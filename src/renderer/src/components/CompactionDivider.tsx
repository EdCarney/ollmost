import { ChevronRight, Layers } from 'lucide-react'
import { useState } from 'react'
import type { Compaction } from '@shared/types'
import { cn, relativeTime } from '@/lib/format'

/** Marks where a /compact summary ends: later replies replay the summary instead of the messages above it. */
export function CompactionDivider({ compaction }: { compaction: Compaction }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="my-2 text-[13px] text-muted" data-testid="compaction">
      <div className="flex items-center gap-3">
        <div className="h-px flex-1 bg-line" />
        <button
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          className="flex items-center gap-1.5 rounded-md px-2 py-1 hover:bg-hover hover:text-fg"
          title="Replies replay this summary in place of the messages above it; the messages stay here."
        >
          <Layers className="size-3.5" />
          <span>
            Compacted {compaction.turns} {compaction.turns === 1 ? 'message' : 'messages'} · {relativeTime(compaction.at)}
          </span>
          <ChevronRight className={cn('size-3.5 transition-transform', open && 'rotate-90')} />
        </button>
        <div className="h-px flex-1 bg-line" />
      </div>
      {open && (
        <div className="selectable mx-auto mt-2 max-w-[640px] whitespace-pre-wrap rounded-ollmost border border-line bg-panel px-4 py-3 leading-relaxed">
          {compaction.summary}
        </div>
      )}
    </div>
  )
}
