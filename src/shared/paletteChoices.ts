// The settings the command palette offers choices for, as data: each choice carries the patch that saves it, and
// each list knows the value in force, so it opens there. Pure, so it can be tested without the app.
import type { DeepPartial } from './ipc'
import type { Rankable } from './palette'
import type { ModelInfo, Settings, ThemeDef } from './types'

/** One choice a settings command offers; `patch` is what choosing it saves (and what highlighting it previews). */
export interface Choice {
  value: string
  label: string
  patch: DeepPartial<Settings>
}

export interface SettingsCommand extends Rankable {
  group: 'Settings'
  choices: Choice[]
  /** The choice in force now, so the list starts on it. */
  current: string
}

const range = (from: number, to: number, step: number) =>
  Array.from({ length: Math.floor((to - from) / step) + 1 }, (_, i) => from + i * step)

/** "gpt-oss:120b-cloud" → "gpt-oss:120b", as the model picker shows it, with cloud models marked. */
const modelLabel = (m: ModelInfo) => `${m.name.replace(/(:|-)cloud$/, '').replace(/:latest$/, '')}${m.where === 'cloud' ? ' (cloud)' : ''}`

/**
 * Every list opens on the value in force with a check, so a saved value off a list (a width off the slider's grid,
 * 768 out of the box; a theme or model no longer there) is added with a patch of its own.
 */
export function settingsCommands(settings: Settings, themes: ThemeDef[], models: ModelInfo[]): SettingsCommand[] {
  const a = settings.appearance
  const appearance = (patch: Partial<Settings['appearance']>): DeepPartial<Settings> => ({ appearance: patch })
  const pixels = (key: 'fontSize' | 'chatWidth', from: number, to: number, step: number, current: number): Choice[] =>
    [...new Set([...range(from, to, step), current])]
      .sort((x, y) => x - y)
      .map((n) => ({ value: String(n), label: `${n}px`, patch: appearance({ [key]: n }) }))
  const themeChoices: Choice[] = [
    ...(themes.some((t) => t.id === a.themeId) ? [] : [{ value: a.themeId, label: a.themeId, patch: appearance({ themeId: a.themeId }) }]),
    ...themes.map((t) => ({ value: t.id, label: t.name, patch: appearance({ themeId: t.id }) }))
  ]
  const saved = settings.defaultModel
  const modelChoices: Choice[] = [
    { value: '', label: 'Last used', patch: { defaultModel: null } },
    ...(saved && !models.some((m) => m.name === saved) ? [{ value: saved, label: saved, patch: { defaultModel: saved } }] : []),
    ...models.map((m) => ({ value: m.name, label: modelLabel(m), patch: { defaultModel: m.name } }))
  ]
  return [
    { id: 'theme', title: 'Theme', group: 'Settings', keywords: ['colors', 'appearance'], current: a.themeId, choices: themeChoices },
    {
      id: 'mode',
      title: 'Appearance mode',
      group: 'Settings',
      keywords: ['light', 'dark', 'system'],
      current: a.mode,
      choices: (['system', 'light', 'dark'] as const).map((mode) => ({
        value: mode,
        label: mode[0].toUpperCase() + mode.slice(1),
        patch: appearance({ mode })
      }))
    },
    {
      id: 'font',
      title: 'Response font',
      group: 'Settings',
      keywords: ['serif', 'sans', 'reading'],
      current: a.responseFont,
      choices: [
        { value: 'reading', label: 'Serif', patch: appearance({ responseFont: 'reading' }) },
        { value: 'ui', label: 'Sans', patch: appearance({ responseFont: 'ui' }) }
      ]
    },
    {
      id: 'font-size',
      title: 'Text size',
      group: 'Settings',
      keywords: ['font size', 'bigger', 'smaller', 'zoom'],
      current: String(a.fontSize),
      choices: pixels('fontSize', 13, 20, 1, a.fontSize)
    },
    {
      id: 'chat-width',
      title: 'Chat width',
      group: 'Settings',
      keywords: ['narrow', 'wide', 'column'],
      current: String(a.chatWidth),
      // The slider's own 20 px steps, plus the saved width when it's off them.
      choices: pixels('chatWidth', 600, 1100, 20, a.chatWidth)
    },
    {
      id: 'default-model',
      title: 'Default model',
      group: 'Settings',
      keywords: ['model', 'new chats'],
      current: saved ?? '',
      choices: modelChoices
    },
    {
      id: 'usage-header',
      title: 'Usage in the title bar',
      group: 'Settings',
      keywords: ['quota', 'cost', 'tokens', 'chip'],
      current: settings.usage.showInHeader ? 'on' : 'off',
      choices: [
        { value: 'on', label: 'Shown', patch: { usage: { showInHeader: true } } },
        { value: 'off', label: 'Hidden', patch: { usage: { showInHeader: false } } }
      ]
    }
  ]
}
