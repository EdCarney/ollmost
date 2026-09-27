import type { ComposerSubmit } from '@/components/Composer'
import { reportError, useApp } from '@/stores/app'
import { useChat } from '@/stores/chat'
import type { Message } from '@shared/types'
import { api } from './api'

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
  try {
    const result = await api.chat.regenerate(conversationId, { model: conversation.model, think: conversation.think })
    useChat.getState().began(result, { replaceFrom: messages[lastUser + 1]?.id })
  } catch (err) {
    reportError(err)
  }
}

export async function editMessage(message: Message, content: string, messages: Message[]): Promise<void> {
  const { conversation } = useChat.getState()
  if (!conversation?.model) return
  const idx = messages.findIndex((m) => m.id === message.id)
  try {
    const result = await api.chat.edit(message.id, content, { model: conversation.model, think: conversation.think })
    useChat.getState().began(result, { replaceFrom: messages[idx + 1]?.id })
  } catch (err) {
    reportError(err)
  }
}

/** A slash command sent from a chat's composer: it runs once, and never becomes a message. */
export async function runCommand(conversationId: string, cmd: { name: string; args: string; model: string }): Promise<boolean> {
  try {
    switch (cmd.name) {
      case 'compact': {
        const conversation = await api.chat.compact(conversationId, { focus: cmd.args, model: cmd.model })
        useChat.getState().setConversation(conversation)
        const c = conversation.compaction
        if (c) useApp.getState().toast(`Compacted ${c.messages} ${c.messages === 1 ? 'message' : 'messages'} into a summary.`)
        return true
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
