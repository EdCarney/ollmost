import { type Rankable, settingsTabCommands } from '@shared/palette'
import { type Choice, settingsCommands } from '@shared/paletteChoices'
import { api } from '@/lib/api'
import { openFolder } from '@/lib/codeActions'
import { type AppState, debugTargetFor } from '@/stores/app'

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

/** What the commands are built from: only these slices, so a preview (which changes the store) doesn't rebuild them. */
export type PaletteInput = Pick<AppState, 'settings' | 'themes' | 'models' | 'route' | 'navigate' | 'toggleSidebar'>

/** Every command the palette offers, built from the app's current state. */
export function paletteCommands(s: PaletteInput): PaletteCommand[] {
  const go = (route: Parameters<AppState['navigate']>[0]) => () => s.navigate(route)
  const commands: PaletteCommand[] = [
    { id: 'new-chat', title: 'New chat', group: 'Actions', keywords: ['start', 'home'], run: go({ name: 'home' }) },
    { id: 'new-session', title: 'New code session…', group: 'Actions', keywords: ['folder', 'open', 'repo'], run: () => openFolder() },
    { id: 'sidebar', title: 'Toggle sidebar', group: 'Actions', keywords: ['hide', 'show'], run: () => s.toggleSidebar() },
    {
      id: 'debugger',
      title: 'Open the debugger',
      group: 'Actions',
      keywords: ['requests', 'traces', 'replay'],
      run: () => api.debug.open(debugTargetFor(s.route))
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
    ...settingsTabCommands().map(({ tab, ...c }): PaletteCommand => ({ ...c, group: 'Go to', run: go({ name: 'settings', tab }) }))
  ]
  if (s.settings) commands.push(...settingsCommands(s.settings, s.themes, s.models))
  return commands
}
