import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (s: string) => Buffer.from(`enc:${s}`),
    decryptString: (b: Buffer) => b.toString().replace(/^enc:/, '')
  },
  shell: {},
  app: { getPath: () => '' }
}))

const { get, openDatabase } = await import('../src/main/db/index')
const { createConversation } = await import('../src/main/db/conversations')
const { readModelProfile, writeModelOverrides } = await import('../src/main/db/kv')
const { DEFAULT_OLLAMA, getSettings, setEndpoints, updateSettings } = await import('../src/main/settings')
const { endpointSecretName, getSecret, OLLAMA_ACCOUNT_SECRET, setSecret } = await import('../src/main/providers/secrets')
const endpoints = await import('../src/main/providers/endpoints')

const gpu = (over: { apiKey?: string } = {}) =>
  endpoints.addEndpoint({ name: 'GPU box', baseUrl: '192.168.1.20:11434/', kind: 'ollama', flavor: 'ollama', ...over })
const chatOn = (model: string) => createConversation({ projectId: null, model, think: null, skills: [], toolSources: [] })

beforeAll(() => openDatabase(':memory:'))
beforeEach(() => {
  setEndpoints([DEFAULT_OLLAMA])
  setSecret(endpointSecretName('gpu-box'), null)
  updateSettings({ defaultModel: null, titleModel: null })
})

describe('adding an endpoint', () => {
  it('normalises the address, makes an id from the name, and keeps its key for it alone', () => {
    expect(gpu({ apiKey: ' gpu-key ' })).toEqual({
      id: 'gpu-box',
      name: 'GPU box',
      kind: 'ollama',
      flavor: 'ollama',
      baseUrl: 'http://192.168.1.20:11434',
      enabled: true,
      hasKey: true,
      showCloudCatalog: false,
      numCtx: 32768
    })
    expect(getSecret(endpointSecretName('gpu-box'))).toBe('gpu-key')
    expect(getSecret(OLLAMA_ACCOUNT_SECRET)).toBeNull()
    expect(getSettings().endpoints.map((e) => e.id)).toEqual(['ollama', 'gpu-box'])
  })

  it('refuses an address that’s taken, however it’s typed (Review Focus #5)', async () => {
    for (const typed of ['localhost:11434', 'http://localhost:11434/', 'http://127.0.0.1:11434/v1/'])
      expect(() => endpoints.addEndpoint({ name: 'Again', baseUrl: typed, kind: 'ollama', flavor: 'ollama' })).toThrow(
        'Ollama already uses this address.'
      )
    await expect(endpoints.probeNewEndpoint({ baseUrl: 'localhost:11434' })).rejects.toThrow('Ollama already uses this address.')
  })

  it('gives a name that’s taken the next free id', () => {
    expect(endpoints.addEndpoint({ name: 'Ollama', baseUrl: 'http://10.0.0.2:11434', kind: 'ollama', flavor: 'ollama' }).id).toBe(
      'ollama-2'
    )
  })

  it('refuses a nameless endpoint', () => {
    expect(() => endpoints.addEndpoint({ name: '  ', baseUrl: 'http://10.0.0.3:11434', kind: 'ollama', flavor: 'ollama' })).toThrow(
      'Give the endpoint a name.'
    )
  })
})

describe('changing an endpoint', () => {
  it('keeps its id when its name, address and settings change', async () => {
    gpu()
    await expect(
      endpoints.updateEndpoint('gpu-box', {
        name: 'Studio',
        baseUrl: 'http://192.168.1.21:11434/',
        numCtx: 65536,
        showCloudCatalog: true,
        enabled: false
      })
    ).resolves.toMatchObject({
      id: 'gpu-box',
      name: 'Studio',
      baseUrl: 'http://192.168.1.21:11434',
      numCtx: 65536,
      showCloudCatalog: true,
      enabled: false
    })
  })

  it('refuses a taken address, a blank name and a nonsense window', async () => {
    gpu()
    await expect(endpoints.updateEndpoint('gpu-box', { baseUrl: 'localhost:11434' })).rejects.toThrow('Ollama already uses this address.')
    await expect(endpoints.updateEndpoint('gpu-box', { name: '' })).rejects.toThrow('Give the endpoint a name.')
    await expect(endpoints.updateEndpoint('gpu-box', { numCtx: -1 })).rejects.toThrow('whole number of tokens')
    await expect(endpoints.updateEndpoint('nope', { name: 'x' })).rejects.toThrow('That endpoint no longer exists.')
  })

  it('sets and clears its key, but never one for ollama.com', () => {
    gpu()
    expect(endpoints.setEndpointKey('gpu-box', 'k').hasKey).toBe(true)
    expect(endpoints.setEndpointKey('gpu-box', null).hasKey).toBe(false)
    setEndpoints([{ ...DEFAULT_OLLAMA, name: 'Ollama cloud', baseUrl: 'https://ollama.com' }])
    expect(() => endpoints.setEndpointKey('ollama', 'k')).toThrow('ollama.com account key')
  })
})

describe('removing an endpoint', () => {
  it('says what goes, then deletes its key and model settings and keeps its chats', () => {
    gpu({ apiKey: 'gpu-key' })
    chatOn('gpu-box/qwen3:8b')
    chatOn('gpu-box/qwen3:8b')
    chatOn('ollama/llama3.2')
    writeModelOverrides('gpu-box/qwen3:8b', { artifacts: false })
    updateSettings({ defaultModel: 'gpu-box/qwen3:8b', titleModel: 'ollama/llama3.2' })
    expect(endpoints.endpointRemovalImpact('gpu-box')).toEqual({ chats: 2, hasKey: true, overrides: 1 })

    endpoints.removeEndpoint('gpu-box')
    expect(getSettings().endpoints.map((e) => e.id)).toEqual(['ollama'])
    expect(getSecret(endpointSecretName('gpu-box'))).toBeNull()
    expect(readModelProfile('gpu-box/qwen3:8b').overrides).toEqual({})
    expect(getSettings()).toMatchObject({ defaultModel: null, titleModel: 'ollama/llama3.2' })
    // The chats stay, still naming the model: they need another one picked.
    expect(get<{ n: number }>("SELECT COUNT(*) AS n FROM conversations WHERE model = 'gpu-box/qwen3:8b'")?.n).toBe(2)
  })
})
