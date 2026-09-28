import { DEFAULT_NUM_CTX, isOllamaCloudUrl } from '@shared/endpoints'
import { keyPrefix, slugEndpointId } from '@shared/modelKey'
import type { Endpoint, EndpointFlavor, EndpointKind, EndpointProbe } from '@shared/types'
import { get } from '../db/index'
import { countEndpointOverrides, deleteEndpointProfiles } from '../db/kv'
import { getSettings, setEndpoints, type StoredEndpoint, updateSettings } from '../settings'
import { normalizeBaseUrl, probeEndpoint, sameServer } from './probe'
import { invalidateProviders } from './registry'
import { endpointSecretName, setSecret } from './secrets'

// Endpoints change only here, never through a settings update. Everything the renderer sends is checked: it may
// send anything.

type EndpointPatch = Partial<Pick<Endpoint, 'name' | 'baseUrl' | 'enabled' | 'flavor' | 'showCloudCatalog' | 'numCtx' | 'defaultContext'>>

const FLAVORS: readonly EndpointFlavor[] = ['ollama', 'lmstudio', 'llamacpp', 'vllm', 'generic']

const stored = (): StoredEndpoint[] =>
  getSettings().endpoints.map((e) => {
    const { hasKey: _hasKey, ...rest } = e
    return rest
  })

function find(id: string): Endpoint {
  const endpoint = getSettings().endpoints.find((e) => e.id === id)
  if (!endpoint) throw new Error('That endpoint no longer exists.')
  return endpoint
}

function save(list: StoredEndpoint[], id: string): Endpoint {
  setEndpoints(list)
  invalidateProviders()
  return find(id)
}

function cleanName(name: unknown): string {
  const trimmed = typeof name === 'string' ? name.trim() : ''
  if (!trimmed) throw new Error('Give the endpoint a name.')
  return trimmed.slice(0, 60)
}

function tokens(value: unknown, what: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 512 || value > 4_194_304)
    throw new Error(`${what} must be a whole number of tokens.`)
  return value
}

/** Refuse an address another endpoint has. localhost, 127.0.0.1 and [::1] are one server. */
export function assertAddressFree(baseUrl: string, exceptId?: string): void {
  const taken = getSettings().endpoints.find((e) => e.id !== exceptId && sameServer(e.baseUrl, baseUrl))
  if (taken) throw new Error(`${taken.name} already uses this address.`)
}

/** Check an address before it's added: refused at once if it's taken, then asked what it is. */
export async function probeNewEndpoint(input: { baseUrl: string; apiKey?: string }): Promise<EndpointProbe> {
  assertAddressFree(normalizeBaseUrl(String(input.baseUrl)))
  return probeEndpoint(String(input.baseUrl), typeof input.apiKey === 'string' ? input.apiKey : undefined)
}

export function addEndpoint(input: {
  name: string
  baseUrl: string
  kind: EndpointKind
  flavor: EndpointFlavor
  apiKey?: string
}): Endpoint {
  if (input.kind !== 'ollama') throw new Error('Ollmost can’t talk to OpenAI-compatible servers yet. That arrives in the next update.')
  const name = cleanName(input.name)
  const baseUrl = normalizeBaseUrl(String(input.baseUrl))
  assertAddressFree(baseUrl)
  const list = stored()
  const id = slugEndpointId(
    name,
    list.map((e) => e.id)
  )
  // A second Ollama starts without the cloud catalog, so ollama.com's models aren't listed twice.
  const endpoint: StoredEndpoint = {
    id,
    name,
    kind: 'ollama',
    flavor: 'ollama',
    baseUrl,
    enabled: true,
    showCloudCatalog: false,
    numCtx: DEFAULT_NUM_CTX
  }
  // ollama.com takes the account key; an endpoint key is never kept for it.
  const key = typeof input.apiKey === 'string' ? input.apiKey.trim() : ''
  if (key && !isOllamaCloudUrl(baseUrl)) setSecret(endpointSecretName(id), key)
  return save([...list, endpoint], id)
}

/** Change an endpoint. Its id never changes, so a server that moves keeps its chats. */
export function updateEndpoint(id: string, patch: EndpointPatch): Endpoint {
  const list = stored()
  const i = list.findIndex((e) => e.id === id)
  if (i < 0) throw new Error('That endpoint no longer exists.')
  const next: StoredEndpoint = { ...list[i] }
  if (patch.name !== undefined) next.name = cleanName(patch.name)
  if (patch.baseUrl !== undefined) {
    next.baseUrl = normalizeBaseUrl(String(patch.baseUrl))
    assertAddressFree(next.baseUrl, id)
  }
  if (patch.enabled !== undefined) next.enabled = patch.enabled === true
  if (patch.flavor !== undefined && next.kind === 'openai' && FLAVORS.includes(patch.flavor)) next.flavor = patch.flavor
  if (patch.showCloudCatalog !== undefined && next.kind === 'ollama') next.showCloudCatalog = patch.showCloudCatalog === true
  if (patch.numCtx !== undefined && next.kind === 'ollama') next.numCtx = tokens(patch.numCtx, 'The context window')
  if (patch.defaultContext !== undefined && next.kind === 'openai') next.defaultContext = tokens(patch.defaultContext, 'The context size')
  list[i] = next
  return save(list, id)
}

/** What removing an endpoint loses, for the question asked first. */
export function endpointRemovalImpact(id: string): { chats: number; hasKey: boolean; overrides: number } {
  const endpoint = find(id)
  const chats = get<{ n: number }>('SELECT COUNT(*) AS n FROM conversations WHERE model LIKE ?', `${id}/%`)?.n ?? 0
  return { chats, hasKey: endpoint.hasKey, overrides: countEndpointOverrides(id) }
}

/** Remove an endpoint with its key and its models' settings. Its chats keep their history and need a new model. */
export function removeEndpoint(id: string): void {
  find(id)
  setSecret(endpointSecretName(id), null)
  deleteEndpointProfiles(id)
  setEndpoints(stored().filter((e) => e.id !== id))
  // A default that named one of its models would name a model that can't be reached. Only a key whose prefix is
  // this endpoint's id counts: splitModelKey/registry.resolve are the only places a key is otherwise taken apart.
  const s = getSettings()
  const on = (key: string | null) => key !== null && keyPrefix(key) === id
  if (on(s.defaultModel) || on(s.titleModel))
    updateSettings({ ...(on(s.defaultModel) && { defaultModel: null }), ...(on(s.titleModel) && { titleModel: null }) })
  invalidateProviders()
}

export function setEndpointKey(id: string, key: string | null): Endpoint {
  const endpoint = find(id)
  if (isOllamaCloudUrl(endpoint.baseUrl))
    throw new Error('This endpoint uses your ollama.com account key. Set it under ollama.com account in Settings → Models.')
  setSecret(endpointSecretName(id), typeof key === 'string' ? key.trim() || null : null)
  invalidateProviders()
  return find(id)
}
