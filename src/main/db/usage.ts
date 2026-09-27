import type { ChatUsage, TokenTotals, UsageSummary } from '@shared/types'
import { now, uid } from '../util'
import { getConversation } from './conversations'
import { all, get, run } from './index'

export function insertUsageEvent(e: {
  conversationId: string | null
  messageId: string | null
  model: string
  kind: 'chat' | 'title' | 'replay' | 'compact' | 'delegate'
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
  // A compacted chat's older rows no longer reflect what the next request sends, and a row whose message
  // was later deleted (an Edit or Retry) never went out either; skip both so the meter reads null, not a
  // stale number, until a real request lands.
  const compactedAt = getConversation(conversationId)?.compaction?.at ?? 0
  // ORDER BY ... LIMIT 1 over the filtered rows, so when an Edit or Retry deletes the latest reply, this falls
  // back to the latest surviving request's real total — an older real number, not an estimate of the next one.
  const last = get<{ tokens: number }>(
    `SELECT prompt_tokens + completion_tokens AS tokens FROM usage_events
     WHERE conversation_id = ? AND kind = 'chat' AND created_at > ?
       AND (message_id IS NULL OR EXISTS (SELECT 1 FROM messages WHERE messages.id = usage_events.message_id))
     ORDER BY created_at DESC LIMIT 1`,
    conversationId,
    compactedAt
  )
  const { requests: _requests, ...rest } = total
  return { ...rest, byModel, lastContextTokens: last?.tokens ?? null }
}

/**
 * Totals over the last `days`, or between `sinceMs` and `untilMs` when given (the account's own period, to sit
 * beside its spend; a reported period may have ended before now).
 */
export function usageSummary(days: number, sinceMs?: number, untilMs?: number | null): UsageSummary {
  const since = sinceMs ?? Date.now() - days * 86_400_000
  const until = untilMs ?? Number.MAX_SAFE_INTEGER
  const total = totals(get<TotalsRow>(`SELECT ${TOTALS_SQL} FROM usage_events WHERE created_at >= ? AND created_at < ?`, since, until))
  const byModel = all<TotalsRow & { model: string }>(
    `SELECT model, ${TOTALS_SQL} FROM usage_events WHERE created_at >= ? AND created_at < ?
     GROUP BY model ORDER BY SUM(cost_usd) DESC, SUM(completion_tokens) DESC`,
    since,
    until
  ).map((r) => ({ model: r.model, ...totals(r) }))
  const byDay = all<{ day: string; cost: number | null; tokens: number }>(
    `SELECT date(created_at / 1000, 'unixepoch', 'localtime') AS day, SUM(cost_usd) AS cost,
       SUM(prompt_tokens + completion_tokens) AS tokens
     FROM usage_events WHERE created_at >= ? AND created_at < ? GROUP BY day ORDER BY day`,
    since,
    until
  ).map((r) => ({ day: r.day, costUsd: r.cost ?? 0, tokens: r.tokens }))
  return { days, total, byModel, byDay }
}
