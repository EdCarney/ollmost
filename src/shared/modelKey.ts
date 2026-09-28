// Model identity across endpoints: a key "<endpoint id>/<the model's name at its server>". Only splitModelKey (here)
// and registry.resolve (main) take one apart; a raw name never leaves an adapter.

/** "ollama/gpt-oss:120b-cloud", "lm-studio/qwen/qwen3-8b". Branded so a bare name can't pass for one by accident. */
export type ModelKey = string & { readonly __brand: 'ModelKey' }

/** The endpoint every model from before endpoints is on: the settings and database migrations both use it. */
export const MIGRATED_ENDPOINT_ID = 'ollama'

/** What an endpoint id may be. No '.', so "hf.co/…" never reads as one; no '/', the key's separator. */
export const ENDPOINT_ID = /^[a-z0-9-]+$/

// The picker's endpoint filter uses 'all' for every endpoint, so no endpoint may have that id.
const RESERVED_IDS = ['all']

export const toModelKey = (endpointId: string, model: string): ModelKey => `${endpointId}/${model}` as ModelKey

/**
 * A key's endpoint and model. The part before the first '/' is the endpoint when it's one of `knownIds`; anything
 * else is a bare name from before keys, which is Ollama's, whole: "hf.co/bartowski/Qwen3-8B-GGUF:Q4_K_M" keeps its slashes.
 */
export function splitModelKey(key: string, knownIds: readonly string[]): { endpointId: string; model: string } {
  const slash = key.indexOf('/')
  if (slash > 0 && knownIds.includes(key.slice(0, slash))) return { endpointId: key.slice(0, slash), model: key.slice(slash + 1) }
  return { endpointId: MIGRATED_ENDPOINT_ID, model: key }
}

/**
 * The part before a key's first '/' when it's shaped like an endpoint id, else null. A key whose prefix has that shape
 * but names no endpoint was on one that's been removed. A bare name has none: "llama3.2", or "hf.co/…" (a dot).
 */
export function keyPrefix(key: string): string | null {
  const slash = key.indexOf('/')
  const prefix = slash > 0 ? key.slice(0, slash) : ''
  return ENDPOINT_ID.test(prefix) ? prefix : null
}

/** A new endpoint's id, from its name: "LM Studio" → "lm-studio", "llama.cpp" → "llama-cpp". A clash gets -2, -3… */
export function slugEndpointId(name: string, taken: readonly string[]): string {
  const base =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'endpoint'
  const used = (id: string) => taken.includes(id) || RESERVED_IDS.includes(id)
  if (!used(base)) return base
  let n = 2
  while (used(`${base}-${n}`)) n++
  return `${base}-${n}`
}
