import { getApiKey } from '../settings'
import { cloudUnreachableMessage } from '../providers/fetchFailure'
import { errorDetail, messageOf, OLLAMA_CLOUD, OllamaError } from '../providers/ollama/wire'
import { testOverride } from '../testOverrides'

// Tests point this at a mock server; never the shipped app, which sends the key here (#137).
const WEB_BASE = testOverride('OLLMOST_WEB_URL') ?? OLLAMA_CLOUD

export interface SearchResult {
  title: string
  url: string
  content: string
}

export interface FetchedPage {
  title: string
  content: string
  links: string[]
}

export const webEndpoint = (path: string): string => `${WEB_BASE}${path}`

export function webAvailable(): boolean {
  return getApiKey() !== null
}

const TIMEOUT_MS = 30_000

/**
 * Ollama's web search/fetch run on ollama.com (pages are fetched by Ollama, not this Mac) and are
 * authorised with the ollama.com API key, which stays in the main process.
 */
async function call<T>(path: string, body: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
  const key = getApiKey()
  if (!key) throw new OllamaError('Web tools need an ollama.com API key (Settings → Usage & cost).')
  let res: Response
  try {
    res = await fetch(`${WEB_BASE}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify(body),
      // Stopping the reply cancels the request instead of waiting out the timeout.
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)]) : AbortSignal.timeout(TIMEOUT_MS)
    })
  } catch (err) {
    if (signal?.aborted) throw err
    throw new OllamaError(cloudUnreachableMessage(err, TIMEOUT_MS / 1000), undefined, { cause: err })
  }
  if (res.status === 401 || res.status === 403) throw new OllamaError('ollama.com rejected the API key.', res.status)
  if (res.status === 429) throw new OllamaError('Web search limit reached on ollama.com. Try again later.', res.status)
  if (!res.ok) {
    const message = messageOf(errorDetail(await res.text().catch(() => '')))
    throw new OllamaError(message || `ollama.com answered HTTP ${res.status}.`, res.status)
  }
  try {
    return (await res.json()) as T
  } catch (err) {
    // A sign-in page or a changed API, not a connection problem. Anything else (a stop) goes through as it is.
    if (err instanceof SyntaxError) throw new OllamaError("ollama.com sent a reply Ollmost couldn't read.", undefined, { cause: err })
    throw err
  }
}

export async function webSearch(query: string, maxResults = 5, signal?: AbortSignal): Promise<SearchResult[]> {
  const n = Math.min(10, Math.max(1, Math.round(maxResults) || 5))
  const data = await call<{ results?: SearchResult[] }>('/api/web_search', { query, max_results: n }, signal)
  return (data.results ?? []).map((r) => ({ title: r.title ?? '', url: r.url ?? '', content: r.content ?? '' }))
}

export async function webFetch(url: string, signal?: AbortSignal): Promise<FetchedPage> {
  const data = await call<{ title?: string; content?: string; links?: string[] }>('/api/web_fetch', { url }, signal)
  return { title: data.title ?? '', content: data.content ?? '', links: Array.isArray(data.links) ? data.links : [] }
}
