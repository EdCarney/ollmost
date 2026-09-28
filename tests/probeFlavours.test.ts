import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { fixtureText, type MockOllama, startMockOllama } from './ollamaMock'
import { probeEndpoint } from '../src/main/providers/probe'

const server: MockOllama = await startMockOllama()

let routes: Record<string, unknown> = {}
let auths: Array<string | undefined> = []
beforeAll(() => {
  server.handler = (r, res) => {
    auths.push(r.headers.authorization)
    const body = routes[(r.url ?? '').split('?')[0]]
    if (body === undefined) return void res.writeHead(404).end('Not Found')
    if (typeof body === 'number') return void res.writeHead(body).end('{"error":"Unauthorized"}')
    res.writeHead(200, { 'content-type': 'application/json' }).end(typeof body === 'string' ? body : JSON.stringify(body))
  }
})
afterAll(() => server.close())
beforeEach(() => {
  routes = {}
  auths = []
})

describe('probeEndpoint', () => {
  it('finds Ollama first, by /api/version', async () => {
    routes = {
      '/api/version': { version: '0.12.3' },
      '/api/tags': { models: [{ name: 'llama3.2' }] },
      '/api/show': { capabilities: ['completion', 'tools'], model_info: { 'llama.context_length': 8192 } },
      '/v1/models': { data: [{ id: 'llama3.2' }] }
    }
    expect(await probeEndpoint(server.url)).toMatchObject({ kind: 'ollama', flavor: 'ollama' })
  })

  it('finds LM Studio 0.4+ by its own model list, and counts what it reports', async () => {
    routes = { '/api/v1/models': fixtureText('discovery/lmstudio-docs.json'), '/v1/models': { data: [{ id: 'qwen/qwen3-8b' }] } }
    const expected = {
      kind: 'openai',
      flavor: 'lmstudio',
      baseUrl: `${server.url}/v1`,
      version: null,
      models: 3,
      withTools: 2,
      withVision: 1,
      canThink: 2,
      reportsCapabilities: true,
      reportsContext: true
    }
    expect(await probeEndpoint(server.url)).toEqual(expected)
    expect(await probeEndpoint(`${server.url}/v1/`)).toEqual(expected)
    expect(await probeEndpoint(server.url.replace('http://', ''))).toEqual(expected)
  })

  it('finds llama.cpp by /props, with its build as the version', async () => {
    routes = { '/props': fixtureText('discovery/llamacpp-props.json'), '/v1/models': fixtureText('discovery/llamacpp-models.json') }
    expect(await probeEndpoint(server.url)).toEqual({
      kind: 'openai',
      flavor: 'llamacpp',
      baseUrl: `${server.url}/v1`,
      version: 'b6600-abc1234',
      models: 1,
      withTools: 1,
      withVision: 0,
      canThink: 0,
      reportsCapabilities: true,
      reportsContext: true
    })
  })

  it('finds vLLM by max_model_len, with its /version', async () => {
    routes = { '/v1/models': fixtureText('discovery/vllm-models.json'), '/version': { version: '0.11.0' } }
    expect(await probeEndpoint(server.url)).toEqual({
      kind: 'openai',
      flavor: 'vllm',
      baseUrl: `${server.url}/v1`,
      version: '0.11.0',
      models: 1,
      withTools: 1,
      withVision: 0,
      canThink: 0,
      reportsCapabilities: false,
      reportsContext: true
    })
  })

  it('takes any other server that lists models as generic', async () => {
    routes = { '/v1/models': fixtureText('discovery/generic-models.json') }
    expect(await probeEndpoint(server.url)).toEqual({
      kind: 'openai',
      flavor: 'generic',
      baseUrl: `${server.url}/v1`,
      version: null,
      models: 2,
      withTools: 2,
      withVision: 0,
      canThink: 0,
      reportsCapabilities: false,
      reportsContext: false
    })
  })

  it('finds LM Studio before 0.4 as generic', async () => {
    routes = { '/v1/models': fixtureText('discovery/lmstudio-v1-models.json') }
    const p = await probeEndpoint(server.url)
    expect(p).toMatchObject({ kind: 'openai', flavor: 'generic', baseUrl: `${server.url}/v1` })
    expect(p.models).toBeGreaterThan(0)
  })

  it('says when nothing there is a model server', async () => {
    await expect(probeEndpoint(server.url)).rejects.toThrow(
      /^Couldn't find a model server at 127\.0\.0\.1:\d+\. Check the address, and that the server is running\.$/
    )
  })

  it('says when nothing answers at all', async () => {
    await expect(probeEndpoint('http://127.0.0.1:9')).rejects.toThrow("Can't reach 127.0.0.1:9. Is the server started?")
  })

  it('keeps an API base typed with a path of its own when /models answers there, else looks under /v1', async () => {
    routes = { '/v1beta/openai/models': fixtureText('discovery/generic-models.json') }
    expect(await probeEndpoint(`${server.url}/v1beta/openai/`)).toMatchObject({
      kind: 'openai',
      flavor: 'generic',
      baseUrl: `${server.url}/v1beta/openai`,
      models: 2
    })
    routes = { '/api/openai/v1/models': fixtureText('discovery/generic-models.json') }
    expect(await probeEndpoint(`${server.url}/api/openai`)).toMatchObject({ flavor: 'generic', baseUrl: `${server.url}/api/openai/v1` })
  })

  it('asks for a key, sends the one it’s given, and says when it’s wrong', async () => {
    routes = { '/api/v1/models': 401 }
    await expect(probeEndpoint(server.url)).rejects.toThrow(`The server at ${server.url.replace('http://', '')} needs an API key.`)
    await expect(probeEndpoint(server.url, 'sk-x')).rejects.toThrow(
      `The server at ${server.url.replace('http://', '')} rejected the API key.`
    )
    expect(auths.at(-1)).toBe('Bearer sk-x')
  })
})
