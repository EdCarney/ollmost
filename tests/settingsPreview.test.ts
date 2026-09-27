import { describe, expect, it } from 'vitest'
import { withPreview } from '../src/shared/settingsPreview'

const settings = {
  userName: 'Ed',
  appearance: { themeId: 'paper', mode: 'system', fontSize: 15, chatWidth: 720, responseFont: 'reading' },
  usage: { showInHeader: true, headerWindow: 'auto', anchors: { weekly: null }, monthlyDay: null, poolUsd: null }
}

describe('a settings preview', () => {
  it('lays the previewed values over the saved ones a section at a time, leaving the rest alone', () => {
    const out = withPreview(settings, { appearance: { themeId: 'ink', mode: 'dark' }, usage: { showInHeader: false } })
    expect(out.appearance).toEqual({ themeId: 'ink', mode: 'dark', fontSize: 15, chatWidth: 720, responseFont: 'reading' })
    expect(out.usage).toEqual({ ...settings.usage, showInHeader: false })
    expect(out.userName).toBe('Ed')
    // The saved settings aren't touched.
    expect(settings.appearance.themeId).toBe('paper')
  })

  it('goes as deep as the preview does, keeping siblings at every level', () => {
    const saved = { skills: { sources: { ollama: true, claude: false }, disabled: ['x'], autoLoad: true } }
    const out = withPreview(saved, { skills: { sources: { claude: true } } })
    expect(out.skills).toEqual({ sources: { ollama: true, claude: true }, disabled: ['x'], autoLoad: true })
  })

  it('is the saved settings themselves when there is no preview', () => {
    expect(withPreview(settings, null)).toBe(settings)
    expect(withPreview(settings, {})).toBe(settings)
  })
})
