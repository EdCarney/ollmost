import { describe, expect, it } from 'vitest'
import { afterLiveToggle, CLOSED_THINKING_KEPT } from '../src/shared/thinkingPanes'

describe('which chats keep live thinking closed', () => {
  it('closing live thinking keeps it closed in that chat only', () => {
    expect(afterLiveToggle(['a'], 'b', false)).toEqual(['a', 'b'])
  })

  it('opening live thinking lets it open by itself again', () => {
    expect(afterLiveToggle(['a', 'b'], 'a', true)).toEqual(['b'])
    expect(afterLiveToggle(['b'], 'a', true)).toEqual(['b'])
  })

  it('closing it again counts as the newest choice, once', () => {
    expect(afterLiveToggle(['a', 'b'], 'a', false)).toEqual(['b', 'a'])
  })

  it('forgets the oldest choices past the limit', () => {
    const full = Array.from({ length: CLOSED_THINKING_KEPT }, (_, i) => `c${i}`)
    const next = afterLiveToggle(full, 'new', false)
    expect(next).toHaveLength(CLOSED_THINKING_KEPT)
    expect(next[0]).toBe('c1')
    expect(next.at(-1)).toBe('new')
  })
})
