// The settings the command palette offers choices for, as data: each choice carries the patch that saves it, and
// each list knows the value in force, so it opens there. Pure, so it can be tested without the app.
import type { DeepPartial } from './ipc'
import { labelForKey, modelLabel } from './modelLabel'
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

/**
 * Where a list's highlight starts: on the value in force when a choice list opens (nothing highlighted, and nothing
 * previewed, if it isn't listed); at the top when typing, or in the command list. The palette sets it in the same
 * update as the list or the query it's for, never in an effect after it: the preview reads the highlighted row, and
 * a stale index for one render would put another choice on screen for a frame (#146).
 */
export function startIndex(choosing: { choices?: Choice[]; current?: string } | null, query: string): number {
  return choosing && !query ? (choosing.choices?.findIndex((c) => c.value === choosing.current) ?? -1) : 0
}

const range = (from: number, to: number, step: number) =>
  Array.from({ length: Math.floor((to - from) / step) + 1 }, (_, i) => from + i * step)

/** As the picker names it, with cloud models marked (the palette lists every endpoint's models together). */
const choiceLabel = (m: ModelInfo) => `${modelLabel(m)}${m.where === 'cloud' ? ' (cloud)' : ''}`

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
    ...(saved && !models.some((m) => m.key === saved)
      ? [{ value: saved, label: labelForKey(saved, settings.endpoints ?? []), patch: { defaultModel: saved } }]
      : []),
    ...models.map((m) => ({ value: m.key, label: choiceLabel(m), patch: { defaultModel: m.key } }))
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
