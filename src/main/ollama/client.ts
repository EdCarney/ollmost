import { getApiKey, getSettings } from '../settings'

export const OLLAMA_CLOUD = 'https://ollama.com'

export interface ToolCall {
  function: { name: string; arguments: Record<string, unknown> | string }
}

export interface OllamaMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
  thinking?: string
  images?: string[]
  tool_calls?: ToolCall[]
  tool_name?: string
}

export interface OllamaTool {
  type: 'function'
  function: { name: string; description: string; parameters: Record<string, unknown> }
}

export interface ChatBody {
  model: string
  messages: OllamaMessage[]
  think?: boolean | 'low' | 'medium' | 'high'
  tools?: OllamaTool[]
  options?: Record<string, unknown>
  keep_alive?: string
}

export interface ChatChunk {
  message?: { role: string; content?: string; thinking?: string; tool_calls?: ToolCall[] }
  done: boolean
  done_reason?: string
  prompt_eval_count?: number
  eval_count?: number
  eval_duration?: number
  total_duration?: number
  error?: string
}

export class OllamaError extends Error {
  constructor(
    message: string,
    readonly status?: number
  ) {
    super(message)
  }
}

function target(): { base: string; headers: Record<string, string> } {
  const s = getSettings()
  if (s.connection.mode === 'direct') {
    const key = getApiKey()
    return { base: OLLAMA_CLOUD, headers: key ? { Authorization: `Bearer ${key}` } : {} }
  }
  return { base: s.connection.host.replace(/\/+$/, ''), headers: {} }
}

const NOT_ENOUGH_MEMORY_RE = /model requires more system memory/i

/** Ollama's daemon says the model needs more RAM than the machine has; point at the two real fixes. */
function notEnoughMemory(detail: string, model?: string): string | undefined {
  if (!NOT_ENOUGH_MEMORY_RE.test(detail)) return undefined
  return model
    ? `Not enough memory to load “${model}”. Lower the context window in Settings → Models, or pick a smaller or more quantized model.`
    : `Not enough memory to load the model. Lower the context window in Settings → Models, or pick a smaller or more quantized model.`
}

function friendly(status: number, body: string, model?: string): OllamaError {
  let detail = body
  try {
    detail = (JSON.parse(body) as { error?: string }).error ?? body
  } catch {
    /* not JSON */
  }
  if (status === 401 || status === 403)
    return new OllamaError(
      getSettings().connection.mode === 'direct'
        ? 'Ollama cloud rejected the API key. Check it in Settings → Models.'
        : 'Ollama cloud needs you to sign in. Run `ollama signin` in a terminal, then retry.',
      status
    )
  if (status === 429) return new OllamaError('Ollama cloud usage limit reached. Try again later, or switch to a local model.', status)
  if (status === 404 && /not found/i.test(detail))
    return new OllamaError(model ? `Model “${model}” was not found by Ollama.` : detail, status)
  return new OllamaError(notEnoughMemory(detail, model) ?? (detail || `Ollama returned HTTP ${status}`), status)
}

// Short calls (model lists, /api/show) should never hang the UI on a wedged daemon.
const METADATA_TIMEOUT_MS = 30_000

async function request(path: string, init: RequestInit & { model?: string; base?: string } = {}): Promise<Response> {
  const { base, headers } = target()
  const url = `${init.base ?? base}${path}`
  let res: Response
  try {
    res = await fetch(url, {
      ...init,
      signal: init.signal ?? AbortSignal.timeout(METADATA_TIMEOUT_MS),
      headers: { 'Content-Type': 'application/json', ...headers, ...(init.headers as Record<string, string>) }
    })
  } catch (err) {
    if ((err as Error).name === 'AbortError') throw err
    if ((err as Error).name === 'TimeoutError') throw new OllamaError('Ollama took too long to respond. Try again in a moment.')
    throw new OllamaError(
      getSettings().connection.mode === 'direct'
        ? `Can't reach ${OLLAMA_CLOUD}. Check your internet connection.`
        : `Can't reach Ollama at ${base}. Is the Ollama app running?`
    )
  }
  if (!res.ok) throw friendly(res.status, await res.text().catch(() => ''), init.model)
  return res
}

export interface StreamTimeouts {
  /** Until the first byte of the reply: covers loading a cold local model and reading a long prompt. */
  firstByteMs: number
  /** Between chunks once the reply has started. */
  idleMs: number
  /**
   * Between chunks when the request offers tools. Ollama holds back a tool call until its arguments are
   * complete, so a slow local model writing a long argument can go quiet for many minutes while healthy.
   */
  toolIdleMs: number
}

// Generous on purpose: these catch a dead connection, not a slow model.
export const STREAM_TIMEOUTS: StreamTimeouts = { firstByteMs: 10 * 60_000, idleMs: 3 * 60_000, toolIdleMs: 30 * 60_000 }

/**
 * The long tool-call allowance is only for local models: cloud models finish a tool call's arguments in
 * seconds, so a long silence there is always a dead connection.
 */
export function streamTimeoutsFor(location: 'cloud' | 'local'): StreamTimeouts {
  return location === 'local' ? STREAM_TIMEOUTS : { ...STREAM_TIMEOUTS, toolIdleMs: STREAM_TIMEOUTS.idleMs }
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
  body: ChatBody,
  signal: AbortSignal,
  timeouts: StreamTimeouts = STREAM_TIMEOUTS
): AsyncGenerator<ChatChunk> {
  const inner = new AbortController()
  const forward = () => inner.abort(signal.reason)
  if (signal.aborted) forward()
  else signal.addEventListener('abort', forward, { once: true })
  let stalled: string | null = null
  let timer: ReturnType<typeof setTimeout> | undefined
  const arm = (ms: number, message: string) => {
    clearTimeout(timer)
    timer = setTimeout(() => {
      stalled = message
      inner.abort()
    }, ms)
  }

  arm(
    timeouts.firstByteMs,
    `Ollama didn't start replying within ${Math.round(timeouts.firstByteMs / 60_000)} minutes. Check that it's running, then retry.`
  )
  try {
    const res = await request('/api/chat', {
      method: 'POST',
      body: JSON.stringify({ ...body, stream: true }),
      signal: inner.signal,
      model: body.model
    })
    if (!res.body) throw new OllamaError('Ollama returned an empty response')
    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    const idleMs = body.tools?.length ? timeouts.toolIdleMs : timeouts.idleMs
    const idle = `Ollama stopped responding in the middle of the reply (nothing for ${Math.round(idleMs / 60_000)} minutes).`
    let buffer = ''
    let finished = false
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      arm(idleMs, idle)
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
    if (!finished) throw new OllamaError('The connection to Ollama dropped before the reply finished.')
  } catch (err) {
    if (stalled && !signal.aborted) throw new OllamaError(stalled)
    throw err
  } finally {
    clearTimeout(timer)
    signal.removeEventListener('abort', forward)
    // A consumer that stops early (break or throw) must not leave Ollama generating into an unread socket.
    inner.abort()
  }
}

export async function chatOnce(body: ChatBody, opts: { signal?: AbortSignal; timeoutMs: number }): Promise<ChatChunk> {
  const timeout = AbortSignal.timeout(opts.timeoutMs)
  const res = await request('/api/chat', {
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

export async function listTags(fromCloudCatalog = false): Promise<TagModel[]> {
  const res = await request('/api/tags', fromCloudCatalog ? { base: OLLAMA_CLOUD } : {})
  return ((await res.json()) as { models?: TagModel[] }).models ?? []
}

export interface ShowResponse {
  capabilities?: string[]
  details?: { family?: string; parameter_size?: string }
  model_info?: Record<string, unknown>
}

export async function showModel(model: string): Promise<ShowResponse> {
  const res = await request('/api/show', { method: 'POST', body: JSON.stringify({ model }), model })
  return (await res.json()) as ShowResponse
}

export const isCloudName = (name: string): boolean => /(:|-)cloud$/.test(name)

/** Full URL for an Ollama API path on the current target (never includes credentials). */
export function endpointFor(path: string): string {
  return `${target().base}${path}`
}

export function connectionMode(): 'local' | 'direct' {
  return getSettings().connection.mode
}
