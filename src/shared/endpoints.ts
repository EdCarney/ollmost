// What an endpoint is, as data both processes need: the defaults, and what an address says about a server.
import type { EndpointFlavor, ModelWhere } from './types'

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
