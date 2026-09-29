import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { OllamaTarget } from '../src/main/providers/ollama/wire'
import { fetchFailed } from './fetchFailed'
import { line, type MockOllama, startMockOllama, streamChunks } from './ollamaMock'

const { chatOnce, chatStream, listCloudCatalog, listTags, OllamaError, STREAM_TIMEOUTS, streamTimeoutsFor } =
  await import('../src/main/providers/ollama/wire')

const t: OllamaTarget = { base: '', name: 'Ollama', headers: {}, cloud: false, keyed: false }
let ollama: MockOllama
beforeAll(async () => {
  ollama = await startMockOllama()
  t.base = ollama.url
})
afterAll(() => ollama.close())

const body = { model: 'llama3.2', messages: [{ role: 'user' as const, content: 'hi' }] }
const fast = { firstByteMs: 2_000, idleMs: 2_000, toolIdleMs: 2_000 }

type Body = Parameters<typeof chatStream>[1]

async function collectFrom(target: OllamaTarget, signal = new AbortController().signal, timeouts = fast, request: Body = body) {
  const chunks = []
  for await (const c of chatStream(target, request, signal, timeouts)) chunks.push(c)
  return chunks
}
const collect = (signal?: AbortSignal, timeouts = fast, request: Body = body) => collectFrom(t, signal, timeouts, request)

describe('chatStream', () => {
  it('reassembles JSON lines split across network chunks', async () => {
    const all =
      line({ message: { role: 'assistant', content: 'Hel' }, done: false }) +
      line({ message: { role: 'assistant', content: 'lo' }, done: false }) +
      line({ done: true, done_reason: 'stop', eval_count: 2 })
    ollama.handler = (_req, res) => streamChunks(res, [all.slice(0, 7), all.slice(7, 50), all.slice(50)], 5).then(() => res.end())
    const chunks = await collect()
    expect(chunks.map((c) => c.message?.content ?? '').join('')).toBe('Hello')
    expect(chunks.at(-1)).toMatchObject({ done: true, eval_count: 2 })
  })

  it('accepts a final chunk with no trailing newline', async () => {
    ollama.handler = (_req, res) =>
      streamChunks(res, [line({ message: { role: 'assistant', content: 'ok' }, done: false }), JSON.stringify({ done: true })]).then(() =>
        res.end()
      )
    expect((await collect()).at(-1)?.done).toBe(true)
  })

  it('treats a stream that ends without done as a dropped connection', async () => {
    ollama.handler = (_req, res) =>
      streamChunks(res, [line({ message: { role: 'assistant', content: 'partial' }, done: false })]).then(() => res.end())
    await expect(collect()).rejects.toThrow(/dropped before the reply finished/)
  })

  it('surfaces an error chunk sent mid-stream', async () => {
    ollama.handler = (_req, res) =>
      streamChunks(res, [
        line({ message: { role: 'assistant', content: 'a' }, done: false }),
        line({ error: 'model runner has unexpectedly stopped' })
      ]).then(() => res.end())
    await expect(collect()).rejects.toThrow('model runner has unexpectedly stopped')
  })

  it('turns a not-enough-memory error chunk into a friendly, model-naming message', async () => {
    ollama.handler = (_req, res) =>
      streamChunks(res, [line({ error: 'model requires more system memory (9.1 GiB) than is available (6.0 GiB)' })]).then(() => res.end())
    const err = await collect().catch((e) => e)
    expect(err.message).toBe(
      'Not enough memory to load “llama3.2”. Lower the context window in Settings → Models, or pick a smaller or more quantized model.'
    )
  })

  it('turns an unreadable line into a friendly error', async () => {
    ollama.handler = (_req, res) => streamChunks(res, ['{"message": {"content": "a"}\n', 'this is not json\n']).then(() => res.end())
    const err = await collect().catch((e) => e)
    expect(err).toBeInstanceOf(OllamaError)
    expect(err.message).toMatch(/couldn't read/)
  })

  it('reports HTTP errors with the daemon message', async () => {
    ollama.handler = (_req, res) => void res.writeHead(404).end(JSON.stringify({ error: "model 'nope' not found" }))
    await expect(collect()).rejects.toThrow(/was not found/)
  })

  it('turns a not-enough-memory HTTP error into a friendly, model-naming message', async () => {
    ollama.handler = (_req, res) =>
      void res.writeHead(500).end(JSON.stringify({ error: 'model requires more system memory (9.1 GiB) than is available (6.0 GiB)' }))
    const err = await collect().catch((e) => e)
    expect(err.message).toBe(
      'Not enough memory to load “llama3.2”. Lower the context window in Settings → Models, or pick a smaller or more quantized model.'
    )
  })

  it('gives up when the first byte never arrives', async () => {
    ollama.handler = () => undefined // never answers
    await expect(collect(undefined, { firstByteMs: 150, idleMs: 5_000, toolIdleMs: 5_000 })).rejects.toThrow(/didn't start replying/)
  })

  it('gives up when the stream stalls mid-reply', async () => {
    ollama.handler = (_req, res) => streamChunks(res, [line({ message: { role: 'assistant', content: 'a' }, done: false })]) // then silence
    await expect(collect(undefined, { firstByteMs: 5_000, idleMs: 150, toolIdleMs: 5_000 })).rejects.toThrow(/stopped responding/)
  })

  it('keeps a slow but steady stream alive', async () => {
    const chunks = [0, 1, 2, 3].map((i) => line({ message: { role: 'assistant', content: String(i) }, done: false }))
    ollama.handler = (_req, res) => streamChunks(res, [...chunks, line({ done: true })], 80).then(() => res.end())
    const out = await collect(undefined, { firstByteMs: 5_000, idleMs: 200, toolIdleMs: 5_000 })
    expect(out).toHaveLength(5)
  })

  it('waits longer for a quiet stream when tools are offered (Ollama holds back tool calls)', async () => {
    const tools = [{ type: 'function' as const, function: { name: 'web_search', description: 'search', parameters: {} } }]
    ollama.handler = async (_req, res) => {
      await streamChunks(res, [line({ message: { role: 'assistant', content: '' }, done: false })])
      await new Promise((r) => setTimeout(r, 300)) // longer than idleMs, as a tool call's arguments are generated
      res.end(
        line({
          message: { role: 'assistant', content: '', tool_calls: [{ function: { name: 'web_search', arguments: { query: 'q' } } }] },
          done: false
        }) + line({ done: true })
      )
    }
    const out = await collect(undefined, { firstByteMs: 5_000, idleMs: 150, toolIdleMs: 5_000 }, { ...body, tools })
    expect(out.at(-1)?.done).toBe(true)
  })

  it('closes the connection when the caller stops reading early', async () => {
    let closed = false
    ollama.handler = (req, res) => {
      res.on('close', () => (closed = true))
      return streamChunks(res, [line({ message: { role: 'assistant', content: 'a' }, done: false })]) // then keeps the socket open
    }
    for await (const _chunk of chatStream(t, body, new AbortController().signal, { firstByteMs: 5_000, idleMs: 5_000, toolIdleMs: 5_000 }))
      break
    await vi.waitFor(() => expect(closed).toBe(true), { timeout: 2_000 })
  })

  it('stops with an AbortError, not a timeout error, when the user aborts', async () => {
    ollama.handler = (_req, res) => streamChunks(res, [line({ message: { role: 'assistant', content: 'a' }, done: false })])
    const controller = new AbortController()
    const run = collect(controller.signal, { firstByteMs: 5_000, idleMs: 5_000, toolIdleMs: 5_000 })
    setTimeout(() => controller.abort(), 50)
    const err = await run.catch((e) => e)
    expect(err.name).toBe('AbortError')
  })

  it('sends stream: true and the request body', async () => {
    ollama.handler = (_req, res) => streamChunks(res, [line({ done: true })]).then(() => res.end())
    await collect()
    expect(ollama.requests.at(-1)).toMatchObject({ model: 'llama3.2', stream: true })
  })
})

describe('chatOnce', () => {
  it('returns the single response', async () => {
    ollama.handler = (_req, res) =>
      void res.writeHead(200).end(JSON.stringify({ message: { role: 'assistant', content: 'Title' }, done: true }))
    expect((await chatOnce(t, body, { timeoutMs: 2_000 })).message?.content).toBe('Title')
  })

  it('times out instead of hanging', async () => {
    ollama.handler = () => undefined
    await expect(chatOnce(t, body, { timeoutMs: 150 })).rejects.toThrow(/took too long/)
  })
})

describe('streamTimeoutsFor', () => {
  it('gives only models on a machine the long quiet allowance for tool calls', () => {
    expect(streamTimeoutsFor('this-mac').toolIdleMs).toBe(STREAM_TIMEOUTS.toolIdleMs)
    expect(streamTimeoutsFor('network').toolIdleMs).toBe(STREAM_TIMEOUTS.toolIdleMs)
    expect(streamTimeoutsFor('cloud').toolIdleMs).toBe(STREAM_TIMEOUTS.idleMs)
    expect(STREAM_TIMEOUTS.toolIdleMs).toBeGreaterThan(STREAM_TIMEOUTS.idleMs)
  })
})

describe('targets', () => {
  it('sends the target’s key and names it when it can’t be reached', async () => {
    let auth: string | undefined
    ollama.handler = (req, res) => {
      auth = req.headers.authorization
      return streamChunks(res, [line({ done: true })]).then(() => res.end())
    }
    await collectFrom({ ...t, headers: { Authorization: 'Bearer k' }, keyed: true })
    expect(auth).toBe('Bearer k')
    const gone = { ...t, base: 'http://127.0.0.1:9', name: 'GPU box' }
    await expect(chatOnce(gone, body, { timeoutMs: 2_000 })).rejects.toThrow("Can't reach GPU box at http://127.0.0.1:9.")
  })
})

describe('a failed request', () => {
  const gpu: OllamaTarget = { ...t, base: 'https://gpu.lan:11434', name: 'GPU box' }
  const message = (run: () => Promise<unknown>) =>
    run().then(
      () => '',
      (e: Error) => e.message
    )
  const stubFetch = (cause: unknown) => vi.stubGlobal('fetch', vi.fn().mockRejectedValue(cause))
  afterEach(() => vi.unstubAllGlobals())

  it('says why an endpoint can’t be reached: refused, a host that isn’t there, or an untrusted certificate', async () => {
    const reach = () => message(() => chatOnce(gpu, body, { timeoutMs: 2_000 }))
    stubFetch(fetchFailed('ECONNREFUSED', 'aggregate-no-code'))
    expect(await reach()).toBe("Can't reach GPU box at https://gpu.lan:11434. Is the Ollama app running?")
    stubFetch(fetchFailed('ENOTFOUND'))
    expect(await reach()).toBe("GPU box's host gpu.lan wasn't found. Check the address in Settings → Models → GPU box.")
    stubFetch(fetchFailed('SELF_SIGNED_CERT_IN_CHAIN'))
    expect(await reach()).toBe("GPU box's certificate at gpu.lan:11434 isn't trusted (SELF_SIGNED_CERT_IN_CHAIN).")
  })

  it('says the same of ollama.com: a certificate problem by name, anything else as being offline', async () => {
    const reach = () => message(() => listCloudCatalog())
    stubFetch(fetchFailed('CERT_HAS_EXPIRED'))
    expect(await reach()).toBe("ollama.com's certificate isn't trusted (CERT_HAS_EXPIRED).")
    for (const code of ['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN']) {
      stubFetch(fetchFailed(code))
      expect(await reach()).toBe("Can't reach https://ollama.com. Check your internet connection.")
    }
  })

  it('says the server took too long when the request times out, and keeps the timeout as the cause', async () => {
    const timeout = new DOMException('The operation was aborted due to timeout', 'TimeoutError')
    stubFetch(timeout)
    const err = await chatOnce(gpu, body, { timeoutMs: 2_000 }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(OllamaError)
    expect((err as Error).message).toBe('GPU box took too long to respond. Try again in a moment.')
    expect((err as Error).cause).toBe(timeout)
  })

  it('keeps the cause on the error, and lets a stop through as it is', async () => {
    const cause = fetchFailed('ENOTFOUND')
    stubFetch(cause)
    const err = await chatOnce(gpu, body, { timeoutMs: 2_000 }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(OllamaError)
    expect((err as Error).cause).toBe(cause)
    const stop = new DOMException('This operation was aborted', 'AbortError')
    stubFetch(stop)
    await expect(chatOnce(gpu, body, { timeoutMs: 2_000 })).rejects.toBe(stop)
  })

  it('names the address when a server answers with a bare HTTP error, or a proxy’s HTML page', async () => {
    const answer = (status: number, text: string) => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(text, { status })))
    }
    const reach = () => message(() => chatOnce(gpu, body, { timeoutMs: 2_000 }))
    answer(502, '')
    expect(await reach()).toBe('GPU box at gpu.lan:11434 answered HTTP 502.')
    // A body of only whitespace says as little.
    answer(502, '\n')
    expect(await reach()).toBe('GPU box at gpu.lan:11434 answered HTTP 502.')
    answer(502, '{"error":" \\n"}')
    expect(await reach()).toBe('GPU box at gpu.lan:11434 answered HTTP 502.')
    answer(502, '<html><body><h1>502 Bad Gateway</h1></body></html>')
    expect(await reach()).toBe('GPU box at gpu.lan:11434 answered HTTP 502.')
    answer(404, '<html>404 Not Found</html>')
    expect(await message(() => listTags(gpu))).toBe('GPU box at gpu.lan:11434 answered HTTP 404.')
    answer(502, '')
    expect(await message(() => listCloudCatalog())).toBe('ollama.com answered HTTP 502.')
    answer(500, '{"error":"model runner crashed"}')
    expect(await reach()).toBe('model runner crashed')
    // JSON with no error text says nothing, whatever else it holds; text that isn't JSON is read as it came.
    for (const json of ['{"error":{"code":500}}', '{"error":null}', '{"message":"runner crashed"}', '{}', '[]']) {
      answer(500, json)
      expect(await reach()).toBe('GPU box at gpu.lan:11434 answered HTTP 500.')
    }
    answer(500, '{"error":{"code":500}}')
    expect(await message(() => listCloudCatalog())).toBe('ollama.com answered HTTP 500.')
    answer(500, 'upstream timed out')
    expect(await reach()).toBe('upstream timed out')
  })

  it('reads a 404 as a missing model only when the server says so', async () => {
    // A new Response for each ask: a body reads once.
    const answer = (text: string) =>
      vi.stubGlobal(
        'fetch',
        vi.fn(() => Promise.resolve(new Response(text, { status: 404 })))
      )
    // A chat names its model; listing the models doesn't.
    const chat = () => message(() => chatOnce(gpu, body, { timeoutMs: 2_000 }))
    const bare = 'GPU box at gpu.lan:11434 answered HTTP 404.'
    // What Ollama says of a model it doesn't have.
    answer('{"error":"model \'llama3.2\' not found"}')
    expect(await chat()).toBe('Model “llama3.2” was not found by GPU box.')
    // A proxy's own 404 page, or JSON with no error text, says nothing about the model.
    answer('<html><head><title>404 Not Found</title></head><body>nginx</body></html>')
    expect(await chat()).toBe(bare)
    answer('{"message":"model not found"}')
    expect(await chat()).toBe(bare)
    answer('{"error":{"code":404}}')
    expect(await chat()).toBe(bare)
    // Go's own plain-text 404 is ambiguous (a missing route, or a missing model), so it reads as it always has: a missing
    // model when the request names one, its own words when not.
    answer('404 page not found\n')
    expect(await chat()).toBe('Model “llama3.2” was not found by GPU box.')
    expect(await message(() => listTags(gpu))).toBe('404 page not found\n')
  })
})
