// Folding an endpoint's late answer into the model list the renderer already has, and what a new chat starts with.
import { modelAvailability } from './availability'
import type { Endpoint, ModelListResult, ModelListUpdate } from './types'

/**
 * The list once an endpoint that was still pending has answered: its models replace any it had, and its pending entry
 * goes (or becomes its error, if it failed). Every other endpoint stays as it was.
 */
export function mergeLateModels(state: ModelListResult, update: ModelListUpdate): ModelListResult {
  const errors = state.errors.filter((e) => e.endpointId !== update.endpointId)
  const models = state.models.filter((m) => m.endpoint.id !== update.endpointId)
  if ('error' in update) return { models, errors: [...errors, { endpointId: update.endpointId, message: update.error }] }
  return { models: [...models, ...update.models], errors }
}

/**
 * The model new chats should hold, given the list as it stands: `current` when it stays (a null when there's nothing
 * yet and nothing to pick).
 *
 * `autoPicked` says the app chose `current`, not the user. A model chosen while the default's endpoint was still
 * answering gives way to the default once it's listed; one the user chose never does. Either stays while its own
 * endpoint is still answering, since its model may yet be listed, and goes when the endpoint failed or dropped it.
 * Its replacement is the default, else an installed model, else the first.
 */
export function nextDraftModel(
  current: string | null,
  autoPicked: boolean,
  defaultKey: string | null | undefined,
  list: ModelListResult,
  endpoints: readonly Endpoint[]
): string | null {
  const { models, errors } = list
  const preferred = defaultKey ? models.find((m) => m.key === defaultKey) : undefined
  if (autoPicked && preferred) return preferred.key
  if (current) {
    if (models.some((m) => m.key === current)) return current
    const availability = modelAvailability(current, models, endpoints, errors)
    if (availability === 'ok' || availability === 'endpoint-waiting') return current
  }
  return (preferred || models.find((m) => m.installed) || models[0])?.key ?? current
}
