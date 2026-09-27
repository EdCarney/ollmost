import { describe, expect, it } from 'vitest'
import { settingsCommands } from '../src/shared/paletteChoices'
import type { ModelInfo, Settings, ThemeDef } from '../src/shared/types'

const appearance: Settings['appearance'] = { themeId: 'clay', mode: 'system', fontSize: 15, chatWidth: 768, responseFont: 'reading' }
const settings = { appearance, defaultModel: null, usage: { showInHeader: true } } as Settings
const themes = [
  { id: 'clay', name: 'Clay' },
  { id: 'nord', name: 'Nord' }
] as ThemeDef[]
const models = [
  { name: 'gpt-oss:120b-cloud', location: 'cloud' },
  { name: 'gemma4:e4b', location: 'local' }
] as ModelInfo[]

describe('the settings the palette offers choices for', () => {
  it('opens every list on the value in force, out of the box included', () => {
    for (const c of settingsCommands(settings, themes, models)) {
      const values = c.choices.map((x) => x.value)
      expect(values, c.title).toContain(c.current)
    }
  })

  it('offers "Last used" for the default model, marks cloud models, and steps the chat width like the slider', () => {
    const byId = Object.fromEntries(settingsCommands(settings, themes, models).map((c) => [c.id, c]))
    expect(byId['default-model'].choices.map((x) => x.label)).toEqual(['Last used', 'gpt-oss:120b (cloud)', 'gemma4:e4b'])
    expect(byId['default-model'].current).toBe('')
    expect(byId['default-model'].choices[0].patch).toEqual({ defaultModel: null })
    const widths = byId['chat-width'].choices.map((x) => Number(x.value))
    expect(widths[0]).toBe(600)
    expect(widths.at(-1)).toBe(1100)
    expect(widths[1] - widths[0]).toBe(20)
    expect(widths).toContain(768)
  })
})
