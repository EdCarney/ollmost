import { mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

// The `code` IPC group the renderer calls for code sessions (#86), through the handlers registerIpc installs. Electron
// is faked: the folder dialog answers from `picks`, and Show in Finder records what it was shown.

const fake = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  /** What the next folder dialogs choose, in turn: a path, or null for Cancel. */
  picks: [] as Array<string | null>,
  /** The options each folder dialog was opened with. */
  dialogs: [] as Array<{ properties?: string[]; message?: string; defaultPath?: string }>,
  shown: [] as string[],
  replying: new Set<string>(),
  /** Something to do while a folder dialog is open (a reply starting, say). */
  whileOpen: null as null | (() => void)
}))
vi.mock('electron', () => ({
  app: { getPath: () => '', isPackaged: false },
  BrowserWindow: { getAllWindows: () => [], getFocusedWindow: () => null },
  dialog: {
    showOpenDialog: async (opts: (typeof fake.dialogs)[number]) => {
      fake.dialogs.push(opts)
      fake.whileOpen?.()
      const path = fake.picks.shift() ?? null
      return path === null ? { canceled: true, filePaths: [] } : { canceled: false, filePaths: [path] }
    }
  },
  ipcMain: { handle: (channel: string, fn: (...args: unknown[]) => unknown) => fake.handlers.set(channel, fn) },
  nativeTheme: {},
  nativeImage: {},
  net: {},
  protocol: {},
  safeStorage: { isEncryptionAvailable: () => false },
  shell: { showItemInFolder: (path: string) => fake.shown.push(path) }
}))
vi.mock('../src/main/ipcSender', () => ({ appPages: () => [], isAppFrame: () => true }))
vi.mock('../src/main/skills/library', async (original) => ({ ...(await original<object>()), watchSkills: () => undefined }))
vi.mock('../src/main/chat/service', async (original) => ({
  ...(await original<object>()),
  isReplyingIn: (id: string) => fake.replying.has(id)
}))

const { openDatabase } = await import('../src/main/db/index')
const { createConversation, deleteConversation, getConversation } = await import('../src/main/db/conversations')
const { updateSettings } = await import('../src/main/settings')
const { paths } = await import('../src/main/paths')
const { registerIpc } = await import('../src/main/ipc')

const base = realpathSync.native(mkdtempSync(join(tmpdir(), 'ollmost-code-ipc-')))
beforeAll(() => {
  openDatabase(':memory:')
  paths.data = join(base, 'data')
  paths.files = join(paths.data, 'files')
  paths.skills = join(paths.data, 'skills')
  paths.workspaces = join(paths.data, 'workspaces')
  paths.runner = join(paths.data, 'runner')
  mkdirSync(paths.files, { recursive: true })
  updateSettings({ skills: { sources: { ollama: false, claude: false } } })
  registerIpc()
})
afterAll(() => rmSync(base, { recursive: true, force: true }))
beforeEach(() => {
  fake.picks.length = 0
  fake.dialogs.length = 0
  fake.shown.length = 0
  fake.replying.clear()
  fake.whileOpen = null
})

const call = (name: string, ...args: unknown[]) => Promise.resolve(fake.handlers.get(`code:${name}`)!({ senderFrame: {} }, ...args))

let made = 0
/** A folder of the user's (a real path), a repository on `branch` when given. */
function folder(branch?: string): string {
  const dir = join(base, `project-${made++}`)
  mkdirSync(dir)
  writeFileSync(join(dir, 'README.md'), 'theirs')
  if (branch) {
    mkdirSync(join(dir, '.git'))
    writeFileSync(join(dir, '.git', 'HEAD'), `ref: refs/heads/${branch}\n`)
  }
  return dir
}
const session = (root: string) => createConversation({ projectId: null, model: 'm', think: null, skills: [], mode: 'code', root })
const chat = () => createConversation({ projectId: null, model: 'm', think: null, skills: [] })

describe('choosing a folder', () => {
  it('opens a folder dialog, and gives the chosen folder’s real path, or null when cancelled', async () => {
    const dir = folder()
    symlinkSync(dir, join(base, 'link-to-project'))
    fake.picks.push(join(base, 'link-to-project'), null)
    expect(await call('pickFolder')).toBe(dir)
    expect(await call('pickFolder')).toBeNull()
    expect(fake.dialogs[0].properties).toEqual(['openDirectory', 'createDirectory'])
    expect(fake.dialogs[0].message).toMatch(/Ollmost/)
  })

  it('refuses a folder Ollmost won’t work in, saying why', async () => {
    fake.picks.push(homedir())
    await expect(call('pickFolder')).rejects.toThrow(/home folder/)
  })
})

describe('making a session', () => {
  it('checks the folder again, and titles the session after it, with the default network', async () => {
    updateSettings({ code: { defaultNetwork: 'registries' } })
    const dir = folder()
    symlinkSync(dir, join(base, 'another-link'))
    const c = (await call('create', { root: join(base, 'another-link'), model: 'm', think: 'high' })) as ReturnType<typeof session>
    expect(c).toMatchObject({
      mode: 'code',
      root: dir,
      title: basename(dir),
      network: 'registries',
      projectId: null,
      model: 'm',
      think: 'high'
    })
    await expect(call('create', { root: paths.data, model: 'm', think: null })).rejects.toThrow(/Ollmost.s own/)
    await expect(call('create', { root: 'relative', model: 'm', think: null })).rejects.toThrow(/full path/)
    updateSettings({ code: { defaultNetwork: 'none' } })
  })
})

describe('recent folders', () => {
  it('are the folders of sessions still where they were, newest first', async () => {
    const kept = folder()
    const moved = folder()
    session(kept)
    session(moved)
    renameSync(moved, `${moved}-moved`)
    // A link where it was: something is there, but not the folder the session was opened on.
    symlinkSync(`${moved}-moved`, moved)
    const roots = (await call('recentRoots')) as string[]
    expect(roots).toContain(kept)
    expect(roots).not.toContain(moved)
    expect(roots.indexOf(kept)).toBe(0)
  })
})

describe('a session’s folder', () => {
  it('shows whether it’s still there, and the branch checked out in it', async () => {
    const repo = folder('feature/x')
    const c = session(repo)
    expect(await call('status', c.id)).toEqual({ found: true, branch: 'feature/x' })
    expect(await call('status', session(folder()).id)).toEqual({ found: true, branch: null })
    renameSync(repo, `${repo}-moved`)
    expect(await call('status', c.id)).toEqual({ found: false, branch: null })
    await expect(call('status', chat().id)).rejects.toThrow(/isn.t a code session/)
    await expect(call('status', 'no-such-id')).rejects.toThrow(/no longer exists/)
  })

  it('tells its changes and a file’s diff only for a session, between replies, while it’s there', async () => {
    const dir = folder()
    const c = session(dir)
    await expect(call('changes', chat().id)).rejects.toThrow(/isn.t a code session/)
    await expect(call('diff', chat().id, 'README.md')).rejects.toThrow(/isn.t a code session/)
    fake.replying.add(c.id)
    await expect(call('changes', c.id)).rejects.toThrow(/still responding.*look again/)
    await expect(call('diff', c.id, 'README.md')).rejects.toThrow(/still responding/)
    fake.replying.clear()
    renameSync(dir, `${dir}-moved`)
    expect(await call('changes', c.id)).toEqual({ repo: false, files: [], cut: false, error: expect.stringMatching(/no longer at/) })
    await expect(call('diff', c.id, 'README.md')).rejects.toThrow(/no longer at/)
  })

  it('tells no changes while a reply runs in another session on the same folder', async () => {
    const dir = folder()
    const a = session(dir)
    const b = session(dir)
    fake.replying.add(b.id)
    await expect(call('changes', a.id)).rejects.toThrow(/in a session on this folder/)
    await expect(call('diff', a.id, 'README.md')).rejects.toThrow(/in a session on this folder/)
  })

  it('is shown in Finder while it’s where it was, and not after it moved', async () => {
    const dir = folder()
    const c = session(dir)
    await call('reveal', c.id)
    expect(fake.shown).toEqual([dir])
    renameSync(dir, `${dir}-moved`)
    await expect(call('reveal', c.id)).rejects.toThrow(/no longer at/)
    expect(fake.shown).toEqual([dir])
  })

  it('can be chosen again after it moved, starting from where it was', async () => {
    const dir = folder()
    const c = session(dir)
    renameSync(dir, `${dir}-moved`)
    fake.picks.push(null, `${dir}-moved`)
    expect(await call('locate', c.id)).toBeNull()
    expect(getConversation(c.id)?.root).toBe(dir)
    expect(await call('locate', c.id)).toMatchObject({ id: c.id, root: `${dir}-moved` })
    expect(fake.dialogs.map((d) => d.defaultPath)).toEqual([dirname(dir), dirname(dir)])
    expect(await call('status', c.id)).toEqual({ found: true, branch: null })
  })

  it('isn’t chosen again while a reply runs, or for a folder Ollmost won’t work in, or for a chat', async () => {
    const dir = folder()
    const c = session(dir)
    fake.replying.add(c.id)
    await expect(call('locate', c.id)).rejects.toThrow(/still responding/)
    expect(fake.dialogs).toEqual([])
    fake.replying.clear()
    fake.picks.push(homedir())
    await expect(call('locate', c.id)).rejects.toThrow(/home folder/)
    expect(getConversation(c.id)?.root).toBe(dir)
    await expect(call('locate', chat().id)).rejects.toThrow(/isn.t a code session/)
  })

  it('isn’t changed when a reply starts, or the session is deleted, while the dialog is open', async () => {
    const dir = folder()
    const c = session(dir)
    fake.whileOpen = () => fake.replying.add(c.id)
    fake.picks.push(folder())
    await expect(call('locate', c.id)).rejects.toThrow(/still responding/)
    expect(fake.dialogs).toHaveLength(1)
    expect(getConversation(c.id)?.root).toBe(dir)
    fake.replying.clear()
    fake.whileOpen = () => deleteConversation(c.id)
    fake.picks.push(folder())
    await expect(call('locate', c.id)).rejects.toThrow(/no longer exists/)
  })
})
