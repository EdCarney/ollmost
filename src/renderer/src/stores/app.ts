import { create } from 'zustand'
import { effectiveContext } from '@shared/context'
import type { DeepPartial } from '@shared/ipc'
import { defaultThinkSetting, resolveThinkProfile } from '@shared/thinking'
import type {
  Conversation,
  McpServer,
  McpStatus,
  ModelInfo,
  Project,
  Settings,
  Skill,
  ThemeDef,
  ThinkProfile,
  ThinkSetting
} from '@shared/types'
import { api } from '@/lib/api'

export type SettingsTab = 'general' | 'appearance' | 'models' | 'usage' | 'features' | 'tools' | 'data'

export type Route =
  | { name: 'home' }
  | { name: 'chat'; id: string }
  | { name: 'chats' }
  | { name: 'projects' }
  | { name: 'project'; id: string }
  | { name: 'artifacts' }
  | { name: 'skills'; id?: string }
  | { name: 'settings'; tab?: SettingsTab }

export interface Toast {
  id: number
  message: string
  kind: 'info' | 'error'
}

interface AppState {
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
  modelsError: string | null
  modelsLoading: boolean
  loadModels: (refresh?: boolean) => Promise<void>

  /** Model + thinking choice for chats that don't exist yet. */
  draftModel: string | null
  draftThink: ThinkSetting | null
  setDraftModel: (name: string) => void
  setDraftThink: (think: ThinkSetting | null) => void

  projects: Project[]
  loadProjects: () => Promise<void>

  conversations: Conversation[]
  loadConversations: () => Promise<void>
  upsertConversation: (c: Conversation) => void

  themes: ThemeDef[]
  loadThemes: () => Promise<void>
  /** A theme being edited; applied live instead of the saved one. */
  previewTheme: ThemeDef | null
  setPreviewTheme: (theme: ThemeDef | null) => void

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
  modelsError: null,
  modelsLoading: false,
  loadModels: async (refresh = false) => {
    set({ modelsLoading: true })
    try {
      const { models, error } = await api.models.list(refresh)
      set({ models, modelsError: error })
      const { draftModel, settings } = get()
      if (!draftModel || !models.some((m) => m.name === draftModel)) {
        const preferred = settings?.defaultModel && models.find((m) => m.name === settings.defaultModel)
        const pick = preferred || models.find((m) => m.installed) || models[0]
        if (pick) get().setDraftModel(pick.name)
      }
    } catch (err) {
      set({ modelsError: (err as Error).message })
    } finally {
      set({ modelsLoading: false })
    }
  },

  draftModel: null,
  draftThink: null,
  setDraftModel: (name) => {
    const profile = thinkProfileFor(get().models, name)
    set({ draftModel: name, draftThink: defaultThinkSetting(profile) })
  },
  setDraftThink: (draftThink) => set({ draftThink }),

  projects: [],
  loadProjects: async () => set({ projects: await api.projects.list() }),

  conversations: [],
  loadConversations: async () => set({ conversations: await api.conversations.list({ limit: 300 }) }),
  upsertConversation: (c) =>
    set((s) => {
      const rest = s.conversations.filter((x) => x.id !== c.id)
      return { conversations: [c, ...rest].sort((a, b) => b.updatedAt - a.updatedAt) }
    }),

  themes: [],
  loadThemes: async () => set({ themes: await api.themes.list() }),
  previewTheme: null,
  setPreviewTheme: (previewTheme) => set({ previewTheme }),

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

export function findModel(models: ModelInfo[], name: string | null): ModelInfo | undefined {
  return name ? models.find((m) => m.name === name) : undefined
}

/** The window a chat with this model actually gets (local models are capped at the num_ctx setting). */
export function contextWindowFor(model: ModelInfo | undefined, settings: Settings | null): number | null {
  if (!model) return null
  return settings ? effectiveContext(model, settings.localNumCtx) : model.contextLength
}

export function thinkProfileFor(models: ModelInfo[], name: string | null): ThinkProfile {
  const model = findModel(models, name)
  return model ? resolveThinkProfile(model.name, model.capabilities, model.overrides.think) : { kind: 'none' }
}

/** Whether `route` is showing this conversation's chat UI (inline approvals, etc.); add `|| (route.name === 'code' && route.id === conversationId)` once the code route exists. */
export function showsConversation(route: Route, conversationId: string): boolean {
  return route.name === 'chat' && route.id === conversationId
}

/** Surface an error from an async UI action as a toast. */
export function reportError(err: unknown): void {
  const raw = err instanceof Error ? err.message : String(err)
  // Electron prefixes errors thrown in ipcMain handlers.
  useApp.getState().toast(raw.replace(/^Error invoking remote method '[^']+': (Error: )?/, ''), 'error')
}
