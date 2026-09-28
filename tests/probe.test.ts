import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { normalizeBaseUrl, probeEndpoint, sameServer } from '../src/main/providers/probe'
import { type MockOllama, startMockOllama } from './ollamaMock'

describe('normalizeBaseUrl (Review Focus #5)', () => {
  it('reads a loosely typed address as the server’s root', () => {
    for (const typed of ['localhost:1234', 'http://localhost:1234/', 'http://localhost:1234/v1/', ' HTTP://LocalHost:1234/v1 '])
      expect(normalizeBaseUrl(typed)).toBe('http://localhost:1234')
    expect(normalizeBaseUrl('https://ollama.com/')).toBe('https://ollama.com')
    expect(normalizeBaseUrl('[::1]:11434')).toBe('http://[::1]:11434')
    expect(normalizeBaseUrl('http://gpu.lan:8000/api/openai/v1')).toBe('http://gpu.lan:8000/api/openai')
  })

  it('refuses what isn’t an address', () => {
    expect(() => normalizeBaseUrl('  ')).toThrow('Type the server’s address')
    expect(() => normalizeBaseUrl('not an address')).toThrow('isn’t an address')
    expect(() => normalizeBaseUrl('ftp://files.lan')).toThrow('http or https')
  })

  it('knows this Mac by any of its names', () => {
    expect(sameServer('http://localhost:11434', 'http://127.0.0.1:11434/')).toBe(true)
    expect(sameServer('localhost:11434/v1', 'http://[::1]:11434')).toBe(true)
    expect(sameServer('http://localhost:11434', 'http://localhost:1234')).toBe(false)
    expect(sameServer('http://192.168.1.20:11434', 'http://localhost:11434')).toBe(false)
  })
})

describe('probeEndpoint', () => {
  let server: MockOllama
  let auth: string | undefined
  beforeAll(async () => {
    server = await startMockOllama()
  })
  afterAll(() => server.close())

  it('finds Ollama and counts its models, however the address was typed', async () => {
    server.handler = (req, res) => {
      auth = req.headers.authorization
      if (req.url === '/api/version') return void res.writeHead(200).end(JSON.stringify({ version: '0.12.3' }))
      if (req.url === '/api/tags') return void res.writeHead(200).end(JSON.stringify({ models: [{ name: 'a' }, { name: 'b' }] }))
      res.writeHead(404).end()
    }
    const found = await probeEndpoint(`${server.url}/v1/`, ' sk-1 ')
    expect(found).toEqual({
      kind: 'ollama',
      flavor: 'ollama',
      baseUrl: server.url,
      version: '0.12.3',
      models: 2,
      withTools: 0,
      withVision: 0,
      canThink: 0,
      reportsCapabilities: true,
      reportsContext: true
    })
    expect(auth).toBe('Bearer sk-1')
  })

  it('tells an OpenAI-compatible server from Ollama, even one that answers every path', async () => {
    // LM Studio answers an unknown path with an error object, not a 404.
    server.handler = (req, res) => {
      if (req.url === '/v1/models') return void res.writeHead(200).end(JSON.stringify({ data: [{ id: 'qwen/qwen3-8b' }] }))
      res.writeHead(200).end(JSON.stringify({ error: `Unexpected endpoint or method. (GET ${req.url})` }))
    }
    expect(await probeEndpoint(server.url)).toMatchObject({
      kind: 'openai',
      flavor: 'generic',
      baseUrl: `${server.url}/v1`,
      models: 1,
      reportsCapabilities: false
    })
  })

  it('says when nothing answers, or the server wants a key', async () => {
    await expect(probeEndpoint('http://127.0.0.1:9')).rejects.toThrow('Nothing answered at 127.0.0.1:9. Is the server started?')
    server.handler = (_req, res) => void res.writeHead(401).end()
    await expect(probeEndpoint(server.url)).rejects.toThrow('wants an API key, or rejected this one')
  })
})
