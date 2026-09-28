import type { Endpoint, ThinkProfile } from '@shared/types'
import { isRecord } from '../json'
import { friendlyOpenAIError, OpenAIError, unreachableError } from './errors'

/** What discovery learns about one model. Where a server reports nothing, the defaults are filled in: tools on, vision off. */
export interface DiscoveredModel {
  name: string
  capabilities: string[]
  contextLength: number | null
  parameterSize: string | null
  thinkPreset: ThinkProfile['kind'] | null
  reportsCapabilities: boolean
}

type Where = Pick<Endpoint, 'name' | 'baseUrl' | 'flavor'>

// Short calls should never hang the UI on a wedged server.
const DISCOVERY_TIMEOUT_MS = 30_000

// Tools on, vision off: what a model gets when its server says nothing about it.
const DEFAULT_CAPABILITIES = ['completion', 'tools']

// Embedding and reranking models can't chat; servers that list them beside chat models give only their names.
const NOT_CHAT = /(^|[-_/])(embed|embedding|rerank)/i

/** The address without its trailing /v1: where LM Studio's and llama.cpp's own APIs live. */
export const rootOf = (baseUrl: string): string => baseUrl.replace(/\/+$/, '').replace(/\/v1$/, '')

const unreadable = (endpoint: Where) => new OpenAIError(`${endpoint.name} sent a model list Ollmost couldn't read.`)

/** GET a JSON document from the endpoint with its key; a failure comes back in words that name the endpoint. */
export async function getJson(endpoint: Where, url: string, apiKey: string | null, timeoutMs = DISCOVERY_TIMEOUT_MS): Promise<unknown> {
  let res: Response
  try {
    res = await fetch(url, { headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {}, signal: AbortSignal.timeout(timeoutMs) })
  } catch (err) {
    if ((err as Error).name === 'TimeoutError')
      throw new OpenAIError(`${endpoint.name} took too long to list its models. Try again in a moment.`)
    throw unreachableError(endpoint)
  }
  const text = await res.text().catch(() => '')
  if (!res.ok) throw friendlyOpenAIError(endpoint, res.status, text).error
  try {
    return JSON.parse(text) as unknown
  } catch {
    throw unreadable(endpoint)
  }
}

/** The entries of an OpenAI `/models` list that have an id. */
function dataOf(endpoint: Where, json: unknown): Array<Record<string, unknown> & { id: string }> {
  if (!isRecord(json) || !Array.isArray(json.data)) throw unreadable(endpoint)
  return json.data.filter((m): m is Record<string, unknown> & { id: string } => isRecord(m) && typeof m.id === 'string')
}

function genericModels(endpoint: Where, json: unknown): DiscoveredModel[] {
  return dataOf(endpoint, json)
    .filter((m) => !NOT_CHAT.test(m.id))
    .map((m) => ({
      name: m.id,
      capabilities: [...DEFAULT_CAPABILITIES],
      contextLength: null,
      parameterSize: null,
      thinkPreset: null,
      reportsCapabilities: false
    }))
}

/** The chat models an endpoint offers, with what its server reports about each. Throws a friendly error when it can't. */
export async function discoverModels(endpoint: Endpoint, apiKey: string | null): Promise<DiscoveredModel[]> {
  const base = endpoint.baseUrl.replace(/\/+$/, '')
  return genericModels(endpoint, await getJson(endpoint, `${base}/models`, apiKey))
}
