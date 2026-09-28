import { isOllamaCloudUrl } from '@shared/endpoints'
import { creditPool, describeWindows, detectReset, effectiveSpend, parseUsageResponse } from '@shared/usage'
import type { AccountUsage } from '@shared/types'
import { readSetting, writeSetting } from '../db/kv'
import { OLLAMA_CLOUD } from '../providers/ollama/wire'
import { getApiKey, getSettings, updateSettings } from '../settings'
import { errorMessage } from '../util'

const CACHE_MS = 30_000
// Tests point this at a mock server; the real endpoint is undocumented, so a mock is the only stable target.
const USAGE_URL = process.env.OLLMOST_USAGE_URL ?? `${OLLAMA_CLOUD}/api/usage`
let cache: AccountUsage | null = null
let inflight: Promise<AccountUsage> | null = null
let plan: string | null = null

/** The signed-in Ollama app knows the plan name (POST /api/me), even without an API key. */
async function fetchPlan(): Promise<string | null> {
  if (plan) return plan
  // The first Ollama app among the endpoints: ollama.com itself has no /api/me.
  const app = getSettings().endpoints.find((e) => e.enabled && e.kind === 'ollama' && !isOllamaCloudUrl(e.baseUrl))
  if (!app) return null
  try {
    const res = await fetch(`${app.baseUrl.replace(/\/+$/, '')}/api/me`, { method: 'POST', signal: AbortSignal.timeout(5000) })
    if (!res.ok) return null
    plan = ((await res.json()) as { plan?: string }).plan ?? null
    return plan
  } catch {
    return null
  }
}

type Observed = Record<string, { usage: number; at: number }>

/**
 * ollama.com/api/usage is undocumented and needs an API key (the daemon's sign-in doesn't cover it).
 * It reports how much of each window is used but not when windows reset, so Ollmost dates resets
 * itself whenever it sees usage drop, unless you've set the time in Settings.
 */
async function load(): Promise<AccountUsage> {
  const now = Date.now()
  const base = { plan: await fetchPlan(), windows: [], spend: null, fetchedAt: now }
  const key = getApiKey()
  if (!key) return { ...base, needsKey: true, error: null }

  let json: unknown
  try {
    const res = await fetch(USAGE_URL, {
      headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' },
      signal: AbortSignal.timeout(10_000)
    })
    if (res.status === 401 || res.status === 403)
      return { ...base, needsKey: true, error: 'Ollama rejected the API key. Create a new one at ollama.com/settings/keys.' }
    if (!res.ok) return { ...base, needsKey: false, error: `Ollama returned HTTP ${res.status} for usage.` }
    json = await res.json()
    // The endpoint is undocumented: keep the last response so its shape can be inspected in Settings.
    writeSetting('usageRaw', { at: now, json })
  } catch (err) {
    return { ...base, needsKey: false, error: `Couldn't reach ollama.com: ${errorMessage(err)}` }
  }

  const { windows, spend } = parseUsageResponse(json)
  const settings = getSettings().usage
  const observed = readSetting<Observed>('usageObserved', {})
  const anchors = { ...settings.anchors }
  let anchorsChanged = false
  for (const w of windows) {
    const resetAt = detectReset(observed[w.id], w.usage, now)
    // A user-set time wins; a freshly detected reset replaces an older detected one.
    if (resetAt && anchors[w.id]?.source !== 'configured') {
      anchors[w.id] = { at: resetAt, source: 'detected' }
      anchorsChanged = true
    }
    observed[w.id] = { usage: w.usage, at: now }
  }
  writeSetting('usageObserved', observed)
  if (anchorsChanged) updateSettings({ usage: { anchors } })

  return {
    ...base,
    windows: describeWindows(windows, { anchors, monthlyDay: settings.monthlyDay }, now),
    spend: effectiveSpend(windows, spend, creditPool(base.plan, settings.poolUsd)),
    needsKey: false,
    error: null
  }
}

export function getAccountUsage(refresh = false): Promise<AccountUsage> {
  if (!refresh && cache && Date.now() - cache.fetchedAt < CACHE_MS) {
    // Reset times move with the clock even when the numbers are cached.
    const { anchors, monthlyDay } = getSettings().usage
    return Promise.resolve({ ...cache, windows: describeWindows(cache.windows, { anchors, monthlyDay }, Date.now()) })
  }
  inflight ??= load()
    .then((u) => (cache = u))
    .finally(() => (inflight = null))
  return inflight
}

export function lastRawUsage(): { at: number; json: unknown } | null {
  return readSetting<{ at: number; json: unknown } | null>('usageRaw', null)
}

/** Settings changed (key, reset times): drop the cache so the next read is fresh. */
export function invalidateAccountUsage(): void {
  cache = null
}
