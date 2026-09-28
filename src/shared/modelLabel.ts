// How a model is named wherever Ollmost shows one: the picker, the palette, message footers, usage rows.
import { MIGRATED_ENDPOINT_ID, splitModelKey } from './modelKey'
import type { Endpoint, ModelInfo } from './types'

/** "gpt-oss:120b-cloud" → "gpt-oss:120b", "llama3.2:latest" → "llama3.2": an Ollama name as the picker shows it. */
export const shortModelName = (name: string): string => name.replace(/(:|-)cloud$/, '').replace(/:latest$/, '')

/** A model's name, and its endpoint's when that isn't Ollama: "qwen/qwen3-8b · LM Studio". */
export function modelLabel(m: Pick<ModelInfo, 'name' | 'endpoint'>): string {
  return m.endpoint.kind === 'ollama' ? shortModelName(m.name) : `${m.name} · ${m.endpoint.name}`
}

/** The same label for a stored key (a message's, a usage row's), from the endpoints alone. */
export function labelForKey(key: string | null | undefined, endpoints: readonly Endpoint[]): string {
  if (!key) return 'Choose a model'
  // `ollama` is always known, so an Ollama key reads right before the endpoints load (the debugger has none).
  const ids = [...new Set([MIGRATED_ENDPOINT_ID, ...endpoints.map((e) => e.id)])]
  const { endpointId, model } = splitModelKey(key, ids)
  const e = endpoints.find((x) => x.id === endpointId)
  return modelLabel({
    name: model,
    endpoint: e
      ? { id: e.id, name: e.name, kind: e.kind, flavor: e.flavor }
      : { id: endpointId, name: endpointId, kind: 'ollama', flavor: 'ollama' }
  })
}
