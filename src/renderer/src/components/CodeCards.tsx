import { ChevronRight, LoaderCircle, SquareTerminal } from 'lucide-react'
import { useState } from 'react'
import type { ToolEvent } from '@shared/types'
import { cn } from '@/lib/format'
import { CodeBlock } from './CodeBlock'
import { Detail, pill } from './Messages'

const FIRST_LINE_MAX = 120

/** The first line that isn't blank or a comment (as the main process names the command), cut to fit on a card. */
const firstLine = (command: string): string => {
  const line =
    command
      .split('\n')
      .map((l) => l.trim())
      .find((l) => l && !l.startsWith('#')) ?? ''
  return line.length > FIRST_LINE_MAX ? `${line.slice(0, FIRST_LINE_MAX)}…` : line
}

/** A command a code session ran: its first line and how it went; on click, the whole command and what the model saw. */
export function CommandCard({ e }: { e: ToolEvent }) {
  const [open, setOpen] = useState(false)
  const command = String(e.args.command ?? '')
  const failed = !e.pending && !e.ok && !e.declined
  const label = e.pending ? 'Running command…' : e.declined ? "Didn't run" : e.ok ? 'Ran' : 'Command failed'
  return (
    <div className={cn('max-w-full', open && 'basis-full')}>
      <button
        onClick={() => setOpen(!open)}
        disabled={e.pending}
        aria-expanded={open}
        className={cn(
          pill,
          failed ? 'border-danger/40 text-danger' : 'border-line text-muted',
          !e.pending && 'hover:border-line-strong hover:text-fg'
        )}
      >
        {e.pending ? <LoaderCircle className="size-3.5 shrink-0 animate-spin" /> : <SquareTerminal className="size-3.5 shrink-0" />}
        <span className="shrink-0">{label}</span>
        {command && <span className="truncate font-mono text-fg">{firstLine(command)}</span>}
        {failed && e.summary && <span className="shrink-0">· {e.summary}</span>}
        {!e.pending && <ChevronRight className={cn('size-3 shrink-0 transition-transform', open && 'rotate-90')} />}
      </button>
      {open && (
        <div className="mt-1.5 space-y-2 rounded-ollmost border border-line bg-panel p-2.5 font-ui text-xs">
          <div className="max-h-80 overflow-auto">
            <CodeBlock code={command} lang="bash" />
          </div>
          {e.preview && <Detail label="Output" text={e.preview} />}
        </div>
      )}
    </div>
  )
}
