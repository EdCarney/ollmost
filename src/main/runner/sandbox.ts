import { join } from 'node:path'
import type { SandboxRuntimeConfig } from '@anthropic-ai/sandbox-runtime'
import { childEnv } from '../env'
import { type GroupProcess, spawnGroup } from '../processes'
import { errorMessage } from '../util'
import { codeEnded, codeStarting } from './lock'
import type { Workspace } from './workspace'

// Code the model writes runs under macOS's Seatbelt sandbox through @anthropic-ai/sandbox-runtime (the one Claude
// Code uses). The package is ESM-only and Ollmost's main process is CommonJS, so it's loaded with import() on first use.
// Nothing ever runs unsandboxed: if the sandbox can't start, the runner isn't offered.

type Manager = (typeof import('@anthropic-ai/sandbox-runtime'))['SandboxManager']

/** The package domains `pip install` needs when PyPI is allowed. */
export const PYPI_HOSTS = ['pypi.org', 'files.pythonhosted.org']

/** How much output a run keeps (the model sees less: tool results are capped). */
const OUTPUT_BYTES = 256 * 1024

/**
 * Where user data lives outside the home folder: other accounts' homes and /Users/Shared, other disks and mounted
 * images, and the per-user and shared temp folders (caches, drafts, downloads in progress). Hidden like the home
 * folder (#68). macOS spells /tmp and /var as /private/tmp and /private/var.
 */
export const PRIVATE_ROOTS = ['/Users', '/Volumes', '/private/var/folders', '/private/tmp']

/**
 * sandbox-runtime puts TMPDIR=/tmp/claude on every command it builds and always lets code write there: one folder for
 * every chat (and anything else using the runtime), inside /private/tmp, whose reads are denied, so temp files there
 * couldn't be read back. Code can't write it; each run gets its own TMPDIR instead (see runSandboxed).
 */
export const RUNTIME_TMPDIR = '/private/tmp/claude'

/** Ollmost's own files in a workspace: the sandbox's HOME and TMPDIR. */
export const OLLMOST_DIR = '.ollmost'

/**
 * A path code may never write, inside a folder it may. The runtime then also denies deleting, renaming or creating
 * every folder above it, so code can't swap the folder, or any folder above it, for a link (#71): writes Ollmost makes
 * there outside the sandbox would follow it. It needn't exist.
 */
export const pin = (folder: string): string => join(folder, '.pinned')

/**
 * Paths are real ones (no links in them): Seatbelt matches the real path, and the runtime can only resolve a path that
 * exists, which a pin never does.
 */
export interface PolicyInput {
  /** The chat's workspace: the only folder code can write to (and read inside the hidden folders). */
  workspace: string
  home: string
  /** Folders code may read inside the hidden folders: skills, tool folders on PATH, the chat's scripts. */
  readable: string[]
  /** Ollmost's Python environment, writable only when packages may be installed. */
  venv: string
  pypi: boolean
}

/**
 * What code may touch. Reads: the system (libraries, Homebrew, Python), but in the home folder and PRIVATE_ROOTS only
 * the workspace and `readable`. Writes: the workspace (and the Python environment when PyPI is allowed), never the
 * runtime's shared temp folder, and never so as to replace the workspace, its .ollmost folder or the environment.
 * Network: none, or PyPI's two hosts.
 */
export function policyFor(p: PolicyInput): SandboxRuntimeConfig {
  return {
    network: { allowedDomains: p.pypi ? PYPI_HOSTS : [], deniedDomains: [] },
    filesystem: {
      denyRead: [...new Set([p.home, ...PRIVATE_ROOTS])],
      allowRead: [p.workspace, ...p.readable, p.venv],
      allowWrite: p.pypi ? [p.workspace, p.venv] : [p.workspace],
      denyWrite: [RUNTIME_TMPDIR, pin(join(p.workspace, OLLMOST_DIR)), ...(p.pypi ? [pin(p.venv)] : [])]
    }
  }
}

let manager: Promise<Manager> | null = null

async function load(): Promise<Manager> {
  const { SandboxManager } = await import('@anthropic-ai/sandbox-runtime')
  if (!SandboxManager.isSupportedPlatform()) throw new Error("This Mac's sandbox isn't supported.")
  const deps = await SandboxManager.checkDependenciesAsync()
  if (deps.errors.length) throw new Error(deps.errors.join(' '))
  // Per-run settings (the workspace) are passed with each command; this starts the network proxy.
  await SandboxManager.initialize({
    network: { allowedDomains: [], deniedDomains: [] },
    filesystem: { denyRead: [], allowRead: [], allowWrite: [], denyWrite: [] }
  })
  return SandboxManager
}

/** The sandbox, started once. Rejects (every time) when it can't run on this Mac. */
function sandbox(): Promise<Manager> {
  manager ??= load().catch((err) => {
    manager = null
    throw err
  })
  return manager
}

/** Whether code can be sandboxed here, and if not, why. */
export async function sandboxStatus(): Promise<{ ok: boolean; reason: string | null }> {
  try {
    await sandbox()
    return { ok: true, reason: null }
  } catch (err) {
    return { ok: false, reason: `The sandbox couldn't start: ${errorMessage(err)}` }
  }
}

/** A word bash reads back as `s` exactly. */
export const shellQuote = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`

export interface RunResult {
  code: number | null
  /** stdout and stderr as they arrived, with any sandbox denials explained at the end. */
  output: string
  timedOut: boolean
  /** Output past the limit was dropped. */
  truncated: boolean
}

// The manager has one config, and its network part applies to every sandbox at once (the wrap reads allowLocalBinding
// from it too). Concurrent runs with different network rules would overwrite each other's (#79), so they take turns:
// runs with the same rules share them, and a run with other rules waits until none of those is running. Ollmost's
// policies set nothing else under `network`.

/** The network rules the manager has now (null until the first run), and how many runs hold them. */
let networkRules: string | null = null
let networkHolders = 0
/** Runs waiting for their network rules, first come first served. `take` gives a run its rules and resolves its hold. */
const networkQueue: { key: string; take: () => void }[] = []

/** A policy's network rules, whatever the order of its domains. */
const networkKey = ({ network: n }: SandboxRuntimeConfig) =>
  JSON.stringify({
    allowedDomains: [...n.allowedDomains].sort(),
    deniedDomains: [...n.deniedDomains].sort(),
    allowLocalBinding: n.allowLocalBinding ?? false
  })

/**
 * Let in the runs whose turn it is: the first in line once no run holds other rules (the rules held may be its own,
 * when a run ahead of it gave up its place), and with it everyone in line with the same rules.
 */
function admitNetwork(): void {
  while (networkQueue.length && (!networkHolders || networkQueue[0].key === networkRules)) {
    const { key } = networkQueue[0]
    for (const w of networkQueue.filter((w) => w.key === key)) {
      networkQueue.splice(networkQueue.indexOf(w), 1)
      w.take()
    }
  }
}

/**
 * Hold the manager's network config at `policy`'s rules while a run uses them; resolves to the release (releasing
 * twice does nothing). A run joins the runs holding its rules at once, unless someone is waiting: then it queues behind
 * them even with the same rules, or a stream of runs with the same rules could keep a run with other rules waiting
 * forever. Stop (the signal) while waiting gives up the place in line and rejects.
 */
export async function holdNetwork(
  sb: { updateConfig(cfg: SandboxRuntimeConfig): void },
  policy: SandboxRuntimeConfig,
  signal?: AbortSignal
): Promise<() => void> {
  signal?.throwIfAborted()
  const key = networkKey(policy)
  const take = () => {
    // The network proxy reads the allowlist per request from the global config; the filesystem rules go with the command.
    if (key !== networkRules) sb.updateConfig(policy)
    networkRules = key
    networkHolders++
    let released = false
    return () => {
      if (released) return
      released = true
      networkHolders--
      admitNetwork()
    }
  }
  // No await from this look to taking the rules or a place in line, or another run could slip in between.
  if (!networkQueue.length && (!networkHolders || key === networkRules)) return take()
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      networkQueue.splice(networkQueue.indexOf(waiter), 1)
      reject(signal?.reason)
      admitNetwork()
    }
    const waiter = {
      key,
      take: () => {
        signal?.removeEventListener('abort', onAbort)
        // A failure is this run's, not that of the run whose release let it in.
        try {
          resolve(take())
        } catch (err) {
          reject(err)
        }
      }
    }
    networkQueue.push(waiter)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/**
 * Run a shell command in the sandbox, in its own process group (so background jobs die with it). Stop (the signal)
 * kills it and rejects; running past `timeoutMs` kills it and says so. Either way, by the time it returns, anything
 * the code left running in the workspace is stopped too, even outside its process group (see reaper.ts).
 */
export async function runSandboxed(opts: {
  command: string
  policy: SandboxRuntimeConfig
  /** Where code runs (in its root), and whose leftovers are stopped when it ends. */
  workspace: Workspace
  env: Record<string, string>
  timeoutMs: number
  signal?: AbortSignal
  /** Ties sandbox denials to this run. */
  id: string
}): Promise<RunResult> {
  const sb = await sandbox()
  opts.signal?.throwIfAborted()
  await codeStarting(opts.workspace)
  let ended: Promise<void> | null = null
  const end = () => (ended ??= codeEnded(opts.workspace))
  let release = () => {}
  try {
    // Waits while another run uses other network rules. Stop pressed while the start waited for Ollmost's work in the
    // folder, or while this waits, rejects here.
    release = await holdNetwork(sb, opts.policy, opts.signal)
    // The runtime's TMPDIR=/tmp/claude is part of the command, where the environment can't override it: set ours there.
    const command = opts.env.TMPDIR ? `export TMPDIR=${shellQuote(opts.env.TMPDIR)}; ${opts.command}` : opts.command
    const { argv, env } = await sb.wrapWithSandboxArgv(command, '/bin/bash', opts.policy, opts.signal, opts.workspace.root, {
      commandId: opts.id
    })
    const procEnv = { ...(await childEnv()), ...env, ...opts.env }
    // Stop may have come while the command was being built.
    opts.signal?.throwIfAborted()
    const proc = spawnGroup(argv[0], argv.slice(1), { cwd: opts.workspace.root, env: procEnv, stdio: ['ignore', 'pipe', 'pipe'] })
    const { code, output, timedOut, truncated } = await supervise(proc, opts, end)
    return { code, output: sb.annotateStderrWithSandboxFailures(opts.id, output), timedOut, truncated }
  } finally {
    sb.cleanupAfterCommand()
    await end()
    // Only now: until its leftovers are stopped, they could make requests through the proxy under the next run's rules.
    release()
  }
}

/** How long output may keep arriving after a run's process has exited and its leftovers were stopped. */
const DRAIN_MS = 2_000

/**
 * Collect a run's output until it exits, stopping it at the time limit or on Stop (then rejecting). Once it exits,
 * `afterExit` stops whatever it left running: a process that left its group could otherwise hold the output open, and
 * the run would never end. Exported for tests.
 */
export async function supervise(
  proc: GroupProcess,
  opts: { timeoutMs: number; signal?: AbortSignal },
  afterExit: () => Promise<void>
): Promise<RunResult> {
  const chunks: Buffer[] = []
  let bytes = 0
  let truncated = false
  const collect = (chunk: Buffer) => {
    if (bytes >= OUTPUT_BYTES) return void (truncated = true)
    chunks.push(chunk)
    bytes += chunk.length
  }
  proc.child.stdout!.on('data', collect)
  proc.child.stderr!.on('data', collect)
  const closed = new Promise<void>((resolve) => proc.child.once('close', () => resolve()))

  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    void proc.stop(1000)
  }, opts.timeoutMs)
  const onAbort = () => void proc.stop(500)
  // A listener added to a signal that has already aborted never fires.
  if (opts.signal?.aborted) onAbort()
  else opts.signal?.addEventListener('abort', onAbort, { once: true })
  const settle = () => {
    clearTimeout(timer)
    opts.signal?.removeEventListener('abort', onAbort)
  }
  try {
    const code = await new Promise<number | null>((resolve, reject) => {
      proc.child.once('error', reject)
      proc.child.once('exit', (c) => resolve(c))
    })
    // It exited: from here on the time limit is no longer running (stopping leftovers and draining can take seconds).
    settle()
    await afterExit()
    await Promise.race([closed, new Promise((resolve) => setTimeout(resolve, DRAIN_MS))])
    proc.child.stdout!.destroy()
    proc.child.stderr!.destroy()
    opts.signal?.throwIfAborted()
    return { code, output: Buffer.concat(chunks).toString('utf8'), timedOut, truncated }
  } finally {
    settle()
  }
}
