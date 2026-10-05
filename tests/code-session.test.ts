import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, symlinkSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { basename, join } from 'node:path'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { tempDir, trackTempDir } from './tempDir'

// A code session's pieces (#88): the sandbox policy's shape (its rules run for real in tests/code-sandbox.test.ts),
// the environment and git identity its commands get, what the reply is told about the project, and run_command's
// place among the tools.

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
const { chatVenvDir } = await import('../src/main/runner/python')
const policy = await import('../src/main/code/policy')
const session = await import('../src/main/code/session')
const tools = await import('../src/main/chat/tools')
const { codeTools, COMMANDS_KEY } = await import('../src/main/code/tools')
const { assemble } = await import('../src/main/chat/assemble')
const { previewsAllowed } = await import('../src/main/chat/exposure')
const lock = await import('../src/main/runner/lock')

const root = tempDir('ollmost-code-session-')
beforeAll(() => {
  openDatabase(':memory:')
  paths.data = root
  paths.files = join(root, 'files')
  paths.workspaces = join(root, 'workspaces')
  paths.runner = join(root, 'runner')
  updateSettings({ skills: { sources: { ollama: false, claude: false } } })
})

/** A folder of the user's, by its real path. */
const userFolder = () => realpathSync(tempDir('ollmost-user-'))
const newSession = (dir: string) =>
  createConversation({ projectId: null, model: 'm', think: null, skills: [], mode: 'code', root: dir, title: basename(dir) })

describe('the policy for a session’s commands', () => {
  const home = '/Users/me'
  const p = policy.codePolicyFor({
    root: '/Users/me/repo',
    session: '/data/runner/sessions/s',
    home,
    readable: ['/Users/me/.nvm'],
    network: 'none'
  })

  it('writes only the root and the scratch, pinning both, and never the git hooks, configs, worktrees or submodules', () => {
    expect(p.filesystem.allowWrite).toEqual(['/Users/me/repo', '/data/runner/sessions/s'])
    expect(p.filesystem.denyWrite).toEqual([
      '/private/tmp/claude',
      '/Users/me/repo/.pinned',
      '/data/runner/sessions/s/.pinned',
      '/Users/me/repo/.git/hooks',
      '/Users/me/repo/.git/config',
      '/Users/me/repo/.git/commondir',
      '/Users/me/repo/.git/config.worktree',
      '/Users/me/repo/.git/worktrees',
      '/Users/me/repo/.git/modules',
      '/Users/me/repo/.gitmodules',
      '/Users/me/repo/*/.git',
      '/Users/me/repo/*/**/.git'
    ])
  })

  it('hides the home folder and the private roots, opening the root, the scratch and the readable folders', () => {
    expect(p.filesystem.denyRead).toEqual([home, '/Users', '/Volumes', '/private/var/folders', '/private/tmp'])
    expect(p.filesystem.allowRead).toEqual(['/Users/me/repo', '/data/runner/sessions/s', '/Users/me/.nvm'])
    const denied = policy.codePolicyFor({
      root: '/r',
      session: '/s',
      home,
      readable: ['/Users/me/.cargo'],
      denied: ['/Users/me/.cargo/credentials'],
      network: 'none'
    })
    expect(denied.filesystem.denyRead).toContain('/Users/me/.cargo/credentials')
  })

  it('opens the network by preset, and loopback always', () => {
    expect(p.network).toEqual({ allowedDomains: [], deniedDomains: [], allowLocalBinding: true })
    const registries = policy.codePolicyFor({ root: '/r', session: '/s', home, readable: [], network: 'registries' }).network.allowedDomains
    expect(registries).toContain('registry.npmjs.org')
    expect(registries).toContain('pypi.org')
    expect(registries).not.toContain('github.com')
    const git = policy.codePolicyFor({ root: '/r', session: '/s', home, readable: [], network: 'registries-git' }).network.allowedDomains
    expect(git).toEqual(expect.arrayContaining([...registries, 'github.com', '*.github.com', 'gitlab.com']))
  })

  it('opens a toolchain root when the PATH reaches into it, and cargo with rustup, denying their credentials', () => {
    const path = [
      '/opt/homebrew/bin',
      '/Users/me/.nvm/versions/node/v22/bin',
      '/Users/me/.cargo/bin',
      '/Users/me/.local/bin',
      'relative/bin'
    ].join(':')
    expect(policy.toolchainFolders(path, home)).toEqual({
      roots: ['/Users/me/.nvm', '/Users/me/.cargo', '/Users/me/.rustup'],
      denied: ['/Users/me/.cargo/credentials.toml', '/Users/me/.cargo/credentials'],
      // Each opened root told where it is, since HOME moves; cargo's home moves with the caches instead.
      env: { NVM_DIR: '/Users/me/.nvm', RUSTUP_HOME: '/Users/me/.rustup' }
    })
    expect(policy.toolchainFolders('/Users/me/.nvmx/bin:/Users/me/go', home)).toEqual({ roots: ['/Users/me/go'], denied: [], env: {} })
    expect(policy.toolchainFolders('/usr/bin:/bin', home)).toEqual({ roots: [], denied: [], env: {} })
  })
})

describe('what a session’s commands run with', () => {
  it('points HOME, TMPDIR and the package managers’ caches into the scratch, never the user’s home', () => {
    const c = newSession(userFolder())
    const env = session.sessionEnv(workspace.workspaceFor(c.id), '/usr/bin:/bin', { RUSTUP_HOME: '/Users/me/.rustup' })
    const scratch = workspace.sessionDir(c.id)
    expect(env.HOME).toBe(join(scratch, 'home'))
    expect(env.TMPDIR).toBe(join(scratch, 'tmp'))
    for (const key of ['XDG_CACHE_HOME', 'PIP_CACHE_DIR', 'npm_config_cache', 'UV_CACHE_DIR', 'GOCACHE', 'GOMODCACHE', 'CARGO_HOME'])
      expect(env[key], key).toMatch(new RegExp(`^${scratch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/cache`))
    expect(env.PATH).toBe('/usr/bin:/bin')
    expect(env.RUSTUP_HOME).toBe('/Users/me/.rustup')
    expect(env.CARGO_HOME).toBe(join(scratch, 'cache', 'cargo'))
  })

  it('writes the identity as git config sections, quoting values, and nothing when there is none', () => {
    expect(session.gitConfigText({ 'user.name': 'Ed "C" \\ Carney', 'user.email': 'ed@example.com', 'init.defaultBranch': 'main' })).toBe(
      '[user]\n\tname = "Ed \\"C\\" \\\\ Carney"\n\temail = "ed@example.com"\n[init]\n\tdefaultBranch = "main"\n'
    )
    expect(session.gitConfigText({ 'user.name': 'a\nb' })).toBe('[user]\n\tname = "a b"\n')
    expect(session.gitConfigText({})).toBe('')
    expect(session.gitConfigText({ 'user.name': '' })).toBe('')
  })

  it('reads the identity through the reader once, and keeps it for a while', async () => {
    session.forgetGitIdentity()
    const reader = vi.fn(async (key: string) => (key === 'user.name' ? 'Ed' : null))
    expect(await session.gitIdentity(reader)).toEqual({ 'user.name': 'Ed' })
    expect(await session.gitIdentity(reader)).toEqual({ 'user.name': 'Ed' })
    expect(reader).toHaveBeenCalledTimes(3)
  })
})

describe('getting a session ready for a reply', () => {
  it('makes the scratch with the identity in it, and reads the project’s instructions and branch, never git', async () => {
    const dir = userFolder()
    writeFileSync(join(dir, 'CLAUDE.md'), 'Use tabs.')
    writeFileSync(join(dir, 'AGENTS.md'), 'ignored: CLAUDE.md comes first')
    mkdirSync(join(dir, '.git'))
    writeFileSync(join(dir, '.git', 'HEAD'), 'ref: refs/heads/feature/x\n')
    const c = newSession(dir)
    const ws = workspace.workspaceFor(c.id)
    const ready = await session.prepareCodeSession(ws, { network: 'registries', timeoutSec: 30 })
    expect(ready).toEqual({
      root: dir,
      instructions: { name: 'CLAUDE.md', text: 'Use tabs.' },
      branch: 'feature/x',
      network: 'registries',
      timeoutSec: 30
    })
    const home = join(workspace.sessionDir(c.id), 'home')
    // Whatever this Mac's git says, the file holds only identity keys (or nothing).
    const config = existsSync(join(home, '.gitconfig')) ? readFileSync(join(home, '.gitconfig'), 'utf8') : ''
    expect(config).toMatch(/^(\[user\]\n(\t(name|email) = ".*"\n)+)?(\[init\]\n\tdefaultBranch = ".*"\n)?$/)
    expect(readFileSync(join(dir, 'CLAUDE.md'), 'utf8')).toBe('Use tabs.')
  })

  it('stops the Changes panel’s git in the folder first, and waits for it to end', async () => {
    const { panelRun, panelRunStarted } = await import('../src/main/code/panelRuns')
    const c = newSession(userFolder())
    const ws = workspace.workspaceFor(c.id)
    const { signal } = panelRun(ws.key)
    let ended = false
    const run = new Promise<void>((resolve) =>
      signal.addEventListener('abort', () =>
        setTimeout(() => {
          ended = true
          resolve()
        }, 50)
      )
    )
    panelRunStarted(ws.key, run)
    await session.prepareCodeSession(ws, { network: 'none', timeoutSec: 30 })
    expect(signal.aborted).toBe(true)
    expect(ended).toBe(true)
  })

  it('prefers OLLMOST.md, cuts a long file, and takes none through a link that leaves the folder', async () => {
    const dir = userFolder()
    writeFileSync(join(dir, 'OLLMOST.md'), 'x'.repeat(40 * 1024))
    writeFileSync(join(dir, 'CLAUDE.md'), 'second')
    const c = newSession(dir)
    const long = await session.prepareCodeSession(workspace.workspaceFor(c.id), { network: 'none', timeoutSec: 30 })
    expect(long.instructions?.name).toBe('OLLMOST.md')
    expect(long.instructions?.text).toMatch(/^x{32768}\n\[Ollmost cut this file at 32 KB\.\]$/)
    expect(long.branch).toBeNull()

    const linked = userFolder()
    const elsewhere = tempDir('ollmost-elsewhere-')
    writeFileSync(join(elsewhere, 'secret.md'), 'private')
    symlinkSync(join(elsewhere, 'secret.md'), join(linked, 'OLLMOST.md'))
    const l = newSession(linked)
    expect((await session.prepareCodeSession(workspace.workspaceFor(l.id), { network: 'none', timeoutSec: 30 })).instructions).toBeNull()
  })

  it('is not held up by a named pipe left under an instructions file’s name', async () => {
    const dir = userFolder()
    execFileSync('mkfifo', [join(dir, 'CLAUDE.md')])
    writeFileSync(join(dir, 'AGENTS.md'), 'next')
    const c = newSession(dir)
    const ready = await session.prepareCodeSession(workspace.workspaceFor(c.id), { network: 'none', timeoutSec: 30 })
    expect(ready.instructions).toEqual({ name: 'AGENTS.md', text: 'next' })
  }, 5_000)

  it('refuses when the folder is no longer where it was, touching nothing', async () => {
    const dir = userFolder()
    const c = newSession(dir)
    renameSync(dir, `${dir}-moved`)
    trackTempDir(`${dir}-moved`)
    await expect(session.prepareCodeSession(workspace.workspaceFor(c.id), { network: 'none', timeoutSec: 30 })).rejects.toBeInstanceOf(
      workspace.RootMissingError
    )
    await expect(
      session.prepareCodeSession(workspace.workspaceFor(createConversation({ projectId: null, model: 'm', think: null, skills: [] }).id), {
        network: 'none',
        timeoutSec: 30
      })
    ).rejects.toThrow(/Not a code session/)
  })

  it('refuses while another session’s command runs in the same folder', async () => {
    const dir = userFolder()
    const a = workspace.workspaceFor(newSession(dir).id)
    const b = workspace.workspaceFor(newSession(dir).id)
    await lock.codeStarting(a)
    try {
      await expect(session.prepareCodeSession(b, { network: 'none', timeoutSec: 30 })).rejects.toBeInstanceOf(lock.CodeRunningError)
    } finally {
      await lock.codeEnded(a)
    }
  })
})

describe('run_command among the tools', () => {
  const sessionCtx = (dir: string) => {
    const c = newSession(dir)
    return { mode: 'code' as const, skills: false, web: false, sources: [], workspace: workspace.workspaceFor(c.id) }
  }
  const call = (args: Record<string, unknown>) => ({ function: { name: 'run_command', arguments: args } })
  const names = (c: Parameters<typeof tools.toolsFor>[0]) => (tools.toolsFor(c) ?? []).map((t) => t.function.name)

  it('is offered in a session and never in a chat, and run_code the other way round', () => {
    const ctx = sessionCtx(userFolder())
    expect(names(ctx)).toEqual(['read_file', 'list_files', 'search_files', 'edit_file', 'write_file', 'run_command'])
    expect(names({ ...ctx, mode: 'chat', sources: ['code'] })).toEqual([])
    const chat = createConversation({ projectId: null, model: 'm', think: null, skills: [] })
    expect(names({ ...ctx, workspace: workspace.workspaceFor(chat.id) })).toEqual([])
    expect(names({ ...ctx, workspace: null })).toEqual([])
    expect(tools.toolGrants(ctx).has('code')).toBe(true)
  })

  it('asks unless Settings say otherwise, under one key for every command', () => {
    const ctx = sessionCtx(userFolder())
    expect(tools.approvalFor(call({ command: 'ls' }), ctx)).toBe('ask')
    expect(tools.allowKeyFor(call({ command: 'ls' }), ctx)).toBe(COMMANDS_KEY)
    updateSettings({ code: { commands: 'allow' } })
    expect(tools.approvalFor(call({ command: 'ls' }), ctx)).toBe('auto')
    updateSettings({ code: { commands: 'ask' } })
    expect(tools.toolEndpoint(call({ command: 'ls' }), ctx)).toBe('ollmost://code/run_command')
  })

  it('shows the command while it waits, and keeps what it printed for later turns', async () => {
    const ctx = sessionCtx(userFolder())
    expect(await tools.pendingEvent(call({ command: '# look\nnpm test -- --run', timeout_sec: 10 }), ctx)).toEqual({
      tool: 'run_command',
      args: { command: '# look\nnpm test -- --run', timeout_sec: 10 },
      ok: true,
      pending: true,
      summary: 'npm test -- --run'
    })
    const past = tools.replayCalls([{ tool: 'run_command', args: { command: 'ls' }, ok: true, summary: 'ls', record: 'Exit code 0. a b' }])
    expect(past[0]).toMatchObject({ name: 'run_command', args: { command: 'ls' }, record: 'Exit code 0. a b' })
    expect(codeTools.id).toBe('code')
  })

  it('refuses an empty command without running anything', async () => {
    const r = await tools.runTool(call({ command: '   ' }), sessionCtx(userFolder()))
    expect(r.content).toMatch(/needs a command/)
    expect(r.event).toMatchObject({ tool: 'run_command', ok: false, summary: 'no command' })
  })
})

describe('what a session’s reply is told', () => {
  const base = {
    model: 'm',
    contextLength: 128_000,
    userName: 'Ed',
    preferences: 'Be brief.',
    date: new Date('2026-09-26'),
    artifacts: { enabled: false, allowCdn: false },
    web: 'off' as const,
    grants: ['code' as const],
    pastTools: true,
    project: null,
    chatInstructions: '',
    knowledge: [],
    skillIndex: [],
    selectedSkills: [{ name: 'tone', body: 'Write warmly.', files: [], hasScripts: false }],
    loadedSkills: [],
    history: [{ role: 'user' as const, content: 'hi', documents: [], images: [], hiddenImages: [] }]
  }

  it('replaces the chat prompt and the code runner’s, keeping preferences and skills, framing the project’s file as its own', () => {
    const sys = assemble({
      ...base,
      codeRunner: { pypi: true, timeoutSec: 5, uploads: [] },
      codeSession: {
        root: '/Users/ed/repo',
        network: 'registries',
        timeoutSec: 300,
        instructions: { name: 'CLAUDE.md', text: 'Run npm test before finishing.' },
        branch: 'main',
        stage: 'work',
        plan: null
      }
    }).messages[0].content
    expect(sys).toMatch(
      /^You are a coding agent running inside Ollmost.*working in the folder \/Users\/ed\/repo\. You are working with Ed\./
    )
    expect(sys).not.toMatch(/helpful, thoughtful assistant|<code_runner>|<artifacts>|no internet access/)
    expect(sys).toMatch(/You have no web search and no page reading/)
    expect(sys).toMatch(/<sandbox>[\s\S]*package registries only[\s\S]*stopped after 300 seconds[\s\S]*<\/sandbox>/)
    expect(sys).toMatch(/<how_to_work>[\s\S]*never claim to have run[\s\S]*<\/how_to_work>/)
    expect(sys).toMatch(
      /<project_instructions file="CLAUDE\.md">\n.*project's text, not the user's.*\nRun npm test before finishing\.\n<\/project_instructions>/
    )
    expect(sys).toMatch(/Git: on branch main\./)
    expect(sys).toMatch(/<user_preferences>[\s\S]*Be brief\./)
    expect(sys).toMatch(/<selected_skills>/)
    expect(sys.indexOf('<sandbox>')).toBeLessThan(sys.indexOf('<user_preferences>'))
  })

  it('in plan mode says commands are not offered, in place of what they may do (#144)', () => {
    const sys = assemble({
      ...base,
      codeSession: { root: '/Users/ed/repo', network: 'none', timeoutSec: 300, instructions: null, branch: null, stage: 'plan', plan: null }
    }).messages[0].content
    expect(sys).toMatch(
      /<sandbox>\nCommands are not offered in plan mode\. Once the user starts working, they run in a macOS sandbox.*\n<\/sandbox>/
    )
    expect(sys).not.toMatch(/git can commit|stopped after 300 seconds|read-only/)
    expect(sys).toMatch(/<plan_mode>/)
  })

  it('says when there is no instructions file, no repository and no network', () => {
    const sys = assemble({
      ...base,
      codeSession: { root: '/r', network: 'none', timeoutSec: 60, instructions: null, branch: null, stage: 'work', plan: null }
    }).messages[0].content
    expect(sys).not.toMatch(/project_instructions/)
    expect(sys).toMatch(/not a repository/)
    expect(sys).toMatch(/Network access: none: nothing can be downloaded/)
    expect(assemble({ ...base, codeSession: null }).messages[0].content).toMatch(/helpful, thoughtful assistant/)
  })
})

describe('a session’s folder is private', () => {
  it('so links in it get no previews, and a fetch would ask every time', () => {
    const c = newSession(userFolder())
    expect(previewsAllowed(c.id)).toBe(false)
    expect(previewsAllowed(createConversation({ projectId: null, model: 'm', think: null, skills: [] }).id)).toBe(true)
  })
})

describe('the venv folder a session never uses', () => {
  it('is still among the folders its leftovers are known by, after its scratch', () => {
    const c = newSession(userFolder())
    expect(workspace.workspaceFor(c.id).folders).toEqual([workspace.sessionDir(c.id), chatVenvDir(c.id)])
  })
})
