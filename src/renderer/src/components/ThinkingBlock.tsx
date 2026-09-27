import { Brain, ChevronRight } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { normalizeSpaces } from '@shared/text'
import { cn, formatDuration } from '@/lib/format'

/** A round's thinking: open while it's live (unless the reader closed it), collapsed once it ends (unless opened). */
export function ThinkingBlock({ thinking, active, durationMs }: { thinking: string; active: boolean; durationMs: number | null }) {
  const [toggled, setToggled] = useState<boolean | null>(null)
  const open = toggled ?? active
  const box = useRef<HTMLDivElement>(null)
  // Live text grows past the box: keep its end in view, as the transcript does.
  useEffect(() => {
    if (open && active && box.current) box.current.scrollTop = box.current.scrollHeight
  }, [thinking, open, active])
  if (!thinking && !active) return null
  return (
    <div className="mb-3">
      <button
        onClick={() => setToggled(!open)}
        className="group flex items-center gap-1.5 rounded-md py-1 text-[13px] text-muted hover:text-fg"
        aria-expanded={open}
      >
        <Brain className="size-4" />
        <span className={cn(active && 'shimmer-text')}>
          {active ? 'Thinking…' : durationMs !== null ? `Thought for ${formatDuration(durationMs)}` : 'Thought process'}
        </span>
        <ChevronRight className={cn('size-3.5 transition-transform', open && 'rotate-90')} />
      </button>
      {open && (
        <div
          ref={box}
          className="selectable mt-1.5 max-h-96 overflow-y-auto whitespace-pre-wrap border-l-2 border-line pl-3.5 font-ui text-[13px] leading-relaxed text-muted"
        >
          {normalizeSpaces(thinking) || '…'}
        </div>
      )}
    </div>
  )
}
