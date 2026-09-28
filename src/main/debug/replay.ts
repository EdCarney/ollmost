import { stripImagePlaceholders } from '@shared/debug'
import type { TraceDetail } from '@shared/types'
import { insertUsageEvent } from '../db/usage'
import { resolve } from '../providers/registry'
import { requestCost } from '../usage/pricing'
import { errorMessage } from '../util'
import { startTrace } from './traces'

type Recorded = { model: string; messages: unknown[] }

/**
 * Re-send a (possibly edited) recorded request, non-streaming, to its model's server, in that server's own shape.
 * Nothing is added to the chat; the call is recorded as a 'replay' trace and counted as usage.
 */
export async function replayRequest(conversationId: string | null, raw: unknown): Promise<TraceDetail> {
  const recorded = raw as Partial<Recorded> | null
  if (!recorded || typeof recorded !== 'object' || typeof recorded.model !== 'string' || !Array.isArray(recorded.messages))
    throw new Error('A replay needs a JSON object with a "model" string and a "messages" array.')
  const { body } = stripImagePlaceholders(recorded as Recorded)
  const request = { ...body, stream: false }
  const { provider } = resolve(request.model)
  const trace = startTrace({
    kind: 'replay',
    conversationId,
    messageId: null,
    model: request.model,
    endpoint: provider.wireEndpoint(),
    request,
    summary: 'Replay…'
  })
  try {
    const res = await provider.sendWire(request, { timeoutMs: 10 * 60_000 })
    trace.firstByte()
    const promptTokens = res.usage.prompt ?? 0
    const completionTokens = res.usage.completion ?? 0
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
      response: {
        content: res.content,
        thinking: res.thinking || undefined,
        toolCalls: res.toolCalls.length ? res.toolCalls : undefined,
        final: res.raw
      },
      promptTokens,
      completionTokens,
      costUsd,
      summary: `Replay: ${res.content.trim() || (res.toolCalls.length ? 'tool call' : '(empty)')}`,
      timing: res.timing
    })
  } catch (err) {
    const error = errorMessage(err)
    trace.finish({ status: 'error', response: { error }, summary: `Replay failed: ${error}` })
    throw err
  }
}
