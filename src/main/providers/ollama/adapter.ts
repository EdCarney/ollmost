import { isOllamaCloudUrl } from '@shared/endpoints'
import { toOllamaThink } from '@shared/thinking'
import type { Endpoint, ModelInfo, ModelWhere } from '@shared/types'
import { endpointSecretName, getSecret, OLLAMA_ACCOUNT_SECRET } from '../secrets'
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
import { getModelInfo, listOllamaModels, ollamaWhere } from './models'
import {
  type ChatBody,
  type ChatChunk,
  chatOnce as postChat,
  chatStream as streamChat,
  endpointFor,
  type OllamaMessage,
  type OllamaTarget,
  type OllamaToolCall,
  type StreamTimeouts,
  streamTimeoutsFor
} from './wire'

// Ollama's side of the seam: neutral requests become /api/chat bodies, NDJSON chunks become neutral events. A body is
// byte for byte what Ollmost sent before the seam existed (tests/ollamaAdapter.test.ts holds it to that).

/** How a request reaches an endpoint: its root, its name for errors, and the one key it may be sent. */
export function ollamaTarget(endpoint: Pick<Endpoint, 'id' | 'name' | 'baseUrl'>): OllamaTarget {
  const base = endpoint.baseUrl.replace(/\/+$/, '')
  const cloud = isOllamaCloudUrl(base)
  // ollama.com takes the ollama.com account key, and only over https: plain http is sent no key at all. Any other
  // server is only ever sent its own. (`cloud` parsed the URL, so reading its protocol can't throw.)
  const key = cloud
    ? new URL(base).protocol === 'https:'
      ? getSecret(OLLAMA_ACCOUNT_SECRET)
      : null
    : getSecret(endpointSecretName(endpoint.id))
  return { base, name: endpoint.name, cloud, keyed: !cloud && key !== null, headers: key ? { Authorization: `Bearer ${key}` } : {} }
}

/**
 * A request's options: the temperature when asked, and num_ctx only where Ollmost sets the window. Every request to
 * a local model carries the same num_ctx, titles included: a different one makes Ollama reload the model.
 */
export function ollamaOptions(
  req: Pick<ChatRequest, 'temperature' | 'contextWindow'>,
  clientContext: boolean
): Record<string, number> | undefined {
  const options: Record<string, number> = {}
  if (req.temperature !== undefined) options.temperature = req.temperature
  if (clientContext && req.contextWindow !== null) options.num_ctx = req.contextWindow
  return Object.keys(options).length ? options : undefined
}

/** How long a stream may go quiet: see streamTimeoutsFor. */
export const ollamaTimeouts = (endpoint: Pick<Endpoint, 'baseUrl'>, model: string): StreamTimeouts =>
  streamTimeoutsFor(ollamaWhere(endpoint, model))

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
 * The /api/chat body for a request. `clientContext`: Ollmost sets this model's window (a model the Ollama app runs),
 * so the request's window goes as num_ctx. Cloud models manage their own context.
 */
export function toOllamaBody(req: ChatRequest, clientContext: boolean): ChatBody {
  return {
    model: req.model,
    messages: req.messages.map(toOllamaMessage),
    think: toOllamaThink(req.profile, req.think),
    tools: req.tools,
    options: ollamaOptions(req, clientContext)
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

/** One Ollama endpoint: the Ollama app, another machine's, or ollama.com itself. */
export class OllamaProvider implements Provider {
  constructor(readonly endpoint: Endpoint) {}

  get id(): string {
    return this.endpoint.id
  }

  // Read per request, so a key saved since applies at once.
  private target(): OllamaTarget {
    return ollamaTarget(this.endpoint)
  }

  private where(model: string): ModelWhere {
    return ollamaWhere(this.endpoint, model)
  }

  private body(req: ChatRequest): ChatBody {
    return toOllamaBody(req, this.where(req.model) !== 'cloud')
  }

  // async, so a throw from target() rejects the promise: listAllModels then reports it for this endpoint alone.
  async listModels(refresh: boolean): Promise<ModelInfo[]> {
    return listOllamaModels(this.endpoint, this.target(), refresh)
  }

  async modelInfo(model: string, refresh = false): Promise<ModelInfo> {
    return getModelInfo(this.endpoint, this.target(), model, refresh)
  }

  async *chatStream(req: ChatRequest, signal: AbortSignal): AsyncGenerator<ChatEvent> {
    yield* ollamaEvents(streamChat(this.target(), this.body(req), signal, ollamaTimeouts(this.endpoint, req.model)))
  }

  async chatOnce(req: ChatRequest, opts: { signal?: AbortSignal; timeoutMs: number }): Promise<ChatResult> {
    return resultFromOllama(await postChat(this.target(), this.body(req), opts))
  }

  wire(req: ChatRequest, stream: boolean): WireRequest {
    return { endpoint: this.wireEndpoint(), body: { ...this.body(req), stream } }
  }

  wireEndpoint(): string {
    return endpointFor(this.target(), '/api/chat')
  }

  async sendWire(body: unknown, opts: { signal?: AbortSignal; timeoutMs: number }): Promise<ChatResult> {
    return resultFromOllama(await postChat(this.target(), body as ChatBody, opts))
  }
}
