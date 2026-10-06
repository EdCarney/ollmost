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

/**
 * The stream's thinking segments after a delta: thinking joins its round's segment or starts one; text ends the live
 * one. Thinking that resumes after text in the same round reopens the round's segment, where it was, as the saved
 * reply keeps one segment per round (#151): a new card at the round's start would jump above the text that came
 * between, and vanish into the first card as the reply ended.
 */
export function applyPiece(segments: LiveThinking[], piece: Piece, now: number): LiveThinking[] {
  if ('content' in piece) return piece.content ? endLiveThinking(segments, now) : segments
  const last = segments[segments.length - 1]
  const { round } = piece
  if (last && last.at === round.at && last.index === round.index)
    return [...segments.slice(0, -1), { ...last, text: last.text + piece.thinking, ms: null }]
  // A new round's thinking ends the earlier one if nothing else did: only one card is ever live.
  return [...endLiveThinking(segments, now), { text: piece.thinking, at: round.at, index: round.index, ms: null, startedAt: now }]
}
