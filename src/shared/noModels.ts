// What Home says when there are no models to pick: a heading, and why, under the endpoints' own errors if any.
import type { Endpoint, ModelListResult } from './types'

/** Why there are no models when no endpoint reported an error. */
function noModelsNote(endpoints: readonly Endpoint[]): string {
  if (!endpoints.length) return 'No endpoints yet. Add one in Settings → Models.'
  // A switched-off endpoint isn't asked, so it has neither models nor an error.
  if (!endpoints.some((e) => e.enabled)) return 'Your endpoints are all turned off. Turn one on in Settings → Models.'
  return 'None of your endpoints has a model yet. Add one, or add another endpoint in Settings → Models.'
}

export interface NoModelsNotice {
  heading: string
  /** Shown under the errors' lines, or alone when there are none. */
  note: string | null
  /** Set while an endpoint is still answering: Home shows it as waiting, not as a warning. */
  waiting?: true
}

const names = new Intl.ListFormat('en-GB', { style: 'long', type: 'conjunction' })

/**
 * "Couldn't load models from any endpoint" only when that's so: every enabled endpoint failed, or the list call itself
 * did (an error with no endpoint). When only some failed, the others answered with no models, and it says so. While
 * one is still answering, it's waiting for that one: it may yet have models.
 */
export function noModelsNotice(endpoints: readonly Endpoint[], errors: ModelListResult['errors']): NoModelsNotice {
  if (!errors.length) return { heading: "Ollmost can't find any models.", note: noModelsNote(endpoints) }
  const waitingFor = endpoints.filter((e) => e.enabled && errors.some((x) => x.pending && x.endpointId === e.id)).map((e) => e.name)
  if (waitingFor.length) return { heading: `Waiting for ${names.format(waitingFor)}…`, note: null, waiting: true }
  const failed = new Set(errors.map((e) => e.endpointId))
  if (failed.has('') || endpoints.filter((e) => e.enabled).every((e) => failed.has(e.id)))
    return { heading: "Couldn't load models from any endpoint", note: null }
  return { heading: "Ollmost can't find any models.", note: 'Your other endpoints have no models yet.' }
}
