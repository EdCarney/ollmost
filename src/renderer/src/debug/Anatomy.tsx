import { ChevronRight } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { type AnatomySegment, type TraceMessage, traceMessages } from '@shared/debug'
import type { TraceDialect } from '@shared/types'
import { Tooltip } from '@/components/ui'
import { api } from '@/lib/api'
import { cn, contextSizeLabel, formatTokens } from '@/lib/format'
import { JsonBlock } from './bits'

interface Req {
  options?: { num_ctx?: number } & Record<string, unknown>
  messages?: unknown[]
}

const GROUP_LABEL: Record<AnatomySegment['group'], string> = {
  system: 'System prompt',
  history: 'Conversation history',
  latest: 'This turn',
  tools: 'Tools',
  images: 'Images'
}

/**
 * Where a request's tokens go. One hue on purpose: the job is comparing sizes, so bar length does the
 * work and labels carry identity (a categorical palette for ~8 parts would be past the soft cap).
 */
export function Anatomy({
  request,
  dialect,
  anatomy,
  actualTokens,
  model
}: {
  request: Req
  dialect: TraceDialect
  anatomy: { segments: AnatomySegment[]; total: number }
  actualTokens: number | null
  model: string | null
}) {
  // Ollama's local requests carry the num_ctx they used; anything else uses the window the model gets now.
  const numCtx = request.options?.num_ctx ?? null
  const [modelContext, setModelContext] = useState<number | null>(null)
  useEffect(() => {
    if (model && numCtx === null)
      void api.models.info(model).then(
        (m) => setModelContext(m.contextWindow ?? m.contextLength),
        () => setModelContext(null)
      )
  }, [model, numCtx])
  const messages = useMemo(() => traceMessages(request, dialect), [request, dialect])
  const contextLength = numCtx ?? modelContext

  const used = actualTokens ?? anatomy.total
  const share = contextLength ? used / contextLength : null
  const max = Math.max(1, ...anatomy.segments.map((s) => s.tokens))
  const groups = [...new Set(anatomy.segments.map((s) => s.group))]

  return (
    <div className="max-w-3xl">
      {share !== null && contextLength && (
        <section className="mb-6">
          <div className="mb-1.5 flex items-baseline justify-between text-[13px]">
            <span className="font-medium">Context window</span>
            <span className="tabular-nums text-muted">
              {formatTokens(used)} of {contextSizeLabel(contextLength)} · {(share * 100).toFixed(1)}%
              {actualTokens == null && ' (estimated)'}
            </span>
          </div>
          {/* Meter: same-hue fill on a neutral track. */}
          <div
            className="h-2 overflow-hidden rounded-full bg-hover"
            role="meter"
            aria-valuemin={0}
            aria-valuemax={contextLength}
            aria-valuenow={used}
          >
            <div
              className={cn('h-full rounded-full', share > 0.8 ? 'bg-danger' : 'bg-accent')}
              style={{ width: `${Math.min(100, share * 100)}%` }}
            />
          </div>
        </section>
      )}

      <section className="mb-8">
        <div className="mb-3 flex items-baseline justify-between">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-subtle">Where the tokens go</h3>
          <span className="text-xs tabular-nums text-subtle">
            ≈{anatomy.total.toLocaleString()} estimated
            {actualTokens != null && ` · ${actualTokens.toLocaleString()} counted by the server`}
          </span>
        </div>
        {groups.map((group) => (
          <div key={group} className="mb-3">
            <div className="mb-1 text-[11px] font-medium text-subtle">{GROUP_LABEL[group]}</div>
            {anatomy.segments
              .filter((s) => s.group === group)
              .map((s) => {
                const pct = (s.tokens / anatomy.total) * 100
                return (
                  <Tooltip key={s.label} content={`${s.label}: ≈${s.tokens.toLocaleString()} tokens, ${pct.toFixed(1)}% of the request`}>
                    <div className="grid cursor-default grid-cols-[220px_1fr_88px] items-center gap-3 rounded py-1 text-[13px] hover:bg-hover">
                      <span className="truncate pl-1">{s.label}</span>
                      {/* 8px bar, square at the baseline, 4px rounded data end. */}
                      <span className="h-2">
                        <span className="block h-2 rounded-r bg-accent" style={{ width: `${Math.max(0.5, (s.tokens / max) * 100)}%` }} />
                      </span>
                      <span className="pr-1 text-right font-mono text-[12px] tabular-nums text-muted">
                        {formatTokens(s.tokens)} · {pct.toFixed(0)}%
                      </span>
                    </div>
                  </Tooltip>
                )
              })}
          </div>
        ))}
        <p className="text-xs text-subtle">Estimates use ~4 characters per token, the same rule Ollmost uses to trim long histories.</p>
      </section>

      <section>
        <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-subtle">Messages ({messages.length})</h3>
        <div className="space-y-2">
          {messages.map((m, i) => (
            <MessageRow key={i} index={i} message={m} />
          ))}
        </div>
      </section>
    </div>
  )
}

const ROLE_STYLE: Record<string, string> = {
  system: 'bg-accent-soft text-accent',
  user: 'bg-hover text-fg',
  assistant: 'bg-hover text-muted',
  tool: 'bg-hover text-subtle'
}

function MessageRow({ index, message: m }: { index: number; message: TraceMessage }) {
  const [open, setOpen] = useState(index === 0 ? false : !!m.text && m.text.length < 400)
  const tokens = Math.ceil((m.text.length + m.thinking.length) / 4)
  return (
    <div className="rounded-ollmost border border-line">
      <button onClick={() => setOpen((o) => !o)} className="flex w-full items-center gap-2 px-3 py-2 text-left text-[13px]">
        <ChevronRight className={cn('size-3.5 shrink-0 text-subtle transition-transform', open && 'rotate-90')} />
        <span className={cn('rounded px-1.5 py-px font-mono text-[11px]', ROLE_STYLE[m.role] ?? 'bg-hover')}>
          {m.role}
          {m.toolName ? `:${m.toolName}` : ''}
        </span>
        <span className="min-w-0 flex-1 truncate text-muted">
          {m.text.replace(/\s+/g, ' ').slice(0, 160) || (m.toolCalls ? '(tool call)' : '(empty)')}
        </span>
        {m.images.length ? <span className="shrink-0 text-xs text-subtle">{m.images.length} image(s)</span> : null}
        <span className="shrink-0 font-mono text-[11px] tabular-nums text-subtle">≈{formatTokens(tokens)}</span>
      </button>
      {open && (
        <div className="space-y-2 border-t border-line px-3 py-2">
          {m.thinking && <pre className="selectable whitespace-pre-wrap font-mono text-[12px] text-subtle">{m.thinking}</pre>}
          {m.text && (
            <pre className="selectable max-h-[520px] overflow-auto whitespace-pre-wrap font-mono text-[12px] leading-relaxed">{m.text}</pre>
          )}
          {m.toolCalls && <JsonBlock value={m.toolCalls} />}
          {m.images.length ? <div className="text-xs text-subtle">{m.images.join(', ')}</div> : null}
        </div>
      )}
    </div>
  )
}
