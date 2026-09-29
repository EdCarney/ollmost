import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { basename, dirname, join } from 'node:path'
import { PassThrough } from 'node:stream'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import type { GroupProcess } from '../src/main/processes'
import { tempDir, trackTempDir } from './tempDir'

vi.mock('electron', () => ({
  safeStorage: { isEncryptionAvailable: () => false },
  shell: {},
  app: { getPath: () => '' }
}))

const { openDatabase } = await import('../src/main/db/index')
const { createConversation, insertAttachment, insertMessage, linkAttachments } = await import('../src/main/db/conversations')
const { updateSettings } = await import('../src/main/settings')
const { paths } = await import('../src/main/paths')
const { policyFor, PRIVATE_ROOTS, RUNTIME_TMPDIR, runSandboxed, supervise } = await import('../src/main/runner/sandbox')
const workspace = await import('../src/main/runner/workspace')
const tools = await import('../src/main/chat/tools')
const python = await import('../src/main/runner/python')
const { openWith, IMAGE_FILE } = await import('../src/shared/workspace')
const { quarantine, quarantineInWorkspace, quarantineValue, QUARANTINE_ATTR } = await import('../src/main/quarantine')
const { reap } = await import('../src/main/runner/reaper')
const { quiesce } = await import('../src/main/runner/lock')
const { foldersOnPathInside } = await import('../src/main/runner/provider')

const root = tempDir('ollmost-runner-test-')
beforeAll(() => {
  openDatabase(':memory:')
  paths.data = root
  paths.workspaces = join(root, 'workspaces')
  paths.runner = join(root, 'runner')
  updateSettings({ skills: { sources: { ollama: false, claude: false } } })
})

const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

type Workspace = import('../src/main/runner/workspace').Workspace
/** A chat's workspace at `dir`, as workspaceFor makes it (the sandbox tests' folders aren't under paths.workspaces). */
const chatWs = (dir: string): Workspace => ({
  id: basename(dir),
  root: dir,
  owned: true,
  key: dir,
  folders: [dir, python.chatVenvDir(basename(dir))]
})

describe('the sandbox policy', () => {
  const base = { workspace: '/w', home: '/Users/me', readable: ['/Users/me/.claude/skills'], venv: '/Users/me/k/venv' }

  it('hides the home folder except what code needs, and writes only to the workspace, with no network', () => {
    expect(policyFor({ ...base, pypi: false })).toEqual({
      network: { allowedDomains: [], deniedDomains: [] },
      filesystem: {
        denyRead: ['/Users/me', '/Users', '/Volumes', '/private/var/folders', '/private/tmp'],
        allowRead: ['/w', '/Users/me/.claude/skills', '/Users/me/k/venv'],
        allowWrite: ['/w'],
        denyWrite: ['/private/tmp/claude', '/w/.ollmost/.pinned']
      }
    })
  })

  // #68: the sandbox allows every read it doesn't deny, and user data isn't only in the home folder.
  it('also hides other accounts, shared and mounted folders, and the temp folders', () => {
    const { denyRead } = policyFor({ ...base, home: '/Volumes/Home/me', pypi: false }).filesystem
    expect(denyRead).toEqual(['/Volumes/Home/me', '/Users', '/Volumes', '/private/var/folders', '/private/tmp'])
    expect(policyFor({ ...base, home: '/Users', pypi: false }).filesystem.denyRead).toEqual(PRIVATE_ROOTS)
  })

  it('lets code read tool folders on PATH inside hidden ones, never a hidden folder itself or one above it', () => {
    const path = ['/Users/me/', '/Users/me/.local/bin', '/Users/me/./tools/../bin2', '/opt/homebrew/bin', '/Users', '/', 'rel/bin'].join(
      ':'
    )
    expect(foldersOnPathInside(path, ['/Users/me', '/Users', '/Volumes'])).toEqual(['/Users/me/.local/bin', '/Users/me/bin2'])
  })

  it('opens PyPI, and the Python environment for writing, only when allowed', () => {
    const p = policyFor({ ...base, pypi: true })
    expect(p.network.allowedDomains).toEqual(['pypi.org', 'files.pythonhosted.org'])
    expect(p.filesystem.allowWrite).toEqual(['/w', '/Users/me/k/venv'])
    // #71: a path code can't write pins every folder above it, so none can be swapped for a link.
    expect(p.filesystem.denyWrite).toEqual(['/private/tmp/claude', '/w/.ollmost/.pinned', '/Users/me/k/venv/.pinned'])
  })
})

describe('workspaces', () => {
  it("copies a chat's attachments into uploads, with unique names", async () => {
    const c = createConversation({ projectId: null, model: 'm', think: null, skills: [] })
    const m = insertMessage({ conversationId: c.id, parentId: null, role: 'user', content: 'data' })
    const files = join(root, 'files')
    mkdirSync(files, { recursive: true })
    for (const [id, text] of [
      ['a1', 'x,y\n1,2\n'],
      ['a2', 'other']
    ]) {
      writeFileSync(join(files, id), text)
      insertAttachment({
        id,
        kind: 'document',
        name: 'data.csv',
        mime: 'text/csv',
        size: text.length,
        path: join(files, id),
        text,
        token_est: 1
      })
    }
    linkAttachments(['a1', 'a2'], m.id)
    const ws = workspace.workspaceFor(c.id)
    expect(await workspace.prepareWorkspace(ws)).toEqual({ uploads: ['data.csv', 'data (2).csv'] })
    expect(readFileSync(join(ws.root, 'uploads', 'data.csv'), 'utf8')).toBe('x,y\n1,2\n')
    expect(existsSync(join(ws.root, '.ollmost', 'home'))).toBe(true)
  })

  it('lists files that are new or changed, leaving out uploads and Ollmost’s own', () => {
    const before = new Map([
      ['same.txt', { size: 1, mtimeMs: 1 }],
      ['edited.txt', { size: 1, mtimeMs: 1 }]
    ])
    const after = new Map([
      ['same.txt', { size: 1, mtimeMs: 1 }],
      ['edited.txt', { size: 2, mtimeMs: 2 }],
      ['chart.png', { size: 9, mtimeMs: 3 }]
    ])
    expect(workspace.changedFiles(before, after)).toEqual([
      { path: 'chart.png', size: 9 },
      { path: 'edited.txt', size: 2 }
    ])
  })

  it('only hands out files inside the workspace, even through a symlink', async () => {
    const id = 'chat-files'
    const dir = workspace.workspaceDir(id)
    mkdirSync(join(dir, 'out'), { recursive: true })
    writeFileSync(join(dir, 'out', 'report.txt'), 'ok')
    writeFileSync(join(root, 'secret.txt'), 'secret')
    symlinkSync(join(root, 'secret.txt'), join(dir, 'link.txt'))
    expect(await workspace.workspaceFile(id, 'out/report.txt')).toMatch(/out\/report\.txt$/)
    expect(await workspace.workspaceFile(id, '../../secret.txt')).toBeNull()
    expect(await workspace.workspaceFile(id, 'link.txt')).toBeNull()
    expect(await workspace.workspaceFile(id, join(dir, 'out', 'report.txt'))).toBeNull()
    expect(await workspace.workspaceFile('../workspaces/chat-files', 'out/report.txt')).toBeNull()
    expect(await workspace.workspaceFile(id, 'out')).toBeNull()
  })

  // #71: code can swap any folder in its workspace for a link, so a link anywhere in the path is refused, not only
  // one that points outside: it could point elsewhere by the time the file is read.
  it('hands out nothing through a link anywhere in its path, the workspace folder included', async () => {
    const outside = tempDir('ollmost-outside-')
    writeFileSync(join(outside, 'secret.txt'), 'secret')
    const id = 'chat-linked-folder'
    const dir = workspace.workspaceDir(id)
    mkdirSync(join(dir, 'real'), { recursive: true })
    writeFileSync(join(dir, 'real', 'mine.txt'), 'mine')
    symlinkSync(outside, join(dir, 'out'))
    symlinkSync(join(dir, 'real'), join(dir, 'inside'))
    expect(await workspace.workspaceFile(id, 'out/secret.txt')).toBeNull()
    expect(await workspace.workspaceFile(id, 'inside/mine.txt')).toBeNull()
    expect(await workspace.readWorkspaceFile(id, 'out/secret.txt')).toBeNull()
    expect((await workspace.readWorkspaceFile(id, 'real/mine.txt'))?.toString()).toBe('mine')
    const copy = join(tempDir('ollmost-copy-'), 'copy.txt')
    expect(await workspace.copyWorkspaceFile(id, 'out/secret.txt', copy)).toBe(false)
    expect(existsSync(copy)).toBe(false)
    expect(await workspace.copyWorkspaceFile(id, 'real/mine.txt', copy)).toBe(true)
    expect(readFileSync(copy, 'utf8')).toBe('mine')

    // The workspace folder itself replaced by a link (code could, before the sandbox pinned it).
    const rooted = 'chat-linked-root'
    symlinkSync(outside, workspace.workspaceDir(rooted))
    expect(await workspace.workspaceFile(rooted, 'secret.txt')).toBeNull()
    expect(await workspace.stageWorkspaceFile(rooted, 'secret.txt')).toBeNull()
    expect(await workspace.workspaceFiles(rooted)).toEqual([])
    expect(await workspace.snapshot(workspace.workspaceFor(rooted))).toEqual(new Map())
  })

  it('makes a real folder of a workspace, or its .ollmost or uploads, that a link replaced, writing nothing through it', async () => {
    const outside = tempDir('ollmost-outside-')
    const file = join(outside, 'notes.txt')
    writeFileSync(file, 'keep')
    const c = createConversation({ projectId: null, model: 'm', think: null, skills: [] })
    const m = insertMessage({ conversationId: c.id, parentId: null, role: 'user', content: 'data' })
    writeFileSync(join(root, 'files', 'u1'), 'a,b\n')
    insertAttachment({
      id: 'u1',
      kind: 'document',
      name: 'sales.csv',
      mime: 'text/csv',
      size: 4,
      path: join(root, 'files', 'u1'),
      text: 'a,b',
      token_est: 1
    })
    linkAttachments(['u1'], m.id)
    const dir = workspace.workspaceDir(c.id)
    const untouched = () => expect(readdirSync(outside)).toEqual(['notes.txt'])

    mkdirSync(paths.workspaces, { recursive: true })
    symlinkSync(outside, dir)
    await workspace.prepareWorkspace(workspace.workspaceFor(c.id))
    expect(lstatSync(dir).isDirectory()).toBe(true)
    untouched()

    for (const sub of ['.ollmost', 'uploads']) {
      rmSync(join(dir, sub), { recursive: true })
      symlinkSync(outside, join(dir, sub))
      await workspace.prepareWorkspace(workspace.workspaceFor(c.id))
      expect(lstatSync(join(dir, sub)).isDirectory()).toBe(true)
      untouched()
    }
    // An upload replaced by a link to a file elsewhere: the copy replaces the link instead of overwriting that file.
    rmSync(join(dir, 'uploads', 'sales.csv'))
    symlinkSync(file, join(dir, 'uploads', 'sales.csv'))
    await workspace.prepareWorkspace(workspace.workspaceFor(c.id))
    expect(lstatSync(join(dir, 'uploads', 'sales.csv')).isFile()).toBe(true)
    expect(readFileSync(join(dir, 'uploads', 'sales.csv'), 'utf8')).toBe('a,b\n')
    expect(readFileSync(file, 'utf8')).toBe('keep')
    untouched()
  })

  // Show in Finder marks these: Finder shows the whole folder, not only the file (#67).
  it('lists every file Finder would show, nearest first, leaving out .ollmost and never following links', async () => {
    const id = 'chat-finder'
    const dir = workspace.workspaceDir(id)
    mkdirSync(join(dir, 'a', 'b'), { recursive: true })
    mkdirSync(join(dir, '.ollmost'), { recursive: true })
    mkdirSync(join(dir, 'uploads'), { recursive: true })
    const outside = tempDir('ollmost-outside-')
    writeFileSync(join(outside, 'mine.txt'), 'x')
    for (const f of ['a/b/deep.txt', 'a/mid.txt', 'top.command', 'uploads/data.csv', '.ollmost/run-1.py']) writeFileSync(join(dir, f), 'x')
    symlinkSync(outside, join(dir, 'linked'))
    symlinkSync(join(outside, 'mine.txt'), join(dir, 'mine.txt'))
    const files = await workspace.workspaceFiles(id)
    expect([...files].sort()).toEqual(['a/b/deep.txt', 'a/mid.txt', 'top.command', 'uploads/data.csv'])
    expect(files.indexOf('top.command')).toBeLessThan(files.indexOf('a/mid.txt'))
    expect(files.indexOf('a/mid.txt')).toBeLessThan(files.indexOf('a/b/deep.txt'))
    expect(await workspace.workspaceFiles('../workspaces')).toEqual([])
  })
})

describe('workspaces, further', () => {
  it('names only the uploads that are there, and leaves a copy alone when its attachment’s file is gone', async () => {
    const c = createConversation({ projectId: null, model: 'm', think: null, skills: [] })
    const m = insertMessage({ conversationId: c.id, parentId: null, role: 'user', content: 'data' })
    insertAttachment({
      id: 'g1',
      kind: 'document',
      name: 'gone.csv',
      mime: 'text/csv',
      size: 9,
      path: join(root, 'files', 'no-such-file'),
      text: 'x',
      token_est: 1
    })
    linkAttachments(['g1'], m.id)
    mkdirSync(join(workspace.workspaceDir(c.id), 'uploads'), { recursive: true })
    writeFileSync(join(workspace.workspaceDir(c.id), 'uploads', 'gone.csv'), 'edited')
    expect((await workspace.prepareWorkspace(workspace.workspaceFor(c.id))).uploads).toEqual([])
    expect(readFileSync(join(workspace.workspaceDir(c.id), 'uploads', 'gone.csv'), 'utf8')).toBe('edited')
  })

  it('previews a copy kept in one place per file, removed with the chat', async () => {
    const id = 'chat-preview'
    const dir = workspace.workspaceDir(id)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'a.txt'), 'one')
    const first = await workspace.stageWorkspaceFile(id, 'a.txt')
    writeFileSync(join(dir, 'a.txt'), 'two')
    const second = await workspace.stageWorkspaceFile(id, 'a.txt')
    expect(second).toBe(first)
    expect(readFileSync(second!, 'utf8')).toBe('two')
    expect(await workspace.stageWorkspaceFile(id, 'missing.txt')).toBeNull()
    await workspace.removeWorkspace(workspace.workspaceFor(id))
    expect(existsSync(first!)).toBe(false)
  })

  // A chat delete that couldn't stop the chat's code leaves its folders; the next start removes them.
  it('deletes the folders of chats that are gone at startup, never those of chats that exist, nor when quitting', async () => {
    const kept = createConversation({ projectId: null, model: 'm', think: null, skills: [] })
    await workspace.prepareWorkspace(workspace.workspaceFor(kept.id))
    const gone = 'chat-gone'
    const folders = [workspace.workspaceDir(gone), workspace.scriptsDir(gone), python.chatVenvDir(gone)]
    for (const dir of folders) mkdirSync(dir, { recursive: true })
    await workspace.sweepWorkspaces()
    for (const dir of folders) expect(existsSync(dir), dir).toBe(true)
    await workspace.sweepWorkspaces({ removeOrphans: true })
    for (const dir of folders) expect(existsSync(dir), dir).toBe(false)
    expect(existsSync(workspace.workspaceDir(kept.id))).toBe(true)
  })
})

// A run exits, then Ollmost stops what it left and drains its output: the time limit and Stop must still be right.
describe('supervising a run', () => {
  const fake = () => {
    const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough() })
    const stop = vi.fn(async () => undefined)
    return { proc: { child, stop } as unknown as GroupProcess, child, stop }
  }

  it('doesn’t call a run timed out when its leftovers are still being stopped at the time limit', async () => {
    const { proc, child, stop } = fake()
    const result = supervise(proc, { timeoutMs: 50 }, () => new Promise((resolve) => setTimeout(resolve, 150)))
    child.stdout.end('done')
    child.emit('exit', 0)
    child.emit('close', 0)
    expect(await result).toMatchObject({ code: 0, timedOut: false, output: 'done' })
    expect(stop).not.toHaveBeenCalled()
  })

  it('stops a run at once when Stop came before it started', async () => {
    const { proc, child, stop } = fake()
    const controller = new AbortController()
    controller.abort()
    const result = supervise(proc, { timeoutMs: 10_000, signal: controller.signal }, async () => undefined)
    expect(stop).toHaveBeenCalled()
    child.emit('exit', null)
    child.emit('close', null)
    await expect(result).rejects.toThrow()
  })
})

// #69: with PyPI allowed, a shared writable environment would let one chat's code run in every other.
describe("Ollmost's Python environments", () => {
  const plantPackage = (venv: string, name: string, version: string) =>
    mkdirSync(join(venv, 'lib', 'python3.12', 'site-packages', `${name}-${version}.dist-info`), { recursive: true })

  it("lists the packages installed in the chats' own environments, each once", async () => {
    plantPackage(python.chatVenvDir('chat-a'), 'requests', '2.32.0')
    plantPackage(python.chatVenvDir('chat-a'), 'pip', '24.0')
    plantPackage(python.chatVenvDir('chat-b'), 'pip', '24.0')
    plantPackage(python.chatVenvDir('chat-b'), 'numpy', '2.1.0')
    expect(await python.installedPackages()).toEqual([
      { name: 'numpy', version: '2.1.0' },
      { name: 'pip', version: '24.0' },
      { name: 'requests', version: '2.32.0' }
    ])
    expect(python.venvsExist()).toBe(true)
  })

  it("deletes a chat's environment with the chat, and every environment on reset, without following links", async () => {
    const outside = tempDir('ollmost-outside-')
    writeFileSync(join(outside, 'keep.txt'), 'keep')
    plantPackage(python.chatVenvDir('chat-c'), 'six', '1.16.0')
    symlinkSync(outside, join(python.chatVenvDir('chat-c'), 'lib', 'link'))
    await workspace.removeWorkspace(workspace.workspaceFor('chat-c'))
    expect(existsSync(python.chatVenvDir('chat-c'))).toBe(false)

    plantPackage(python.chatVenvDir('chat-d'), 'six', '1.16.0')
    symlinkSync(outside, join(python.chatVenvDir('chat-d'), 'lib', 'link'))
    mkdirSync(join(paths.runner, 'venv', 'bin'), { recursive: true })
    await python.resetVenv(['chat-a', 'chat-b', 'chat-d'])
    expect(existsSync(python.chatVenvDir('chat-d'))).toBe(false)
    expect(existsSync(join(paths.runner, 'venv'))).toBe(false)
    expect(readFileSync(join(outside, 'keep.txt'), 'utf8')).toBe('keep')
    expect(await python.installedPackages()).toEqual([])
    expect(python.venvsExist()).toBe(false)
  })

  it('replaces the old shared environment with one without pip', async (t) => {
    if (!(await python.findPython())) t.skip()
    const legacy = join(paths.runner, 'venv', 'lib', 'python3', 'site-packages')
    mkdirSync(legacy, { recursive: true })
    writeFileSync(join(legacy, 'sitecustomize.py'), 'print("planted")')
    const base = await python.ensureBaseVenv()
    expect(base).toBe(python.baseVenvDir())
    expect(existsSync(python.venvPython(base))).toBe(true)
    expect(existsSync(join(base, 'bin', 'pip'))).toBe(false)
    expect(existsSync(join(paths.runner, 'venv'))).toBe(false)
  }, 60_000)
})

// A file a run wrote may carry the chat's data, and whatever opens it runs outside the sandbox (#67).
describe('handing out files a run wrote', () => {
  it('previews documents with Quick Look on a Mac, never in the app for their type', () => {
    for (const f of ['report.docx', 'data.xlsx', 'notes.md', 'table.csv', 'out.json', 'chart.png', 'doc.pdf', 'a.txt'])
      expect(openWith(f, 'darwin')).toBe('quick-look')
  })

  it('elsewhere opens only plain text, PDFs and bitmaps', () => {
    for (const f of ['a.txt', 'doc.pdf', 'chart.png', 'photo.JPG', 'anim.gif', 'pic.webp']) expect(openWith(f, 'linux')).toBe('default-app')
    for (const f of ['report.docx', 'deck.pptx', 'data.xlsx', 'notes.md', 'table.csv', 'out.json', 'x.rtf', 'y.odt'])
      expect(openWith(f, 'linux')).toBeNull()
  })

  it('never opens an SVG, a script or an app, though an SVG is still shown inline as an image', () => {
    for (const platform of ['darwin', 'linux', 'win32'])
      for (const f of ['plot.svg', 'run.command', 'x.sh', 'x.py', 'x.html', 'Evil.app', 'x.webloc', 'x.terminal'])
        expect(openWith(f, platform)).toBeNull()
    expect(IMAGE_FILE.test('plot.svg')).toBe(true)
  })

  it('marks handed-out files the way browsers mark downloads', () => {
    expect(quarantineValue(Date.UTC(2026, 0, 1))).toBe(`0081;${(Date.UTC(2026, 0, 1) / 1000).toString(16)};Ollmost;`)
  })

  it.runIf(process.platform === 'darwin')('writes the quarantine mark on macOS', async () => {
    const file = join(root, 'handed-out.txt')
    writeFileSync(file, 'x')
    await quarantine(file)
    const { execFileSync } = await import('node:child_process')
    expect(execFileSync('/usr/bin/xattr', ['-p', QUARANTINE_ATTR, file]).toString().trim()).toMatch(/^0081;[0-9a-f]+;Ollmost;$/)
    await expect(quarantine(join(root, 'missing.txt'))).rejects.toThrow()
  })

  // Show in Finder shows the whole folder: every file in it is marked, never one a link leads to (#67, #71).
  it.runIf(process.platform === 'darwin')('marks every file Finder shows in a chat’s folder, and nothing through a link', async () => {
    const id = 'chat-mark'
    const dir = workspace.workspaceDir(id)
    const outside = tempDir('ollmost-outside-')
    writeFileSync(join(outside, 'mine.txt'), 'x')
    mkdirSync(join(dir, 'out'), { recursive: true })
    mkdirSync(join(dir, '.ollmost'), { recursive: true })
    for (const f of ['shown.txt', 'out/run.command', '.ollmost/run-1.py']) writeFileSync(join(dir, f), 'x')
    symlinkSync(outside, join(dir, 'linked'))
    await workspace.markWorkspaceFiles(id, 'shown.txt')
    const { execFileSync } = await import('node:child_process')
    const marked = (f: string) => {
      try {
        return /^0081;/.test(execFileSync('/usr/bin/xattr', ['-p', QUARANTINE_ATTR, f], { stdio: 'pipe' }).toString())
      } catch {
        return false
      }
    }
    expect([join(dir, 'shown.txt'), join(dir, 'out', 'run.command')].map(marked)).toEqual([true, true])
    expect([join(dir, '.ollmost', 'run-1.py'), join(outside, 'mine.txt')].map(marked)).toEqual([false, false])
  })

  it.runIf(process.platform === 'darwin')(
    'marks nothing in a workspace when a path has a link anywhere in it, writable or not',
    async () => {
      const dir = realpathSync(tempDir('ollmost-marks-'))
      mkdirSync(join(dir, 'real'))
      writeFileSync(join(dir, 'real', 'writable.txt'), 'x')
      writeFileSync(join(dir, 'real', 'locked.txt'), 'x')
      chmodSync(join(dir, 'real', 'locked.txt'), 0o444)
      writeFileSync(join(dir, 'first.txt'), 'x')
      symlinkSync(join(dir, 'real'), join(dir, 'linked'))
      for (const f of ['writable.txt', 'locked.txt'])
        await expect(quarantineInWorkspace(join(dir, 'first.txt'), join(dir, 'linked', f))).rejects.toThrow()
      const { execFileSync } = await import('node:child_process')
      expect(() => execFileSync('/usr/bin/xattr', ['-p', QUARANTINE_ATTR, join(dir, 'first.txt')], { stdio: 'pipe' })).toThrow()
      expect(statSync(join(dir, 'real', 'locked.txt')).mode & 0o777).toBe(0o444)
      await quarantineInWorkspace(join(dir, 'first.txt'), join(dir, 'real', 'locked.txt'))
      expect(statSync(join(dir, 'real', 'locked.txt')).mode & 0o777).toBe(0o644)
    }
  )

  // Code can make a file read-only, and the mark needs write permission: that mustn't leave a script unmarked.
  it.runIf(process.platform === 'darwin')('marks many files at once, read-only ones too, and a link itself, not its target', async () => {
    const dir = tempDir('ollmost-marks-')
    const target = join(tempDir('ollmost-target-'), 'target.txt')
    writeFileSync(target, 'elsewhere')
    const files = [join(dir, 'a b.txt'), join(dir, 'setup.command'), ...Array.from({ length: 250 }, (_, i) => join(dir, `f${i}`))]
    for (const f of files) writeFileSync(f, 'x')
    chmodSync(join(dir, 'setup.command'), 0o555)
    symlinkSync(target, join(dir, 'link'))
    await quarantine(...files, join(dir, 'link'))
    const { execFileSync } = await import('node:child_process')
    const mark = (f: string) => {
      try {
        return execFileSync('/usr/bin/xattr', ['-s', '-p', QUARANTINE_ATTR, f], { stdio: 'pipe' }).toString().trim()
      } catch {
        return null
      }
    }
    for (const f of files) expect(mark(f), f).toMatch(/^0081;/)
    expect(statSync(join(dir, 'setup.command')).mode & 0o777).toBe(0o755)
    expect(mark(join(dir, 'link'))).toMatch(/^0081;/)
    expect(mark(target)).toBeNull()
  })
})

// The sandbox itself is macOS's (sandbox-exec); CI runs on Linux.
describe.runIf(process.platform === 'darwin' && existsSync('/usr/bin/sandbox-exec'))('running code in the sandbox', () => {
  // Real paths, as run_code uses: the pin (and so the leftover check) matches the real path.
  const ws = realpathSync(tempDir('ollmost-ws-'))
  const fakeHome = tempDir('ollmost-home-')
  const elsewhere = tempDir('ollmost-elsewhere-')
  writeFileSync(join(fakeHome, 'private.txt'), 'private')
  const policy = policyFor({ workspace: ws, home: fakeHome, readable: [], venv: join(root, 'venv'), pypi: false })
  const sandboxed = (command: string, extra: { timeoutMs?: number; signal?: AbortSignal; env?: Record<string, string> } = {}) =>
    runSandboxed({
      command,
      policy,
      workspace: chatWs(ws),
      env: extra.env ?? {},
      timeoutMs: extra.timeoutMs ?? 30_000,
      signal: extra.signal,
      id: command
    })

  // #81: sandbox-runtime anchors its mandatory denies (.git/hooks among them) at the main process's cwd at wrap
  // time, not at the run's own workspace, so a workspace outside that folder was never covered by them. Ollmost
  // always runs with its cwd at / (see src/main/index.ts) so they cover every workspace; this proves the gap they'd
  // otherwise leave, and that / closes it.
  beforeAll(() => process.chdir('/'))

  it('anchors sandbox-runtime’s mandatory denies at the process cwd, so only / covers every workspace', async () => {
    const parentA = realpathSync(tempDir('ollmost-cwd-a-'))
    const parentB = realpathSync(tempDir('ollmost-cwd-b-'))
    const plantHook = 'mkdir -p .git/hooks && touch .git/hooks/pre-commit'
    const hookPath = (workspace: string) => join(workspace, '.git', 'hooks', 'pre-commit')
    const runIn = (workspace: string, id: string) =>
      runSandboxed({
        command: plantHook,
        policy: policyFor({ workspace, home: fakeHome, readable: [], venv: join(root, 'venv'), pypi: false }),
        workspace: chatWs(workspace),
        env: {},
        timeoutMs: 30_000,
        id
      })

    try {
      // cwd outside parentB: the mandatory deny (anchored at cwd) never reaches a workspace under parentB.
      process.chdir(parentA)
      const gapWorkspace = join(parentB, 'gap')
      mkdirSync(gapWorkspace, { recursive: true })
      const gap = await runIn(gapWorkspace, 'cwd-gap')
      expect(gap.code).toBe(0)
      expect(existsSync(hookPath(gapWorkspace))).toBe(true)

      // cwd at /: the same mandatory deny is now anchored at /, so it reaches every workspace, this one included.
      process.chdir('/')
      const coveredWorkspace = join(parentB, 'covered')
      mkdirSync(coveredWorkspace, { recursive: true })
      const covered = await runIn(coveredWorkspace, 'cwd-covered')
      expect(covered.code).not.toBe(0)
      expect(covered.output).toMatch(/Operation not permitted/)
      expect(existsSync(hookPath(coveredWorkspace))).toBe(false)
    } finally {
      process.chdir('/')
    }
  })

  it('writes in the workspace and nowhere else, and reads nothing it was denied', async () => {
    const ok = await sandboxed('echo made > made.txt && cat made.txt')
    expect(ok).toMatchObject({ code: 0, timedOut: false })
    expect(ok.output.trim()).toBe('made')
    const outside = await sandboxed(`echo x > ${join(elsewhere, 'escape.txt')}`)
    expect(outside.code).not.toBe(0)
    expect(outside.output).toMatch(/Operation not permitted/)
    expect(existsSync(join(elsewhere, 'escape.txt'))).toBe(false)
    const denied = await sandboxed(`cat ${join(fakeHome, 'private.txt')}`)
    expect(denied.output).toMatch(/Operation not permitted/)
  })

  // #68: outside the home folder too. The test folders are in the per-user temp folder (/private/var/folders).
  it('reads nothing in /Users/Shared, the temp folders or other disks, but still its workspace', async () => {
    const shared = join('/Users/Shared', `ollmost-test-${process.pid}.txt`)
    const tmp = join('/private/tmp', `ollmost-test-${process.pid}.txt`)
    writeFileSync(shared, 'shared')
    writeFileSync(tmp, 'tmp')
    writeFileSync(join(elsewhere, 'draft.txt'), 'draft')
    writeFileSync(join(ws, 'mine.txt'), 'mine')
    try {
      for (const file of [shared, tmp, '/tmp/' + tmp.split('/').at(-1), join(elsewhere, 'draft.txt')]) {
        const r = await sandboxed(`cat "${file}"`)
        expect(r.code, file).not.toBe(0)
        expect(r.output, file).toMatch(/Operation not permitted/)
      }
      expect((await sandboxed('ls /Volumes')).output).toMatch(/Operation not permitted/)
      expect((await sandboxed(`cat ${join(ws, 'mine.txt')}`)).output.trim()).toBe('mine')
    } finally {
      rmSync(shared, { force: true })
      rmSync(tmp, { force: true })
    }
  })

  // sandbox-runtime sets TMPDIR=/tmp/claude and lets every sandbox write there: a folder all chats would share, and
  // (reads being denied in /private/tmp) one whose files couldn't be read back.
  it('gives code its own temp folder, and none shared with other chats', async () => {
    const tmp = join(ws, "it's tmp")
    mkdirSync(tmp, { recursive: true })
    const own = await sandboxed('echo "TMPDIR=$TMPDIR" && echo kept > "$TMPDIR/t" && cat "$TMPDIR/t"', { env: { TMPDIR: tmp } })
    expect(own.code).toBe(0)
    expect(own.output).toBe(`TMPDIR=${tmp}\nkept\n`)
    const shared = await sandboxed('mkdir -p /tmp/claude/ollmost-test && echo x > /tmp/claude/ollmost-test/f', { env: { TMPDIR: tmp } })
    expect(shared.code).not.toBe(0)
    expect(shared.output).toMatch(/Operation not permitted/)
    expect(existsSync('/tmp/claude/ollmost-test/f')).toBe(false)
  })

  it('has no network, and says so', async () => {
    const r = await sandboxed('curl -sS -m 5 https://example.com -o /dev/null')
    expect(r.code).not.toBe(0)
    expect(r.output).toMatch(/deny network-outbound example\.com/)
  })

  it('stops a run at the time limit, background jobs included', async () => {
    const r = await sandboxed('sleep 30 & echo $! > bg.pid; sleep 30', { timeoutMs: 500 })
    expect(r.timedOut).toBe(true)
    const pid = Number(readFileSync(join(ws, 'bg.pid'), 'utf8'))
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(alive(pid)).toBe(false)
  })

  it('stops a run when the reply is stopped', async () => {
    const controller = new AbortController()
    const run = sandboxed('echo $$ > leader.pid; sleep 30', { signal: controller.signal })
    await new Promise((resolve) => setTimeout(resolve, 800))
    controller.abort()
    await expect(run).rejects.toThrow()
  })

  describe('as run_code', () => {
    const ctx = (dir: string) => ({ mode: 'chat' as const, skills: false, web: false, sources: ['code'], workspace: chatWs(dir) })
    const call = (name: string, args: Record<string, unknown> | string) => ({ function: { name, arguments: args } })

    it('is offered only in chats with the runner on, and asks unless set to Always allow', () => {
      expect((tools.toolsFor({ ...ctx(ws), sources: [] }) ?? []).map((t) => t.function.name)).not.toContain('run_code')
      expect((tools.toolsFor(ctx(ws)) ?? []).map((t) => t.function.name)).toContain('run_code')
      // A code session has tools of its own (#82).
      expect((tools.toolsFor({ ...ctx(ws), mode: 'code' }) ?? []).map((t) => t.function.name)).not.toContain('run_code')
      expect(tools.toolGrants(ctx(ws)).has('code')).toBe(true)
      expect(tools.approvalFor(call('run_code', { code: '1' }), ctx(ws))).toBe('ask')
      updateSettings({ runner: { mode: 'allow' } })
      expect(tools.approvalFor(call('run_code', { code: '1' }), ctx(ws))).toBe('auto')
      updateSettings({ runner: { mode: 'off' } })
      expect(tools.toolsFor(ctx(ws))).toBeUndefined()
      updateSettings({ runner: { mode: 'ask' } })
    })

    it('runs Python in its own environment, reports output and the files it wrote', async () => {
      const dir = tempDir('ollmost-run-')
      const code = "import sys\nprint(6 * 7)\nprint(sys.prefix.endswith('venv'))\nopen('answer.txt', 'w').write('42')"
      const r = await tools.runTool(call('run_code', { language: 'python', code }), ctx(dir))
      expect(r.content).toMatch(/^Exit code 0\.\n\n42\nTrue\n/)
      expect(r.content).toMatch(/Files created or changed:\n- answer\.txt \(2 bytes\)/)
      expect(r.event).toMatchObject({ tool: 'run_code', ok: true, summary: 'import sys', files: [{ path: 'answer.txt', size: 2 }] })
      expect(tools.replayCalls([r.event])[0]).toMatchObject({ name: 'run_code', record: expect.stringMatching(/Exit code 0\. 42/) })
      const failed = await tools.runTool(call('run_code', { language: 'bash', code: 'echo oops >&2; exit 3' }), ctx(dir))
      expect(failed.content).toMatch(/^Exit code 3\.\n\noops/)
      expect(failed.event).toMatchObject({ ok: false, summary: 'exit code 3' })
    }, 120_000)

    // #69: what one chat's code writes into its environment never runs in another chat.
    it('gives each chat that may install packages its own environment, which other chats never run or read', async () => {
      const a = tempDir('ollmost-run-')
      const b = tempDir('ollmost-run-')
      const plant = [
        // A .pth file's import lines run at every start (a sitecustomize.py can be shadowed by the base Python's).
        'import sys, sysconfig',
        "open(sysconfig.get_paths()['purelib'] + '/zz_planted.pth', 'w').write('import sys; print(\"PLANTED\")\\n')",
        'print(sys.prefix)'
      ].join('\n')
      updateSettings({ runner: { pypi: true } })
      try {
        const planted = await tools.runTool(call('run_code', { language: 'python', code: plant }), ctx(a))
        expect(planted.content).toMatch(/^Exit code 0\./)
        const venvA = python.chatVenvDir(basename(a))
        expect(planted.content).toContain(venvA)
        expect(existsSync(join(venvA, 'bin', 'pip'))).toBe(true)
        expect((await tools.runTool(call('run_code', { language: 'python', code: 'print(1)' }), ctx(a))).content).toMatch(/PLANTED/)

        const other = await tools.runTool(call('run_code', { language: 'python', code: 'import sys\nprint(sys.prefix)' }), ctx(b))
        expect(other.content).toMatch(/^Exit code 0\./)
        expect(other.content).not.toMatch(/PLANTED/)
        expect(other.content).toContain(python.chatVenvDir(basename(b)))
        const peek = await tools.runTool(call('run_code', { language: 'bash', code: `ls "${venvA}"` }), ctx(b))
        expect(peek.content).toMatch(/Operation not permitted/)
      } finally {
        updateSettings({ runner: { pypi: false } })
      }
      // Without PyPI, a chat with no environment of its own uses the shared one, and can't write it.
      const c = tempDir('ollmost-run-')
      const shared = await tools.runTool(call('run_code', { language: 'python', code: plant.replace('print(sys.prefix)', '') }), ctx(c))
      expect(shared.content).toMatch(/Operation not permitted/)
      expect(existsSync(python.chatVenvDir(basename(c)))).toBe(false)
      expect((await tools.runTool(call('run_code', { language: 'python', code: 'print(2)' }), ctx(c))).content).not.toMatch(/PLANTED/)
    }, 180_000)

    // pip checks certificates through macOS's trust service, which the sandbox blocks. Needs the network (pypi.org).
    it('installs a package from PyPI into the chat’s own environment', async () => {
      const dir = tempDir('ollmost-run-')
      mkdirSync(join(dir, '.ollmost', 'tmp'), { recursive: true })
      updateSettings({ runner: { pypi: true } })
      try {
        const code = 'pip install -q --disable-pip-version-check --no-deps six && python -c "import six; print(six.__file__)"'
        const r = await tools.runTool(call('run_code', { language: 'bash', code }), ctx(dir))
        expect(r.content).toMatch(/^Exit code 0\./)
        expect(r.content).toContain(join(python.chatVenvDir(basename(dir)), 'lib'))
      } finally {
        updateSettings({ runner: { pypi: false } })
      }
    }, 180_000)

    it("answers gpt-oss's built-in python tool, whose code can arrive as plain text", async () => {
      const dir = tempDir('ollmost-run-')
      expect(tools.resolveCall(call('python', 'print(1 + 1)'), ctx(dir))).toMatchObject({ name: 'run_code', via: 'python' })
      const r = await tools.runTool(call('python', 'print(1 + 1)'), ctx(dir))
      expect(r.content).toMatch(/^Exit code 0\.\n\n2/)
      const json = await tools.runTool(call('python', { code: 'print(3)' }), ctx(dir))
      expect(json.content).toMatch(/^Exit code 0\.\n\n3/)
    }, 120_000)
  })

  // #73: code can leave its process group (fork, setsid, let go of its output) and outlive the run.
  describe('code a run leaves running', () => {
    const leftover = (keepOutput: boolean) =>
      [
        'import os, time',
        'if os.fork() == 0:',
        '    os.setsid()',
        ...(keepOutput ? [] : ["    fd = os.open('/dev/null', os.O_RDWR)", '    for n in (0, 1, 2): os.dup2(fd, n)']),
        "    open('child.pid', 'w').write(str(os.getpid()))",
        '    while True:',
        "        open('tick.txt', 'w').write(str(time.time())); time.sleep(0.05)",
        "while not os.path.exists('child.pid'): time.sleep(0.01)",
        "print('parent done')"
      ].join('\n')
    /** A sandboxed `sleep` started straight from the runtime, as if a run had left it (no run's end stops it). */
    const leftBehind = async (dir: string, p: typeof policy) => {
      const { SandboxManager } = await import('@anthropic-ai/sandbox-runtime')
      const { argv, env } = await SandboxManager.wrapWithSandboxArgv('exec sleep 30', '/bin/bash', p, undefined, dir, { commandId: 'left' })
      return spawn(argv[0], argv.slice(1), { cwd: dir, env: { ...process.env, ...env }, stdio: 'ignore', detached: true })
    }
    const settle = () => new Promise((resolve) => setTimeout(resolve, 1000))

    it('is stopped by the time the run returns, even outside its process group, and can’t keep the run going', async () => {
      for (const keepOutput of [false, true]) {
        rmSync(join(ws, 'child.pid'), { force: true })
        writeFileSync(join(ws, 'leftover.py'), leftover(keepOutput))
        const started = Date.now()
        const r = await sandboxed('python3 leftover.py', { timeoutMs: 30_000 })
        expect(r, `keepOutput=${keepOutput}`).toMatchObject({ code: 0, timedOut: false })
        expect(r.output).toContain('parent done')
        expect(Date.now() - started).toBeLessThan(15_000)
        expect(alive(Number(readFileSync(join(ws, 'child.pid'), 'utf8'))), `keepOutput=${keepOutput}`).toBe(false)
      }
    }, 60_000)

    // Ollmost's sandbox for a chat is the only one that may write its folder but not the folder above it. macOS agents and
    // browser helpers may write the temp folder the test workspaces are in: those must never be touched.
    it("stops only that chat's code: not another chat's, a program outside the sandbox, or a sandbox that may write more", async () => {
      const other = realpathSync(tempDir('ollmost-ws-'))
      const otherChat = await leftBehind(
        other,
        policyFor({ workspace: other, home: fakeHome, readable: [], venv: join(root, 'venv'), pypi: false })
      )
      const wider = await leftBehind(ws, { ...policy, filesystem: { ...policy.filesystem, allowWrite: [dirname(ws)] } })
      // Shaped like a sandboxed app the user opened the folder in: it may write it, and delete it (no pin).
      const granted = await leftBehind(ws, { ...policy, filesystem: { ...policy.filesystem, denyWrite: [RUNTIME_TMPDIR] } })
      const unsandboxed = spawn('sleep', ['30'], { cwd: ws, stdio: 'ignore', detached: true })
      const mine = await leftBehind(ws, policy)
      await settle()
      try {
        expect(await reap([ws])).toEqual({ stopped: 1, checked: [ws] })
        await new Promise((resolve) => setTimeout(resolve, 200))
        expect(alive(mine.pid!)).toBe(false)
        for (const p of [otherChat, wider, granted, unsandboxed]) expect(alive(p.pid!)).toBe(true)
      } finally {
        for (const p of [otherChat, wider, granted, unsandboxed, mine]) p.kill('SIGKILL')
      }
    }, 60_000)

    it('is stopped in every chat at startup or when quitting, when no run’s end did it (a crash)', async () => {
      const c = createConversation({ projectId: null, model: 'm', think: null, skills: [] })
      const dir = workspace.workspaceFor(c.id).root
      await workspace.prepareWorkspace(workspace.workspaceFor(c.id))
      const real = realpathSync(dir)
      const left = await leftBehind(
        dir,
        policyFor({ workspace: real, home: fakeHome, readable: [], venv: join(root, 'venv'), pypi: false })
      )
      await settle()
      expect(await workspace.sweepWorkspaces()).toBeGreaterThanOrEqual(1)
      await new Promise((resolve) => setTimeout(resolve, 200))
      expect(alive(left.pid!)).toBe(false)
    }, 60_000)
  })

  // #76: a run waits while Ollmost works in its folder; Stop pressed meanwhile must still stop it.
  it('waits for Ollmost’s work in the folder to finish before code starts, and heeds Stop pressed meanwhile', async () => {
    let release = () => {}
    const work = quiesce(chatWs(ws), () => new Promise<void>((resolve) => (release = resolve)))
    await new Promise((resolve) => setTimeout(resolve, 100))
    const controller = new AbortController()
    let started = false
    const run = sandboxed('touch started-too-soon', { signal: controller.signal }).finally(() => (started = true))
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(started).toBe(false)
    controller.abort()
    release()
    await work
    await expect(run).rejects.toThrow()
    expect(existsSync(join(ws, 'started-too-soon'))).toBe(false)
  }, 30_000)

  // #71: Ollmost works in a chat's folder outside the sandbox, so it must never follow a link code left there.
  describe('links code leaves in its workspace', () => {
    const ctx = (dir: string) => ({ mode: 'chat' as const, skills: false, web: false, sources: ['code'], workspace: chatWs(dir) })
    const call = (name: string, args: Record<string, unknown>) => ({ function: { name, arguments: args } })
    const chat = async () => {
      const c = createConversation({ projectId: null, model: 'm', think: null, skills: [] })
      await workspace.prepareWorkspace(workspace.workspaceFor(c.id))
      return { id: c.id, dir: workspace.workspaceFor(c.id).root }
    }

    it('can’t replace the workspace or its .ollmost folder, so later runs still work there', async () => {
      const { dir } = await chat()
      const elsewhere = tempDir('ollmost-elsewhere-')
      const swap = [
        `cd / && rm -rf "${dir}"; mv "${dir}" "${dir}.moved"; ln -s "${elsewhere}" "${dir}.link" && mv "${dir}.link" "${dir}"`,
        `cd "${dir}" && rm -rf .ollmost; mv .ollmost .ollmost-moved; ln -s "${elsewhere}" .ollmost-link && mv -f .ollmost-link .ollmost`,
        'true'
      ].join('; ')
      const r = await tools.runTool(call('run_code', { language: 'bash', code: swap }), ctx(dir))
      expect(r.content).toMatch(/Operation not permitted/)
      expect(lstatSync(dir).isDirectory()).toBe(true)
      expect(lstatSync(join(dir, '.ollmost')).isDirectory()).toBe(true)
      const next = await tools.runTool(
        call('run_code', { language: 'python', code: "open('ok.txt', 'w').write('ok')\nprint('ok')" }),
        ctx(dir)
      )
      expect(next.content).toMatch(/^Exit code 0\.\n\nok/)
      expect(readdirSync(elsewhere)).toEqual([])
    }, 120_000)

    it('keeps the scripts a run executes outside the workspace, where code can’t change them', async () => {
      const { id, dir } = await chat()
      const code = [
        'import os',
        'print(os.path.dirname(__file__))',
        'try:',
        "    open(__file__, 'a').write('x')",
        "    print('changed')",
        'except OSError as e:',
        "    print('refused', e.errno)"
      ].join('\n')
      const r = await tools.runTool(call('run_code', { language: 'python', code }), ctx(dir))
      expect(r.content).toContain(workspace.scriptsDir(id))
      expect(r.content).toMatch(/refused 1\b/)
      expect(readdirSync(join(dir, '.ollmost')).filter((f) => f.startsWith('run-'))).toEqual([])
    }, 120_000)

    it('lists nothing through a link, and waits for none of the chat’s code to be running to list its files', async () => {
      const { id, dir } = await chat()
      const elsewhere = tempDir('ollmost-elsewhere-')
      writeFileSync(join(elsewhere, 'secret.txt'), 'secret')
      const code = `mkdir out && echo x > out/a.txt && rm -rf out && ln -s "${elsewhere}" out`
      const r = await tools.runTool(call('run_code', { language: 'bash', code }), ctx(dir))
      expect(r.content).toMatch(/^Exit code 0\./)
      expect(r.event.files).toEqual([])
      expect(await workspace.workspaceFiles(id)).toEqual([])
      expect(await workspace.workspaceFile(id, 'out/secret.txt')).toBeNull()

      const slow = tools.runTool(call('run_code', { language: 'bash', code: 'touch started; sleep 3' }), ctx(dir))
      for (let i = 0; i < 200 && !existsSync(join(dir, 'started')); i++) await new Promise((resolve) => setTimeout(resolve, 50))
      await expect(workspace.workspaceFiles(id)).rejects.toThrow(/Code is running in this chat/)
      await slow
      expect(await workspace.workspaceFiles(id)).toEqual(['started'])
    }, 120_000)
  })

  // #60: moving the data folder must cut off code an earlier session left running there. Its policy names the old
  // path, and Seatbelt checks the path an access resolves to at the time, even through the working directory.
  it('stops code writing a workspace once the folder above it is renamed', async () => {
    const before = realpathSync(tempDir('ollmost-move-a-'))
    const after = `${before}-moved`
    const workspace = join(before, 'workspaces', 'c1')
    mkdirSync(workspace, { recursive: true })
    const policy = policyFor({ workspace, home: fakeHome, readable: [], venv: join(root, 'venv'), pypi: false })
    const run = runSandboxed({
      command: 'echo ok > first.txt; sleep 2; echo x > second.txt; echo "exit=$?"',
      policy,
      workspace: chatWs(workspace),
      env: {},
      timeoutMs: 30_000,
      id: 'moved-folder'
    })
    // Rename once the first write has happened, while the code sleeps.
    const t0 = Date.now()
    while (!existsSync(join(workspace, 'first.txt')) && Date.now() - t0 < 10_000) await new Promise((r) => setTimeout(r, 50))
    renameSync(before, after)
    trackTempDir(after)
    const result = await run
    expect(existsSync(join(after, 'workspaces', 'c1', 'first.txt'))).toBe(true)
    expect(existsSync(join(after, 'workspaces', 'c1', 'second.txt'))).toBe(false)
    expect(result.output).toMatch(/Operation not permitted/)
  })

  // #80: the reaper takes any sandbox that may write a folder it's given, but neither write the folder above it nor
  // delete it, for Ollmost's. Other sandboxes pin folders too: sandbox-runtime always denies writing .git/hooks (among
  // others) under the folder a sandbox is started in, so Claude Code's sandbox in a repo has the repo pinned. So a
  // session working in the user's folder must be reaped by its own scratch, never by that folder.
  describe('the folders the reaper is given', () => {
    // Real paths, which the pins match. The user's folder is a repo; neither sandbox may write the scratch's parent.
    const base = realpathSync(tempDir('ollmost-session-'))
    const repo = join(base, 'repo')
    const scratch = join(base, 'runner', 'sessions', 's1')
    mkdirSync(join(repo, '.git', 'hooks'), { recursive: true })
    mkdirSync(scratch, { recursive: true })
    /** A sandboxed `sleep` started straight from the runtime, as if a run had left it (no run's end stops it). */
    const leftBehind = async (dir: string, p: typeof policy) => {
      const { SandboxManager } = await import('@anthropic-ai/sandbox-runtime')
      const { argv, env } = await SandboxManager.wrapWithSandboxArgv('exec sleep 30', '/bin/bash', p, undefined, dir, { commandId: 'left' })
      return spawn(argv[0], argv.slice(1), { cwd: dir, env: { ...process.env, ...env }, stdio: 'ignore', detached: true })
    }
    const settle = () => new Promise((resolve) => setTimeout(resolve, 1000))

    it("stops a session's code by its scratch, which only the session's policy pins", async () => {
      const run = policyFor({ workspace: scratch, home: fakeHome, readable: [], venv: join(root, 'venv'), pypi: false })
      const session = await leftBehind(repo, {
        ...run,
        filesystem: {
          ...run.filesystem,
          allowRead: [repo, ...(run.filesystem.allowRead ?? [])],
          allowWrite: [repo, scratch],
          denyWrite: [RUNTIME_TMPDIR, join(scratch, '.pinned')]
        }
      })
      await settle()
      try {
        expect(await reap([scratch])).toEqual({ stopped: 1, checked: [scratch] })
        await new Promise((resolve) => setTimeout(resolve, 200))
        expect(alive(session.pid!)).toBe(false)
        expect(await reap([scratch])).toEqual({ stopped: 0, checked: [scratch] })
      } finally {
        session.kill('SIGKILL')
      }
    }, 60_000)

    it('leaves a Claude Code sandbox in the same repo alone, which reaping by the repo would stop', async () => {
      // Like Claude Code's in the repo: it may write the repo, and .git/hooks there is pinned (the runtime would pin it
      // under this process's working directory, not the repo, so the policy says it). Nothing in it names the scratch.
      const claudeCode = await leftBehind(repo, {
        network: { allowedDomains: [], deniedDomains: [] },
        filesystem: { denyRead: [], allowRead: [], allowWrite: [repo], denyWrite: [RUNTIME_TMPDIR, join(repo, '.git', 'hooks')] }
      })
      await settle()
      try {
        expect(await reap([scratch])).toEqual({ stopped: 0, checked: [scratch] })
        expect(alive(claudeCode.pid!)).toBe(true)
        // Why the repo must never be given: the pin on its .git/hooks makes this sandbox look like Ollmost's.
        expect(await reap([repo])).toEqual({ stopped: 1, checked: [repo] })
        await new Promise((resolve) => setTimeout(resolve, 200))
        expect(alive(claudeCode.pid!)).toBe(false)
      } finally {
        claudeCode.kill('SIGKILL')
      }
    }, 60_000)
  })
})
