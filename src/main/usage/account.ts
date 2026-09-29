import { creditPool, describeWindows, detectReset, effectiveSpend, parseUsageResponse } from '@shared/usage'
import type { AccountUsage, Endpoint } from '@shared/types'
import { readSetting, writeSetting } from '../db/kv'
import { cloudUnreachableMessage } from '../providers/fetchFailure'
import { OLLAMA_CLOUD } from '../providers/ollama/wire'
import { whereOf } from '../providers/where'
import { getApiKey, getSettings, updateSettings } from '../settings'

const CACHE_MS = 30_000
const USAGE_TIMEOUT_MS = 10_000
// Tests point this at a mock server; the real endpoint is undocumented, so a mock is the only stable target.
const USAGE_URL = process.env.OLLMOST_USAGE_URL ?? `${OLLAMA_CLOUD}/api/usage`
let cache: AccountUsage | null = null
let inflight: Promise<AccountUsage> | null = null
/** Bumped when settings change under a load: a load begun before that must not fill the cache or be joined. */
let generation = 0
let plan: string | null = null
/**
 * Where /api/me failed in a way worth remembering, and until when it isn't asked again. A server without /api/me (a 404,
 * 405 or 501, or a body that isn't JSON) would fail every load: remembered for the session. No answer within 5 s is
 * remembered for 10 minutes: the app asks ollama.com with no deadline of its own, so a stalled ollama.com (after a wake,
 * or behind a captive portal) holds it up for a while, and a hung app then delays at most one load in 10 minutes.
 * Anything else reads as no plan and is asked again at the next load: a refused connection (the Ollama app not started
 * yet, or restarting for an update), 401 or 403 (signed out, and signing in needs no restart), another error status, or
 * an answer without a plan.
 */
let planFailed: { at: string; until: number } | null = null
/** What a server without /api/me answers: an older Ollama, or something else on the port. */
const NO_API_ME = new Set([404, 405, 501])
const PLAN_TIMEOUT_MEMORY_MS = 10 * 60_000

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
  if (planFailed?.at === base && Date.now() < planFailed.until) return null
  try {
    const res = await fetch(`${base}/api/me`, { method: 'POST', signal: AbortSignal.timeout(5000) })
    if (NO_API_ME.has(res.status)) planFailed = { at: base, until: Infinity }
    // Signed out (401), or signed in but unable to reach ollama.com (503 on newer builds, 200 null on older ones): no plan
    // yet, asked again next time.
    if (!res.ok) return null
    const found = ((await res.json()) as { plan?: unknown } | null)?.plan
    plan = typeof found === 'string' && found ? found : null
    return plan
  } catch (err) {
    // A body that isn't JSON, for the session; the 5 s timeout (waiting for the answer or reading it), for 10 minutes. A
    // refused or dropped connection is asked again.
    if (err instanceof SyntaxError) planFailed = { at: base, until: Infinity }
    else if (err instanceof Error && err.name === 'TimeoutError') planFailed = { at: base, until: Date.now() + PLAN_TIMEOUT_MEMORY_MS }
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
      signal: AbortSignal.timeout(USAGE_TIMEOUT_MS)
    })
    if (res.status === 401 || res.status === 403)
      return { ...base, needsKey: true, error: 'ollama.com rejected the API key. Create a new one at ollama.com/settings/keys.' }
    if (!res.ok) return { ...base, needsKey: false, error: `ollama.com answered HTTP ${res.status} for usage.` }
    json = await res.json()
  } catch (err) {
    // A body that isn't JSON (a sign-in page, or the endpoint changed) isn't a connection problem.
    if (err instanceof SyntaxError) return { ...base, needsKey: false, error: "ollama.com sent usage Ollmost couldn't read." }
    return { ...base, needsKey: false, error: cloudUnreachableMessage(err, USAGE_TIMEOUT_MS / 1000) }
  }
  // The endpoint is undocumented: keep the last response so its shape can be inspected in Settings.
  writeSetting('usageRaw', { at: now, json })

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
