import { Check, CircleAlert, CircleCheck, CircleSlash, Copy, LoaderCircle } from 'lucide-react'
import { useMemo } from 'react'
import type { TraceSummary } from '@shared/types'
import { CodeBlock, useCopy } from '@/components/CodeBlock'
import { Button } from '@/components/ui'
import { cn } from '@/lib/format'

// Small pieces shared by the debugger's list, detail, anatomy and replay views.

export function StatusIcon({ status, className }: { status: TraceSummary['status']; className?: string }) {
  if (status === 'running') return <LoaderCircle className={cn('size-3.5 animate-spin text-accent', className)} aria-label="Running" />
  if (status === 'ok') return <CircleCheck className={cn('size-3.5 text-success', className)} aria-label="OK" />
  if (status === 'aborted') return <CircleSlash className={cn('size-3.5 text-warn', className)} aria-label="Stopped" />
  return <CircleAlert className={cn('size-3.5 text-danger', className)} aria-label="Error" />
}

export function kindLabel(t: Pick<TraceSummary, 'kind' | 'round'>): string {
  if (t.kind === 'chat') return `chat · round ${(t.round ?? 0) + 1}`
  if (t.kind === 'delegate') return 'sub-agent'
  return t.kind
}

export const ms = (v: number | null | undefined) => (v == null ? '—' : v < 1000 ? `${v} ms` : `${(v / 1000).toFixed(2)} s`)

export function CopyButton({ text, label = 'Copy' }: { text: string; label?: string }) {
  const [copied, copy] = useCopy()
  return (
    <Button size="sm" variant="ghost" onClick={() => copy(text)}>
      {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />} {copied ? 'Copied' : label}
    </Button>
  )
}

/** Pretty JSON; highlighted when small enough that Shiki stays fast. */
export function JsonBlock({ value, className }: { value: unknown; className?: string }) {
  const text = useMemo(() => JSON.stringify(value, null, 2) ?? 'null', [value])
  return (
    <div className={cn('json-wrap overflow-hidden rounded-ollmost border border-line bg-code', className)}>
      {text.length < 120_000 ? (
        <CodeBlock code={text} lang="json" bare />
      ) : (
        <pre className="selectable overflow-x-auto p-4 font-mono text-[12px] leading-relaxed">{text}</pre>
      )}
    </div>
  )
}
