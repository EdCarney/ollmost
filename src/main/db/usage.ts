import type { ChatUsage, TokenTotals, UsageSummary } from '@shared/types'
import { now, uid } from '../util'
import { all, get, run } from './index'

export function insertUsageEvent(e: {
  conversationId: string | null
  messageId: string | null
  model: string
  kind: 'chat' | 'title' | 'replay'
  promptTokens: number
  completionTokens: number
  costUsd: number | null
  estimated: boolean
}): void {
  run(
    `INSERT INTO usage_events (id, conversation_id, message_id, model, kind, prompt_tokens, completion_tokens, cost_usd, estimated, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    uid(),
    e.conversationId,
    e.messageId,
    e.model,
    e.kind,
    Math.round(e.promptTokens),
    Math.round(e.completionTokens),
    e.costUsd,
    e.estimated ? 1 : 0,
    now()
  )
}

interface TotalsRow {
  prompt: number | null
  completion: number | null
  cost: number | null
  unpriced: number | null
  estimated: number | null
  requests: number
}

const TOTALS_SQL = `COALESCE(SUM(prompt_tokens), 0) AS prompt, COALESCE(SUM(completion_tokens), 0) AS completion,
  SUM(cost_usd) AS cost, SUM(cost_usd IS NULL) AS unpriced, MAX(estimated) AS estimated, COUNT(*) AS requests`

function totals(r: TotalsRow | undefined): TokenTotals & { requests: number } {
  return {
    promptTokens: r?.prompt ?? 0,
    completionTokens: r?.completion ?? 0,
    // One unpriced cloud request makes the total unknowable rather than silently low.
    costUsd: r && r.unpriced ? null : (r?.cost ?? 0),
    estimated: !!r?.estimated,
    requests: r?.requests ?? 0
  }
}

export function conversationUsage(conversationId: string): ChatUsage {
  const total = totals(get<TotalsRow>(`SELECT ${TOTALS_SQL} FROM usage_events WHERE conversation_id = ?`, conversationId))
  const byModel = all<TotalsRow & { model: string }>(
    `SELECT model, ${TOTALS_SQL} FROM usage_events WHERE conversation_id = ? GROUP BY model ORDER BY SUM(completion_tokens) DESC`,
    conversationId
  ).map((r) => ({ model: r.model, ...totals(r) }))
  const last = get<{ tokens: number }>(
    `SELECT prompt_tokens + completion_tokens AS tokens FROM usage_events
     WHERE conversation_id = ? AND kind = 'chat' ORDER BY created_at DESC LIMIT 1`,
    conversationId
  )
  const { requests: _requests, ...rest } = total
  return { ...rest, byModel, lastContextTokens: last?.tokens ?? null }
}

/** Totals over the last `days`, or from `sinceMs` when given (the account's own period, to sit beside its spend). */
export function usageSummary(days: number, sinceMs?: number): UsageSummary {
  const since = sinceMs ?? Date.now() - days * 86_400_000
  const total = totals(get<TotalsRow>(`SELECT ${TOTALS_SQL} FROM usage_events WHERE created_at >= ?`, since))
  const byModel = all<TotalsRow & { model: string }>(
    `SELECT model, ${TOTALS_SQL} FROM usage_events WHERE created_at >= ? GROUP BY model ORDER BY SUM(cost_usd) DESC, SUM(completion_tokens) DESC`,
    since
  ).map((r) => ({ model: r.model, ...totals(r) }))
  const byDay = all<{ day: string; cost: number | null; tokens: number }>(
    `SELECT date(created_at / 1000, 'unixepoch', 'localtime') AS day, SUM(cost_usd) AS cost,
       SUM(prompt_tokens + completion_tokens) AS tokens
     FROM usage_events WHERE created_at >= ? GROUP BY day ORDER BY day`,
    since
  ).map((r) => ({ day: r.day, costUsd: r.cost ?? 0, tokens: r.tokens }))
  return { days, total, byModel, byDay }
}
