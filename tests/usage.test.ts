import { describe, expect, it } from 'vitest'
import type { PriceTable } from '@shared/types'
import {
  costOf,
  creditPool,
  effectiveSpend,
  describeWindows,
  detectReset,
  elapsedFraction,
  formatCost,
  formatDollars,
  formatPercent,
  formatTimeLeft,
  monthlyBounds,
  nextReset,
  paceOf,
  parsePricingHtml,
  parseUsageResponse,
  priceFor,
  spendPeriod
} from '@shared/usage'

const HOUR = 3_600_000
const DAY = 24 * HOUR

const table: PriceTable = {
  source: 'bundled',
  updatedAt: 0,
  prices: {
    'gpt-oss:120b': { input: 0.15, cachedInput: 0.014, output: 0.6 },
    'glm-5.3': { input: 1.4, cachedInput: 0.26, output: 4.4 },
    'deepseek-v4-pro': { input: 1.32, cachedInput: 0.044, output: 3.96 },
    gemma4: { input: 0.14, cachedInput: 0.05, output: 0.4 }
  }
}

describe('prices', () => {
  it('matches daemon cloud names to published prices', () => {
    expect(priceFor(table, 'gpt-oss:120b-cloud')?.output).toBe(0.6)
    expect(priceFor(table, 'glm-5.3:cloud')?.input).toBe(1.4)
    expect(priceFor(table, 'deepseek-v4-pro:0813-cloud')?.input).toBe(1.32)
    expect(priceFor(table, 'gemma4:31b-cloud')?.output).toBe(0.4)
    expect(priceFor(table, 'mystery-model:cloud')).toBeNull()
  })

  it('costs a request at per-million rates', () => {
    expect(costOf(table.prices['gpt-oss:120b'], 1_000_000, 1_000_000)).toBeCloseTo(0.75)
    expect(costOf(table.prices['glm-5.3'], 2000, 500)).toBeCloseTo(0.005)
    expect(costOf(null, 10, 10)).toBeNull()
  })

  it('parses the ollama.com pricing table, skipping headers and off-peak rows', () => {
    const html = `<table>
      <tr><th>Model</th><th>Input</th><th>Cached input</th><th>Output</th></tr>
      <tr><td><a href="/library/kimi-k3">kimi-k3</a></td><td>$3.00</td><td>$0.30</td><td>$15.00</td></tr>
      <tr><td>deepseek-v4-pro (Off-Peak)</td><td>$0.66</td><td>$0.022</td><td>$1.98</td></tr>
      <tr><td>qwen3.5:397b</td><td>$0.60</td><td>—</td><td>$3.60</td></tr>
    </table>`
    expect(parsePricingHtml(html)).toEqual({
      'kimi-k3': { input: 3, cachedInput: 0.3, output: 15 },
      'qwen3.5:397b': { input: 0.6, cachedInput: null, output: 3.6 }
    })
  })

  it('formats small and large costs', () => {
    expect(formatCost(0.00042)).toBe('$0.0004')
    expect(formatCost(0.123)).toBe('$0.123')
    expect(formatCost(12.5)).toBe('$12.50')
    expect(formatCost(null)).toBe('—')
  })

  it('shows quota to one decimal and spend to the cent', () => {
    expect(formatPercent(0.3346)).toBe('33.5%')
    expect(formatPercent(0.02)).toBe('2.0%')
    expect(formatDollars(3.21)).toBe('$3.21')
    expect(formatDollars(0.013)).toBe('$0.01')
    expect(formatDollars(null)).toBe('—')
  })

  it('counts down without rounding up', () => {
    expect(formatTimeLeft(7 * DAY - 1000)).toBe('6d 23h')
    expect(formatTimeLeft(90 * 60_000)).toBe('1h 30m')
    expect(formatTimeLeft(20_000)).toBe('1m')
  })
})

describe('account usage', () => {
  it('reads limit windows and spend from /api/usage', () => {
    const parsed = parseUsageResponse({
      activity: {
        cost: '1.23450',
        models: [{ model: 'glm-5.3', cost: '1.2' }],
        period: { type: 'last_4_weeks', starting_at: '2026-08-26T00:00:00Z', ending_at: '2026-09-23T00:00:00Z' }
      },
      limits: { weekly: { usage: 0.335, models: {} }, session: { usage: 0.025, models: {} } }
    })
    expect(parsed.windows).toEqual([
      { id: 'session', usage: 0.025, models: [] },
      { id: 'weekly', usage: 0.335, models: [] }
    ])
    expect(parsed.spend).toMatchObject({
      cost: 1.2345,
      label: 'Last 4 weeks',
      source: 'activity',
      models: [{ model: 'glm-5.3', cost: 1.2 }]
    })
  })

  // Shape returned for a credit-based Pro plan (numbers made up): no dollar figure, a monthly share,
  // and per-model request counts across every app on the account.
  const creditPlan = {
    activity: { cost: '0.00000', period: { type: 'last_4_weeks' }, models: [] },
    limits: {
      monthly: {
        usage: 0.009,
        models: [
          { name: 'kimi-k3', request_count: 12 },
          { name: 'gpt-oss:120b', request_count: 200 },
          { name: 'web search', request_count: 3 }
        ]
      }
    }
  }

  it('reads per-model request counts, busiest first', () => {
    const [monthly] = parseUsageResponse(creditPlan).windows
    expect(monthly.models.map((m) => m.name)).toEqual(['gpt-oss:120b', 'kimi-k3', 'web search'])
    expect(
      parseUsageResponse({ limits: { weekly: { usage: 0.1, models: { 'glm-5.3': { request_count: 4 } } } } }).windows[0].models
    ).toEqual([{ name: 'glm-5.3', requests: 4 }])
  })

  it('works out credit-plan spend from the share of the monthly pool', () => {
    const { windows, spend } = parseUsageResponse(creditPlan)
    expect(spend?.cost).toBe(0) // what Ollama itself reports
    const pool = creditPool('pro', null)
    expect(pool).toBe(60)
    expect(effectiveSpend(windows, spend, pool)).toMatchObject({ cost: 0.54, source: 'credits', pool: 60, label: 'This month' })
    expect(creditPool('pro', 75)).toBe(75)
    expect(creditPool(null, null)).toBeNull()
  })

  it("keeps Ollama's own figure on legacy plans", () => {
    const legacy = parseUsageResponse({ activity: { cost: '4.5' }, limits: { weekly: { usage: 0.2 } } })
    expect(effectiveSpend(legacy.windows, legacy.spend, 60)).toMatchObject({ cost: 4.5, source: 'activity' })
  })

  it('tolerates unexpected shapes', () => {
    expect(parseUsageResponse(null)).toEqual({ windows: [], spend: null })
    expect(parseUsageResponse({ limits: { monthly: { usage: '0.5' }, junk: 3 } }).windows).toEqual([
      { id: 'monthly', usage: 0.5, models: [] }
    ])
  })
})

describe('pace', () => {
  const now = Date.parse('2026-09-23T12:00:00Z')
  // A weekly window that resets in `daysLeft` days.
  const weekly = (usage: number, daysLeft: number | null) => ({
    id: 'weekly',
    label: 'Weekly',
    usage,
    periodMs: 7 * DAY,
    resetAt: daysLeft === null ? null : now + daysLeft * DAY,
    resetSource: 'detected' as const,
    models: []
  })

  it('is under pace when usage trails the time elapsed', () => {
    // Half the week gone, 30% used → projects to 60%.
    expect(paceOf(weekly(0.3, 3.5), now)).toMatchObject({ status: 'under', target: 0.5, projected: 0.6, runOutAt: null })
  })

  it('is on pace when usage tracks the time elapsed', () => {
    expect(paceOf(weekly(0.52, 3.5), now).status).toBe('on-track')
  })

  it('is over pace, with a run-out time, when usage outruns the week', () => {
    // 2 of 7 days gone, 50% used → 25%/day → the rest lasts 2 more days, 3 days before the reset.
    const p = paceOf(weekly(0.5, 5), now)
    expect(p.status).toBe('over')
    expect(p.runOutAt).toBe(now + 2 * DAY)
  })

  it('damps projections at the very start of a window', () => {
    // 2% used in the first hour would naively project to over 300%.
    expect(paceOf(weekly(0.02, 7 - 1 / 24), now).status).toBe('under')
  })

  it('is over once the limit is hit, and unknown without a reset time', () => {
    expect(paceOf(weekly(1, 3), now)).toMatchObject({ status: 'over', runOutAt: now })
    expect(paceOf(weekly(0.4, null), now).status).toBe('unknown')
  })
})

describe('reset schedule', () => {
  it('rolls a known reset forward (or back) to the next one', () => {
    const now = Date.parse('2026-09-23T12:00:00Z')
    expect(nextReset(now - 10 * DAY, 7 * DAY, now)).toBe(now + 4 * DAY)
    expect(nextReset(now + 10 * DAY, 7 * DAY, now)).toBe(now + 3 * DAY)
    expect(nextReset(now, 7 * DAY, now)).toBe(now + 7 * DAY)
  })

  it('clamps monthly reset days to short months', () => {
    const now = new Date(2026, 1, 10).getTime() // 10 Feb
    const { start, end } = monthlyBounds(31, now)
    expect(new Date(end).getDate()).toBe(28) // 28 Feb
    expect(new Date(start).getMonth()).toBe(0) // 31 Jan
  })

  it('dates a reset at the midpoint when usage drops', () => {
    expect(detectReset({ usage: 0.4, at: 1000 }, 0.01, 3000)).toBe(2000)
    expect(detectReset({ usage: 0.4, at: 1000 }, 0.41, 3000)).toBeNull()
    expect(detectReset(undefined, 0.1, 3000)).toBeNull()
  })

  it('describes windows with reset times and elapsed share', () => {
    const now = Date.parse('2026-09-23T12:00:00Z')
    const [session, weekly] = describeWindows(
      [
        { id: 'session', usage: 0.1, models: [] },
        { id: 'weekly', usage: 0.5, models: [] }
      ],
      { anchors: { weekly: { at: now - 2 * DAY, source: 'detected' } }, monthlyDay: null },
      now
    )
    expect(session).toMatchObject({ label: '5-hour session', resetAt: null })
    expect(weekly).toMatchObject({ label: 'Weekly', resetAt: now + 5 * DAY, resetSource: 'detected' })
    expect(elapsedFraction(weekly, now)).toBeCloseTo(2 / 7)
  })
})

describe('the period Ollmost sums its own estimate over, to sit beside the account\u2019s spend', () => {
  const now = Date.parse('2026-09-27T12:00:00Z')
  const base = { plan: 'pro', fetchedAt: now, needsKey: false, error: null }
  const monthly = (extra: object) => ({
    id: 'monthly',
    label: 'Monthly',
    usage: 0.111,
    models: [],
    periodMs: 30 * DAY,
    resetAt: now + 10 * DAY,
    resetSource: 'configured' as const,
    ...extra
  })
  const credits = { cost: 6.66, label: 'This month', source: 'credits' as const, pool: 60, periodStart: null, periodEnd: null, models: [] }

  it('uses the monthly window\u2019s current period on a credit plan whose reset day is known', () => {
    expect(spendPeriod({ ...base, windows: [monthly({})], spend: credits })).toEqual({ since: now - 20 * DAY, label: 'this month' })
  })

  it('uses the activity period Ollama reports on a legacy plan', () => {
    const spend = {
      ...credits,
      source: 'activity' as const,
      label: 'Last 4 weeks',
      pool: null,
      periodStart: now - 28 * DAY,
      periodEnd: now
    }
    expect(spendPeriod({ ...base, windows: [], spend })).toEqual({ since: now - 28 * DAY, label: 'last 4 weeks' })
  })

  it('has no period when the reset day is unknown, when there is no spend line, or when the period would be empty', () => {
    expect(spendPeriod({ ...base, windows: [monthly({ resetAt: null, resetSource: null })], spend: credits })).toBeNull()
    expect(spendPeriod({ ...base, windows: [monthly({})], spend: null })).toBeNull()
    expect(spendPeriod({ ...base, windows: [], spend: { ...credits, source: 'activity', periodStart: null } })).toBeNull()
  })
})
