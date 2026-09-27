import { withChildEvents } from './toolEvents'
import type { Artifact, Message } from './types'

const FILE_EDIT_TOOLS = new Set(['edit_file', 'write_file'])

export interface HistoryLoss {
  laterMessages: number
  clearsSummary: boolean
  /** Artifacts that would be lost outright: every version they have came from a message this would delete (an
   *  artifact with a version from an earlier, surviving message just reverts to it, per `pruneEmptyArtifacts`). */
  lostArtifacts: Artifact[]
  /** A deleted reply (or a sub-agent inside it) ran an `edit_file` or `write_file` call; those changes are on disk,
   *  not undone by losing it. */
  fileEditsMade: boolean
}

/**
 * What redoing the exchange at `messages[index]` (a user message being edited, or the last one for a Retry) would
 * throw away: the messages after that exchange's own reply, and whether the chat's /compact summary covers the
 * message being redone (it would be cleared, see `uncompactFrom` in the main process). A message with no reply yet
 * loses nothing later, and a failed reply still counts as the exchange being redone, not as later history.
 *
 * `artifacts` is the chat's own artifacts (their `versions[].messageId` says which message made each version), so
 * an edit or a retry that only replaces its own reply's text can still be told it would also cost an artifact or a
 * file edit that reply made — `historyLossNotice` decides whether that's worth mentioning.
 */
export function historyLoss(messages: Message[], index: number, compaction: { upTo: number } | null, artifacts: Artifact[]): HistoryLoss {
  const message = messages[index]
  const reply = messages[index + 1]
  const deleted = reply ? messages.slice(index + 1) : []
  const deletedIds = new Set(deleted.map((m) => m.id))
  return {
    laterMessages: reply ? messages.length - index - 2 : 0,
    clearsSummary: !!compaction && !!message && message.createdAt <= compaction.upTo,
    lostArtifacts: artifacts.filter(
      (a) => a.versions.length > 0 && a.versions.every((v) => v.messageId !== null && deletedIds.has(v.messageId))
    ),
    fileEditsMade: deleted.some((m) => withChildEvents(m.toolEvents).some((e) => FILE_EDIT_TOOLS.has(e.tool) && e.ok && !e.declined))
  }
}

const quote = (title: string): string => `“${title}”`

/** One line naming the artifacts a loss would take, in the wording the dialog uses for 1, 2–3, or more. */
function artifactsLine(lost: Artifact[]): string {
  if (lost.length === 1) return `The artifact ${quote(lost[0].title)} will be deleted too.`
  if (lost.length <= 3) {
    const titles = lost.map((a) => quote(a.title))
    return `The artifacts ${titles.slice(0, -1).join(', ')} and ${titles[titles.length - 1]} will be deleted too.`
  }
  return `${lost.length} artifacts made in those replies will be deleted too.`
}

export interface HistoryLossNotice {
  title: string
  /** One line per thing that would be lost. */
  lines: string[]
  /** The destructive button's label; Cancel is always the other one. */
  confirmLabel: string
}

/**
 * Whether an Edit or a Retry should ask first, and what to say: only when it would drop messages after the
 * exchange's own reply, or clear the /compact summary — replacing that reply's own text is the point of an edit or
 * a retry, so an artifact or a file edit made only by that reply doesn't ask on its own (they're named alongside
 * the later messages when there are some, since "those replies" then reads as the reply plus what followed it).
 */
export function historyLossNotice(kind: 'edit' | 'retry', loss: HistoryLoss): HistoryLossNotice | null {
  const { laterMessages, clearsSummary, lostArtifacts, fileEditsMade } = loss
  if (!laterMessages && !clearsSummary) return null
  const verb = kind === 'edit' ? 'Edit' : 'Retry'
  const lines: string[] = []
  if (laterMessages) {
    lines.push(`Its reply and the ${laterMessages} ${laterMessages === 1 ? 'message' : 'messages'} after it will be deleted.`)
    if (lostArtifacts.length) lines.push(artifactsLine(lostArtifacts))
    if (fileEditsMade) lines.push('Changes those replies made to files in the folder stay as they are.')
  }
  if (clearsSummary)
    lines.push(
      "The chat's summary covers this message, so it will be cleared. Later replies will send the full history again until you run /compact."
    )
  const confirmLabel = laterMessages && clearsSummary ? 'Continue' : laterMessages ? `${verb} and delete` : `${verb} and clear summary`
  return { title: kind === 'edit' ? 'Edit this message?' : 'Retry this reply?', lines, confirmLabel }
}
