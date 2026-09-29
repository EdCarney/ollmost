import { Play, RotateCcw, TriangleAlert } from 'lucide-react'
import { useMemo, useState } from 'react'
import { formatCost } from '@shared/usage'
import type { TraceDetail } from '@shared/types'
import { Button, TextArea } from '@/components/ui'
import { api } from '@/lib/api'
import { formatTokens } from '@/lib/format'
import { CopyButton, JsonBlock, ms } from './bits'

function editable(request: unknown): string {
  // A replay is one request, not a stream: the stream fields would only be dropped again.
  const { stream: _stream, stream_options: _options, ...rest } = (request ?? {}) as Record<string, unknown>
  return JSON.stringify(rest, null, 2)
}

/** Edit a recorded request and send it again, like a playground. Nothing is added to the chat. */
export function Replay({ trace, conversationId }: { trace: TraceDetail; conversationId: string | null }) {
  const original = useMemo(() => editable(trace.request), [trace.request])
  const [text, setText] = useState(original)
  const [running, setRunning] = useState(false)
  const [result, setResult] = useState<TraceDetail | null>(null)
  const [error, setError] = useState<string | null>(null)

  let parseError: string | null = null
  try {
    JSON.parse(text)
  } catch (err) {
    parseError = (err as Error).message
  }

  const run = async () => {
    setRunning(true)
    setError(null)
    setResult(null)
    try {
      setResult(await api.debug.replay(conversationId, trace.model, JSON.parse(text), trace.endpointName))
    } catch (err) {
      setError((err as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ''))
    } finally {
      setRunning(false)
    }
  }

  return (
    <div className="grid h-full min-h-[520px] grid-cols-2 gap-4">
      <div className="flex min-h-0 flex-col">
        <div className="mb-2 flex items-center justify-between">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-subtle">Request (editable)</h3>
          <div className="flex gap-1">
            <Button size="sm" variant="ghost" disabled={text === original} onClick={() => setText(original)}>
              <RotateCcw className="size-3.5" /> Reset
            </Button>
            <Button size="sm" variant="primary" loading={running} disabled={!!parseError} onClick={run}>
              {!running && <Play className="size-3.5" />} Send
            </Button>
          </div>
        </div>
        <TextArea
          value={text}
          onChange={(e) => setText(e.target.value)}
          spellCheck={false}
          className="min-h-0 flex-1 bg-code font-mono text-[12px] leading-relaxed"
        />
        <p className="mt-2 text-xs text-subtle">
          {parseError ? (
            <span className="text-danger">Invalid JSON: {parseError}</span>
          ) : (
            `Sent without streaming to ${trace.endpointName ?? 'the endpoint it was recorded from'}. It costs tokens like any request and is recorded as a replay; images that weren’t recorded are left out.`
          )}
        </p>
      </div>

      <div className="min-h-0 overflow-y-auto">
        <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-subtle">Result</h3>
        {error && (
          <div className="flex gap-2 rounded-ollmost border border-danger/40 p-3 text-[13px] text-danger">
            <TriangleAlert className="mt-0.5 size-4 shrink-0" /> <span className="selectable">{error}</span>
          </div>
        )}
        {!result && !error && <p className="text-sm text-subtle">{running ? 'Waiting for the model…' : 'Edit the request, then Send.'}</p>}
        {result && (
          <div className="space-y-4">
            <div className="font-mono text-[12px] tabular-nums text-muted">
              {ms(result.durationMs)} · {formatTokens(result.promptTokens ?? 0)} in → {formatTokens(result.completionTokens ?? 0)} out ·{' '}
              {formatCost(result.costUsd)}
            </div>
            {result.response.thinking && (
              <div>
                <div className="mb-1 text-[11px] font-medium text-subtle">Thinking</div>
                <pre className="selectable whitespace-pre-wrap rounded-ollmost border border-line bg-code p-3 font-mono text-[12px] text-muted">
                  {result.response.thinking}
                </pre>
              </div>
            )}
            <div>
              <div className="mb-1 flex items-center justify-between text-[11px] font-medium text-subtle">
                Content {result.response.content && <CopyButton text={result.response.content} />}
              </div>
              <pre className="selectable whitespace-pre-wrap rounded-ollmost border border-line bg-code p-3 font-mono text-[12px] leading-relaxed">
                {result.response.content || '(empty)'}
              </pre>
            </div>
            {result.response.toolCalls && (
              <div>
                <div className="mb-1 text-[11px] font-medium text-subtle">Tool calls</div>
                <JsonBlock value={result.response.toolCalls} />
              </div>
            )}
            <div>
              <div className="mb-1 text-[11px] font-medium text-subtle">Final stats</div>
              <JsonBlock value={result.response.final ?? null} />
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
