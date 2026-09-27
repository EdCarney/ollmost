// The settings the command palette offers choices for, as data: each choice carries the patch that saves it, and
// each list knows the value in force, so it opens there. Pure, so it can be tested without the app.
import type { DeepPartial } from './ipc'
import type { ModelInfo, Settings, ThemeDef } from './types'
import type { Rankable } from './palette'

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

/** "gpt-oss:120b-cloud" → "gpt-oss:120b", as the model picker shows it. */
const modelLabel = (m: ModelInfo) =>
  `${m.name.replace(/(:|-)cloud$/, '').replace(/:latest$/, '')}${m.location === 'cloud' ? ' (cloud)' : ''}`

/**
 * The value in force may be off the list (a saved width off the slider's grid, a theme no longer installed): it's
 * added, in order for numbers, so every list opens on what's in force and shows a check.
 */
function withCurrent(c: SettingsCommand, unit = ''): SettingsCommand {
  if (c.choices.some((x) => x.value === c.current)) return c
  const n = Number(c.current)
  const extra: Choice = {
    value: c.current,
    label: Number.isFinite(n) ? `${c.current}${unit}` : c.current,
    patch: c.choices[0]?.patch ?? {}
  }
  return { ...c, choices: [...c.choices, extra].sort((x, y) => Number(x.value) - Number(y.value)) }
}

export function settingsCommands(settings: Settings, themes: ThemeDef[], models: ModelInfo[]): SettingsCommand[] {
  const a = settings.appearance
  const appearance = (patch: Partial<Settings['appearance']>): DeepPartial<Settings> => ({ appearance: patch })
  const px = (key: 'fontSize' | 'chatWidth') => (c: SettingsCommand) => {
    const done = withCurrent(c, 'px')
    // The added value's patch must be its own.
    return {
      ...done,
      choices: done.choices.map((x) =>
        x.value === c.current && !c.choices.some((y) => y.value === c.current)
          ? { ...x, patch: appearance({ [key]: Number(c.current) }) }
          : x
      )
    }
  }
  const list: SettingsCommand[] = [
    {
      id: 'theme',
      title: 'Theme',
      group: 'Settings',
      keywords: ['colors', 'appearance'],
      current: a.themeId,
      choices: themes.map((t) => ({ value: t.id, label: t.name, patch: appearance({ themeId: t.id }) }))
    },
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
      choices: range(13, 20, 1).map((n) => ({ value: String(n), label: `${n}px`, patch: appearance({ fontSize: n }) }))
    },
    {
      id: 'chat-width',
      title: 'Chat width',
      group: 'Settings',
      keywords: ['narrow', 'wide', 'column'],
      current: String(a.chatWidth),
      // The same steps as the slider in Settings, so the value in force is always one of them.
      choices: range(600, 1100, 20).map((n) => ({ value: String(n), label: `${n}px`, patch: appearance({ chatWidth: n }) }))
    },
    {
      id: 'default-model',
      title: 'Default model',
      group: 'Settings',
      keywords: ['model', 'new chats'],
      current: settings.defaultModel ?? '',
      choices: [
        { value: '', label: 'Last used', patch: { defaultModel: null } },
        ...models.map((m) => ({ value: m.name, label: modelLabel(m), patch: { defaultModel: m.name } }))
      ]
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
  return list.map((c) =>
    c.id === 'font-size' ? px('fontSize')(c) : c.id === 'chat-width' ? px('chatWidth')(c) : c.id === 'theme' ? withTheme(c, a.themeId) : c
  )
}

/** A theme no longer installed still opens the list on itself, named by its id. */
function withTheme(c: SettingsCommand, themeId: string): SettingsCommand {
  if (c.choices.some((x) => x.value === themeId)) return c
  return { ...c, choices: [{ value: themeId, label: themeId, patch: { appearance: { themeId } } }, ...c.choices] }
}
