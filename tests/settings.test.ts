import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ safeStorage: { isEncryptionAvailable: () => false } }))

const { openDatabase } = await import('../src/main/db/index')
const { writeSetting } = await import('../src/main/db/kv')
const { getSettings } = await import('../src/main/settings')

describe('settings saved by an earlier version', () => {
  it('read what they lack from the defaults: sub-agents run 3 at once', () => {
    openDatabase(':memory:')
    // Saved before sub-agents could run at once, and read for the first time since.
    writeSetting('app', { userName: 'Ed', delegate: { enabled: false, maxRounds: 10 } })
    expect(getSettings().delegate).toEqual({ enabled: false, maxRounds: 10, parallel: 3 })
    expect(getSettings().userName).toBe('Ed')
  })
})
