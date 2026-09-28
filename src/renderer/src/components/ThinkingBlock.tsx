import { Brain, ChevronRight } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { normalizeSpaces } from '@shared/text'
import { cn, formatDuration } from '@/lib/format'
import { useThinkingPanes } from '@/stores/thinkingPanes'

/**
 * A round's thinking: open while it's live, collapsed once it ends, unless the reader toggled it. Closing live thinking
 * keeps the chat's later thinking closed too, until the reader opens some while it's live (stores/thinkingPanes.ts).
 */
export function ThinkingBlock({
  conversationId,
  thinking,
  active,
  durationMs
}: {
  conversationId: string
  thinking: string
  active: boolean
  durationMs: number | null
}) {
  const [toggled, setToggled] = useState<boolean | null>(null)
  const opensItself = useThinkingPanes((s) => !s.closed.includes(conversationId))
  const liveToggled = useThinkingPanes((s) => s.liveToggled)
  // Open by itself once there's live thinking to show; the stand-in before any arrives stays a line.
  const open = toggled ?? (active && !!thinking && opensItself)
  const box = useRef<HTMLDivElement>(null)
  // Live text grows past the box: keep its end in view, as the transcript does, unless the reader scrolled up.
  const stuck = useRef(true)
  useEffect(() => {
    const el = box.current
    if (open && active && stuck.current && el) el.scrollTop = el.scrollHeight
  }, [thinking, open, active])
  if (!thinking && !active) return null
  return (
    <div className="mb-3">
      <button
        onClick={() => {
          setToggled(!open)
          if (active) liveToggled(conversationId, !open)
        }}
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
          onScroll={(e) => {
            const el = e.currentTarget
            stuck.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24
          }}
          className="selectable mt-1.5 max-h-96 overflow-y-auto whitespace-pre-wrap border-l-2 border-line pl-3.5 font-ui text-[13px] leading-relaxed text-muted"
        >
          {normalizeSpaces(thinking) || '…'}
        </div>
      )}
    </div>
  )
}
