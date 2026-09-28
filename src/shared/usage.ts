import type { AccountUsage, Endpoint, ModelPrice, PriceTable, Settings, UsageWindow } from './types'

// ---- Prices ---------------------------------------------------------------

/** "gpt-oss:120b-cloud" → "gpt-oss:120b", "glm-5.3:cloud" → "glm-5.3". */
export function priceKey(model: string): string {
  return model.replace(/(:|-)cloud$/, '').replace(/:latest$/, '')
}

/** Price for a model, trying the exact name first and then the name without its tag. */
export function priceFor(table: PriceTable, model: string): ModelPrice | null {
  const key = priceKey(model)
  return table.prices[key] ?? table.prices[key.split(':')[0]] ?? null
}

/** USD for one request. Uncached input rates are used for all prompt tokens, so this is an upper bound. */
export function costOf(price: ModelPrice | null, promptTokens: number, completionTokens: number): number | null {
  if (!price) return null
  return (promptTokens * price.input + completionTokens * price.output) / 1_000_000
}

const money = (cell: string): number | null => {
  const m = cell.replace(/,/g, '').match(/\$\s*([\d.]+)/)
  return m ? Number(m[1]) : null
}

/**
 * Parse the per-model table on ollama.com/pricing (rows of: model, input, cached input, output,
 * all $ per million tokens). Off-peak rows are skipped: we can't tell when off-peak applies,
 * so the standard rate is the safe estimate.
 */
export function parsePricingHtml(html: string): Record<string, ModelPrice> {
  const decode = (s: string) =>
    s
      .replace(/<[^>]+>/g, '')
      .replace(/&amp;/g, '&')
      .replace(/&#x27;|&#39;/g, "'")
      .replace(/&nbsp;/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
  const prices: Record<string, ModelPrice> = {}
  for (const row of html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)) {
    const cells = [...row[1].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/g)].map((c) => decode(c[1]))
    if (cells.length < 4 || /off-peak/i.test(cells[0])) continue
    const [name, input, cached, output] = cells
    const inRate = money(input)
    const outRate = money(output)
    if (!name || inRate === null || outRate === null) continue
    prices[name.toLowerCase()] = { input: inRate, cachedInput: money(cached), output: outRate }
  }
  return prices
}

// ---- Account usage (ollama.com/api/usage) ----------------------------------

const DAY = 86_400_000
export const WINDOW_PERIODS: Record<string, number> = {
  session: 5 * 3_600_000,
  weekly: 7 * DAY
}

const WINDOW_LABELS: Record<string, string> = { session: '5-hour session', weekly: 'Weekly', monthly: 'Monthly' }

export interface RawUsageWindow {
  id: string
  usage: number
  models: Array<{ name: string; requests: number }>
}

/** Per-model request counts: an array of {name, request_count} or a map of name → {request_count}. */
function parseModels(raw: unknown): Array<{ name: string; requests: number }> {
  const entries: Array<[string, unknown]> = Array.isArray(raw)
    ? raw.map((m) => [String((m as Record<string, unknown>)?.name ?? (m as Record<string, unknown>)?.model ?? ''), m])
    : raw && typeof raw === 'object'
      ? Object.entries(raw)
      : []
  return entries
    .map(([name, m]) => ({ name, requests: Number((m as { request_count?: unknown })?.request_count) }))
    .filter((m) => m.name && Number.isFinite(m.requests))
    .sort((a, b) => b.requests - a.requests)
}

/**
 * The endpoint is undocumented, so parse defensively: any entry under `limits` with a numeric
 * `usage` (a 0–1 fraction) becomes a window; `activity.cost` is spend over `activity.period`.
 */
export function parseUsageResponse(json: unknown): { windows: RawUsageWindow[]; spend: AccountUsage['spend'] } {
  const root = (json ?? {}) as Record<string, unknown>
  const limits = (root.limits ?? {}) as Record<string, unknown>
  const windows: RawUsageWindow[] = []
  for (const [id, value] of Object.entries(limits)) {
    const usage = Number((value as { usage?: unknown })?.usage)
    if (Number.isFinite(usage)) windows.push({ id, usage: Math.max(0, usage), models: parseModels((value as { models?: unknown }).models) })
  }
  windows.sort((a, b) => (WINDOW_PERIODS[a.id] ?? Infinity) - (WINDOW_PERIODS[b.id] ?? Infinity))

  const activity = root.activity as
    { cost?: unknown; period?: { starting_at?: string; ending_at?: string; type?: string }; models?: unknown } | undefined
  let spend: AccountUsage['spend'] = null
  const cost = Number(activity?.cost)
  if (activity && Number.isFinite(cost)) {
    const models = Array.isArray(activity.models)
      ? activity.models
          .map((m) => {
            const o = m as Record<string, unknown>
            const name = String(o.model ?? o.name ?? '')
            const c = Number(o.cost)
            return name && Number.isFinite(c) ? { model: name, cost: c } : null
          })
          .filter((m): m is { model: string; cost: number } => !!m)
      : []
    spend = {
      cost,
      label: activity.period?.type === 'last_4_weeks' ? 'Last 4 weeks' : 'Recent',
      source: 'activity',
      pool: null,
      periodStart: activity.period?.starting_at ? Date.parse(activity.period.starting_at) : null,
      periodEnd: activity.period?.ending_at ? Date.parse(activity.period.ending_at) : null,
      models
    }
  }
  return { windows, spend }
}

/** Monthly credit pools from ollama.com/pricing (USD). */
export const PLAN_CREDIT_POOLS: Record<string, number> = { pro: 60, max: 300, team: 1000 }

export function creditPool(plan: string | null, override: number | null): number | null {
  if (override && override > 0) return override
  return plan ? (PLAN_CREDIT_POOLS[plan.toLowerCase()] ?? null) : null
}

/**
 * Credit plans report no dollar spend (activity.cost stays "0.00000"), only the share of the monthly
 * pool used, so spend = share × pool. Ollama rounds the share to 0.1%, so on a $60 pool this is
 * good to about ±$0.03. Legacy plans (session/weekly windows) keep Ollama's own figure.
 */
export function effectiveSpend(
  windows: RawUsageWindow[],
  activitySpend: AccountUsage['spend'],
  pool: number | null
): AccountUsage['spend'] {
  const monthly = windows.find((w) => w.id === 'monthly')
  if (monthly && pool)
    return {
      cost: Math.round(monthly.usage * pool * 100) / 100,
      label: 'This month',
      source: 'credits',
      pool,
      periodStart: null,
      periodEnd: null,
      models: []
    }
  return activitySpend
}

/**
 * The period to sum Ollmost's own estimate over so it sits beside the account's spend line: the monthly
 * window's current period on a credit plan (known once the reset day is), or the activity period Ollama
 * reports on a legacy plan, to its end when it has one (a reported period may have ended before now).
 * Null when neither is known; the caller falls back to a rolling 30 days.
 */
export function spendPeriod(account: AccountUsage): { since: number; until: number | null; label: string } | null {
  const spend = account.spend
  if (!spend) return null
  if (spend.source === 'credits') {
    const monthly = account.windows.find((w) => w.id === 'monthly')
    if (!monthly?.resetAt || !monthly.periodMs) return null
    return { since: monthly.resetAt - monthly.periodMs, until: null, label: spend.label.toLowerCase() }
  }
  return spend.periodStart ? { since: spend.periodStart, until: spend.periodEnd ?? null, label: spend.label.toLowerCase() } : null
}

// ---- Reset schedule ---------------------------------------------------------

/** First reset strictly after `now`, given any known reset moment and the window length. */
export function nextReset(anchor: number, period: number, now: number): number {
  let next = anchor + Math.ceil((now - anchor) / period) * period
  if (next <= now) next += period
  return next
}

/** Next and previous reset for a plan whose pool refreshes on a day of the month. */
export function monthlyBounds(day: number, now: number): { start: number; end: number } {
  const at = (y: number, m: number) => {
    const last = new Date(y, m + 1, 0).getDate()
    return new Date(y, m, Math.min(day, last)).getTime()
  }
  const d = new Date(now)
  let end = at(d.getFullYear(), d.getMonth())
  if (end <= now) end = at(d.getFullYear(), d.getMonth() + 1)
  const e = new Date(end)
  const start = at(e.getFullYear(), e.getMonth() - 1)
  return { start, end }
}

export interface ResetSchedule {
  /** A known reset moment for each window id (user-set or detected). */
  anchors: Record<string, { at: number; source: 'configured' | 'detected' } | null>
  /** Day of month credits refresh, for credit-based plans. */
  monthlyDay: number | null
}

/** Attach labels, periods and reset times to raw windows. */
export function describeWindows(raw: RawUsageWindow[], schedule: ResetSchedule, now: number): UsageWindow[] {
  return raw.map((w) => {
    const base = { id: w.id, label: WINDOW_LABELS[w.id] ?? w.id, usage: w.usage, models: w.models ?? [] }
    if (w.id === 'monthly' && schedule.monthlyDay) {
      const { start, end } = monthlyBounds(schedule.monthlyDay, now)
      return { ...base, periodMs: end - start, resetAt: end, resetSource: 'configured' as const }
    }
    const period = WINDOW_PERIODS[w.id] ?? null
    const anchor = schedule.anchors[w.id]
    if (!period || !anchor) return { ...base, periodMs: period, resetAt: null, resetSource: null }
    return { ...base, periodMs: period, resetAt: nextReset(anchor.at, period, now), resetSource: anchor.source }
  })
}

/**
 * Usage only goes down when a window resets, so a clear drop between two readings dates a reset.
 * Returns the estimated reset time, or null if no reset was seen.
 */
export function detectReset(prev: { usage: number; at: number } | undefined, usage: number, now: number): number | null {
  if (!prev || prev.usage - usage < 0.02) return null
  // The reset happened somewhere between the readings; the midpoint halves the worst-case error.
  return Math.round((prev.at + now) / 2)
}

/** Share of the current window that has elapsed (0–1), or null if the reset time is unknown. */
export function elapsedFraction(w: UsageWindow, now: number): number | null {
  if (!w.resetAt || !w.periodMs) return null
  return Math.min(1, Math.max(0, 1 - (w.resetAt - now) / w.periodMs))
}

export function formatCost(usd: number | null): string {
  if (usd === null) return '—'
  if (usd === 0) return '$0'
  if (usd < 0.01) return `$${usd.toFixed(4)}`
  if (usd < 1) return `$${usd.toFixed(3)}`
  return `$${usd.toFixed(2)}`
}

/** Countdown text; rounds down like a clock, so it never shows "6d 24h". */
// ---- Pace -----------------------------------------------------------------

export type PaceStatus = 'under' | 'on-track' | 'over' | 'unknown'

export interface Pace {
  status: PaceStatus
  /** Share you'd have used by now if you spread the allowance evenly across the window. */
  target: number | null
  /** Share you'll have used at the reset if you keep going at the average rate so far. */
  projected: number | null
  /** When you'd hit 100% at that rate, if that's before the reset. */
  runOutAt: number | null
}

/** Below 90% projected is under pace; above 110% you'd likely run out before the reset. */
export const PACE_BAND = { under: 0.9, over: 1.1 }
/**
 * Early in a window a few requests project wildly (2% used in the first hour looks like 300%),
 * so treat at least this much of the window as elapsed when projecting.
 */
const MIN_ELAPSED = 0.1

export function paceOf(w: UsageWindow, now: number): Pace {
  if (w.usage >= 1) return { status: 'over', target: elapsedFraction(w, now), projected: w.usage, runOutAt: now }
  const elapsed = elapsedFraction(w, now)
  if (elapsed === null || !w.periodMs || !w.resetAt) return { status: 'unknown', target: null, projected: null, runOutAt: null }

  const projected = w.usage / Math.max(elapsed, MIN_ELAPSED)
  let runOutAt: number | null = null
  const elapsedMs = elapsed * w.periodMs
  if (w.usage > 0 && elapsedMs > 0) {
    const at = now + ((1 - w.usage) / w.usage) * elapsedMs
    if (at < w.resetAt) runOutAt = at
  }
  const status = projected > PACE_BAND.over ? 'over' : projected >= PACE_BAND.under ? 'on-track' : 'under'
  // The run-out estimate uses the raw rate; only show it when the damped projection agrees.
  return { status, target: elapsed, projected, runOutAt: status === 'over' ? runOutAt : null }
}

/** Quota share with one decimal: 0.3346 → "33.5%". */
export function formatPercent(fraction: number): string {
  return `${(fraction * 100).toFixed(1)}%`
}

/** Account-level spend, to the cent. */
export function formatDollars(usd: number | null): string {
  return usd === null ? '—' : `$${usd.toFixed(2)}`
}

export function formatTimeLeft(ms: number): string {
  if (ms <= 0) return 'resetting'
  const minutes = Math.floor(ms / 60_000)
  if (minutes < 60) return `${Math.max(1, minutes)}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ${minutes % 60}m`
  return `${Math.floor(hours / 24)}d ${hours % 24}h`
}

// ---- Quota chip --------------------------------------------------------------

export type QuotaMode = 'show' | 'add-key' | 'hidden'

/** Whether any enabled endpoint is an Ollama server (on this Mac, the network or ollama.com). */
export function hasOllamaEndpoint(endpoints: ReadonlyArray<Pick<Endpoint, 'kind' | 'enabled'>>): boolean {
  return endpoints.some((e) => e.kind === 'ollama' && e.enabled)
}

/**
 * What the title bar's quota chip does: with the ollama.com key saved it shows usage (polled); with no key but an
 * Ollama endpoint it offers to add one; with neither there's nothing to show, and nothing is fetched.
 */
export function quotaMode(s: Pick<Settings, 'endpoints' | 'ollamaAccount'>): QuotaMode {
  if (s.ollamaAccount.hasKey) return 'show'
  return hasOllamaEndpoint(s.endpoints) ? 'add-key' : 'hidden'
}
