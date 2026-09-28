import { normalizeThinkSetting } from '@shared/thinking'
import type { EndpointFlavor, ThinkProfile, ThinkSetting } from '@shared/types'
import type { ChatImage, ChatMessage, ChatRequest, ToolCall } from '../types'
import { madeUpToolCallId } from './toolCalls'

/**
 * The content of an assistant message that only calls tools. OpenAI allows '' or null; the capture spike
 * (capture/FINDINGS.md, question 5) says which LM Studio accepts.
 */
export const EMPTY_TOOL_CALL_CONTENT: '' | null = ''

/**
 * The think setting as an OpenAI-compatible server takes it; nothing where the profile only shows reasoning.
 * LM Studio is its own case (capture/FINDINGS.md, question 1): `reasoning_effort` and OpenAI's own values are the
 * only thing that moves it there, `none` is its working "off", and `chat_template_kwargs` and the `reasoning`
 * object are accepted but silently ignored. "off"/"on" (LM Studio's own on/off vocabulary) are rejected with 400,
 * so they're never sent. "on" sends `medium`: on an on/off model every value but `none` keeps full reasoning, so it
 * costs nothing where the default reasons, and can turn reasoning on for a model whose default is off.
 */
export function openAIThink(profile: ThinkProfile, setting: ThinkSetting | null, flavor?: EndpointFlavor): Record<string, unknown> {
  const s = normalizeThinkSetting(profile, setting)
  if (flavor === 'lmstudio') {
    switch (profile.kind) {
      case 'toggle':
        return { reasoning_effort: s === 'on' ? 'medium' : 'none' }
      case 'levels':
        return s === 'off' ? { reasoning_effort: 'none' } : { reasoning_effort: s }
      default:
        return {}
    }
  }
  switch (profile.kind) {
    case 'toggle':
      return { chat_template_kwargs: { enable_thinking: s === 'on' } }
    case 'levels':
      // reasoning_effort has no "off": low is the least a server will think.
      return { reasoning_effort: s === 'off' || s === null ? 'low' : s }
    default:
      return {}
  }
}

const imagePart = (img: ChatImage) => ({ type: 'image_url', image_url: { url: `data:${img.mime};base64,${img.data}` } })

const argumentsText = (args: ToolCall['function']['arguments']): string => (typeof args === 'string' ? args : JSON.stringify(args))

function toOpenAIMessage(m: ChatMessage): Record<string, unknown> {
  switch (m.role) {
    case 'user':
      if (!m.images?.length) return { role: 'user', content: m.content }
      return { role: 'user', content: [...(m.content ? [{ type: 'text', text: m.content }] : []), ...m.images.map(imagePart)] }
    case 'assistant':
      // Earlier reasoning isn't sent back: chat templates drop it or reject it.
      if (!m.toolCalls?.length) return { role: 'assistant', content: m.content }
      return {
        role: 'assistant',
        content: m.content || EMPTY_TOOL_CALL_CONTENT,
        // assemble() and the adapters always set ids; the fallback only keeps the body valid.
        tool_calls: m.toolCalls.map((c, n) => ({
          id: c.id ?? madeUpToolCallId(n),
          type: 'function',
          function: { name: c.function.name, arguments: argumentsText(c.function.arguments) }
        }))
      }
    case 'tool':
      // assemble() and the reply loop always set toolCallId; ChatMessage keeps it optional for every other role.
      return { role: 'tool', tool_call_id: m.toolCallId ?? '', content: m.content }
    default:
      return { role: 'system', content: m.content }
  }
}

/** The body of POST {baseUrl}/chat/completions for a request (the spec's mapping table). */
export function toOpenAIBody(
  req: ChatRequest,
  opts: { stream: boolean; streamOptions: boolean; flavor?: EndpointFlavor }
): Record<string, unknown> {
  return {
    model: req.model,
    messages: req.messages.map(toOpenAIMessage),
    ...(req.tools?.length ? { tools: req.tools } : {}),
    ...openAIThink(req.profile, req.think, opts.flavor),
    ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
    stream: opts.stream,
    // Usage comes in a last chunk only when asked for. An endpoint that rejects the option is retried without it.
    ...(opts.stream && opts.streamOptions ? { stream_options: { include_usage: true } } : {})
  }
}
