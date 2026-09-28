import type { ModelInfo, ModelListResult, ModelOverrides } from '@shared/types'
import { type CachedModelInfo, readModelProfile, writeModelInfo, writeModelOverrides } from '../../db/kv'
import { ollamaConnection } from '../../settings'
import { errorMessage } from '../../util'
import { modelPrice } from '../../usage/pricing'
import { connectionMode, isCloudName, listTags, showModel } from './wire'

const INFO_TTL = 24 * 60 * 60 * 1000
const CATALOG_TTL = 60 * 60 * 1000

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
  const names = (await listTags(true)).map((m) => m.name)
  catalogCache = { at: Date.now(), names }
  return names
}

function contextLengthOf(info: Record<string, unknown> | undefined): number | null {
  if (!info) return null
  for (const [k, v] of Object.entries(info)) if (k.endsWith('.context_length') && typeof v === 'number') return v
  return null
}

async function fetchInfo(name: string, refresh: boolean): Promise<CachedModelInfo> {
  const cached = readModelProfile(name)
  if (!refresh && cached.info && Date.now() - cached.fetchedAt < INFO_TTL) return cached.info
  try {
    const show = await showModel(name)
    const info: CachedModelInfo = {
      capabilities: show.capabilities ?? ['completion'],
      contextLength: contextLengthOf(show.model_info),
      family: show.details?.family || null,
      parameterSize: show.details?.parameter_size || null
    }
    writeModelInfo(name, info)
    return info
  } catch (err) {
    if (cached.info) return cached.info
    throw err
  }
}

function toModelInfo(name: string, info: CachedModelInfo, installed: boolean): ModelInfo {
  return {
    name,
    location: connectionMode() === 'direct' || isCloudName(name) ? 'cloud' : 'local',
    installed,
    capabilities: info.capabilities,
    contextLength: info.contextLength,
    family: info.family,
    parameterSize: info.parameterSize,
    overrides: readModelProfile(name).overrides,
    price: connectionMode() === 'direct' || isCloudName(name) ? modelPrice(name) : null
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

export async function listModels(refresh = false): Promise<ModelListResult> {
  const errors: string[] = []
  const names = new Map<string, boolean>() // name -> installed

  if (connectionMode() === 'direct') {
    try {
      for (const n of await cloudCatalog(refresh)) names.set(n, true)
    } catch (err) {
      errors.push(errorMessage(err))
    }
  } else {
    try {
      for (const m of await listTags()) names.set(m.name, true)
    } catch (err) {
      errors.push(errorMessage(err))
    }
    if (ollamaConnection().showCloudCatalog) {
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

  const entries = [...names.entries()]
  const models = (
    await mapLimit(entries, 6, async ([name, installed]) => {
      try {
        return toModelInfo(name, await fetchInfo(name, refresh), installed)
      } catch {
        return installed
          ? toModelInfo(name, { capabilities: ['completion'], contextLength: null, family: null, parameterSize: null }, true)
          : null
      }
    })
  )
    .filter((m): m is ModelInfo => !!m)
    // Embedding-only models can't chat.
    .filter((m) => m.capabilities.includes('completion'))
    .sort((a, b) => (a.location === b.location ? a.name.localeCompare(b.name) : a.location === 'cloud' ? -1 : 1))

  return { models, error: models.length ? null : (errors[0] ?? 'No models found.') }
}

export async function getModelInfo(name: string, refresh = false): Promise<ModelInfo> {
  try {
    return toModelInfo(name, await fetchInfo(name, refresh), true)
  } catch {
    return toModelInfo(name, { capabilities: ['completion'], contextLength: null, family: null, parameterSize: null }, false)
  }
}

export async function setModelOverrides(name: string, overrides: ModelOverrides): Promise<ModelInfo> {
  writeModelOverrides(name, overrides)
  return getModelInfo(name)
}
