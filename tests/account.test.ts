import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { Endpoint } from '@shared/types'
import { openDatabase } from '../src/main/db/index'
import { getAccountUsage, planEndpoint } from '../src/main/usage/account'

vi.mock('electron', () => ({ app: { getPath: () => '' }, safeStorage: { isEncryptionAvailable: () => false } }))
const state = vi.hoisted(() => ({ endpoints: [] as Endpoint[] }))
vi.mock('../src/main/settings', () => ({
  getSettings: () => ({
    endpoints: state.endpoints,
    ollamaAccount: { hasKey: false },
    usage: { anchors: {}, monthlyDay: null, poolUsd: null }
  }),
  getApiKey: () => null,
  updateSettings: () => undefined
}))

// A daemon without /api/me (an older Ollama, or anything else on the port): every ask is a 404.
let meHits = 0
const daemon = createServer((req, res) => {
  if (req.url === '/api/me') meHits++
  res.writeHead(404).end()
})
const at = () => `http://127.0.0.1:${(daemon.address() as AddressInfo).port}`
const endpoint = (over: Partial<Endpoint>): Endpoint => ({
  id: 'ollama',
  name: 'Ollama',
  kind: 'ollama',
  flavor: 'ollama',
  baseUrl: at(),
  enabled: true,
  hasKey: false,
  ...over
})

beforeAll(async () => {
  openDatabase(':memory:')
  await new Promise<void>((resolve) => daemon.listen(0, '127.0.0.1', resolve))
})
afterAll(() => daemon.close())

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
      endpoint({ id: 'lm-studio', kind: 'openai', flavor: 'lmstudio', baseUrl: `${at()}/v1` })
    ]
    const ask = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('no network in this test'))
    try {
      expect((await getAccountUsage(true)).plan).toBeNull()
      expect(ask.mock.calls.filter(([url]) => String(url).endsWith('/api/me'))).toEqual([])
    } finally {
      ask.mockRestore()
    }
    expect(meHits).toBe(0)
  })

  it('remembers a failure for the session instead of asking on every load', async () => {
    state.endpoints = [endpoint({})]
    await getAccountUsage(true)
    await getAccountUsage(true)
    await getAccountUsage(true)
    expect(meHits).toBe(1)
  })
})
