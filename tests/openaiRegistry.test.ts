import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { type MockOllama, startMockOllama } from './ollamaMock'

// The registry and the endpoint store for real, on an in-memory database; only Electron is faked.
vi.mock('electron', () => ({
  app: { getPath: () => '' },
  BrowserWindow: { getAllWindows: () => [] },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (s: string) => Buffer.from(s),
    decryptString: (b: Buffer) => b.toString()
  },
  shell: {},
  nativeImage: {}
}))

const server: MockOllama = await startMockOllama()
const { openDatabase } = await import('../src/main/db/index')
const { getSettings, setEndpoints, setEndpointStreamOptions } = await import('../src/main/settings')
const { writeModelDetected, writeModelOverrides } = await import('../src/main/db/kv')
const { addEndpoint, removeEndpoint, updateEndpoint } = await import('../src/main/providers/endpoints')
const registry = await import('../src/main/providers/registry')
const { OpenAIProvider } = await import('../src/main/providers/openai/adapter')

beforeAll(() => openDatabase(':memory:'))
afterAll(() => server.close())

/**
 * An OpenAI-compatible server that holds its first request for /v1/models until `answer()`; `asked` settles once the
 * probe is waiting on it. Discovery reads the list again once the probe has told the flavour apart (Task 3.7), so any
 * later /v1/models request answers at once.
 */
async function slowOpenAI(): Promise<{ mock: MockOllama; asked: Promise<void>; answer: () => void }> {
  const mock = await startMockOllama()
  const send = (res: Parameters<MockOllama['handler']>[1]) => void res.writeHead(200).end(JSON.stringify({ data: [{ id: 'm' }] }))
  let held: (() => void) | null = null
  const asked = new Promise<void>((resolve) => {
    mock.handler = (r, res) => {
      if (r.url !== '/v1/models') return void res.writeHead(404).end()
      if (held) return send(res)
      held = () => send(res)
      resolve()
    }
  })
  return { mock, asked, answer: () => held?.() }
}

const request = {
  model: 'x',
  messages: [{ role: 'user' as const, content: 'hi' }],
  think: null,
  profile: { kind: 'none' as const },
  contextWindow: null
}

describe('an OpenAI-compatible endpoint', () => {
  let id = ''
  beforeAll(() => {
    id = addEndpoint({ name: 'LM Studio', baseUrl: `${server.url}/v1`, kind: 'openai', flavor: 'lmstudio' }).id
  })

  it('can be added, and its keys resolve to an OpenAIProvider for it', () => {
    expect(id).toBe('lm-studio')
    const { provider, endpoint, model } = registry.resolve('lm-studio/qwen/qwen3-8b')
    expect(provider).toBeInstanceOf(OpenAIProvider)
    expect(endpoint).toMatchObject({ id: 'lm-studio', kind: 'openai', flavor: 'lmstudio' })
    expect(model).toBe('qwen/qwen3-8b')
  })

  it('keeps a rejected stream_options off, across new providers', () => {
    setEndpointStreamOptions(id, false)
    expect(getSettings().endpoints.find((e) => e.id === id)?.streamOptions).toBe(false)
    registry.invalidateProviders()
    expect(registry.resolve('lm-studio/x').provider.wire(request, true).body).not.toHaveProperty('stream_options')
  })

  it('keeps an OpenAI-compatible server by its API base, and probes an edited address before storing it', async () => {
    expect(getSettings().endpoints.find((e) => e.id === id)).toMatchObject({
      kind: 'openai',
      flavor: 'lmstudio',
      baseUrl: `${server.url}/v1`
    })
    const moved = await startMockOllama()
    moved.handler = (r, res) =>
      r.url === '/v1/models' ? void res.writeHead(200).end(JSON.stringify({ data: [{ id: 'm' }] })) : void res.writeHead(404).end()
    try {
      const box = addEndpoint({ name: 'Box', baseUrl: 'http://127.0.0.1:9/v1/', kind: 'openai', flavor: 'vllm' })
      expect(box).toMatchObject({ kind: 'openai', flavor: 'vllm', baseUrl: 'http://127.0.0.1:9/v1' })
      // Typed without /v1: the probe finds the API under it, and that's what is kept, with the kind of server found there.
      expect(await updateEndpoint(box.id, { baseUrl: moved.url })).toMatchObject({
        id: box.id,
        baseUrl: `${moved.url}/v1`,
        flavor: 'generic'
      })
    } finally {
      await moved.close()
    }
  })

  it('asks a server at an edited address for stream_options again, whatever the old one refused', async () => {
    const moved = await startMockOllama()
    moved.handler = (r, res) =>
      r.url === '/v1/models' ? void res.writeHead(200).end(JSON.stringify({ data: [{ id: 'm' }] })) : void res.writeHead(404).end()
    const box = addEndpoint({ name: 'Old box', baseUrl: 'http://127.0.0.1:10/v1', kind: 'openai', flavor: 'generic' })
    try {
      setEndpointStreamOptions(box.id, false)
      await updateEndpoint(box.id, { baseUrl: moved.url })
      expect(getSettings().endpoints.find((e) => e.id === box.id)?.streamOptions).toBeUndefined()
      expect(registry.resolve(`${box.id}/m`).provider.wire(request, true).body).toHaveProperty('stream_options')
    } finally {
      removeEndpoint(box.id)
      await moved.close()
    }
  })

  // The renderer never sends a flavour, but whatever it sends is checked.
  it('keeps the flavour its probe found over one sent beside the address, and never takes Ollama’s', async () => {
    const moved = await startMockOllama()
    moved.handler = (r, res) =>
      r.url === '/v1/models' ? void res.writeHead(200).end(JSON.stringify({ data: [{ id: 'm' }] })) : void res.writeHead(404).end()
    const box = addEndpoint({ name: 'Flavour box', baseUrl: 'http://127.0.0.1:11/v1', kind: 'openai', flavor: 'vllm' })
    try {
      expect(await updateEndpoint(box.id, { baseUrl: moved.url, flavor: 'llamacpp' })).toMatchObject({ flavor: 'generic' })
      expect(await updateEndpoint(box.id, { flavor: 'ollama' })).toMatchObject({ kind: 'openai', flavor: 'generic' })
      // A flavour sent on its own is still taken.
      expect(await updateEndpoint(box.id, { flavor: 'vllm' })).toMatchObject({ flavor: 'vllm' })
    } finally {
      removeEndpoint(box.id)
      await moved.close()
    }
  })

  it('refuses an edited address where Ollama answers, and keeps the endpoint as it was', async () => {
    const ollama = await startMockOllama()
    ollama.handler = (r, res) => {
      if (r.url === '/api/version') return void res.writeHead(200).end(JSON.stringify({ version: '0.34.4' }))
      if (r.url === '/api/tags') return void res.writeHead(200).end(JSON.stringify({ models: [] }))
      res.writeHead(404).end()
    }
    try {
      const before = getSettings().endpoints.find((e) => e.id === id)
      await expect(updateEndpoint(id, { name: 'Moved', baseUrl: ollama.url })).rejects.toThrow(
        'Ollama answers at that address, not an OpenAI-compatible server. Add it as an endpoint of its own.'
      )
      expect(getSettings().endpoints.find((e) => e.id === id)).toEqual(before)
    } finally {
      await ollama.close()
    }
  })

  // Before the tests below turn this endpoint off.
  it('re-detect forgets what errors taught, and reads the model again', async () => {
    server.handler = (r, res) =>
      r.url === '/api/v1/models'
        ? void res.writeHead(200).end(
            JSON.stringify({
              models: [{ type: 'llm', key: 'qwen/qwen3-8b', max_context_length: 32768, capabilities: { trained_for_tool_use: true } }]
            })
          )
        : void res.writeHead(404).end()
    const key = 'lm-studio/qwen/qwen3-8b'
    writeModelDetected(key, { tools: false, reason: 'server lacks --jinja' })
    expect((await registry.modelInfo(key)).capabilities).not.toContain('tools')
    const info = await registry.redetectModel(key)
    expect(info.detected).toEqual({})
    expect(info.capabilities).toContain('tools')
  })

  it('keeps a change made to another endpoint while an edited address was being probed', async () => {
    const slow = await slowOpenAI()
    try {
      const box = addEndpoint({ name: 'Slow box', baseUrl: 'http://10.0.0.9:8000/v1', kind: 'openai', flavor: 'vllm' })
      const edit = updateEndpoint(box.id, { baseUrl: slow.mock.url })
      await slow.asked
      await updateEndpoint(id, { name: 'Renamed meanwhile', enabled: false })
      slow.answer()
      expect(await edit).toMatchObject({ id: box.id, baseUrl: `${slow.mock.url}/v1`, flavor: 'generic' })
      expect(getSettings().endpoints.find((e) => e.id === id)).toMatchObject({ name: 'Renamed meanwhile', enabled: false })
      expect(getSettings().endpoints.find((e) => e.id === box.id)?.baseUrl).toBe(`${slow.mock.url}/v1`)
    } finally {
      await slow.mock.close()
    }
  })

  it('refuses an edited address another endpoint took while it was being probed', async () => {
    const slow = await slowOpenAI()
    try {
      const box = addEndpoint({ name: 'Late box', baseUrl: 'http://10.0.0.11:8000/v1', kind: 'openai', flavor: 'vllm' })
      const edit = updateEndpoint(box.id, { baseUrl: slow.mock.url })
      await slow.asked
      addEndpoint({ name: 'Quick', baseUrl: `${slow.mock.url}/v1`, kind: 'openai', flavor: 'generic' })
      slow.answer()
      await expect(edit).rejects.toThrow('Quick already uses this address.')
      expect(getSettings().endpoints.find((e) => e.id === box.id)?.baseUrl).toBe('http://10.0.0.11:8000/v1')
    } finally {
      await slow.mock.close()
    }
  })

  it('refuses an edit to an endpoint removed while its address was being probed, and doesn’t bring it back', async () => {
    const slow = await slowOpenAI()
    try {
      const box = addEndpoint({ name: 'Short-lived', baseUrl: 'http://10.0.0.10:8000/v1', kind: 'openai', flavor: 'vllm' })
      const edit = updateEndpoint(box.id, { baseUrl: slow.mock.url })
      await slow.asked
      removeEndpoint(box.id)
      slow.answer()
      await expect(edit).rejects.toThrow('That endpoint no longer exists.')
      expect(getSettings().endpoints.map((e) => e.id)).not.toContain(box.id)
    } finally {
      await slow.mock.close()
    }
  })

  it('lets the user turn an Ollama model’s tools off and its vision on', async () => {
    const ollama = await startMockOllama()
    ollama.handler = (r, res) =>
      r.url === '/api/show'
        ? void res
            .writeHead(200)
            .end(JSON.stringify({ capabilities: ['completion', 'tools'], model_info: { 'llama.context_length': 8192 } }))
        : void res.writeHead(200).end(JSON.stringify({ models: [{ name: 'llama3.2' }] }))
    setEndpoints(getSettings().endpoints.map((e) => (e.id === 'ollama' ? { ...e, baseUrl: ollama.url, showCloudCatalog: false } : e)))
    registry.invalidateProviders()
    writeModelOverrides('ollama/llama3.2', { tools: false, vision: true })
    try {
      expect(await registry.modelInfo('ollama/llama3.2')).toMatchObject({
        capabilities: ['completion', 'vision'],
        auto: { capabilities: ['completion', 'tools'] }
      })
    } finally {
      await ollama.close()
    }
  })
})
