import { existsSync } from 'node:fs'
import type { ServerResponse } from 'node:http'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Endpoint } from '@shared/types'
import type { ChatEvent, ChatRequest } from '../src/main/providers/types'
import {
  byteChunks,
  capturedChunks,
  FIXTURES,
  fixtureText,
  type MockOllama,
  sse,
  sseDelta,
  sseDone,
  startMockOllama,
  streamSse
} from './ollamaMock'

// The adapter's own dependencies are faked: model_profiles (a Map), the endpoint store and the endpoint key. The server
// is a local mock speaking OpenAI's SSE.
const fake = vi.hoisted(() => {
  type Row = { info: unknown; fetchedAt: number; overrides: Record<string, unknown>; detected: Record<string, unknown> }
  const rows = new Map<string, Row>()
  const row = (key: string): Row => rows.get(key) ?? { info: null, fetchedAt: 0, overrides: {}, detected: {} }
  return { rows, row, key: null as string | null, streamOptions: [] as Array<[string, boolean]> }
})
vi.mock('../src/main/db/kv', () => ({
  readModelProfile: (key: string) => fake.row(key),
  writeModelInfo: (key: string, info: unknown) => void fake.rows.set(key, { ...fake.row(key), info, fetchedAt: Date.now() }),
  writeModelDetected: (key: string, detected: Record<string, unknown>) => void fake.rows.set(key, { ...fake.row(key), detected }),
  writeModelOverrides: (key: string, overrides: Record<string, unknown>) => void fake.rows.set(key, { ...fake.row(key), overrides })
}))
vi.mock('../src/main/settings', () => ({ setEndpointStreamOptions: (id: string, v: boolean) => void fake.streamOptions.push([id, v]) }))
vi.mock('../src/main/providers/secrets', () => ({ endpointSecretName: (id: string) => `endpointKey:${id}`, getSecret: () => fake.key }))

const { OpenAIProvider } = await import('../src/main/providers/openai/adapter')

let server: MockOllama
beforeAll(async () => {
  server = await startMockOllama()
})
afterAll(() => server.close())
beforeEach(() => {
  fake.rows.clear()
  fake.key = null
  fake.streamOptions.length = 0
  server.requests.length = 0
})

const fast = { firstByteMs: 2_000, idleMs: 2_000, toolIdleMs: 2_000 }
const endpoint = (over: Partial<Endpoint> = {}): Endpoint => ({
  id: 'lm',
  name: 'LM Studio',
  kind: 'openai',
  flavor: 'lmstudio',
  baseUrl: `${server.url}/v1`,
  enabled: true,
  hasKey: false,
  ...over
})
const provider = (over: Partial<Endpoint> = {}, timeouts = fast) => new OpenAIProvider(endpoint(over), { timeouts })
const req = (over: Partial<ChatRequest> = {}): ChatRequest => ({
  model: 'qwen/qwen3-8b',
  messages: [{ role: 'user', content: 'hi' }],
  think: null,
  profile: { kind: 'none' },
  contextWindow: null,
  ...over
})
const TOOLS = [{ type: 'function' as const, function: { name: 'get_weather', description: 'Weather', parameters: { type: 'object' } } }]
// An earlier round of this turn, whose call came without an id and was given t00000000.
const EARLIER_ROUND: ChatRequest['messages'] = [
  { role: 'user', content: 'Weather in Paris, then Tokyo?' },
  { role: 'assistant', content: '', toolCalls: [{ id: 't00000000', function: { name: 'get_weather', arguments: { city: 'Paris' } } }] },
  { role: 'tool', content: 'Sunny, 21°C', toolCallId: 't00000000', toolName: 'get_weather' }
]

async function collect(p = provider(), request = req(), signal = new AbortController().signal): Promise<ChatEvent[]> {
  const out: ChatEvent[] = []
  for await (const e of p.chatStream(request, signal)) out.push(e)
  return out
}
const text = (events: ChatEvent[], type: 'content' | 'thinking') => events.flatMap((e) => (e.type === type ? [e.text] : [])).join('')
const calls = (events: ChatEvent[]) => events.flatMap((e) => (e.type === 'toolCall' ? [e.call] : []))

/** Serve these pieces as one SSE reply, and collect what the adapter makes of them. */
function replay(chunks: Array<string | Uint8Array>, p = provider()): Promise<ChatEvent[]> {
  server.handler = (_req, res) => streamSse(res, chunks).then(() => res.end())
  return collect(p)
}
const ok = (content = 'ok') => [sseDelta({ content }, 'stop'), sseDone]

describe('chatStream', () => {
  it('streams content, reasoning, and one done with usage and timing', async () => {
    const events = await replay([
      sseDelta({ role: 'assistant', content: '' }),
      sseDelta({ reasoning_content: 'Think' }),
      sseDelta({ reasoning_content: 'ing.' }),
      sseDelta({ content: 'Hel' }),
      sseDelta({ content: 'lo' }),
      sseDelta({}, 'length'),
      sse({
        id: 'x',
        object: 'chat.completion.chunk',
        choices: [],
        usage: { prompt_tokens: 9, completion_tokens: 4 },
        timings: { prompt_ms: 12.5, predicted_ms: 80 }
      }),
      sseDone
    ])
    expect(text(events, 'thinking')).toBe('Thinking.')
    expect(text(events, 'content')).toBe('Hello')
    expect(events.filter((e) => e.type === 'done')).toHaveLength(1)
    expect(events.at(-1)).toEqual({
      type: 'done',
      usage: { prompt: 9, completion: 4 },
      finishReason: 'length',
      timing: { promptMs: 12.5, genMs: 80 },
      raw: expect.anything()
    })
  })

  it('says the server is there with an empty content for a chunk that shows nothing', async () => {
    const events = await replay([sseDelta({ role: 'assistant', content: '' }), ...ok('Hi')])
    expect(events[0]).toEqual({ type: 'content', text: '' })
  })

  it('posts an OpenAI chat-completions body, asking for usage, with the endpoint’s key', async () => {
    fake.key = 'sk-local'
    let auth: string | undefined
    let url: string | undefined
    server.handler = (r, res) => {
      auth = r.headers.authorization
      url = r.url
      return streamSse(res, ok()).then(() => res.end())
    }
    await collect()
    expect(url).toBe('/v1/chat/completions')
    expect(auth).toBe('Bearer sk-local')
    expect(server.requests.at(-1)).toEqual({
      model: 'qwen/qwen3-8b',
      messages: [{ role: 'user', content: 'hi' }],
      stream: true,
      stream_options: { include_usage: true }
    })
  })

  it('sends no Authorization header without a key', async () => {
    let auth: string | undefined = 'unset'
    server.handler = (r, res) => {
      auth = r.headers.authorization
      return streamSse(res, ok()).then(() => res.end())
    }
    await collect()
    expect(auth).toBeUndefined()
  })

  it('turns thinking off on LM Studio with reasoning_effort none, the only off it takes', async () => {
    server.handler = (_r, res) => streamSse(res, ok()).then(() => res.end())
    await collect(provider({ flavor: 'lmstudio' }), req({ profile: { kind: 'toggle' }, think: 'off' }))
    expect(server.requests.at(-1)).toMatchObject({ reasoning_effort: 'none' })
    expect(server.requests.at(-1)).not.toHaveProperty('chat_template_kwargs')
  })

  it('sends exactly what wire() says', async () => {
    const p = provider()
    const request = req({ tools: TOOLS, temperature: 0.2, profile: { kind: 'toggle' }, think: 'on' })
    await replay(ok(), p)
    await collect(p, request)
    expect(server.requests.at(-1)).toEqual(p.wire(request, true).body)
    expect(p.wire(request, true).endpoint).toBe(`${server.url}/v1/chat/completions`)
    expect(p.wireEndpoint()).toBe(`${server.url}/v1/chat/completions`)
  })

  it('reads a reply split anywhere the same as whole', async () => {
    const all = fixtureText('sse/llamacpp-reasoning.sse')
    const whole = await replay([all])
    expect(await replay(byteChunks(all, 7))).toEqual(whole)
    expect(await replay(byteChunks(all, 1))).toEqual(whole)
  })

  it('splits a leading <think> block out of content when no reasoning field comes', async () => {
    const events = await replay([
      sseDelta({ content: '<thi' }),
      sseDelta({ content: 'nk>plan</think>\n\nAnswer' }),
      sseDelta({}, 'stop'),
      sseDone
    ])
    expect(text(events, 'thinking')).toBe('plan')
    expect(text(events, 'content')).toBe('Answer')
  })

  it('leaves <think> in content once the server has sent reasoning apart', async () => {
    const events = await replay([sseDelta({ reasoning: 'r' }), sseDelta({ content: 'Use <think> tags' }), sseDelta({}, 'stop'), sseDone])
    expect(text(events, 'thinking')).toBe('r')
    expect(text(events, 'content')).toBe('Use <think> tags')
  })

  it('reads llama.cpp: reasoning_content, usage and timings', async () => {
    const events = await replay(byteChunks(fixtureText('sse/llamacpp-reasoning.sse'), 11))
    expect(text(events, 'thinking')).toBe('The user says hi. Greet them back — briefly.')
    expect(text(events, 'content')).toBe('Hello! Café or tea?')
    expect(events.at(-1)).toMatchObject({
      type: 'done',
      usage: { prompt: 11, completion: 17 },
      finishReason: 'stop',
      timing: { promptMs: 35.2, genMs: 254.1 }
    })
  })

  it('reads llama.cpp’s tool call, with token counts from its timings', async () => {
    const events = await replay(byteChunks(fixtureText('sse/llamacpp-tools.sse'), 13))
    expect(calls(events)).toEqual([{ id: 'Xk3pQ9dLr2VbN7sT0aYw4eHu', function: { name: 'get_weather', arguments: { city: 'Zürich' } } }])
    expect(events.at(-1)).toMatchObject({
      type: 'done',
      usage: { prompt: 180, completion: 21 },
      finishReason: 'tool_calls',
      timing: { promptMs: 402.7, genMs: 318.4 }
    })
  })

  it('reads vLLM: reasoning in `reasoning`, usage in a last chunk', async () => {
    const events = await replay([fixtureText('sse/vllm-reasoning.sse')])
    expect(text(events, 'thinking')).toBe('Capital of France. Easy.')
    expect(text(events, 'content')).toBe('Paris.')
    expect(events.at(-1)).toEqual({ type: 'done', usage: { prompt: 12, completion: 12 }, finishReason: 'stop', raw: expect.anything() })
  })

  it('hands over two calls whole, after the text and before done', async () => {
    const events = await replay(byteChunks(fixtureText('sse/vllm-tools.sse'), 17))
    expect(calls(events)).toEqual([
      { id: 'chatcmpl-tool-5b1c', function: { name: 'get_weather', arguments: { city: 'Paris' } } },
      { id: 'chatcmpl-tool-9e7a', function: { name: 'get_time', arguments: { zone: 'Europe/Paris' } } }
    ])
    const types = events.map((e) => e.type)
    expect(types.slice(-3)).toEqual(['toolCall', 'toolCall', 'done'])
    expect(events.at(-1)).toMatchObject({ finishReason: 'tool_calls', usage: { prompt: 240, completion: 41 } })
  })

  it('numbers a call sent without an id past the ids this turn already made up', async () => {
    server.handler = (_r, res) =>
      streamSse(res, [
        sseDelta(
          { tool_calls: [{ index: 0, type: 'function', function: { name: 'get_weather', arguments: '{"city":"Tokyo"}' } }] },
          'tool_calls'
        ),
        sseDone
      ]).then(() => res.end())
    const events = await collect(provider(), req({ messages: EARLIER_ROUND, tools: TOOLS }))
    expect(calls(events)).toEqual([{ id: 't00000001', function: { name: 'get_weather', arguments: { city: 'Tokyo' } } }])
  })

  it('treats a stream that ends with neither finish_reason nor [DONE] as a dropped connection', async () => {
    await expect(replay([sseDelta({ content: 'partial' })])).rejects.toThrow(
      'The connection to LM Studio dropped before the reply finished.'
    )
  })

  it('hands over the text it was holding back when the reply breaks off', async () => {
    server.handler = (_r, res) => streamSse(res, [sseDelta({ content: 'Half an ans' })]).then(() => res.end())
    const seen: ChatEvent[] = []
    const read = async () => {
      for await (const e of provider().chatStream(req(), new AbortController().signal)) seen.push(e)
    }
    await expect(read()).rejects.toThrow(/dropped before the reply finished/)
    expect(text(seen, 'content')).toBe('Half an ans')
  })

  it('says the connection dropped, naming the endpoint, when the server goes away mid-reply', async () => {
    server.handler = async (_r, res) => {
      await streamSse(res, [sseDelta({ content: 'Half an ans' })])
      await new Promise((r) => setTimeout(r, 50))
      res.socket?.destroy()
    }
    const seen: ChatEvent[] = []
    const read = async () => {
      for await (const e of provider().chatStream(req(), new AbortController().signal)) seen.push(e)
    }
    await expect(read()).rejects.toThrow('The connection to LM Studio dropped before the reply finished.')
    expect(text(seen, 'content')).toBe('Half an ans')
  })

  it('accepts a finish_reason with no [DONE], and a [DONE] with no finish_reason', async () => {
    expect(text(await replay([sseDelta({ content: 'Hi' }), sseDelta({}, 'stop')]), 'content')).toBe('Hi')
    expect(text(await replay([sseDelta({ content: 'Hi' }), sseDone]), 'content')).toBe('Hi')
  })

  it('surfaces an error sent mid-stream', async () => {
    await expect(replay([sseDelta({ content: 'a' }), sse({ error: { message: 'model crashed', code: 500 } })])).rejects.toThrow(
      'LM Studio: model crashed'
    )
  })

  it('turns an unreadable payload into a friendly error', async () => {
    await expect(replay(['data: {"choices": [\n\n'])).rejects.toThrow(/LM Studio sent a response Ollmost couldn't read/)
  })

  it('gives up when the first byte never arrives', async () => {
    server.handler = () => undefined
    await expect(collect(provider({}, { firstByteMs: 150, idleMs: 5_000, toolIdleMs: 5_000 }))).rejects.toThrow(
      /LM Studio didn't start replying/
    )
  })

  it('gives up when the stream stalls mid-reply', async () => {
    server.handler = (_r, res) => streamSse(res, [sseDelta({ content: 'a' })])
    await expect(collect(provider({}, { firstByteMs: 5_000, idleMs: 150, toolIdleMs: 5_000 }))).rejects.toThrow(
      /LM Studio stopped responding/
    )
  })

  it('waits longer for a quiet stream when tools are offered', async () => {
    server.handler = async (_r, res) => {
      await streamSse(res, [sseDelta({ role: 'assistant', content: '' })])
      await new Promise((r) => setTimeout(r, 300))
      res.end(
        sseDelta(
          { tool_calls: [{ index: 0, id: 'c1', type: 'function', function: { name: 'get_weather', arguments: '{}' } }] },
          'tool_calls'
        ) + sseDone
      )
    }
    const p = provider({}, { firstByteMs: 5_000, idleMs: 150, toolIdleMs: 5_000 })
    expect(calls(await collect(p, req({ tools: TOOLS })))).toHaveLength(1)
  })

  // Review Focus #4.
  it('stops with an AbortError, not "connection dropped", when the user stops mid-stream', async () => {
    server.handler = (_r, res) => streamSse(res, [sseDelta({ reasoning_content: 'thinking…' })])
    const controller = new AbortController()
    const run = collect(provider({}, { firstByteMs: 5_000, idleMs: 5_000, toolIdleMs: 5_000 }), req(), controller.signal)
    setTimeout(() => controller.abort(), 50)
    const err = (await run.then(
      () => null,
      (e: unknown) => e
    )) as Error
    expect(err.name).toBe('AbortError')
    expect(err.message).not.toMatch(/dropped/)
  })

  it('closes the connection when the caller stops reading early', async () => {
    let closed = false
    server.handler = (_r, res) => {
      res.on('close', () => (closed = true))
      return streamSse(res, [sseDelta({ reasoning_content: 'a' })])
    }
    for await (const _event of provider({}, { firstByteMs: 5_000, idleMs: 5_000, toolIdleMs: 5_000 }).chatStream(
      req(),
      new AbortController().signal
    ))
      break
    await vi.waitFor(() => expect(closed).toBe(true), { timeout: 2_000 })
  })

  it('retries once without stream_options when the server rejects it, and remembers that', async () => {
    server.handler = (r, res) =>
      r.json.stream_options
        ? void res.writeHead(400).end(
            JSON.stringify({
              error: { message: 'Unrecognized request argument supplied: stream_options', type: 'invalid_request_error' }
            })
          )
        : streamSse(res, ok()).then(() => res.end())
    const p = provider()
    expect(text(await collect(p), 'content')).toBe('ok')
    expect(server.requests.map((b) => 'stream_options' in b)).toEqual([true, false])
    expect(fake.streamOptions).toEqual([['lm', false]])
    expect(p.wire(req(), true).body).not.toHaveProperty('stream_options')
    await collect(p)
    expect(server.requests).toHaveLength(3)
  })

  // FastAPI servers (vLLM, SGLang, TabbyAPI) echo the whole body in a validation error, stream_options and all.
  it('remembers nothing when the retry without stream_options fails too', async () => {
    server.handler = (r, res) =>
      void res.writeHead(400).end(
        JSON.stringify({
          object: 'error',
          message: `1 validation error for ChatCompletionRequest\nmessages.0.role\n  Input should be 'user' [type=literal_error, input_value=${JSON.stringify(r.json)}, input_type=dict]`,
          type: 'BadRequestError',
          code: 400
        })
      )
    const p = provider()
    await expect(collect(p)).rejects.toThrow('LM Studio: 1 validation error for ChatCompletionRequest')
    expect(server.requests.map((b) => 'stream_options' in b)).toEqual([true, false])
    expect(fake.streamOptions).toEqual([])
    expect(p.wire(req(), true).body).toHaveProperty('stream_options')
    await expect(collect(p)).rejects.toThrow('LM Studio: 1 validation error for ChatCompletionRequest')
    expect(server.requests.map((b) => 'stream_options' in b)).toEqual([true, false, true, false])
    expect(fake.streamOptions).toEqual([])
  })

  it('leaves stream_options out for an endpoint that rejected it before', async () => {
    await replay(ok(), provider({ streamOptions: false }))
    expect(server.requests.at(-1)).not.toHaveProperty('stream_options')
  })

  it('doesn’t retry a 400 about something else', async () => {
    server.handler = (_r, res) => void res.writeHead(400).end(JSON.stringify({ error: { message: 'messages must not be empty' } }))
    await expect(collect()).rejects.toThrow('LM Studio: messages must not be empty')
    expect(server.requests).toHaveLength(1)
    expect(fake.streamOptions).toEqual([])
  })

  it('names the endpoint and its address when it can’t be reached', async () => {
    await expect(collect(provider({ baseUrl: 'http://127.0.0.1:9/v1' }))).rejects.toThrow(
      "Can't reach LM Studio at 127.0.0.1:9. Is its server started? Start it in LM Studio’s Developer tab."
    )
  })

  it('learns that tools are off when the server needs a flag for them', async () => {
    server.handler = (_r, res) =>
      void res.writeHead(400).end(
        JSON.stringify({
          object: 'error',
          message: '"auto" tool choice requires --enable-auto-tool-choice and --tool-call-parser to be set',
          code: 400
        })
      )
    const p = provider({ id: 'gpu', name: 'GPU box', flavor: 'vllm' })
    await expect(collect(p, req({ model: 'Qwen/Qwen3-8B', tools: TOOLS }))).rejects.toThrow(/GPU box can't use tools with this model/)
    expect(fake.row('gpu/Qwen/Qwen3-8B').detected).toEqual({ tools: false, reason: 'server lacks --enable-auto-tool-choice' })
  })

  it('learns the context size from an overflow error, keeping what it knew', async () => {
    fake.rows.set('gpu/Qwen/Qwen3-8B', {
      info: null,
      fetchedAt: 0,
      overrides: {},
      detected: { tools: false, reason: 'server lacks --enable-auto-tool-choice' }
    })
    server.handler = (_r, res) =>
      void res.writeHead(400).end(
        JSON.stringify({
          object: 'error',
          message: "This model's maximum context length is 16384 tokens. However, you requested 20000 tokens.",
          code: 400
        })
      )
    await expect(collect(provider({ id: 'gpu', name: 'GPU box', flavor: 'vllm' }), req({ model: 'Qwen/Qwen3-8B' }))).rejects.toThrow(
      /no longer fits/
    )
    expect(fake.row('gpu/Qwen/Qwen3-8B').detected).toEqual({ tools: false, contextLength: 16384, reason: 'GPU box reported a 16K context' })
  })
})

describe('the LM Studio captures', () => {
  const has = (path: string) => existsSync(join(FIXTURES, path))

  // LM Studio honours include_usage: a `choices: []` chunk after the finish_reason (capture/FINDINGS.md, question 3).
  it('streams its plain reply the same in the pieces it arrived in and in any others', async () => {
    const events = await replay(capturedChunks('sse/lmstudio-plain.sse'))
    expect(await replay(byteChunks(fixtureText('sse/lmstudio-plain.sse'), 5))).toEqual(events)
    expect(text(events, 'content').trim()).not.toBe('')
    expect(events.filter((e) => e.type === 'done')).toHaveLength(1)
    expect(events.at(-1)).toMatchObject({ type: 'done', finishReason: 'stop', usage: { prompt: 22, completion: 8 } })
  })

  it('reads the reply streamed without stream_options', async () => {
    const events = await replay(capturedChunks('sse/lmstudio-plain-no-usage.sse'))
    expect(text(events, 'content').trim()).not.toBe('')
    expect(events.at(-1)).toMatchObject({ type: 'done' })
  })

  // Its ids are 9-digit numbers (question 2), kept as they came.
  it('hands over its tool call whole', async () => {
    expect(calls(await replay(capturedChunks('sse/lmstudio-tool-single.sse')))).toEqual([
      { id: '456579262', function: { name: 'get_weather', arguments: { city: 'Paris' } } }
    ])
  })

  it('keeps parallel calls apart', async () => {
    expect(calls(await replay(capturedChunks('sse/lmstudio-tool-parallel.sse')))).toEqual([
      { id: '330268305', function: { name: 'get_weather', arguments: { city: 'Paris' } } },
      { id: '926371468', function: { name: 'get_weather', arguments: { city: 'Tokyo' } } }
    ])
  })

  it.runIf(has('sse/lmstudio-think-default.sse'))('shows a thinking model’s reasoning', async () => {
    expect(text(await replay(capturedChunks('sse/lmstudio-think-default.sse')), 'thinking').trim()).not.toBe('')
  })
})

describe('chatOnce and sendWire', () => {
  const completion =
    (message: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
    (_r: unknown, res: ServerResponse) =>
      void res.writeHead(200, { 'content-type': 'application/json' }).end(
        JSON.stringify({
          id: 'x',
          object: 'chat.completion',
          choices: [{ index: 0, message: { role: 'assistant', ...message }, finish_reason: 'stop' }],
          ...extra
        })
      )

  it('returns the whole reply, sent without stream_options', async () => {
    server.handler = completion(
      {
        content: 'A title',
        reasoning_content: 'hmm',
        tool_calls: [{ id: 'c1', type: 'function', function: { name: 'f', arguments: '{"a":1}' } }]
      },
      { usage: { prompt_tokens: 20, completion_tokens: 2 } }
    )
    const r = await provider().chatOnce(req({ temperature: 0.3 }), { timeoutMs: 2_000 })
    expect(r).toMatchObject({
      content: 'A title',
      thinking: 'hmm',
      toolCalls: [{ id: 'c1', function: { name: 'f', arguments: { a: 1 } } }],
      usage: { prompt: 20, completion: 2 },
      finishReason: 'stop'
    })
    expect(JSON.stringify(r.raw)).not.toContain('A title')
    expect(server.requests.at(-1)).toMatchObject({ stream: false, temperature: 0.3 })
    expect(server.requests.at(-1)).not.toHaveProperty('stream_options')
  })

  it('numbers a call read whole without an id past the ids this turn already made up', async () => {
    server.handler = completion({
      content: '',
      tool_calls: [{ type: 'function', function: { name: 'get_weather', arguments: '{"city":"Tokyo"}' } }]
    })
    const r = await provider().chatOnce(req({ messages: EARLIER_ROUND, tools: TOOLS }), { timeoutMs: 2_000 })
    expect(r.toolCalls).toEqual([{ id: 't00000001', function: { name: 'get_weather', arguments: { city: 'Tokyo' } } }])
  })

  it('splits <think> out of a reply read whole', async () => {
    server.handler = completion({ content: '<think>short</think>\n\nDone' })
    expect(await provider().chatOnce(req(), { timeoutMs: 2_000 })).toMatchObject({ content: 'Done', thinking: 'short' })
  })

  it('times out instead of hanging', async () => {
    server.handler = () => undefined
    await expect(provider().chatOnce(req(), { timeoutMs: 150 })).rejects.toThrow(
      'LM Studio took too long to respond. Try again in a moment.'
    )
  })

  it('replays an edited body as it is, not streamed', async () => {
    const p = provider()
    const wire = p.wire(req(), true)
    server.handler = completion({ content: 'again' })
    const r = await p.sendWire(
      { ...(wire.body as Record<string, unknown>), messages: [{ role: 'user', content: 'edited' }] },
      { timeoutMs: 2_000 }
    )
    expect(r.content).toBe('again')
    expect(server.requests.at(-1)).toEqual({ model: 'qwen/qwen3-8b', messages: [{ role: 'user', content: 'edited' }], stream: false })
  })

  it.runIf(existsSync(join(FIXTURES, 'once/lmstudio-tool-single.json')))('reads LM Studio’s own replies read whole', async () => {
    server.handler = (_r, res) =>
      void res.writeHead(200, { 'content-type': 'application/json' }).end(fixtureText('once/lmstudio-plain.json'))
    expect((await provider().chatOnce(req(), { timeoutMs: 2_000 })).content.trim()).not.toBe('')
    server.handler = (_r, res) =>
      void res.writeHead(200, { 'content-type': 'application/json' }).end(fixtureText('once/lmstudio-tool-single.json'))
    expect((await provider().chatOnce(req({ tools: TOOLS }), { timeoutMs: 2_000 })).toolCalls[0]?.function.name).toBe('get_weather')
  })
})

describe('models', () => {
  const list = (hits: { n: number }) => (r: { url?: string }, res: ServerResponse) => {
    if (r.url !== '/v1/models') return void res.writeHead(404).end()
    hits.n++
    res.writeHead(200, { 'content-type': 'application/json' }).end(fixtureText('discovery/generic-models.json'))
  }
  const generic = () => provider({ id: 'gen', name: 'Box', flavor: 'generic' })

  it('lists the chat models with their keys, where they run and the endpoint’s default context', async () => {
    server.handler = list({ n: 0 })
    const models = await generic().listModels(false)
    expect(models.map((m) => m.key)).toEqual(['gen/mistral-small-3.2-24b', 'gen/qwen3-coder-30b-a3b'])
    expect(models[0]).toMatchObject({
      name: 'mistral-small-3.2-24b',
      endpoint: { id: 'gen', name: 'Box', kind: 'openai', flavor: 'generic' },
      where: 'this-mac',
      billing: 'local',
      contextControl: 'server',
      contextWindow: 8192,
      installed: true,
      capabilities: ['completion', 'tools'],
      contextLength: null,
      price: null,
      detected: {}
    })
  })

  it('keeps a model’s info for a day, and reads it again on refresh', async () => {
    const hits = { n: 0 }
    server.handler = list(hits)
    const p = generic()
    await p.modelInfo('qwen3-coder-30b-a3b')
    await p.modelInfo('qwen3-coder-30b-a3b')
    expect(hits.n).toBe(1)
    await p.modelInfo('qwen3-coder-30b-a3b', true)
    expect(hits.n).toBe(2)
  })

  it('describes a model the server no longer lists as not installed', async () => {
    server.handler = list({ n: 0 })
    expect(await generic().modelInfo('gone-model')).toMatchObject({
      key: 'gen/gone-model',
      installed: false,
      capabilities: ['completion', 'tools']
    })
  })

  it('rereads an LM Studio model whose cached window is still null, but trusts one that has loaded', async () => {
    const hits = { n: 0 }
    server.handler = (r, res) => {
      if (r.url !== '/api/v1/models') return void res.writeHead(404).end()
      hits.n++
      res.writeHead(200, { 'content-type': 'application/json' }).end(fixtureText('discovery/lmstudio-docs.json'))
    }
    const p = provider() // the default endpoint is LM Studio (id 'lm')
    const cached = (contextLength: number | null) => ({
      info: { capabilities: ['completion'], contextLength, family: null, parameterSize: null, thinkPreset: null },
      fetchedAt: Date.now(),
      overrides: {},
      detected: {}
    })
    // Not yet loaded: every call re-reads, since the fixture never loads it either.
    fake.rows.set('lm/google/gemma-3-12b', cached(null))
    await p.modelInfo('google/gemma-3-12b')
    await p.modelInfo('google/gemma-3-12b')
    expect(hits.n).toBe(2)
    // Loaded, within the TTL: the cache is trusted, no re-read.
    fake.rows.set('lm/qwen/qwen3-8b', cached(16384))
    await p.modelInfo('qwen/qwen3-8b')
    expect(hits.n).toBe(2)
  })

  it('says why it can’t list when the server is down, and still describes a model it knew', async () => {
    const down = provider({ id: 'gen', name: 'Box', flavor: 'generic', baseUrl: 'http://127.0.0.1:9/v1' })
    await expect(down.listModels(false)).rejects.toThrow("Can't reach Box at 127.0.0.1:9. Is its server started?")
    fake.rows.set('gen/old', {
      info: { capabilities: ['completion', 'vision'], contextLength: 4096, family: null, parameterSize: null },
      fetchedAt: 0,
      overrides: {},
      detected: {}
    })
    expect(await down.modelInfo('old')).toMatchObject({ installed: true, capabilities: ['completion', 'vision'], contextWindow: 4096 })
  })

  it('applies the user’s overrides and what errors taught, and says what Auto would be', async () => {
    server.handler = list({ n: 0 })
    fake.rows.set('gen/mistral-small-3.2-24b', {
      info: null,
      fetchedAt: 0,
      overrides: { vision: true, tools: false, contextLength: 32_768, think: 'toggle' },
      detected: {}
    })
    fake.rows.set('gen/qwen3-coder-30b-a3b', {
      info: null,
      fetchedAt: 0,
      overrides: {},
      detected: { tools: false, contextLength: 16_384, reason: 'Box reported a 16K context' }
    })
    const [mistral, coder] = await generic().listModels(false)
    expect(mistral).toMatchObject({
      capabilities: ['completion', 'vision', 'thinking'],
      contextWindow: 32_768,
      thinkPreset: null,
      auto: { capabilities: ['completion', 'tools'], contextWindow: 8_192 }
    })
    expect(coder).toMatchObject({
      capabilities: ['completion'],
      contextWindow: 16_384,
      auto: { capabilities: ['completion'], contextWindow: 16_384 }
    })
  })

  it('carries LM Studio’s thinking preset into the model', async () => {
    server.handler = (r, res) =>
      r.url === '/api/v1/models' ? void res.writeHead(200).end(fixtureText('discovery/lmstudio-docs.json')) : void res.writeHead(404).end()
    const models = await provider().listModels(false)
    expect(models.map((m) => [m.name, m.thinkPreset])).toEqual([
      ['qwen/qwen3-8b', 'toggle'],
      ['google/gemma-3-12b', null],
      ['openai/gpt-oss-20b', 'levels']
    ])
  })
})
