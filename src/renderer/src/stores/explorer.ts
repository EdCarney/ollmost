import { create } from 'zustand'
import { readJson, strings, writeJson } from '@/lib/storage'

// The explorer's per-viewer conveniences, kept in browser storage: which nodes are open, and folders made but not yet
// filled (a folder is its files' paths, so an empty one exists only here). One store, so every explorer on screen
// (pinned projects and the one in view) reads and writes the same copy.

const EXPANDED_KEY = 'ollmost.explorer.expanded'
const FOLDERS_KEY = 'ollmost.explorer.folders'

function stringLists(v: unknown): Record<string, string[]> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return {}
  return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, list]) => [k, strings(list)]))
}

interface ExplorerState {
  /** Open nodes: a project's id, or `<project id>/<folder>`. */
  expanded: string[]
  /** Folders the viewer made, kept here until removed (a folder is otherwise only its files' paths), by project id. */
  emptyFolders: Record<string, string[]>
  toggle: (key: string) => void
  rememberFolder: (projectId: string, folder: string) => void
  /** Forgets the folder and those under it. */
  forgetFolder: (projectId: string, folder: string) => void
  /** Drops what was kept for projects that no longer exist. */
  prune: (projectIds: string[]) => void
}

export const useExplorer = create<ExplorerState>((set, get) => ({
  expanded: strings(readJson(EXPANDED_KEY)),
  emptyFolders: stringLists(readJson(FOLDERS_KEY)),
  toggle: (key) => {
    const { expanded } = get()
    const next = expanded.includes(key) ? expanded.filter((k) => k !== key) : [...expanded, key]
    set({ expanded: next })
    writeJson(EXPANDED_KEY, next)
  },
  rememberFolder: (projectId, folder) => {
    const { emptyFolders } = get()
    const next = { ...emptyFolders, [projectId]: [...new Set([...(emptyFolders[projectId] ?? []), folder])] }
    set({ emptyFolders: next })
    writeJson(FOLDERS_KEY, next)
  },
  forgetFolder: (projectId, folder) => {
    const { emptyFolders } = get()
    const kept = (emptyFolders[projectId] ?? []).filter((f) => f !== folder && !f.startsWith(`${folder}/`))
    const next = { ...emptyFolders, [projectId]: kept }
    set({ emptyFolders: next })
    writeJson(FOLDERS_KEY, next)
  },
  prune: (projectIds) => {
    const ids = new Set(projectIds)
    const { expanded, emptyFolders } = get()
    const nextExpanded = expanded.filter((k) => ids.has(k.split('/')[0]))
    const nextFolders = Object.fromEntries(Object.entries(emptyFolders).filter(([id]) => ids.has(id)))
    if (nextExpanded.length === expanded.length && Object.keys(nextFolders).length === Object.keys(emptyFolders).length) return
    set({ expanded: nextExpanded, emptyFolders: nextFolders })
    writeJson(EXPANDED_KEY, nextExpanded)
    writeJson(FOLDERS_KEY, nextFolders)
  }
}))
