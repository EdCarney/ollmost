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
