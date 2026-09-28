// What an endpoint is, as data both processes need: the defaults, and what an address says about a server.
import { formatContext } from './format'
import type { EndpointFlavor, EndpointProbe, ModelWhere } from './types'

export const OLLAMA_CLOUD_URL = 'https://ollama.com'
export const DEFAULT_OLLAMA_URL = 'http://127.0.0.1:11434'
/** Ollama's num_ctx for an endpoint that hasn't set one: what local models got before endpoints. */
export const DEFAULT_NUM_CTX = 32_768
/** The window assumed for an OpenAI-compatible model when nothing reports one. */
export const DEFAULT_CONTEXT = 8_192

export const FLAVOR_LABELS: Record<EndpointFlavor, string> = {
  ollama: 'Ollama',
  lmstudio: 'LM Studio',
  llamacpp: 'llama.cpp',
  vllm: 'vLLM',
  generic: 'OpenAI-compatible'
}

function hostnameOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase()
  } catch {
    return null
  }
}

/** ollama.com itself (Ollama's cloud API), as opposed to an Ollama app somewhere. */
export const isOllamaCloudUrl = (url: string): boolean => hostnameOf(url) === 'ollama.com'

/** A hostname for this Mac. URL keeps an IPv6 address's brackets. */
export const isLoopbackHost = (hostname: string): boolean => ['localhost', '127.0.0.1', '[::1]'].includes(hostname)

/** Where a server runs, by its address: this Mac for a loopback address, another machine for anything else. */
export function whereOf(baseUrl: string): Exclude<ModelWhere, 'cloud'> {
  const host = hostnameOf(baseUrl)
  return host !== null && isLoopbackHost(host) ? 'this-mac' : 'network'
}

/** An address as headings and errors show it: host, port, and a path other than a trailing /v1. */
export function displayAddress(baseUrl: string): string {
  try {
    const url = new URL(baseUrl)
    return `${url.host}${url.pathname.replace(/\/+$/, '').replace(/\/v1$/, '')}`
  } catch {
    return baseUrl
  }
}

const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`

/** What checking an address found, in one line: "Found LM Studio 0.4 · 5 models · 4 with tools · 1 with vision · 2 can think". */
export function probeSummary(p: EndpointProbe): string {
  const server = p.kind === 'ollama' ? 'Ollama' : p.flavor === 'generic' ? 'an OpenAI-compatible server' : FLAVOR_LABELS[p.flavor]
  const parts = [`Found ${server}${p.version ? ` ${p.version}` : ''}`, count(p.models, 'model', 'models')]
  // Ollama reports each model's capabilities when it's listed, so its probe doesn't count them.
  if (p.kind === 'openai')
    parts.push(
      ...(p.reportsCapabilities
        ? [`${p.withTools} with tools`, `${p.withVision} with vision`, `${p.canThink} can think`]
        : ['capabilities not reported — defaults apply (tools on, vision off)'])
    )
  return parts.join(' · ')
}

/** Where the dialog says its models' context sizes will come from. */
export function probeContextNote(p: Pick<EndpointProbe, 'reportsContext'>): string {
  return p.reportsContext
    ? 'Context sizes reported by the server'
    : `Context sizes not reported — models get ${formatContext(DEFAULT_CONTEXT)} unless you change “Context when not reported”`
}

/** A name for a new endpoint: its server's, numbered when another endpoint has it. */
export function suggestEndpointName(p: Pick<EndpointProbe, 'flavor'>, taken: readonly string[]): string {
  const base = FLAVOR_LABELS[p.flavor]
  if (!taken.includes(base)) return base
  let n = 2
  while (taken.includes(`${base} ${n}`)) n++
  return `${base} ${n}`
}

/** The question before an endpoint is removed: what goes (the confirm-before-loss rule). */
export function removalText(
  name: string,
  impact: { chats: number; hasKey: boolean; overrides: number }
): { title: string; body: string[] } {
  const chats =
    impact.chats === 0
      ? 'No chats use its models.'
      : impact.chats === 1
        ? '1 chat uses its models; it keeps its history but needs a new model picked.'
        : `${impact.chats} chats use its models; they keep their history but need a new model picked.`
  const gone =
    impact.hasKey && impact.overrides
      ? 'Its API key and model settings are deleted.'
      : impact.hasKey
        ? 'Its API key is deleted.'
        : impact.overrides
          ? 'Its model settings are deleted.'
          : null
  return { title: `Remove ${name}?`, body: gone ? [chats, gone] : [chats] }
}
