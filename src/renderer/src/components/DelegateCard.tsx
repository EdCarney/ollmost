import { Bot, ChevronRight, Loader2 } from 'lucide-react'
import { useEffect, useState } from 'react'
import { childId } from '@shared/toolEvents'
import type { ToolEvent } from '@shared/types'
import { cn } from '@/lib/format'
import { Detail, pill, ToolGroup } from './Messages'
import { Markdown } from './Markdown'

/** A sub-agent's run: its task, the calls it made, and the reply the parent got. */
export function DelegateCard({
  e,
  conversationId,
  messageId,
  index,
  scope
}: {
  e: ToolEvent
  conversationId: string
  messageId: string
  index: number
  /** Passed through to the child's ToolGroup; see ApprovalCard's scope prop. */
  scope?: string
}) {
  const child = e.child
  const waiting = !!child?.events.some((ev) => ev?.awaiting)
  const [opened, setOpened] = useState(false)
  // Opened for a question, it stays open once answered, so the card the user answered in doesn't snap shut.
  useEffect(() => {
    if (waiting) setOpened(true)
  }, [waiting])
  const open = opened || waiting
  const calls = child?.events.length ?? 0
  return (
    <div data-testid="delegate-card" className="basis-full">
      <button
        onClick={() => setOpened((o) => !o)}
        aria-expanded={open}
        className={cn(pill, 'cursor-pointer', e.pending ? 'border-line' : e.ok ? 'border-line' : 'border-danger/50 text-danger')}
      >
        {e.pending ? <Loader2 className="size-3.5 shrink-0 animate-spin" /> : <Bot className="size-3.5 shrink-0" />}
        <span className="truncate">Sub-agent · {e.summary}</span>
        <ChevronRight className={cn('size-3.5 shrink-0 text-subtle transition-transform', open && 'rotate-90')} />
      </button>
      {open && child && (
        <div className="mt-1.5 rounded-ollmost border border-line bg-panel p-3 font-ui text-[13px]">
          <div className="whitespace-pre-wrap text-muted">{child.task}</div>
          {child.context && <Detail label="Context" text={child.context} />}
          {calls > 0 && (
            <ToolGroup
              events={child.events.map((event, i) => ({ event, index: i }))}
              conversationId={conversationId}
              messageId={childId(messageId, index)}
              scope={scope}
              depth={1}
              child
            />
          )}
          {child.result ? (
            <>
              <div className="mt-2 text-xs font-medium text-muted">Result</div>
              <Markdown text={child.result} conversationId={conversationId} />
            </>
          ) : e.pending ? (
            <div className="mt-2 text-xs text-subtle">Working…</div>
          ) : child.error ? (
            <div className="mt-2 whitespace-pre-wrap text-xs text-danger">The sub-agent failed: {child.error}</div>
          ) : (
            <div className="mt-2 text-xs text-subtle">Stopped before it answered.</div>
          )}
        </div>
      )}
    </div>
  )
}
