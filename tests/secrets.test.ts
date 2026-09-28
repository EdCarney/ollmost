import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

// A stand-in keychain: "sealed:" marks what it encrypted, and it refuses anything else.
const keychain = vi.hoisted(() => ({ available: true }))
vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: () => keychain.available,
    encryptString: (s: string) => Buffer.from(`sealed:${s}`),
    decryptString: (b: Buffer) => {
      const s = b.toString()
      if (!s.startsWith('sealed:')) throw new Error('not sealed here')
      return s.slice('sealed:'.length)
    }
  }
}))

const { openDatabase } = await import('../src/main/db/index')
const { readSetting, writeSetting } = await import('../src/main/db/kv')
const { endpointSecretName, getSecret, OLLAMA_ACCOUNT_SECRET, setSecret } = await import('../src/main/providers/secrets')
const { getApiKey, setApiKey } = await import('../src/main/settings')

beforeAll(() => openDatabase(':memory:'))
beforeEach(() => {
  keychain.available = true
})

describe('secrets', () => {
  it('names an endpoint key by its endpoint, and keeps the ollama.com key in the row it always had', () => {
    expect(endpointSecretName('lm-studio')).toBe('endpointKey:lm-studio')
    expect(OLLAMA_ACCOUNT_SECRET).toBe('apiKey')
  })

  it('stores a secret encrypted and trimmed, and reads it back', () => {
    setSecret('endpointKey:lm-studio', '  sk-local  ')
    expect(readSetting<string | null>('endpointKey:lm-studio', null)).toBe(Buffer.from('sealed:sk-local').toString('base64'))
    expect(getSecret('endpointKey:lm-studio')).toBe('sk-local')
  })

  it('deletes a secret set to null or empty', () => {
    setSecret('endpointKey:a', 'k')
    setSecret('endpointKey:a', null)
    expect(readSetting<string | null>('endpointKey:a', null)).toBeNull()
    setSecret('endpointKey:b', 'k')
    setSecret('endpointKey:b', '')
    expect(getSecret('endpointKey:b')).toBeNull()
  })

  it('reads a row this keychain cannot open as no secret', () => {
    writeSetting('endpointKey:c', Buffer.from('another Mac').toString('base64'))
    expect(getSecret('endpointKey:c')).toBeNull()
  })

  it('refuses to store a secret without OS encryption', () => {
    keychain.available = false
    expect(() => setSecret('endpointKey:d', 'k')).toThrow('OS encryption is unavailable; cannot store the API key')
    expect(getSecret('endpointKey:d')).toBeNull()
  })

  it('is what the settings API key reads and writes', () => {
    setApiKey('ollama-key')
    expect(getSecret(OLLAMA_ACCOUNT_SECRET)).toBe('ollama-key')
    setSecret(OLLAMA_ACCOUNT_SECRET, 'rotated')
    expect(getApiKey()).toBe('rotated')
    setApiKey(null)
    expect(getSecret(OLLAMA_ACCOUNT_SECRET)).toBeNull()
  })
})
