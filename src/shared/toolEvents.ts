import type { ToolEvent } from './types'

/** What a sub-agent's traces and approvals are keyed by: its parent's message and the delegate call's index there. */
export const childId = (messageId: string, index: number): string => `${messageId}#${index}`

/**
 * A reply's tool calls with its sub-agents' own calls in place: each event, then the calls its sub-agent made (for
 * whatever reads a reply's calls for what they did, such as the files they edited). A live reply's list can have gaps
 * where a call hasn't been reported yet; those are left out.
 */
export function withChildEvents(events: ReadonlyArray<ToolEvent | undefined>): ToolEvent[] {
  return events.flatMap((e) => (e ? [e, ...withChildEvents(e.child?.events ?? [])] : []))
}

/**
 * Whether a reply's calls have all come to a halt on you: one waits for your answer and none still runs (one waiting
 * its turn behind the ones asking isn't running). The reply is paused then, not working; while any call still runs (a
 * sub-agent beside the one asking), it is still working (#177).
 */
export function pausedOnYou(events: ReadonlyArray<ToolEvent | undefined>): boolean {
  return events.some((e) => e?.awaiting) && !events.some((e) => e?.pending && !e.awaiting && !e.queued)
}
