// The model picker's sections and endpoint chips, as data (option B of the approved mockup).
import { isOllamaCloudUrl, whereOf } from './endpoints'
import { modelLabel } from './modelLabel'
import { splitModelKey } from './modelKey'
import type { Endpoint, ModelInfo, ModelListResult, ModelWhere } from './types'

export interface PickerGroup {
  id: string
  endpointId: string
  label: string
  where: ModelWhere
  items: ModelInfo[]
  /** Why the endpoint listed nothing, with Retry beside it. */
  error?: string
  /** Set while the endpoint is still answering, with what to say about it: waiting, not an error. */
  pending?: true
  note?: string
}

export interface EndpointChip {
  id: string
  label: string
  offline: boolean
  error?: string
  /** Set while the endpoint is still answering (it isn't offline), with what its tooltip says. */
  pending?: true
  note?: string
}

/**
 * A section per endpoint, the current model's endpoint first; Ollama keeps its "cloud" and local sections. An endpoint
 * that couldn't list shows why only when it's asked about: its own chip, or the chat's model is on it.
 */
export function groupModels(
  models: readonly ModelInfo[],
  errors: ModelListResult['errors'],
  opts: { query: string; filter: string; currentKey: string | null; endpoints: readonly Endpoint[] }
): PickerGroup[] {
  const q = opts.query.trim().toLowerCase()
  const current = opts.currentKey
    ? splitModelKey(
        opts.currentKey,
        opts.endpoints.map((e) => e.id)
      ).endpointId
    : null
  const shown = opts.endpoints.filter((e) => e.enabled && (opts.filter === 'all' || opts.filter === e.id))
  const ordered = [...shown.filter((e) => e.id === current), ...shown.filter((e) => e.id !== current)]
  const matches = (m: ModelInfo) => !q || m.name.toLowerCase().includes(q) || modelLabel(m).toLowerCase().includes(q)
  const groups: PickerGroup[] = []
  for (const e of ordered) {
    const items = models.filter((m) => m.endpoint.id === e.id && matches(m))
    const failure = errors.find((x) => x.endpointId === e.id)
    // One still answering that listed before keeps its models (the chip says it's waiting) until it answers.
    const kept = failure?.pending && models.some((m) => m.endpoint.id === e.id)
    if (failure && !kept) {
      // Pending or failed, it listed nothing: shown only when asked about, but a pending one as waiting.
      if (opts.filter === e.id || e.id === current) {
        const base = { id: e.id, endpointId: e.id, label: e.name, where: whereOf(e.baseUrl), items: [] }
        groups.push(failure.pending ? { ...base, pending: true, note: failure.message } : { ...base, error: failure.message })
      }
      continue
    }
    if (e.kind === 'ollama') {
      const cloud = items.filter((m) => m.where === 'cloud')
      const local = items.filter((m) => m.where !== 'cloud')
      const cloudLabel = isOllamaCloudUrl(e.baseUrl) ? e.name : `${e.name} cloud`
      if (cloud.length) groups.push({ id: `${e.id}:cloud`, endpointId: e.id, label: cloudLabel, where: 'cloud', items: cloud })
      if (local.length) groups.push({ id: `${e.id}:local`, endpointId: e.id, label: e.name, where: whereOf(e.baseUrl), items: local })
    } else if (items.length) groups.push({ id: e.id, endpointId: e.id, label: e.name, where: whereOf(e.baseUrl), items })
  }
  return groups
}

/** All, then each enabled endpoint; one that couldn't list is offline, with its error, and one still answering is pending. */
export function endpointChips(endpoints: readonly Endpoint[], errors: ModelListResult['errors']): EndpointChip[] {
  return [
    { id: 'all', label: 'All', offline: false },
    ...endpoints
      .filter((e) => e.enabled)
      .map((e) => {
        const failure = errors.find((x) => x.endpointId === e.id)
        if (!failure) return { id: e.id, label: e.name, offline: false }
        return failure.pending
          ? { id: e.id, label: e.name, offline: false, pending: true as const, note: failure.message }
          : { id: e.id, label: e.name, offline: true, error: failure.message }
      })
  ]
}
