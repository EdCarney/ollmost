import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeAll, describe, expect, it, vi } from 'vitest'

// A code session works in a folder of the user's (#78): Ollmost must never repair, fill, mark or delete it, only
// its own folders for the session, and it must find the folder where it was. A chat's folder is Ollmost's own.

vi.mock('electron', () => ({
  safeStorage: { isEncryptionAvailable: () => false },
  shell: {},
  app: { getPath: () => '' }
}))

const { openDatabase } = await import('../src/main/db/index')
const { createConversation, deleteConversation, insertAttachment, insertMessage, linkAttachments } =
  await import('../src/main/db/conversations')
const { updateSettings } = await import('../src/main/settings')
const { paths } = await import('../src/main/paths')
const workspace = await import('../src/main/runner/workspace')
const { chatVenvDir } = await import('../src/main/runner/python')
const { QUARANTINE_ATTR } = await import('../src/main/quarantine')
const lock = await import('../src/main/runner/lock')
const tools = await import('../src/main/chat/tools')
await import('../src/main/runner/provider')

const root = mkdtempSync(join(tmpdir(), 'ollmost-ownership-'))
beforeAll(() => {
  openDatabase(':memory:')
  paths.data = root
  paths.files = join(root, 'files')
  paths.workspaces = join(root, 'workspaces')
  paths.runner = join(root, 'runner')
  mkdirSync(paths.files, { recursive: true })
  updateSettings({ skills: { sources: { ollama: false, claude: false } }, runner: { mode: 'ask' } })
})

/** A folder of the user's, as a code session's root: a real path, with a file of theirs in it. */
function userFolder(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'ollmost-user-folder-')))
  writeFileSync(join(dir, 'README.md'), 'theirs')
  return dir
}
const chat = () => createConversation({ projectId: null, model: 'm', think: null, skills: [] })
const session = (dir: string) => createConversation({ projectId: null, model: 'm', think: null, skills: [], mode: 'code', root: dir })
const listing = (dir: string) => readdirSync(dir).sort()
const marked = async (file: string) => {
  const { execFileSync } = await import('node:child_process')
  try {
    return /^0081;/.test(execFileSync('/usr/bin/xattr', ['-p', QUARANTINE_ATTR, file], { stdio: 'pipe' }).toString())
  } catch {
    return false
  }
}

describe('whose folder a workspace is', () => {
  it('is Ollmost’s own for a chat, or for an id with no conversation, named by the id', () => {
    const c = chat()
    expect(c).toMatchObject({ mode: 'chat', root: null })
    const dir = join(paths.workspaces, c.id)
    expect(workspace.workspaceFor(c.id)).toEqual({ id: c.id, root: dir, owned: true, key: dir, folders: [dir, chatVenvDir(c.id)] })
    // An id with no row may have been a session's: its scratch is checked before the sweep deletes it.
    const gone = join(paths.workspaces, 'gone-chat')
    expect(workspace.workspaceFor('gone-chat')).toEqual({
      id: 'gone-chat',
      root: gone,
      owned: true,
      key: gone,
      folders: [gone, workspace.sessionDir('gone-chat'), chatVenvDir('gone-chat')]
    })
    expect(() => workspace.workspaceFor('../x')).toThrow()
  })

  it('is the user’s folder for a code session, checked by Ollmost’s own folders beside it', () => {
    const dir = userFolder()
    const c = session(dir)
    expect(c).toMatchObject({ mode: 'code', root: dir })
    const ws = workspace.workspaceFor(c.id)
    expect(ws).toEqual({ id: c.id, root: dir, owned: false, key: dir, folders: [workspace.sessionDir(c.id), chatVenvDir(c.id)] })
    expect(workspace.ownDir(ws)).toBe(join(paths.runner, 'sessions', c.id))
  })
})

describe('a code session', () => {
  it('is never offered the chat’s code runner, not even as gpt-oss’s python tool', () => {
    const ctx = (id: string) => ({
      mode: 'chat' as const,
      skills: false,
      web: false,
      sources: ['code'],
      workspace: workspace.workspaceFor(id)
    })
    const names = (id: string) => (tools.toolsFor(ctx(id)) ?? []).map((t) => t.function.name)
    expect(names(chat().id)).toContain('run_code')
    const c = session(userFolder())
    expect(names(c.id)).not.toContain('run_code')
    expect(tools.resolveCall({ function: { name: 'python', arguments: 'print(1)' } }, ctx(c.id))).toBeNull()
    expect(tools.resolveCall({ function: { name: 'run_code', arguments: { code: '1' } } }, ctx(c.id))).toBeNull()
  })

  it('hands out no file while code runs on its folder, so nothing is read through a link code could swap', async () => {
    const dir = userFolder()
    const c = session(dir)
    const ws = workspace.workspaceFor(c.id)
    await workspace.readyForRun(ws)
    await lock.codeStarting(ws)
    try {
      await expect(workspace.workspaceFile(c.id, 'README.md')).rejects.toBeInstanceOf(lock.CodeRunningError)
      await expect(workspace.readWorkspaceFile(c.id, 'README.md')).rejects.toBeInstanceOf(lock.CodeRunningError)
      await expect(workspace.stageWorkspaceFile(c.id, 'README.md')).rejects.toBeInstanceOf(lock.CodeRunningError)
      // Another session on the same folder waits too; a chat's files are handed out as before, run or no run.
      const other = workspace.workspaceFor(session(dir).id)
      await expect(workspace.readyForRun(other)).rejects.toBeInstanceOf(lock.CodeRunningError)
      const ch = chat()
      await workspace.prepareWorkspace(workspace.workspaceFor(ch.id))
      writeFileSync(join(workspace.workspaceFor(ch.id).root, 'out.txt'), 'x')
      await lock.codeStarting(workspace.workspaceFor(ch.id))
      expect(await workspace.workspaceFile(ch.id, 'out.txt')).toMatch(/out\.txt$/)
      await lock.codeEnded(workspace.workspaceFor(ch.id))
    } finally {
      await lock.codeEnded(ws)
    }
    expect(await workspace.workspaceFile(c.id, 'README.md')).toBe(join(dir, 'README.md'))
  })
})

describe('a code session’s folder', () => {
  it('gets nothing put in it when readied: Ollmost’s folders go beside it, and uploads nowhere', async () => {
    const dir = userFolder()
    const c = session(dir)
    const ws = workspace.workspaceFor(c.id)
    const m = insertMessage({ conversationId: c.id, parentId: null, role: 'user', content: 'data' })
    writeFileSync(join(paths.files, 'att1'), 'data')
    insertAttachment({
      id: 'att1',
      kind: 'document',
      name: 'data.csv',
      mime: 'text/csv',
      size: 4,
      path: join(paths.files, 'att1'),
      text: 'data',
      token_est: 1
    })
    linkAttachments(['att1'], m.id)
    expect(await workspace.prepareWorkspace(ws)).toEqual({ uploads: [] })
    await workspace.readyForRun(ws)
    expect(listing(dir)).toEqual(['README.md'])
    expect(listing(workspace.sessionDir(c.id))).toEqual(['home', 'tmp'])
    expect(await workspace.snapshot(ws)).toEqual(new Map())
  })

  it('keeps links of the user’s named like Ollmost’s folders, and repairs only its own scratch', async () => {
    const dir = userFolder()
    const c = session(dir)
    const ws = workspace.workspaceFor(c.id)
    const outside = userFolder()
    for (const name of ['.ollmost', 'uploads']) symlinkSync(outside, join(dir, name))
    await workspace.prepareWorkspace(ws)
    await workspace.readyForRun(ws)
    await workspace.sweepWorkspaces({ removeOrphans: true })
    for (const name of ['.ollmost', 'uploads']) expect(lstatSync(join(dir, name)).isSymbolicLink()).toBe(true)
    expect(listing(outside)).toEqual(['README.md'])
    // Its scratch is Ollmost's: a link code left where home/ was is replaced, never followed.
    const home = join(workspace.sessionDir(c.id), 'home')
    rmSync(home, { recursive: true })
    symlinkSync(outside, home)
    await workspace.readyForRun(ws)
    expect(lstatSync(home).isDirectory()).toBe(true)
    expect(listing(outside)).toEqual(['README.md'])
  })

  it('must still be where it was: a folder moved away, or a link in its place, is refused and left alone', async () => {
    const dir = userFolder()
    const c = session(dir)
    const ws = workspace.workspaceFor(c.id)
    const elsewhere = userFolder()
    renameSync(dir, `${dir}-moved`)
    await expect(workspace.readyForRun(ws)).rejects.toBeInstanceOf(workspace.RootMissingError)
    await expect(workspace.prepareWorkspace(ws)).rejects.toThrow(/no longer at/)
    symlinkSync(elsewhere, dir)
    await expect(workspace.readyForRun(ws)).rejects.toBeInstanceOf(workspace.RootMissingError)
    expect(lstatSync(dir).isSymbolicLink()).toBe(true)
    expect(listing(elsewhere)).toEqual(['README.md'])
    expect(await workspace.workspacePath(c.id, 'README.md')).toBeNull()
    expect(await workspace.workspaceFile(c.id, 'README.md')).toBeNull()
    expect(await workspace.workspaceFiles(c.id)).toEqual([])
    // The sweep repairs a chat's folder a link replaced, never a session's.
    await workspace.sweepWorkspaces({ removeOrphans: true })
    expect(lstatSync(dir).isSymbolicLink()).toBe(true)
  })

  it('hands out its files through links of the user’s that stay inside it, never through one that leaves', async () => {
    const dir = userFolder()
    const c = session(dir)
    const outside = userFolder()
    mkdirSync(join(dir, 'src'))
    writeFileSync(join(dir, 'src', 'a.ts'), 'inside')
    symlinkSync(join(dir, 'src'), join(dir, 'lib'))
    symlinkSync(join(dir, 'README.md'), join(dir, 'readme-link'))
    symlinkSync(outside, join(dir, 'out'))
    symlinkSync(join(outside, 'README.md'), join(dir, 'theirs.md'))
    expect(await workspace.workspaceFile(c.id, 'src/a.ts')).toBe(join(dir, 'src', 'a.ts'))
    expect(await workspace.workspaceFile(c.id, 'lib/a.ts')).toBe(join(dir, 'src', 'a.ts'))
    expect((await workspace.readWorkspaceFile(c.id, 'readme-link'))?.toString()).toBe('theirs')
    expect(await workspace.workspaceFile(c.id, 'out/README.md')).toBeNull()
    expect(await workspace.workspaceFile(c.id, 'theirs.md')).toBeNull()
    expect(await workspace.workspaceFile(c.id, '../README.md')).toBeNull()
    expect(await workspace.workspaceFile(c.id, 'src')).toBeNull()
    expect(await workspace.workspaceFile(c.id, join(dir, 'src', 'a.ts'))).toBeNull()
    expect(await workspace.readWorkspaceFile(c.id, 'out/README.md')).toBeNull()
  })

  it.runIf(process.platform === 'darwin')('is never marked as downloaded for Show in Finder, unlike a chat’s', async () => {
    const dir = userFolder()
    const c = session(dir)
    writeFileSync(join(dir, 'setup.command'), 'x')
    await workspace.markWorkspaceFiles(c.id, 'setup.command')
    expect(await marked(join(dir, 'setup.command'))).toBe(false)
    expect(await marked(join(dir, 'README.md'))).toBe(false)

    const ch = chat()
    const ws = workspace.workspaceFor(ch.id)
    await workspace.prepareWorkspace(ws)
    writeFileSync(join(ws.root, 'run.command'), 'x')
    await workspace.markWorkspaceFiles(ch.id, 'run.command')
    expect(await marked(join(ws.root, 'run.command'))).toBe(true)
  })

  it('stays when the session is deleted, while Ollmost’s own folders for it go', async () => {
    const dir = userFolder()
    const c = session(dir)
    const ws = workspace.workspaceFor(c.id)
    await workspace.readyForRun(ws)
    const own = [workspace.sessionDir(c.id), workspace.scriptsDir(c.id), chatVenvDir(c.id)]
    for (const d of own) mkdirSync(d, { recursive: true })
    const preview = await workspace.stageWorkspaceFile(c.id, 'README.md')
    expect(preview && existsSync(preview)).toBe(true)
    // As the delete does: the workspace is taken from the row before the row goes.
    deleteConversation(c.id)
    await workspace.removeWorkspace(ws)
    for (const d of [...own, preview!]) expect(existsSync(d), d).toBe(false)
    expect(listing(dir)).toEqual(['README.md'])
  })

  it('is left alone by the sweep at startup, whether its session still exists or not', async () => {
    const dir = userFolder()
    const c = session(dir)
    await workspace.readyForRun(workspace.workspaceFor(c.id))
    await workspace.sweepWorkspaces({ removeOrphans: true })
    expect(existsSync(workspace.sessionDir(c.id))).toBe(true)
    expect(listing(dir)).toEqual(['README.md'])
    // The row gone, its folders are orphans: only Ollmost's own go.
    deleteConversation(c.id)
    await workspace.sweepWorkspaces({ removeOrphans: true })
    expect(existsSync(workspace.sessionDir(c.id))).toBe(false)
    expect(listing(dir)).toEqual(['README.md'])
  })
})
