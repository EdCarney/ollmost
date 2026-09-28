import { create } from 'zustand'
import type { DeepPartial } from '@shared/ipc'
import type { SettingsTabId } from '@shared/palette'
import { defaultThinkSetting, resolveThinkProfile } from '@shared/thinking'
import type {
  Conversation,
  Endpoint,
  McpServer,
  McpStatus,
  ModelInfo,
  ModelListResult,
  Project,
  Settings,
  Skill,
  ThemeDef,
  ThinkProfile,
  ThinkSetting
} from '@shared/types'
import { api } from '@/lib/api'

export type SettingsTab = SettingsTabId

export type Route =
  | { name: 'home' }
  | { name: 'chat'; id: string }
  | { name: 'chats' }
  | { name: 'code'; id?: string }
  | { name: 'projects' }
  | { name: 'project'; id: string }
  | { name: 'artifacts' }
  | { name: 'skills'; id?: string }
  | { name: 'settings'; tab?: SettingsTab }

/** The chat or session a debugger opened from a route should show; null elsewhere. */
export const debugTargetFor = (route: Route): string | null => (route.name === 'chat' || route.name === 'code' ? (route.id ?? null) : null)

export interface Toast {
  id: number
  message: string
  kind: 'info' | 'error'
}

export interface AppState {
  route: Route
  navigate: (route: Route) => void

  sidebarOpen: boolean
  toggleSidebar: () => void
  searchOpen: boolean
  setSearchOpen: (open: boolean) => void

  settings: Settings | null
  loadSettings: () => Promise<void>
  updateSettings: (patch: DeepPartial<Settings>) => Promise<void>

  models: ModelInfo[]
  /** Endpoints that couldn't list their models this time, and why. */
  modelErrors: ModelListResult['errors']
  modelsLoading: boolean
  /** The first listing has finished: before it, a chat's model can't be told from a missing one. */
  modelsReady: boolean
  loadModels: (refresh?: boolean) => Promise<void>
  /** An endpoint was added, changed or removed: the endpoint list (in settings) and the models again. */
  endpointsChanged: () => Promise<void>

  /** Model (a key) + thinking choice for chats that don't exist yet. */
  draftModel: string | null
  draftThink: ThinkSetting | null
  setDraftModel: (key: string) => void
  setDraftThink: (think: ThinkSetting | null) => void

  projects: Project[]
  loadProjects: () => Promise<void>
  /** Bumped when a project's files change anywhere, so the sidebar's explorer reloads them. */
  projectFilesVersion: number
  touchProjectFiles: () => void

  /** Chats; code sessions are kept apart in `sessions`. */
  conversations: Conversation[]
  sessions: Conversation[]
  /** Loads both lists. */
  loadConversations: () => Promise<void>
  /** Puts a conversation in the list its mode belongs to. */
  upsertConversation: (c: Conversation) => void

  themes: ThemeDef[]
  loadThemes: () => Promise<void>
  /** A theme being edited; applied live instead of the saved one. */
  previewTheme: ThemeDef | null
  setPreviewTheme: (theme: ThemeDef | null) => void
  /** Settings the command palette shows while a choice is highlighted, before they're saved (see withPreview). */
  previewSettings: DeepPartial<Settings> | null
  setPreviewSettings: (preview: DeepPartial<Settings> | null) => void

  skills: Skill[]
  loadSkills: () => Promise<void>

  /** Configured MCP servers, and each one's state and tools (kept current by events). */
  mcpServers: McpServer[]
  mcpStatus: McpStatus[]
  loadMcp: () => Promise<void>

  toasts: Toast[]
  toast: (message: string, kind?: Toast['kind']) => void
  dismissToast: (id: number) => void
}

let toastId = 0

export const useApp = create<AppState>((set, get) => ({
  route: { name: 'home' },
  navigate: (route) => set({ route }),

  sidebarOpen: true,
  toggleSidebar: () => set((s) => ({ sidebarOpen: !s.sidebarOpen })),
  searchOpen: false,
  setSearchOpen: (searchOpen) => set({ searchOpen }),

  settings: null,
  loadSettings: async () => set({ settings: await api.settings.get() }),
  updateSettings: async (patch) => set({ settings: await api.settings.update(patch) }),

  models: [],
  modelErrors: [],
  modelsLoading: false,
  modelsReady: false,
  loadModels: async (refresh = false) => {
    set({ modelsLoading: true })
    try {
      const { models, errors } = await api.models.list(refresh)
      set({ models, modelErrors: errors })
      const { draftModel, settings } = get()
      if (!draftModel || !models.some((m) => m.key === draftModel)) {
        const preferred = settings?.defaultModel && models.find((m) => m.key === settings.defaultModel)
        const pick = preferred || models.find((m) => m.installed) || models[0]
        if (pick) get().setDraftModel(pick.key)
      }
    } catch (err) {
      set({ modelErrors: [{ endpointId: '', message: (err as Error).message }] })
    } finally {
      set({ modelsLoading: false, modelsReady: true })
    }
  },
  endpointsChanged: async () => {
    await get().loadSettings()
    await get().loadModels(true)
  },

  draftModel: null,
  draftThink: null,
  setDraftModel: (key) => {
    const profile = thinkProfileFor(get().models, key)
    set({ draftModel: key, draftThink: defaultThinkSetting(profile) })
  },
  setDraftThink: (draftThink) => set({ draftThink }),

  projects: [],
  projectFilesVersion: 0,
  touchProjectFiles: () => set((s) => ({ projectFilesVersion: s.projectFilesVersion + 1 })),
  loadProjects: async () => set({ projects: await api.projects.list() }),

  conversations: [],
  sessions: [],
  loadConversations: async () => {
    const [conversations, sessions] = await Promise.all([
      api.conversations.list({ limit: 300, mode: 'chat' }),
      api.conversations.list({ limit: 300, mode: 'code' })
    ])
    set({ conversations, sessions })
  },
  upsertConversation: (c) =>
    set((s) => {
      const put = (list: Conversation[]) => [c, ...list.filter((x) => x.id !== c.id)].sort((a, b) => b.updatedAt - a.updatedAt)
      return c.mode === 'code' ? { sessions: put(s.sessions) } : { conversations: put(s.conversations) }
    }),

  themes: [],
  loadThemes: async () => set({ themes: await api.themes.list() }),
  previewTheme: null,
  setPreviewTheme: (previewTheme) => set({ previewTheme }),
  previewSettings: null,
  setPreviewSettings: (previewSettings) => set({ previewSettings }),

  skills: [],
  loadSkills: async () => set({ skills: await api.skills.list() }),

  mcpServers: [],
  mcpStatus: [],
  loadMcp: async () => {
    const [mcpServers, mcpStatus] = await Promise.all([api.mcp.list(), api.mcp.status()])
    set({ mcpServers, mcpStatus })
  },

  toasts: [],
  toast: (message, kind = 'info') => {
    const id = ++toastId
    set((s) => ({ toasts: [...s.toasts, { id, message, kind }] }))
    setTimeout(() => get().dismissToast(id), kind === 'error' ? 7000 : 3500)
  },
  dismissToast: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }))
}))

export function findModel(models: ModelInfo[], key: string | null): ModelInfo | undefined {
  return key ? models.find((m) => m.key === key) : undefined
}

/** The window a chat with this model actually gets, as main worked it out. */
export function contextWindowFor(model: ModelInfo | undefined): number | null {
  return model?.contextWindow ?? null
}

export function thinkProfileFor(models: ModelInfo[], key: string | null): ThinkProfile {
  const model = findModel(models, key)
  // Family rules match the name the server knows ("gpt-oss…"), never the key.
  return model
    ? resolveThinkProfile(model.name, model.capabilities, model.overrides.think, model.thinkPreset ?? undefined)
    : { kind: 'none' }
}

const NO_ENDPOINTS: Endpoint[] = []
/** The configured endpoints, for `useApp(selectEndpoints)`: one empty list until settings load, so nothing re-renders for it. */
export const selectEndpoints = (s: AppState): Endpoint[] => s.settings?.endpoints ?? NO_ENDPOINTS

/** Whether `route` is showing this conversation's chat UI (inline approvals, etc.): a chat, or a code session. */
export function showsConversation(route: Route, conversationId: string): boolean {
  return (route.name === 'chat' || route.name === 'code') && route.id === conversationId
}

/** Where a conversation opens: a code session in the Code pane, anything else as a chat. `mode`, when given, decides directly. */
export function conversationRoute(id: string, sessions: Conversation[], mode?: 'chat' | 'code'): Route {
  const isCode = mode ? mode === 'code' : sessions.some((c) => c.id === id)
  return isCode ? { name: 'code', id } : { name: 'chat', id }
}

/** Surface an error from an async UI action as a toast. */
export function reportError(err: unknown): void {
  const raw = err instanceof Error ? err.message : String(err)
  // Electron prefixes errors thrown in ipcMain handlers.
  useApp.getState().toast(raw.replace(/^Error invoking remote method '[^']+': (Error: )?/, ''), 'error')
}
