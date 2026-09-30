import { create } from 'zustand'
import { readJson, strings, writeJson } from '@/lib/storage'

// Per-viewer conveniences for projects, kept in browser storage: in the sidebar, whether the Projects section is
// collapsed and which projects are expanded; on a project's page, which of its folders are closed, and folders made
// but not yet filled (a folder is its files' paths, so an empty one exists only here). One store, so every view on
// screen reads and writes the same copy.

const EXPANDED_KEY = 'ollmost.explorer.expanded'
const CLOSED_KEY = 'ollmost.explorer.closedFolders'
const FOLDERS_KEY = 'ollmost.explorer.folders'
const COLLAPSED_KEY = 'ollmost.sidebar.projectsCollapsed'

function stringLists(v: unknown): Record<string, string[]> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return {}
  return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, list]) => [k, strings(list)]))
}

/** A folder's key in `closedFolders`. */
export const folderKey = (projectId: string, folder: string): string => `${projectId}/${folder}`

interface ExplorerState {
  /** Whether the sidebar's Projects section is collapsed to its header. */
  projectsCollapsed: boolean
  /** Projects expanded in the sidebar, by id. */
  expanded: string[]
  /** Folders closed on their project's page, as `folderKey`s; a folder is open until closed. */
  closedFolders: string[]
  /** Folders the viewer made, kept here until removed (a folder is otherwise only its files' paths), by project id. */
  emptyFolders: Record<string, string[]>
  toggleProjects: () => void
  toggle: (projectId: string) => void
  /** Expands a project in the sidebar (and leaves an expanded one as it is). */
  expand: (projectId: string) => void
  toggleFolder: (projectId: string, folder: string) => void
  /** Opens a folder on its project's page (and leaves an open one as it is). */
  openFolder: (projectId: string, folder: string) => void
  rememberFolder: (projectId: string, folder: string) => void
  /** Forgets the folder and those under it. */
  forgetFolder: (projectId: string, folder: string) => void
  /** Drops what was kept for projects that no longer exist. */
  prune: (projectIds: string[]) => void
}

const flip = (list: string[], key: string) => (list.includes(key) ? list.filter((k) => k !== key) : [...list, key])

export const useExplorer = create<ExplorerState>((set, get) => ({
  projectsCollapsed: readJson(COLLAPSED_KEY) === true,
  // Before #128 this also held the sidebar tree's open folders, as `<project id>/<folder>`; those mean nothing now.
  expanded: strings(readJson(EXPANDED_KEY)).filter((k) => !k.includes('/')),
  closedFolders: strings(readJson(CLOSED_KEY)),
  emptyFolders: stringLists(readJson(FOLDERS_KEY)),
  toggleProjects: () => {
    const next = !get().projectsCollapsed
    set({ projectsCollapsed: next })
    writeJson(COLLAPSED_KEY, next)
  },
  toggle: (projectId) => {
    const next = flip(get().expanded, projectId)
    set({ expanded: next })
    writeJson(EXPANDED_KEY, next)
  },
  expand: (projectId) => {
    if (!get().expanded.includes(projectId)) get().toggle(projectId)
  },
  toggleFolder: (projectId, folder) => {
    const next = flip(get().closedFolders, folderKey(projectId, folder))
    set({ closedFolders: next })
    writeJson(CLOSED_KEY, next)
  },
  openFolder: (projectId, folder) => {
    if (get().closedFolders.includes(folderKey(projectId, folder))) get().toggleFolder(projectId, folder)
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
    const { expanded, closedFolders, emptyFolders } = get()
    const nextExpanded = expanded.filter((id) => ids.has(id))
    const nextClosed = closedFolders.filter((k) => ids.has(k.split('/')[0]))
    const nextFolders = Object.fromEntries(Object.entries(emptyFolders).filter(([id]) => ids.has(id)))
    if (
      nextExpanded.length === expanded.length &&
      nextClosed.length === closedFolders.length &&
      Object.keys(nextFolders).length === Object.keys(emptyFolders).length
    )
      return
    set({ expanded: nextExpanded, closedFolders: nextClosed, emptyFolders: nextFolders })
    writeJson(EXPANDED_KEY, nextExpanded)
    writeJson(CLOSED_KEY, nextClosed)
    writeJson(FOLDERS_KEY, nextFolders)
  }
}))
