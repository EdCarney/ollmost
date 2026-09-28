import { stripImagePlaceholders, traceTarget } from '@shared/debug'
import { toModelKey } from '@shared/modelKey'
import type { ModelInfo, TraceDetail } from '@shared/types'
import { insertUsageEvent } from '../db/usage'
import { EndpointGoneError, modelInfo, resolve } from '../providers/registry'
import { requestCost } from '../usage/pricing'
import { errorMessage } from '../util'
import { startTrace } from './traces'

interface ReplayBody extends Record<string, unknown> {
  model: string
  messages: unknown[]
}

/** The response's stats without the reply itself, which the trace shows on its own. */
function statsOf(raw: unknown): unknown {
  if (!raw || typeof raw !== 'object') return raw
  const { message: _message, choices, ...rest } = raw as Record<string, unknown>
  const finish = Array.isArray(choices) ? (choices[0] as { finish_reason?: unknown } | undefined)?.finish_reason : undefined
  return finish === undefined ? rest : { ...rest, finish_reason: finish }
}

/** Billing for the replayed model, else the trace's own (an edited name may not exist); untracked when neither reads. */
async function billingFor(keys: string[]): Promise<Pick<ModelInfo, 'billing' | 'price'>> {
  for (const key of new Set(keys)) {
    try {
      return await modelInfo(key)
    } catch {
      // Try the next.
    }
  }
  return { billing: 'untracked', price: null }
}

/**
 * Re-send a (possibly edited) recorded request, non-streaming, to the endpoint the trace went to. `model` is the trace's
 * model key, which names that endpoint; the body's own `model` (maybe edited) is what the endpoint is asked for.
 * `endpointName` is the endpoint's name when the trace was recorded, for the message if it has since been removed.
 * Nothing is added to the chat; the call is recorded as a 'replay' trace and counted as usage.
 */
export async function replayRequest(
  conversationId: string | null,
  model: string | null,
  raw: unknown,
  endpointName?: string | null
): Promise<TraceDetail> {
  if (!raw || typeof raw !== 'object' || typeof (raw as ReplayBody).model !== 'string' || !Array.isArray((raw as ReplayBody).messages))
    throw new Error('A replay needs a JSON object with a "model" string and a "messages" array.')
  // One request, not a stream: a streamed round's body carries stream, and stream_options, which only a stream allows.
  const { stream: _stream, stream_options: _options, ...edited } = stripImagePlaceholders(raw as ReplayBody).body
  const request = { ...edited, stream: false }
  let target: ReturnType<typeof resolve>
  try {
    // A trace with no model key resolves by its body's name, the way any leftover name does.
    target = resolve(model ?? request.model)
  } catch (err) {
    if (err instanceof EndpointGoneError)
      throw new Error(`This trace's endpoint (${endpointName || err.endpointId}) no longer exists.`, { cause: err })
    throw err
  }
  const { provider, endpoint } = target
  const key = toModelKey(endpoint.id, request.model)
  const trace = startTrace({
    kind: 'replay',
    conversationId,
    messageId: null,
    model: key,
    // Where the provider posts its bodies, as a round's trace records it.
    endpoint: provider.wireEndpoint(),
    request,
    summary: 'Replay…',
    ...traceTarget(endpoint)
  })
  try {
    const res = await provider.sendWire(request, { timeoutMs: 10 * 60_000 })
    trace.firstByte()
    const promptTokens = res.usage.prompt ?? 0
    const completionTokens = res.usage.completion ?? 0
    const info = await billingFor([key, model ?? key])
    const costUsd = requestCost(info, promptTokens, completionTokens)
    insertUsageEvent({
      conversationId,
      messageId: null,
      model: key,
      kind: 'replay',
      billing: info.billing,
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
        final: statsOf(res.raw)
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
