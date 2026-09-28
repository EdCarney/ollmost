// What both wires share for a streamed reply: how long it may go quiet, and the timer that gives up on it.

export interface StreamTimeouts {
  /** Until the first byte of the reply: covers loading a cold local model and reading a long prompt. */
  firstByteMs: number
  /** Between chunks once the reply has started. */
  idleMs: number
  /**
   * Between chunks when the request offers tools. Ollama holds back a tool call until its arguments are
   * complete, so a slow local model writing a long argument can go quiet for many minutes while healthy.
   */
  toolIdleMs: number
}

// Generous on purpose: these catch a dead connection, not a slow model.
export const STREAM_TIMEOUTS: StreamTimeouts = { firstByteMs: 10 * 60_000, idleMs: 3 * 60_000, toolIdleMs: 30 * 60_000 }

export interface StallTimer {
  /** (Re)start the countdown: after `ms` of silence `abort` runs, and `stalled()` then returns `message`. */
  arm(ms: number, message: string): void
  /** Why the stream was given up on, or null while it hasn't been. */
  stalled(): string | null
  clear(): void
}

/**
 * Armed for the first byte and again on every chunk. When it fires it aborts the request; the reader then throws
 * `stalled()`'s message instead of the abort, so only the user's Stop surfaces as an AbortError.
 */
export function createStallTimer(abort: () => void): StallTimer {
  let stalled: string | null = null
  let timer: ReturnType<typeof setTimeout> | undefined
  return {
    arm(ms, message) {
      clearTimeout(timer)
      timer = setTimeout(() => {
        stalled = message
        abort()
      }, ms)
    },
    stalled: () => stalled,
    clear: () => clearTimeout(timer)
  }
}
