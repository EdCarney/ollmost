// Ollama's HTTP API: /api/chat as NDJSON, /api/tags and /api/show. Only the adapter (adapter.ts) and the model list
// (models.ts) call it; everything else speaks the neutral types in ../types.ts.
import { displayAddress, hostnameOf, OLLAMA_CLOUD_URL } from '@shared/endpoints'
import type { ModelWhere } from '@shared/types'
import { cloudUnreachableMessage, fetchFailureMessage } from '../fetchFailure'
import { isRecord } from '../json'
import { createStallTimer, STREAM_TIMEOUTS, type StreamTimeouts } from '../stream'
import type { ToolDef } from '../types'

// Kept here too, where the Ollama side and its tests have always found them.
export { STREAM_TIMEOUTS, type StreamTimeouts }

export const OLLAMA_CLOUD = OLLAMA_CLOUD_URL

/** One Ollama server, as a request sees it. adapter.ts's ollamaTarget() makes one from an endpoint. */
export interface OllamaTarget {
  /** The server's root, without a trailing slash. */
  base: string
  /** The endpoint's name, for errors ("Can't reach GPU box at …"). */
  name: string
  /** The one key this server may be sent, as a header; empty when there's none. */
  headers: Record<string, string>
  /** The server is ollama.com itself. */
  cloud: boolean
  /** A key of the endpoint's own is sent (an Ollama behind a proxy that checks one). */
  keyed: boolean
}

// ollama.com's public catalog. No key goes with it: an endpoint's key must never reach ollama.com.
const CATALOG: OllamaTarget = { base: OLLAMA_CLOUD, name: 'ollama.com', headers: {}, cloud: true, keyed: false }

/** A tool call as Ollama sends it. Newer versions give each call an `id` and say which came first (`index`). */
export interface OllamaToolCall {
  id?: string
  function: { index?: number; name: string; arguments: Record<string, unknown> | string }
}

export interface OllamaMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
  thinking?: string
  images?: string[]
  tool_calls?: OllamaToolCall[]
  tool_name?: string
}

export interface ChatBody {
  model: string
  messages: OllamaMessage[]
  think?: boolean | 'low' | 'medium' | 'high'
  tools?: ToolDef[]
  options?: Record<string, unknown>
  keep_alive?: string
}

export interface ChatChunk {
  message?: { role: string; content?: string; thinking?: string; tool_calls?: OllamaToolCall[] }
  done: boolean
  done_reason?: string
  prompt_eval_count?: number
  eval_count?: number
  /** Nanoseconds, like every Ollama duration. */
  load_duration?: number
  prompt_eval_duration?: number
  eval_duration?: number
  total_duration?: number
  error?: string
}

export class OllamaError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    options?: ErrorOptions
  ) {
    super(message, options)
  }
}

const NOT_ENOUGH_MEMORY_RE = /model requires more system memory/i

/** Ollama's daemon says the model needs more RAM than the machine has; point at the two real fixes. */
function notEnoughMemory(detail: string, model?: string): string | undefined {
  if (!NOT_ENOUGH_MEMORY_RE.test(detail)) return undefined
  return model
    ? `Not enough memory to load “${model}”. Lower the context window in Settings → Models, or pick a smaller or more quantized model.`
    : `Not enough memory to load the model. Lower the context window in Settings → Models, or pick a smaller or more quantized model.`
}

/** What an error body says: Ollama's `error` text, or the body as it came when it isn't JSON. JSON with no such text says nothing. */
export function errorDetail(body: string): string {
  try {
    const parsed: unknown = JSON.parse(body)
    return isRecord(parsed) && typeof parsed.error === 'string' ? parsed.error : ''
  } catch {
    return body
  }
}

/** What `detail` says to a person, or '' for nothing: blank, or a proxy's error page (HTML). */
export function messageOf(detail: string): string {
  const shown = detail.trim()
  return shown === '' || shown.startsWith('<') ? '' : detail
}

function friendly(t: OllamaTarget, status: number, body: string, model?: string): OllamaError {
  const detail = errorDetail(body)
  // With nothing to say, a server is named by its address.
  const answered = t.cloud ? `ollama.com answered HTTP ${status}.` : `${t.name} at ${displayAddress(t.base)} answered HTTP ${status}.`
  const message = messageOf(detail)
  if (status === 401 || status === 403)
    return new OllamaError(
      t.cloud
        ? 'Ollama cloud rejected the API key. Check it in Settings → Models → ollama.com account.'
        : t.keyed
          ? `${t.name} rejected the API key. Check it in Settings → Models → ${t.name}.`
          : 'Ollama cloud needs you to sign in. Run `ollama signin` in a terminal, then retry.',
      status
    )
  if (status === 429) return new OllamaError('Ollama cloud usage limit reached. Try again later, or switch to a local model.', status)
  if (status === 404 && /not found/i.test(detail))
    return new OllamaError(model ? `Model “${model}” was not found by ${t.name}.` : message || answered, status)
  // 4b69183: Ollama's "model requires more system memory" in plain English, naming the model.
  return new OllamaError(notEnoughMemory(detail, model) ?? (message || answered), status)
}

// Short calls (model lists, /api/show) should never hang the UI on a wedged daemon.
const METADATA_TIMEOUT_MS = 30_000

/** A request that never got an answer, in words that name the server; `err` is what fetch threw. */
function unreachable(t: OllamaTarget, err: unknown): string {
  if (t.cloud) return cloudUnreachableMessage(err)
  const refused = `Can't reach ${t.name} at ${t.base}. Is the Ollama app running?`
  return fetchFailureMessage(err, { subject: t.name, address: displayAddress(t.base), host: hostnameOf(t.base) ?? t.base }, refused)
}

async function request(t: OllamaTarget, path: string, init: RequestInit & { model?: string } = {}): Promise<Response> {
  let res: Response
  try {
    res = await fetch(`${t.base}${path}`, {
      ...init,
      signal: init.signal ?? AbortSignal.timeout(METADATA_TIMEOUT_MS),
      headers: { 'Content-Type': 'application/json', ...t.headers, ...(init.headers as Record<string, string>) }
    })
  } catch (err) {
    if ((err as Error).name === 'AbortError') throw err
    if ((err as Error).name === 'TimeoutError')
      throw new OllamaError(`${t.name} took too long to respond. Try again in a moment.`, undefined, { cause: err })
    throw new OllamaError(unreachable(t, err), undefined, { cause: err })
  }
  if (!res.ok) throw friendly(t, res.status, await res.text().catch(() => ''), init.model)
  return res
}

/**
 * The long tool-call allowance is for models that run on a machine: a cloud model finishes a tool call's arguments in
 * seconds, so a long silence there is always a dead connection.
 */
export function streamTimeoutsFor(where: ModelWhere): StreamTimeouts {
  return where === 'cloud' ? { ...STREAM_TIMEOUTS, toolIdleMs: STREAM_TIMEOUTS.idleMs } : STREAM_TIMEOUTS
}

function parseChunk(line: string): ChatChunk {
  try {
    return JSON.parse(line) as ChatChunk
  } catch {
    throw new OllamaError(`Ollama sent a response Ollmost couldn't read: ${line.slice(0, 120)}`)
  }
}

/**
 * Stream /api/chat as NDJSON chunks. Throws an OllamaError when the stream stalls past the timeouts or
 * ends without Ollama's final `done` chunk, so a dropped connection never passes for a finished reply.
 * Aborting `signal` still surfaces as an AbortError, which callers treat as the user stopping.
 */
export async function* chatStream(
  t: OllamaTarget,
  body: ChatBody,
  signal: AbortSignal,
  timeouts: StreamTimeouts = STREAM_TIMEOUTS
): AsyncGenerator<ChatChunk> {
  const inner = new AbortController()
  const forward = () => inner.abort(signal.reason)
  if (signal.aborted) forward()
  else signal.addEventListener('abort', forward, { once: true })
  const stall = createStallTimer(() => inner.abort())

  stall.arm(
    timeouts.firstByteMs,
    `${t.name} didn't start replying within ${Math.round(timeouts.firstByteMs / 60_000)} minutes. Check that it's running, then retry.`
  )
  try {
    const res = await request(t, '/api/chat', {
      method: 'POST',
      body: JSON.stringify({ ...body, stream: true }),
      signal: inner.signal,
      model: body.model
    })
    if (!res.body) throw new OllamaError(`${t.name} returned an empty response`)
    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    const idleMs = body.tools?.length ? timeouts.toolIdleMs : timeouts.idleMs
    const idle = `${t.name} stopped responding in the middle of the reply (nothing for ${Math.round(idleMs / 60_000)} minutes).`
    let buffer = ''
    let finished = false
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      stall.arm(idleMs, idle)
      buffer += decoder.decode(value, { stream: true })
      let nl: number
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl).trim()
        buffer = buffer.slice(nl + 1)
        if (!line) continue
        const chunk = parseChunk(line)
        if (chunk.error) throw new OllamaError(notEnoughMemory(chunk.error, body.model) ?? chunk.error)
        if (chunk.done) finished = true
        yield chunk
      }
    }
    buffer += decoder.decode()
    if (buffer.trim()) {
      const chunk = parseChunk(buffer.trim())
      if (chunk.error) throw new OllamaError(notEnoughMemory(chunk.error, body.model) ?? chunk.error)
      if (chunk.done) finished = true
      yield chunk
    }
    if (!finished) throw new OllamaError(`The connection to ${t.name} dropped before the reply finished.`)
  } catch (err) {
    const stalled = stall.stalled()
    if (stalled && !signal.aborted) throw new OllamaError(stalled)
    throw err
  } finally {
    stall.clear()
    signal.removeEventListener('abort', forward)
    // A consumer that stops early (break or throw) must not leave Ollama generating into an unread socket.
    inner.abort()
  }
}

export async function chatOnce(t: OllamaTarget, body: ChatBody, opts: { signal?: AbortSignal; timeoutMs: number }): Promise<ChatChunk> {
  const timeout = AbortSignal.timeout(opts.timeoutMs)
  const res = await request(t, '/api/chat', {
    method: 'POST',
    body: JSON.stringify({ ...body, stream: false }),
    signal: opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout,
    model: body.model
  })
  return (await res.json()) as ChatChunk
}

export interface TagModel {
  name: string
  remote_host?: string
  details?: { family?: string; parameter_size?: string }
}

export async function listTags(t: OllamaTarget): Promise<TagModel[]> {
  const res = await request(t, '/api/tags')
  return ((await res.json()) as { models?: TagModel[] }).models ?? []
}

/** ollama.com's cloud catalog, read with no key. */
export const listCloudCatalog = (): Promise<TagModel[]> => listTags(CATALOG)

export interface ShowResponse {
  capabilities?: string[]
  details?: { family?: string; parameter_size?: string }
  model_info?: Record<string, unknown>
}

export async function showModel(t: OllamaTarget, model: string): Promise<ShowResponse> {
  const res = await request(t, '/api/show', { method: 'POST', body: JSON.stringify({ model }), model })
  return (await res.json()) as ShowResponse
}

export const isCloudName = (name: string): boolean => /(:|-)cloud$/.test(name)

/** Full URL for an Ollama API path on this target (never includes credentials). */
export function endpointFor(t: OllamaTarget, path: string): string {
  return `${t.base}${path}`
}
