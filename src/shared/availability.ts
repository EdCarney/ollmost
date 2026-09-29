// Whether a chat's model can be used right now, and if not, why: the composer says so and, unless its endpoint is still
// answering, won't send until another model is picked.
import { labelForKey } from './modelLabel'
import { keyPrefix, splitModelKey } from './modelKey'
import type { Endpoint, ModelInfo, ModelListResult } from './types'

export function modelAvailability(
  key: string | null,
  models: readonly ModelInfo[],
  endpoints: readonly Endpoint[],
  errors: ModelListResult['errors']
): 'ok' | 'none' | 'endpoint-removed' | 'endpoint-disabled' | 'endpoint-waiting' | 'endpoint-offline' | 'model-missing' {
  if (!key) return 'none'
  const ids = endpoints.map((e) => e.id)
  // A prefix shaped like an endpoint id that names none: that endpoint was removed (see registry.resolve).
  const prefix = keyPrefix(key)
  if (prefix !== null && !ids.includes(prefix)) return 'endpoint-removed'
  const { endpointId, model } = splitModelKey(key, ids)
  const endpoint = endpoints.find((e) => e.id === endpointId)
  if (!endpoint) return 'endpoint-removed'
  if (!endpoint.enabled) return 'endpoint-disabled'
  // By endpoint and name, so a bare name from before keys still finds its Ollama model.
  if (models.some((m) => m.endpoint.id === endpointId && m.name === model)) return 'ok'
  // Still answering isn't offline: its list may yet have the model. The composer says so but still sends (a chat request
  // doesn't need the list); every other reason here blocks.
  const error = errors.find((e) => e.endpointId === endpointId)
  if (error) return error.pending ? 'endpoint-waiting' : 'endpoint-offline'
  return 'model-missing'
}

export type ModelAvailability = ReturnType<typeof modelAvailability>

/** What the composer says under an unavailable model: its name, and what to do. */
export function unavailableText(reason: ModelAvailability, key: string, endpoints: readonly Endpoint[]): string {
  const label = labelForKey(key, endpoints)
  const endpoint =
    endpoints.find(
      (e) =>
        e.id ===
        splitModelKey(
          key,
          endpoints.map((x) => x.id)
        ).endpointId
    )?.name ?? 'its endpoint'
  switch (reason) {
    case 'endpoint-removed': {
      // The endpoint's name went with it, so the line names the model alone ("gpt-oss:120b"), not the whole key.
      const prefix = keyPrefix(key)
      const model = prefix === null ? label : splitModelKey(key, [prefix]).model
      return `${model} is unavailable: its endpoint was removed. Pick another model to keep chatting.`
    }
    case 'endpoint-disabled':
      return `${label} is unavailable: ${endpoint} is turned off in Settings → Models. Turn it on, or pick another model.`
    case 'endpoint-waiting':
      return `Waiting for ${endpoint} to list its models…`
    case 'endpoint-offline':
      return `${label} is unavailable: Ollmost can't reach ${endpoint}.`
    case 'model-missing':
      return `${label} is unavailable: ${endpoint} doesn’t list it any more. Pick another model.`
    default:
      return ''
  }
}
