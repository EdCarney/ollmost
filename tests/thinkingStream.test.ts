import { describe, expect, it } from 'vitest'
import { applyPiece, endLiveThinking, type LiveThinking } from '../src/shared/thinkingStream'

const seg = (text: string, at: number, index: number, ms: number | null, startedAt = 1000): LiveThinking => ({
  text,
  at,
  index,
  ms,
  startedAt
})

describe('a stream’s thinking segments', () => {
  it('starts a segment for a round’s first thinking, and appends the rest of that round to it', () => {
    let s = applyPiece([], { thinking: 'Plan', round: { at: 0, index: 0 } }, 1000)
    expect(s).toEqual([seg('Plan', 0, 0, null)])
    s = applyPiece(s, { thinking: ' more', round: { at: 0, index: 0 } }, 1200)
    expect(s).toEqual([seg('Plan more', 0, 0, null)])
  })

  it('ends the live segment when text follows, measuring how long the thinking took', () => {
    const s = applyPiece([seg('Plan', 0, 0, null)], { content: 'Let me' }, 1500)
    expect(s).toEqual([seg('Plan', 0, 0, 500)])
    // Text with nothing live, or empty text, changes nothing.
    expect(applyPiece(s, { content: ' check' }, 2000)).toBe(s)
    expect(applyPiece([seg('Plan', 0, 0, null)], { content: '' }, 2000)).toEqual([seg('Plan', 0, 0, null)])
  })

  it('starts a new segment for the next round, even before the earlier one ended', () => {
    const s = applyPiece([seg('Plan', 0, 0, null)], { thinking: 'Got it', round: { at: 13, index: 1 } }, 3000)
    expect(s).toEqual([seg('Plan', 0, 0, null), seg('Got it', 13, 1, null, 3000)])
  })

  it('ends the live segment when a call is made, whether or not any text followed', () => {
    expect(endLiveThinking([seg('Plan', 0, 0, null)], 1800)).toEqual([seg('Plan', 0, 0, 800)])
    const ended = [seg('Plan', 0, 0, 800)]
    expect(endLiveThinking(ended, 5000)).toBe(ended)
    expect(endLiveThinking([], 5000)).toEqual([])
  })
})
