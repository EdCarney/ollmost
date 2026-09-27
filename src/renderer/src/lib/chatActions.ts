import type { ComposerSubmit } from '@/components/Composer'
import { reportError, useApp } from '@/stores/app'
import { useChat } from '@/stores/chat'
import { useConfirm } from '@/stores/confirm'
import { historyLoss, type HistoryLoss } from '@shared/historyLoss'
import type { Message } from '@shared/types'
import { api } from './api'

/** Ask before an Edit or a Retry that would lose history; resolves true when nothing would be lost or the user
 *  chose to go ahead. See historyLoss for what counts as a loss. */
async function confirmHistoryLoss(kind: 'edit' | 'retry', loss: HistoryLoss): Promise<boolean> {
  const { laterMessages, clearsSummary, artifactsMayBeDeleted, fileEditsMade } = loss
  if (!laterMessages && !clearsSummary && !artifactsMayBeDeleted && !fileEditsMade) return true
  const verb = kind === 'edit' ? 'Edit' : 'Retry'
  const body: string[] = []
  // The exchange's own reply always goes too (that's the point of an edit or a retry), so the count says so.
  if (laterMessages)
    body.push(`Its reply and the ${laterMessages} ${laterMessages === 1 ? 'message' : 'messages'} after it will be deleted.`)
  if (clearsSummary)
    body.push(
      "The chat's summary covers this message, so it will be cleared. Later replies will send the full history again until you run /compact."
    )
  if (artifactsMayBeDeleted) body.push('Artifacts made in those replies may be deleted too.')
  if (fileEditsMade) body.push('Changes those replies made to files in the folder stay as they are.')
  // Named labels only for the two single-cause cases the wording above spells out; anything else, including a
  // combination, gets the neutral "Continue" rather than a label that would only tell part of the story.
  const reasons = [laterMessages > 0, clearsSummary, artifactsMayBeDeleted, fileEditsMade].filter(Boolean).length
  const confirmLabel =
    reasons > 1 ? 'Continue' : laterMessages ? `${verb} and delete` : clearsSummary ? `${verb} and clear summary` : 'Continue'
  return useConfirm.getState().ask({ title: kind === 'edit' ? 'Edit this message?' : 'Retry this reply?', body, confirmLabel })
}

export async function sendMessage(conversationId: string | null, projectId: string | null, input: ComposerSubmit): Promise<boolean> {
  try {
    const result = await api.chat.send({ conversationId, projectId, ...input })
    useChat.getState().began(result, {})
    if (!conversationId) useApp.getState().navigate({ name: 'chat', id: result.conversation.id })
    if (projectId) void useApp.getState().loadProjects()
    return true
  } catch (err) {
    reportError(err)
    return false
  }
}

/** Why a reply stopped short: it hit the model's length limit, or used up its tool rounds. */
export type ContinueReason = 'length' | 'rounds'

export const CONTINUE_PROMPTS: Record<ContinueReason, string> = {
  length: 'Your last reply was cut off. Continue exactly where it stopped, without repeating what you already wrote.',
  rounds: 'Your last reply ran out of tool calls before you had finished. Carry on from where you got to, using tools again as needed.'
}

/** Ask the model to pick up a reply that stopped short, as a normal follow-up in the chat. */
export async function continueReply(conversationId: string, reason: ContinueReason = 'length'): Promise<void> {
  const { conversation } = useChat.getState()
  if (!conversation?.model || conversation.id !== conversationId) return
  await sendMessage(conversationId, conversation.projectId, {
    content: CONTINUE_PROMPTS[reason],
    attachmentIds: [],
    model: conversation.model,
    think: conversation.think,
    skills: conversation.skills,
    toolSources: conversation.toolSources
  })
}

export async function retryLast(conversationId: string, messages: Message[]): Promise<void> {
  const { conversation } = useChat.getState()
  if (!conversation?.model) return
  const lastUser = messages.findLastIndex((m) => m.role === 'user')
  if (lastUser < 0) return
  if (!(await confirmHistoryLoss('retry', historyLoss(messages, lastUser, conversation.compaction)))) return
  // The confirm can sit on screen long enough for ⌘K or a menu accelerator to move to another chat; regenerating
  // this one once back is still fine, but must not land on whatever chat is open now (stores/chat.ts's open()
  // also answers false to a confirm still waiting on this chat, so this is mostly a belt-and-braces check).
  if (useChat.getState().conversation?.id !== conversationId) return
  try {
    const result = await api.chat.regenerate(conversationId, { model: conversation.model, think: conversation.think })
    useChat.getState().began(result, { replaceFrom: messages[lastUser + 1]?.id })
  } catch (err) {
    reportError(err)
  }
}

/** Edits and resends a message; returns false unless it actually went through, so the edit box can stay open with
 *  the draft on a cancelled confirm, a stale chat switched away from, or an api failure (which still toasts). */
export async function editMessage(message: Message, content: string, messages: Message[]): Promise<boolean> {
  const { conversation } = useChat.getState()
  if (!conversation?.model) return false
  const idx = messages.findIndex((m) => m.id === message.id)
  if (!(await confirmHistoryLoss('edit', historyLoss(messages, idx, conversation.compaction)))) return false
  if (useChat.getState().conversation?.id !== message.conversationId) return false
  try {
    const result = await api.chat.edit(message.id, content, { model: conversation.model, think: conversation.think })
    useChat.getState().began(result, { replaceFrom: messages[idx + 1]?.id })
    return true
  } catch (err) {
    reportError(err)
    return false
  }
}

/** A slash command sent from a chat's composer: it runs once, and never becomes a message. */
export async function runCommand(conversationId: string, cmd: { name: string; args: string; model: string }): Promise<boolean> {
  try {
    switch (cmd.name) {
      case 'compact': {
        const before = useChat.getState().messages
        // A second /compact only newly covers what came after the earlier summary; its own messages already lost
        // their attachments last time, so they don't belong in this run's notice.
        const previousUpTo = useChat.getState().conversation?.compaction?.upTo ?? null
        useChat.getState().setCompacting(conversationId, true)
        try {
          const conversation = await api.chat.compact(conversationId, { focus: cmd.args, model: cmd.model })
          useChat.getState().setConversation(conversation)
          const c = conversation.compaction
          if (c) {
            const lostAttachments = before.some(
              (m) => m.attachments.length > 0 && m.createdAt <= c.upTo && (previousUpTo === null || m.createdAt > previousUpTo)
            )
            const notice = lostAttachments ? " Files attached to them won't be sent to the model any more." : ''
            useApp.getState().toast(`Compacted ${c.messages} ${c.messages === 1 ? 'message' : 'messages'} into a summary.${notice}`)
          }
          return true
        } finally {
          useChat.getState().setCompacting(conversationId, false)
        }
      }
      default:
        // A command listed without a handler is a bug, not a silent no-op.
        throw new Error(`/${cmd.name} isn't wired up yet.`)
    }
  } catch (err) {
    reportError(err)
    return false
  }
}

/** A code session's stage (plan or work), kept on the chat; starting work keeps the model's last reply as the plan. */
export async function setStage(conversationId: string, stage: 'plan' | 'work'): Promise<boolean> {
  try {
    useChat.getState().setConversation(await api.conversations.update(conversationId, { stage }))
    return true
  } catch (err) {
    reportError(err)
    return false
  }
}

/** Approve the plan: start work and ask the model to carry it out, as a normal follow-up in the session. */
export async function approvePlan(conversationId: string): Promise<void> {
  if (!(await setStage(conversationId, 'work'))) return
  const { conversation } = useChat.getState()
  if (!conversation?.model || conversation.id !== conversationId) return
  await sendMessage(conversationId, null, {
    content: 'Carry out the plan above.',
    attachmentIds: [],
    model: conversation.model,
    think: conversation.think,
    skills: conversation.skills,
    toolSources: conversation.toolSources
  })
}
