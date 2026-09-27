import type { ThinkingSegment } from './types'

/** A round's thinking as it streams: `ms` is measured here until the text moves on (the saved reply carries its own). */
export type LiveThinking = ThinkingSegment & { startedAt: number }

/** One delta from the reply loop: text, or thinking with the round it belongs to. */
export type Piece = { content: string } | { thinking: string; round: { at: number; index: number } }

/** The live segment, if the last one is still open, ended at `now`. */
export function endLiveThinking(segments: LiveThinking[], now: number): LiveThinking[] {
  const last = segments[segments.length - 1]
  if (!last || last.ms !== null) return segments
  return [...segments.slice(0, -1), { ...last, ms: now - last.startedAt }]
}

/** The stream's thinking segments after a delta: thinking joins its round's segment or starts one; text ends the live one. */
export function applyPiece(segments: LiveThinking[], piece: Piece, now: number): LiveThinking[] {
  if ('content' in piece) return piece.content ? endLiveThinking(segments, now) : segments
  const last = segments[segments.length - 1]
  const { round } = piece
  if (last && last.at === round.at && last.index === round.index && last.ms === null)
    return [...segments.slice(0, -1), { ...last, text: last.text + piece.thinking }]
  return [...segments, { text: piece.thinking, at: round.at, index: round.index, ms: null, startedAt: now }]
}
