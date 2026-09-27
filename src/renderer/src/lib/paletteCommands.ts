import type { DeepPartial } from '@shared/ipc'
import type { Rankable } from '@shared/palette'
import type { Settings } from '@shared/types'
import { api } from '@/lib/api'
import { openFolder } from '@/lib/codeActions'
import { displayModelName } from '@/lib/format'
import type { AppState, SettingsTab } from '@/stores/app'

/** One choice a settings command offers; `patch` is what choosing it saves (and what highlighting it previews). */
export interface Choice {
  value: string
  label: string
  patch: DeepPartial<Settings>
}

export type PaletteGroup = 'Actions' | 'Go to' | 'Settings'

/**
 * A command the palette can run: `run` does it at once; `choices` opens a list whose highlighted entry is
 * previewed live and saved on Enter (see `previewSettings` in the app store).
 */
export interface PaletteCommand extends Rankable {
  group: PaletteGroup
  run?: () => void | Promise<void>
  choices?: Choice[]
  /** The choice in force now, so the list starts on it. */
  current?: string
}

const RECENT_KEY = 'ollmost.palette.recent'
const RECENT_MAX = 8

/** Ids of the commands run most recently, newest first; a per-viewer convenience, so browser storage is fine. */
export function recentCommands(): string[] {
  try {
    const raw = localStorage.getItem(RECENT_KEY)
    const list = raw ? (JSON.parse(raw) as unknown) : []
    return Array.isArray(list) ? list.filter((x): x is string => typeof x === 'string') : []
  } catch {
    return []
  }
}

export function rememberCommand(id: string): void {
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify([id, ...recentCommands().filter((x) => x !== id)].slice(0, RECENT_MAX)))
  } catch {
    // Storage may be unavailable; recents are a convenience.
  }
}

const SETTINGS_TABS: Array<{ id: SettingsTab; label: string; keywords: string[] }> = [
  { id: 'general', label: 'General', keywords: ['name', 'preferences', 'connection', 'ollama'] },
  { id: 'appearance', label: 'Appearance', keywords: ['theme', 'font', 'dark', 'light', 'width'] },
  { id: 'models', label: 'Models', keywords: ['default model', 'context', 'catalog'] },
  { id: 'usage', label: 'Usage & cost', keywords: ['quota', 'spend', 'tokens', 'api key'] },
  { id: 'features', label: 'Features', keywords: ['artifacts', 'web', 'links', 'skills'] },
  { id: 'tools', label: 'Tools', keywords: ['mcp', 'code runner', 'code sessions', 'sandbox'] },
  { id: 'data', label: 'Data', keywords: ['export', 'folder', 'debug'] }
]

const range = (from: number, to: number, step: number) =>
  Array.from({ length: Math.floor((to - from) / step) + 1 }, (_, i) => from + i * step)

/** What the commands are built from: only these slices, so a preview (which changes the store) doesn't rebuild them. */
export type PaletteInput = Pick<AppState, 'settings' | 'themes' | 'models' | 'route' | 'navigate' | 'toggleSidebar'>

/** Every command the palette offers, built from the app's current state. */
export function paletteCommands(s: PaletteInput): PaletteCommand[] {
  const go = (route: Parameters<AppState['navigate']>[0]) => () => s.navigate(route)
  const a = s.settings?.appearance
  const commands: PaletteCommand[] = [
    { id: 'new-chat', title: 'New chat', group: 'Actions', keywords: ['start', 'home'], run: go({ name: 'home' }) },
    { id: 'new-session', title: 'New code session…', group: 'Actions', keywords: ['folder', 'open', 'repo'], run: () => openFolder() },
    { id: 'sidebar', title: 'Toggle sidebar', group: 'Actions', keywords: ['hide', 'show'], run: () => s.toggleSidebar() },
    {
      id: 'debugger',
      title: 'Open the debugger',
      group: 'Actions',
      keywords: ['requests', 'traces', 'replay'],
      run: () => api.debug.open(s.route.name === 'chat' || s.route.name === 'code' ? (s.route.id ?? null) : null)
    },
    { id: 'add-skill', title: 'Add a skill', group: 'Actions', keywords: ['import', 'marketplace'], run: go({ name: 'skills' }) },
    {
      id: 'add-mcp',
      title: 'Add an MCP server',
      group: 'Actions',
      keywords: ['tools', 'server'],
      run: go({ name: 'settings', tab: 'tools' })
    },
    { id: 'chats', title: 'Chats', group: 'Go to', run: go({ name: 'chats' }) },
    { id: 'projects', title: 'Projects', group: 'Go to', run: go({ name: 'projects' }) },
    { id: 'code', title: 'Code sessions', group: 'Go to', run: go({ name: 'code' }) },
    { id: 'artifacts', title: 'Artifacts', group: 'Go to', run: go({ name: 'artifacts' }) },
    { id: 'skills', title: 'Skills', group: 'Go to', run: go({ name: 'skills' }) },
    ...SETTINGS_TABS.map((t): PaletteCommand => ({
      id: `settings-${t.id}`,
      title: `Settings › ${t.label}`,
      group: 'Go to',
      keywords: ['settings', 'preferences', ...t.keywords],
      run: go({ name: 'settings', tab: t.id })
    }))
  ]
  if (!a) return commands
  const appearance = (patch: Partial<Settings['appearance']>): DeepPartial<Settings> => ({ appearance: patch })
  commands.push(
    {
      id: 'theme',
      title: 'Theme',
      group: 'Settings',
      keywords: ['colors', 'appearance', 'change theme'],
      current: a.themeId,
      choices: s.themes.map((t) => ({ value: t.id, label: t.name, patch: appearance({ themeId: t.id }) }))
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
      choices: range(600, 1100, 100).map((n) => ({ value: String(n), label: `${n}px`, patch: appearance({ chatWidth: n }) }))
    },
    {
      id: 'default-model',
      title: 'Default model',
      group: 'Settings',
      keywords: ['model', 'new chats'],
      current: s.settings?.defaultModel ?? undefined,
      choices: s.models.map((m) => ({ value: m.name, label: displayModelName(m.name), patch: { defaultModel: m.name } }))
    },
    {
      id: 'usage-header',
      title: 'Usage in the title bar',
      group: 'Settings',
      keywords: ['quota', 'cost', 'tokens', 'chip'],
      current: s.settings?.usage.showInHeader ? 'on' : 'off',
      choices: [
        { value: 'on', label: 'Shown', patch: { usage: { showInHeader: true } } },
        { value: 'off', label: 'Hidden', patch: { usage: { showInHeader: false } } }
      ]
    }
  )
  return commands
}
