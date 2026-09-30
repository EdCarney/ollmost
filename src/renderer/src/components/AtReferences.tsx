import { FileText, Folder } from 'lucide-react'
import { useEffect, useRef } from 'react'
import { type AtRow, type AtToken, hitRuns, splitMarked } from '@shared/atRefs'
import { cn } from '@/lib/format'

/**
 * An @ reference that names a real file or folder (#129): accent text on the soft accent ground, as a skill chip is.
 * Colour and background only (its padding is a shadow), so the composer's layer of marks wraps as its textarea does.
 */
export const REF_MARK = 'rounded-[4px] bg-accent-soft text-accent shadow-[0_0_0_2px_var(--o-accentSoft)] [box-decoration-break:clone]'

/** `text` with its marked tokens drawn as references. */
export function MarkedText({ text, marks }: { text: string; marks: readonly AtToken[] }) {
  return (
    <>
      {splitMarked(text, marks).map((part, i) =>
        part.marked ? (
          <span key={i} data-testid="at-mark" className={REF_MARK}>
            {part.text}
          </span>
        ) : (
          <span key={i}>{part.text}</span>
        )
      )}
    </>
  )
}

/** Part of a path, with the characters the query matched in the accent colour. */
function Matched({ text, hits, offset }: { text: string; hits: readonly number[]; offset: number }) {
  return (
    <>
      {hitRuns(text, hits, offset).map((run, i) => (
        <span key={i} className={run.hit ? 'text-accent' : undefined}>
          {run.text}
        </span>
      ))}
    </>
  )
}

/** The @ menu: above the composer, like the / menu, wider so a name and its folder fit on one row. */
export function AtMenu({
  heading,
  rows,
  index,
  footer,
  onChoose
}: {
  heading: string | null
  rows: readonly AtRow[]
  index: number
  footer: string | null
  onChoose: (path: string) => void
}) {
  const list = useRef<HTMLDivElement>(null)
  const current = useRef<HTMLButtonElement>(null)
  // Keep the chosen row in sight by scrolling the list alone: scrollIntoView could scroll the window's own panes too.
  useEffect(() => {
    const box = list.current
    const row = current.current
    if (!box || !row) return
    if (row.offsetTop < box.scrollTop) box.scrollTop = row.offsetTop
    else if (row.offsetTop + row.offsetHeight > box.scrollTop + box.clientHeight)
      box.scrollTop = row.offsetTop + row.offsetHeight - box.clientHeight
  }, [index, rows])

  return (
    <div
      data-testid="at-menu"
      className="absolute bottom-full left-0 z-30 mb-2 w-[420px] rounded-ollmost border border-line bg-panel p-1 shadow-[0_8px_30px_rgba(0,0,0,0.12)]"
    >
      {heading && <div className="px-2 pb-1 pt-1.5 text-xs font-medium text-subtle">{heading}</div>}
      {rows.length > 0 && (
        <div ref={list} className="relative max-h-[296px] overflow-y-auto">
          {rows.map((row, i) => (
            <button
              key={row.path}
              ref={i === index ? current : undefined}
              data-path={row.path}
              onMouseDown={(e) => {
                e.preventDefault()
                onChoose(row.path)
              }}
              className={cn('flex h-8 w-full items-center gap-2 rounded-md px-2 text-left', i === index && 'bg-hover')}
            >
              {row.folder ? <Folder className="size-4 shrink-0 text-muted" /> : <FileText className="size-4 shrink-0 text-muted" />}
              <span className="flex min-w-0 flex-1 items-baseline gap-2">
                <span className="max-w-full shrink-0 truncate text-sm font-semibold">
                  <Matched text={row.name} hits={row.hits} offset={row.dir ? row.dir.length + 1 : 0} />
                </span>
                <span className="min-w-0 truncate text-xs text-muted">
                  <Matched text={row.dir} hits={row.hits} offset={0} />
                </span>
              </span>
              {row.touched && <span className="shrink-0 text-[11px] text-muted">{row.touched}</span>}
            </button>
          ))}
        </div>
      )}
      {footer && <div className={cn('px-2 pb-1 pt-2 text-xs text-muted', rows.length > 0 && 'mt-1 border-t border-line')}>{footer}</div>}
    </div>
  )
}
