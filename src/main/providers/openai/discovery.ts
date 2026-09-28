import type { Endpoint, ThinkProfile } from '@shared/types'
import { isRecord } from '../json'
import { friendlyOpenAIError, OpenAIError, unreachableError } from './errors'

/** What discovery learns about one model. Where a server reports nothing, the defaults are filled in: tools on, vision off. */
export interface DiscoveredModel {
  name: string
  capabilities: string[]
  contextLength: number | null
  parameterSize: string | null
  thinkPreset: ThinkProfile['kind'] | null
  reportsCapabilities: boolean
}

type Where = Pick<Endpoint, 'name' | 'baseUrl' | 'flavor'>

// Short calls should never hang the UI on a wedged server.
const DISCOVERY_TIMEOUT_MS = 30_000

// Tools on, vision off: what a model gets when its server says nothing about it.
const DEFAULT_CAPABILITIES = ['completion', 'tools']

// Embedding and reranking models can't chat; servers that list them beside chat models give only their names.
const NOT_CHAT = /(^|[-_/])(embed|embedding|rerank)/i

/** The address without its trailing /v1: where LM Studio's and llama.cpp's own APIs live. */
export const rootOf = (baseUrl: string): string => baseUrl.replace(/\/+$/, '').replace(/\/v1$/, '')

const unreadable = (endpoint: Where) => new OpenAIError(`${endpoint.name} sent a model list Ollmost couldn't read.`)

/** GET a JSON document from the endpoint with its key; a failure comes back in words that name the endpoint. */
export async function getJson(endpoint: Where, url: string, apiKey: string | null, timeoutMs = DISCOVERY_TIMEOUT_MS): Promise<unknown> {
  let res: Response
  try {
    res = await fetch(url, { headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {}, signal: AbortSignal.timeout(timeoutMs) })
  } catch (err) {
    if ((err as Error).name === 'TimeoutError')
      throw new OpenAIError(`${endpoint.name} took too long to list its models. Try again in a moment.`)
    throw unreachableError(endpoint)
  }
  const text = await res.text().catch(() => '')
  if (!res.ok) throw friendlyOpenAIError(endpoint, res.status, text).error
  try {
    return JSON.parse(text) as unknown
  } catch {
    throw unreadable(endpoint)
  }
}

/** The entries of an OpenAI `/models` list that have an id. */
function dataOf(endpoint: Where, json: unknown): Array<Record<string, unknown> & { id: string }> {
  if (!isRecord(json) || !Array.isArray(json.data)) throw unreadable(endpoint)
  return json.data.filter((m): m is Record<string, unknown> & { id: string } => isRecord(m) && typeof m.id === 'string')
}

function genericModels(endpoint: Where, json: unknown): DiscoveredModel[] {
  return dataOf(endpoint, json)
    .filter((m) => !NOT_CHAT.test(m.id))
    .map((m) => ({
      name: m.id,
      capabilities: [...DEFAULT_CAPABILITIES],
      contextLength: null,
      parameterSize: null,
      thinkPreset: null,
      reportsCapabilities: false
    }))
}

const num = (v: unknown): number | null => (typeof v === 'number' && v > 0 ? v : null)

/** "8.2B" from llama.cpp's parameter count. */
const paramsOf = (n: number | null): string | null => (n ? `${(n / 1e9).toFixed(1)}B` : null)

/** LM Studio's reasoning options as a thinking profile: levels, an on/off toggle, or always on. */
function thinkPresetOf(reasoning: unknown): ThinkProfile['kind'] | null {
  if (!isRecord(reasoning)) return null
  const options: unknown[] = Array.isArray(reasoning.allowed_options) ? reasoning.allowed_options : []
  if (options.some((o) => o === 'low' || o === 'medium' || o === 'high')) return 'levels'
  if (options.includes('on') && options.includes('off')) return 'toggle'
  // It reasons, and LM Studio offers no way to turn that off.
  return 'always'
}

function lmStudioModels(endpoint: Where, json: unknown): DiscoveredModel[] {
  if (!isRecord(json) || !Array.isArray(json.models)) throw unreadable(endpoint)
  return json.models
    .filter((m): m is Record<string, unknown> & { key: string } => isRecord(m) && m.type === 'llm' && typeof m.key === 'string')
    .map((m) => {
      const caps = isRecord(m.capabilities) ? m.capabilities : {}
      const preset = thinkPresetOf(caps.reasoning)
      const instance: unknown = Array.isArray(m.loaded_instances) ? m.loaded_instances[0] : undefined
      const config = isRecord(instance) && isRecord(instance.config) ? instance.config : {}
      return {
        name: m.key,
        capabilities: [
          'completion',
          ...(caps.trained_for_tool_use === true ? ['tools'] : []),
          ...(caps.vision === true ? ['vision'] : []),
          ...(preset ? ['thinking'] : [])
        ],
        // The window it's loaded with; not loaded, it's unknown (FINDINGS Q6: max_context_length is only an upper
        // bound, and the next load may use far less).
        contextLength: num(config.context_length),
        parameterSize: typeof m.params_string === 'string' ? m.params_string : null,
        thinkPreset: preset,
        reportsCapabilities: true
      }
    })
}

function llamaCppModels(endpoint: Where, list: unknown, props: unknown): DiscoveredModel[] {
  const p = isRecord(props) ? props : null
  const settings = p && isRecord(p.default_generation_settings) ? p.default_generation_settings : {}
  // The window the server opened: newer builds put n_ctx under default_generation_settings, older ones at the top.
  // meta.n_ctx_train is only the most the model was trained for.
  const nCtx = num(settings.n_ctx) ?? num(p?.n_ctx)
  const caps = p && isRecord(p.chat_template_caps) ? p.chat_template_caps : {}
  // The key is common/jinja/caps.cpp's; a build that doesn't report it gets the default. Tools also need --jinja,
  // which the server's error names.
  const tools = typeof caps.supports_tool_calls === 'boolean' ? caps.supports_tool_calls : true
  const vision = p !== null && isRecord(p.modalities) && p.modalities.vision === true
  return dataOf(endpoint, list).map((m) => ({
    name: m.id,
    capabilities: ['completion', ...(tools ? ['tools'] : []), ...(vision ? ['vision'] : [])],
    contextLength: nCtx,
    parameterSize: paramsOf(num(isRecord(m.meta) ? m.meta.n_params : undefined)),
    thinkPreset: null,
    reportsCapabilities: p !== null
  }))
}

function vllmModels(endpoint: Where, list: unknown): DiscoveredModel[] {
  return dataOf(endpoint, list).map((m) => ({
    name: m.id,
    capabilities: [...DEFAULT_CAPABILITIES],
    contextLength: num(m.max_model_len),
    parameterSize: null,
    thinkPreset: null,
    reportsCapabilities: false
  }))
}

/** The chat models an endpoint offers, with what its server reports about each. Throws a friendly error when it can't. */
export async function discoverModels(endpoint: Endpoint, apiKey: string | null): Promise<DiscoveredModel[]> {
  const base = endpoint.baseUrl.replace(/\/+$/, '')
  const root = rootOf(base)
  switch (endpoint.flavor) {
    case 'lmstudio':
      return lmStudioModels(endpoint, await getJson(endpoint, `${root}/api/v1/models`, apiKey))
    case 'llamacpp': {
      // /props says what the loaded model can do; without it the defaults apply.
      const [list, props] = await Promise.all([
        getJson(endpoint, `${base}/models`, apiKey),
        getJson(endpoint, `${root}/props`, apiKey).catch(() => null)
      ])
      return llamaCppModels(endpoint, list, props)
    }
    case 'vllm':
      return vllmModels(endpoint, await getJson(endpoint, `${base}/models`, apiKey))
    default:
      return genericModels(endpoint, await getJson(endpoint, `${base}/models`, apiKey))
  }
}
