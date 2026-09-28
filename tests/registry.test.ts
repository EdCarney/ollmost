import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Endpoint } from '@shared/types'
import { type MockOllama, startMockOllama } from './ollamaMock'

vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (s: string) => Buffer.from(`enc:${s}`),
    decryptString: (b: Buffer) => b.toString().replace(/^enc:/, '')
  },
  shell: {},
  app: { getPath: () => '' }
}))

const { openDatabase } = await import('../src/main/db/index')
const { deleteEndpointProfiles, readModelProfile, writeModelOverrides } = await import('../src/main/db/kv')
const { setApiKey, setEndpoints } = await import('../src/main/settings')
const { endpointSecretName, setSecret } = await import('../src/main/providers/secrets')
const registry = await import('../src/main/providers/registry')
const { ollamaTarget } = await import('../src/main/providers/ollama/adapter')
const { contextWindowFor } = await import('../src/main/providers/context')
const { billingOf } = await import('../src/main/providers/where')

const HF = 'hf.co/bartowski/Qwen3-8B-GGUF:Q4_K_M'

/** An Ollama that lists `names`: an 8K window each, 128K for a cloud name. */
function serve(mock: MockOllama, names: string[]): void {
  mock.handler = (req, res) => {
    if (req.url === '/api/tags') return void res.writeHead(200).end(JSON.stringify({ models: names.map((name) => ({ name })) }))
    if (req.url === '/api/show') {
      const cloud = /(:|-)cloud$/.test(String(req.json.model))
      return void res
        .writeHead(200)
        .end(JSON.stringify({ capabilities: ['completion', 'tools'], model_info: { 'x.context_length': cloud ? 131072 : 8192 } }))
    }
    res.writeHead(404).end()
  }
}

/** An address nothing listens on: a port that was just given back. */
async function refusedUrl(): Promise<string> {
  const server = createServer()
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  await new Promise<void>((resolve) => server.close(() => resolve()))
  return `http://127.0.0.1:${port}`
}

const ollama = (id: string, name: string, baseUrl: string, over: Partial<Endpoint> = {}) => ({
  id,
  name,
  kind: 'ollama' as const,
  flavor: 'ollama' as const,
  baseUrl,
  enabled: true,
  showCloudCatalog: false,
  numCtx: 32768,
  ...over
})

let a: MockOllama
let b: MockOllama
let down: string
beforeAll(async () => {
  openDatabase(':memory:')
  a = await startMockOllama()
  b = await startMockOllama()
  down = await refusedUrl()
})
afterAll(async () => {
  await a.close()
  await b.close()
})
beforeEach(() => {
  serve(a, ['llama3.2', 'qwen3:8b', 'gpt-oss:120b-cloud'])
  serve(b, ['qwen3:8b'])
  setEndpoints([
    ollama('ollama', 'Ollama', a.url),
    ollama('gpu', 'GPU box', b.url),
    ollama('down', 'Down box', down),
    ollama('off', 'Off box', b.url, { enabled: false })
  ])
  registry.invalidateProviders()
})

describe('listing every endpoint', () => {
  it('lists the endpoints that answer and says which one didn’t (Review Focus #2)', async () => {
    const { models, errors } = await registry.listAllModels(true)
    // The same name on two endpoints is two models; a turned-off endpoint isn't asked.
    expect(models.map((m) => m.key)).toEqual(['ollama/gpt-oss:120b-cloud', 'ollama/llama3.2', 'ollama/qwen3:8b', 'gpu/qwen3:8b'])
    expect(errors).toEqual([{ endpointId: 'down', message: expect.stringMatching(/^Can't reach Down box at http:\/\/127\.0\.0\.1:\d+/) }])
  })

  it('says where each model runs, how it’s billed, and the window it gets', async () => {
    const { models } = await registry.listAllModels(true)
    const byKey = Object.fromEntries(models.map((m) => [m.key, m]))
    expect(byKey['ollama/llama3.2']).toMatchObject({
      name: 'llama3.2',
      endpoint: { id: 'ollama', name: 'Ollama', kind: 'ollama', flavor: 'ollama' },
      where: 'this-mac',
      billing: 'local',
      contextControl: 'client',
      contextLength: 8192,
      contextWindow: 8192,
      detected: {},
      price: null
    })
    expect(byKey['ollama/llama3.2']).not.toHaveProperty('location')
    expect(byKey['ollama/gpt-oss:120b-cloud']).toMatchObject({
      where: 'cloud',
      billing: 'priced',
      contextControl: 'server',
      contextWindow: 131072,
      price: { input: 0.15, output: 0.6 }
    })
  })

  it('caches model info by key, so a name on two endpoints never shares a row', async () => {
    await registry.listAllModels(true)
    expect(readModelProfile('ollama/qwen3:8b').info).not.toBeNull()
    expect(readModelProfile('gpu/qwen3:8b').info).not.toBeNull()
    expect(readModelProfile('qwen3:8b').info).toBeNull()
    writeModelOverrides('gpu-2/qwen3:8b', { artifacts: false })
    expect(deleteEndpointProfiles('gpu')).toBe(1)
    expect(readModelProfile('gpu/qwen3:8b').info).toBeNull()
    expect(readModelProfile('gpu-2/qwen3:8b').overrides).toEqual({ artifacts: false })
    expect(readModelProfile('ollama/qwen3:8b').info).not.toBeNull()
  })
})

describe('resolving a key', () => {
  it('splits on the first slash and keeps an hf.co name whole (Review Focus #1)', () => {
    const r = registry.resolve(`ollama/${HF}`)
    expect([r.provider.id, r.endpoint.id, r.model]).toEqual(['ollama', 'ollama', HF])
    expect(registry.resolve('gpu/qwen3:8b')).toMatchObject({ endpoint: { id: 'gpu' }, model: 'qwen3:8b' })
  })

  it('reads a bare name from before keys as Ollama’s, whole', () => {
    expect(registry.resolve('llama3.2')).toMatchObject({ endpoint: { id: 'ollama' }, model: 'llama3.2' })
    expect(registry.resolve(HF)).toMatchObject({ endpoint: { id: 'ollama' }, model: HF })
  })

  it('refuses a removed endpoint and a turned-off one', () => {
    expect(() => registry.resolve('lm-studio/qwen/qwen3-8b')).toThrow(registry.EndpointGoneError)
    expect(() => registry.resolve('off/qwen3:8b')).toThrow(/Off box is turned off/)
    setEndpoints([ollama('gpu', 'GPU box', b.url)])
    registry.invalidateProviders()
    // With `ollama` removed, a bare name has nowhere to go.
    expect(() => registry.resolve('llama3.2')).toThrow(registry.EndpointGoneError)
  })

  it('asks the key’s own endpoint about its model', async () => {
    const info = await registry.modelInfo('gpu/qwen3:8b', true)
    expect(info).toMatchObject({ key: 'gpu/qwen3:8b', endpoint: { name: 'GPU box' }, installed: true })
    expect(b.requests.at(-1)).toEqual({ model: 'qwen3:8b' })
  })
})

describe('which key goes where', () => {
  it('sends ollama.com the account key and every other server only its own', () => {
    setApiKey('account-key')
    setSecret(endpointSecretName('gpu'), 'gpu-key')
    try {
      expect(ollamaTarget({ id: 'cloud', name: 'Ollama cloud', baseUrl: 'https://ollama.com' })).toMatchObject({
        cloud: true,
        headers: { Authorization: 'Bearer account-key' }
      })
      expect(ollamaTarget({ id: 'gpu', name: 'GPU box', baseUrl: `${b.url}/` })).toEqual({
        base: b.url,
        name: 'GPU box',
        cloud: false,
        keyed: true,
        headers: { Authorization: 'Bearer gpu-key' }
      })
      expect(ollamaTarget({ id: 'ollama', name: 'Ollama', baseUrl: a.url }).headers).toEqual({})
    } finally {
      setApiKey(null)
      setSecret(endpointSecretName('gpu'), null)
    }
  })
})

describe('billing and context windows', () => {
  it('bills Ollama’s cloud models and nothing else', () => {
    expect(billingOf('cloud')).toBe('priced')
    expect(billingOf('this-mac')).toBe('local')
    expect(billingOf('network')).toBe('untracked')
  })

  it('caps a window Ollmost sets at the endpoint’s num_ctx', () => {
    const m = (contextLength: number | null) => ({ contextControl: 'client' as const, contextLength, overrides: {}, detected: {} })
    expect(contextWindowFor(m(131_072), { kind: 'ollama', numCtx: 32_768 })).toBe(32_768)
    expect(contextWindowFor(m(8_192), { kind: 'ollama', numCtx: 32_768 })).toBe(8_192)
    expect(contextWindowFor(m(null), { kind: 'ollama', numCtx: 32_768 })).toBe(32_768)
    expect(contextWindowFor(m(null), { kind: 'ollama' })).toBe(32_768)
  })

  it('takes a window the server sets by precedence: override, detected, reported, the endpoint’s default', () => {
    const m = (over: object) => ({ contextControl: 'server' as const, contextLength: 262_144, overrides: {}, detected: {}, ...over })
    expect(contextWindowFor(m({}), { kind: 'ollama' })).toBe(262_144)
    expect(contextWindowFor(m({ contextLength: null }), { kind: 'ollama' })).toBeNull()
    expect(contextWindowFor(m({ contextLength: null }), { kind: 'openai', defaultContext: 16_384 })).toBe(16_384)
    expect(contextWindowFor(m({ contextLength: null }), { kind: 'openai' })).toBe(8_192)
    expect(contextWindowFor(m({ detected: { contextLength: 40_960 } }), { kind: 'openai' })).toBe(40_960)
    expect(contextWindowFor(m({ detected: { contextLength: 40_960 }, overrides: { contextLength: 32_768 } }), { kind: 'openai' })).toBe(
      32_768
    )
  })
})
