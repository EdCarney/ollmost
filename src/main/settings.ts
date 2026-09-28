import type { DeepPartial } from '@shared/ipc'
import { DEFAULT_NUM_CTX, DEFAULT_OLLAMA_URL, OLLAMA_CLOUD_URL } from '@shared/endpoints'
import { MIGRATED_ENDPOINT_ID, toModelKey } from '@shared/modelKey'
import { DEFAULT_THEME_ID } from '@shared/themes'
import type { Endpoint, Settings } from '@shared/types'
import { readSetting, writeSetting } from './db/kv'
import { endpointSecretName, getSecret, OLLAMA_ACCOUNT_SECRET, setSecret } from './providers/secrets'

/** An endpoint as stored: whether it has a key is read from the keychain rows each time, never saved. */
export type StoredEndpoint = Omit<Endpoint, 'hasKey'>
type StoredSettings = Omit<Settings, 'endpoints' | 'ollamaAccount'> & { endpoints: StoredEndpoint[] }

/** How many sub-agents one reply may run at the same time, unless the user sets it (or their settings file has none). */
export const DEFAULT_SUB_AGENTS_AT_ONCE = 3
/** How much of a sub-agent's reply comes back to the chat, in characters (about 4,000 words), unless the user sets it. */
export const DEFAULT_SUB_AGENT_REPLY_CHARS = 24_000

/** The endpoint a fresh install starts with. Its id is the one both migrations give every older model. */
export const DEFAULT_OLLAMA: StoredEndpoint = {
  id: MIGRATED_ENDPOINT_ID,
  name: 'Ollama',
  kind: 'ollama',
  flavor: 'ollama',
  baseUrl: DEFAULT_OLLAMA_URL,
  enabled: true,
  showCloudCatalog: true,
  numCtx: DEFAULT_NUM_CTX
}

const DEFAULTS: StoredSettings = {
  userName: '',
  preferences: '',
  endpoints: [DEFAULT_OLLAMA],
  defaultModel: null,
  titleModel: null,
  appearance: { themeId: DEFAULT_THEME_ID, mode: 'system', fontSize: 16, chatWidth: 768, responseFont: 'reading' },
  artifacts: { enabled: true, allowCdn: true },
  skills: { sources: { ollama: true, claude: true }, disabled: [], enabledImports: [], autoLoad: true },
  web: { enabled: true },
  runner: { mode: 'ask', defaultOn: false, pypi: false, timeoutSec: 120 },
  chat: { maxRounds: 20 },
  code: { edits: 'ask', commands: 'ask', timeoutSec: 300, maxRounds: 60, defaultNetwork: 'none' },
  delegate: { enabled: true, maxRounds: 20, parallel: DEFAULT_SUB_AGENTS_AT_ONCE, resultChars: DEFAULT_SUB_AGENT_REPLY_CHARS },
  debug: { record: true },
  links: { previews: false },
  usage: { showInHeader: true, headerWindow: 'auto', anchors: {}, monthlyDay: null, poolUsd: null }
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function deepMerge<T>(base: T, patch: unknown): T {
  if (!isPlainObject(base) || !isPlainObject(patch)) return (patch === undefined ? base : patch) as T
  const out: Record<string, unknown> = { ...base }
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue
    out[k] = k in base ? deepMerge((base as Record<string, unknown>)[k], v) : v
  }
  return out as T
}

type Legacy = { connection?: { mode?: string; host?: string }; showCloudCatalog?: boolean; localNumCtx?: number }

/**
 * Settings from before endpoints had one Ollama `connection`. It becomes the endpoint `ollama`, which the database
 * migration also puts every stored model on, and the default and title models become keys on it. A row that has
 * `endpoints` is left alone, so this runs once.
 */
export function migrateSettings(raw: Record<string, unknown>): { settings: Record<string, unknown>; migrated: boolean } {
  if (Array.isArray(raw.endpoints)) return { settings: raw, migrated: false }
  const { connection, showCloudCatalog, localNumCtx, ...rest } = raw as Legacy & Record<string, unknown>
  const endpoint: StoredEndpoint =
    connection?.mode === 'direct'
      ? { id: MIGRATED_ENDPOINT_ID, name: 'Ollama cloud', kind: 'ollama', flavor: 'ollama', baseUrl: OLLAMA_CLOUD_URL, enabled: true }
      : {
          ...DEFAULT_OLLAMA,
          baseUrl: (connection?.host || DEFAULT_OLLAMA_URL).replace(/\/+$/, ''),
          showCloudCatalog: showCloudCatalog ?? true,
          numCtx: localNumCtx ?? DEFAULT_NUM_CTX
        }
  const key = (model: unknown) => (typeof model === 'string' && model ? toModelKey(MIGRATED_ENDPOINT_ID, model) : null)
  return {
    settings: { ...rest, endpoints: [endpoint], defaultModel: key(rest.defaultModel), titleModel: key(rest.titleModel) },
    migrated: true
  }
}

let cache: StoredSettings | null = null

function stored(): StoredSettings {
  if (cache) return cache
  const raw = readSetting<unknown>('app', {})
  const { settings, migrated } = migrateSettings(isPlainObject(raw) ? raw : {})
  cache = deepMerge(DEFAULTS, settings)
  // Written at once: the migration is one-way, like the database's.
  if (migrated) writeSetting('app', cache)
  return cache
}

export function getSettings(): Settings {
  const { endpoints, ...s } = stored()
  return {
    ...s,
    endpoints: endpoints.map((e) => ({ ...e, hasKey: getSecret(endpointSecretName(e.id)) !== null })),
    ollamaAccount: { hasKey: getApiKey() !== null }
  }
}

/**
 * Everything but the endpoints and the account. Endpoints have their own calls (providers/endpoints.ts): the
 * deep-merge would take a partial list as the whole of it. The account's key is a keychain secret.
 */
export function updateSettings(patch: DeepPartial<Settings>): Settings {
  const { endpoints: _endpoints, ollamaAccount: _account, ...rest } = patch
  cache = deepMerge(stored(), rest)
  writeSetting('app', cache)
  return getSettings()
}

/** Replace the endpoint list as given; providers/endpoints.ts checks it first. A `hasKey` passed in is dropped. */
export function setEndpoints(list: Array<StoredEndpoint | Endpoint>): void {
  const endpoints = list.map((e) => {
    const { hasKey: _hasKey, ...rest } = e as Endpoint
    return rest
  })
  cache = { ...stored(), endpoints }
  writeSetting('app', cache)
}

/** A server rejected `stream_options`: stop sending it to this endpoint, across restarts too. */
export function setEndpointStreamOptions(id: string, supported: boolean): void {
  setEndpoints(stored().endpoints.map((e) => (e.id === id ? { ...e, streamOptions: supported } : e)))
}

// The ollama.com API key never leaves the main process; see providers/secrets.ts.
export function setApiKey(key: string | null): void {
  setSecret(OLLAMA_ACCOUNT_SECRET, key)
}

export function getApiKey(): string | null {
  return getSecret(OLLAMA_ACCOUNT_SECRET)
}
