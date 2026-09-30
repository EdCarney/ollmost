import { toModelKey } from '@shared/modelKey'
import type { Endpoint, ModelDetected, ModelInfo } from '@shared/types'
import { type CachedModelInfo, readModelProfile, writeModelDetected, writeModelInfo } from '../../db/kv'
import { setEndpointStreamOptions } from '../../settings'
import { effectiveCapabilities } from '../capabilities'
import { contextWindowFor } from '../context'
import { endpointSecretName, getSecret } from '../secrets'
import { createStallTimer, idleMsFor, STREAM_TIMEOUTS, type StreamTimeouts } from '../stream'
import type { ChatEvent, ChatRequest, ChatResult, ChatTiming, Provider, RequestUsage, WireRequest } from '../types'
import { billingOf, whereOf } from '../where'
import { toOpenAIBody } from './body'
import { type DiscoveredModel, discoverModels } from './discovery'
import { friendlyOpenAIError, OpenAIError, unreachableError } from './errors'
import { sseData } from './sse'
import { createThinkSplitter, type ThinkSplit } from './thinkSplitter'
import { createToolCallAccumulator, firstMadeUpId } from './toolCalls'

// A model's info is read again after a day, as the Ollama adapter does.
const INFO_TTL = 24 * 60 * 60 * 1000

// A model its server never described: the defaults for a server that reports nothing.
const UNKNOWN: CachedModelInfo = {
  capabilities: ['completion', 'tools'],
  contextLength: null,
  family: null,
  parameterSize: null,
  thinkPreset: null
}

interface Delta {
  content?: string | null
  reasoning?: string | null
  reasoning_content?: string | null
  tool_calls?: unknown
}
interface Usage {
  prompt_tokens?: number
  completion_tokens?: number
}
/** llama.cpp's own counts and durations (ms). */
interface Timings {
  prompt_n?: number
  prompt_ms?: number
  predicted_n?: number
  predicted_ms?: number
}
interface StreamChunk {
  choices?: Array<{ delta?: Delta; finish_reason?: string | null }>
  usage?: Usage | null
  timings?: Timings
  error?: unknown
}
interface Completion {
  choices?: Array<{ message?: Delta; finish_reason?: string | null }>
  usage?: Usage | null
  timings?: Timings
  error?: unknown
}

// llama.cpp's timings count the tokens it processed: the fallback for a server that sends no usage.
const usageOf = (u: Usage | null | undefined, t: Timings | undefined): RequestUsage => ({
  prompt: u?.prompt_tokens ?? t?.prompt_n,
  completion: u?.completion_tokens ?? t?.predicted_n
})

const timingOf = (t: Timings | undefined): ChatTiming | undefined =>
  t && (t.prompt_ms !== undefined || t.predicted_ms !== undefined) ? { promptMs: t.prompt_ms, genMs: t.predicted_ms } : undefined

/** Thinking before content: within one piece of a reply, the reasoning came first. */
const splitEvents = ({ thinking, content }: ThinkSplit): ChatEvent[] => [
  ...(thinking ? [{ type: 'thinking' as const, text: thinking }] : []),
  ...(content ? [{ type: 'content' as const, text: content }] : [])
]

const infoOf = (d: DiscoveredModel): CachedModelInfo => ({
  capabilities: d.capabilities,
  contextLength: d.contextLength,
  family: null,
  parameterSize: d.parameterSize,
  toolsReported: d.toolsReported,
  thinkPreset: d.thinkPreset
})

const minutes = (ms: number): number => Math.round(ms / 60_000)

// A server that doesn't know stream_options names it (OpenAI answers 400; FastAPI-based servers 422), but so does a
// FastAPI server's error about anything else: it echoes the body. post() tells them apart by retrying without.
const rejectsStreamOptions = (status: number, text: string): boolean => (status === 400 || status === 422) && /stream_options/i.test(text)

/**
 * A reply read whole: reasoning from its field, else split out of the text. `first` numbers a call that came without
 * an id past the ids this turn already made up (firstMadeUpId).
 */
function resultFrom(json: Completion, first = 0): ChatResult {
  const choice = json.choices?.[0]
  const message = choice?.message ?? {}
  const text = typeof message.content === 'string' ? message.content : ''
  const reasoning = message.reasoning || message.reasoning_content || ''
  let split: ThinkSplit = { content: text, thinking: reasoning }
  if (!reasoning) {
    const splitter = createThinkSplitter()
    const a = splitter.push(text)
    const b = splitter.flush()
    split = { content: a.content + b.content, thinking: a.thinking + b.thinking }
  }
  const calls = createToolCallAccumulator()
  if (Array.isArray(message.tool_calls)) calls.add(message.tool_calls.map((c, index) => ({ index, ...(c as Record<string, unknown>) })))
  return {
    ...split,
    toolCalls: calls.finish(first),
    usage: usageOf(json.usage, json.timings),
    finishReason: choice?.finish_reason ?? undefined,
    timing: timingOf(json.timings),
    // The closing record without the reply's text, as the debugger shows it.
    raw: { ...json, choices: json.choices?.map(({ message: _message, ...rest }) => rest) }
  }
}

/** An OpenAI-compatible server: LM Studio, llama.cpp's llama-server, vLLM, or anything else with /v1/chat/completions. */
export class OpenAIProvider implements Provider {
  readonly id: string
  private readonly timeouts: StreamTimeouts
  // False once the server has rejected stream_options; saved on the endpoint too.
  private streamOptions: boolean

  /**
   * An OpenAI-compatible endpoint is on this Mac or the network, never 'cloud', and both keep the local allowances:
   * some servers hold a tool call back the way Ollama does. Tests pass shorter ones.
   */
  constructor(
    readonly endpoint: Endpoint,
    opts: { timeouts?: StreamTimeouts } = {}
  ) {
    this.id = endpoint.id
    this.timeouts = opts.timeouts ?? STREAM_TIMEOUTS
    this.streamOptions = endpoint.streamOptions !== false
  }

  // ---- models ----

  async listModels(_refresh: boolean): Promise<ModelInfo[]> {
    // One request lists every model with what it can do, so the list is always read fresh; model_profiles keeps each
    // model's info for modelInfo(), which runs before every reply.
    const found = await discoverModels(this.endpoint, this.apiKey())
    return found.map((d) => {
      const info = infoOf(d)
      writeModelInfo(this.keyOf(d.name), info)
      return this.toModelInfo(d.name, info, true)
    })
  }

  async modelInfo(model: string, refresh = false): Promise<ModelInfo> {
    const profile = readModelProfile(this.keyOf(model))
    const cached = profile.info
    // LM Studio loads a model just-in-time: a cached null window (FINDINGS Q6) isn't the real one yet, so it's read
    // again on every call until the model has actually loaded.
    if (
      !refresh &&
      cached &&
      Date.now() - profile.fetchedAt < INFO_TTL &&
      !(this.endpoint.flavor === 'lmstudio' && cached.contextLength === null)
    )
      return this.toModelInfo(model, cached, true)
    let listed: DiscoveredModel[] | null = null
    try {
      listed = await discoverModels(this.endpoint, this.apiKey())
    } catch {
      // Unreachable: what was known still describes the model.
    }
    const found = listed?.find((d) => d.name === model)
    if (found) {
      const info = infoOf(found)
      writeModelInfo(this.keyOf(model), info)
      return this.toModelInfo(model, info, true)
    }
    // Listed without it: it's gone from the server. Not reachable: it's as it was.
    return this.toModelInfo(model, cached ?? UNKNOWN, listed === null && cached !== null)
  }

  // ---- chat ----

  wireEndpoint(): string {
    return `${this.endpoint.baseUrl.replace(/\/+$/, '')}/chat/completions`
  }

  wire(req: ChatRequest, stream: boolean): WireRequest {
    return { endpoint: this.wireEndpoint(), body: this.body(req, stream) }
  }

  async *chatStream(req: ChatRequest, signal: AbortSignal): AsyncGenerator<ChatEvent> {
    const { name } = this.endpoint
    const t = this.timeouts
    const inner = new AbortController()
    const forward = () => inner.abort(signal.reason)
    if (signal.aborted) forward()
    else signal.addEventListener('abort', forward, { once: true })
    const stall = createStallTimer(() => inner.abort())
    stall.arm(t.firstByteMs, `${name} didn't start replying within ${minutes(t.firstByteMs)} minutes. Check that it's running, then retry.`)
    const splitter = createThinkSplitter()
    // Once the server sends reasoning in its own field, content is only reply and the splitter steps aside.
    let separated = false
    try {
      const res = await this.post(this.body(req, true), req.model, inner.signal)
      if (!res.body) throw new OpenAIError(`${name} returned an empty response.`)
      const idleMs = idleMsFor(req.tools, t)
      const idle = `${name} stopped responding in the middle of the reply (nothing for ${minutes(idleMs)} minutes).`
      const dropped = `The connection to ${name} dropped before the reply finished.`
      const calls = createToolCallAccumulator()
      let finishReason: string | undefined
      let usage: Usage | null | undefined
      let timings: Timings | undefined
      let sawDone = false
      const payloads = sseData(res.body)
      for (;;) {
        let next: IteratorResult<string, boolean>
        try {
          next = await payloads.next()
        } catch (err) {
          // A stall or Stop aborted the read, and the catch below says which. Anything else broke the connection
          // mid-reply: the server quit or the socket reset.
          if (inner.signal.aborted) throw err
          throw new OpenAIError(dropped)
        }
        if (next.done) {
          sawDone = next.value
          break
        }
        stall.arm(idleMs, idle)
        const chunk = this.parse<StreamChunk>(next.value)
        if (chunk.error) throw this.errorIn(chunk.error, req.model)
        if (chunk.usage) usage = chunk.usage
        if (chunk.timings) timings = chunk.timings
        const choice = chunk.choices?.[0]
        const delta = choice?.delta
        const events: ChatEvent[] = []
        const reasoning = delta?.reasoning || delta?.reasoning_content
        if (reasoning) {
          if (!separated) {
            separated = true
            // Anything the splitter held back was the start of the reply.
            events.push(...splitEvents(splitter.flush()))
          }
          events.push({ type: 'thinking', text: reasoning })
        }
        if (delta?.content) events.push(...splitEvents(separated ? { thinking: '', content: delta.content } : splitter.push(delta.content)))
        const toolDeltas = delta?.tool_calls
        if (Array.isArray(toolDeltas)) calls.add(toolDeltas)
        if (choice?.finish_reason) finishReason = choice.finish_reason
        // A chunk with nothing to show still says the server is there: the loop times the first byte by it.
        if (!events.length) events.push({ type: 'content', text: '' })
        yield* events
      }
      if (!sawDone && !finishReason) throw new OpenAIError(dropped)
      if (!separated) yield* splitEvents(splitter.flush())
      // Calls go out whole, once the stream has said it's finished (finish_reason, then [DONE] or the end). One sent
      // without an id is numbered past the ids this turn's earlier rounds made up.
      for (const call of calls.finish(firstMadeUpId(req.messages))) yield { type: 'toolCall', call }
      yield {
        type: 'done',
        usage: usageOf(usage, timings),
        finishReason,
        timing: timingOf(timings),
        raw: { finish_reason: finishReason ?? null, usage: usage ?? null, timings: timings ?? null }
      }
    } catch (err) {
      // What the splitter still holds is the start of the reply: a stopped or broken reply keeps it, as it would on Ollama.
      if (!separated) yield* splitEvents(splitter.flush())
      const stalled = stall.stalled()
      if (stalled && !signal.aborted) throw new OpenAIError(stalled)
      throw err
    } finally {
      stall.clear()
      signal.removeEventListener('abort', forward)
      // A consumer that stops early mustn't leave the server generating into an unread socket.
      inner.abort()
    }
  }

  chatOnce(req: ChatRequest, opts: { signal?: AbortSignal; timeoutMs: number }): Promise<ChatResult> {
    return this.once(this.body(req, false), req.model, opts, firstMadeUpId(req.messages))
  }

  /**
   * Replay a body as it is (perhaps edited in the debugger), read whole: stream_options only goes with a stream. Its
   * reply never joins a chat, so a call without an id is numbered from the start.
   */
  sendWire(body: unknown, opts: { signal?: AbortSignal; timeoutMs: number }): Promise<ChatResult> {
    const { stream_options: _streamOptions, ...rest } = body as Record<string, unknown>
    return this.once({ ...rest, stream: false }, typeof rest.model === 'string' ? rest.model : undefined, opts)
  }

  // ---- internals ----

  private body(req: ChatRequest, stream: boolean): Record<string, unknown> {
    return toOpenAIBody(req, { stream, streamOptions: stream && this.streamOptions, flavor: this.endpoint.flavor })
  }

  private apiKey(): string | null {
    return getSecret(endpointSecretName(this.endpoint.id))
  }

  private keyOf(model: string) {
    return toModelKey(this.endpoint.id, model)
  }

  private async send(body: unknown, signal: AbortSignal): Promise<Response> {
    const key = this.apiKey()
    try {
      return await fetch(this.wireEndpoint(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(key ? { Authorization: `Bearer ${key}` } : {}) },
        body: JSON.stringify(body),
        signal
      })
    } catch (err) {
      const name = (err as Error).name
      // Stop, a stall and chatOnce's timeout are told apart by the callers.
      if (name === 'AbortError' || name === 'TimeoutError') throw err
      throw unreachableError(this.endpoint, err)
    }
  }

  /**
   * POST a body. A server that seems to reject stream_options gets it again without, once, and the endpoint remembers
   * only if that one is taken: FastAPI servers echo the whole body in any validation error, stream_options included.
   */
  private async post(body: Record<string, unknown>, model: string | undefined, signal: AbortSignal): Promise<Response> {
    let res = await this.send(body, signal)
    if (!res.ok && 'stream_options' in body) {
      const text = await res.text().catch(() => '')
      if (!rejectsStreamOptions(res.status, text)) throw this.fail(res.status, text, model)
      const { stream_options: _dropped, ...rest } = body
      res = await this.send(rest, signal)
      if (res.ok) {
        this.streamOptions = false
        setEndpointStreamOptions(this.endpoint.id, this.endpoint.baseUrl, false)
      }
    }
    if (!res.ok) throw this.fail(res.status, await res.text().catch(() => ''), model)
    return res
  }

  private fail(status: number, text: string, model?: string): Error {
    const { error, detected } = friendlyOpenAIError(this.endpoint, status, text, model)
    if (detected && model) this.learn(model, detected)
    return error
  }

  /** Keep what an error taught about a model (tools refused, its real window) until the user re-detects it. */
  private learn(model: string, detected: ModelDetected): void {
    const key = this.keyOf(model)
    writeModelDetected(key, { ...readModelProfile(key).detected, ...detected })
  }

  /** An error sent inside a 200: `data: {"error": …}` mid-stream, or a JSON body. */
  private errorIn(error: unknown, model: string | undefined): Error {
    const code =
      typeof error === 'object' && error !== null && typeof (error as { code?: unknown }).code === 'number'
        ? (error as { code: number }).code
        : 500
    return this.fail(code, JSON.stringify({ error }), model)
  }

  private parse<T>(text: string): T {
    try {
      return JSON.parse(text) as T
    } catch {
      throw new OpenAIError(`${this.endpoint.name} sent a response Ollmost couldn't read: ${text.slice(0, 120)}`)
    }
  }

  private async once(
    body: Record<string, unknown>,
    model: string | undefined,
    opts: { signal?: AbortSignal; timeoutMs: number },
    first = 0
  ): Promise<ChatResult> {
    const timeout = AbortSignal.timeout(opts.timeoutMs)
    try {
      const res = await this.post(body, model, opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout)
      const json = this.parse<Completion>(await res.text())
      if (json.error) throw this.errorIn(json.error, model)
      return resultFrom(json, first)
    } catch (err) {
      if ((err as Error).name === 'TimeoutError')
        throw new OpenAIError(`${this.endpoint.name} took too long to respond. Try again in a moment.`)
      throw err
    }
  }

  private toModelInfo(name: string, info: CachedModelInfo, installed: boolean): ModelInfo {
    const key = this.keyOf(name)
    const { overrides, detected } = readModelProfile(key)
    const where = whereOf(this.endpoint.baseUrl)
    const { id, name: endpointName, kind, flavor } = this.endpoint
    // The server fixed the window when it loaded the model: Ollmost never sends one.
    const contextControl = 'server' as const
    const capabilities = effectiveCapabilities(info.capabilities, overrides, detected)
    // A thinking profile the user picked brings the control, even where the server reports no thinking.
    if (overrides.think && overrides.think !== 'none' && !capabilities.includes('thinking')) capabilities.push('thinking')
    const sizes = { contextControl, contextLength: info.contextLength, detected }
    return {
      key,
      name,
      endpoint: { id, name: endpointName, kind, flavor },
      where,
      billing: billingOf(where),
      contextControl,
      contextWindow: contextWindowFor({ ...sizes, overrides }, this.endpoint),
      installed,
      capabilities,
      // Tools are known when the server said so (a profile saved before that was recorded counts as assumed until it's
      // read again) or the user set them.
      toolsKnown: overrides.tools !== undefined || info.toolsReported === true,
      contextLength: info.contextLength,
      family: info.family,
      parameterSize: info.parameterSize,
      overrides,
      detected,
      price: null,
      thinkPreset: info.thinkPreset ?? null,
      auto: {
        capabilities: effectiveCapabilities(info.capabilities, {}, detected),
        contextWindow: contextWindowFor({ ...sizes, overrides: {} }, this.endpoint)
      }
    }
  }
}
