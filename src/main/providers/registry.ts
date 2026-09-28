import { keyPrefix, splitModelKey } from '@shared/modelKey'
import type { Endpoint, ModelInfo, ModelListResult } from '@shared/types'
import { getSettings } from '../settings'
import { errorMessage } from '../util'
import { OllamaProvider } from './ollama/adapter'
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

function build(): Map<string, Provider> {
  const map = new Map<string, Provider>()
  for (const endpoint of getSettings().endpoints)
    if (endpoint.enabled && endpoint.kind === 'ollama') map.set(endpoint.id, new OllamaProvider(endpoint))
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

/** Every enabled endpoint's models, asked in parallel. One that fails adds to `errors`; the others still list. */
export async function listAllModels(refresh = false): Promise<ModelListResult> {
  const list = [...live().values()]
  const settled = await Promise.allSettled(list.map((p) => p.listModels(refresh)))
  const result: ModelListResult = { models: [], errors: [] }
  settled.forEach((r, i) => {
    if (r.status === 'fulfilled') result.models.push(...r.value)
    else result.errors.push({ endpointId: list[i].endpoint.id, message: errorMessage(r.reason) })
  })
  return result
}
