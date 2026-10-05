import { chmodSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { DIFF_CUT_MARK } from '@shared/diff'
import type { Workspace } from '../src/main/runner/workspace'
import { tempDir } from './tempDir'

// A code session's file tools (#93): where they may read and write (inside the folder by real path, never through a
// link on a write, never .git or a name the sandbox denies commands), what each gives back, and their place among
// the session's tools.

vi.mock('electron', () => ({
  safeStorage: { isEncryptionAvailable: () => false },
  shell: {},
  app: { getPath: () => '' }
}))

const { openDatabase } = await import('../src/main/db/index')
const { createConversation } = await import('../src/main/db/conversations')
const { updateSettings } = await import('../src/main/settings')
const { paths } = await import('../src/main/paths')
const workspace = await import('../src/main/runner/workspace')
const lock = await import('../src/main/runner/lock')
const files = await import('../src/main/code/files')
const tools = await import('../src/main/chat/tools')
const { codeTools, COMMANDS_KEY, EDITS_KEY } = await import('../src/main/code/tools')

const data = tempDir('ollmost-code-files-')
beforeAll(() => {
  openDatabase(':memory:')
  paths.data = data
  paths.files = join(data, 'files')
  paths.workspaces = join(data, 'workspaces')
  paths.runner = join(data, 'runner')
  updateSettings({ skills: { sources: { ollama: false, claude: false } } })
})

const made: string[] = []
afterAll(() => {
  for (const dir of [data, ...made]) rmSync(dir, { recursive: true, force: true })
})

/** A folder of the user's holding `tree`, by its real path, with a session working in it. */
function project(tree: Record<string, string | Buffer> = {}) {
  const dir = realpathSync(tempDir('ollmost-user-'))
  made.push(dir)
  for (const [rel, text] of Object.entries(tree)) {
    mkdirSync(join(dir, dirname(rel)), { recursive: true })
    writeFileSync(join(dir, rel), text)
  }
  const c = createConversation({ projectId: null, model: 'm', think: null, skills: [], mode: 'code', root: dir, title: basename(dir) })
  return { dir, ws: workspace.workspaceFor(c.id) }
}
const ctxFor = (ws: Workspace) => ({ mode: 'code' as const, skills: false, web: false, sources: [], workspace: ws })
const call = (name: string, args: Record<string, unknown>) => ({ function: { name, arguments: args } })
const text = (dir: string, rel: string) => readFileSync(join(dir, rel), 'utf8')

/** The reason a file tool refused, or a failure when it didn't refuse. */
async function refusal(p: Promise<unknown>): Promise<string> {
  try {
    await p
  } catch (err) {
    if (err instanceof files.Refused) return err.reason
    throw err
  }
  throw new Error('not refused')
}

const THREE = 'one\ntwo\nthree\n'

describe('where a file tool may work', () => {
  it('takes a path inside the folder as relative, with a leading ./, or absolute', async () => {
    const { dir, ws } = project({ 'src/a.ts': THREE })
    for (const path of ['src/a.ts', './src/a.ts', join(dir, 'src', 'a.ts'), 'src/../src/a.ts']) {
      const r = await files.readFile(ws, path)
      expect(r.rel).toBe('src/a.ts')
      expect(r.total).toBe(3)
    }
  })

  it('refuses a path that leaves the folder, an empty one, and one with NUL in it', async () => {
    const { ws } = project({ 'a.ts': THREE })
    for (const path of ['../x', '/etc/hosts', 'src/../../x', '..'])
      expect(await refusal(files.readFile(ws, path))).toBe('outside the folder')
    expect(await refusal(files.readFile(ws, ''))).toBe('no path')
    expect(await refusal(files.readFile(ws, 7))).toBe('no path')
    expect(await refusal(files.readFile(ws, 'a.ts\0'))).toBe('bad path')
  })

  it('follows a link of the user’s that stays inside the folder, and refuses one that leaves it', async () => {
    const { dir, ws } = project({ 'src/a.ts': THREE })
    symlinkSync(join(dir, 'src', 'a.ts'), join(dir, 'a-link'))
    symlinkSync(join(dir, 'src'), join(dir, 'src-link'))
    symlinkSync('/etc/hosts', join(dir, 'out'))
    symlinkSync(realpathSync(tmpdir()), join(dir, 'docs'))
    symlinkSync(join(dir, 'nowhere'), join(dir, 'dangling'))
    expect((await files.readFile(ws, 'a-link')).text).toMatch(/1\tone/)
    expect((await files.readFile(ws, 'src-link/a.ts')).rel).toBe('src-link/a.ts')
    expect(await refusal(files.readFile(ws, 'out'))).toBe('outside the folder')
    expect(await refusal(files.readFile(ws, 'docs/anything'))).toBe('outside the folder')
    expect(await refusal(files.readFile(ws, 'dangling'))).toBe('broken link')
  })

  it('never writes through a link, even one that stays inside', async () => {
    const { dir, ws } = project({ 'src/a.ts': THREE })
    symlinkSync(join(dir, 'src', 'a.ts'), join(dir, 'a-link'))
    symlinkSync(join(dir, 'src'), join(dir, 'src-link'))
    expect(await refusal(files.editFile(ws, { path: 'a-link', oldString: 'two', newString: '2' }))).toBe('is a link')
    await expect(files.writeFile(ws, { path: 'a-link', content: 'x' })).rejects.toThrow(/is a link/)
    // A new file through a folder link that leaves, or a dangling link, is refused as a read is.
    symlinkSync(realpathSync(tmpdir()), join(dir, 'docs'))
    symlinkSync(join(dir, 'nowhere'), join(dir, 'dangling'))
    expect(await refusal(files.writeFile(ws, { path: 'docs/new.txt', content: 'x' }))).toBe('outside the folder')
    expect(await refusal(files.writeFile(ws, { path: 'dangling/new.txt', content: 'x' }))).toBe('broken link')
    expect(await refusal(files.writeFile(ws, { path: 'dangling', content: 'x' }))).toBe('broken link')
    // A folder link on the way is followed: the write lands inside the folder, on a real file.
    await files.writeFile(ws, { path: 'src-link/b.ts', content: 'b\n' })
    expect(text(dir, 'src/b.ts')).toBe('b\n')
    expect(text(dir, 'src/a.ts')).toBe(THREE)
  })

  it.each([
    '.git/config',
    '.git/hooks/pre-commit',
    '.git/info/exclude',
    '.git',
    '.GIT/x',
    'sub/.git/x',
    'sub/.git',
    '.gitmodules',
    'sub/.gitmodules',
    '.gitconfig',
    '.zshrc',
    '.bashrc',
    '.bash_profile',
    '.zprofile',
    '.profile',
    '.ripgreprc',
    '.mcp.json',
    'sub/.Zshrc',
    '.vscode/settings.json',
    '.idea/workspace.xml',
    '.claude/commands/x.md',
    '.claude/agents/x.md',
    // Spellings the file system folds to the same names: the long s, and the Kelvin sign for k.
    '.vſcode/tasks.json',
    '.claude/commandſ/x.md',
    '.mcp.jſon',
    'sub/.zſhrc',
    '.zshrc/inside'
  ])('never writes %s, which the sandbox keeps from the session’s commands', async (path) => {
    const { ws } = project({ '.git/config': '[core]\n', 'sub/.git/x': 'x' })
    expect(await refusal(files.writeFile(ws, { path, content: 'x' }))).toBe('read-only')
    expect(await refusal(files.editFile(ws, { path, oldString: 'a', newString: 'b' }))).toBe('read-only')
  })

  it.each(['.claude/notes.md', 'src/.gitignore', '.github/workflows/ci.yml', 'hooks/pre-commit', 'zshrc', 'src/profile.ts'])(
    'writes %s, which only looks like a read-only name',
    async (path) => {
      const { dir, ws } = project()
      await files.writeFile(ws, { path, content: 'x\n' })
      expect(text(dir, path)).toBe('x\n')
    }
  )

  it('refuses a write anywhere under a read-only name, even when the session’s folder is inside one', async () => {
    const { dir } = project({ '.git/config': '', '.claude/commands/x.md': '' })
    const inGit = workspace.workspaceFor(
      createConversation({ projectId: null, model: 'm', think: null, skills: [], mode: 'code', root: join(dir, '.git'), title: 'g' }).id
    )
    expect(await refusal(files.writeFile(inGit, { path: 'hooks/pre-commit', content: '#!/bin/sh\n' }))).toBe('read-only')
    expect((await files.readFile(inGit, 'config')).rel).toBe('config')
    const inCommands = workspace.workspaceFor(
      createConversation({
        projectId: null,
        model: 'm',
        think: null,
        skills: [],
        mode: 'code',
        root: join(dir, '.claude', 'commands'),
        title: 'c'
      }).id
    )
    expect(await refusal(files.writeFile(inCommands, { path: 'y.md', content: 'y' }))).toBe('read-only')
  })

  it('refuses a write whose real path is read-only, however it was reached', async () => {
    const { dir, ws } = project({ '.git/hooks/keep': '' })
    symlinkSync(join(dir, '.git', 'hooks'), join(dir, 'hooks-link'))
    expect(await refusal(files.writeFile(ws, { path: 'hooks-link/pre-commit', content: '#!/bin/sh\n' }))).toBe('read-only')
  })

  it('reads inside .git, as a command may', async () => {
    const { ws } = project({ '.git/HEAD': 'ref: refs/heads/main\n' })
    expect((await files.readFile(ws, '.git/HEAD')).text).toMatch(/refs\/heads\/main/)
  })

  it('refuses while the session’s code runs, and when its folder is gone', async () => {
    const { dir, ws } = project({ 'a.ts': THREE })
    await lock.codeStarting(ws)
    try {
      await expect(files.readFile(ws, 'a.ts')).rejects.toBeInstanceOf(lock.CodeRunningError)
    } finally {
      await lock.codeEnded(ws)
    }
    renameSync(dir, `${dir}-moved`)
    made.push(`${dir}-moved`)
    await expect(files.readFile(ws, 'a.ts')).rejects.toBeInstanceOf(workspace.RootMissingError)
  })
})

describe('read_file', () => {
  it('numbers the lines, keeping the whole file when it fits', async () => {
    const { ws } = project({ 'a.ts': THREE })
    expect(await files.readFile(ws, 'a.ts')).toEqual({
      rel: 'a.ts',
      text: '     1\tone\n     2\ttwo\n     3\tthree',
      from: 1,
      to: 3,
      total: 3
    })
  })

  it('reads a range with offset and limit, and stops at the character budget with at least one line', async () => {
    const { ws } = project({ 'a.ts': THREE })
    expect(await files.readFile(ws, 'a.ts', { offset: 2, limit: 1 })).toMatchObject({ text: '     2\ttwo', from: 2, to: 2, total: 3 })
    expect(await files.readFile(ws, 'a.ts', { offset: 3, limit: 10 })).toMatchObject({ text: '     3\tthree', from: 3, to: 3 })
    expect(await files.readFile(ws, 'a.ts', { maxChars: 21 })).toMatchObject({ text: '     1\tone\n     2\ttwo', to: 2 })
    expect(await files.readFile(ws, 'a.ts', { maxChars: 20 })).toMatchObject({ text: '     1\tone', to: 1 })
    expect(await files.readFile(ws, 'a.ts', { maxChars: 1 })).toMatchObject({ text: '     1\tone', to: 1 })
  })

  it('keeps an empty file, a final line without a newline, and CR line endings as they are', async () => {
    const { ws } = project({ empty: '', bare: 'a\nb', crlf: 'a\r\nb\r\n' })
    expect(await files.readFile(ws, 'empty')).toEqual({ rel: 'empty', text: '', from: 1, to: 0, total: 0 })
    expect(await files.readFile(ws, 'bare')).toMatchObject({ text: '     1\ta\n     2\tb', total: 2 })
    expect(await files.readFile(ws, 'crlf')).toMatchObject({ text: '     1\ta\r\n     2\tb\r', total: 2 })
  })

  it('cuts a very long line', async () => {
    const { ws } = project({ 'min.js': `${'x'.repeat(3000)}\n` })
    const r = await files.readFile(ws, 'min.js')
    expect(r.text).toHaveLength(7 + 2000 + 1)
    expect(r.text.endsWith('…')).toBe(true)
  })

  it('refuses an offset past the end, a folder, a missing file, a binary file and one too large', async () => {
    const { ws } = project({
      'a.ts': THREE,
      bin: Buffer.from([0x89, 0x50, 0, 0x47]),
      'big.txt': 'a'.repeat(8 * 1024 * 1024 + 1),
      'dir/x': ''
    })
    expect(await refusal(files.readFile(ws, 'a.ts', { offset: 4 }))).toBe('offset past the end')
    expect(await refusal(files.readFile(ws, 'dir'))).toBe('is a folder')
    expect(await refusal(files.readFile(ws, '.'))).toBe('is a folder')
    expect(await refusal(files.readFile(ws, 'nope.ts'))).toBe('not found')
    expect(await refusal(files.readFile(ws, 'bin'))).toBe('binary file')
    expect(await refusal(files.readFile(ws, 'big.txt'))).toBe('too large')
  })
})

describe('edit_file and write_file', () => {
  it('replaces one exact passage and reports a unified diff', async () => {
    const { dir, ws } = project({ 'a.ts': THREE })
    const r = await files.editFile(ws, { path: 'a.ts', oldString: 'two', newString: '2' })
    expect(r).toEqual({
      rel: 'a.ts',
      diff: '--- a/a.ts\n+++ b/a.ts\n@@ -1,3 +1,3 @@\n one\n-two\n+2\n three',
      added: 1,
      removed: 1,
      size: 12,
      created: false
    })
    expect(text(dir, 'a.ts')).toBe('one\n2\nthree\n')
  })

  it('keeps the file’s mode, and treats $ in new_string as itself', async () => {
    const { dir, ws } = project({ 'run.sh': '#!/bin/sh\necho x\n' })
    chmodSync(join(dir, 'run.sh'), 0o755)
    await files.editFile(ws, { path: 'run.sh', oldString: 'echo x', newString: 'echo "$&$1"' })
    expect(text(dir, 'run.sh')).toBe('#!/bin/sh\necho "$&$1"\n')
    expect(statSync(join(dir, 'run.sh')).mode & 0o777).toBe(0o755)
  })

  it('refuses an old_string that is missing, ambiguous, empty or unchanged, and replaces every occurrence with replace_all', async () => {
    const { dir, ws } = project({ 'a.ts': 'x = 1\ny = 1\n' })
    expect(await refusal(files.editFile(ws, { path: 'a.ts', oldString: '= 2', newString: '= 3' }))).toBe('old_string not found')
    expect(await refusal(files.editFile(ws, { path: 'a.ts', oldString: '= 1', newString: '= 2' }))).toBe('old_string appears 2 times')
    expect(await refusal(files.editFile(ws, { path: 'a.ts', oldString: '', newString: 'z' }))).toBe('empty old_string')
    expect(await refusal(files.editFile(ws, { path: 'a.ts', oldString: 'x', newString: 'x' }))).toBe('no change')
    expect(await refusal(files.editFile(ws, { path: 'a.ts', oldString: 'x', newString: 7 }))).toBe('bad arguments')
    expect(await refusal(files.editFile(ws, { path: 'nope.ts', oldString: 'x', newString: 'y' }))).toBe('not found')
    const r = await files.editFile(ws, { path: 'a.ts', oldString: '= 1', newString: '= 2', replaceAll: true })
    expect(r).toMatchObject({ added: 2, removed: 2 })
    expect(text(dir, 'a.ts')).toBe('x = 2\ny = 2\n')
  })

  it('writes a new file with its folders, with a diff from /dev/null', async () => {
    const { dir, ws } = project()
    const r = await files.writeFile(ws, { path: 'deep/er/new.txt', content: 'hi\nthere\n' })
    expect(r).toEqual({
      rel: 'deep/er/new.txt',
      diff: '--- /dev/null\n+++ b/deep/er/new.txt\n@@ -0,0 +1,2 @@\n+hi\n+there',
      added: 2,
      removed: 0,
      size: 9,
      created: true
    })
    expect(text(dir, 'deep/er/new.txt')).toBe('hi\nthere\n')
    expect(statSync(join(dir, 'deep', 'er', 'new.txt')).mode & 0o777).toBe(0o644 & ~process.umask())
  })

  it('replaces an existing file, counting the lines that changed', async () => {
    const { dir, ws } = project({ 'a.ts': THREE })
    const r = await files.writeFile(ws, { path: 'a.ts', content: 'one\nthree\nfour\n' })
    expect(r).toMatchObject({ added: 1, removed: 1, created: false, size: 15 })
    expect(text(dir, 'a.ts')).toBe('one\nthree\nfour\n')
  })

  it('refuses to replace a folder or a binary file, and content over 2 MB', async () => {
    const { ws } = project({ 'dir/x': '', bin: Buffer.from([0, 1, 2]) })
    expect(await refusal(files.writeFile(ws, { path: 'dir', content: 'x' }))).toBe('is a folder')
    expect(await refusal(files.writeFile(ws, { path: 'bin', content: 'x' }))).toBe('binary file')
    expect(await refusal(files.writeFile(ws, { path: 'big', content: 'x'.repeat(2 * 1024 * 1024 + 1) }))).toBe('too large')
    expect(await refusal(files.writeFile(ws, { path: 'big', content: 7 }))).toBe('bad arguments')
  })

  it('refuses to edit or replace a file that isn’t UTF-8, which a read still shows', async () => {
    const { dir, ws } = project({ 'latin1.txt': Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a]) })
    expect(await refusal(files.editFile(ws, { path: 'latin1.txt', oldString: 'caf', newString: 'bar' }))).toBe('not UTF-8 text')
    expect(await refusal(files.writeFile(ws, { path: 'latin1.txt', content: 'x' }))).toBe('not UTF-8 text')
    expect((await files.readFile(ws, 'latin1.txt')).text).toBe('     1\tcaf\uFFFD')
    expect(readFileSync(join(dir, 'latin1.txt'))).toEqual(Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a]))
  })

  it('takes bare line breaks in an edit to a file with CR LF ones, and as they are in a file with both', async () => {
    const { dir, ws } = project({ 'win.txt': 'one\r\ntwo\r\nthree\r\n', 'mixed.txt': 'one\ntwo\nthree\r\n' })
    const r = await files.editFile(ws, { path: 'win.txt', oldString: 'one\ntwo', newString: 'uno\ndos' })
    expect(r).toMatchObject({ added: 2, removed: 2 })
    expect(readFileSync(join(dir, 'win.txt'), 'utf8')).toBe('uno\r\ndos\r\nthree\r\n')
    await files.editFile(ws, { path: 'mixed.txt', oldString: 'one\ntwo', newString: 'uno\ndos' })
    expect(readFileSync(join(dir, 'mixed.txt'), 'utf8')).toBe('uno\ndos\nthree\r\n')
  })

  it('keeps a byte order mark through an edit', async () => {
    const { dir, ws } = project({ 'bom.txt': '\uFEFFhello\n' })
    const r = await files.editFile(ws, { path: 'bom.txt', oldString: 'hello', newString: 'bonjour' })
    expect(r.diff).toBe('--- a/bom.txt\n+++ b/bom.txt\n@@ -1,1 +1,1 @@\n-\uFEFFhello\n+\uFEFFbonjour')
    expect(readFileSync(join(dir, 'bom.txt'))).toEqual(Buffer.from('\uFEFFbonjour\n', 'utf8'))
  })

  it('gives the diff an edit or a write would make, or throws what the edit would, writing nothing', async () => {
    const { dir, ws } = project({ 'a.ts': THREE })
    expect(await files.editDiff(ws, { path: 'a.ts', oldString: 'two', newString: '2' })).toEqual({
      diff: '--- a/a.ts\n+++ b/a.ts\n@@ -1,3 +1,3 @@\n one\n-two\n+2\n three',
      added: 1,
      removed: 1
    })
    await expect(files.editDiff(ws, { path: 'a.ts', oldString: 'nope', newString: '2' })).rejects.toThrow(/not found/)
    expect(await files.writeDiff(ws, { path: 'b.ts', content: 'b\n' })).toEqual({
      diff: '--- /dev/null\n+++ b/b.ts\n@@ -0,0 +1,1 @@\n+b',
      added: 1,
      removed: 0
    })
    await expect(files.writeDiff(ws, { path: '.git/config', content: 'b\n' })).rejects.toThrow(files.Refused)
    // Nothing was written.
    expect(text(dir, 'a.ts')).toBe(THREE)
    expect(() => statSync(join(dir, 'b.ts'))).toThrow()
  })

  it('cuts a huge diff, and marks a missing final newline', async () => {
    const { ws } = project()
    const r = await files.writeFile(ws, { path: 'big.txt', content: `${'y'.repeat(60)}\n`.repeat(2500) })
    expect(r.diff.endsWith(DIFF_CUT_MARK)).toBe(true)
    expect(r.diff.length).toBeLessThan(100_100)
    // The counts are of the whole change, not of what's left of the diff (#149).
    expect(r).toMatchObject({ added: 2500, removed: 0 })
    // Past the diff's time or edit limits, the whole file is shown replaced.
    expect(files.unifiedDiff('x', 'a\nb\nc\n', 'x\nb\ny', { maxEditLength: 0 })).toEqual({
      diff: '--- a/x\n+++ b/x\n@@ -1,3 +1,3 @@\n-a\n-b\n-c\n+x\n+b\n+y\n\\ No newline at end of file',
      added: 3,
      removed: 3
    })
    // The same change, within the limits, keeps the unchanged line as context.
    expect(files.unifiedDiff('x', 'a\nb\nc\n', 'x\nb\ny').diff).toContain('\n b\n')
    expect(files.unifiedDiff('x', 'a', 'b')).toEqual({
      diff: '--- a/x\n+++ b/x\n@@ -1,1 +1,1 @@\n-a\n\\ No newline at end of file\n+b\n\\ No newline at end of file',
      added: 1,
      removed: 1
    })
  })
})

describe('list_files and search_files', () => {
  const TREE = {
    'a.md': 'one\ntwo\n',
    'src/x.ts': 'const two = 2\n',
    'src/y.ts': 'three\n',
    'src/sub/z.ts': 'const zed = 3\n',
    'README.md': '# two\n'
  }

  it('lists the files under the folder or one of its subfolders, matching a glob', async () => {
    const { ws } = project(TREE)
    expect(await files.listFiles(ws, {})).toEqual({
      rel: '',
      files: ['README.md', 'a.md', 'src/sub/z.ts', 'src/x.ts', 'src/y.ts'],
      cut: false
    })
    expect(await files.listFiles(ws, { path: 'src' })).toMatchObject({ rel: 'src', files: ['src/sub/z.ts', 'src/x.ts', 'src/y.ts'] })
    expect((await files.listFiles(ws, { pattern: '*.ts' })).files).toEqual(['src/sub/z.ts', 'src/x.ts', 'src/y.ts'])
    expect((await files.listFiles(ws, { pattern: 'src/*.ts' })).files).toEqual(['src/x.ts', 'src/y.ts'])
    expect((await files.listFiles(ws, { pattern: '*.rs' })).files).toEqual([])
  })

  it('leaves out what .gitignore ignores, and stops at the cap', async () => {
    const tree: Record<string, string> = { '.gitignore': 'dist/\n*.log\n', 'dist/x.js': '', 'a.log': '', 'src/a.ts': '' }
    for (let i = 0; i < 510; i++) tree[`many/${String(i).padStart(3, '0')}.txt`] = ''
    const { ws } = project(tree)
    const all = await files.listFiles(ws, {})
    expect(all.files).not.toContain('dist/x.js')
    expect(all.files).not.toContain('a.log')
    expect(all.files).toContain('.gitignore')
    expect(all).toMatchObject({ cut: true })
    expect(all.files).toHaveLength(500)
    const r = await tools.runTool(call('list_files', {}), ctxFor(ws))
    expect(r.event.summary).toBe('500+ files')
    expect(r.content).toMatch(/\[… the list stops at 500 files; narrow the pattern or the folder\]$/)
    expect((await files.listFiles(ws, { pattern: '*.ts' })).files).toEqual(['src/a.ts'])
  })

  it('refuses a folder outside, a file given as the folder, and a missing one', async () => {
    const { ws } = project(TREE)
    expect(await refusal(files.listFiles(ws, { path: '..' }))).toBe('outside the folder')
    expect(await refusal(files.listFiles(ws, { path: 'a.md' }))).toBe('not a folder')
    expect(await refusal(files.listFiles(ws, { path: 'nope' }))).toBe('not found')
  })

  it('finds the lines matching a regular expression, with their file and number', async () => {
    const { ws } = project(TREE)
    expect(await files.searchFiles(ws, { pattern: 'two|zed' })).toEqual({
      rel: '',
      lines: ['README.md:1: # two', 'a.md:2: two', 'src/sub/z.ts:1: const zed = 3', 'src/x.ts:1: const two = 2'],
      matches: 4,
      files: 4,
      cut: null
    })
    expect(await files.searchFiles(ws, { pattern: 'two', path: 'src', glob: '*.ts' })).toMatchObject({
      rel: 'src',
      lines: ['src/x.ts:1: const two = 2']
    })
    expect(await files.searchFiles(ws, { pattern: '^t', glob: '*.md' })).toMatchObject({ lines: ['a.md:2: two'], matches: 1, files: 1 })
    expect(await files.searchFiles(ws, { pattern: 'nothing here' })).toMatchObject({ lines: [], matches: 0, files: 0 })
  })

  it('ends a search whose pattern backtracks without end at the deadline, with what it found', async () => {
    const { ws } = project({ 'a.txt': 'needle\n', 'z.txt': `${'a'.repeat(32)}c\n` })
    const began = Date.now()
    const r = await files.searchFiles(ws, { pattern: '(a+)+b|needle', maxMs: 2000 })
    expect(Date.now() - began).toBeLessThan(8_000)
    expect(r).toMatchObject({ lines: ['a.txt:1: needle'], matches: 1, files: 1, cut: 'the search stopped after 2 seconds' })
    // Stop ends it at once, as a stop and not a result.
    const controller = new AbortController()
    setTimeout(() => controller.abort(), 100)
    const stopping = Date.now()
    await expect(files.searchFiles(ws, { pattern: '(a+)+b', signal: controller.signal })).rejects.toThrow(/abort/i)
    expect(Date.now() - stopping).toBeLessThan(3_000)
  }, 20_000)

  it('refuses an empty or invalid pattern', async () => {
    const { ws } = project(TREE)
    expect(await refusal(files.searchFiles(ws, { pattern: '' }))).toBe('no pattern')
    expect(await refusal(files.searchFiles(ws, { pattern: '[' }))).toBe('invalid pattern')
    expect(await refusal(files.searchFiles(ws, { pattern: 'x', glob: `{${'a,'.repeat(600)}}` }))).toBe('pattern too long')
    expect(await refusal(files.listFiles(ws, { pattern: '*'.repeat(1001) }))).toBe('pattern too long')
  })

  it('skips binary files and files over 1 MB, stops at 200 matches, and cuts a long line', async () => {
    const { ws } = project({
      'a.txt': 'needle\n',
      bin: Buffer.concat([Buffer.from('needle\n'), Buffer.from([0, 1])]),
      'big.txt': `needle ${'x'.repeat(1024 * 1024)}\n`,
      'many.txt': 'needle\n'.repeat(250),
      'long.txt': `needle ${'y'.repeat(400)}\n`
    })
    const r = await files.searchFiles(ws, { pattern: 'needle' })
    expect(r.lines.filter((l) => !l.startsWith('many.txt:'))).toEqual(['a.txt:1: needle', `long.txt:1: needle ${'y'.repeat(293)}…`])
    expect(r).toMatchObject({ matches: 200, files: 3, cut: 'the search stopped at 200 matches' })
  })
})

describe('the file tools among a session’s tools', () => {
  const names = (c: Parameters<typeof tools.toolsFor>[0]) => (tools.toolsFor(c) ?? []).map((t) => t.function.name)

  it('are offered with run_command in a session, and nowhere else', () => {
    const { ws } = project()
    const ctx = ctxFor(ws)
    expect(names(ctx)).toEqual(['read_file', 'list_files', 'search_files', 'edit_file', 'write_file', 'run_command'])
    expect(names({ ...ctx, mode: 'chat', sources: ['code'] })).toEqual([])
    expect(codeTools.id).toBe('code')
  })

  it('read unasked; ask before an edit or a command, under one key for each kind', () => {
    const { ws } = project()
    const ctx = ctxFor(ws)
    for (const name of ['read_file', 'list_files', 'search_files']) expect(tools.approvalFor(call(name, {}), ctx)).toBe('auto')
    for (const name of ['edit_file', 'write_file']) {
      expect(tools.approvalFor(call(name, {}), ctx)).toBe('ask')
      expect(tools.allowKeyFor(call(name, {}), ctx)).toBe(EDITS_KEY)
      expect(tools.toolEndpoint(call(name, {}), ctx)).toBe(`ollmost://code/${name}`)
    }
    expect(tools.allowKeyFor(call('run_command', {}), ctx)).toBe(COMMANDS_KEY)
    updateSettings({ code: { edits: 'allow' } })
    expect(tools.approvalFor(call('edit_file', {}), ctx)).toBe('auto')
    expect(tools.approvalFor(call('run_command', {}), ctx)).toBe('ask')
    updateSettings({ code: { edits: 'ask' } })
  })

  it('shows the diff an edit would make while it asks, keeping long arguments short', async () => {
    const { ws } = project({ 'a.ts': THREE })
    const ctx = ctxFor(ws)
    expect(await tools.pendingEvent(call('edit_file', { path: 'a.ts', old_string: 'two', new_string: '2' }), ctx)).toEqual({
      tool: 'edit_file',
      args: { path: 'a.ts', old_string: 'two', new_string: '2' },
      ok: true,
      pending: true,
      summary: 'a.ts',
      diff: '--- a/a.ts\n+++ b/a.ts\n@@ -1,3 +1,3 @@\n one\n-two\n+2\n three',
      changed: { added: 1, removed: 1 }
    })
    const long = await tools.pendingEvent(call('write_file', { path: 'b.ts', content: 'z'.repeat(5000) }), ctx)
    expect(long.diff).toMatch(/^--- \/dev\/null\n\+\+\+ b\/b\.ts\n/)
    expect(String(long.args.content)).toMatch(/^z{2000}\n\[… 3000 more characters cut\]$/)
    expect(await tools.pendingEvent(call('edit_file', { path: 'a.ts', old_string: 'nope', new_string: '2' }), ctx)).not.toHaveProperty(
      'diff'
    )
    expect(await tools.pendingEvent(call('read_file', { path: 'a.ts', offset: 2 }), ctx)).toEqual({
      tool: 'read_file',
      args: { path: 'a.ts', offset: 2 },
      ok: true,
      pending: true,
      summary: 'a.ts'
    })
    expect(await tools.pendingEvent(call('list_files', {}), ctx)).toMatchObject({ summary: 'files', args: {} })
    expect(await tools.pendingEvent(call('search_files', { pattern: 'x', glob: '*.ts' }), ctx)).toMatchObject({
      summary: 'x',
      args: { pattern: 'x', glob: '*.ts' }
    })
  })

  it('answers an edit its preview couldn’t make without asking, and leaves the file alone', async () => {
    const { dir, ws } = project({ 'a.ts': THREE })
    const ctx = ctxFor(ws)
    const missing = call('edit_file', { path: 'a.ts', old_string: 'nope', new_string: '2' })
    expect(await tools.pendingEvent(missing, ctx)).not.toHaveProperty('diff')
    expect(tools.approvalFor(missing, ctx)).toBe('auto')
    // The file changing meanwhile doesn't get the edit through unasked: the answer is the preview's.
    writeFileSync(join(dir, 'a.ts'), 'nope\n')
    const r = await tools.runTool(missing, ctx)
    expect(r.content).toMatch(/^Error: /)
    expect(r.event).toMatchObject({ tool: 'edit_file', ok: false, summary: 'old_string not found' })
    expect(text(dir, 'a.ts')).toBe('nope\n')
    // Looked at afresh the next time it's called.
    expect(await tools.pendingEvent(missing, ctx)).toHaveProperty('diff')
    expect(tools.approvalFor(missing, ctx)).toBe('ask')
    // A refused target likewise.
    const denied = call('write_file', { path: '.git/config', content: 'x' })
    expect(await tools.pendingEvent(denied, ctx)).not.toHaveProperty('diff')
    expect(tools.approvalFor(denied, ctx)).toBe('auto')
    expect((await tools.runTool(denied, ctx)).event).toMatchObject({ tool: 'write_file', ok: false, summary: 'read-only' })
  })

  it('runs each tool, giving the model the result and the reply its event', async () => {
    const { dir, ws } = project({ 'a.ts': THREE, 'src/b.ts': 'two\n' })
    const ctx = ctxFor(ws)
    const read = await tools.runTool(call('read_file', { path: 'a.ts' }), ctx)
    expect(read.content).toBe('a.ts (3 lines)\n\n     1\tone\n     2\ttwo\n     3\tthree')
    expect(read.event).toMatchObject({
      tool: 'read_file',
      args: { path: 'a.ts' },
      ok: true,
      summary: '3 lines',
      record: 'Read a.ts (3 lines). Read it again for the text.'
    })
    const part = await tools.runTool(call('read_file', { path: 'a.ts', offset: '2', limit: '1' }), ctx)
    expect(part.content).toBe('a.ts (lines 2–2 of 3; call read_file again with offset=3 for more)\n\n     2\ttwo')
    expect(part.event.summary).toBe('lines 2–2 of 3')
    // At the last line there is nothing more to ask for.
    expect((await tools.runTool(call('read_file', { path: 'a.ts', offset: 3 }), ctx)).content).toBe(
      'a.ts (lines 3–3 of 3)\n\n     3\tthree'
    )

    const edit = await tools.runTool(call('edit_file', { path: 'a.ts', old_string: 'two', new_string: '2' }), ctx)
    expect(edit.content).toBe('Edited a.ts (+1 −1).\n\n--- a/a.ts\n+++ b/a.ts\n@@ -1,3 +1,3 @@\n one\n-two\n+2\n three')
    expect(edit.event).toMatchObject({
      tool: 'edit_file',
      ok: true,
      summary: '+1 −1',
      files: [{ path: 'a.ts', size: 12 }],
      record: 'Edited a.ts (+1 −1).'
    })
    expect(edit.event.diff).toMatch(/^--- a\/a\.ts/)
    expect(text(dir, 'a.ts')).toBe('one\n2\nthree\n')

    const write = await tools.runTool(call('write_file', { path: 'new/c.ts', content: 'c\nd\n' }), ctx)
    expect(write.content).toBe('Wrote new/c.ts (new file, 2 lines).')
    expect(write.event).toMatchObject({
      tool: 'write_file',
      ok: true,
      summary: 'new file, 2 lines',
      files: [{ path: 'new/c.ts', size: 4 }]
    })
    expect(write.event.diff).toMatch(/^--- \/dev\/null/)

    const list = await tools.runTool(call('list_files', { pattern: '*.ts' }), ctx)
    expect(list.content).toBe('a.ts\nnew/c.ts\nsrc/b.ts')
    expect(list.event).toMatchObject({ tool: 'list_files', ok: true, summary: '3 files', record: 'a.ts\nnew/c.ts\nsrc/b.ts' })
    const none = await tools.runTool(call('list_files', { pattern: '*.rs', path: 'src' }), ctx)
    expect(none.content).toMatch(/^No files match \*\.rs in src \(what \.gitignore ignores/)
    expect(none.event.summary).toBe('no files')

    const search = await tools.runTool(call('search_files', { pattern: 'two' }), ctx)
    expect(search.content).toBe('src/b.ts:1: two')
    expect(search.event).toMatchObject({ tool: 'search_files', ok: true, summary: '1 match in 1 file' })
    const nothing = await tools.runTool(call('search_files', { pattern: 'zzz', path: 'src' }), ctx)
    expect(nothing.content).toMatch(/^No matches for \/zzz\/ in src \(what \.gitignore ignores/)
    expect(nothing.event.summary).toBe('no matches')
  })

  it('tells the model why a call failed, and the reply in a word or two', async () => {
    const { dir, ws } = project({ 'a.ts': THREE, 'dir/x': '' })
    const ctx = ctxFor(ws)
    const missing = await tools.runTool(call('read_file', { path: 'nope.ts' }), ctx)
    expect(missing).toMatchObject({
      content: 'Error: There is no file at nope.ts.',
      event: { tool: 'read_file', ok: false, summary: 'not found' }
    })
    expect((await tools.runTool(call('read_file', { path: 'dir' }), ctx)).event.summary).toBe('is a folder')
    expect((await tools.runTool(call('edit_file', { path: 'a.ts', old_string: 'x', new_string: 'y' }), ctx)).event.summary).toBe(
      'old_string not found'
    )
    const hooks = await tools.runTool(call('write_file', { path: '.git/hooks/pre-commit', content: '' }), ctx)
    expect(hooks.content).toMatch(/^Error: Can’t write \.git\/hooks\/pre-commit: \.git is off limits/)
    expect(hooks.event.summary).toBe('read-only')
    const commands = await tools.runTool(call('write_file', { path: '.claude/commands/x.md', content: '' }), ctx)
    expect(commands.content).toMatch(/\.claude\/commands is read-only for a session, as it is for its commands\./)
    const zeroWidth = await tools.runTool(call('write_file', { path: '.g\u200Cit/config', content: '' }), ctx)
    expect(zeroWidth.event.summary).toBe('read-only')
    const direction = await tools.runTool(call('write_file', { path: '.v\u202Ascode/x', content: '' }), ctx)
    expect(direction.event.summary).toBe('read-only')
    expect((await tools.runTool(call('search_files', { pattern: '(' }), ctx)).event.summary).toBe('invalid pattern')
    await lock.codeStarting(ws)
    try {
      expect((await tools.runTool(call('read_file', { path: 'a.ts' }), ctx)).event).toMatchObject({ ok: false, summary: 'code running' })
    } finally {
      await lock.codeEnded(ws)
    }
    renameSync(dir, `${dir}-moved`)
    made.push(`${dir}-moved`)
    const gone = await tools.runTool(call('read_file', { path: 'a.ts' }), ctx)
    expect(gone.event.summary).toBe('folder missing')
    expect(gone.content).toMatch(/no longer at/)
  })

  it('reads within the room the reply has for the result', async () => {
    const { ws } = project({ 'long.txt': 'line\n'.repeat(100) })
    const r = await tools.runTool(call('read_file', { path: 'long.txt' }), { ...ctxFor(ws), maxResultChars: 400 })
    expect(r.content).toMatch(/^long\.txt \(lines 1–\d+ of 100; call read_file again with offset=/)
    expect(r.content.length).toBeLessThanOrEqual(400)
    expect(r.content).not.toMatch(/more characters cut/)
  })

  it('takes the argument names a model brings from elsewhere', async () => {
    const { ws } = project({ 'a.ts': THREE })
    const ctx = ctxFor(ws)
    expect((await tools.pendingEvent(call('edit_file', { file_path: 'a.ts', old_str: 'two', new_str: '2' }), ctx)).args).toEqual({
      path: 'a.ts',
      old_string: 'two',
      new_string: '2'
    })
    expect((await tools.pendingEvent(call('write_file', { file: 'b.ts', file_text: 'b' }), ctx)).args).toEqual({
      path: 'b.ts',
      content: 'b'
    })
    expect((await tools.pendingEvent(call('search_files', { regex: 'x' }), ctx)).args).toEqual({ pattern: 'x' })
    expect(
      (await tools.pendingEvent(call('edit_file', { path: 'a.ts', old_string: 'o', new_string: 'n', replace_all: 'true' }), ctx)).args
    ).toMatchObject({
      replace_all: true
    })
    // A card's one line, and an event's argument, stay short.
    const long = await tools.pendingEvent(call('read_file', { path: `${'d/'.repeat(1200)}x.ts` }), ctx)
    expect(long.summary).toHaveLength(201)
    expect(String(long.args.path).length).toBeLessThan(2100)
  })

  it('keeps a line about each file call for later turns', () => {
    const past = tools.replayCalls([
      {
        tool: 'read_file',
        args: { path: 'a.ts' },
        ok: true,
        summary: '3 lines',
        record: 'Read a.ts (3 lines). Read it again for the text.'
      },
      { tool: 'list_files', args: {}, ok: true, summary: '2 files', record: 'a.ts\nb.ts' },
      { tool: 'edit_file', args: { path: 'a.ts' }, ok: false, summary: 'old_string not found' },
      {
        tool: 'write_file',
        args: { path: 'b.ts', content: 'x'.repeat(2000) },
        ok: true,
        summary: 'new file, 1 line',
        record: 'Wrote b.ts (new file, 1 line).'
      }
    ])
    expect(past).toEqual([
      {
        name: 'read_file',
        args: { path: 'a.ts' },
        record: 'Read a.ts (3 lines). Read it again for the text.',
        note: 'Kept in brief from an earlier turn; read the file again if you need its text.'
      },
      { name: 'list_files', args: {}, record: 'a.ts\nb.ts', note: 'Kept in brief from an earlier turn.' },
      { name: 'write_file', args: { path: 'b.ts' }, record: 'Wrote b.ts (new file, 1 line).', note: 'Kept in brief from an earlier turn.' }
    ])
  })
})
