import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { spawn } from 'node:child_process'
import { dirname, join } from 'node:path'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { tempDir } from './tempDir'

// A code session's commands under the real sandbox (#88): what codePolicyFor lets them read and write in a folder of
// the user's, what the mandatory denies cover there, the network presets, and that the reaper knows a session's
// leftovers by its scratch. macOS only, like tests/runner.test.ts.

vi.mock('electron', () => ({
  safeStorage: { isEncryptionAvailable: () => false },
  shell: {},
  app: { getPath: () => '' }
}))

const { openDatabase } = await import('../src/main/db/index')
const { updateSettings } = await import('../src/main/settings')
const { paths } = await import('../src/main/paths')
const { RUNTIME_TMPDIR, runSandboxed } = await import('../src/main/runner/sandbox')
const { codePolicyFor } = await import('../src/main/code/policy')
const { reap } = await import('../src/main/runner/reaper')
const python = await import('../src/main/runner/python')
type Workspace = import('../src/main/runner/workspace').Workspace

// Made in beforeAll, not while the file loads: off a Mac every test here is skipped, and vitest then runs no afterAll,
// so tests/setup.ts couldn't remove a folder made earlier.
beforeAll(() => {
  const data = tempDir('ollmost-code-sandbox-')
  openDatabase(':memory:')
  paths.data = data
  paths.workspaces = join(data, 'workspaces')
  paths.runner = join(data, 'runner')
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

describe.runIf(process.platform === 'darwin' && existsSync('/usr/bin/sandbox-exec'))('a session’s commands in the sandbox', () => {
  // Real paths, which the pins match. Everything here is in the per-user temp folder, which the policy hides, so only
  // what it opens again is readable: like the user's home folder, where a real session's folder is.
  let base: string, root: string, scratch: string, venv: string, home: string, ws: Workspace
  beforeAll(() => {
    base = realpathSync(tempDir('ollmost-session-'))
    root = join(base, 'repo')
    scratch = join(base, 'runner', 'sessions', 's1')
    venv = join(base, 'runner', 'venvs', 's1')
    home = join(base, 'home')
    mkdirSync(join(root, '.git', 'hooks'), { recursive: true })
    // A submodule's git folder, as git would leave it: the sandbox denies writing there, not only creating it.
    mkdirSync(join(root, '.git', 'modules', 'sub'), { recursive: true })
    // A linked worktree's folder likewise: its commondir and config.worktree point git at another config.
    mkdirSync(join(root, '.git', 'worktrees', 'x'), { recursive: true })
    writeFileSync(join(root, '.git', 'HEAD'), 'ref: refs/heads/main\n')
    writeFileSync(join(root, 'README.md'), 'theirs')
    for (const dir of ['home', 'tmp']) mkdirSync(join(scratch, dir), { recursive: true })
    mkdirSync(join(home, '.nvm', 'versions', 'node', 'v22', 'bin'), { recursive: true })
    writeFileSync(join(home, '.nvm', 'versions', 'node', 'v22', 'bin', 'node'), 'a runtime')
    mkdirSync(join(home, '.cargo', 'bin'), { recursive: true })
    writeFileSync(join(home, '.cargo', 'bin', 'cargo'), 'a tool')
    writeFileSync(join(home, '.cargo', 'credentials.toml'), 'token = "secret"')
    mkdirSync(join(home, '.ssh'), { recursive: true })
    writeFileSync(join(home, '.ssh', 'id_ed25519'), 'key')
    writeFileSync(join(home, 'private.txt'), 'private')
    writeFileSync(join(base, 'runner', 'ollmost.db'), 'the database')
    ws = { id: 's1', root, owned: false, key: root, folders: [scratch, venv] }
  })

  const policy = (network: 'none' | 'registries' | 'registries-git' = 'none') =>
    codePolicyFor({
      root,
      session: scratch,
      home: homedir(),
      readable: [join(home, '.nvm'), join(home, '.cargo')],
      denied: [join(home, '.cargo', 'credentials.toml'), join(home, '.cargo', 'credentials')],
      network
    })
  const command = (cmd: string, extra: { network?: 'none' | 'registries' | 'registries-git'; timeoutMs?: number } = {}) =>
    runSandboxed({
      command: cmd,
      policy: policy(extra.network),
      workspace: ws,
      env: { HOME: join(scratch, 'home'), TMPDIR: join(scratch, 'tmp') },
      timeoutMs: extra.timeoutMs ?? 30_000,
      id: cmd
    })

  beforeAll(() => process.chdir('/'))

  it('reads the folder, the scratch and the toolchains it was given, and nothing else in hidden places', async () => {
    expect((await command('cat README.md')).output.trim()).toBe('theirs')
    expect((await command('echo kept > "$HOME/x" && cat "$HOME/x"')).output.trim()).toBe('kept')
    expect((await command(`cat ${join(home, '.nvm', 'versions', 'node', 'v22', 'bin', 'node')}`)).output.trim()).toBe('a runtime')
    expect((await command(`cat ${join(home, '.cargo', 'bin', 'cargo')}`)).output.trim()).toBe('a tool')
    for (const file of [
      join(home, 'private.txt'),
      join(home, '.ssh', 'id_ed25519'),
      // Denied inside an opened root inside a hidden one: the nesting the library must honour.
      join(home, '.cargo', 'credentials.toml'),
      // Beside the scratch in Ollmost's own folder.
      join(base, 'runner', 'ollmost.db')
    ]) {
      const r = await command(`cat ${file}`)
      expect(r.code, file).not.toBe(0)
      expect(r.output, file).toMatch(/Operation not permitted/)
    }
  }, 120_000)

  it('writes the folder and the scratch, and cannot replace, move or escape them', async () => {
    expect((await command('echo made > made.txt && cat made.txt')).output.trim()).toBe('made')
    expect((await command('echo t > "$TMPDIR/t" && cat "$TMPDIR/t"')).output.trim()).toBe('t')
    const beside = await command(`touch ${join(dirname(root), 'escape.txt')}`)
    expect(beside.output).toMatch(/Operation not permitted/)
    expect(existsSync(join(dirname(root), 'escape.txt'))).toBe(false)
    const moved = await command(`mv ${root} ${root}-moved`)
    expect(moved.output).toMatch(/Operation not permitted/)
    expect(existsSync(root)).toBe(true)
    const pinned = await command('touch .pinned')
    expect(pinned.output).toMatch(/Operation not permitted/)
    // rm -rf may empty a folder it can write, but never remove the pinned folder itself.
    const spare = join(base, 'spare')
    mkdirSync(spare)
    writeFileSync(join(spare, 'f'), 'x')
    const wsSpare: Workspace = { ...ws, root: spare, key: spare }
    const removed = await runSandboxed({
      command: `rm -rf ${spare}`,
      policy: {
        ...policy(),
        filesystem: {
          ...policy().filesystem,
          allowRead: [spare, ...policy().filesystem.allowRead!],
          allowWrite: [spare, scratch],
          denyWrite: [RUNTIME_TMPDIR, join(spare, '.pinned'), join(scratch, '.pinned')]
        }
      },
      workspace: wsSpare,
      env: {},
      timeoutMs: 30_000,
      id: 'rm'
    })
    expect(removed.code).not.toBe(0)
    expect(existsSync(spare)).toBe(true)
    expect(existsSync(join(spare, 'f'))).toBe(false)
  }, 120_000)

  it('leaves the git hooks, configs, worktrees, submodules, any .git below the folder and .gitconfig read-only, while git’s own state can change', async () => {
    for (const file of [
      '.git/hooks/pre-commit',
      '.git/config',
      '.git/commondir',
      '.git/config.worktree',
      '.git/worktrees/x/commondir',
      '.git/modules/sub/config',
      '.gitmodules',
      'sub/.git',
      '.vscode/settings.json',
      `${join(scratch, 'home')}/.gitconfig`
    ]) {
      const r = await command(`mkdir -p $(dirname ${file}) 2>/dev/null; echo x > ${file}`)
      expect(r.code, file).not.toBe(0)
      expect(r.output, file).toMatch(/Operation not permitted/)
      expect(existsSync(join(root, file)), file).toBe(false)
    }
    // A .git folder at any depth below the folder is refused too (a populated submodule needs one), in any spelling:
    // the disk doesn't tell .GIT from .git, and neither must the deny.
    expect((await command('mkdir -p deep/er/.git')).code).not.toBe(0)
    expect(existsSync(join(root, 'deep', 'er', '.git'))).toBe(false)
    expect((await command('mkdir -p sub/.GIT')).code).not.toBe(0)
    expect(existsSync(join(root, 'sub', '.GIT'))).toBe(false)
    expect((await command('echo "ref: refs/heads/other" > .git/HEAD && cat .git/HEAD')).output.trim()).toBe('ref: refs/heads/other')
    writeFileSync(join(root, '.git', 'HEAD'), 'ref: refs/heads/main\n')
  }, 120_000)

  it('gets no convenience write to ~/.npm/_logs in the real home folder, which is hidden', async () => {
    const marker = join(homedir(), '.npm', '_logs', `ollmost-test-${process.pid}`)
    try {
      const r = await command(`mkdir -p ${dirname(marker)} && touch ${marker}`)
      expect(r.code).not.toBe(0)
      expect(existsSync(marker)).toBe(false)
    } finally {
      rmSync(marker, { force: true })
    }
  })

  it('has the network its preset says, and says so', async () => {
    const none = await command('curl -sS -m 5 https://pypi.org/simple/ -o /dev/null')
    expect(none.code).not.toBe(0)
    expect(none.output).toMatch(/deny network-outbound pypi\.org/)
    const github = await command('curl -sS -m 5 https://github.com -o /dev/null', { network: 'registries' })
    expect(github.code).not.toBe(0)
    expect(github.output).toMatch(/deny network-outbound github\.com/)
  })

  it('can bind a port and talk to it, so tests that serve locally work', async () => {
    const py = await python.findPython()
    if (!py) throw new Error('This test needs Python 3 on the PATH')
    const script = [
      'import socket',
      's = socket.socket(); s.bind(("127.0.0.1", 0)); s.listen(1)',
      'c = socket.socket(); c.connect(s.getsockname()); a, _ = s.accept()',
      'c.sendall(b"ping"); print(a.recv(4).decode())'
    ].join('\n')
    writeFileSync(join(root, 'serve.py'), script)
    const r = await command(`${py.path} serve.py`)
    expect(r.output.trim()).toBe('ping')
    expect(r.code).toBe(0)
  }, 60_000)

  it('is known to the reaper by its scratch, which its policy alone pins', async () => {
    const { SandboxManager } = await import('@anthropic-ai/sandbox-runtime')
    const { argv, env } = await SandboxManager.wrapWithSandboxArgv('exec sleep 30', '/bin/bash', policy(), undefined, root, {
      commandId: 'left'
    })
    const left = spawn(argv[0], argv.slice(1), { cwd: root, env: { ...process.env, ...env }, stdio: 'ignore', detached: true })
    await new Promise((resolve) => setTimeout(resolve, 1000))
    try {
      expect(await reap([scratch])).toEqual({ stopped: 1, checked: [scratch] })
      await new Promise((resolve) => setTimeout(resolve, 200))
      expect(alive(left.pid!)).toBe(false)
    } finally {
      left.kill('SIGKILL')
    }
    // A run's end does the same: nothing it left outlives it.
    const r = await command('sleep 30 & echo $! > bg.pid; echo started')
    expect(r.output.trim()).toBe('started')
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(alive(Number(readFileSync(join(root, 'bg.pid'), 'utf8')))).toBe(false)
  }, 60_000)
})
