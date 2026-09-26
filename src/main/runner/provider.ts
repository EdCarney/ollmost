import { existsSync } from 'node:fs'
import { mkdir, realpath, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { delimiter, isAbsolute, join, resolve, sep } from 'node:path'
import type { ToolEvent } from '@shared/types'
import { childPath } from '../env'
import type { OllamaTool } from '../ollama/client'
import { getSettings } from '../settings'
import { listSkills } from '../skills/library'
import type { ToolProvider, ToolResult } from '../chat/tools'
import type { TurnMode } from '../chat/turn'
import { capText } from '../chat/results'
import { errorMessage } from '../util'
import { chatVenvDir, ensureBaseVenv, findPython, venvPython } from './python'
import { policyFor, PRIVATE_ROOTS, runSandboxed, shellQuote } from './sandbox'
import { changedFiles, ownDir, readyForRun, realRoot, scriptsDir, snapshot, type Workspace } from './workspace'

// run_code: Python or bash in the chat's workspace, under the sandbox. Each call is a fresh process; files persist.

/** The tool source for the code runner in Conversation.toolSources. */
export const CODE_SOURCE = 'code'
const OUTPUT_CHARS = 20_000
const RECORD_CHARS = 500

export const RUN_CODE: OllamaTool = {
  type: 'function',
  function: {
    name: 'run_code',
    description:
      "Run Python 3 or bash in a sandbox on the user's Mac, in this chat's working folder. Returns the exit code and output (stdout and stderr), and lists files the code created or changed. Each call is a new process: variables don't carry over, files do.",
    parameters: {
      type: 'object',
      properties: {
        language: { type: 'string', enum: ['python', 'bash'], description: 'python (the default) or bash' },
        code: { type: 'string', description: 'The whole program or script to run' }
      },
      required: ['code']
    }
  }
}

/**
 * Whether this reply may run code: the chat switched the runner on and a workspace of Ollmost's own was prepared for
 * it. Never in a code session, which has tools of its own, and never a folder of the user's: run_code fills its folder
 * with uploads and files of its own.
 */
const enabled = (ctx: { mode: TurnMode; sources: readonly string[]; workspace: Workspace | null }) =>
  ctx.mode === 'chat' && ctx.sources.includes(CODE_SOURCE) && !!ctx.workspace?.owned && getSettings().runner.mode !== 'off'

type Language = 'python' | 'bash'

/** The code and language of a call (gpt-oss's built-in python tool sends its code under other names). */
function readCall(args: Record<string, unknown>, via: string | null): { language: Language; code: string } {
  const code = [args.code, args.input, args.script, args.source].find((v) => typeof v === 'string') as string | undefined
  const language: Language = via === 'python' || args.language !== 'bash' ? 'python' : 'bash'
  return { language, code: code ?? '' }
}

/** The first line of a program or command that isn't blank or a comment, for its card. */
export const firstLine = (code: string): string =>
  code
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l && !l.startsWith('#'))
    ?.slice(0, 120) ?? ''

let runs = 0

/**
 * Folders code may read inside the hidden ones (see policyFor): skills and tool folders on PATH. Not Ollmost's runner
 * folder: a run reads only the Python environment it uses, never another chat's. A code session's commands read these
 * too (src/main/code/tools.ts).
 */
export async function readableFolders(): Promise<string[]> {
  const skills = [...new Set((await listSkills()).map((s) => s.dir))]
  return [...skills, ...foldersOnPathInside(await childPath(), [homedir(), ...PRIVATE_ROOTS])]
}

/**
 * The folders on `path` inside one of the `hidden` ones, normalized. Never a hidden folder itself or one above it:
 * `$HOME/` or `/Users/me/.` on PATH would otherwise open the whole home folder (it's inside /Users). Exported for tests.
 */
export function foldersOnPathInside(path: string, hidden: string[]): string[] {
  const roots = hidden.map((d) => resolve(d))
  return path
    .split(delimiter)
    .filter(isAbsolute)
    .map((d) => resolve(d))
    .filter((d) => roots.some((h) => d.startsWith(h + sep)) && !roots.some((h) => h === d || h.startsWith(d + sep)))
}

/**
 * The Python environment a run uses: the chat's own when it may install packages or already has one; otherwise the
 * shared one, which no run can write (#69). A chat's own is made inside the sandbox: its earlier runs could have left
 * links in it that Ollmost, writing outside the sandbox, would follow.
 */
async function environmentFor(
  ws: Workspace,
  pypi: boolean,
  sandbox: (venv: string) => Promise<ReturnType<typeof policyFor>>,
  env: Record<string, string>,
  signal?: AbortSignal
): Promise<{ venv: string } | { error: string }> {
  // readyForRun already replaced anything but a real folder here (the chat's code can write it, with PyPI allowed).
  const own = chatVenvDir(ws.id)
  if (existsSync(venvPython(own))) return { venv: own }
  if (!pypi) return { venv: await ensureBaseVenv() }
  const python = await findPython()
  if (!python) return { error: 'Python 3 was not found on your PATH.' }
  await mkdir(own, { recursive: true })
  const made = await runSandboxed({
    command: `${shellQuote(python.path)} -m venv ${shellQuote(own)}`,
    policy: await sandbox(own),
    workspace: ws,
    env,
    timeoutMs: 120_000,
    signal,
    id: `venv:${ws.id}`
  })
  return made.code === 0 && existsSync(venvPython(own))
    ? { venv: own }
    : { error: `Couldn't make this chat's Python environment: ${made.output.trim().slice(-2000) || `exit code ${made.code}`}` }
}

async function run(language: Language, code: string, ws: Workspace, signal?: AbortSignal): Promise<ToolResult> {
  const settings = getSettings().runner
  const args = { language, code }
  const summary = firstLine(code)
  if (!code.trim())
    return { content: 'Error: run_code needs the code to run.', event: { tool: 'run_code', args, ok: false, summary: 'no code' } }

  // Nothing an earlier run left is still running (it could change the folder under Ollmost), and Ollmost's folders are there.
  try {
    await readyForRun(ws)
  } catch (err) {
    return { content: `Error: ${errorMessage(err)}`, event: { tool: 'run_code', args, ok: false, summary: 'not run' } }
  }
  const n = ++runs
  // Outside the workspace, where code can't swap it for a link or change it before it runs.
  const scripts = scriptsDir(ws.id)
  await mkdir(scripts, { recursive: true })
  const script = join(scripts, `run-${n}.${language === 'python' ? 'py' : 'sh'}`)
  await writeFile(script, code)

  // Tools that keep caches or config in HOME or TMPDIR find a writable one of Ollmost's own (see ownDir).
  const own = ownDir(ws)
  const baseEnv = {
    HOME: join(own, 'home'),
    TMPDIR: join(own, 'tmp'),
    PIP_CACHE_DIR: join(own, 'tmp', 'pip'),
    // pip checks certificates through macOS's trust service, which the sandbox blocks (SSLCertVerificationError, OSStatus
    // -26276), so every install failed. Its own certificate bundle works.
    PIP_USE_DEPRECATED: 'legacy-certs',
    MPLBACKEND: 'Agg',
    PYTHONUNBUFFERED: '1'
  }
  const readable = [...(await readableFolders()), scripts]
  // Real paths: the sandbox matches those (see PolicyInput).
  const real = await realRoot(ws)
  const sandbox = async (venv: string) =>
    policyFor({ workspace: real, home: homedir(), readable, venv: await realpath(venv).catch(() => venv), pypi: settings.pypi })
  const environment = await environmentFor(ws, settings.pypi, sandbox, baseEnv, signal)
  if ('error' in environment)
    return { content: `Error: ${environment.error}`, event: { tool: 'run_code', args, ok: false, summary: 'no Python environment' } }
  const { venv } = environment

  const before = await snapshot(ws)
  const result = await runSandboxed({
    command: language === 'python' ? `${shellQuote(venvPython(venv))} ${shellQuote(script)}` : `/bin/bash ${shellQuote(script)}`,
    policy: await sandbox(venv),
    workspace: ws,
    // Ollmost's environment comes first on PATH for bash too, so `python` and `pip` work there (Homebrew has only python3).
    env: { ...baseEnv, VIRTUAL_ENV: venv, PATH: `${join(venv, 'bin')}${delimiter}${await childPath()}` },
    timeoutMs: settings.timeoutSec * 1000,
    signal,
    id: `run_code:${n}`
  })
  // The run's leftovers were stopped as it ended; if they couldn't be, its folder isn't listed.
  let files: Array<{ path: string; size: number }> = []
  let unlisted = ''
  try {
    files = changedFiles(before, await snapshot(ws))
  } catch (err) {
    unlisted = `\n\nThe files it wrote aren't listed: ${errorMessage(err)}`
  }

  const status = result.timedOut
    ? `Stopped after ${settings.timeoutSec} seconds (the time limit).`
    : `Exit code ${result.code ?? 'none (killed)'}.`
  const output = result.output.trim() ? capText(result.output, OUTPUT_CHARS) : '(no output)'
  const listed = files.length ? `\n\nFiles created or changed:\n${files.map((f) => `- ${f.path} (${f.size} bytes)`).join('\n')}` : ''
  const content = `${status}${result.truncated ? ' (output was cut short)' : ''}\n\n${output}${listed}${unlisted}`
  const ok = !result.timedOut && result.code === 0
  const event: ToolEvent = {
    tool: 'run_code',
    args,
    ok,
    summary: ok ? summary : result.timedOut ? 'timed out' : `exit code ${result.code ?? '?'}`,
    files,
    record: `${status} ${result.output.trim().slice(0, RECORD_CHARS)}${files.length ? ` Files: ${files.map((f) => f.path).join(', ')}` : ''}`
  }
  return { content, event }
}

export const runnerTools: ToolProvider = {
  id: 'runner',
  tools: (ctx) => (enabled(ctx) ? [RUN_CODE] : []),
  grants: ['code'],
  hint: 'Use run_code to run Python or bash.',
  // gpt-oss is trained with a built-in `python` tool and calls it by that name.
  alias: (name) => (name === 'python' ? 'run_code' : null),
  pending: ({ args, via }) => {
    const { language, code } = readCall(args, via)
    return { tool: 'run_code', args: { language, code }, ok: true, pending: true, summary: firstLine(code) }
  },
  run: async ({ args, via }, ctx) => {
    const { language, code } = readCall(args, via)
    return run(language, code, ctx.workspace!, ctx.signal)
  },
  approval: () => (getSettings().runner.mode === 'allow' ? 'auto' : 'ask'),
  endpoint: ({ args, via }) => `ollmost://runner/${readCall(args, via).language}`,
  // Later turns keep what a run printed and wrote, briefly.
  replay: (e) =>
    e.tool === 'run_code' && e.record
      ? {
          name: 'run_code',
          args: { ...e.args, code: capText(String(e.args.code ?? ''), 2_000) },
          record: e.record,
          note: 'Kept in brief from an earlier turn; the files are still in the working folder.'
        }
      : null
}
