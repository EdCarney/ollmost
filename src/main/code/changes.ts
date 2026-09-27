import { dirname } from 'node:path'
import type { ChangedFile, ChangeStatus, CodeChanges, CodeDiff } from '@shared/types'
import { runSandboxed, shellQuote, type RunResult } from '../runner/sandbox'
import { realRoot, type Workspace } from '../runner/workspace'
import { errorMessage } from '../util'
import { locate, Refused } from './files'
import { panelRun, panelRunStarted, panelRunStopped, stopPanelRuns } from './panelRuns'
import { hasCommandLineTools, sandboxFor } from './session'

// What changed in a session's folder, asked of git run inside the session's sandbox and never outside it: a folder
// that isn't a repository lets session code plant a .git file whose config names programs (a fsmonitor, hooks,
// filters, an external diff) that git run by Ollmost would execute as the user. The flags below keep git from running
// the ones they can (the fsmonitor, hooks, an external diff, textconv); a clean filter still runs, as it would for a
// session's own git, confined by the sandbox like any session command. Git sees the folder as the session's commands
// do, and stops looking for a repository at the folder's parent, so a folder inside a repository isn't one to it.
// File names are taken literally: a session names its files, and a name read as a pathspec (`:x`, `*`) would show
// another file's change under it; and the working tree is the folder itself, whatever a planted core.worktree says,
// or the paths listed would name other files than the ones a click then shows.

const GIT =
  '/usr/bin/git --literal-pathspecs --work-tree=. --no-optional-locks -c core.fsmonitor=false -c core.hooksPath=/dev/null --no-pager'
const DIFF = `${GIT} diff --no-ext-diff --no-textconv --no-color`
/**
 * The script's exit codes: git's own when it says there's no repository; one for git failing before it could say (a
 * broken config); one for status failing in a repository it found.
 */
const NOT_A_REPOSITORY = 128
const NO_ANSWER = 5
const GIT_FAILED = 4
/**
 * How long one git run may take, the wait for the sandbox included. Ten seconds is plenty on a Mac of the user's;
 * a CI runner's sandbox can be far slower, so OLLMOST_GIT_MS lengthens it there. Nothing gates the variable to
 * tests: a positive number in the app's own environment would apply too, like the other OLLMOST_* knobs.
 */
const configuredGitMs = Number(process.env.OLLMOST_GIT_MS)
export const GIT_MS = Number.isFinite(configuredGitMs) && configuredGitMs > 0 ? configuredGitMs : 10_000
export const FILES_LIMIT = 500
/** More than an edit's diff keeps (files.ts): this one is shown in the panel, not given to the model. */
export const DIFF_LIMIT_CHARS = 200_000
const NO_TOOLS = 'Git needs the Command Line Tools: run xcode-select --install.'
const TOO_LONG = `Git took longer than ${GIT_MS / 1000} seconds.`
const STOPPED = 'A reply started in a session on this folder; look again when it ends.'

// Git's own messages are dropped (they'd mix with the output); the exit codes say what happened. Whether the folder
// is a repository is asked first, by git's own words for it, so neither a failure of status itself nor a repository
// git can't read is taken for "not a repository".
const STATUS = [
  `m=$(${GIT} rev-parse --git-dir 2>&1 >/dev/null) || case "$m" in *"not a git repository"*) exit ${NOT_A_REPOSITORY} ;; *) exit ${NO_ANSWER} ;; esac`,
  `${GIT} status --porcelain=v1 -z --untracked-files=all 2>/dev/null || exit ${GIT_FAILED}`
].join('\n')

/**
 * A file's diff against HEAD when git knows it there or in the index (a change, a deletion however it was made, a
 * file added since the last commit); otherwise the whole file as new (untracked, or a repository with no commit yet).
 * Only `diff --no-index` exits 1 to mean a difference.
 */
const diffScript = (path: string) =>
  [
    `p=${shellQuote(path)}`,
    `if ${GIT} rev-parse -q --verify HEAD >/dev/null 2>&1 && { ${GIT} ls-files --error-unmatch -- "$p" >/dev/null 2>&1 || ${GIT} cat-file -e "HEAD:$p" 2>/dev/null; }; then`,
    `  ${DIFF} HEAD -- "$p" 2>/dev/null; exit $?`,
    `fi`,
    `${DIFF} --no-index -- /dev/null "$p" 2>/dev/null; [ $? -le 1 ]`
  ].join('\n')

let runs = 0

/** A panel call's options: `replying` says whether a reply is running in the session now, asked when the run's turn comes. */
export interface PanelOptions {
  replying?: () => boolean
}

/**
 * Run git in the session's sandbox, after any panel run already going in that folder (one at a time, so a refresh
 * and a diff asked together don't refuse each other), unless a reply starts there first (see panelRuns.ts): a
 * reply stops the runs it finds registered, and a run whose turn comes after a reply began asks `replying` and gives
 * up.
 */
async function git(ws: Workspace, command: string, opts: PanelOptions): Promise<RunResult> {
  const { signal, after } = panelRun(ws.key)
  const turn = after.then(() => gitNow(ws, command, signal, opts))
  panelRunStarted(ws.key, turn)
  return turn
}

/**
 * Git in the session's sandbox with the network off, reading no config of the user's, its search for a repository
 * stopped at the folder's parent. Throws when the folder isn't where it was, there are no Command Line Tools to run
 * git with, a reply stopped it, or the time limit passes: that limit covers the wait for the sandbox's network rules
 * too, which another run with other rules holds for as long as it runs.
 */
async function gitNow(ws: Workspace, command: string, stop: AbortSignal, opts: PanelOptions): Promise<RunResult> {
  if (stop.aborted || opts.replying?.()) throw new Error(STOPPED)
  const { policy, env } = await sandboxFor(ws, 'none')
  if (!(await hasCommandLineTools())) throw new Error(NO_TOOLS)
  const signal = AbortSignal.any([stop, AbortSignal.timeout(GIT_MS)])
  try {
    return await runSandboxed({
      command,
      policy,
      workspace: ws,
      env: {
        ...env,
        GIT_CEILING_DIRECTORIES: dirname(ws.root),
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_TERMINAL_PROMPT: '0',
        LC_ALL: 'C'
      },
      timeoutMs: GIT_MS,
      signal,
      id: `changes:${++runs}`
    })
  } catch (err) {
    if (panelRunStopped(signal)) throw new Error(STOPPED, { cause: err })
    if (signal.aborted) throw new Error(TOO_LONG, { cause: err })
    throw err
  }
}

/**
 * A run's output without the note the runtime appends when the sandbox denied something (`\n<sandbox_violations>\n`
 * … `</sandbox_violations>`, nothing after it), and the note's lines. Only a note at the very end counts: git's
 * output always ends with a line break or NUL, so text in it can't pass for one. Exported for tests.
 */
export function withoutNote(output: string): { text: string; denied: string | null } {
  const open = '\n<sandbox_violations>\n'
  const close = '</sandbox_violations>'
  if (!output.endsWith(close)) return { text: output, denied: null }
  const at = output.lastIndexOf(open)
  if (at < 0) return { text: output, denied: null }
  return {
    text: output.slice(0, at),
    denied: output
      .slice(at + open.length, output.length - close.length)
      .trim()
      .slice(0, 300)
  }
}

const failed = (what: string, r: RunResult): string => {
  const { denied } = withoutNote(r.output)
  return `Git couldn't ${what} (exit code ${r.code ?? 'none'}).${denied ? ` The sandbox denied: ${denied}` : ''}`
}

/**
 * What changed in a session's folder: git status inside the sandbox, parsed. A folder that isn't a repository gives
 * `repo: false` and no error; what stops git from answering (no Command Line Tools, the folder moved, a failure, the
 * time limit) is the error, for the panel to show.
 */
export async function changes(ws: Workspace, opts: PanelOptions = {}): Promise<CodeChanges> {
  const none = (error: string | null, repo = false): CodeChanges => ({ repo, files: [], cut: false, error })
  let r: RunResult
  try {
    r = await git(ws, STATUS, opts)
  } catch (err) {
    return none(errorMessage(err))
  }
  if (r.timedOut) return none(TOO_LONG)
  if (r.code === NOT_A_REPOSITORY) return none(null)
  if (r.code === GIT_FAILED) return none(failed('list the changes', r), true)
  if (r.code !== 0) return none(failed('list the changes', r))
  const { files, cut } = parseStatus(withoutNote(r.output).text, r.truncated)
  return { repo: true, files, cut: cut || r.truncated, error: null }
}

/**
 * The files `git status --porcelain=v1 -z` lists: records of `XY path` each ending in NUL, a rename's old name in a
 * record of its own after it. Anything that isn't a record (the empty end, a note the runtime appended) is passed
 * over, and so is the partial record at the end of output that was cut short. Exported for tests.
 */
export function parseStatus(output: string, truncated = false): { files: ChangedFile[]; cut: boolean } {
  const records = output.split('\0')
  if (truncated) records.pop()
  const files: ChangedFile[] = []
  for (let i = 0; i < records.length; i++) {
    const r = records[i]
    if (r.length < 4 || r[2] !== ' ') continue
    const status = statusOf(r[0], r[1])
    if (!status) continue
    if (files.length === FILES_LIMIT) return { files, cut: true }
    const file: ChangedFile = { path: r.slice(3), status }
    if (status === 'renamed' || r[0] === 'C') {
      const from = records[++i]
      if (from === undefined) break
      file.from = from
    }
    files.push(file)
  }
  return { files, cut: false }
}

/** A file's state from its two status letters (the index's, then the working tree's). */
function statusOf(x: string, y: string): ChangeStatus | null {
  if (x === '?') return 'untracked'
  if (x === '!') return null
  if (x === 'U' || y === 'U' || (x === 'A' && y === 'A') || (x === 'D' && y === 'D')) return 'conflict'
  if (x === 'R' || y === 'R') return 'renamed'
  if (x === 'D' || y === 'D') return 'deleted'
  if (x === 'A' || x === 'C' || y === 'A') return 'added'
  if (x === 'M' || y === 'M' || x === 'T' || y === 'T') return 'modified'
  return null
}

/**
 * One changed file's diff, by its path as git status gives it. The path is checked as the file tools check theirs
 * (inside the folder by real path: not through a link that leaves it), then git answers from inside the sandbox.
 * Throws for a bad path, missing tools, a folder that's moved, the time limit or git failing.
 */
export async function diff(ws: Workspace, path: unknown, opts: PanelOptions = {}): Promise<CodeDiff> {
  // The folder first (RootMissingError when it moved), then the path in it.
  await realRoot(ws)
  let rel: string
  try {
    rel = (await locate(ws.root, path)).rel
  } catch (err) {
    throw new Error(err instanceof Refused ? err.message : errorMessage(err), { cause: err })
  }
  const r = await git(ws, diffScript(rel), opts)
  if (r.timedOut) throw new Error(TOO_LONG)
  if (r.code !== 0) throw new Error(failed('show the change', r))
  const { text } = withoutNote(r.output)
  const cut = r.truncated || text.length > DIFF_LIMIT_CHARS
  return { diff: cut ? text.slice(0, DIFF_LIMIT_CHARS) : text, cut }
}

export { stopPanelRuns }
