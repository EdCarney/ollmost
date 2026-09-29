import { creditPool, describeWindows, detectReset, effectiveSpend, parseUsageResponse } from '@shared/usage'
import type { AccountUsage, Endpoint } from '@shared/types'
import { readSetting, writeSetting } from '../db/kv'
import { OLLAMA_CLOUD } from '../providers/ollama/wire'
import { whereOf } from '../providers/where'
import { getApiKey, getSettings, updateSettings } from '../settings'
import { errorMessage } from '../util'

const CACHE_MS = 30_000
// Tests point this at a mock server; the real endpoint is undocumented, so a mock is the only stable target.
const USAGE_URL = process.env.OLLMOST_USAGE_URL ?? `${OLLAMA_CLOUD}/api/usage`
let cache: AccountUsage | null = null
let inflight: Promise<AccountUsage> | null = null
/** Bumped when settings change under a load: a load begun before that must not fill the cache or be joined. */
let generation = 0
let plan: string | null = null
/**
 * The address /api/me last failed at: not asked again this session (a server without it would fail on every load). A
 * refused connection isn't remembered: nothing is listening there yet (the Ollama app not started, or restarting for an
 * update), which isn't a server without /api/me, and it's asked again at the next load.
 */
let planFailedAt: string | null = null

/** Where to ask for the plan: the first enabled Ollama endpoint on this Mac (the signed-in app), if any. */
export function planEndpoint(endpoints: readonly Endpoint[]): Endpoint | null {
  return endpoints.find((e) => e.kind === 'ollama' && e.enabled && whereOf(e.baseUrl) === 'this-mac') ?? null
}

/** The signed-in daemon knows the plan name (POST /api/me), even without an API key. */
async function fetchPlan(): Promise<string | null> {
  if (plan) return plan
  const target = planEndpoint(getSettings().endpoints)
  if (!target) return null
  const base = target.baseUrl.replace(/\/+$/, '')
  if (planFailedAt === base) return null
  try {
    const res = await fetch(`${base}/api/me`, { method: 'POST', signal: AbortSignal.timeout(5000) })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    // A signed-out daemon answers without a plan: asked again next time, since signing in needs no restart.
    plan = ((await res.json()) as { plan?: string }).plan ?? null
    return plan
  } catch (err) {
    // An error status, a body that isn't JSON and the 5 s timeout are remembered; fetch's refused connection isn't.
    if ((err as { cause?: { code?: string } }).cause?.code !== 'ECONNREFUSED') planFailedAt = base
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
  if (!inflight) {
    const started = generation
    const run: Promise<AccountUsage> = load()
      // A load that settings changed under (a key removed mid-request) is dropped: its caller gets a read made after.
      .then((u) => (started === generation ? (cache = u) : getAccountUsage()))
      .finally(() => {
        if (inflight === run) inflight = null
      })
    inflight = run
  }
  return inflight
}

export function lastRawUsage(): { at: number; json: unknown } | null {
  return readSetting<{ at: number; json: unknown } | null>('usageRaw', null)
}

/** Settings changed (key, reset times): drop the cache, and any load still running, so the next read is fresh. */
export function invalidateAccountUsage(): void {
  generation++
  cache = null
  inflight = null
}
