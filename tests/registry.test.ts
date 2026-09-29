import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { displayAddress } from '@shared/endpoints'
import type { Endpoint, ModelInfo, ModelListUpdate } from '@shared/types'
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
const { deleteEndpointProfiles, readModelProfile, writeModelDetected, writeModelOverrides } = await import('../src/main/db/kv')
const { setApiKey, setEndpoints } = await import('../src/main/settings')
const { endpointSecretName, setSecret } = await import('../src/main/providers/secrets')
const registry = await import('../src/main/providers/registry')
const { OllamaProvider, ollamaTarget } = await import('../src/main/providers/ollama/adapter')
const { listCloudCatalog } = await import('../src/main/providers/ollama/wire')
const { contextWindowFor } = await import('../src/main/providers/context')
const { billingOf } = await import('../src/main/providers/where')
const { requestCost } = await import('../src/main/usage/pricing')

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

  it('reports a listModels that throws before returning a promise for its own endpoint alone', async () => {
    const real = OllamaProvider.prototype.listModels
    // Not async, so it throws synchronously (OllamaProvider's own listModels is async and never does).
    function listOrThrow(this: InstanceType<typeof OllamaProvider>, refresh: boolean) {
      if (this.endpoint.id === 'gpu') throw new Error('GPU box broke before listing')
      return real.call(this, refresh)
    }
    const broken = vi.spyOn(OllamaProvider.prototype, 'listModels').mockImplementation(listOrThrow)
    try {
      const { models, errors } = await registry.listAllModels(true)
      expect(models.map((m) => m.key)).toEqual(['ollama/gpt-oss:120b-cloud', 'ollama/llama3.2', 'ollama/qwen3:8b'])
      expect(errors).toEqual([
        { endpointId: 'gpu', message: 'GPU box broke before listing' },
        { endpointId: 'down', message: expect.stringMatching(/^Can't reach Down box/) }
      ])
    } finally {
      broken.mockRestore()
    }
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

describe('a slow endpoint', () => {
  const WAIT = 50
  const lateModel = { key: 'gpu/late-model', name: 'late-model', endpoint: { id: 'gpu' } } as ModelInfo
  let late: ModelListUpdate[]
  let gpuCalls: number
  let answer: { resolve: (models: ModelInfo[]) => void; reject: (err: Error) => void }
  let hung: ReturnType<typeof vi.spyOn>

  /** Lets the events a settled promise queued run, then says whether the registry told the listener anything. */
  const settleTimers = () => new Promise<void>((resolve) => setTimeout(resolve, 20))

  beforeEach(() => {
    late = []
    gpuCalls = 0
    registry.onLateModels((update) => late.push(update))
    setEndpoints([ollama('ollama', 'Ollama', a.url), ollama('gpu', 'GPU box', b.url)])
    registry.invalidateProviders()
    // GPU box's listing waits for the test to answer it; Ollama lists as it does.
    const gate = new Promise<ModelInfo[]>((resolve, reject) => (answer = { resolve, reject }))
    const real = OllamaProvider.prototype.listModels
    hung = vi.spyOn(OllamaProvider.prototype, 'listModels').mockImplementation(function (
      this: InstanceType<typeof OllamaProvider>,
      refresh
    ) {
      if (this.endpoint.id !== 'gpu') return real.call(this, refresh)
      gpuCalls++
      return gate
    })
  })
  afterEach(() => {
    hung.mockRestore()
    registry.onLateModels(null)
  })

  it('lists the others at once, and says it is still being waited for', async () => {
    const { models, errors } = await registry.listAllModels(true, WAIT)
    expect(models.map((m) => m.key)).toEqual(['ollama/gpt-oss:120b-cloud', 'ollama/llama3.2', 'ollama/qwen3:8b'])
    expect(errors).toEqual([{ endpointId: 'gpu', message: `Still waiting for GPU box at ${displayAddress(b.url)}…`, pending: true }])
  })

  it('fills the endpoint in when it answers late', async () => {
    await registry.listAllModels(true, WAIT)
    answer.resolve([lateModel])
    await vi.waitFor(() => expect(late).toEqual([{ endpointId: 'gpu', models: [lateModel] }]))
  })

  it('reports why when it fails late', async () => {
    await registry.listAllModels(true, WAIT)
    answer.reject(new Error("Can't reach GPU box at 10.0.0.9:11434."))
    await vi.waitFor(() => expect(late).toEqual([{ endpointId: 'gpu', error: "Can't reach GPU box at 10.0.0.9:11434." }]))
  })

  it('joins the request in flight, even for a refresh, rather than asking a dead host again', async () => {
    await registry.listAllModels(true, WAIT)
    const again = await registry.listAllModels(true, WAIT)
    expect(again.errors).toMatchObject([{ endpointId: 'gpu', pending: true }])
    expect(gpuCalls).toBe(1)
    // One request, so one late answer however many lists waited for it.
    answer.resolve([lateModel])
    await vi.waitFor(() => expect(late).toHaveLength(1))
    await settleTimers()
    expect(late).toHaveLength(1)
  })

  it('asks again once the request has settled', async () => {
    await registry.listAllModels(true, WAIT)
    answer.resolve([lateModel])
    await vi.waitFor(() => expect(late).toHaveLength(1))
    await registry.listAllModels(true, WAIT)
    expect(gpuCalls).toBe(2)
  })

  it('drops a late answer once the endpoints have changed', async () => {
    await registry.listAllModels(true, WAIT)
    registry.invalidateProviders()
    answer.resolve([lateModel])
    await settleTimers()
    expect(late).toEqual([])
  })

  it('drops a late answer from a provider that a new one has replaced', async () => {
    await registry.listAllModels(true, WAIT)
    registry.invalidateProviders()
    // Made again for the same endpoint, so the id still matches: only the instance tells them apart.
    registry.resolve('gpu/late-model')
    answer.resolve([lateModel])
    await settleTimers()
    expect(late).toEqual([])
  })

  it('asks a new provider afresh, since the request in flight belongs to the old one', async () => {
    await registry.listAllModels(true, WAIT)
    registry.invalidateProviders()
    await registry.listAllModels(true, WAIT)
    expect(gpuCalls).toBe(2)
  })

  it('tells no one about an endpoint that answers in time', async () => {
    const quick = new Promise<ModelInfo[]>((resolve) => setTimeout(() => resolve([lateModel]), 5))
    hung.mockImplementation(function (this: InstanceType<typeof OllamaProvider>) {
      return this.endpoint.id === 'gpu' ? quick : Promise.resolve([])
    })
    const { models, errors } = await registry.listAllModels(true, 1_000)
    expect(models).toEqual([lateModel])
    expect(errors).toEqual([])
    await settleTimers()
    expect(late).toEqual([])
  })

  it('still fails an endpoint at once when its server refuses', async () => {
    setEndpoints([ollama('ollama', 'Ollama', a.url), ollama('down', 'Down box', down)])
    registry.invalidateProviders()
    const started = Date.now()
    const { errors } = await registry.listAllModels(true, 10_000)
    expect(errors).toEqual([{ endpointId: 'down', message: expect.stringMatching(/^Can't reach Down box/) }])
    expect(errors[0]).not.toHaveProperty('pending')
    expect(Date.now() - started).toBeLessThan(5_000)
    expect(late).toEqual([])
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

describe('re-detecting a model', () => {
  it('forgets what errors taught an Ollama model and asks /api/show about it again', async () => {
    const shown: string[] = []
    const answer = a.handler
    a.handler = (req, res) => {
      if (req.url === '/api/show') shown.push(String(req.json.model))
      return answer(req, res)
    }
    await registry.modelInfo('ollama/llama3.2')
    writeModelDetected('ollama/llama3.2', { tools: false, reason: 'refused tools' })
    const before = shown.length
    // Read again within the day, it comes from the cache: no request.
    expect((await registry.modelInfo('ollama/llama3.2')).capabilities).not.toContain('tools')
    expect(shown).toHaveLength(before)
    const info = await registry.redetectModel('ollama/llama3.2')
    expect(shown.slice(before)).toEqual(['llama3.2'])
    expect(info.detected).toEqual({})
    expect(info.capabilities).toContain('tools')
    expect(readModelProfile('ollama/llama3.2').detected).toEqual({})
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

  it('sends the account key to ollama.com only over https, and nothing over plain http', () => {
    setApiKey('account-key')
    setSecret(endpointSecretName('plain'), 'plain-key')
    try {
      expect(ollamaTarget({ id: 'plain', name: 'Plain', baseUrl: 'http://ollama.com' })).toEqual({
        base: 'http://ollama.com',
        name: 'Plain',
        cloud: true,
        keyed: false,
        headers: {}
      })
      expect(ollamaTarget({ id: 'secure', name: 'Secure', baseUrl: 'https://ollama.com/' })).toEqual({
        base: 'https://ollama.com',
        name: 'Secure',
        cloud: true,
        keyed: false,
        headers: { Authorization: 'Bearer account-key' }
      })
    } finally {
      setApiKey(null)
      setSecret(endpointSecretName('plain'), null)
    }
  })
})

describe('ollama.com’s catalog', () => {
  it('is read with no key, even with the ollama.com account key set', async () => {
    setApiKey('account-key')
    const fetchMock = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ models: [{ name: 'gpt-oss:120b' }] })))
    vi.stubGlobal('fetch', fetchMock)
    try {
      expect((await listCloudCatalog()).map((m) => m.name)).toEqual(['gpt-oss:120b'])
      expect(fetchMock).toHaveBeenCalledTimes(1)
      const [url, init] = fetchMock.mock.calls[0]
      expect(url).toBe('https://ollama.com/api/tags')
      // No Authorization header: the account key goes only with chat on an ollama.com endpoint, usage and web tools.
      expect(init?.headers).toEqual({ 'Content-Type': 'application/json' })
    } finally {
      vi.unstubAllGlobals()
      setApiKey(null)
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

  it('leaves the window Ollmost sends to Ollama at num_ctx, whatever the override says', () => {
    const local = { contextControl: 'client' as const, contextLength: 131_072, overrides: { contextLength: 8_192 }, detected: {} }
    expect(contextWindowFor(local, { kind: 'ollama', numCtx: 32_768 })).toBe(32_768)
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

describe('requestCost', () => {
  it('prices only priced requests, and a priced one with no known price as unknown', () => {
    const price = { input: 1, cachedInput: null, output: 2 }
    expect(requestCost({ billing: 'priced', price }, 1_000_000, 1_000_000)).toBe(3)
    expect(requestCost({ billing: 'priced', price: null }, 10, 10)).toBeNull()
    expect(requestCost({ billing: 'local', price }, 10, 10)).toBe(0)
    expect(requestCost({ billing: 'untracked', price: null }, 10, 10)).toBe(0)
  })
})
