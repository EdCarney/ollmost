// Pure helpers for the debugger window: redaction, prompt anatomy and curl export, for both wire formats.
import { isOllamaCloudUrl } from './endpoints'
import type { Endpoint, TraceAuth, TraceDetail, TraceDialect } from './types'

const IMAGE_PLACEHOLDER = /^<image [\d.]+ KB>$/

/**
 * Whether a request to this address carries the ollama.com account key, by the rule the Ollama wire attaches it with
 * (adapter.ts's ollamaTarget): ollama.com itself, and only over https. (isOllamaCloudUrl parsed the URL, so reading
 * its protocol can't throw.)
 */
const carriesAccountKey = (url: string): boolean => isOllamaCloudUrl(url) && new URL(url).protocol === 'https:'

/** A size placeholder for base64 image data this many characters long. */
const placeholder = (base64Chars: number) => `<image ${((base64Chars * 3) / 4 / 1024).toFixed(0)} KB>`

/** Deep-copy a request body, replacing base64 images (Ollama's `images`, OpenAI's `image_url` data URLs) with a size placeholder. */
export function redactImages<T>(body: T): T {
  return JSON.parse(
    JSON.stringify(body, (key, value) => {
      if (key === 'images' && Array.isArray(value)) return value.map((img) => (typeof img === 'string' ? placeholder(img.length) : img))
      if (key === 'image_url' && typeof value?.url === 'string' && value.url.startsWith('data:'))
        return { ...value, url: placeholder(value.url.length - value.url.indexOf(',') - 1) }
      return value
    })
  ) as T
}

const isPlaceholderPart = (part: unknown): boolean => {
  const p = part as { type?: unknown; image_url?: { url?: unknown } } | null
  return p?.type === 'image_url' && typeof p.image_url?.url === 'string' && IMAGE_PLACEHOLDER.test(p.image_url.url)
}

/** Drop redacted image placeholders so a recorded request can be replayed. */
export function stripImagePlaceholders<T>(body: T): { body: T; removed: number } {
  let removed = 0
  const clean = JSON.parse(
    JSON.stringify(body, (key, value) => {
      if (key === 'images' && Array.isArray(value)) {
        const kept = value.filter((img) => !(typeof img === 'string' && IMAGE_PLACEHOLDER.test(img)))
        removed += value.length - kept.length
        return kept.length ? kept : undefined
      }
      if (key === 'content' && Array.isArray(value)) {
        const kept = value.filter((part) => !isPlaceholderPart(part))
        removed += value.length - kept.length
        return kept
      }
      return value
    })
  ) as T
  return { body: clean, removed }
}

export interface TraceTarget {
  dialect: TraceDialect
  auth: TraceAuth
  endpointId: string
  endpointName: string
}

/** What a trace records about where its request went: the wire format, which key it carried (never the key), the endpoint. */
export function traceTarget(endpoint: Pick<Endpoint, 'id' | 'name' | 'kind' | 'baseUrl' | 'hasKey'>): TraceTarget {
  // An Ollama endpoint on ollama.com is sent the account key (over https) and never a key of its own.
  const cloud = endpoint.kind === 'ollama' && isOllamaCloudUrl(endpoint.baseUrl)
  return {
    dialect: endpoint.kind,
    auth: cloud ? (carriesAccountKey(endpoint.baseUrl) ? 'ollama.com' : null) : endpoint.hasKey ? 'endpoint' : null,
    endpointId: endpoint.id,
    endpointName: endpoint.name
  }
}

/**
 * A stored trace's target. Traces recorded before endpoints have none and read as Ollama's, except an OpenAI-compatible
 * request recorded before traces kept their dialect (PR 3's), told by its address: {baseUrl}/chat/completions.
 */
export function storedTraceTarget(data: {
  endpoint?: string
  dialect?: TraceDialect
  auth?: TraceAuth
  endpointId?: string | null
  endpointName?: string | null
}): Pick<TraceDetail, 'dialect' | 'auth' | 'endpointId' | 'endpointName'> {
  return {
    dialect: data.dialect ?? (data.endpoint?.endsWith('/chat/completions') ? 'openai' : 'ollama'),
    // Before endpoints, only a request to ollama.com carried a key: the account's. Whether one of PR 3's OpenAI requests
    // carried its endpoint's key wasn't recorded, and reads as none.
    auth: data.auth !== undefined ? data.auth : carriesAccountKey(data.endpoint ?? '') ? 'ollama.com' : null,
    endpointId: data.endpointId ?? null,
    endpointName: data.endpointName ?? null
  }
}

/** One message of a recorded request, read the same way whichever wire format it used. */
export interface TraceMessage {
  role: string
  text: string
  thinking: string
  /** Image placeholders (or, unredacted, the data). */
  images: string[]
  toolCalls: unknown[] | null
  /** For a tool result: the tool it answers. */
  toolName: string | null
}

export function traceMessages(body: { messages?: unknown[] }, dialect: TraceDialect): TraceMessage[] {
  // OpenAI tool results carry the call's id; the name comes from the assistant message that made the call.
  const callNames = new Map<string, string>()
  return (body.messages ?? []).map((raw) => {
    const m = (raw ?? {}) as Record<string, unknown>
    const toolCalls = Array.isArray(m.tool_calls) && m.tool_calls.length ? (m.tool_calls as unknown[]) : null
    const role = String(m.role ?? 'other')
    if (dialect === 'openai') {
      for (const c of toolCalls ?? []) {
        const call = c as { id?: unknown; function?: { name?: unknown } }
        if (typeof call.id === 'string' && typeof call.function?.name === 'string') callNames.set(call.id, call.function.name)
      }
      const parts = Array.isArray(m.content) ? (m.content as Array<Record<string, unknown>>) : null
      return {
        role,
        text: parts
          ? parts
              .filter((p) => p?.type === 'text')
              .map((p) => String(p.text ?? ''))
              .join('\n')
          : typeof m.content === 'string'
            ? m.content
            : '',
        thinking: '',
        images: parts ? parts.filter((p) => p?.type === 'image_url').map((p) => String((p.image_url as { url?: unknown })?.url ?? '')) : [],
        toolCalls,
        toolName: typeof m.tool_call_id === 'string' ? (callNames.get(m.tool_call_id) ?? m.tool_call_id) : null
      }
    }
    return {
      role,
      text: typeof m.content === 'string' ? m.content : '',
      thinking: typeof m.thinking === 'string' ? m.thinking : '',
      images: Array.isArray(m.images) ? m.images.map(String) : [],
      toolCalls,
      toolName: typeof m.tool_name === 'string' ? m.tool_name : null
    }
  })
}

const estimate = (text: string) => Math.ceil(text.length / 4)
const IMAGE_TOKENS = 1600

export interface AnatomySegment {
  label: string
  group: 'system' | 'history' | 'latest' | 'tools' | 'images'
  tokens: number
}

const SECTION_LABELS: Record<string, string> = {
  user_preferences: 'Your preferences',
  project: 'Project instructions',
  project_knowledge: 'Project knowledge',
  artifacts: 'Artifact instructions',
  web: 'Web tool guidance',
  skills: 'Skill index',
  loaded_skills: 'Loaded skills',
  selected_skills: 'Selected skills'
}

interface BodyLike {
  messages?: unknown[]
  tools?: unknown[]
}

/**
 * Where a request's tokens go, estimated at ~4 characters per token (the same heuristic Ollmost uses
 * for trimming history). Compare the total with the server's prompt token count for the real number.
 */
export function promptAnatomy(body: BodyLike, dialect: TraceDialect = 'ollama'): { segments: AnatomySegment[]; total: number } {
  const segments: AnatomySegment[] = []
  const messages = traceMessages(body, dialect)
  const system = messages.find((m) => m.role === 'system')?.text ?? ''
  let rest = system
  for (const m of system.matchAll(/<([a-z_]+)(?:\s[^>]*)?>[\s\S]*?<\/\1>/g)) {
    segments.push({ label: SECTION_LABELS[m[1]] ?? `<${m[1]}>`, group: 'system', tokens: estimate(m[0]) })
    rest = rest.replace(m[0], '')
  }
  if (rest.trim()) segments.unshift({ label: 'Base instructions', group: 'system', tokens: estimate(rest) })

  const convo = messages.filter((m) => m.role !== 'system')
  const lastUser = convo.map((m) => m.role).lastIndexOf('user')
  const byRole = new Map<string, number>()
  let latest = 0
  let latestHasTools = false
  let images = 0
  convo.forEach((m, i) => {
    const t = estimate(m.text + m.thinking + (m.toolCalls ? JSON.stringify(m.toolCalls) : ''))
    images += m.images.length
    if (i >= lastUser && lastUser >= 0) {
      latest += t
      if (m.role === 'tool') latestHasTools = true
    } else byRole.set(m.role, (byRole.get(m.role) ?? 0) + t)
  })
  for (const [role, tokens] of byRole)
    segments.push({ label: role === 'tool' ? 'Earlier tool results' : `Earlier ${role} messages`, group: 'history', tokens })
  if (lastUser >= 0)
    segments.push({ label: latestHasTools ? 'Latest message + tool results' : 'Latest message', group: 'latest', tokens: latest })
  if (body.tools?.length)
    segments.push({ label: `Tool definitions (${body.tools.length})`, group: 'tools', tokens: estimate(JSON.stringify(body.tools)) })
  if (images) segments.push({ label: `Images (${images})`, group: 'images', tokens: images * IMAGE_TOKENS })

  const kept = segments.filter((s) => s.tokens > 0)
  return { segments: kept, total: kept.reduce((n, s) => n + s.tokens, 0) }
}

/**
 * The environment variable Copy as curl reads a key from: $OLLAMA_API_KEY for ollama.com, $<ENDPOINT_ID>_API_KEY for
 * an endpoint's own key (upper case, anything but a letter, digit or '_' as '_', and a leading '_' when the id starts
 * with a digit, which a shell variable can't). Ids are made of [a-z0-9-], but the name goes inside double quotes, where
 * a hand-edited id's $( ` or " would be acted on when the command is pasted.
 */
export function curlKeyVar(t: Pick<TraceDetail, 'auth' | 'endpointId'>): string | null {
  if (t.auth === 'ollama.com') return 'OLLAMA_API_KEY'
  if (t.auth !== 'endpoint') return null
  const id = (t.endpointId ?? 'endpoint').toUpperCase().replace(/[^A-Z0-9_]/g, '_')
  const name = `${/^\d/.test(id) ? '_' : ''}${id}_API_KEY`
  // $OLLAMA_API_KEY holds the ollama.com key, which goes only to ollama.com: endpoint `ollama`'s own key reads another.
  return name === 'OLLAMA_API_KEY' ? 'OLLAMA_ENDPOINT_API_KEY' : name
}

/** A word a POSIX shell reads as written: in single quotes, each ' closing them for an escaped one. */
const shellQuote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`

/**
 * A curl command that reproduces the request (non-streaming). The API key is never embedded. The address is quoted:
 * its path is kept as typed and may hold what a shell acts on, and zsh reads an unquoted [::1] as a glob.
 */
export function toCurl(endpoint: string, body: unknown, keyVar: string | null): string {
  const { body: clean, removed } = stripImagePlaceholders(body)
  // One request, not a stream: stream_options is only allowed with a stream.
  const { stream_options: _options, ...rest } = (clean ?? {}) as Record<string, unknown>
  const payload = JSON.stringify({ ...rest, stream: false }, null, 2)
  const auth = keyVar ? ` \\\n  -H "Authorization: Bearer $${keyVar}"` : ''
  // A `:` line of plain words, not a # comment: an interactive zsh reads # as a word unless interactivecomments is on,
  // and an apostrophe would then open a quote that swallows the curl line.
  const note = !removed
    ? ''
    : removed === 1
      ? ': 1 image was not recorded and is left out.\n'
      : `: ${removed} images were not recorded and are left out.\n`
  return `${note}curl ${shellQuote(endpoint)} \\\n  -H 'Content-Type: application/json'${auth} \\\n  -d @- <<'JSON'\n${payload}\nJSON`
}
