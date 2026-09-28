import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { Endpoint } from '@shared/types'
import { discoverModels } from '../src/main/providers/openai/discovery'
import { fixtureJson, fixtureText, type MockOllama, startMockOllama } from './ollamaMock'

// Each test says what the server answers where; anything else is a 404.
let server: MockOllama
let routes: Record<string, unknown> = {}
let auth: string | undefined
beforeAll(async () => {
  server = await startMockOllama()
  server.handler = (r, res) => {
    auth = r.headers.authorization
    const body = routes[(r.url ?? '').split('?')[0]]
    if (body === undefined) return void res.writeHead(404).end('Not Found')
    if (typeof body === 'number') return void res.writeHead(body).end('{"error":"Unauthorized"}')
    res.writeHead(200, { 'content-type': 'application/json' }).end(typeof body === 'string' ? body : JSON.stringify(body))
  }
})
afterAll(() => server.close())
beforeEach(() => {
  routes = {}
  auth = undefined
})

const ep = (flavor: Endpoint['flavor'], over: Partial<Endpoint> = {}): Endpoint => ({
  id: 's',
  name: 'Server',
  kind: 'openai',
  flavor,
  baseUrl: `${server.url}/v1`,
  enabled: true,
  hasKey: false,
  ...over
})

describe('discoverModels', () => {
  it('reads LM Studio’s own list: chat models only, what they can do, the loaded window, a think preset', async () => {
    routes['/api/v1/models'] = fixtureText('discovery/lmstudio-docs.json')
    expect(await discoverModels(ep('lmstudio'), null)).toEqual([
      {
        name: 'qwen/qwen3-8b',
        capabilities: ['completion', 'tools', 'thinking'],
        contextLength: 16384,
        parameterSize: '8B',
        thinkPreset: 'toggle',
        reportsCapabilities: true
      },
      {
        name: 'google/gemma-3-12b',
        capabilities: ['completion', 'vision'],
        contextLength: null,
        parameterSize: '12B',
        thinkPreset: null,
        reportsCapabilities: true
      },
      {
        name: 'openai/gpt-oss-20b',
        capabilities: ['completion', 'tools', 'thinking'],
        contextLength: null,
        parameterSize: '20B',
        thinkPreset: 'levels',
        reportsCapabilities: true
      }
    ])
  })

  it('reads the LM Studio lists the spike captured, before and after a model loaded', async () => {
    for (const file of ['discovery/lmstudio-models-cold.json', 'discovery/lmstudio-models-loaded.json']) {
      routes['/api/v1/models'] = fixtureText(file)
      const list = fixtureJson<{
        models: Array<{
          type: string
          key: string
          loaded_instances?: Array<{ config?: { context_length?: number } }>
          max_context_length?: number
        }>
      }>(file).models
      const llms = list.filter((m) => m.type === 'llm')
      const found = await discoverModels(ep('lmstudio'), null)
      expect(found.map((m) => m.name)).toEqual(llms.map((m) => m.key))
      for (const [i, m] of llms.entries()) expect(found[i].contextLength).toBe(m.loaded_instances?.[0]?.config?.context_length ?? null)
    }
  })

  it('reads llama.cpp: its window, vision and tools from /props, the size from /models', async () => {
    routes['/v1/models'] = fixtureText('discovery/llamacpp-models.json')
    routes['/props'] = fixtureText('discovery/llamacpp-props.json')
    expect(await discoverModels(ep('llamacpp'), null)).toEqual([
      {
        name: 'Qwen3-8B-Q4_K_M.gguf',
        capabilities: ['completion', 'tools'],
        contextLength: 32768,
        parameterSize: '8.2B',
        thinkPreset: null,
        reportsCapabilities: true
      }
    ])
  })

  it('reads an older llama.cpp’s /props, and one whose template can’t call tools', async () => {
    routes['/v1/models'] = { data: [{ id: 'llava.gguf' }] }
    routes['/props'] = {
      n_ctx: 4096,
      modalities: { vision: true },
      chat_template_caps: { supports_tools: false, supports_tool_calls: false }
    }
    expect(await discoverModels(ep('llamacpp'), null)).toMatchObject([
      { name: 'llava.gguf', capabilities: ['completion', 'vision'], contextLength: 4096 }
    ])
  })

  it('gives llama.cpp the defaults when /props says nothing about tools, or isn’t there', async () => {
    routes['/v1/models'] = { data: [{ id: 'm.gguf' }] }
    routes['/props'] = { default_generation_settings: { n_ctx: 8192 } }
    expect(await discoverModels(ep('llamacpp'), null)).toMatchObject([
      { capabilities: ['completion', 'tools'], contextLength: 8192, reportsCapabilities: true }
    ])
    delete routes['/props']
    expect(await discoverModels(ep('llamacpp'), null)).toMatchObject([
      { capabilities: ['completion', 'tools'], contextLength: null, reportsCapabilities: false }
    ])
  })

  it('reads vLLM’s max_model_len and gives it the defaults', async () => {
    routes['/v1/models'] = fixtureText('discovery/vllm-models.json')
    expect(await discoverModels(ep('vllm'), null)).toEqual([
      {
        name: 'Qwen/Qwen3-8B',
        capabilities: ['completion', 'tools'],
        contextLength: 32768,
        parameterSize: null,
        thinkPreset: null,
        reportsCapabilities: false
      }
    ])
  })

  it('hides embedding and reranking models on a generic server', async () => {
    routes['/v1/models'] = fixtureText('discovery/generic-models.json')
    expect((await discoverModels(ep('generic'), null)).map((m) => m.name)).toEqual(['mistral-small-3.2-24b', 'qwen3-coder-30b-a3b'])
  })

  it('sends the endpoint’s key, and says so when it’s rejected', async () => {
    routes['/v1/models'] = { data: [{ id: 'm' }] }
    await discoverModels(ep('generic'), 'sk-1')
    expect(auth).toBe('Bearer sk-1')
    routes['/v1/models'] = 401
    await expect(discoverModels(ep('generic', { name: 'Lab' }), 'bad')).rejects.toThrow(
      'Lab rejected the API key. Check it in Settings → Models → Lab.'
    )
  })

  it('names the endpoint when it can’t be reached, or sends something that isn’t a list', async () => {
    await expect(discoverModels(ep('vllm', { name: 'GPU box', baseUrl: 'http://127.0.0.1:9/v1' }), null)).rejects.toThrow(
      "Can't reach GPU box at 127.0.0.1:9. Is its server started? Start it with `vllm serve`."
    )
    routes['/v1/models'] = { models: [] }
    await expect(discoverModels(ep('generic'), null)).rejects.toThrow("Server sent a model list Ollmost couldn't read.")
  })
})
