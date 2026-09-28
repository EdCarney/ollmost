import { BrowserWindow } from 'electron'
import { redactImages } from '@shared/debug'
import { EVENT_CHANNELS, type TraceEvent } from '@shared/ipc'
import type { TraceDetail, TraceKind, TraceStatus, TraceSummary, TraceTiming } from '@shared/types'
import { all, get, run } from '../db/index'
import type { ChatTiming } from '../providers/types'
import { getSettings } from '../settings'
import { parseJson, uid } from '../util'

const MAX_TRACES = 500
const MAX_TEXT = 200_000

interface Row {
  id: string
  conversation_id: string | null
  message_id: string | null
  kind: string
  model: string | null
  round: number | null
  status: string
  started_at: number
  duration_ms: number | null
  prompt_tokens: number | null
  completion_tokens: number | null
  cost_usd: number | null
  summary: string
  data?: string
}

const toSummary = (r: Row): TraceSummary => ({
  id: r.id,
  conversationId: r.conversation_id,
  messageId: r.message_id,
  kind: r.kind as TraceKind,
  model: r.model,
  round: r.round,
  status: r.status as TraceStatus,
  startedAt: r.started_at,
  durationMs: r.duration_ms,
  promptTokens: r.prompt_tokens,
  completionTokens: r.completion_tokens,
  costUsd: r.cost_usd,
  summary: r.summary
})

function emit(event: TraceEvent): void {
  for (const w of BrowserWindow.getAllWindows()) w.webContents.send(EVENT_CHANNELS.trace, event)
}

const cap = (s: string | undefined) => (s && s.length > MAX_TEXT ? `${s.slice(0, MAX_TEXT)}\n[… truncated for the debugger]` : s)

type Data = Pick<TraceDetail, 'endpoint' | 'request' | 'response' | 'timing'>

/**
 * One recorded request. Callers mark timing points as the stream arrives and call finish() once.
 * When recording is off the handle is inert, so call sites never need to check.
 */
export class Trace {
  private firstByteAt: number | null = null
  private firstTokenAt: number | null = null
  private lastProgress = 0
  private readonly startedAt = Date.now()

  /** `id` is null when recording is off: nothing is stored, but finish() still returns the detail. */
  constructor(
    private readonly id: string | null,
    private readonly data: Data,
    private readonly meta: Omit<TraceSummary, 'status' | 'durationMs' | 'promptTokens' | 'completionTokens' | 'costUsd' | 'summary'>
  ) {}

  firstByte(): void {
    this.firstByteAt ??= Date.now()
  }

  firstToken(): void {
    this.firstTokenAt ??= Date.now()
  }

  /** Throttled live update while streaming, so the debugger shows the request as it grows. */
  progress(summary: string, completionTokens: number): void {
    if (!this.id || Date.now() - this.lastProgress < 400) return
    this.lastProgress = Date.now()
    run('UPDATE traces SET summary = ?, completion_tokens = ? WHERE id = ?', summary.slice(0, 200), completionTokens, this.id)
    emitRow(this.id)
  }

  finish(result: {
    status: TraceStatus
    response: TraceDetail['response']
    promptTokens?: number | null
    completionTokens?: number | null
    costUsd?: number | null
    summary: string
    /** The server's own durations for the request, when it reports them. */
    timing?: ChatTiming
  }): TraceDetail {
    const now = Date.now()
    const ms = (v?: number) => (typeof v === 'number' ? Math.round(v) : null)
    const timing: TraceTiming = {
      ttfbMs: this.firstByteAt ? this.firstByteAt - this.startedAt : null,
      firstTokenMs: this.firstTokenAt ? this.firstTokenAt - this.startedAt : null,
      totalMs: now - this.startedAt,
      loadMs: ms(result.timing?.loadMs),
      promptEvalMs: ms(result.timing?.promptMs),
      evalMs: ms(result.timing?.genMs)
    }
    const response = {
      ...result.response,
      content: cap(result.response.content),
      thinking: cap(result.response.thinking),
      result: cap(result.response.result)
    }
    const detail: TraceDetail = {
      ...this.meta,
      ...this.data,
      status: result.status,
      durationMs: timing.totalMs,
      promptTokens: result.promptTokens ?? null,
      completionTokens: result.completionTokens ?? null,
      costUsd: result.costUsd ?? null,
      summary: result.summary.slice(0, 200),
      response,
      timing
    }
    if (!this.id) return detail
    run(
      `UPDATE traces SET status = ?, duration_ms = ?, prompt_tokens = ?, completion_tokens = ?, cost_usd = ?, summary = ?, data = ?
       WHERE id = ?`,
      result.status,
      timing.totalMs,
      result.promptTokens ?? null,
      result.completionTokens ?? null,
      result.costUsd ?? null,
      result.summary.slice(0, 200),
      JSON.stringify({ ...this.data, response, timing }),
      this.id
    )
    emitRow(this.id)
    return detail
  }
}

function emitRow(id: string): void {
  const row = get<Row>('SELECT * FROM traces WHERE id = ?', id)
  if (row) emit({ type: 'upsert', trace: toSummary(row) })
}

export function startTrace(meta: {
  kind: TraceKind
  conversationId: string | null
  messageId: string | null
  model: string | null
  round?: number | null
  endpoint: string
  request: unknown
  summary: string
}): Trace {
  const id = uid()
  const startedAt = Date.now()
  const traceMeta = {
    id,
    conversationId: meta.conversationId,
    messageId: meta.messageId,
    kind: meta.kind,
    model: meta.model,
    round: meta.round ?? null,
    startedAt
  }
  const data: Data = {
    endpoint: meta.endpoint,
    request: redactImages(meta.request),
    response: {},
    timing: { ttfbMs: null, firstTokenMs: null, totalMs: null, loadMs: null, promptEvalMs: null, evalMs: null }
  }
  if (!getSettings().debug.record) return new Trace(null, data, traceMeta)
  run(
    `INSERT INTO traces (id, conversation_id, message_id, kind, model, round, status, started_at, summary, data)
     VALUES (?, ?, ?, ?, ?, ?, 'running', ?, ?, ?)`,
    id,
    meta.conversationId,
    meta.messageId,
    meta.kind,
    meta.model,
    meta.round ?? null,
    startedAt,
    meta.summary.slice(0, 200),
    JSON.stringify(data)
  )
  run(`DELETE FROM traces WHERE id NOT IN (SELECT id FROM traces ORDER BY started_at DESC LIMIT ${MAX_TRACES})`)
  emitRow(id)
  return new Trace(id, data, traceMeta)
}

export function listTraces(conversationId: string | null): TraceSummary[] {
  const cols =
    'id, conversation_id, message_id, kind, model, round, status, started_at, duration_ms, prompt_tokens, completion_tokens, cost_usd, summary'
  const rows = conversationId
    ? all<Row>(`SELECT ${cols} FROM traces WHERE conversation_id = ? ORDER BY started_at`, conversationId)
    : all<Row>(`SELECT ${cols} FROM traces ORDER BY started_at DESC LIMIT 300`).reverse()
  return rows.map(toSummary)
}

export function getTrace(id: string): TraceDetail | null {
  const row = get<Row>('SELECT * FROM traces WHERE id = ?', id)
  if (!row) return null
  const data = parseJson<Data>(row.data, { endpoint: '', request: null, response: {}, timing: {} as TraceTiming })
  return { ...toSummary(row), ...data }
}

export function clearTraces(conversationId: string | null): void {
  if (conversationId) run('DELETE FROM traces WHERE conversation_id = ?', conversationId)
  else run('DELETE FROM traces')
  emit({ type: 'cleared', conversationId })
}

export function tracesForExport(conversationId: string | null): TraceDetail[] {
  return listTraces(conversationId)
    .map((t) => getTrace(t.id))
    .filter((t): t is TraceDetail => !!t)
}

/** Mark traces left 'running' by a crash or quit as aborted. */
export function settleStaleTraces(): void {
  run(`UPDATE traces SET status = 'aborted' WHERE status = 'running'`)
}
