// Cost labels. Only Ollama cloud models are priced; a model on this Mac is 'local', and anything else 'cost not tracked'.
import { keyPrefix, splitModelKey } from './modelKey'
import type { Endpoint, ModelBilling, TraceSummary, UsageByModel } from './types'
import { formatCost } from './usage'

/** One reply's or one row's cost: dollars when priced (nothing while the price is unknown), else what it is instead. */
export function billingLabel(b: ModelBilling, costUsd: number | null): string | null {
  if (b === 'local') return 'local'
  if (b === 'untracked') return 'cost not tracked'
  return costUsd === null ? null : formatCost(costUsd)
}

/**
 * A chat's cost for its chip: 'local' when every request ran on this Mac; 'not tracked' when nothing was priced and
 * some went elsewhere ($0 would claim a cost Ollmost can't know); else the priced requests' sum, or 'cost unknown'
 * when one of them has no price.
 */
export function chatCostLabel(rows: Array<{ billing: ModelBilling; costUsd: number | null }>): string {
  const priced = rows.filter((r) => r.billing === 'priced')
  if (!priced.length) return rows.some((r) => r.billing === 'untracked') ? 'not tracked' : 'local'
  if (priced.some((r) => r.costUsd === null)) return 'cost unknown'
  return formatCost(priced.reduce((n, r) => n + (r.costUsd ?? 0), 0))
}

/**
 * A reply saved before billing was recorded: 0 reads as local, anything else as priced. It sees only the cost, not the
 * model, so a cloud reply saved at $0 reads as local here, where the database backfill (which sees the name) calls it priced.
 */
export function legacyBilling(costUsd: number | null | undefined): ModelBilling {
  return costUsd === 0 ? 'local' : 'priced'
}

/**
 * A usage row's model name and endpoint, for display. A prefix shaped like an endpoint id that names none is a removed
 * endpoint's (as registry.resolve reads it), and keeps its whole key; a bare name from before keys is Ollama's.
 */
export function describeUsageModel(key: string, endpoints: readonly Endpoint[]): Pick<UsageByModel, 'name' | 'endpoint'> {
  const ids = endpoints.map((e) => e.id)
  const prefix = keyPrefix(key)
  if (prefix === null || ids.includes(prefix)) {
    const { endpointId, model } = splitModelKey(key, ids)
    const e = endpoints.find((x) => x.id === endpointId)
    if (e) return { name: model, endpoint: { id: e.id, name: e.name, kind: e.kind, flavor: e.flavor } }
  }
  return { name: key, endpoint: { id: '', name: 'Removed endpoint', kind: 'openai', flavor: 'generic' } }
}

/**
 * The debugger's cost total. A billed request always has token counts, and local and untracked ones cost 0, so a
 * billed request with no cost is a priced one whose price is unknown: that makes the total unknown.
 */
export function traceCostTotal(traces: ReadonlyArray<Pick<TraceSummary, 'kind' | 'promptTokens' | 'costUsd'>>): number | null {
  let total = 0
  for (const t of traces) {
    if (t.kind === 'tool' || t.promptTokens == null) continue
    if (t.costUsd == null) return null
    total += t.costUsd
  }
  return total
}
