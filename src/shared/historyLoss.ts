import { parseMessage, type Segment } from './artifactParser'
import type { Message } from './types'

const isArtifact = (s: Segment): s is Extract<Segment, { kind: 'artifact' }> => s.kind === 'artifact' && !!s.content.trim()

/** The identifiers a message's own reply gave a version to, the same way `saveArtifacts` (main/chat/service.ts)
 *  reads them off a saved message to record its artifact versions. */
const artifactIdentifiers = (content: string): string[] =>
  parseMessage(content)
    .filter(isArtifact)
    .map((s) => s.identifier)

const FILE_EDIT_TOOLS = new Set(['edit_file', 'write_file'])

export interface HistoryLoss {
  laterMessages: number
  clearsSummary: boolean
  /**
   * Whether a deleted reply gave a version to an artifact that has no other occurrence earlier in the chat (an
   * artifact with an earlier occurrence keeps that version, per `pruneEmptyArtifacts`, so it isn't counted here).
   * A code block promoted to an artifact by hand, rather than written by the model as an `<artifact>` block, can't
   * be seen this way, so this errs toward true rather than claim certainty it doesn't have.
   */
  artifactsMayBeDeleted: boolean
  /** Whether a deleted reply edited or wrote a file; those changes are on disk, not undone by losing the reply. */
  fileEditsMade: boolean
}

/**
 * What redoing the exchange at `messages[index]` (a user message being edited, or the last one for a Retry) would
 * throw away: the messages after that exchange's own reply, and whether the chat's /compact summary covers the
 * message being redone (it would be cleared, see `uncompactFrom` in the main process). A message with no reply yet
 * loses nothing later, and a failed reply still counts as the exchange being redone, not as later history.
 *
 * The exchange's own reply is deleted regardless of `laterMessages` (that's the point of an edit or a retry), so
 * artifacts and file edits are checked over it too, not just over what follows it.
 */
export function historyLoss(messages: Message[], index: number, compaction: { upTo: number } | null): HistoryLoss {
  const message = messages[index]
  const reply = messages[index + 1]
  const deleted = reply ? messages.slice(index + 1) : []
  const survivingIdentifiers = new Set(
    messages
      .slice(0, index + 1)
      .filter((m) => m.role === 'assistant')
      .flatMap((m) => artifactIdentifiers(m.content))
  )
  return {
    laterMessages: reply ? messages.length - index - 2 : 0,
    clearsSummary: !!compaction && !!message && message.createdAt <= compaction.upTo,
    artifactsMayBeDeleted: deleted.some(
      (m) => m.role === 'assistant' && artifactIdentifiers(m.content).some((id) => !survivingIdentifiers.has(id))
    ),
    fileEditsMade: deleted.some((m) => m.toolEvents.some((e) => FILE_EDIT_TOOLS.has(e.tool)))
  }
}
