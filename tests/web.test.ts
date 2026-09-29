import { afterEach, describe, expect, it, vi } from 'vitest'
import { fetchFailed } from './fetchFailed'

vi.mock('../src/main/settings', () => ({ getApiKey: () => 'a-secret-key' }))

const { webFetch, webSearch } = await import('../src/main/ollama/web')
const { OllamaError } = await import('../src/main/providers/ollama/wire')

const stubFetch = (cause: unknown) => vi.stubGlobal('fetch', vi.fn().mockRejectedValue(cause))
const answer = (status: number, text: string) => vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(text, { status })))
const message = (run: () => Promise<unknown>) =>
  run().then(
    () => '',
    (e: Error) => e.message
  )
const search = () => message(() => webSearch('llamas'))
afterEach(() => vi.unstubAllGlobals())

describe('web search and fetch when ollama.com can’t be reached', () => {
  it('says which certificate problem it was', async () => {
    stubFetch(fetchFailed('CERT_HAS_EXPIRED'))
    expect(await search()).toBe("ollama.com's certificate isn't trusted (CERT_HAS_EXPIRED).")
    expect(await message(() => webFetch('https://example.com'))).toBe("ollama.com's certificate isn't trusted (CERT_HAS_EXPIRED).")
  })

  it('says to check the connection for a refused connection, a host that isn’t found, or anything else', async () => {
    for (const code of ['ECONNREFUSED', 'ENOTFOUND', 'ECONNRESET']) {
      stubFetch(fetchFailed(code))
      expect(await search()).toBe("Can't reach https://ollama.com. Check your internet connection.")
    }
    stubFetch(new TypeError('fetch failed'))
    expect(await search()).toBe("Can't reach https://ollama.com. Check your internet connection.")
  })

  it('says ollama.com didn’t answer when the request ran out of time', async () => {
    stubFetch(new DOMException('The operation was aborted due to timeout', 'TimeoutError'))
    expect(await search()).toBe("ollama.com didn't answer within 30 seconds.")
  })

  it('keeps the cause on the error, and never puts the key in the message', async () => {
    const cause = fetchFailed('ENOTFOUND')
    stubFetch(cause)
    const err = await webSearch('llamas').catch((e: unknown) => e)
    expect(err).toBeInstanceOf(OllamaError)
    expect((err as Error).cause).toBe(cause)
    expect((err as Error).message).not.toContain('a-secret-key')
  })

  it('words a failure the same while a reply is running, unless the reply was stopped', async () => {
    const running = new AbortController()
    stubFetch(fetchFailed('SELF_SIGNED_CERT_IN_CHAIN'))
    expect(await message(() => webSearch('llamas', 5, running.signal))).toBe(
      "ollama.com's certificate isn't trusted (SELF_SIGNED_CERT_IN_CHAIN)."
    )
    const stop = new DOMException('This operation was aborted', 'AbortError')
    stubFetch(stop)
    running.abort()
    await expect(webSearch('llamas', 5, running.signal)).rejects.toBe(stop)
    await expect(webFetch('https://example.com', running.signal)).rejects.toBe(stop)
  })
})

describe('web search and fetch when ollama.com answers with an error', () => {
  it('names ollama.com and the status when there is no message: an empty body, blank, HTML, or an error that isn’t text', async () => {
    for (const body of [
      '',
      '\n',
      '{"error":" "}',
      '<html><body><h1>502 Bad Gateway</h1></body></html>',
      '  <!doctype html>',
      '{"error":{"code":502}}'
    ]) {
      answer(502, body)
      expect(await search()).toBe('ollama.com answered HTTP 502.')
    }
  })

  it('passes on what ollama.com says', async () => {
    answer(500, '{"error":"search backend unavailable"}')
    expect(await search()).toBe('search backend unavailable')
    answer(500, 'upstream timed out')
    expect(await search()).toBe('upstream timed out')
  })

  it('keeps the wording for a rejected key and the search limit', async () => {
    for (const status of [401, 403]) {
      answer(status, '{"error":"unauthorized"}')
      expect(await search()).toBe('ollama.com rejected the API key.')
    }
    answer(429, '')
    expect(await search()).toBe('Web search limit reached on ollama.com. Try again later.')
  })
})
