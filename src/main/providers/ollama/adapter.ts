import { toOllamaThink } from '@shared/thinking'
import type { ModelInfo } from '@shared/types'
import type {
  ChatEvent,
  ChatImage,
  ChatMessage,
  ChatRequest,
  ChatResult,
  ChatTiming,
  IdentifiedToolCall,
  Provider,
  ToolCall,
  WireRequest
} from '../types'
import { getModelInfo, listModels as listOllamaModels } from './models'
import {
  type ChatBody,
  type ChatChunk,
  chatOnce as postChat,
  chatStream as streamChat,
  connectionMode,
  endpointFor,
  isCloudName,
  OllamaError,
  type OllamaMessage,
  type OllamaToolCall,
  type StreamTimeouts,
  streamTimeoutsFor
} from './wire'

// Ollama's side of the seam: neutral requests become /api/chat bodies, NDJSON chunks become neutral events. A body is
// byte for byte what Ollmost sent before the seam existed (tests/ollamaAdapter.test.ts holds it to that).

/** Where a model runs, by the one rule: everything through ollama.com, and `-cloud` names through the app. */
const runsInCloud = (model: string): boolean => connectionMode() === 'direct' || isCloudName(model)

/**
 * The long tool-call allowance is only for models on this Mac: Ollama holds a call back until its arguments are
 * complete, and a slow local model can be quiet for minutes. A cloud model that goes quiet has dropped.
 */
export function ollamaTimeouts(model: string): StreamTimeouts {
  return streamTimeoutsFor(runsInCloud(model) ? 'cloud' : 'local')
}

// Each call Ollama sent, by the neutral call made from it. The next round echoes a call back exactly as Ollama sent it,
// its own id and index included. A call assemble() rebuilt from history has no entry and goes back without the id
// Ollmost gave it.
const sentByOllama = new WeakMap<ToolCall, OllamaToolCall>()

function identify(raw: OllamaToolCall, n: number): IdentifiedToolCall {
  // An id of Ollmost's own is 9 letters and digits ("t" and the call's place in base 36): Mistral's chat templates on
  // vLLM refuse any other shape, and the loop's calls may reach such a server later in the chat.
  const call = { id: raw.id ?? `t${n.toString(36).padStart(8, '0')}`, function: raw.function }
  sentByOllama.set(call, raw)
  return call
}

/** One message in Ollama's shape, key by key in the order it was built (JSON keeps that order). */
export function toOllamaMessage(m: ChatMessage): OllamaMessage {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(m)) {
    if (value === undefined) continue
    if (key === 'images') out.images = (value as ChatImage[]).map((image) => image.data)
    else if (key === 'toolCalls')
      out.tool_calls = (value as ToolCall[]).map((call) => sentByOllama.get(call) ?? { function: call.function })
    else if (key === 'toolName') out.tool_name = value
    // Ollama matches a result to its call by order and tool_name.
    else if (key !== 'toolCallId') out[key] = value
  }
  return out as unknown as OllamaMessage
}

/**
 * The /api/chat body for a request. A local model gets the request's window as num_ctx on every call, titles included:
 * a request with a different num_ctx makes Ollama reload the model. Cloud models manage their own context.
 */
export function toOllamaBody(req: ChatRequest): ChatBody {
  const numCtx = runsInCloud(req.model) || req.contextWindow == null ? undefined : req.contextWindow
  const options =
    req.temperature === undefined && numCtx === undefined
      ? undefined
      : { ...(req.temperature !== undefined && { temperature: req.temperature }), ...(numCtx !== undefined && { num_ctx: numCtx }) }
  return {
    model: req.model,
    messages: req.messages.map(toOllamaMessage),
    think: toOllamaThink(req.profile, req.think),
    tools: req.tools,
    options
  }
}

const nsToMs = (ns: number | undefined): number | undefined => (typeof ns === 'number' ? ns / 1e6 : undefined)
const timingOf = (c: ChatChunk): ChatTiming => ({
  loadMs: nsToMs(c.load_duration),
  promptMs: nsToMs(c.prompt_eval_duration),
  genMs: nsToMs(c.eval_duration)
})
const usageOf = (c: ChatChunk) => ({ prompt: c.prompt_eval_count, completion: c.eval_count })

/** The final chunk without the reply's text: its counts, durations and done_reason. */
function closing(c: ChatChunk): unknown {
  const { message: _message, ...rest } = c
  return rest
}

/** Ollama's NDJSON chunks as neutral events. Ollama sends each tool call whole. */
export async function* ollamaEvents(chunks: AsyncIterable<ChatChunk>): AsyncGenerator<ChatEvent> {
  let calls = 0
  for await (const chunk of chunks) {
    const m = chunk.message
    let said = false
    if (m?.thinking) {
      said = true
      yield { type: 'thinking', text: m.thinking }
    }
    if (m?.content) {
      said = true
      yield { type: 'content', text: m.content }
    }
    for (const raw of m?.tool_calls ?? []) {
      said = true
      yield { type: 'toolCall', call: identify(raw, calls++) }
    }
    if (chunk.done)
      yield { type: 'done', usage: usageOf(chunk), finishReason: chunk.done_reason, timing: timingOf(chunk), raw: closing(chunk) }
    // A chunk with nothing in it still says Ollama is there: the loop times the first byte by it.
    else if (!said) yield { type: 'content', text: '' }
  }
}

/** A /api/chat reply that came whole. */
export function resultFromOllama(res: ChatChunk): ChatResult {
  return {
    content: res.message?.content ?? '',
    thinking: res.message?.thinking ?? '',
    toolCalls: (res.message?.tool_calls ?? []).map((raw, n) => identify(raw, n)),
    usage: usageOf(res),
    finishReason: res.done_reason,
    timing: timingOf(res),
    raw: closing(res)
  }
}

/** The Ollama app, or ollama.com in direct mode: whichever Settings → Models points at. */
export class OllamaProvider implements Provider {
  readonly id = 'ollama'

  async listModels(refresh: boolean): Promise<ModelInfo[]> {
    const { models, error } = await listOllamaModels(refresh)
    // The list carries an error only when it's empty; the registry reports it in place of the models.
    if (error) throw new OllamaError(error)
    return models
  }

  modelInfo(model: string, refresh = false): Promise<ModelInfo> {
    return getModelInfo(model, refresh)
  }

  async *chatStream(req: ChatRequest, signal: AbortSignal): AsyncGenerator<ChatEvent> {
    yield* ollamaEvents(streamChat(toOllamaBody(req), signal, ollamaTimeouts(req.model)))
  }

  async chatOnce(req: ChatRequest, opts: { signal?: AbortSignal; timeoutMs: number }): Promise<ChatResult> {
    return resultFromOllama(await postChat(toOllamaBody(req), opts))
  }

  wire(req: ChatRequest, stream: boolean): WireRequest {
    return { endpoint: this.wireEndpoint(), body: { ...toOllamaBody(req), stream } }
  }

  wireEndpoint(): string {
    return endpointFor('/api/chat')
  }

  async sendWire(body: unknown, opts: { signal?: AbortSignal; timeoutMs: number }): Promise<ChatResult> {
    return resultFromOllama(await postChat(body as ChatBody, opts))
  }
}
