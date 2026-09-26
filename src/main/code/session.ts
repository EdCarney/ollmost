import { execFile } from 'node:child_process'
import { rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import type { CodeNetwork } from '@shared/types'
import { childEnv } from '../env'
import { openSessionFile, readyForSession, sessionDir, type Workspace } from '../runner/workspace'
import { readBranch } from './git'

// Getting a code session ready for a reply (#88): its folder still where it was, its scratch in order, the user's git
// identity copied in, and what the prompt says about the project (its instructions file, its branch). All of Ollmost's
// reads of the folder here go through the confined reader, under the session's lock.

const run = promisify(execFile)

/** The project's own instructions, the first found: Ollmost's own name first, then the names other agents read. */
export const INSTRUCTION_FILES = ['OLLMOST.md', 'CLAUDE.md', 'AGENTS.md']
const INSTRUCTIONS_BYTES = 32 * 1024
/** What of the user's global git config a session gets: enough to commit as them, nothing that reaches anywhere. */
const IDENTITY_KEYS = ['user.name', 'user.email', 'init.defaultBranch']
const IDENTITY_TTL_MS = 60_000

export interface CodeSession {
  root: string
  /** The project's instructions file, cut at 32 KB; null when there's none. */
  instructions: { name: string; text: string } | null
  /** The branch checked out in the root, or null when it isn't a repository (or its HEAD couldn't be read plainly). */
  branch: string | null
  network: CodeNetwork
  timeoutSec: number
}

/**
 * The environment a session's commands run with: HOME and TMPDIR in the scratch (tools that keep config or caches
 * under ~ land there with no knobs), the caches of the common package managers under scratch/cache (their homes in
 * ~ are hidden or read-only), each opened toolchain told where its root is (`toolchains`, from toolchainFolders:
 * with HOME moved they'd look in the scratch), and Ollmost's PATH. CARGO_HOME moves with the caches, since cargo
 * writes its registry cache there.
 */
export function sessionEnv(ws: Workspace, path: string, toolchains: Record<string, string> = {}): Record<string, string> {
  const own = sessionDir(ws.id)
  const cache = join(own, 'cache')
  return {
    ...toolchains,
    HOME: join(own, 'home'),
    TMPDIR: join(own, 'tmp'),
    XDG_CACHE_HOME: cache,
    PIP_CACHE_DIR: join(cache, 'pip'),
    // pip checks certificates through macOS's trust service, which the sandbox blocks (see runner/provider.ts).
    PIP_USE_DEPRECATED: 'legacy-certs',
    npm_config_cache: join(cache, 'npm'),
    YARN_CACHE_FOLDER: join(cache, 'yarn'),
    UV_CACHE_DIR: join(cache, 'uv'),
    GOCACHE: join(cache, 'go-build'),
    GOMODCACHE: join(cache, 'go-mod'),
    CARGO_HOME: join(cache, 'cargo'),
    PYTHONUNBUFFERED: '1',
    PATH: path
  }
}

let identity: { at: number; value: Promise<Record<string, string>> } | null = null

/** Forget the cached identity (tests). */
export const forgetGitIdentity = (): void => {
  identity = null
}

/**
 * The user's git identity from their global config, read with git itself: `git config --global` reads only the
 * global files, and with / as the working directory no repository's config (which could name a fsmonitor or hooks
 * path to run) is in play. Without the Command Line Tools /usr/bin/git only opens an install dialog, so nothing is
 * read then. Never the whole file: credential helpers and includes stay out. Cached briefly. Exported for tests,
 * which pass their own reader.
 */
export function gitIdentity(reader: (key: string) => Promise<string | null> = readGlobalConfig): Promise<Record<string, string>> {
  if (identity && Date.now() - identity.at < IDENTITY_TTL_MS) return identity.value
  const value = (async () => {
    const found: Record<string, string> = {}
    for (const key of IDENTITY_KEYS) {
      const v = await reader(key)
      if (v) found[key] = v
    }
    return found
  })()
  identity = { at: Date.now(), value }
  return value
}

async function readGlobalConfig(key: string): Promise<string | null> {
  try {
    await run('/usr/bin/xcode-select', ['-p'])
    const env = await childEnv()
    const { stdout } = await run('/usr/bin/git', ['config', '--global', '--get', key], { cwd: '/', env, timeout: 5_000 })
    return stdout.trim() || null
  } catch {
    return null
  }
}

/** A git config value quoted, so a name with quotes or backslashes reads back as itself; line breaks can't be. */
const configValue = (v: string) =>
  `"${v
    .replace(/[\r\n]+/g, ' ')
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')}"`

/** The .gitconfig a session's commands see: only the identity, as sections. Exported for tests. */
export function gitConfigText(values: Record<string, string>): string {
  const sections = new Map<string, string[]>()
  for (const [key, value] of Object.entries(values)) {
    const [section, name] = key.split('.')
    if (!section || !name || !value) continue
    sections.set(section, [...(sections.get(section) ?? []), `\t${name} = ${configValue(value)}`])
  }
  return [...sections].map(([section, lines]) => `[${section}]\n${lines.join('\n')}\n`).join('')
}

/**
 * Write the session's .gitconfig in its scratch home. Under the session's lock, where none of its code runs (the
 * sandbox never lets code write a .gitconfig anyway); whatever is there is replaced, never written through.
 */
async function writeGitConfig(ws: Workspace, values: Record<string, string>): Promise<void> {
  const file = join(sessionDir(ws.id), 'home', '.gitconfig')
  await rm(file, { force: true })
  const text = gitConfigText(values)
  if (text) await writeFile(file, text, { flag: 'wx', mode: 0o600 })
}

/** The project's instructions file, the first of INSTRUCTION_FILES found in the root, cut at 32 KB. Under the lock. */
async function readInstructions(ws: Workspace): Promise<CodeSession['instructions']> {
  for (const name of INSTRUCTION_FILES) {
    const file = await openSessionFile(ws, name)
    if (!file) continue
    try {
      const buffer = Buffer.alloc(INSTRUCTIONS_BYTES + 1)
      const { bytesRead } = await file.handle.read(buffer, 0, buffer.length, 0)
      const cut = bytesRead > INSTRUCTIONS_BYTES
      const text = buffer.toString('utf8', 0, Math.min(bytesRead, INSTRUCTIONS_BYTES))
      return { name, text: cut ? `${text}\n[Ollmost cut this file at 32 KB.]` : text }
    } finally {
      await file.handle.close()
    }
  }
  return null
}

/**
 * A session ready for a reply. Throws RootMissingError when its folder isn't where it was (the reply then says its
 * tools are unavailable), or CodeRunningError while another session's command runs in the same folder.
 */
export async function prepareCodeSession(ws: Workspace, opts: { network: CodeNetwork; timeoutSec: number }): Promise<CodeSession> {
  // Outside the lock: git may take a moment the first time.
  const values = await gitIdentity()
  return readyForSession(ws, async (root) => {
    await writeGitConfig(ws, values)
    return {
      root,
      instructions: await readInstructions(ws),
      branch: await readBranch(root),
      network: opts.network,
      timeoutSec: opts.timeoutSec
    }
  })
}
