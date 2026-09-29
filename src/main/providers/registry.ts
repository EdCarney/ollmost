import { displayAddress } from '@shared/endpoints'
import { keyPrefix, splitModelKey, toModelKey } from '@shared/modelKey'
import type { Endpoint, ModelInfo, ModelListResult, ModelListUpdate } from '@shared/types'
import { writeModelDetected } from '../db/kv'
import { getSettings } from '../settings'
import { errorMessage } from '../util'
import { OllamaProvider } from './ollama/adapter'
import { OpenAIProvider } from './openai/adapter'
import type { Provider } from './types'

/** A key names an endpoint that's been removed: its chats keep their history and need another model picked. */
export class EndpointGoneError extends Error {
  constructor(readonly endpointId: string) {
    super(`This chat's model was on an endpoint that's been removed (${endpointId}). Pick another model.`)
    this.name = 'EndpointGoneError'
  }
}

// One provider per enabled endpoint, made on first use and again after any endpoint change.
let providers: Map<string, Provider> | null = null

/** The adapter for an endpoint's kind of server. */
export function createProvider(endpoint: Endpoint): Provider {
  return endpoint.kind === 'openai' ? new OpenAIProvider(endpoint) : new OllamaProvider(endpoint)
}

function build(): Map<string, Provider> {
  const map = new Map<string, Provider>()
  for (const endpoint of getSettings().endpoints) if (endpoint.enabled) map.set(endpoint.id, createProvider(endpoint))
  return map
}

const live = (): Map<string, Provider> => (providers ??= build())

/** An endpoint was added, changed, removed or given a key: providers are made again from the settings. */
export function invalidateProviders(): void {
  providers = null
}

/**
 * Which endpoint a key's model is on, and its name there. The only place in main that takes a key apart: every model
 * call (a reply's rounds, a sub-agent, titles, /compact, replay) comes through here.
 */
export function resolve(key: string): { provider: Provider; endpoint: Endpoint; model: string } {
  const endpoints = getSettings().endpoints
  const ids = endpoints.map((e) => e.id)
  // A prefix shaped like an endpoint id that names none: that endpoint was removed. A bare name from before keys has
  // no such prefix, and is Ollama's.
  const prefix = keyPrefix(key)
  if (prefix !== null && !ids.includes(prefix)) throw new EndpointGoneError(prefix)
  const { endpointId, model } = splitModelKey(key, ids)
  const endpoint = endpoints.find((e) => e.id === endpointId)
  if (!endpoint) throw new EndpointGoneError(endpointId)
  const provider = live().get(endpoint.id)
  if (!provider) throw new Error(`${endpoint.name} is turned off. Turn it on in Settings → Models, or pick another model.`)
  return { provider, endpoint, model }
}

export function modelInfo(key: string, refresh = false): Promise<ModelInfo> {
  const { provider, model } = resolve(key)
  return provider.modelInfo(model, refresh)
}

/** Forget what errors taught Ollmost about a model (tools refused, its window), then read it again from its server. */
export function redetectModel(key: string): Promise<ModelInfo> {
  const { endpoint, model } = resolve(key)
  // The canonical key, as every read uses: a bare name from before keys is Ollama's.
  writeModelDetected(toModelKey(endpoint.id, model), {})
  return modelInfo(key, true)
}

/** How long a list waits for one endpoint before it carries on without it (its request keeps going). */
export const LIST_WAIT_MS = 3_000

// At most one list request per provider at a time. A Retry while one hangs joins it: asking a dead host again can't
// make it faster. Keyed by provider, so an endpoint change (a new provider) starts fresh.
const inflight = new WeakMap<Provider, Promise<ModelInfo[]>>()
// Requests a list has stopped waiting for, so one that several lists joined tells the listener once.
const lateWatched = new WeakSet<Promise<ModelInfo[]>>()
let lateListener: ((update: ModelListUpdate) => void) | null = null

/** Who hears when an endpoint that a list stopped waiting for answers or fails; null stops it. main sends it to the windows. */
export function onLateModels(cb: ((update: ModelListUpdate) => void) | null): void {
  lateListener = cb
}

function requestList(p: Provider, refresh: boolean): Promise<ModelInfo[]> {
  const joined = inflight.get(p)
  if (joined) return joined
  // Made async, so a provider that throws before it returns a promise fails only its own endpoint.
  const request = (async () => p.listModels(refresh))()
  inflight.set(p, request)
  const done = () => {
    if (inflight.get(p) === request) inflight.delete(p)
  }
  request.then(done, done)
  return request
}

/** Tell the listener how a request that missed the deadline ends, unless its endpoint has changed since. */
function tellLater(p: Provider, request: Promise<ModelInfo[]>): void {
  if (lateWatched.has(request)) return
  lateWatched.add(request)
  const endpointId = p.endpoint.id
  // `providers`, not live(): after an endpoint change the renderer lists again, so this answer is no use to it.
  const tell = (update: ModelListUpdate) => {
    if (providers?.get(endpointId) === p) lateListener?.(update)
  }
  request.then(
    (models) => tell({ endpointId, models }),
    (err) => tell({ endpointId, error: errorMessage(err) })
  )
}

type Outcome = { models: ModelInfo[] } | { error: string; pending?: true }

async function listOne(p: Provider, refresh: boolean, waitMs: number): Promise<Outcome> {
  const request = requestList(p, refresh)
  let timer: NodeJS.Timeout | undefined
  const deadline = new Promise<'late'>((resolve) => (timer = setTimeout(() => resolve('late'), waitMs)))
  try {
    const answer = await Promise.race([request, deadline])
    if (answer !== 'late') return { models: answer }
    tellLater(p, request)
    return { error: `Still waiting for ${p.endpoint.name} at ${displayAddress(p.endpoint.baseUrl)}…`, pending: true }
  } catch (err) {
    return { error: errorMessage(err) }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Every enabled endpoint's models, asked in parallel. One that fails adds to `errors`; the others still list. One that
 * hasn't answered within `waitMs` adds a `pending` error instead of holding the list up: its request goes on, and the
 * listener from onLateModels hears how it ends.
 */
export async function listAllModels(refresh = false, waitMs = LIST_WAIT_MS): Promise<ModelListResult> {
  const list = [...live().values()]
  const outcomes = await Promise.all(list.map((p) => listOne(p, refresh, waitMs)))
  const result: ModelListResult = { models: [], errors: [] }
  outcomes.forEach((o, i) => {
    const endpointId = list[i].endpoint.id
    if ('models' in o) result.models.push(...o.models)
    else result.errors.push({ endpointId, message: o.error, ...(o.pending && { pending: true as const }) })
  })
  return result
}
