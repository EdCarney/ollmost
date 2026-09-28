import { safeStorage } from 'electron'
import type { DeepPartial } from '@shared/ipc'
import { DEFAULT_THEME_ID } from '@shared/themes'
import type { Settings } from '@shared/types'
import { deleteSetting, readSetting, writeSetting } from './db/kv'

type StoredSettings = Omit<Settings, 'connection'> & { connection: Omit<Settings['connection'], 'hasApiKey'> }

/** How many sub-agents one reply may run at the same time, unless the user sets it (or their settings file has none). */
export const DEFAULT_SUB_AGENTS_AT_ONCE = 3

const DEFAULTS: StoredSettings = {
  userName: '',
  preferences: '',
  connection: { mode: 'local', host: 'http://127.0.0.1:11434' },
  defaultModel: null,
  titleModel: null,
  showCloudCatalog: true,
  localNumCtx: 32768,
  appearance: { themeId: DEFAULT_THEME_ID, mode: 'system', fontSize: 16, chatWidth: 768, responseFont: 'reading' },
  artifacts: { enabled: true, allowCdn: true },
  skills: { sources: { ollama: true, claude: true }, disabled: [], enabledImports: [], autoLoad: true },
  web: { enabled: true },
  runner: { mode: 'ask', defaultOn: false, pypi: false, timeoutSec: 120 },
  chat: { maxRounds: 20 },
  code: { edits: 'ask', commands: 'ask', timeoutSec: 300, maxRounds: 60, defaultNetwork: 'none' },
  delegate: { enabled: true, maxRounds: 20, parallel: DEFAULT_SUB_AGENTS_AT_ONCE },
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

let cache: StoredSettings | null = null

function stored(): StoredSettings {
  if (!cache) cache = deepMerge(DEFAULTS, readSetting<unknown>('app', {}))
  return cache
}

export function getSettings(): Settings {
  const s = stored()
  return { ...s, connection: { ...s.connection, hasApiKey: getApiKey() !== null } }
}

export function updateSettings(patch: DeepPartial<Settings>): Settings {
  const { connection, ...rest } = patch
  const conn = connection ? { mode: connection.mode, host: connection.host } : undefined
  cache = deepMerge(stored(), { ...rest, connection: conn })
  writeSetting('app', cache)
  return getSettings()
}

// The ollama.com API key never leaves the main process; at rest it is encrypted with the OS keychain.
export function setApiKey(key: string | null): void {
  if (!key) return deleteSetting('apiKey')
  if (!safeStorage.isEncryptionAvailable()) throw new Error('OS encryption is unavailable; cannot store the API key')
  writeSetting('apiKey', safeStorage.encryptString(key.trim()).toString('base64'))
}

export function getApiKey(): string | null {
  const enc = readSetting<string | null>('apiKey', null)
  if (!enc) return null
  try {
    return safeStorage.decryptString(Buffer.from(enc, 'base64'))
  } catch {
    return null
  }
}
