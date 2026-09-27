import { execFileSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

// What changed in a session's folder (#102): git status and diff run inside the session's sandbox, parsed. The
// sandbox part is macOS only, like tests/code-sandbox.test.ts, and needs the Command Line Tools for git.

vi.mock('electron', () => ({
  safeStorage: { isEncryptionAvailable: () => false },
  shell: {},
  app: { getPath: () => '' }
}))

const { openDatabase } = await import('../src/main/db/index')
const { createConversation } = await import('../src/main/db/conversations')
const { updateSettings } = await import('../src/main/settings')
const { paths } = await import('../src/main/paths')
const { workspaceFor } = await import('../src/main/runner/workspace')
const { changes, diff, parseStatus, withoutNote, stopPanelRuns, FILES_LIMIT } = await import('../src/main/code/changes')
const { readyForSession } = await import('../src/main/runner/workspace')

const data = mkdtempSync(join(tmpdir(), 'ollmost-changes-'))
beforeAll(() => {
  openDatabase(':memory:')
  paths.data = data
  paths.files = join(data, 'files')
  paths.skills = join(data, 'skills')
  paths.workspaces = join(data, 'workspaces')
  paths.runner = join(data, 'runner')
  updateSettings({ skills: { sources: { ollama: false, claude: false } } })
})
afterAll(() => rmSync(data, { recursive: true, force: true }))

describe('parseStatus', () => {
  it('reads each kind of change, a rename with where it was, and passes over what isn’t a record', () => {
    const out =
      ' M a.txt\0A  b.txt\0 D c.txt\0?? d.txt\0R  new.txt\0old.txt\0UU e.txt\0!! ignored\0MM f.txt\0AD g.txt\0 T h.txt\0AA i.txt\0 A j.txt\0' +
      '\n<sandbox_violations>\nsomething\n</sandbox_violations>'
    expect(parseStatus(out)).toEqual({
      files: [
        { path: 'a.txt', status: 'modified' },
        { path: 'b.txt', status: 'added' },
        { path: 'c.txt', status: 'deleted' },
        { path: 'd.txt', status: 'untracked' },
        { path: 'new.txt', status: 'renamed', from: 'old.txt' },
        { path: 'e.txt', status: 'conflict' },
        { path: 'f.txt', status: 'modified' },
        { path: 'g.txt', status: 'deleted' },
        { path: 'h.txt', status: 'modified' },
        { path: 'i.txt', status: 'conflict' },
        { path: 'j.txt', status: 'added' }
      ],
      cut: false
    })
    expect(parseStatus('')).toEqual({ files: [], cut: false })
  })

  it('stops at the limit', () => {
    const out = Array.from({ length: FILES_LIMIT + 1 }, (_, i) => `?? f${i}\0`).join('')
    const r = parseStatus(out)
    expect(r.cut).toBe(true)
    expect(r.files).toHaveLength(FILES_LIMIT)
  })

  it('drops the record left in pieces when the output was cut short', () => {
    expect(parseStatus(' M a.txt\0 M b.t', true)).toEqual({ files: [{ path: 'a.txt', status: 'modified' }], cut: false })
    expect(parseStatus(' M a.txt\0R  new.txt\0ol', true)).toEqual({ files: [{ path: 'a.txt', status: 'modified' }], cut: false })
  })
})

describe('withoutNote', () => {
  it('splits off the runtime’s note only at the very end, never text in the output that looks like it', () => {
    const diff = '+++ b/x\n+<sandbox_violations>\n+stuff\n+</sandbox_violations>\n'
    expect(withoutNote(diff)).toEqual({ text: diff, denied: null })
    const note = '\n<sandbox_violations>\ndeny file-read /Users/me/.ssh/id\n</sandbox_violations>'
    expect(withoutNote(diff + note)).toEqual({ text: diff, denied: 'deny file-read /Users/me/.ssh/id' })
    const status = '?? b<sandbox_violations>\n\0 M c.txt\0'
    expect(withoutNote(status + note).text).toBe(status)
    expect(parseStatus(withoutNote(status + note).text).files.map((f) => f.path)).toEqual(['b<sandbox_violations>\n', 'c.txt'])
    expect(withoutNote('')).toEqual({ text: '', denied: null })
  })
})

const hasTools = () => {
  try {
    execFileSync('/usr/bin/xcode-select', ['-p'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

describe.runIf(process.platform === 'darwin' && existsSync('/usr/bin/sandbox-exec') && hasTools())(
  'what changed in a session’s folder',
  () => {
    // A real path, which the pins match. The mandatory denies are anchored at the working directory: / as in the app.
    const base = realpathSync(mkdtempSync(join(tmpdir(), 'ollmost-user-changes-')))
    beforeAll(() => process.chdir('/'))
    afterAll(() => rmSync(base, { recursive: true, force: true }))

    /** Git run by the test itself, reading no config of the user's. */
    const gitIn = (dir: string, ...args: string[]) =>
      execFileSync('/usr/bin/git', args, {
        cwd: dir,
        encoding: 'utf8',
        env: { ...process.env, HOME: base, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' }
      })
    function repo(name: string): string {
      const dir = join(base, name)
      mkdirSync(dir, { recursive: true })
      gitIn(dir, 'init', '-q', '-b', 'main')
      gitIn(dir, 'config', 'user.email', 'tests@example.com')
      gitIn(dir, 'config', 'user.name', 'Ollmost tests')
      gitIn(dir, 'config', 'commit.gpgsign', 'false')
      return dir
    }
    const commitAll = (dir: string) => {
      gitIn(dir, 'add', '-A')
      gitIn(dir, 'commit', '-q', '-m', 'start')
    }
    const sessionIn = (dir: string) =>
      workspaceFor(createConversation({ projectId: null, model: 'm', think: null, skills: [], mode: 'code', root: dir, title: 'x' }).id)
    const byPath = <T extends { path: string }>(files: T[]) => [...files].sort((a, b) => (a.path < b.path ? -1 : 1))

    it('lists what changed as git sees it, and shows each file’s diff', async () => {
      const dir = repo('project')
      writeFileSync(join(dir, 'README.md'), 'theirs\n')
      writeFileSync(join(dir, 'gone.txt'), 'going\n')
      writeFileSync(join(dir, 'keep.txt'), 'kept\n')
      writeFileSync(join(dir, '.gitignore'), 'ignored.txt\n')
      commitAll(dir)
      writeFileSync(join(dir, 'README.md'), 'ours\n')
      unlinkSync(join(dir, 'gone.txt'))
      writeFileSync(join(dir, 'new.txt'), 'brand new\n')
      writeFileSync(join(dir, 'added.txt'), 'staged\n')
      gitIn(dir, 'add', 'added.txt')
      writeFileSync(join(dir, 'ignored.txt'), 'not listed\n')
      gitIn(dir, 'mv', 'keep.txt', 'kept.txt')
      const ws = sessionIn(dir)

      const r = await changes(ws)
      expect(r).toMatchObject({ repo: true, cut: false, error: null })
      expect(byPath(r.files)).toEqual([
        { path: 'README.md', status: 'modified' },
        { path: 'added.txt', status: 'added' },
        { path: 'gone.txt', status: 'deleted' },
        { path: 'kept.txt', status: 'renamed', from: 'keep.txt' },
        { path: 'new.txt', status: 'untracked' }
      ])

      const changed = await diff(ws, 'README.md')
      expect(changed.cut).toBe(false)
      expect(changed.diff).toMatch(/^diff --git a\/README\.md b\/README\.md\n/)
      expect(changed.diff).toContain('-theirs\n+ours\n')
      expect((await diff(ws, 'new.txt')).diff).toMatch(/\+\+\+ b\/new\.txt\n[\s\S]*\+brand new\n/)
      expect((await diff(ws, 'added.txt')).diff).toMatch(/\+\+\+ b\/added\.txt\n[\s\S]*\+staged\n/)
      expect((await diff(ws, 'gone.txt')).diff).toMatch(/\+\+\+ \/dev\/null\n[\s\S]*-going\n/)
      expect((await diff(ws, 'kept.txt')).diff).toContain('+kept\n')
      // Unchanged: nothing to show.
      expect(await diff(ws, '.gitignore')).toEqual({ diff: '', cut: false })
      // Nothing that isn't in the folder, and nothing through a link that leaves it.
      await expect(diff(ws, '../outside')).rejects.toThrow(/outside the folder/)
      await expect(diff(ws, '/etc/passwd')).rejects.toThrow(/outside the folder/)
      symlinkSync('/etc', join(dir, 'out'))
      await expect(diff(ws, 'out/hosts')).rejects.toThrow(/outside the folder/)
      await expect(diff(ws, '')).rejects.toThrow(/path of a file/)
      await expect(diff(ws, 42)).rejects.toThrow(/path of a file/)
      // Asked together, a refresh and a diff take turns rather than refusing each other.
      const [again, both] = await Promise.all([changes(ws), diff(ws, 'README.md')])
      expect(again.error).toBeNull()
      expect(again.files.map((f) => f.path)).toContain('README.md')
      expect(both.diff).toContain('+ours\n')
    }, 120_000)

    it('shows a file’s own change whatever its name, never another file’s under it', async () => {
      const dir = repo('names')
      writeFileSync(join(dir, 'x'), 'x1\n')
      commitAll(dir)
      writeFileSync(join(dir, 'x'), 'x2\n')
      const names = [':x', '*', '[x]', '-lead', "it's", 'two\nlines', 'sp ace']
      for (const name of names) writeFileSync(join(dir, name), `content of ${JSON.stringify(name)}\n`)
      const ws = sessionIn(dir)
      const r = await changes(ws)
      expect(r.error).toBeNull()
      expect(r.files.map((f) => f.path).sort()).toEqual([...names, 'x'].sort())
      expect(r.files.find((f) => f.path === 'x')?.status).toBe('modified')
      for (const name of names) {
        const d = await diff(ws, name)
        expect(d.diff).toContain(`+content of ${JSON.stringify(name)}`)
        expect(d.diff).not.toContain('x2')
      }
    }, 120_000)

    it('sees no repository in a plain folder, nor in a folder inside one, and says when git itself failed', async () => {
      const plain = join(base, 'plain')
      mkdirSync(plain)
      writeFileSync(join(plain, 'a.txt'), 'a\n')
      expect(await changes(sessionIn(plain))).toEqual({ repo: false, files: [], cut: false, error: null })
      const outer = repo('outer')
      const inner = join(outer, 'inner')
      mkdirSync(inner)
      writeFileSync(join(inner, 'b.txt'), 'b\n')
      commitAll(outer)
      writeFileSync(join(inner, 'b.txt'), 'changed\n')
      // Its .git is above the folder, out of the sandbox's sight (and git is told not to look above the folder).
      expect(await changes(sessionIn(inner))).toEqual({ repo: false, files: [], cut: false, error: null })
      // A repository git can't read isn't taken for none: a corrupt index fails status, in a repository git found.
      const broken = repo('broken')
      writeFileSync(join(broken, 'c.txt'), 'c\n')
      commitAll(broken)
      writeFileSync(join(broken, '.git', 'index'), 'not an index')
      expect(await changes(sessionIn(broken))).toEqual({
        repo: true,
        files: [],
        cut: false,
        error: expect.stringMatching(/couldn.t list/)
      })
      // A broken config stops git before it can say whether there's a repository: an error, not "no repository".
      const misconfigured = repo('misconfigured')
      writeFileSync(join(misconfigured, '.git', 'config'), '[core\n\tbad = [\n')
      expect(await changes(sessionIn(misconfigured))).toEqual({
        repo: false,
        files: [],
        cut: false,
        error: expect.stringMatching(/couldn.t list/)
      })
    }, 60_000)

    it('is stopped by a reply starting in the folder, which then finds it quiet', async () => {
      const dir = repo('busy')
      writeFileSync(join(dir, 'a.txt'), 'a\n')
      commitAll(dir)
      writeFileSync(join(dir, 'a.txt'), 'b\n')
      const ws = sessionIn(dir)
      const going = changes(ws)
      const queued = diff(ws, 'a.txt')
      // Its rejection is checked below; noted now, or Node would count it unhandled meanwhile.
      queued.catch(() => undefined)
      await new Promise((resolve) => setTimeout(resolve, 200))
      await stopPanelRuns(ws.key)
      // Ollmost's own work in the folder goes ahead at once: nothing of the panel's is running any more.
      expect(await readyForSession(ws, async () => 'ok')).toBe('ok')
      // What was going may have finished first; what was queued never started.
      const r = await going
      expect(r.error === null || /reply started/.test(r.error)).toBe(true)
      await expect(queued).rejects.toThrow(/reply started/)
      // Afterwards the panel works again; a call whose turn comes once a reply is running gives up instead.
      expect((await changes(ws)).files).toEqual([{ path: 'a.txt', status: 'modified' }])
      expect((await changes(ws, { replying: () => true })).error).toMatch(/reply started/)
      await expect(diff(ws, 'a.txt', { replying: () => true })).rejects.toThrow(/reply started/)
    }, 60_000)

    it('lists paths against the folder itself, whatever a planted core.worktree says', async () => {
      const dir = repo('relabel')
      mkdirSync(join(dir, 'sub'))
      writeFileSync(join(dir, 'sub', 'inner.txt'), 'in\n')
      commitAll(dir)
      // Pointed at the subfolder, git would list sub/inner.txt as inner.txt, and a click would show the wrong file.
      gitIn(dir, 'config', 'core.worktree', join(dir, 'sub'))
      writeFileSync(join(dir, 'sub', 'inner.txt'), 'changed\n')
      const r = await changes(sessionIn(dir))
      expect(r.error).toBeNull()
      expect(r.files).toContainEqual({ path: 'sub/inner.txt', status: 'modified' })
      expect(r.files.map((f) => f.path)).not.toContain('inner.txt')
    }, 60_000)

    it('runs a clean filter the folder names only inside the sandbox', async () => {
      // A filter git runs while it looks at a changed file: plain git here runs it with the user's access.
      const dir = repo('filtered')
      const inside = join(dir, 'inside-marker')
      const outside = join(base, 'outside-marker')
      const script = join(dir, 'clean.sh')
      writeFileSync(script, `#!/bin/sh\ntouch ${inside}\ntouch ${outside}\nexec cat\n`)
      chmodSync(script, 0o755)
      writeFileSync(join(dir, '.gitattributes'), 'f.txt filter=trap\n')
      writeFileSync(join(dir, 'f.txt'), 'one\n')
      gitIn(dir, 'config', 'filter.trap.clean', script)
      commitAll(dir)
      rmSync(inside, { force: true })
      rmSync(outside, { force: true })
      writeFileSync(join(dir, 'f.txt'), 'two\n')
      gitIn(dir, 'status', '--porcelain')
      expect(existsSync(inside)).toBe(true)
      expect(existsSync(outside)).toBe(true)
      rmSync(inside)
      rmSync(outside)

      const r = await changes(sessionIn(dir))
      expect(r.error).toBeNull()
      expect(r.files.find((f) => f.path === 'f.txt')?.status).toBe('modified')
      // The filter ran, in the folder it may write, and nowhere else.
      expect(existsSync(inside)).toBe(true)
      expect(existsSync(outside)).toBe(false)
    }, 60_000)

    it('doesn’t run the folder’s fsmonitor, which its flags switch off', async () => {
      // A .git file pointing at a repository whose config names a fsmonitor: git run plainly here runs it.
      const dir = join(base, 'trap')
      const inner = repo(join('trap', 'inner'))
      writeFileSync(join(dir, 'a.txt'), 'a\n')
      const marker = join(dir, 'marker')
      writeFileSync(join(dir, 'monitor.sh'), `#!/bin/sh\ntouch ${marker}\nprintf '/'\n`)
      chmodSync(join(dir, 'monitor.sh'), 0o755)
      gitIn(inner, 'config', 'core.fsmonitor', join(dir, 'monitor.sh'))
      writeFileSync(join(dir, '.git'), `gitdir: ${join(inner, '.git')}\n`)
      gitIn(dir, 'status', '--porcelain')
      expect(existsSync(marker)).toBe(true)
      unlinkSync(marker)

      const r = await changes(sessionIn(dir))
      expect(r.repo).toBe(true)
      expect(r.error).toBeNull()
      expect(existsSync(marker)).toBe(false)
    }, 60_000)

    it('stops listing at the limit, and says when the folder is gone', async () => {
      const dir = repo('many')
      for (let i = 0; i < FILES_LIMIT + 1; i++) writeFileSync(join(dir, `f${i}.txt`), 'x')
      const ws = sessionIn(dir)
      const r = await changes(ws)
      expect(r).toMatchObject({ repo: true, cut: true, error: null })
      expect(r.files).toHaveLength(FILES_LIMIT)
      renameSync(dir, `${dir}-moved`)
      expect(await changes(ws)).toEqual({ repo: false, files: [], cut: false, error: expect.stringMatching(/no longer at/) })
      await expect(diff(ws, 'f1.txt')).rejects.toThrow(/no longer at/)
    }, 60_000)
  }
)
