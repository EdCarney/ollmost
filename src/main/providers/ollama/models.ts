import { isOllamaCloudUrl } from '@shared/endpoints'
import { toModelKey } from '@shared/modelKey'
import type { Endpoint, ModelInfo, ModelWhere } from '@shared/types'
import { type CachedModelInfo, readModelProfile, writeModelInfo } from '../../db/kv'
import { modelPrice } from '../../usage/pricing'
import { effectiveCapabilities } from '../capabilities'
import { contextWindowFor } from '../context'
import { billingOf, whereOf } from '../where'
import { isCloudName, listCloudCatalog, listTags, type OllamaTarget, showModel } from './wire'

const INFO_TTL = 24 * 60 * 60 * 1000
const CATALOG_TTL = 60 * 60 * 1000

// ollama.com's catalog is the same for every endpoint, so one cache serves them all.
let catalogCache: { at: number; names: string[] } | null = null

/**
 * Through the local daemon, a cloud catalog model "glm-5.3" is addressed as "glm-5.3:cloud"
 * and "gpt-oss:120b" as "gpt-oss:120b-cloud" — no pull needed.
 */
export function toDaemonCloudName(catalogName: string): string {
  return catalogName.includes(':') ? `${catalogName}-cloud` : `${catalogName}:cloud`
}

export { isCloudName }

async function cloudCatalog(refresh: boolean): Promise<string[]> {
  if (!refresh && catalogCache && Date.now() - catalogCache.at < CATALOG_TTL) return catalogCache.names
  const names = (await listCloudCatalog()).map((m) => m.name)
  catalogCache = { at: Date.now(), names }
  return names
}

function contextLengthOf(info: Record<string, unknown> | undefined): number | null {
  if (!info) return null
  for (const [k, v] of Object.entries(info)) if (k.endsWith('.context_length') && typeof v === 'number') return v
  return null
}

const UNKNOWN: CachedModelInfo = { capabilities: ['completion'], contextLength: null, family: null, parameterSize: null }

async function fetchInfo(t: OllamaTarget, key: string, name: string, refresh: boolean): Promise<CachedModelInfo> {
  const cached = readModelProfile(key)
  if (!refresh && cached.info && Date.now() - cached.fetchedAt < INFO_TTL) return cached.info
  try {
    const show = await showModel(t, name)
    const info: CachedModelInfo = {
      capabilities: show.capabilities ?? ['completion'],
      contextLength: contextLengthOf(show.model_info),
      family: show.details?.family || null,
      parameterSize: show.details?.parameter_size || null
    }
    writeModelInfo(key, info)
    return info
  } catch (err) {
    if (cached.info) return cached.info
    throw err
  }
}

/** Where an Ollama model runs: everything on ollama.com, and the app's cloud names, in Ollama's cloud; the rest where the server is. */
export function ollamaWhere(endpoint: Pick<Endpoint, 'baseUrl'>, name: string): ModelWhere {
  return isOllamaCloudUrl(endpoint.baseUrl) || isCloudName(name) ? 'cloud' : whereOf(endpoint.baseUrl)
}

function toModelInfo(endpoint: Endpoint, name: string, info: CachedModelInfo, installed: boolean): ModelInfo {
  const key = toModelKey(endpoint.id, name)
  const { overrides, detected } = readModelProfile(key)
  const where = ollamaWhere(endpoint, name)
  const billing = billingOf(where)
  // Ollmost sets num_ctx for the models an Ollama app runs; ollama.com sizes its cloud models itself.
  const contextControl: ModelInfo['contextControl'] = where === 'cloud' ? 'server' : 'client'
  return {
    key,
    name,
    endpoint: { id: endpoint.id, name: endpoint.name, kind: endpoint.kind, flavor: endpoint.flavor },
    where,
    billing,
    contextControl,
    contextWindow: contextWindowFor({ contextControl, contextLength: info.contextLength, overrides, detected }, endpoint),
    installed,
    capabilities: effectiveCapabilities(info.capabilities, overrides, detected),
    // Ollama reports each model's capabilities.
    toolsKnown: true,
    auto: {
      capabilities: effectiveCapabilities(info.capabilities, {}, detected),
      contextWindow: contextWindowFor({ contextControl, contextLength: info.contextLength, overrides: {}, detected }, endpoint)
    },
    contextLength: info.contextLength,
    family: info.family,
    parameterSize: info.parameterSize,
    overrides,
    detected,
    price: billing === 'priced' ? modelPrice(name) : null
  }
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length)
  let i = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++
      out[idx] = await fn(items[idx])
    }
  })
  await Promise.all(workers)
  return out
}

/**
 * Every chat model an Ollama endpoint offers. Throws when the server can't be reached, so the picker shows it offline:
 * the catalog's cloud names need the Ollama app running too.
 */
export async function listOllamaModels(endpoint: Endpoint, t: OllamaTarget, refresh: boolean): Promise<ModelInfo[]> {
  const names = new Map<string, boolean>() // name -> installed
  if (t.cloud) for (const n of await cloudCatalog(refresh)) names.set(n, true)
  else {
    for (const m of await listTags(t)) names.set(m.name, true)
    if (endpoint.showCloudCatalog) {
      try {
        for (const n of await cloudCatalog(refresh)) {
          const daemonName = toDaemonCloudName(n)
          if (!names.has(daemonName)) names.set(daemonName, false)
        }
      } catch {
        // The catalog is a convenience; installed models still work offline.
      }
    }
  }
  const models = await mapLimit([...names.entries()], 6, async ([name, installed]) => {
    try {
      return toModelInfo(endpoint, name, await fetchInfo(t, toModelKey(endpoint.id, name), name, refresh), installed)
    } catch {
      return installed ? toModelInfo(endpoint, name, UNKNOWN, true) : null
    }
  })
  return (
    models
      .filter((m): m is ModelInfo => !!m)
      // Embedding-only models can't chat.
      .filter((m) => m.capabilities.includes('completion'))
      .sort((x, y) => (x.where === y.where ? x.name.localeCompare(y.name) : x.where === 'cloud' ? -1 : 1))
  )
}

export async function getModelInfo(endpoint: Endpoint, t: OllamaTarget, name: string, refresh = false): Promise<ModelInfo> {
  try {
    return toModelInfo(endpoint, name, await fetchInfo(t, toModelKey(endpoint.id, name), name, refresh), true)
  } catch {
    return toModelInfo(endpoint, name, UNKNOWN, false)
  }
}
