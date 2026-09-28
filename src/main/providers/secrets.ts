import { safeStorage } from 'electron'
import { deleteSetting, readSetting, writeSetting } from '../db/kv'

// Keys never leave the main process. At rest each one is encrypted with the OS keychain, in a kv row of its own.

/** The ollama.com account key (web tools, quota, an Ollama endpoint on ollama.com), in the row it always had. */
export const OLLAMA_ACCOUNT_SECRET = 'apiKey'

/** The row an endpoint's own key lives in. */
export function endpointSecretName(id: string): string {
  return `endpointKey:${id}`
}

/** Store a secret, or delete it when `value` is null or empty. */
export function setSecret(name: string, value: string | null): void {
  if (!value) return deleteSetting(name)
  if (!safeStorage.isEncryptionAvailable()) throw new Error('OS encryption is unavailable; cannot store the API key')
  writeSetting(name, safeStorage.encryptString(value.trim()).toString('base64'))
}

/** A stored secret, or null when there is none or this keychain can't open it (a database from another Mac). */
export function getSecret(name: string): string | null {
  const enc = readSetting<string | null>(name, null)
  if (!enc) return null
  try {
    return safeStorage.decryptString(Buffer.from(enc, 'base64'))
  } catch {
    return null
  }
}
