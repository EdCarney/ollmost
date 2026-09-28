import { displayAddress, isLoopbackHost, isOllamaCloudUrl, OLLAMA_CLOUD_URL } from '@shared/endpoints'
import type { EndpointProbe } from '@shared/types'
import { listCloudCatalog } from './ollama/wire'

const PROBE_MS = 5_000

/**
 * An address as typed ("localhost:1234", "http://localhost:1234/v1/") as the server's root: scheme, host and port, and
 * any path but a trailing /v1. Typed three ways, one server is one string.
 */
export function normalizeBaseUrl(input: string): string {
  const raw = input.trim()
  if (!raw) throw new Error('Type the server’s address, such as http://localhost:11434.')
  let url: URL
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `http://${raw}`)
  } catch {
    throw new Error(`“${raw}” isn’t an address Ollmost can use. Try one like http://localhost:11434.`)
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('Ollmost talks to model servers over http or https.')
  return `${url.protocol}//${url.host}${url.pathname.replace(/\/+$/, '').replace(/\/v1$/i, '')}`
}

/** Whether two addresses are one server: localhost, 127.0.0.1 and [::1] are all this Mac. */
export function sameServer(a: string, b: string): boolean {
  try {
    const [x, y] = [new URL(normalizeBaseUrl(a)), new URL(normalizeBaseUrl(b))]
    const host = (u: URL) => (isLoopbackHost(u.hostname) ? 'this-mac' : u.hostname)
    return x.protocol === y.protocol && x.port === y.port && host(x) === host(y) && x.pathname === y.pathname
  } catch {
    return false
  }
}

const ollamaFound = (baseUrl: string, version: string | null, models: number): EndpointProbe => ({
  kind: 'ollama',
  flavor: 'ollama',
  baseUrl,
  version,
  models,
  // Ollama reports each model's capabilities and context (/api/show) when it's listed; the probe needn't count them.
  withTools: 0,
  withVision: 0,
  canThink: 0,
  reportsCapabilities: true,
  reportsContext: true
})

async function json(res: Response): Promise<Record<string, unknown>> {
  const body: unknown = await res.json().catch(() => null)
  return typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {}
}

/**
 * What answers at an address. Ollama says so at /api/version; an OpenAI-compatible server lists its models at
 * /v1/models (PR 3 tells LM Studio, llama.cpp and vLLM apart). The key, if given, is sent only there.
 */
export async function probeEndpoint(baseUrl: string, apiKey?: string): Promise<EndpointProbe> {
  const root = normalizeBaseUrl(baseUrl)
  const where = displayAddress(root)
  // ollama.com is the cloud API, not an Ollama app: it has no /api/version, and its catalog needs no key.
  if (isOllamaCloudUrl(root)) return ollamaFound(OLLAMA_CLOUD_URL, null, (await listCloudCatalog()).length)
  const headers: Record<string, string> = apiKey?.trim() ? { Authorization: `Bearer ${apiKey.trim()}` } : {}
  const get = (path: string) => fetch(`${root}${path}`, { headers, signal: AbortSignal.timeout(PROBE_MS) })
  let version: Response
  try {
    version = await get('/api/version')
  } catch (err) {
    throw new Error(
      (err as Error).name === 'TimeoutError'
        ? `${where} didn’t answer within 5 seconds.`
        : `Nothing answered at ${where}. Is the server started?`,
      { cause: err }
    )
  }
  if (version.status === 401 || version.status === 403) throw new Error(`The server at ${where} wants an API key, or rejected this one.`)
  // LM Studio answers any path with an error object, so only a version string says Ollama.
  const v = version.ok ? (await json(version)).version : undefined
  if (typeof v === 'string') {
    const tags = await get('/api/tags')
      .then(json)
      .catch(() => ({}) as Record<string, unknown>)
    return ollamaFound(root, v, Array.isArray(tags.models) ? tags.models.length : 0)
  }
  const models = await get('/v1/models').catch(() => null)
  if (models?.ok) {
    const data = (await json(models)).data
    return {
      kind: 'openai',
      flavor: 'generic',
      baseUrl: `${root}/v1`,
      version: null,
      models: Array.isArray(data) ? data.length : 0,
      withTools: 0,
      withVision: 0,
      canThink: 0,
      reportsCapabilities: false,
      reportsContext: false
    }
  }
  throw new Error(`The server at ${where} doesn’t look like Ollama or an OpenAI-compatible server.`)
}
