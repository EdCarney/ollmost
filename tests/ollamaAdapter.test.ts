import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ThinkProfile, ThinkSetting } from '@shared/types'
import type { ChatChunk } from '../src/main/providers/ollama/wire'
import type { ChatEvent, ChatRequest, ToolDef } from '../src/main/providers/types'
import { line, type MockOllama, startMockOllama, streamChunks } from './ollamaMock'

// Only the connection Settings → Models points at is faked.
const conn = vi.hoisted(() => ({ mode: 'local' as 'local' | 'direct', host: '' }))
vi.mock('../src/main/settings', () => ({
  getSettings: () => ({ connection: { mode: conn.mode, host: conn.host } }),
  getApiKey: () => null
}))

const { ollamaEvents, OllamaProvider, ollamaTimeouts, resultFromOllama, toOllamaBody } =
  await import('../src/main/providers/ollama/adapter')
const { STREAM_TIMEOUTS } = await import('../src/main/providers/ollama/wire')

let ollama: MockOllama
beforeAll(async () => {
  ollama = await startMockOllama()
  conn.host = ollama.url
})
afterAll(() => ollama.close())
beforeEach(() => {
  conn.mode = 'local'
})

const weather: ToolDef = {
  type: 'function',
  function: {
    name: 'get_weather',
    description: 'Weather for a city',
    parameters: { type: 'object', properties: { city: { type: 'string' } } }
  }
}
const plain: ChatRequest = {
  model: 'llama3.2',
  messages: [{ role: 'user', content: 'hi' }],
  think: null,
  profile: { kind: 'none' },
  contextWindow: null
}

async function* from<T>(items: T[]): AsyncGenerator<T> {
  for (const item of items) yield item
}
async function collect<T>(items: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = []
  for await (const item of items) out.push(item)
  return out
}
const callsIn = (events: ChatEvent[]) => events.flatMap((e) => (e.type === 'toolCall' ? [e.call] : []))
/** JSON keeps key order, so equal strings mean Ollama gets equal bytes. */
const bytes = (value: unknown) => JSON.stringify(value)

describe('toOllamaBody: Ollama gets the bytes it got before the seam', () => {
  it('sends past calls, an image turn and this turn’s tool round exactly as before', async () => {
    // This turn's first round as Ollama streamed it: the call carries Ollama's own id and index.
    const round = await collect(
      ollamaEvents(
        from<ChatChunk>([
          {
            message: {
              role: 'assistant',
              content: '',
              tool_calls: [{ id: 'call_ab12', function: { index: 0, name: 'get_weather', arguments: { city: 'Paris' } } }]
            },
            done: false
          },
          { done: true, done_reason: 'stop', prompt_eval_count: 40, eval_count: 9 }
        ])
      )
    )
    const calls = callsIn(round)
    const request: ChatRequest = {
      model: 'llama3.2',
      messages: [
        { role: 'system', content: 'You are helpful.' },
        { role: 'user', content: 'what is in the news?' },
        // An earlier turn's call, as assemble() replays it: its made-up id must never reach Ollama.
        {
          role: 'assistant',
          content: '',
          toolCalls: [{ id: 'c00010000', function: { name: 'web_search', arguments: { query: 'news' } } }]
        },
        { role: 'tool', toolName: 'web_search', toolCallId: 'c00010000', content: '1. Ollmosts are back' },
        { role: 'assistant', content: 'Ollmosts are back.' },
        { role: 'user', content: 'what is this?', images: [{ data: 'iVBORw0KGgo=', mime: 'image/png' }] },
        // This turn's round as runRounds echoes it, then the result.
        { role: 'assistant', content: 'Let me check.', thinking: 'They want the weather.', toolCalls: calls },
        { role: 'tool', content: 'sunny', toolName: 'get_weather', toolCallId: calls[0].id }
      ],
      tools: [weather],
      think: 'on',
      profile: { kind: 'toggle' },
      contextWindow: 8192
    }
    // What service.ts, assemble.ts and rounds.ts sent before the seam, written out by hand.
    const before = {
      model: 'llama3.2',
      messages: [
        { role: 'system', content: 'You are helpful.' },
        { role: 'user', content: 'what is in the news?' },
        { role: 'assistant', content: '', tool_calls: [{ function: { name: 'web_search', arguments: { query: 'news' } } }] },
        { role: 'tool', tool_name: 'web_search', content: '1. Ollmosts are back' },
        { role: 'assistant', content: 'Ollmosts are back.' },
        { role: 'user', content: 'what is this?', images: ['iVBORw0KGgo='] },
        {
          role: 'assistant',
          content: 'Let me check.',
          thinking: 'They want the weather.',
          tool_calls: [{ id: 'call_ab12', function: { index: 0, name: 'get_weather', arguments: { city: 'Paris' } } }]
        },
        { role: 'tool', content: 'sunny', tool_name: 'get_weather' }
      ],
      think: true,
      tools: [weather],
      options: { num_ctx: 8192 }
    }
    expect(bytes(toOllamaBody(request))).toBe(bytes(before))
  })

  it('gives a call Ollama sent without an id one of its own, and never sends that id', async () => {
    const [call] = callsIn(
      await collect(
        ollamaEvents(
          from<ChatChunk>([
            {
              message: { role: 'assistant', content: '', tool_calls: [{ function: { name: 'get_weather', arguments: { city: 'Oslo' } } }] },
              done: false
            }
          ])
        )
      )
    )
    // Nine letters and digits, like every id Ollmost makes up (Mistral's templates on vLLM refuse any other shape).
    expect(call).toEqual({ id: 't00000000', function: { name: 'get_weather', arguments: { city: 'Oslo' } } })
    const body = toOllamaBody({
      ...plain,
      messages: [
        { role: 'assistant', content: '', toolCalls: [call] },
        { role: 'tool', content: 'rain', toolName: 'get_weather', toolCallId: call.id }
      ]
    })
    expect(bytes(body.messages)).toBe(
      bytes([
        { role: 'assistant', content: '', tool_calls: [{ function: { name: 'get_weather', arguments: { city: 'Oslo' } } }] },
        { role: 'tool', content: 'rain', tool_name: 'get_weather' }
      ])
    )
  })

  it('sends a title or summary as before: the least thinking, then temperature before num_ctx', () => {
    const titleOf = (profile: ThinkProfile, think: ThinkSetting | null) =>
      toOllamaBody({
        model: 'qwen3:8b',
        messages: [
          { role: 'system', content: 'T' },
          { role: 'user', content: 'U' }
        ],
        think,
        profile,
        contextWindow: 32_768,
        temperature: 0.3
      })
    expect(bytes(titleOf({ kind: 'toggle' }, 'off'))).toBe(
      bytes({
        model: 'qwen3:8b',
        messages: [
          { role: 'system', content: 'T' },
          { role: 'user', content: 'U' }
        ],
        think: false,
        options: { temperature: 0.3, num_ctx: 32_768 }
      })
    )
    expect(titleOf({ kind: 'levels', canDisable: false }, 'low').think).toBe('low')
    expect(bytes(titleOf({ kind: 'always' }, null))).not.toContain('"think"')
    expect(bytes(titleOf({ kind: 'none' }, null))).not.toContain('"think"')
  })

  it('leaves the window to cloud models: no num_ctx for a -cloud name, nor for any model in direct mode', () => {
    const cloud: ChatRequest = {
      model: 'gpt-oss:120b-cloud',
      messages: [{ role: 'user', content: 'hi' }],
      think: 'medium',
      profile: { kind: 'levels', canDisable: false },
      contextWindow: 131_072
    }
    expect(bytes(toOllamaBody(cloud))).toBe('{"model":"gpt-oss:120b-cloud","messages":[{"role":"user","content":"hi"}],"think":"medium"}')
    conn.mode = 'direct'
    expect(toOllamaBody({ ...cloud, model: 'gpt-oss:120b' }).options).toBeUndefined()
    expect(toOllamaBody({ ...cloud, model: 'gpt-oss:120b', temperature: 0.3 }).options).toEqual({ temperature: 0.3 })
  })

  it('sends no options for a local request with no window', () => {
    expect(bytes(toOllamaBody(plain))).toBe('{"model":"llama3.2","messages":[{"role":"user","content":"hi"}]}')
  })
})

describe('ollamaEvents', () => {
  it('turns NDJSON chunks into neutral events, in order', async () => {
    const final: ChatChunk = {
      message: { role: 'assistant', content: '' },
      done: true,
      done_reason: 'stop',
      prompt_eval_count: 12,
      eval_count: 5,
      load_duration: 2_500_000,
      prompt_eval_duration: 1_000_000,
      eval_duration: 4_000_000_000
    }
    const events = await collect(
      ollamaEvents(
        from<ChatChunk>([
          { message: { role: 'assistant', content: '' }, done: false },
          { message: { role: 'assistant', content: '', thinking: 'Hmm.' }, done: false },
          { message: { role: 'assistant', content: 'Hi' }, done: false },
          {
            message: {
              role: 'assistant',
              content: '',
              tool_calls: [{ function: { name: 'a', arguments: {} } }, { function: { name: 'b', arguments: '{"x":1}' } }]
            },
            done: false
          },
          final
        ])
      )
    )
    const { message: _message, ...closing } = final
    expect(events).toEqual([
      // A chunk with nothing in it still says Ollama is there.
      { type: 'content', text: '' },
      { type: 'thinking', text: 'Hmm.' },
      { type: 'content', text: 'Hi' },
      { type: 'toolCall', call: { id: 't00000000', function: { name: 'a', arguments: {} } } },
      { type: 'toolCall', call: { id: 't00000001', function: { name: 'b', arguments: '{"x":1}' } } },
      {
        type: 'done',
        usage: { prompt: 12, completion: 5 },
        finishReason: 'stop',
        timing: { loadMs: 2.5, promptMs: 1, genMs: 4000 },
        raw: closing
      }
    ])
  })

  it('reports no usage or timing a server leaves out', async () => {
    expect(await collect(ollamaEvents(from<ChatChunk>([{ done: true }])))).toEqual([
      { type: 'done', usage: {}, timing: {}, raw: { done: true } }
    ])
  })

  it('reads a reply that came whole', () => {
    expect(
      resultFromOllama({
        message: { role: 'assistant', content: 'Title', thinking: 'short' },
        done: true,
        done_reason: 'stop',
        prompt_eval_count: 7,
        eval_count: 2
      })
    ).toEqual({
      content: 'Title',
      thinking: 'short',
      toolCalls: [],
      usage: { prompt: 7, completion: 2 },
      finishReason: 'stop',
      timing: {},
      raw: { done: true, done_reason: 'stop', prompt_eval_count: 7, eval_count: 2 }
    })
  })
})

describe('OllamaProvider', () => {
  const provider = new OllamaProvider()
  const req: ChatRequest = { ...plain, contextWindow: 4096 }

  it('streams /api/chat with exactly the body wire() describes', async () => {
    ollama.handler = (_req, res) =>
      streamChunks(res, [
        line({ message: { role: 'assistant', content: 'Hello' }, done: false }),
        line({ done: true, eval_count: 1 })
      ]).then(() => res.end())
    const events = await collect(provider.chatStream(req, new AbortController().signal))
    expect(events.map((e) => e.type)).toEqual(['content', 'done'])
    const wire = provider.wire(req, true)
    expect(wire.endpoint).toBe(`${ollama.url}/api/chat`)
    expect(ollama.requests.at(-1)).toEqual(wire.body)
    expect(bytes(wire.body)).toBe(
      '{"model":"llama3.2","messages":[{"role":"user","content":"hi"}],"options":{"num_ctx":4096},"stream":true}'
    )
  })

  it('reads a chatOnce reply', async () => {
    ollama.handler = (_req, res) =>
      void res.writeHead(200).end(JSON.stringify({ message: { role: 'assistant', content: 'A title' }, done: true, eval_count: 2 }))
    const res = await provider.chatOnce(req, { timeoutMs: 2_000 })
    expect(res).toMatchObject({ content: 'A title', usage: { completion: 2 } })
    expect(ollama.requests.at(-1)).toMatchObject({ stream: false })
  })

  it('sends a replayed body as it is, not streamed', async () => {
    ollama.handler = (_req, res) =>
      void res.writeHead(200).end(JSON.stringify({ message: { role: 'assistant', content: 'again' }, done: true, eval_count: 1 }))
    const res = await provider.sendWire(
      { model: 'llama3.2', messages: [{ role: 'user', content: 'hi' }], stream: false },
      { timeoutMs: 2_000 }
    )
    expect(res.content).toBe('again')
    expect(bytes(ollama.requests.at(-1))).toBe('{"model":"llama3.2","messages":[{"role":"user","content":"hi"}],"stream":false}')
    expect(provider.wireEndpoint()).toBe(`${ollama.url}/api/chat`)
  })

  it('gives only models on this Mac the long quiet allowance for tool calls', () => {
    expect(ollamaTimeouts('llama3.2')).toEqual(STREAM_TIMEOUTS)
    expect(ollamaTimeouts('gpt-oss:120b-cloud').toolIdleMs).toBe(STREAM_TIMEOUTS.idleMs)
    conn.mode = 'direct'
    expect(ollamaTimeouts('gpt-oss:120b').toolIdleMs).toBe(STREAM_TIMEOUTS.idleMs)
  })
})
