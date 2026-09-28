import { describe, expect, it, vi } from 'vitest'
import type { DeepPartial } from '@shared/ipc'
import type { Settings } from '@shared/types'
import { displayAddress, isOllamaCloudUrl, whereOf } from '../src/shared/endpoints'

// The keychain is faked, as in migrate.test.ts: Electron isn't running under vitest.
vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (s: string) => Buffer.from(`enc:${s}`),
    decryptString: (b: Buffer) => b.toString().replace(/^enc:/, '')
  },
  shell: {},
  app: { getPath: () => '' }
}))

/** Fresh modules on a fresh database whose stored settings row is `raw` (none when undefined). */
async function load(raw?: unknown) {
  vi.resetModules()
  const db = await import('../src/main/db/index')
  db.openDatabase(':memory:')
  const kv = await import('../src/main/db/kv')
  if (raw !== undefined) kv.writeSetting('app', raw)
  return { kv, settings: await import('../src/main/settings'), secrets: await import('../src/main/providers/secrets') }
}

const OLLAMA = { id: 'ollama', name: 'Ollama', kind: 'ollama', flavor: 'ollama', enabled: true, hasKey: false }

describe('settings saved by an earlier version', () => {
  it('read what they lack from the defaults: sub-agents run 3 at once, and 24,000 characters of a reply come back', async () => {
    // Saved before sub-agents could run at once or their reply length was a setting, and read for the first time since.
    const { settings } = await load({ userName: 'Ed', delegate: { enabled: false, maxRounds: 10 } })
    expect(settings.getSettings().delegate).toEqual({ enabled: false, maxRounds: 10, parallel: 3, resultChars: 24_000 })
    expect(settings.getSettings().userName).toBe('Ed')
  })

  it('read what they lack from the defaults: a chat’s reply gets up to 20 tool calls', async () => {
    // Saved before chats had their own tool-call limit.
    const { settings } = await load({ userName: 'Ed' })
    expect(settings.getSettings().chat).toEqual({ maxRounds: 20 })
    expect(settings.getSettings().userName).toBe('Ed')
  })
})

describe('the settings migration', () => {
  it('starts a fresh install with one Ollama endpoint on this Mac', async () => {
    const { settings } = await load()
    const s = settings.getSettings()
    expect(s.endpoints).toEqual([{ ...OLLAMA, baseUrl: 'http://127.0.0.1:11434', showCloudCatalog: true, numCtx: 32768 }])
    expect(s.ollamaAccount).toEqual({ hasKey: false })
    for (const gone of ['connection', 'localNumCtx', 'showCloudCatalog']) expect(s).not.toHaveProperty(gone)
  })

  it('turns a local connection into the ollama endpoint and keys the default and title models', async () => {
    const { kv, settings } = await load({
      userName: 'Ed',
      connection: { mode: 'local', host: 'http://10.0.0.5:11434/' },
      showCloudCatalog: false,
      localNumCtx: 65536,
      defaultModel: 'qwen3:8b',
      titleModel: 'hf.co/bartowski/Qwen3-8B-GGUF:Q4_K_M'
    })
    const s = settings.getSettings()
    expect(s.endpoints).toEqual([{ ...OLLAMA, baseUrl: 'http://10.0.0.5:11434', showCloudCatalog: false, numCtx: 65536 }])
    expect(s).toMatchObject({ userName: 'Ed', defaultModel: 'ollama/qwen3:8b', titleModel: 'ollama/hf.co/bartowski/Qwen3-8B-GGUF:Q4_K_M' })
    // Written back at once, like the database's migration: the old fields are gone from the row.
    const row = kv.readSetting<Record<string, unknown>>('app', {})
    expect([row.connection, row.showCloudCatalog, row.localNumCtx]).toEqual([undefined, undefined, undefined])
    expect(row.endpoints).toHaveLength(1)
  })

  it('turns a direct connection into an "Ollama cloud" endpoint on ollama.com', async () => {
    const { settings } = await load({ connection: { mode: 'direct', host: 'http://127.0.0.1:11434' }, defaultModel: null })
    const s = settings.getSettings()
    expect(s.endpoints).toEqual([{ ...OLLAMA, name: 'Ollama cloud', baseUrl: 'https://ollama.com' }])
    expect(s.defaultModel).toBeNull()
  })

  it('leaves a row that already has endpoints alone', async () => {
    const lm = {
      id: 'lm-studio',
      name: 'LM Studio',
      kind: 'openai',
      flavor: 'lmstudio',
      baseUrl: 'http://localhost:1234/v1',
      enabled: true
    }
    const { settings } = await load({ endpoints: [lm], defaultModel: 'lm-studio/qwen/qwen3-8b' })
    expect(settings.getSettings()).toMatchObject({ endpoints: [{ ...lm, hasKey: false }], defaultModel: 'lm-studio/qwen/qwen3-8b' })
  })
})

describe('endpoints in settings', () => {
  it('are never changed by a settings update', async () => {
    const { settings } = await load()
    const before = settings.getSettings().endpoints
    const patch = { endpoints: [], ollamaAccount: { hasKey: true }, userName: 'Ed' } as DeepPartial<Settings>
    expect(settings.updateSettings(patch)).toMatchObject({ endpoints: before, ollamaAccount: { hasKey: false }, userName: 'Ed' })
  })

  it('say whether each has a key, apart from the ollama.com account’s', async () => {
    const { settings, secrets } = await load()
    settings.setApiKey('account-key')
    expect(settings.getSettings()).toMatchObject({ ollamaAccount: { hasKey: true }, endpoints: [{ id: 'ollama', hasKey: false }] })
    secrets.setSecret(secrets.endpointSecretName('ollama'), 'endpoint-key')
    expect(settings.getSettings().endpoints[0].hasKey).toBe(true)
  })

  it('are replaced as a list by setEndpoints, which never stores hasKey', async () => {
    const { kv, settings } = await load()
    settings.setEndpoints([{ ...settings.DEFAULT_OLLAMA, name: 'Home', hasKey: true }])
    expect(settings.getSettings().endpoints[0]).toMatchObject({ name: 'Home', hasKey: false })
    expect(kv.readSetting<{ endpoints: object[] }>('app', { endpoints: [] }).endpoints[0]).not.toHaveProperty('hasKey')
  })
})

describe('addresses', () => {
  it('know ollama.com itself from anything else', () => {
    expect(isOllamaCloudUrl('https://ollama.com')).toBe(true)
    expect(isOllamaCloudUrl('https://ollama.com/')).toBe(true)
    expect(isOllamaCloudUrl('http://127.0.0.1:11434')).toBe(false)
    expect(isOllamaCloudUrl('https://ollama.com.example.net')).toBe(false)
    expect(isOllamaCloudUrl('not a url')).toBe(false)
  })

  it('say where a server runs: this Mac for a loopback address, the network otherwise', () => {
    for (const url of ['http://localhost:1234', 'http://127.0.0.1:11434', 'http://[::1]:8080']) expect(whereOf(url)).toBe('this-mac')
    for (const url of ['http://192.168.1.20:8000/v1', 'http://gpu.local:11434']) expect(whereOf(url)).toBe('network')
  })

  it('show as host, port and any path but /v1', () => {
    expect(displayAddress('http://localhost:1234/v1')).toBe('localhost:1234')
    expect(displayAddress('http://192.168.1.20:8000')).toBe('192.168.1.20:8000')
    expect(displayAddress('https://gpu.example.com/api/openai/v1')).toBe('gpu.example.com/api/openai')
  })
})
