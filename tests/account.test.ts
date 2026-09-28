import { createServer, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { Endpoint } from '@shared/types'
import { openDatabase } from '../src/main/db/index'
import { getAccountUsage, invalidateAccountUsage, planEndpoint } from '../src/main/usage/account'

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
async function daemon(reply: (res: ServerResponse) => void = (res) => void res.writeHead(404).end()) {
  const stub = { url: '', meHits: 0, reply }
  const server = createServer((req, res) => {
    if (req.url === '/api/me') stub.meHits++
    stub.reply(res)
  })
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  stub.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  return stub
}
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
afterAll(() => Promise.all(servers.map((s) => new Promise((resolve) => s.close(resolve)))))

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

  it('remembers a failure for the session instead of asking on every load', async () => {
    const old = await daemon()
    state.endpoints = [endpoint({ baseUrl: old.url })]
    await getAccountUsage(true)
    await getAccountUsage(true)
    await getAccountUsage(true)
    expect(old.meHits).toBe(1)
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

  it('does not remember a signed-out answer, since signing in needs no restart', async () => {
    const app = await daemon((res) => void res.writeHead(200, { 'Content-Type': 'application/json' }).end('{}'))
    state.endpoints = [endpoint({ baseUrl: app.url })]
    expect((await getAccountUsage(true)).plan).toBeNull()
    expect((await getAccountUsage(true)).plan).toBeNull()
    expect(app.meHits).toBe(2)
    app.reply = (res) => void res.writeHead(200, { 'Content-Type': 'application/json' }).end('{"plan":"pro"}')
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
})
