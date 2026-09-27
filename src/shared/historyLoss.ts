import type { Message } from './types'

/**
 * What redoing the exchange at `messages[index]` (a user message being edited, or the last one for a Retry) would
 * throw away: the messages after that exchange's own reply, and whether the chat's /compact summary covers the
 * message being redone (it would be cleared, see `uncompactFrom` in the main process). A message with no reply yet
 * loses nothing later, and a failed reply still counts as the exchange being redone, not as later history.
 */
export function historyLoss(
  messages: Message[],
  index: number,
  compaction: { upTo: number } | null
): { laterMessages: number; clearsSummary: boolean } {
  const message = messages[index]
  const reply = messages[index + 1]
  return {
    laterMessages: reply ? messages.length - index - 2 : 0,
    clearsSummary: !!compaction && !!message && message.createdAt <= compaction.upTo
  }
}
