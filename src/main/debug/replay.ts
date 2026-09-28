import { stripImagePlaceholders } from '@shared/debug'
import type { TraceDetail } from '@shared/types'
import { insertUsageEvent } from '../db/usage'
import { type ChatBody, chatOnce, endpointFor } from '../providers/ollama/wire'
import { requestCost } from '../usage/pricing'
import { errorMessage } from '../util'
import { startTrace } from './traces'

/**
 * Re-send a (possibly edited) recorded request, non-streaming, to the configured Ollama target.
 * Nothing is added to the chat; the call is recorded as a 'replay' trace and counted as usage.
 */
export async function replayRequest(conversationId: string | null, raw: unknown): Promise<TraceDetail> {
  if (!raw || typeof raw !== 'object' || typeof (raw as ChatBody).model !== 'string' || !Array.isArray((raw as ChatBody).messages))
    throw new Error('A replay needs a JSON object with a "model" string and a "messages" array.')
  const { body } = stripImagePlaceholders(raw as ChatBody)
  const request = { ...body, stream: false } as ChatBody & { stream: false }
  const trace = startTrace({
    kind: 'replay',
    conversationId,
    messageId: null,
    model: request.model,
    endpoint: endpointFor('/api/chat'),
    request,
    summary: 'Replay…'
  })
  try {
    const res = await chatOnce(request, { timeoutMs: 10 * 60_000 })
    trace.firstByte()
    const { message, ...final } = res
    const promptTokens = res.prompt_eval_count ?? 0
    const completionTokens = res.eval_count ?? 0
    const costUsd = requestCost(request.model, promptTokens, completionTokens)
    insertUsageEvent({
      conversationId,
      messageId: null,
      model: request.model,
      kind: 'replay',
      promptTokens,
      completionTokens,
      costUsd,
      estimated: false
    })
    return trace.finish({
      status: 'ok',
      response: { content: message?.content, thinking: message?.thinking, toolCalls: message?.tool_calls, final },
      promptTokens,
      completionTokens,
      costUsd,
      summary: `Replay: ${message?.content?.trim() || (message?.tool_calls?.length ? 'tool call' : '(empty)')}`,
      ollama: res
    })
  } catch (err) {
    const error = errorMessage(err)
    trace.finish({ status: 'error', response: { error }, summary: `Replay failed: ${error}` })
    throw err
  }
}
