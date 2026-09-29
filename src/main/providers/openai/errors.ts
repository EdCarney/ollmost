import { displayAddress } from '@shared/endpoints'
import { contextSizeLabel } from '@shared/format'
import type { Endpoint, EndpointFlavor, ModelDetected } from '@shared/types'
import { fetchFailureMessage, hostOf } from '../fetchFailure'
import { isRecord } from '../json'

export class OpenAIError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    options?: ErrorOptions
  ) {
    super(message, options)
  }
}

// What to do about a server that isn't answering, by the kind of server it is.
const START_HINTS: Record<EndpointFlavor, string> = {
  ollama: '',
  lmstudio: ' Start it in LM Studio’s Developer tab.',
  llamacpp: ' Start it with `llama-server`.',
  vllm: ' Start it with `vllm serve`.',
  generic: ''
}

/** A request that never got an answer, in words that name the endpoint; `cause` is what fetch threw. */
export function unreachableError(endpoint: Pick<Endpoint, 'name' | 'baseUrl' | 'flavor'>, cause?: unknown): OpenAIError {
  const address = displayAddress(endpoint.baseUrl)
  const refused = `Can't reach ${endpoint.name} at ${address}. Is its server started?${START_HINTS[endpoint.flavor]}`
  const message = fetchFailureMessage(cause, { subject: endpoint.name, address, host: hostOf(endpoint.baseUrl) }, refused)
  return new OpenAIError(message, undefined, cause === undefined ? undefined : { cause })
}

// Servers that need a start-up flag before they take tools say so in their error.
const TOOL_FLAGS = [
  {
    match: /enable-auto-tool-choice|tool-call-parser/i,
    flag: '`--enable-auto-tool-choice --tool-call-parser …`',
    reason: 'server lacks --enable-auto-tool-choice'
  },
  { match: /--jinja/i, flag: '`--jinja`', reason: 'server lacks --jinja' }
]

// How servers say a model isn't there: vLLM "does not exist", others "not found". LM Studio's "No models loaded"
// isn't one of them: with just-in-time loading off it means "load a model", so its own words go through.
const MISSING_MODEL = /not found|does not exist|no such|invalid model|unknown model/i

/** The message in any of the error shapes servers send, and the error object itself when there is one. */
function readError(body: string): { detail: string; error: Record<string, unknown> } {
  let json: unknown
  try {
    json = JSON.parse(body)
  } catch {
    return { detail: body.trim(), error: {} }
  }
  const obj = isRecord(json) ? json : {}
  if (typeof obj.error === 'string') return { detail: obj.error, error: {} }
  if (isRecord(obj.error)) return { detail: typeof obj.error.message === 'string' ? obj.error.message : body.trim(), error: obj.error }
  const detail = typeof obj.message === 'string' ? obj.message : typeof obj.detail === 'string' ? obj.detail : body.trim()
  return { detail, error: obj }
}

// vLLM: "maximum context length is 32768 tokens"; llama.cpp: an exceed_context_size_error with n_ctx.
function contextLimitOf(detail: string, error: Record<string, unknown>): number | null {
  const m = /maximum context length is (\d+)/i.exec(detail)
  if (m) return Number(m[1])
  return error.type === 'exceed_context_size_error' && typeof error.n_ctx === 'number' ? error.n_ctx : null
}

/**
 * An HTTP error from an OpenAI-compatible server in words that name the endpoint, and what it teaches about the model
 * (tools refused until a server flag is set; the real context size), for model_profiles' `detected`.
 */
export function friendlyOpenAIError(
  endpoint: Pick<Endpoint, 'name' | 'baseUrl' | 'flavor'>,
  status: number,
  body: string,
  model?: string
): { error: Error; detected?: ModelDetected } {
  const { name } = endpoint
  const { detail, error } = readError(body)
  const fail = (message: string, detected?: ModelDetected) => {
    const e = new OpenAIError(message, status)
    return detected ? { error: e, detected } : { error: e }
  }
  if (status === 401 || status === 403) return fail(`${name} rejected the API key. Check it in Settings → Models → ${name}.`)
  if (status === 429) return fail(`${name} is busy or rate-limited. Try again in a moment.`)
  const tools = TOOL_FLAGS.find((t) => t.match.test(detail))
  if (tools)
    return fail(
      `${name} can't use tools with this model until it's started with ${tools.flag}. Retry to answer without tools; Settings → Models → ${name} turns them back on.`,
      { tools: false, reason: tools.reason }
    )
  const window = contextLimitOf(detail, error)
  if (window)
    return fail(
      `This chat no longer fits ${model ?? 'the model'} on ${name} (a ${contextSizeLabel(window)} context). Ollmost now plans for that size: retry, use /compact, or start a new chat.`,
      { contextLength: window, reason: `${name} reported a ${contextSizeLabel(window)} context` }
    )
  if (model && /model/i.test(detail) && (status === 404 || MISSING_MODEL.test(detail)))
    return fail(`${name} doesn't have a model called ${model}.`)
  // A proxy's error page is HTML: not a message for anyone to read.
  const message = detail.trim().startsWith('<') ? '' : detail
  return fail(message ? `${name}: ${message}` : `${name} at ${displayAddress(endpoint.baseUrl)} answered HTTP ${status}.`)
}
