import type { SessionPaths } from '@shared/types'
import { CodeRunningError } from '../runner/lock'
import { readyForSession, type Workspace } from '../runner/workspace'
import { walkFiles } from './walk'

// The files the @ menu offers in a code session (#129): the file tools' walker (gitignore-aware, never .git, never
// through a folder link, with its visit and time limits) run under the session's lock like list_files, since it can't
// run in a worker (it needs `ignore` and the no-links open). Kept per folder, so two sessions on one folder share it,
// until something may have changed what it would find: a file tool's write, a Changes panel refresh, a reply ending.

/** The most files the list holds. */
const PATHS_LIMIT = 20_000

/** Each folder's list, by its Workspace.key (the folder), built or being built. */
const lists = new Map<string, Promise<SessionPaths>>()

/** Each folder that holds one of `files`, once, ending in "/", ahead of the files themselves. Exported for tests. */
export function withFolders(files: readonly string[]): string[] {
  const folders = new Set<string>()
  for (const f of files) for (let i = f.indexOf('/'); i >= 0; i = f.indexOf('/', i + 1)) folders.add(f.slice(0, i + 1))
  return [...[...folders].sort(), ...files]
}

/**
 * The session folder's files and folders, relative to it. `busy` while a command runs there; that isn't kept. `limit`
 * applies when the list is built: a kept list is given as it is.
 */
export function sessionPaths(ws: Workspace, limit = PATHS_LIMIT): Promise<SessionPaths> {
  let list = lists.get(ws.key)
  if (!list) {
    const built = readyForSession(ws, (root) => walkFiles(root, { limit })).then((walk): SessionPaths => ({
      paths: withFolders(walk.files),
      cut: walk.cut,
      busy: false
    }))
    lists.set(ws.key, built)
    // A list that failed (a command running, the folder gone) isn't kept: the next @ tries again.
    built.catch(() => lists.get(ws.key) === built && lists.delete(ws.key))
    list = built
  }
  return list.catch((err: unknown) => {
    if (err instanceof CodeRunningError) return { paths: [], cut: false, busy: true }
    throw err
  })
}

/** Forget a folder's list (`key` is its Workspace.key, the folder), so the next @ walks it again. */
export function dropSessionPaths(key: string): void {
  lists.delete(key)
}
