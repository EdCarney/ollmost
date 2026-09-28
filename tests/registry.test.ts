import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { type MockOllama, startMockOllama } from './ollamaMock'

vi.mock('electron', () => ({
  safeStorage: { isEncryptionAvailable: () => false, encryptString: () => Buffer.alloc(0), decryptString: () => '' }
}))

const { openDatabase } = await import('../src/main/db/index')
const { updateSettings } = await import('../src/main/settings')
const { listAllModels, modelInfo, resolve } = await import('../src/main/providers/registry')

let ollama: MockOllama
beforeAll(async () => {
  openDatabase(':memory:')
  ollama = await startMockOllama()
  // The cloud catalog would reach ollama.com; these tests list only what the mock app has.
  updateSettings({ connection: { mode: 'local', host: ollama.url }, showCloudCatalog: false })
  ollama.handler = (req, res) => {
    if (req.url === '/api/tags')
      return void res
        .writeHead(200)
        .end(JSON.stringify({ models: [{ name: 'llama3.2' }, { name: 'hf.co/bartowski/Qwen3-8B-GGUF:Q4_K_M' }] }))
    if (req.url === '/api/show')
      return void res.writeHead(200).end(
        JSON.stringify({
          capabilities: ['completion', req.json.model === 'llama3.2' ? 'tools' : 'vision'],
          model_info: { 'llama.context_length': 8192 }
        })
      )
    res.writeHead(404).end()
  }
})
afterAll(() => ollama.close())

describe('registry (Ollama only)', () => {
  it('resolves every model to the Ollama provider, by its whole name', () => {
    expect(resolve('llama3.2').provider.id).toBe('ollama')
    expect(resolve('llama3.2').model).toBe('llama3.2')
    // A name with '/' in it is still one Ollama name.
    expect(resolve('hf.co/bartowski/Qwen3-8B-GGUF:Q4_K_M').model).toBe('hf.co/bartowski/Qwen3-8B-GGUF:Q4_K_M')
  })

  it('lists the models with no error, as models.list did', async () => {
    const out = await listAllModels(true)
    expect(out.error).toBeNull()
    expect(out.models.map((m) => m.name)).toEqual(['hf.co/bartowski/Qwen3-8B-GGUF:Q4_K_M', 'llama3.2'])
  })

  it('reads one model’s info through its provider', async () => {
    expect(await modelInfo('llama3.2')).toMatchObject({
      name: 'llama3.2',
      location: 'local',
      capabilities: ['completion', 'tools'],
      contextLength: 8192
    })
  })

  it('reports an app it can’t reach as the list’s error, with no models', async () => {
    updateSettings({ connection: { mode: 'local', host: 'http://127.0.0.1:1' } })
    try {
      expect(await listAllModels(true)).toEqual({
        models: [],
        error: expect.stringMatching(/^Can't reach Ollama at http:\/\/127\.0\.0\.1:1\./)
      })
    } finally {
      updateSettings({ connection: { mode: 'local', host: ollama.url } })
    }
  })
})
