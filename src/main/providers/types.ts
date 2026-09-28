import type { ModelInfo, ThinkProfile, ThinkSetting } from '@shared/types'

// The shapes every model server is spoken to in. Shared code builds and reads only these; each adapter translates them
// to and from its server's API, so nothing one server needs (Ollama's num_ctx, OpenAI's tool_call_id) leaks out.

/** A tool call as the loop and tools.ts see it: today's shape plus an id. Adapters and assemble() always set `id`. */
export interface ToolCall {
  id?: string
  function: { name: string; arguments: Record<string, unknown> | string }
}

export type IdentifiedToolCall = ToolCall & { id: string }

/** A tool offered with a request: the OpenAI function-tool shape, which Ollama takes as it is. */
export interface ToolDef {
  type: 'function'
  function: { name: string; description: string; parameters: Record<string, unknown> }
}

/** An image for a vision model: base64 without a `data:` prefix, and the type it's encoded in. */
export interface ChatImage {
  data: string
  mime: string
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
  /** An earlier round's reasoning in this turn; only an adapter whose server takes it back sends it. */
  thinking?: string
  images?: ChatImage[]
  toolCalls?: ToolCall[]
  /** For a tool result: the call it answers. */
  toolCallId?: string
  /** For a tool result: the tool that produced it. */
  toolName?: string
}

export interface ChatRequest {
  /** The model's name at its server, never a key with an endpoint in front. */
  model: string
  messages: ChatMessage[]
  tools?: ToolDef[]
  /** The user's choice; the adapter turns it into its server's parameter through `profile`. */
  think: ThinkSetting | null
  profile: ThinkProfile
  /** The window the request was fitted to; an adapter whose server takes a context size sends it. */
  contextWindow: number | null
  temperature?: number
}

export interface RequestUsage {
  prompt?: number
  completion?: number
}

/** The server's own durations for a request, in ms, when it reports them. */
export interface ChatTiming {
  loadMs?: number
  promptMs?: number
  genMs?: number
}

/**
 * What a streamed reply is made of. `content` may be empty: a chunk that carried nothing, which only tells the loop the
 * server is there. A `toolCall` comes only once the call is complete. `done` ends a finished reply; its `raw` is the
 * server's closing record without the reply's text, which the debugger shows.
 */
export type ChatEvent =
  | { type: 'content'; text: string }
  | { type: 'thinking'; text: string }
  | { type: 'toolCall'; call: IdentifiedToolCall }
  | { type: 'done'; usage: RequestUsage; finishReason?: string; timing?: ChatTiming; raw: unknown }

/** A reply read whole: titles, /compact and replay. */
export interface ChatResult {
  content: string
  thinking: string
  toolCalls: IdentifiedToolCall[]
  usage: RequestUsage
  finishReason?: string
  timing?: ChatTiming
  raw: unknown
}

/** A request as it goes over the wire: where to, and the exact body. */
export interface WireRequest {
  endpoint: string
  body: unknown
}

/** One model server behind the seam. Every model call reaches it through registry.resolve(). */
export interface Provider {
  readonly id: string
  /** Every model it serves; throws when nothing can be listed. */
  listModels(refresh: boolean): Promise<ModelInfo[]>
  modelInfo(model: string, refresh?: boolean): Promise<ModelInfo>
  chatStream(req: ChatRequest, signal: AbortSignal): AsyncGenerator<ChatEvent>
  chatOnce(req: ChatRequest, opts: { signal?: AbortSignal; timeoutMs: number }): Promise<ChatResult>
  /** Exactly what chatStream (`stream` true) or chatOnce (false) sends; traces record it. */
  wire(req: ChatRequest, stream: boolean): WireRequest
  /** Where wire bodies go: the endpoint a replayed trace is sent to. */
  wireEndpoint(): string
  /** Send a body already in this server's shape (a replayed trace, perhaps edited), not streamed. */
  sendWire(body: unknown, opts: { signal?: AbortSignal; timeoutMs: number }): Promise<ChatResult>
}
