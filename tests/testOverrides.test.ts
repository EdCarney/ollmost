import { describe, expect, it, vi } from 'vitest'

// The shipped app stands in: these knobs must do nothing there (#137).
vi.mock('electron', () => ({ app: { isPackaged: true } }))

const { testOverride } = await import('../src/main/testOverrides')

describe('test-only environment overrides', () => {
  it('apply in an unpackaged build only: the shipped app ignores them', () => {
    const env = { OLLMOST_WEB_URL: 'http://127.0.0.1:1' }
    expect(testOverride('OLLMOST_WEB_URL', false, env)).toBe('http://127.0.0.1:1')
    expect(testOverride('OLLMOST_WEB_URL', true, env)).toBeUndefined()
    expect(testOverride('OLLMOST_WEB_URL', false, {})).toBeUndefined()
  })

  it('read whether the app is packaged from Electron', () => {
    expect(testOverride('OLLMOST_WEB_URL', undefined, { OLLMOST_WEB_URL: 'http://127.0.0.1:1' })).toBeUndefined()
  })
})
