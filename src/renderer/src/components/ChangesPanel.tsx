import { RefreshCw, X } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ChangeStatus, CodeChanges, CodeDiff, Message, ToolEvent } from '@shared/types'
import { api } from '@/lib/api'
import { cn } from '@/lib/format'
import { useChangesPanel } from '@/stores/changesPanel'
import { useChat } from '@/stores/chat'
import { CodeBlock } from './CodeBlock'
import { IconButton, Spinner, Tooltip } from './ui'

const STATUS_GLYPH: Record<ChangeStatus, string> = {
  modified: 'M',
  added: 'A',
  deleted: 'D',
  renamed: 'R',
  untracked: '?',
  conflict: 'U'
}

const STATUS_COLOR: Record<ChangeStatus, string> = {
  modified: 'text-warn',
  added: 'text-success',
  deleted: 'text-danger',
  renamed: 'text-warn',
  untracked: 'text-success',
  conflict: 'text-danger'
}

/** A stable empty array, so reading it when there's no session loaded doesn't look like a new value every render. */
const NO_MESSAGES: Message[] = []

/** Electron wraps a thrown IPC error; strip that so the reason shows plainly. Third copy of this regex (see app.ts, Replay.tsx). */
function errorText(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err)
  return raw.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
}

function countLabel(n: number, cut: boolean): string {
  return `${n}${cut ? '+' : ''} file${n === 1 && !cut ? '' : 's'}`
}

interface FallbackRow {
  path: string
  status: ChangeStatus
  diff: string
}

/** This session's edit_file and write_file calls, most recent first, one row per distinct path (the latest wins). */
function useFallbackRows(sessionId: string): FallbackRow[] {
  const messages = useChat((s) => (s.conversation?.id === sessionId ? s.messages : NO_MESSAGES))
  // Keyed on the live stream's events and which message they belong to, not the stream object itself, which is a
  // new value on every delta frame while a reply is only streaming text (no tool calls yet).
  const streamMessageId = useChat((s) => s.streams[sessionId]?.messageId)
  const streamEvents = useChat((s) => s.streams[sessionId]?.toolEvents)

  return useMemo(() => {
    const finished: ToolEvent[] = []
    for (const m of messages) {
      const events = streamMessageId === m.id && streamEvents ? streamEvents : m.toolEvents
      for (const e of events) {
        if (e && (e.tool === 'edit_file' || e.tool === 'write_file') && e.ok && !e.pending) finished.push(e)
      }
    }
    const byPath = new Map<string, FallbackRow>()
    for (const e of finished) {
      // The resolved relative path the main process sets, so ./a.ts, a.ts and an absolute path don't make separate rows.
      const path = e.files?.[0]?.path ?? String(e.args.path ?? '')
      if (!path) continue
      // Re-inserting a path already seen moves it to the end of the map's order, so reversing below gives most-recent-first.
      byPath.delete(path)
      byPath.set(path, { path, status: e.summary.startsWith('new file') ? 'added' : 'modified', diff: e.diff ?? '' })
    }
    return [...byPath.values()].reverse()
  }, [messages, streamMessageId, streamEvents])
}

/**
 * What changed in a code session's folder: git's status and diffs when there's a repository there, else this
 * session's own edits. Mounted by App.tsx only while open for the session on screen, keyed there by session id so
 * switching sessions remounts this fresh rather than resetting state by hand.
 */
export function ChangesPanel() {
  // App.tsx only mounts this while the store's sessionId is set and matches the route, so it's never null here.
  const sessionId = useChangesPanel((s) => s.sessionId)!
  const width = useChangesPanel((s) => s.width)
  const selected = useChangesPanel((s) => s.selected)
  const close = useChangesPanel((s) => s.close)
  const setWidth = useChangesPanel((s) => s.setWidth)
  const select = useChangesPanel((s) => s.select)
  const setCount = useChangesPanel((s) => s.setCount)

  const [changes, setChanges] = useState<CodeChanges | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [refreshToken, setRefreshToken] = useState(0)
  const refresh = useCallback(() => setRefreshToken((t) => t + 1), [])
  const dragging = useRef(false)

  // A boolean, not the stream object itself, so the open panel doesn't re-render on every streamed frame.
  const streaming = useChat((s) => !!s.streams[sessionId])
  // Read inside the fetch effect without being a dependency, so a reply starting doesn't also retrigger it directly
  // (the wasStreaming effect below already asks for a fetch, once, exactly when a reply ends).
  const streamingRef = useRef(streaming)
  streamingRef.current = streaming

  // The main process refuses git access in the session's own folder while a reply runs there; look again once it ends.
  const wasStreaming = useRef(streaming)
  useEffect(() => {
    if (wasStreaming.current && !streaming) refresh()
    wasStreaming.current = streaming
  }, [streaming, refresh])

  useEffect(() => {
    if (streamingRef.current) return
    let cancelled = false
    api.code.changes(sessionId).then(
      (result) => {
        if (cancelled) return
        // An error answer keeps the previous list; only a clean answer replaces it.
        if (result.error !== null) {
          setError(result.error)
        } else {
          setError(null)
          setChanges(result)
        }
      },
      (err) => {
        if (cancelled) return
        setError(errorText(err))
      }
    )
    return () => {
      cancelled = true
    }
  }, [refreshToken, sessionId])

  const fallbackRows = useFallbackRows(sessionId)
  const repoMode = changes?.repo === true
  const rows: Array<{ path: string; status: ChangeStatus; from?: string }> = repoMode ? changes!.files : fallbackRows

  // The badge is the number of rows the panel is actually showing: git's files once fetched, or, in the fallback,
  // the session's own edits (which can grow on their own, without a fresh fetch).
  useEffect(() => {
    if (changes) setCount(sessionId, rows.length)
  }, [changes, sessionId, rows, setCount])

  // A refresh can drop a path that was selected (it stopped changing, or moved out of view); don't keep its diff open.
  useEffect(() => {
    if (selected && !rows.some((r) => r.path === selected)) select(null)
  }, [rows, selected, select])

  // The diff for the selected file: fetched from git in repo mode, already in hand from the session's own event otherwise.
  const [diff, setDiff] = useState<CodeDiff | null>(null)
  const [diffLoading, setDiffLoading] = useState(false)
  const [diffError, setDiffError] = useState<string | null>(null)

  useEffect(() => {
    setDiff(null)
    setDiffError(null)
    // Same refusal as the changes fetch: git can't run in the folder while a reply does; the JSX shows a line for
    // it below and this re-runs once streaming ends.
    if (!selected || !repoMode || streaming) return
    let cancelled = false
    setDiffLoading(true)
    api.code.diff(sessionId, selected).then(
      (result) => {
        if (cancelled) return
        setDiffLoading(false)
        setDiff(result)
      },
      (err) => {
        if (cancelled) return
        setDiffLoading(false)
        setDiffError(errorText(err))
      }
    )
    return () => {
      cancelled = true
    }
    // `changes` is a dependency too, so a fresh fetch re-reads the diff instead of leaving a stale one showing.
  }, [selected, sessionId, repoMode, changes, streaming])

  useEffect(() => {
    const move = (e: MouseEvent) => {
      if (!dragging.current) return
      setWidth(window.innerWidth - e.clientX)
    }
    const up = () => {
      if (!dragging.current) return
      dragging.current = false
      document.body.style.cursor = ''
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
    return () => {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
    }
  }, [setWidth])

  const fallbackEvent = !repoMode ? fallbackRows.find((r) => r.path === selected) : null

  return (
    <aside style={{ width }} className="relative flex h-full shrink-0 flex-col border-l border-line bg-canvas" data-testid="changes-panel">
      <div
        onMouseDown={() => {
          dragging.current = true
          document.body.style.cursor = 'col-resize'
        }}
        className="absolute inset-y-0 -left-1 z-10 w-2 cursor-col-resize"
        aria-hidden
      />
      <header className="drag flex h-12 shrink-0 items-center gap-2 border-b border-line px-3">
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium">Changes</div>
          {changes && <div className="truncate text-xs text-subtle">{countLabel(rows.length, repoMode ? changes.cut : false)}</div>}
        </div>
        {/* A disabled button gets no hover of its own (IconButton's disabled:pointer-events-none), so the tooltip
            goes on a plain wrapping span instead. */}
        <Tooltip content={streaming ? 'After the reply' : 'Refresh'}>
          <span className="no-drag inline-flex">
            <IconButton label={streaming ? 'After the reply' : 'Refresh'} size="sm" tooltip={false} disabled={streaming} onClick={refresh}>
              <RefreshCw className="size-4" />
            </IconButton>
          </span>
        </Tooltip>
        <IconButton label="Close" size="sm" onClick={close}>
          <X className="size-4" />
        </IconButton>
      </header>

      {error && <div className="shrink-0 border-b border-line px-3 py-2 text-xs text-danger">{error}</div>}

      {changes && !repoMode && !error && (
        <div className="shrink-0 border-b border-line px-3 py-2 text-xs text-subtle">
          Not a git repository: showing this session's edits.
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto">
        {changes === null ? (
          // A first-load failure has nothing to describe beyond the error line above; show only that.
          error ? null : streaming ? (
            <div className="px-3 py-6 text-center text-sm text-subtle">Looks again after the reply.</div>
          ) : (
            <div className="flex h-full items-center justify-center">
              <Spinner />
            </div>
          )
        ) : rows.length === 0 ? (
          <div className="px-3 py-6 text-center text-sm text-subtle">No changes.</div>
        ) : (
          rows.map((f) => (
            <button
              key={f.path}
              data-testid="changes-row"
              onClick={() => select(selected === f.path ? null : f.path)}
              aria-expanded={selected === f.path}
              className={cn(
                'flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm hover:bg-hover',
                selected === f.path && 'bg-hover'
              )}
            >
              <span className={cn('w-4 shrink-0 text-center font-mono text-xs', STATUS_COLOR[f.status])}>{STATUS_GLYPH[f.status]}</span>
              {/* dir="rtl" truncates from the left so the file name stays visible; bdi isolates the text so a
                  leading "." (as in .gitignore) doesn't get reordered to the end by the bidi algorithm. */}
              <span dir="rtl" className="min-w-0 flex-1 truncate text-left" title={f.from ? `${f.from} → ${f.path}` : f.path}>
                <bdi>{f.from ? `${f.from} → ${f.path}` : f.path}</bdi>
              </span>
            </button>
          ))
        )}
      </div>

      {selected && (
        <div className="max-h-72 shrink-0 overflow-auto border-t border-line bg-panel p-2.5 font-ui text-xs">
          {repoMode ? (
            streaming ? (
              <div className="text-subtle">After the reply</div>
            ) : diffLoading ? (
              <div className="flex justify-center py-4">
                <Spinner />
              </div>
            ) : diffError ? (
              <div className="text-danger">{diffError}</div>
            ) : diff ? (
              diff.diff.trim() ? (
                <div className="space-y-2">
                  <CodeBlock code={diff.diff} lang="diff" />
                  {diff.cut && <div className="text-muted">Cut short</div>}
                </div>
              ) : (
                <div className="text-subtle">No diff to show.</div>
              )
            ) : null
          ) : fallbackEvent ? (
            fallbackEvent.diff.trim() ? (
              <CodeBlock code={fallbackEvent.diff} lang="diff" />
            ) : (
              <div className="text-subtle">No diff to show.</div>
            )
          ) : null}
        </div>
      )}
    </aside>
  )
}
