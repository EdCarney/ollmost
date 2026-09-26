import { createHash } from 'node:crypto'
import { constants, createWriteStream, rmSync } from 'node:fs'
import { copyFile, type FileHandle, lstat, mkdir, open, readdir, realpath, rm, stat } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { attachmentRowsForConversation, getConversation } from '../db/conversations'
import { isPlainId, paths } from '../paths'
import { quarantineInWorkspace } from '../quarantine'
import { forgetWorkspace, quiesce, quiesceEvery } from './lock'
import { chatVenvDir, chatVenvsDir, removeChatVenv, resetVenv } from './python'
import { OLLMOST_DIR } from './sandbox'

// Each chat that runs code gets a folder: code runs there, the chat's attachments are copied into uploads/, and
// what code writes is listed on the run's card. It's deleted with the chat. A code session works in a folder of the
// user's instead (a repo, say): Ollmost didn't make it and never repairs, fills or deletes it, and what it needs of its
// own for the session lives beside, in runner/sessions/<id>. A Workspace says which is which (#78).
//
// Code can write anything in the folder, and Ollmost works in it outside the sandbox, so Ollmost must never follow a link
// code left there (#71). The sandbox won't let code replace the folder itself or .ollmost (see policyFor). Otherwise Ollmost
// changes or lists the folder only under its lock (quiesce: none of the chat's code running, none starting until the
// work is done), replacing any link where it expects a folder; and it hands a file out only by opening it with no link
// anywhere in its path.

export const UPLOADS_DIR = 'uploads'
const MAX_FILES = 5000
const MAX_LISTED = 20

/**
 * The folder a conversation's code runs in, and what Ollmost may do there. Every folder of Ollmost's own for the
 * conversation (scripts, Python environment, previews, a session's scratch) is named by `id`, never by the folder's
 * name: a session's folder is named by the user.
 */
export interface Workspace {
  /** The conversation's id (a plain id). */
  id: string
  /** Where its code runs: a chat's own folder under workspaces/, or the folder a code session was opened on. */
  root: string
  /** Whether Ollmost made the root, and so may repair it (a link replaced), put files in it, and delete it with the chat. */
  owned: boolean
  /** What its lock is keyed by: the root, so two sessions on one folder take turns. */
  key: string
  /**
   * The folders the reaper knows its code by (see reaper.ts): the ones only Ollmost's policy for it pins. A chat's
   * workspace and Python environment; a session's scratch and environment, never its root, which any sandbox started
   * there pins too. The first must exist for a check to count (see lock.ts).
   */
  folders: string[]
}

export const workspaceDir = (conversationId: string): string => join(paths.workspaces, conversationId)
/** A code session's folder of Ollmost's own (the sandbox's HOME and TMPDIR): its root is the user's, so nothing goes there. */
export const sessionDir = (conversationId: string): string => join(paths.runner, 'sessions', conversationId)
/** The scripts a chat's runs execute: outside its workspace, where code can read them but never change them. */
export const scriptsDir = (conversationId: string): string => join(paths.runner, 'scripts', conversationId)
/** Copies of a chat's files being previewed, so what's previewed is the file that was checked. */
const previewsDir = (conversationId?: string): string => join(paths.runner, 'previews', conversationId ?? '')

/**
 * A conversation's workspace, from its row. A code session's is the folder it was opened on, which the user owns.
 * Anything else, a chat or a conversation that's gone, gets the chat folder of that id, which Ollmost owns: an id with
 * no row can only ever name folders of Ollmost's own. A conversation that's gone may have been a session, so its
 * scratch is among the folders checked before they're deleted.
 */
export function workspaceFor(conversationId: string): Workspace {
  if (!isPlainId(conversationId)) throw new Error(`Not a conversation id: ${conversationId}`)
  const c = getConversation(conversationId)
  const venv = chatVenvDir(conversationId)
  if (c?.mode === 'code' && c.root)
    return { id: conversationId, root: c.root, owned: false, key: c.root, folders: [sessionDir(conversationId), venv] }
  const root = workspaceDir(conversationId)
  const folders = c ? [root, venv] : [root, sessionDir(conversationId), venv]
  return { id: conversationId, root, owned: true, key: root, folders }
}

/** Ollmost's own folder for a workspace, holding the sandbox's HOME and TMPDIR: inside a chat's, beside a session's. */
export const ownDir = (ws: Workspace): string => (ws.owned ? join(ws.root, OLLMOST_DIR) : sessionDir(ws.id))

/** A code session's folder isn't where it was: moved, renamed or deleted, or a link put in its place. */
export class RootMissingError extends Error {
  constructor(root: string) {
    super(`This session's folder is no longer at ${root} (moved, renamed or deleted). Choose it again to carry on.`)
  }
}

/**
 * The root's real path, which the sandbox and the checks use. A chat's is a folder in one of Ollmost's own, whose
 * real path is trusted; the root's own name is kept as is, so a link left in its place isn't followed. A session's is
 * stored as a real path and must still be one: a folder moved from there, or a link put in its place, would send
 * Ollmost's work elsewhere.
 */
export async function realRoot(ws: Workspace): Promise<string> {
  if (ws.owned) return join(await realpath(dirname(ws.root)), basename(ws.root))
  const real = await realpath(ws.root).catch(() => null)
  if (real !== ws.root) throw new RootMissingError(ws.root)
  return ws.root
}

/** A safe file name for an upload: no folders, and not hidden. */
const safeName = (name: string) => name.replace(/[/\\:]/g, '_').replace(/^\.+/, '_') || 'file'

/** `dir` as a real folder: a link (or file) code left there is removed first, never followed. */
async function ensureFolder(dir: string): Promise<void> {
  const s = await lstat(dir).catch(() => null)
  if (s?.isDirectory()) return
  if (s) await rm(dir, { force: true })
  await mkdir(dir)
}

/**
 * The root as a folder Ollmost can work in. A chat's is made if missing, and a link left in its place replaced: safe
 * outside the lock, since the folder holding it is Ollmost's and the sandbox pins it (only a link left from before
 * the pin can be there). It must exist for its code to be found. A session's is the user's, and is only checked to
 * still be where it was.
 */
async function ensureRoot(ws: Workspace): Promise<void> {
  if (!ws.owned) {
    await realRoot(ws)
    return
  }
  await mkdir(dirname(ws.root), { recursive: true })
  await ensureFolder(ws.root)
}

/**
 * Ollmost's own folders for a workspace (the sandbox's HOME and TMPDIR, which code may have deleted) as real folders,
 * and the conversation's Python environment, which its code can write, never a link. Under the workspace's lock.
 */
async function fixFolders(ws: Workspace): Promise<void> {
  const own = ownDir(ws)
  await mkdir(dirname(own), { recursive: true })
  for (const dir of [own, join(own, 'home'), join(own, 'tmp')]) await ensureFolder(dir)
  const venv = chatVenvDir(ws.id)
  const found = await lstat(venv).catch(() => null)
  if (found && !found.isDirectory()) await rm(venv, { force: true })
}

/**
 * A workspace ready for a reply: its folders in order, and a chat's attachments copied into uploads/ (names made
 * unique); a session's root gets nothing put in it. Returns the names of the uploads that are there, for the prompt.
 */
export async function prepareWorkspace(ws: Workspace): Promise<{ uploads: string[] }> {
  await ensureRoot(ws)
  const uploads = await quiesce(ws, async () => {
    await fixFolders(ws)
    return ws.owned ? copyUploads(ws) : []
  })
  return { uploads }
}

async function copyUploads(ws: Workspace): Promise<string[]> {
  const dir = ws.root
  const rows = attachmentRowsForConversation(ws.id)
  const names: string[] = []
  const copied: string[] = []
  if (rows.length) await ensureFolder(join(dir, UPLOADS_DIR))
  for (const row of rows) {
    let name = safeName(row.name)
    for (let n = 2; names.includes(name); n++) name = safeName(row.name).replace(/(\.[^.]*)?$/, (ext) => ` (${n})${ext}`)
    names.push(name)
    const target = join(dir, UPLOADS_DIR, name)
    const existing = await lstat(target).catch(() => null)
    if (existing?.isFile() && existing.size === row.size) {
      copied.push(name)
      continue
    }
    // Nothing to copy (the attachment's file is gone): leave what's there, and don't name it.
    if (!(await stat(row.path).catch(() => null))?.isFile()) continue
    // A changed copy, or a link or folder code put in its place: replaced, never written through.
    if (existing) await rm(target, { recursive: true, force: true })
    if (
      await copyFile(row.path, target, constants.COPYFILE_EXCL).then(
        () => true,
        () => false
      )
    )
      copied.push(name)
  }
  return copied
}

/**
 * Before code runs in a workspace: it and Ollmost's folders in it are real folders, and none of its code is still
 * running (see quiesce). Throws if leftover code can't be stopped.
 */
export async function readyForRun(ws: Workspace): Promise<void> {
  await ensureRoot(ws)
  await quiesce(ws, () => fixFolders(ws))
}

/**
 * A code session ready for a reply: its folder where it was (else RootMissingError), its scratch in order, then
 * `work` under its lock, given the root (a real path by construction). What `work` reads of the root goes through
 * openSessionFile. Only for a session's workspace.
 */
export async function readyForSession<T>(ws: Workspace, work: (root: string) => Promise<T>): Promise<T> {
  if (ws.owned) throw new Error('Not a code session')
  await ensureRoot(ws)
  return quiesce(ws, async () => {
    await fixFolders(ws)
    return work(ws.root)
  })
}

export type Snapshot = Map<string, { size: number; mtimeMs: number }>

/**
 * Regular files under `dir`, by relative path, at most MAX_FILES: links aren't followed (nor is `dir` itself if it's
 * one), and entries `skip` names are left out. Breadth-first, so when there are too many, the ones nearer the top
 * (what Finder shows first) are kept. Only under the workspace's lock: code could swap a folder for a link mid-walk.
 */
async function listFiles(dir: string, skip: (rel: string, name: string) => boolean): Promise<string[]> {
  if (!(await lstat(dir).catch(() => null))?.isDirectory()) return []
  const files: string[] = []
  const folders = [dir]
  while (folders.length && files.length < MAX_FILES) {
    const folder = folders.shift()!
    let entries
    try {
      entries = await readdir(folder, { withFileTypes: true })
    } catch {
      continue
    }
    for (const e of entries) {
      if (files.length >= MAX_FILES) break
      const full = join(folder, e.name)
      const rel = relative(dir, full)
      if (skip(rel, e.name)) continue
      if (e.isDirectory()) folders.push(full)
      else if (e.isFile()) files.push(rel)
    }
  }
  return files
}

/**
 * Every file in the workspace except Ollmost's own and the uploads, with its size and modification time. Throws while
 * the chat's code runs (see quiesce). Nothing for a session: its folder is the user's, and could be a whole repo.
 */
export function snapshot(ws: Workspace): Promise<Snapshot> {
  if (!ws.owned) return Promise.resolve(new Map())
  return quiesce(ws, async () => {
    const files: Snapshot = new Map()
    for (const rel of await listFiles(ws.root, (rel, name) => rel === OLLMOST_DIR || rel === UPLOADS_DIR || name === '__pycache__')) {
      const s = await lstat(join(ws.root, rel)).catch(() => null)
      if (s?.isFile()) files.set(rel, { size: s.size, mtimeMs: s.mtimeMs })
    }
    return files
  })
}

/** Every file in a workspace a user can see in Finder (not Ollmost's hidden .ollmost folder), by relative path. */
async function visibleFiles(ws: Workspace): Promise<string[]> {
  const root = await realRoot(ws).catch(() => null)
  return root ? listFiles(root, (rel) => rel === OLLMOST_DIR) : []
}

/** The files Show in Finder marks (see markWorkspaceFiles). Throws while the chat's code runs. */
export async function workspaceFiles(conversationId: string): Promise<string[]> {
  if (!isPlainId(conversationId)) return []
  const ws = workspaceFor(conversationId)
  return quiesce(ws, () => visibleFiles(ws))
}

/**
 * Before showing `rel` in Finder: mark it and every other file in the chat's workspace as downloaded, since Finder
 * shows the whole folder (#67). Under the workspace's lock, so no code can put a link in a path being marked (#76).
 * Throws while the chat's code runs, or if a file can't be marked.
 */
export async function markWorkspaceFiles(conversationId: string, rel: string): Promise<void> {
  if (!isPlainId(conversationId)) return
  const ws = workspaceFor(conversationId)
  // A session's folder holds the user's own files, which are never marked.
  if (!ws.owned) return
  await quiesce(ws, async () => {
    const root = await realRoot(ws)
    const rest = (await visibleFiles(ws)).filter((f) => f !== rel)
    await quarantineInWorkspace(...[rel, ...rest].map((f) => join(root, f)))
  })
}

/** Files that are new or changed since `before` (at most 20, by path). */
export function changedFiles(before: Snapshot, after: Snapshot): Array<{ path: string; size: number }> {
  return [...after]
    .filter(([path, f]) => {
      const was = before.get(path)
      return !was || was.size !== f.size || was.mtimeMs !== f.mtimeMs
    })
    .map(([path, f]) => ({ path, size: f.size }))
    .sort((a, b) => a.path.localeCompare(b.path))
    .slice(0, MAX_LISTED)
}

/** On a Mac, open() fails if any part of the path is a link (O_NOFOLLOW_ANY), which code can't race. */
const NO_LINKS = process.platform === 'darwin' ? 0x20000000 : constants.O_NOFOLLOW

/** Where `rel` would be under the root (by its real path), or null when that's outside it. Nothing is opened. */
async function pathInside(ws: Workspace, rel: string): Promise<string | null> {
  if (!rel || isAbsolute(rel)) return null
  try {
    const root = await realRoot(ws)
    const path = resolve(root, rel)
    return path.startsWith(root + sep) ? path : null
  } catch {
    return null
  }
}

/**
 * Where a file in a conversation's workspace would be, by its relative path, or null when that's outside it: the id
 * must be a plain id, and the path must stay inside the root. Nothing is opened.
 */
export async function workspacePath(conversationId: string, rel: string): Promise<string | null> {
  if (!isPlainId(conversationId)) return null
  return pathInside(workspaceFor(conversationId), rel)
}

/**
 * Open a file in a conversation's workspace by its relative path, or null when it would be anything else. Everything
 * that opens, saves or previews a workspace file goes through this, outside the sandbox. In a chat's, possibly while
 * its code runs: so besides the path check, no part of the path may be a link, not the workspace, not a folder in it,
 * not the file (code could link to a file anywhere). A session's folder may hold links of the user's own that stay
 * inside it (a repo often does): its file is opened by its real path, checked to be inside, under the lock, so no
 * session code can put a link on the path between the check and the open. The caller closes it.
 */
async function openWorkspaceFile(conversationId: string, rel: string): Promise<{ handle: FileHandle; path: string } | null> {
  if (!isPlainId(conversationId)) return null
  const ws = workspaceFor(conversationId)
  if (ws.owned) return openNoLinks(await pathInside(ws, rel))
  return quiesce(ws, () => openSessionFile(ws, rel))
}

/**
 * Open a file in a code session's folder by its relative path (see openWorkspaceFile for the rule), or null. Only
 * under the session's lock (readyForSession, quiesce): the check and the open must not be raced by session code.
 */
export async function openSessionFile(ws: Workspace, rel: string): Promise<{ handle: FileHandle; path: string } | null> {
  // pathInside checked the root is where it was, so its real path is ws.root.
  const path = await pathInside(ws, rel)
  const real = path ? await realpath(path).catch(() => null) : null
  return openNoLinks(real?.startsWith(ws.root + sep) ? real : null)
}

/**
 * Open `path` as a file with no link anywhere in it (see openWorkspaceFile), or null. Non-blocking: a named pipe code
 * left under the name (mkfifo) would otherwise hold the open, and with it the lock, forever; opened so, it's simply
 * not a file. The caller closes the handle.
 */
export async function openNoLinks(path: string | null): Promise<{ handle: FileHandle; path: string } | null> {
  if (!path) return null
  let handle: FileHandle | null = null
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NONBLOCK | NO_LINKS)
    // Elsewhere only the file itself is checked by open(): the folders above it are checked here.
    const ok = (await handle.stat()).isFile() && (process.platform === 'darwin' || (await realpath(path)) === path)
    if (ok) return { handle, path }
  } catch {
    // Missing, a link, or not a file.
  }
  await handle?.close()
  return null
}

/** The full path of a file in a chat's workspace, checked as openWorkspaceFile does, or null. */
export async function workspaceFile(conversationId: string, rel: string): Promise<string | null> {
  const file = await openWorkspaceFile(conversationId, rel)
  await file?.handle.close()
  return file?.path ?? null
}

/** A workspace file's contents (for the images the chat previews), or null. */
export async function readWorkspaceFile(conversationId: string, rel: string): Promise<Buffer | null> {
  const file = await openWorkspaceFile(conversationId, rel)
  if (!file) return null
  try {
    return await file.handle.readFile()
  } finally {
    await file.handle.close()
  }
}

/** Copy a workspace file to `dest`, from the file that was checked. Returns false when there's none. */
export async function copyWorkspaceFile(conversationId: string, rel: string, dest: string): Promise<boolean> {
  const file = await openWorkspaceFile(conversationId, rel)
  if (!file) return false
  // The read stream closes the handle when it's done.
  await pipeline(file.handle.createReadStream(), createWriteStream(dest))
  return true
}

/**
 * A copy of a workspace file to preview, outside the workspace: Quick Look (or the default app) reads the file by its
 * path, whenever it likes, and code could swap a folder on that path for a link meanwhile. One place per file, so
 * previewing it again replaces its copy. Null when there's no such file.
 */
export async function stageWorkspaceFile(conversationId: string, rel: string): Promise<string | null> {
  if (!isPlainId(conversationId)) return null
  const dir = join(previewsDir(conversationId), createHash('sha256').update(rel).digest('hex').slice(0, 16))
  const dest = join(dir, basename(rel))
  await mkdir(dir, { recursive: true })
  try {
    if (await copyWorkspaceFile(conversationId, rel, dest)) return dest
  } catch (err) {
    await rm(dir, { recursive: true, force: true })
    throw err
  }
  await rm(dir, { recursive: true, force: true })
  return null
}

/** Remove the preview copies (at startup, when none is open). */
export async function clearPreviews(): Promise<void> {
  if (paths.runner) await rm(previewsDir(), { recursive: true, force: true })
}

/**
 * Remove the preview copies as Ollmost quits (synchronously: it's the last thing it does). Not before its folders are
 * known: a second copy of Ollmost quits at once, and a relative path would be the working folder's.
 */
export function clearPreviewsSync(): void {
  if (paths.runner) rmSync(previewsDir(), { recursive: true, force: true })
}

/**
 * Delete a conversation's folders: the ones of Ollmost's own (a session's scratch, scripts, Python environment,
 * preview copies), and a chat's workspace. A session's root is the user's and stays. Under the workspace's lock.
 */
async function deleteFolders(ws: Workspace): Promise<void> {
  await Promise.all([
    ...(ws.owned ? [rm(ws.root, { recursive: true, force: true })] : []),
    rm(sessionDir(ws.id), { recursive: true, force: true }),
    removeChatVenv(ws.id),
    rm(scriptsDir(ws.id), { recursive: true, force: true }),
    rm(previewsDir(ws.id), { recursive: true, force: true })
  ])
  forgetWorkspace(ws)
}

/**
 * Delete a deleted conversation's folders, once none of its code is running: code left running could swap a folder
 * for a link while it's being deleted, and the delete would follow it. Never throws: the conversation is gone already,
 * so folders that can't be deleted now (its code can't be stopped, say) are left for the next start's sweep. Takes
 * the workspace, not the id: which folder was a session's is known from its row, which is gone by now.
 */
export async function removeWorkspace(ws: Workspace): Promise<void> {
  try {
    await quiesce(ws, () => deleteFolders(ws))
  } catch (err) {
    console.warn(`Ollmost: left the folders of deleted chat ${ws.id} for the next start:`, err)
  }
}

/** Every conversation that has folders of its own: a workspace, a session's scratch, scripts or a Python environment. */
async function conversationsWithFolders(): Promise<string[]> {
  const lists = await Promise.all(
    [paths.workspaces, join(paths.runner, 'sessions'), join(paths.runner, 'scripts'), chatVenvsDir()].map((dir) =>
      readdir(dir).catch(() => [] as string[])
    )
  )
  return [...new Set(lists.flat())].filter(isPlainId)
}

/**
 * Stop code left running in every conversation that has none running now: at startup (after a crash) and when
 * quitting. At startup it also deletes the folders of conversations that no longer exist (a delete that couldn't
 * stop their code): only ever folders of Ollmost's own, since without a row a session's folder isn't known. A chat's
 * workspace a link replaced (before the sandbox prevented it) becomes a real folder first, so its code can be found;
 * a session's root is never touched. Returns how many processes were stopped.
 */
export async function sweepWorkspaces(opts: { removeOrphans?: boolean } = {}): Promise<number> {
  const workspaces = (await conversationsWithFolders()).map(workspaceFor)
  for (const ws of workspaces) if (ws.owned && (await lstat(ws.root).catch(() => null))) await ensureFolder(ws.root).catch(() => undefined)
  return quiesceEvery(workspaces, {
    skipRunning: true,
    work: async (quiet) => {
      if (!opts.removeOrphans) return
      for (const ws of quiet) if (!getConversation(ws.id)) await deleteFolders(ws)
    }
  })
}

/** Delete every Ollmost Python environment, with no conversation's code running or left running (they may write their own). */
export async function resetEnvironments(): Promise<void> {
  const ids = await conversationsWithFolders()
  await quiesceEvery(ids.map(workspaceFor), { work: () => resetVenv(ids) })
}
