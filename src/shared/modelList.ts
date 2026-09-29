// Folding an endpoint's late answer into the model list the renderer already has.
import type { ModelListResult, ModelListUpdate } from './types'

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
