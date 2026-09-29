import { createServer, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { Endpoint } from '@shared/types'
import { openDatabase } from '../src/main/db/index'
import { getAccountUsage, invalidateAccountUsage, planEndpoint } from '../src/main/usage/account'
import { fetchFailed } from './fetchFailed'

vi.mock('electron', () => ({ app: { getPath: () => '' }, safeStorage: { isEncryptionAvailable: () => false } }))
const state = vi.hoisted(() => ({ endpoints: [] as Endpoint[], key: null as string | null }))
vi.mock('../src/main/settings', () => ({
  getSettings: () => ({
    endpoints: state.endpoints,
    ollamaAccount: { hasKey: false },
    usage: { anchors: {}, monthlyDay: null, poolUsd: null }
  }),
  getApiKey: () => state.key,
  updateSettings: () => undefined
}))

// A stand-in Ollama app on loopback. It counts the asks for /api/me and answers with `reply`: by default a 404, like an
// older Ollama or anything else on the port.
const servers: Server[] = []
async function daemon(reply: (res: ServerResponse) => void = (res) => void res.writeHead(404).end(), port = 0) {
  const stub = { url: '', meHits: 0, reply }
  const server = createServer((req, res) => {
    if (req.url === '/api/me') stub.meHits++
    stub.reply(res)
  })
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve))
  stub.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  return stub
}
/** An answer with a JSON body. */
const json = (status: number, body: string) => (res: ServerResponse) =>
  void res.writeHead(status, { 'Content-Type': 'application/json' }).end(body)
// What a signed-out Ollama app answers /api/me with (its WhoamiHandler): 401, and where to sign in.
const SIGNED_OUT = json(401, '{"error":"unauthorized","signin_url":"https://ollama.com/connect?name=mac&key=made-up"}')

const endpoint = (over: Partial<Endpoint>): Endpoint => ({
  id: 'ollama',
  name: 'Ollama',
  kind: 'ollama',
  flavor: 'ollama',
  baseUrl: 'http://127.0.0.1:11434',
  enabled: true,
  hasKey: false,
  ...over
})

beforeAll(() => openDatabase(':memory:'))
// Closing waits for open connections, and one a timed-out ask left would hold it for seconds.
afterAll(() =>
  Promise.all(
    servers.map((s) => {
      const closed = new Promise((resolve) => s.close(resolve))
      s.closeAllConnections()
      return closed
    })
  )
)

describe('the account’s plan (/api/me)', () => {
  it('asks the first enabled Ollama endpoint on this Mac, and no other', () => {
    const local = endpoint({ id: 'local', baseUrl: 'http://localhost:11434' })
    expect(
      planEndpoint([
        endpoint({ id: 'lm-studio', kind: 'openai', flavor: 'lmstudio', baseUrl: 'http://localhost:1234/v1' }),
        endpoint({ id: 'cloud', baseUrl: 'https://ollama.com' }),
        endpoint({ id: 'off', enabled: false, baseUrl: 'http://127.0.0.1:11434' }),
        endpoint({ id: 'lan', baseUrl: 'http://192.168.1.20:11434' }),
        local
      ])
    ).toBe(local)
    expect(planEndpoint([endpoint({ id: 'cloud', baseUrl: 'https://ollama.com' })])).toBeNull()
  })

  it('skips /api/me when no Ollama endpoint is on this Mac, whatever else is enabled', async () => {
    // An Ollama server on the network is not the signed-in app: /api/me goes to loopback only, and nothing reaches out.
    state.endpoints = [
      endpoint({ id: 'lan', baseUrl: 'http://192.168.1.20:11434' }),
      endpoint({ id: 'lm-studio', kind: 'openai', flavor: 'lmstudio', baseUrl: 'http://localhost:1234/v1' })
    ]
    const ask = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('no network in this test'))
    try {
      expect((await getAccountUsage(true)).plan).toBeNull()
      expect(ask.mock.calls.filter(([url]) => String(url).endsWith('/api/me'))).toEqual([])
    } finally {
      ask.mockRestore()
    }
  })

  it.each([404, 405, 501])(
    'remembers a server without /api/me (HTTP %i) for the session instead of asking on every load',
    async (status) => {
      const old = await daemon((res) => void res.writeHead(status).end())
      state.endpoints = [endpoint({ baseUrl: old.url })]
      await getAccountUsage(true)
      await getAccountUsage(true)
      // Not only for a while, as a timeout is.
      vi.useFakeTimers({ toFake: ['Date'] })
      try {
        vi.setSystemTime(Date.now() + 60 * 60_000)
        await getAccountUsage(true)
      } finally {
        vi.useRealTimers()
      }
      expect(old.meHits).toBe(1)
    }
  )

  it('remembers an answer that isn’t JSON too: something answered there, and would again', async () => {
    const other = await daemon((res) => void res.writeHead(200, { 'Content-Type': 'text/html' }).end('<html>'))
    state.endpoints = [endpoint({ baseUrl: other.url })]
    await getAccountUsage(true)
    await getAccountUsage(true)
    expect(other.meHits).toBe(1)
  })

  it('remembers a server that doesn’t answer within 5 s for 10 minutes, then asks again', async () => {
    // It never answers: the app waiting on a stalled ollama.com.
    const slow = await daemon(() => undefined)
    // A fresh module: this test ends with a plan, which would answer the tests after it.
    vi.resetModules()
    const account = await import('../src/main/usage/account')
    state.endpoints = [endpoint({ baseUrl: slow.url })]
    // The 5 s timeout, fired early: the same abort the real one gives.
    const timeout = vi.spyOn(AbortSignal, 'timeout').mockImplementation(() => {
      const controller = new AbortController()
      setTimeout(() => controller.abort(new DOMException('The operation was aborted due to timeout', 'TimeoutError')), 20)
      return controller.signal
    })
    vi.useFakeTimers({ toFake: ['Date'] })
    const t0 = Date.now()
    try {
      await account.getAccountUsage(true)
      expect(timeout).toHaveBeenCalledWith(5000)
      // Every load in the next 10 minutes would wait 5 s for it.
      vi.setSystemTime(t0 + 10 * 60_000 - 1)
      await account.getAccountUsage(true)
      expect(slow.meHits).toBe(1)
      // The app waits on ollama.com with no deadline of its own: once ollama.com answers it again, so does the app.
      slow.reply = json(200, '{"plan":"pro"}')
      vi.setSystemTime(t0 + 10 * 60_000)
      expect((await account.getAccountUsage(true)).plan).toBe('pro')
      expect(slow.meHits).toBe(2)
    } finally {
      vi.useRealTimers()
      timeout.mockRestore()
    }
  })

  it('asks again at a different address: the memory is of where it failed, not of failing', async () => {
    const [old, moved] = [await daemon(), await daemon()]
    state.endpoints = [endpoint({ baseUrl: old.url })]
    await getAccountUsage(true)
    await getAccountUsage(true)
    expect(old.meHits).toBe(1)
    state.endpoints = [endpoint({ baseUrl: moved.url })]
    await getAccountUsage(true)
    expect(moved.meHits).toBe(1)
  })

  it('asks again after a refused connection: the Ollama app may not have started yet, or be updating', async () => {
    // A port nothing listens on yet: taken for a moment to learn a free one, then let go.
    const probe = createServer()
    await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve))
    const port = (probe.address() as AddressInfo).port
    await new Promise((resolve) => probe.close(resolve))
    // A fresh module: a plan, once known, is kept for the session, so an earlier test's would answer before anything
    // was asked, and this test's would answer the tests after it.
    vi.resetModules()
    const account = await import('../src/main/usage/account')
    state.endpoints = [endpoint({ baseUrl: `http://127.0.0.1:${port}` })]
    expect((await account.getAccountUsage(true)).plan).toBeNull()
    // The app comes up on its port, and the next load asks it.
    const app = await daemon((res) => void res.writeHead(200, { 'Content-Type': 'application/json' }).end('{"plan":"pro"}'), port)
    expect((await account.getAccountUsage(true)).plan).toBe('pro')
    expect(app.meHits).toBe(1)
  })

  it.each([403, 500, 502, 503])('asks again after HTTP %i: refused for now, or trouble that may pass', async (status) => {
    const app = await daemon(json(status, '{"error":"something went wrong"}'))
    state.endpoints = [endpoint({ baseUrl: app.url })]
    expect((await getAccountUsage(true)).plan).toBeNull()
    expect((await getAccountUsage(true)).plan).toBeNull()
    expect(app.meHits).toBe(2)
  })

  // A signed-in app that can't reach ollama.com (offline, or just after a wake) answers 200 null, or 503 on newer Ollama
  // builds (above).
  it.each(['null', '{}', '{"plan":5}'])('reads a 200 answer of %s as no plan, and asks again at the next load', async (body) => {
    const app = await daemon(json(200, body))
    state.endpoints = [endpoint({ baseUrl: app.url })]
    expect((await getAccountUsage(true)).plan).toBeNull()
    expect((await getAccountUsage(true)).plan).toBeNull()
    expect(app.meHits).toBe(2)
  })

  it('asks a signed-out app again at the next load, since signing in needs no restart', async () => {
    const app = await daemon(SIGNED_OUT)
    state.endpoints = [endpoint({ baseUrl: app.url })]
    expect((await getAccountUsage(true)).plan).toBeNull()
    expect((await getAccountUsage(true)).plan).toBeNull()
    expect(app.meHits).toBe(2)
    app.reply = json(200, '{"plan":"pro"}')
    expect((await getAccountUsage(true)).plan).toBe('pro')
  })
})

describe('the account’s usage', () => {
  it('after the key is removed, reads fresh and gives the load in flight that read, not its own result', async () => {
    // No endpoints: nothing asks for the plan, so the only request is the usage one, held until it's released.
    state.endpoints = []
    state.key = 'a-key'
    let release: (res: Response) => void = () => undefined
    const held = new Promise<Response>((resolve) => (release = resolve))
    const usage = vi.spyOn(globalThis, 'fetch').mockImplementation(() => held)
    try {
      const stale = getAccountUsage(true)
      await vi.waitFor(() => expect(usage).toHaveBeenCalledTimes(1))
      state.key = null
      invalidateAccountUsage()
      // The read after the removal must not wait for the keyed request: without a key it settles at once.
      const fresh = await Promise.race([getAccountUsage(), new Promise<null>((resolve) => setTimeout(resolve, 200, null))])
      release(new Response('{}'))
      // Whoever asked before the removal (the chip's poll) gets what's read after it, never the keyed result.
      expect((await stale).needsKey).toBe(true)
      expect(fresh?.needsKey).toBe(true)
      expect((await getAccountUsage()).needsKey).toBe(true)
      expect(usage).toHaveBeenCalledTimes(1)
    } finally {
      release(new Response('{}'))
      usage.mockRestore()
      state.key = null
    }
  })

  describe('when ollama.com won’t give it', () => {
    /** The usage request, answered by `reply` (a rejection is what fetch does when a connection fails). */
    async function loadWith(reply: () => Promise<Response>) {
      state.endpoints = []
      state.key = 'a-secret-key'
      const ask = vi.spyOn(globalThis, 'fetch').mockImplementation(reply)
      try {
        return await getAccountUsage(true)
      } finally {
        ask.mockRestore()
        state.key = null
        invalidateAccountUsage()
      }
    }
    const answered = (status: number, body = '') => loadWith(() => Promise.resolve(new Response(body, { status })))

    it('says which certificate problem it was', async () => {
      const usage = await loadWith(() => Promise.reject(fetchFailed('CERT_HAS_EXPIRED')))
      expect(usage).toMatchObject({ needsKey: false, error: "ollama.com's certificate isn't trusted (CERT_HAS_EXPIRED)." })
      expect(usage.error).not.toContain('a-secret-key')
    })

    it('says ollama.com didn’t answer within 10 seconds, or to check the connection', async () => {
      const slow = await loadWith(() => Promise.reject(new DOMException('The operation was aborted due to timeout', 'TimeoutError')))
      expect(slow.error).toBe("ollama.com didn't answer within 10 seconds.")
      const offline = await loadWith(() => Promise.reject(fetchFailed('ENOTFOUND')))
      expect(offline).toMatchObject({ needsKey: false, error: "Can't reach https://ollama.com. Check your internet connection." })
    })

    it('names ollama.com when it answers with an error status', async () => {
      expect(await answered(502, '<html>Bad Gateway</html>')).toMatchObject({
        needsKey: false,
        error: 'ollama.com answered HTTP 502 for usage.'
      })
    })

    it('says ollama.com rejected the key, and asks for a new one', async () => {
      for (const status of [401, 403])
        expect(await answered(status)).toMatchObject({
          needsKey: true,
          error: 'ollama.com rejected the API key. Create a new one at ollama.com/settings/keys.'
        })
    })
  })
})
