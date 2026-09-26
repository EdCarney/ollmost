import { reap } from './reaper'
import type { Workspace } from './workspace'

// Ollmost works in a conversation's folders outside the sandbox (getting a workspace ready, listing and marking its
// files, deleting it, resetting environments), so it must never do that while code that could change them runs: code
// could swap a folder for a link between Ollmost's check and its write, and Ollmost would follow it (#71). Code runs in
// the folders two ways: a run in progress, or a process a run left behind (#73). So Ollmost's work in a workspace goes
// inside its lock (quiesce): no run in progress, leftovers stopped first, and no run starting until the work is done
// (#76). The lock is per root (Workspace.key: two code sessions on one folder take turns), while what's been checked is
// per workspace, since each has leftovers of its own to stop (Workspace.folders).

/** Roots with code running in them now, by key (a count: a venv is made in the sandbox before a run). */
const running = new Map<string, number>()
/** Workspaces with code running in them now, by id (a count too). */
const runs = new Map<string, number>()
/** Work in progress under a root's lock (a check, and what it protects), by key. Code doesn't start there meanwhile. */
const locked = new Map<string, Promise<unknown>>()
/** Workspaces checked since their last run, by id: none of their code is still running. */
const settled = new Set<string>()
/** Workspaces code ran in this session that haven't been checked since (a check failed), by id. */
const unchecked = new Set<string>()

export class CodeRunningError extends Error {
  constructor(where = 'this chat') {
    super(`Code is running in ${where}. Try again when it finishes.`)
  }
}

const lockedIn = (workspaces: Workspace[]) => [...new Set(workspaces.map((w) => locked.get(w.key)))].filter((p) => p !== undefined)

/**
 * Run `work` holding these workspaces' locks, once no other work holds any of them. The wait is a loop here, not a
 * helper awaited: from its last look to taking the locks there must be no await, or other work could slip in.
 */
async function exclusive<T>(workspaces: Workspace[], work: () => Promise<T>): Promise<T> {
  for (let pending = lockedIn(workspaces); pending.length; pending = lockedIn(workspaces)) await Promise.allSettled(pending)
  const done = work()
  for (const w of workspaces) locked.set(w.key, done)
  try {
    return await done
  } finally {
    for (const w of workspaces) if (locked.get(w.key) === done) locked.delete(w.key)
  }
}

/**
 * Stop code left running in these workspaces. Only a workspace whose first folder the check covered counts as
 * settled: the reaper can't check a folder that's missing.
 */
async function check(workspaces: Workspace[]): Promise<number> {
  const { stopped, checked } = await reap([...new Set(workspaces.flatMap((w) => w.folders))])
  for (const w of workspaces) {
    if (!checked.includes(w.folders[0])) continue
    settled.add(w.id)
    unchecked.delete(w.id)
  }
  return stopped
}

/** Code is about to start in `workspace` (once no work holds its root's lock). */
export async function codeStarting(workspace: Workspace): Promise<void> {
  for (let pending = lockedIn([workspace]); pending.length; pending = lockedIn([workspace])) await Promise.allSettled(pending)
  settled.delete(workspace.id)
  unchecked.add(workspace.id)
  running.set(workspace.key, (running.get(workspace.key) ?? 0) + 1)
  runs.set(workspace.id, (runs.get(workspace.id) ?? 0) + 1)
}

/**
 * Code in `workspace` has ended: stop anything it left running, unless another run of the same workspace is still
 * going (the check couldn't tell its processes from leftovers). Another workspace's run on the same root may go on
 * meanwhile: the check tells leftovers apart by the workspace's own folders. A failure is left for the next quiesce()
 * to report.
 */
export async function codeEnded(workspace: Workspace): Promise<void> {
  const n = (running.get(workspace.key) ?? 1) - 1
  if (n > 0) running.set(workspace.key, n)
  else running.delete(workspace.key)
  const own = (runs.get(workspace.id) ?? 1) - 1
  if (own > 0) return void runs.set(workspace.id, own)
  runs.delete(workspace.id)
  try {
    await exclusive([workspace], () => check([workspace]))
  } catch (err) {
    console.warn(`Ollmost: couldn't stop code left running in ${workspace.root}:`, err)
  }
}

/**
 * Do `work` in a workspace's folders outside the sandbox: with none of its code running (leftovers stopped first),
 * and no run starting until it's done. Throws CodeRunningError while a run is in progress, or if leftovers can't be
 * stopped. `work` must not quiesce the same workspace again: it would wait for itself.
 */
export async function quiesce<T>(workspace: Workspace, work: () => Promise<T>): Promise<T> {
  if (running.has(workspace.key)) throw new CodeRunningError()
  return exclusive([workspace], async () => {
    // A run may have started while earlier work finished.
    if (running.has(workspace.key)) throw new CodeRunningError()
    if (!settled.has(workspace.id)) await check([workspace])
    return work()
  })
}

/**
 * Stop code left running in these workspaces, then do `work` with the ones that are quiet, under all their locks.
 * Returns how many processes were stopped. By default any run in progress refuses it all (deleting every environment
 * mustn't pull one from under a run); `skipRunning` leaves running workspaces to their run's end instead (the sweeps
 * at startup and when quitting).
 */
export async function quiesceEvery(
  workspaces: Workspace[],
  opts: { skipRunning?: boolean; work?: (quiet: Workspace[]) => Promise<void> } = {}
): Promise<number> {
  const busy = () => workspaces.filter((w) => running.has(w.key))
  if (!opts.skipRunning && busy().length) throw new CodeRunningError('a chat')
  const claimed = opts.skipRunning ? workspaces.filter((w) => !running.has(w.key)) : workspaces
  return exclusive(claimed, async () => {
    const quiet = claimed.filter((w) => !running.has(w.key))
    if (!opts.skipRunning && quiet.length < claimed.length) throw new CodeRunningError('a chat')
    const stopped = await check(quiet)
    await opts.work?.(quiet)
    return stopped
  })
}

/** Whether code this session started may still be running (in a run, or left behind where a check failed). */
export const codeMayBeRunning = (): boolean => running.size > 0 || unchecked.size > 0

/** Forget a workspace that was deleted. */
export function forgetWorkspace(workspace: Workspace): void {
  settled.delete(workspace.id)
  unchecked.delete(workspace.id)
}
