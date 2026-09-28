import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createStallTimer, STREAM_TIMEOUTS } from '../src/main/providers/stream'

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('createStallTimer', () => {
  it('aborts with its message once the stream has been quiet too long', () => {
    const abort = vi.fn()
    const stall = createStallTimer(abort)
    stall.arm(1_000, 'quiet')
    vi.advanceTimersByTime(999)
    expect(abort).not.toHaveBeenCalled()
    expect(stall.stalled()).toBeNull()
    vi.advanceTimersByTime(1)
    expect(abort).toHaveBeenCalledOnce()
    expect(stall.stalled()).toBe('quiet')
  })

  it('starts again on every chunk, with the latest message', () => {
    const abort = vi.fn()
    const stall = createStallTimer(abort)
    stall.arm(1_000, 'no first byte')
    vi.advanceTimersByTime(900)
    stall.arm(500, 'went quiet')
    vi.advanceTimersByTime(499)
    expect(abort).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(stall.stalled()).toBe('went quiet')
  })

  it('never fires once cleared', () => {
    const abort = vi.fn()
    const stall = createStallTimer(abort)
    stall.arm(100, 'quiet')
    stall.clear()
    vi.advanceTimersByTime(1_000)
    expect(abort).not.toHaveBeenCalled()
    expect(stall.stalled()).toBeNull()
  })

  it('keeps the long quiet allowance for tool calls', () => {
    expect(STREAM_TIMEOUTS.toolIdleMs).toBeGreaterThan(STREAM_TIMEOUTS.idleMs)
  })
})
