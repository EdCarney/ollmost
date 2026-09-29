import { Play, Terminal } from 'lucide-react'
import { type ReactNode, useEffect, useMemo, useState } from 'react'
import { curlKeyVar, promptAnatomy, toCurl } from '@shared/debug'
import { formatCost } from '@shared/usage'
import { labelForKey } from '@shared/modelLabel'
import type { TraceDetail } from '@shared/types'
import { Button } from '@/components/ui'
import { cn } from '@/lib/format'
import { selectEndpoints, useApp } from '@/stores/app'
import { Anatomy } from './Anatomy'
import { CopyButton, JsonBlock, kindLabel, ms, StatusIcon } from './bits'
import { Replay } from './Replay'

type Tab = 'overview' | 'prompt' | 'request' | 'response' | 'tools' | 'replay'

interface ChatRequest {
  model?: string
  messages?: unknown[]
  tools?: Array<{ function?: { name?: string; description?: string; parameters?: unknown } }>
  // Ollama
  think?: unknown
  options?: { num_ctx?: number } & Record<string, unknown>
  // OpenAI-compatible
  reasoning_effort?: unknown
  chat_template_kwargs?: unknown
  temperature?: unknown
}

function Section({ title, children, actions }: { title: string; children: ReactNode; actions?: ReactNode }) {
  return (
    <section className="mb-6">
      <div className="mb-2 flex items-center justify-between">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-subtle">{title}</h3>
        {actions && <div className="flex gap-1">{actions}</div>}
      </div>
      {children}
    </section>
  )
}

function Grid({ rows }: { rows: Array<[string, ReactNode]> }) {
  return (
    <dl className="grid grid-cols-[180px_1fr] gap-x-4 gap-y-1.5 text-[13px]">
      {rows.map(([k, v]) => (
        <div key={k} className="contents">
          <dt className="text-muted">{k}</dt>
          <dd className="selectable min-w-0 break-words font-mono text-[12px] tabular-nums">{v}</dd>
        </div>
      ))}
    </dl>
  )
}

function Text({ value, muted }: { value: string; muted?: boolean }) {
  return (
    <pre
      className={cn(
        'selectable max-h-[480px] overflow-auto whitespace-pre-wrap rounded-ollmost border border-line bg-code p-3 font-mono text-[12px] leading-relaxed',
        muted && 'text-muted'
      )}
    >
      {value}
    </pre>
  )
}

const perSecond = (tokens: number | null, msValue: number | null) =>
  tokens && msValue ? `${((tokens / msValue) * 1000).toFixed(0)} tok/s` : '—'

/** The server's own durations, only those it reported: cloud models and most OpenAI-compatible servers send none. */
function serverTiming(trace: TraceDetail): Array<[string, ReactNode]> {
  const t = trace.timing
  const rows: Array<[string, ReactNode]> = []
  if (t.loadMs != null) rows.push(['Server: model load', ms(t.loadMs)])
  if (t.promptEvalMs != null)
    rows.push(['Server: prompt processing', `${ms(t.promptEvalMs)} · ${perSecond(trace.promptTokens, t.promptEvalMs)}`])
  if (t.evalMs != null) rows.push(['Server: generation', `${ms(t.evalMs)} · ${perSecond(trace.completionTokens, t.evalMs)}`])
  return rows.length ? rows : [['Server timing', 'not reported by this server']]
}

export function TraceView({ trace, conversationId }: { trace: TraceDetail; conversationId: string | null }) {
  const endpoints = useApp(selectEndpoints)
  const isModelCall = trace.kind !== 'tool'
  const [tab, setTab] = useState<Tab>('overview')
  // Memoised so a trace without a request doesn't get a fresh `{}` each render and recompute the anatomy.
  const request = useMemo(() => (trace.request ?? {}) as ChatRequest, [trace.request])
  const anatomy = useMemo(() => (isModelCall ? promptAnatomy(request, trace.dialect) : null), [isModelCall, request, trace.dialect])

  useEffect(() => {
    if (!isModelCall && tab !== 'overview') setTab('overview')
  }, [isModelCall, tab])

  const tabs: Array<[Tab, string]> = isModelCall
    ? [
        ['overview', 'Overview'],
        ['prompt', 'Prompt anatomy'],
        ['request', 'Request'],
        ['response', 'Response'],
        ['tools', `Tools (${request.tools?.length ?? 0})`],
        ['replay', 'Replay']
      ]
    : [['overview', 'Overview']]

  const curl = isModelCall ? toCurl(trace.endpoint, trace.request, curlKeyVar(trace)) : ''
  const final = (trace.response.final ?? {}) as Record<string, unknown>
  // What the request asked of the model, in its own dialect's fields.
  const settingsRows: Array<[string, ReactNode]> =
    trace.dialect === 'openai'
      ? [
          ['Reasoning', JSON.stringify(request.reasoning_effort ?? request.chat_template_kwargs ?? null)],
          ['temperature', JSON.stringify(request.temperature ?? null)]
        ]
      : [
          ['think', JSON.stringify(request.think ?? null)],
          ['options', JSON.stringify(request.options ?? null)]
        ]
  // labelForKey already names a non-Ollama endpoint that still exists; any other gets its recorded name beside the model.
  const current = endpoints.find((e) => e.id === trace.endpointId)
  const showEndpointName = !!trace.endpointName && (!current || current.kind === 'ollama')
  const estimateDelta = anatomy && trace.promptTokens ? Math.round(((anatomy.total - trace.promptTokens) / trace.promptTokens) * 100) : null

  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-line px-5 pt-3">
        <div className="flex items-center gap-2 text-sm">
          <StatusIcon status={trace.status} />
          <span className="font-mono text-xs text-muted">{kindLabel(trace)}</span>
          {trace.model && <span className="font-medium">{labelForKey(trace.model, endpoints)}</span>}
          {showEndpointName && <span className="text-xs text-subtle">{trace.endpointName}</span>}
          <span className="text-xs text-subtle">{new Date(trace.startedAt).toLocaleTimeString()}</span>
          <span className="ml-auto font-mono text-xs text-subtle">{trace.endpoint}</span>
        </div>
        <div className="mt-2 flex gap-1 text-[13px]">
          {tabs.map(([id, label]) => (
            <button
              key={id}
              onClick={() => setTab(id)}
              className={cn(
                '-mb-px border-b-2 px-2.5 pb-2',
                tab === id ? 'border-accent text-fg' : 'border-transparent text-muted hover:text-fg'
              )}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
        {tab === 'overview' && !isModelCall && (
          <>
            <Section title="Tool call">
              <Grid
                rows={[
                  ['Status', trace.status],
                  ['Duration', ms(trace.durationMs)],
                  ['Endpoint', trace.endpoint]
                ]}
              />
            </Section>
            <Section title="Arguments">
              <JsonBlock value={trace.request} />
            </Section>
            {trace.response.error && (
              <Section title="Error">
                <Text value={trace.response.error} />
              </Section>
            )}
            <Section
              title="Returned to the model"
              actions={trace.response.result ? <CopyButton text={trace.response.result} /> : undefined}
            >
              <Text value={trace.response.result ?? '(nothing yet)'} />
            </Section>
          </>
        )}

        {tab === 'overview' && isModelCall && (
          <>
            <Section
              title="Request"
              actions={
                <>
                  <CopyButton text={curl} label="Copy as curl" />
                  <CopyButton text={JSON.stringify(trace.request, null, 2)} label="Copy JSON" />
                  <Button size="sm" variant="ghost" onClick={() => setTab('replay')}>
                    <Play className="size-3.5" /> Replay
                  </Button>
                </>
              }
            >
              <Grid
                rows={[
                  ['Model', request.model ?? '—'],
                  ...settingsRows,
                  ['Messages', String(request.messages?.length ?? 0)],
                  ['Tools offered', request.tools?.map((t) => t.function?.name).join(', ') || 'none']
                ]}
              />
            </Section>
            <Section title="Timing">
              <Grid
                rows={[
                  ['Time to first byte', ms(trace.timing.ttfbMs)],
                  ['Time to first token', ms(trace.timing.firstTokenMs)],
                  ['Total', ms(trace.timing.totalMs)],
                  ...serverTiming(trace)
                ]}
              />
            </Section>
            <Section title="Tokens & cost">
              <Grid
                rows={[
                  [
                    'Prompt tokens',
                    trace.promptTokens != null
                      ? `${trace.promptTokens.toLocaleString()} (Ollmost estimated ${anatomy?.total.toLocaleString()}${estimateDelta !== null ? `, ${estimateDelta > 0 ? '+' : ''}${estimateDelta}%` : ''})`
                      : `≈${anatomy?.total.toLocaleString()} (estimated)`
                  ],
                  ['Completion tokens', trace.completionTokens?.toLocaleString() ?? '—'],
                  ['Cost', trace.costUsd == null ? '—' : formatCost(trace.costUsd)],
                  ['Finish reason', String(final.done_reason ?? final.finish_reason ?? '—')],
                  ['Stream chunks', String(trace.response.chunks ?? '—')]
                ]}
              />
            </Section>
            {trace.response.error && (
              <Section title="Error">
                <Text value={trace.response.error} />
              </Section>
            )}
          </>
        )}

        {tab === 'prompt' && anatomy && (
          <Anatomy request={request} dialect={trace.dialect} anatomy={anatomy} actualTokens={trace.promptTokens} model={trace.model} />
        )}

        {tab === 'request' && (
          <Section
            title="Exact request body"
            actions={
              <>
                <CopyButton text={curl} label="Copy as curl" />
                <CopyButton text={JSON.stringify(trace.request, null, 2)} label="Copy JSON" />
              </>
            }
          >
            <p className="mb-2 text-xs text-subtle">
              <Terminal className="mr-1 inline size-3.5" />
              As sent to {trace.endpoint}. Image bytes are replaced by size placeholders; the API key is never recorded.
            </p>
            <JsonBlock value={trace.request} />
          </Section>
        )}

        {tab === 'response' && (
          <>
            {trace.response.error && (
              <Section title="Error">
                <Text value={trace.response.error} />
              </Section>
            )}
            {trace.response.thinking && (
              <Section title="Thinking" actions={<CopyButton text={trace.response.thinking} />}>
                <Text value={trace.response.thinking} muted />
              </Section>
            )}
            <Section title="Content" actions={trace.response.content ? <CopyButton text={trace.response.content} /> : undefined}>
              <Text value={trace.response.content || '(empty)'} />
            </Section>
            {trace.response.toolCalls && (
              <Section title="Tool calls">
                <JsonBlock value={trace.response.toolCalls} />
              </Section>
            )}
            <Section title="Response stats">
              <JsonBlock value={trace.response.final ?? null} />
            </Section>
          </>
        )}

        {tab === 'tools' &&
          (request.tools?.length ? (
            request.tools.map((t, i) => (
              <Section key={i} title={t.function?.name ?? `tool ${i + 1}`}>
                <p className="mb-2 text-[13px] text-muted">{t.function?.description}</p>
                <JsonBlock value={t.function?.parameters ?? null} />
              </Section>
            ))
          ) : (
            <p className="text-sm text-subtle">No tools were offered with this request.</p>
          ))}

        {tab === 'replay' && <Replay trace={trace} conversationId={conversationId} />}
      </div>
    </div>
  )
}
