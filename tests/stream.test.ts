import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createStallTimer, idleMsFor, STREAM_TIMEOUTS } from '../src/main/providers/stream'

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

describe('idleMsFor', () => {
  const tool = (name: string) => ({ function: { name } })
  it('gives the long allowance only where a tool may write long arguments', () => {
    expect(idleMsFor(undefined, STREAM_TIMEOUTS)).toBe(STREAM_TIMEOUTS.idleMs)
    expect(idleMsFor([], STREAM_TIMEOUTS)).toBe(STREAM_TIMEOUTS.idleMs)
    expect(idleMsFor([tool('web_search')], STREAM_TIMEOUTS)).toBe(STREAM_TIMEOUTS.toolIdleMs)
    // The question tool's arguments are short: a chat offering only it stalls as quickly as one with no tools.
    expect(idleMsFor([tool('ask_user')], STREAM_TIMEOUTS)).toBe(STREAM_TIMEOUTS.idleMs)
    expect(idleMsFor([tool('ask_user'), tool('write_file')], STREAM_TIMEOUTS)).toBe(STREAM_TIMEOUTS.toolIdleMs)
  })
})
