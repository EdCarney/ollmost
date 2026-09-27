import { delimiter, isAbsolute, join, resolve, sep } from 'node:path'
import type { SandboxRuntimeConfig } from '@anthropic-ai/sandbox-runtime'
import type { CodeNetwork } from '@shared/types'
import { pin, PRIVATE_ROOTS, RUNTIME_TMPDIR } from '../runner/sandbox'

// The sandbox policy for a code session's commands (#88): the same two-level shape as a chat's (policyFor in
// runner/sandbox.ts), so the library semantics are the proven ones. What differs: the root is a folder of the user's,
// the writable scratch of Ollmost's own is beside it rather than inside, the home folder opens a little wider (the
// toolchains a project needs, read-only, less their credentials), and the network is the session's preset.

/** What each network preset lets commands reach. Only the last can send data out to somewhere user content lives. */
const REGISTRIES = [
  'registry.npmjs.org',
  'registry.yarnpkg.com',
  'pypi.org',
  'files.pythonhosted.org',
  'crates.io',
  'static.crates.io',
  'index.crates.io',
  'proxy.golang.org',
  'sum.golang.org',
  'rubygems.org',
  'repo1.maven.org',
  'plugins.gradle.org'
]
export const CODE_NETWORK_HOSTS: Record<CodeNetwork, readonly string[]> = {
  none: [],
  registries: REGISTRIES,
  'registries-git': [...REGISTRIES, 'github.com', '*.github.com', 'gitlab.com', 'bitbucket.org']
}

/**
 * Folders in the home folder where toolchains keep their runtimes and packages. A PATH entry inside one of them opens
 * the whole root, read-only: a project's `node` from nvm, `cargo` from rustup, `python` from pyenv needs its runtime,
 * not just its bin folder. Any other PATH entry inside the home folder opens itself only, as for a chat.
 */
export const TOOLCHAIN_ROOTS = [
  '.nvm',
  '.cargo',
  '.rustup',
  '.pyenv',
  '.rbenv',
  '.asdf',
  '.volta',
  '.fnm',
  '.bun',
  '.deno',
  '.sdkman',
  join('.local', 'share', 'mise'),
  join('Library', 'pnpm'),
  'go'
]
/**
 * Where each toolchain is told its root is, once opened. The sandbox moves HOME into the scratch (see sessionEnv), and
 * most of these default to a folder under HOME: rustup's proxies would then find no toolchain at all. Not every root
 * gets one: cargo's home moves with the caches, since cargo writes it; a GOPATH under the scratch home is writable
 * where ~/go is not; and pnpm and bun find themselves by PATH and keep their stores under HOME, which pointing them at
 * their read-only roots would break.
 */
export const TOOLCHAIN_HOME_VARS: Record<string, string> = {
  '.nvm': 'NVM_DIR',
  '.rustup': 'RUSTUP_HOME',
  '.pyenv': 'PYENV_ROOT',
  '.rbenv': 'RBENV_ROOT',
  '.asdf': 'ASDF_DATA_DIR',
  '.volta': 'VOLTA_HOME',
  '.fnm': 'FNM_DIR',
  '.sdkman': 'SDKMAN_DIR',
  [join('.local', 'share', 'mise')]: 'MISE_DATA_DIR'
}
/** Roots that go together: cargo's proxies in ~/.cargo/bin look their toolchains up in ~/.rustup. */
const TOGETHER: Record<string, string[]> = { '.cargo': ['.rustup'], '.rustup': ['.cargo'] }
/** Credential files inside a toolchain root, denied again when the root is opened. */
export const CREDENTIALS_IN: Record<string, string[]> = { '.cargo': ['credentials.toml', 'credentials'] }

/**
 * The toolchain roots the PATH reaches into (see TOOLCHAIN_ROOTS), and the credential files inside them to deny. A
 * relative PATH entry is ignored, as it would be for the sandbox.
 */
export function toolchainFolders(path: string, home: string): { roots: string[]; denied: string[]; env: Record<string, string> } {
  const entries = path
    .split(delimiter)
    .filter(isAbsolute)
    .map((d) => resolve(d))
  const found = new Set<string>()
  for (const rel of TOOLCHAIN_ROOTS) {
    const root = resolve(home, rel)
    if (!entries.some((d) => d === root || d.startsWith(root + sep))) continue
    found.add(rel)
    for (const other of TOGETHER[rel] ?? []) found.add(other)
  }
  const roots = [...found]
  return {
    roots: roots.map((rel) => resolve(home, rel)),
    denied: roots.flatMap((rel) => (CREDENTIALS_IN[rel] ?? []).map((f) => resolve(home, rel, f))),
    env: Object.fromEntries(roots.filter((rel) => TOOLCHAIN_HOME_VARS[rel]).map((rel) => [TOOLCHAIN_HOME_VARS[rel], resolve(home, rel)]))
  }
}

/** Paths are real ones (no links in them): Seatbelt matches the real path, and a pin (which never exists) can't be resolved. */
export interface CodePolicyInput {
  /** The session's folder: the only folder of the user's that commands may write. */
  root: string
  /** The session's scratch (runner/sessions/<id>): the sandbox's HOME and TMPDIR, and the tools' caches. */
  session: string
  home: string
  /** Folders commands may read inside the hidden ones: skills, tool folders on PATH, the toolchain roots. */
  readable: string[]
  /** Files inside `readable` that must stay hidden (a toolchain's credentials). */
  denied?: string[]
  network: CodeNetwork
}

/**
 * What a session's commands may touch. Reads: the system, but in the home folder and PRIVATE_ROOTS only the root, the
 * scratch and `readable` (less `denied`). Writes: the root and the scratch, never the runtime's shared temp folder,
 * never so as to replace either (the pins), and never the git hooks, git config or submodule list in the root: the
 * library denies those anywhere under the working directory Ollmost runs with (/, see src/main/index.ts), and these
 * say so for the root itself in case that ever changes. Nor the submodules' own git folders (.git/modules), whose
 * config and hooks the library doesn't cover: submodules don't work in a session anyway. Network: the preset's hosts, and loopback (tests that bind
 * a port; local services, Ollama among them, are reachable).
 */
export function codePolicyFor(p: CodePolicyInput): SandboxRuntimeConfig {
  return {
    network: { allowedDomains: [...CODE_NETWORK_HOSTS[p.network]], deniedDomains: [], allowLocalBinding: true },
    filesystem: {
      denyRead: [...new Set([p.home, ...PRIVATE_ROOTS, ...(p.denied ?? [])])],
      allowRead: [p.root, p.session, ...p.readable],
      allowWrite: [p.root, p.session],
      denyWrite: [
        RUNTIME_TMPDIR,
        pin(p.root),
        pin(p.session),
        join(p.root, '.git', 'hooks'),
        join(p.root, '.git', 'config'),
        // Where git would look for a config instead of .git/config: a commondir file names another git folder
        // whose config the user's own git would read, config.worktree is a config of its own, and a linked
        // worktree's folder holds both.
        join(p.root, '.git', 'commondir'),
        join(p.root, '.git', 'config.worktree'),
        join(p.root, '.git', 'worktrees'),
        join(p.root, '.git', 'modules'),
        join(p.root, '.gitmodules'),
        // No .git below the folder (a glob: any depth, never the folder's own): a subfolder with one is a submodule
        // to the user's git, which enters it and runs what its config names; that config would be the session's
        // to write. Costs git init or clone into a subfolder of the session's. A folder made in the scratch can
        // still be renamed in with one inside (the runtime sees only the folder's creation; #111), so this raises
        // the bar rather than closing the door; the README says so.
        join(p.root, '*', '.git'),
        join(p.root, '*', '**', '.git')
      ]
    }
  }
}
