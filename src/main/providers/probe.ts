import { displayAddress, FLAVOR_LABELS, hostnameOf, isLoopbackHost, isOllamaCloudUrl, OLLAMA_CLOUD_URL } from '@shared/endpoints'
import type { Endpoint, EndpointFlavor, EndpointProbe } from '@shared/types'
import { fetchFailureMessage } from './fetchFailure'
import { isRecord } from './json'
import { discoverModels } from './openai/discovery'
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

/**
 * An address as typed, cleaned up (a scheme added, trailing slashes dropped) but with its path whole:
 * "localhost:1234/v1/" → "http://localhost:1234/v1". An OpenAI-compatible endpoint stores this, its API base;
 * addresses are still compared by normalizeBaseUrl's root.
 */
export function apiBaseUrl(input: string): string {
  const root = normalizeBaseUrl(input)
  const raw = input.trim()
  const path = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `http://${raw}`).pathname.replace(/\/+$/, '')
  return /\/v1$/i.test(path) ? `${root}/v1` : root
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

/** Ollama's cloud catalog, or a local server's /api/tags count, with the version probeEndpoint already read. */
async function probeOllama(baseUrl: string, apiKey: string | undefined, version: string | null): Promise<EndpointProbe> {
  // ollama.com is the cloud API, not an Ollama app: it has no /api/version, and its catalog needs no key.
  if (isOllamaCloudUrl(baseUrl)) return ollamaFound(OLLAMA_CLOUD_URL, null, (await listCloudCatalog()).length)
  const headers: Record<string, string> = apiKey ? { Authorization: `Bearer ${apiKey}` } : {}
  const tags = await fetch(`${baseUrl}/api/tags`, { headers, signal: AbortSignal.timeout(PROBE_MS) })
    .then(json)
    .catch(() => ({}) as Record<string, unknown>)
  return ollamaFound(baseUrl, version, Array.isArray(tags.models) ? tags.models.length : 0)
}

/**
 * One probe step: the JSON at `url`, or null when that path isn't there (any other answer, or not JSON). Nothing
 * answering, or a demand for a key, ends the probe: no later step would do better.
 */
async function probeJson(url: string, apiKey: string | undefined, address: string): Promise<unknown> {
  let res: Response
  try {
    res = await fetch(url, { headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {}, signal: AbortSignal.timeout(PROBE_MS) })
  } catch (err) {
    // A server that takes the connection but never answers is there, just stuck.
    if ((err as Error).name === 'TimeoutError') throw new Error(`${address} didn’t answer within 5 seconds.`, { cause: err })
    const refused = `Can't reach ${address}. Is the server started?`
    throw new Error(fetchFailureMessage(err, { subject: null, address, host: hostnameOf(url) ?? url }, refused), { cause: err })
  }
  if (res.status === 401 || res.status === 403)
    throw new Error(apiKey ? `The server at ${address} rejected the API key.` : `The server at ${address} needs an API key.`)
  if (!res.ok) return null
  try {
    return (await res.json()) as unknown
  } catch {
    return null
  }
}

/** Read an OpenAI-compatible server's models, and count what the Add endpoint dialog reports. */
async function probeOpenAI(
  flavor: Exclude<EndpointFlavor, 'ollama'>,
  baseUrl: string,
  apiKey: string | undefined,
  version: string | null
): Promise<EndpointProbe> {
  const endpoint: Endpoint = { id: 'probe', name: FLAVOR_LABELS[flavor], kind: 'openai', flavor, baseUrl, enabled: true, hasKey: !!apiKey }
  const models = await discoverModels(endpoint, apiKey ?? null)
  const count = (capability: string) => models.filter((m) => m.capabilities.includes(capability)).length
  return {
    kind: 'openai',
    flavor,
    baseUrl,
    version,
    models: models.length,
    withTools: count('tools'),
    withVision: count('vision'),
    canThink: models.filter((m) => m.thinkPreset !== null).length,
    reportsCapabilities: models.some((m) => m.reportsCapabilities),
    reportsContext: models.some((m) => m.contextLength !== null)
  }
}

/**
 * What kind of server is at an address, tried in the spec's order (each check is particular to one server; the last
 * only needs /models to answer). Returns the address to store: Ollama's root, or the OpenAI API base that answered.
 */
export async function probeEndpoint(baseUrl: string, apiKey?: string): Promise<EndpointProbe> {
  const root = normalizeBaseUrl(baseUrl)
  const key = apiKey?.trim() || undefined
  const address = displayAddress(root)
  if (isOllamaCloudUrl(root)) return probeOllama(root, key, null)
  const version = await probeJson(`${root}/api/version`, key, address)
  if (isRecord(version) && typeof version.version === 'string') return probeOllama(root, key, version.version)
  const lmStudio = await probeJson(`${root}/api/v1/models`, key, address)
  if (isRecord(lmStudio) && Array.isArray(lmStudio.models)) return probeOpenAI('lmstudio', `${root}/v1`, key, null)
  const props = await probeJson(`${root}/props`, key, address)
  if (isRecord(props) && ('default_generation_settings' in props || 'chat_template_caps' in props || 'n_ctx' in props))
    return probeOpenAI('llamacpp', `${root}/v1`, key, typeof props.build_info === 'string' ? props.build_info : null)
  // Almost every server's API base is {root}/v1, and one that serves /models at its root is taken as it is. An address
  // typed with a path of its own (https://example.com/v1beta/openai) is asked there first and kept if it answers;
  // else {root}/v1.
  const typed = apiBaseUrl(baseUrl)
  const bases = new URL(root).pathname === '/' ? [`${root}/v1`, root] : [typed, `${root}/v1`]
  for (const base of new Set(bases)) {
    const list = await probeJson(`${base}/models`, key, address)
    if (!isRecord(list) || !Array.isArray(list.data)) continue
    if (list.data.some((m) => isRecord(m) && typeof m.max_model_len === 'number')) {
      const v = await probeJson(`${root}/version`, key, address)
      return probeOpenAI('vllm', base, key, isRecord(v) && typeof v.version === 'string' ? v.version : null)
    }
    return probeOpenAI('generic', base, key, null)
  }
  throw new Error(`Couldn't find a model server at ${address}. Check the address, and that the server is running.`)
}
