import { ChevronRight, FilePen, FileText, FolderTree, LoaderCircle, Search, SquareTerminal } from 'lucide-react'
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

/**
 * Whether a card's summary is just its subject restated, bare or with the "(stopped)"/"(not run)" note a settled call
 * gets: nothing worth a second, redundant line (e.g. "Couldn't read src/x.ts · src/x.ts (stopped)").
 */
function repeatsSubject(summary: string, subject: string): boolean {
  if (!summary) return true
  // The main process cuts a long command at the same length without the ellipsis this card adds.
  const plain = subject.replace(/…$/, '')
  if (summary === plain) return true
  const note = summary.match(/^(.*) \((stopped|not run)\)$/)
  return note !== null && note[1] === plain
}

/** A command a code session ran: its first line and how it went; on click, the whole command and what the model saw. */
export function CommandCard({ e }: { e: ToolEvent }) {
  const [open, setOpen] = useState(false)
  const command = String(e.args.command ?? '')
  const subject = firstLine(command)
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
        {command && <span className="truncate font-mono text-fg">{subject}</span>}
        {failed && e.summary && !repeatsSubject(e.summary, subject) && (
          <span className="max-w-[320px] truncate" title={e.summary}>
            · {e.summary}
          </span>
        )}
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

/** A path or pattern on a card, in mono; it's what gives way when the card runs out of room. */
function Subject({ text, running }: { text: string; running?: boolean }) {
  const subject = <span className="truncate font-mono text-fg">{text}</span>
  // The ellipsis of a call still running sits right after the path, not a gap away.
  return running ? (
    <span className="flex min-w-0">
      {subject}
      <span className="shrink-0">…</span>
    </span>
  ) : (
    subject
  )
}

const FILE_EVENTS: Record<string, { icon: typeof FileText; pending: string; labels: [string, string, string]; detail: string }> = {
  read_file: { icon: FileText, pending: 'Reading', labels: ['Read', "Couldn't read", "Didn't read"], detail: 'Text' },
  list_files: { icon: FolderTree, pending: 'Listing files…', labels: ['Listed', "Couldn't list", "Didn't list"], detail: 'Files' },
  search_files: { icon: Search, pending: 'Searching…', labels: ['Searched', "Couldn't search", "Didn't search"], detail: 'Matches' }
}

/** What a list or search looked for and where: the pattern (or "files"), then the folder when the model named one. */
function Target({ e }: { e: ToolEvent }) {
  const pattern = String(e.args.pattern ?? '')
  const path = String(e.args.path ?? '')
  return (
    <>
      {pattern ? <Subject text={pattern} /> : e.tool === 'list_files' && <span className="shrink-0">files</span>}
      {path && (
        <>
          <span className="shrink-0">in</span>
          <Subject text={path} />
        </>
      )}
    </>
  )
}

/** A file a code session read, or a list or search of its folder: what it looked at and how it went; on click, what the model saw. */
export function FileEvent({ e }: { e: ToolEvent }) {
  const [open, setOpen] = useState(false)
  const kind = FILE_EVENTS[e.tool] ?? FILE_EVENTS.read_file
  const Icon = kind.icon
  const failed = !e.pending && !e.ok && !e.declined
  const expandable = !e.pending && !!e.preview
  const [done, couldnt, didnt] = kind.labels
  const label = e.pending ? kind.pending : e.ok ? done : e.declined ? didnt : couldnt
  const path = String(e.args.path ?? '')
  const pattern = String(e.args.pattern ?? '')
  const subject = e.tool === 'read_file' ? path : pattern || (e.tool === 'list_files' ? 'files' : '')
  return (
    <div className={cn('max-w-full', open && 'basis-full')}>
      <button
        onClick={() => setOpen(!open)}
        disabled={!expandable}
        aria-expanded={expandable ? open : undefined}
        className={cn(
          pill,
          failed ? 'border-danger/40 text-danger' : 'border-line text-muted',
          expandable && 'hover:border-line-strong hover:text-fg'
        )}
      >
        {e.pending ? <LoaderCircle className="size-3.5 shrink-0 animate-spin" /> : <Icon className="size-3.5 shrink-0" />}
        <span className="shrink-0">{label}</span>
        {e.tool === 'read_file' ? <Subject text={path} running={e.pending} /> : !e.pending && <Target e={e} />}
        {!e.pending && !e.declined && e.summary && !repeatsSubject(e.summary, subject) && (
          <span className={failed ? 'max-w-[320px] truncate' : 'shrink-0'} title={failed ? e.summary : undefined}>
            · {e.summary}
          </span>
        )}
        {expandable && <ChevronRight className={cn('size-3 shrink-0 transition-transform', open && 'rotate-90')} />}
      </button>
      {open && e.preview && (
        <div className="mt-1.5 rounded-ollmost border border-line bg-panel p-2.5 font-ui text-xs">
          {/* A failed call's preview is the reason it gave the model, not the file's text. */}
          <Detail label={e.ok ? kind.detail : 'Result'} text={e.preview} />
        </div>
      )}
    </div>
  )
}

const EDIT_LABELS: Record<string, [string, string, string, string]> = {
  edit_file: ['Editing', 'Edited', "Couldn't edit", "Didn't edit"],
  write_file: ['Writing', 'Wrote', "Couldn't write", "Didn't write"]
}

/** A file a code session edited or wrote: the path and how it went; on click, the diff (or, without one, what it asked for). */
export function EditCard({ e }: { e: ToolEvent }) {
  const [open, setOpen] = useState(false)
  const failed = !e.pending && !e.ok && !e.declined
  const [running, done, couldnt, didnt] = EDIT_LABELS[e.tool] ?? EDIT_LABELS.edit_file
  const label = e.pending ? running : e.ok ? done : e.declined ? didnt : couldnt
  const path = String(e.args.path ?? '')
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
        {e.pending ? <LoaderCircle className="size-3.5 shrink-0 animate-spin" /> : <FilePen className="size-3.5 shrink-0" />}
        <span className="shrink-0">{label}</span>
        <Subject text={path} running={e.pending} />
        {!e.pending && !e.declined && e.summary && !repeatsSubject(e.summary, path) && (
          <span className={failed ? 'max-w-[320px] truncate' : 'shrink-0'} title={failed ? e.summary : undefined}>
            · {e.summary}
          </span>
        )}
        {!e.pending && <ChevronRight className={cn('size-3 shrink-0 transition-transform', open && 'rotate-90')} />}
      </button>
      {open && (
        <div className="mt-1.5 space-y-2 rounded-ollmost border border-line bg-panel p-2.5 font-ui text-xs">
          {e.diff ? (
            <div className="max-h-96 overflow-auto">
              <CodeBlock code={e.diff} lang="diff" />
            </div>
          ) : e.tool === 'write_file' ? (
            <Detail label="Content" text={String(e.args.content ?? '')} />
          ) : (
            <>
              <Detail label="Replace" text={String(e.args.old_string ?? '')} />
              <Detail label="With" text={String(e.args.new_string ?? '')} />
            </>
          )}
          {failed && e.preview && <Detail label="Result" text={e.preview} />}
        </div>
      )}
    </div>
  )
}
