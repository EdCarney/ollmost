import { describe, expect, it } from 'vitest'
import { settingsCommands, startIndex } from '../src/shared/paletteChoices'
import type { ModelInfo, Settings, ThemeDef } from '../src/shared/types'

const appearance: Settings['appearance'] = { themeId: 'clay', mode: 'system', fontSize: 15, chatWidth: 768, responseFont: 'reading' }
const settings = { appearance, defaultModel: null, endpoints: [], usage: { showInHeader: true } } as unknown as Settings
const themes = [
  { id: 'clay', name: 'Clay' },
  { id: 'nord', name: 'Nord' }
] as ThemeDef[]
const ollama = { id: 'ollama', name: 'Ollama', kind: 'ollama', flavor: 'ollama' } as const
const models = [
  { key: 'ollama/gpt-oss:120b-cloud', name: 'gpt-oss:120b-cloud', endpoint: ollama, where: 'cloud' },
  { key: 'ollama/gemma4:e4b', name: 'gemma4:e4b', endpoint: ollama, where: 'this-mac' }
] as ModelInfo[]

describe('where a list’s highlight starts (#146)', () => {
  const list = {
    choices: [
      { value: 'clay', label: 'Clay', patch: {} },
      { value: 'nord', label: 'Nord', patch: {} }
    ],
    current: 'nord'
  }
  it('opens a choice list on the value in force, or on nothing when it isn’t listed', () => {
    expect(startIndex(list, '')).toBe(1)
    expect(startIndex({ ...list, current: 'gone' }, '')).toBe(-1)
  })
  it('starts at the top when typing, and in the command list', () => {
    expect(startIndex(list, 'no')).toBe(0)
    expect(startIndex(null, '')).toBe(0)
    expect(startIndex(null, 'theme')).toBe(0)
  })
})

describe('the settings the palette offers choices for', () => {
  it('opens every list on the value in force, out of the box included', () => {
    for (const c of settingsCommands(settings, themes, models)) {
      const values = c.choices.map((x) => x.value)
      expect(values, c.title).toContain(c.current)
    }
    // A saved value off the list (a width off the grid, a theme or model no longer there) is added with its own patch.
    const odd = settingsCommands(
      { ...settings, appearance: { ...appearance, chatWidth: 768, themeId: 'gone' }, defaultModel: 'ollama/old-model:7b' } as Settings,
      themes,
      models
    )
    const byId = Object.fromEntries(odd.map((c) => [c.id, c]))
    expect(byId['chat-width'].choices.find((x) => x.value === '768')?.patch).toEqual({ appearance: { chatWidth: 768 } })
    expect(byId['theme'].choices.find((x) => x.value === 'gone')?.patch).toEqual({ appearance: { themeId: 'gone' } })
    expect(byId['default-model'].choices.find((x) => x.value === 'ollama/old-model:7b')).toMatchObject({
      label: 'old-model:7b',
      patch: { defaultModel: 'ollama/old-model:7b' }
    })
    expect(byId['default-model'].current).toBe('ollama/old-model:7b')
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
