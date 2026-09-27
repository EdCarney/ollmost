import type { RangedSegment, Segment } from './artifactParser'
import type { ThinkingSegment, ToolEvent } from './types'

/** A tool event with its position in the message's `toolEvents` (the stream updates events by index). */
export interface IndexedToolEvent {
  event: ToolEvent
  index: number
}

export type TimelineItem =
  | { kind: 'segment'; segment: Segment }
  | { kind: 'tools'; events: IndexedToolEvent[] }
  /** A round's thinking; `position` is its place in the message's list, for keys. */
  | { kind: 'thinking'; thinking: ThinkingSegment; position: number }

/** A call or a round's thinking waiting to be placed, ordered by where it happened in the text, then by round. */
type Queued = { at: number; order: number } & (
  { kind: 'tool'; event: IndexedToolEvent } | { kind: 'thinking'; thinking: ThinkingSegment; position: number }
)

const FENCE_LINE = /^[ \t]*(```|~~~)/gm

/**
 * Where to split a text segment so a tool group can sit at `local`: never inside a fenced code block, which
 * would break the Markdown on both sides. A split inside one moves to just after the closing fence.
 */
function safeSplit(text: string, local: number): number {
  const fences = [...text.matchAll(FENCE_LINE)].map((m) => m.index)
  const before = fences.filter((i) => i < local).length
  if (before % 2 === 0) return local
  const close = fences.find((i) => i >= local)
  if (close === undefined) return text.length
  const lineEnd = text.indexOf('\n', close)
  return lineEnd === -1 ? text.length : lineEnd + 1
}

/**
 * Put a reply's tool calls, and each round's thinking, where they happened. Each event's `at` is how long the
 * reply's text was when the call was made; a round's thinking has the text length and the number of calls at
 * the round's start, so it sits after the calls that ended the round before and before the round's own.
 * Calls from before `at` was recorded have none and go first, as they always used to, after the first round's
 * thinking. A call made inside an artifact goes after it.
 */
export function interleave(segments: RangedSegment[], events: ToolEvent[], thinking: ThinkingSegment[] = []): TimelineItem[] {
  const items: TimelineItem[] = []
  const addTools = (group: IndexedToolEvent[]) => {
    if (!group.length) return
    const last = items[items.length - 1]
    if (last?.kind === 'tools') last.events.push(...group)
    else items.push({ kind: 'tools', events: group })
  }
  const addText = (text: string) => {
    if (text.trim()) items.push({ kind: 'segment', segment: { kind: 'text', text } })
  }
  const add = (taken: Queued[]) => {
    for (const q of taken) {
      if (q.kind === 'tool') addTools([q.event])
      else items.push({ kind: 'thinking', thinking: q.thinking, position: q.position })
    }
  }

  const positioned = thinking.map((t, position) => ({ thinking: t, position }))
  // The first round's thinking came before any call, even one made before positions were recorded.
  for (const { thinking: t, position } of positioned.filter((p) => p.thinking.index === 0))
    items.push({ kind: 'thinking', thinking: t, position })
  const indexed = events.map((event, index) => ({ event, index }))
  addTools(indexed.filter((e) => e.event.at === undefined))
  const queue: Queued[] = [
    ...indexed.filter((e) => e.event.at !== undefined).map((e): Queued => ({ kind: 'tool', at: e.event.at!, order: e.index, event: e })),
    ...positioned
      .filter((p) => p.thinking.index > 0)
      .map((p): Queued => ({ kind: 'thinking', at: p.thinking.at, order: p.thinking.index - 0.5, ...p }))
  ].sort((a, b) => a.at - b.at || a.order - b.order)
  const takeUntil = (limit: number) => {
    let n = 0
    while (n < queue.length && queue[n].at <= limit) n++
    return queue.splice(0, n)
  }

  for (const seg of segments) {
    add(takeUntil(seg.start))
    const { start: _start, end: _end, ...segment } = seg
    if (seg.kind === 'artifact') {
      items.push({ kind: 'segment', segment: segment as Segment })
      add(takeUntil(seg.end))
      continue
    }
    // Split the text at each call or thinking inside it (grouping what lands on the same safe point).
    let from = 0
    while (queue.length && queue[0].at < seg.end) {
      const at = safeSplit(seg.text, Math.min(Math.max(queue[0].at - seg.start, from), seg.text.length))
      addText(seg.text.slice(from, at))
      // At the end of the text, take everything inside the segment: its text may have been trimmed shorter
      // than its range (a stray fence), and a call past the trimmed end must not be left behind.
      add(takeUntil(at >= seg.text.length ? seg.end - 1 : seg.start + at))
      from = at
    }
    addText(seg.text.slice(from))
  }
  add(queue.splice(0))
  return items
}
