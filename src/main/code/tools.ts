import { realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import type { ToolEvent } from '@shared/types'
import { childPath } from '../env'
import { getConversation } from '../db/conversations'
import type { OllamaTool } from '../ollama/client'
import { getSettings } from '../settings'
import { capText } from '../chat/results'
import type { ToolProvider, ToolResult } from '../chat/tools'
import { errorMessage } from '../util'
import { firstLine, readableFolders } from '../runner/provider'
import { runSandboxed } from '../runner/sandbox'
import { readyForRun, realRoot, sessionDir, type Workspace } from '../runner/workspace'
import { codePolicyFor, toolchainFolders } from './policy'
import { sessionEnv } from './session'

// A code session's tools (#88): run_command now; the file tools come next. Offered only in a session, never in a
// chat, whose run_code works in a folder of Ollmost's own.

/** What "Allow for this session" covers for commands (see src/shared/toolAllow.ts). */
export const COMMANDS_KEY = 'code:commands'
const OUTPUT_CHARS = 20_000
const RECORD_CHARS = 500
/** No command runs longer than this, whatever it asks for. */
export const MAX_TIMEOUT_SEC = 30 * 60

export const RUN_COMMAND: OllamaTool = {
  type: 'function',
  function: {
    name: 'run_command',
    description:
      "Run a shell command with bash in the session's folder, in a sandbox on the user's Mac. Returns the exit code and output (stdout and stderr). Use it to look around (ls, cat, grep, git status), to run the project's tests and builds, and to make changes with the project's own tools. Each call is a new shell started in the folder: cd and variables don't carry over.",
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'The command line to run' },
        timeout_sec: {
          type: 'number',
          description: "Seconds before the command is stopped. Defaults to the session's limit; at most 1800."
        }
      },
      required: ['command']
    }
  }
}

const enabled = (ctx: { mode: string; workspace: Workspace | null }) => ctx.mode === 'code' && !!ctx.workspace && !ctx.workspace.owned

function readCall(args: Record<string, unknown>): { command: string; timeoutSec: number | undefined } {
  const command = typeof args.command === 'string' ? args.command : typeof args.input === 'string' ? args.input : ''
  const timeoutSec = typeof args.timeout_sec === 'number' && Number.isFinite(args.timeout_sec) ? args.timeout_sec : undefined
  return { command, timeoutSec }
}

const eventArgs = (command: string, timeoutSec: number | undefined) =>
  timeoutSec === undefined ? { command } : { command, timeout_sec: timeoutSec }

let runs = 0

async function run(command: string, timeoutSec: number | undefined, ws: Workspace, signal?: AbortSignal): Promise<ToolResult> {
  const args = eventArgs(command, timeoutSec)
  const summary = firstLine(command)
  const failed = (content: string, why: string): ToolResult => ({
    content: `Error: ${content}`,
    event: { tool: 'run_command', args, ok: false, summary: why }
  })
  if (!command.trim()) return failed('run_command needs a command to run.', 'no command')
  const settings = getSettings().code
  const limit = Math.min(MAX_TIMEOUT_SEC, Math.max(1, Math.floor(timeoutSec ?? settings.timeoutSec)))
  // The preset as it is now, so a change made in the session's menu takes effect at the next command.
  const network = getConversation(ws.id)?.network ?? 'none'

  // The folder is where it was, the scratch is in order, and none of the session's code is still running.
  try {
    await readyForRun(ws)
  } catch (err) {
    return failed(errorMessage(err), 'not run')
  }
  const n = ++runs
  const path = await childPath()
  const home = homedir()
  const toolchains = toolchainFolders(path, home)
  // Real paths: the sandbox matches those (see CodePolicyInput). The scratch was just made a real folder.
  const policy = codePolicyFor({
    root: await realRoot(ws),
    session: await realpath(sessionDir(ws.id)),
    home,
    readable: [...(await readableFolders()), ...toolchains.roots],
    denied: toolchains.denied,
    network
  })
  const result = await runSandboxed({
    command,
    policy,
    workspace: ws,
    env: sessionEnv(ws, path, toolchains.env),
    timeoutMs: limit * 1000,
    signal,
    id: `run_command:${n}`
  })

  const status = result.timedOut ? `Stopped after ${limit} seconds (the time limit).` : `Exit code ${result.code ?? 'none (killed)'}.`
  const output = result.output.trim() ? capText(result.output, OUTPUT_CHARS) : '(no output)'
  const content = `${status}${result.truncated ? ' (output was cut short)' : ''}\n\n${output}`
  const ok = !result.timedOut && result.code === 0
  const event: ToolEvent = {
    tool: 'run_command',
    args,
    ok,
    summary: ok ? summary : result.timedOut ? 'timed out' : `exit code ${result.code ?? '?'}`,
    record: `${status} ${result.output.trim().slice(0, RECORD_CHARS)}`
  }
  return { content, event }
}

export const codeTools: ToolProvider = {
  id: 'code',
  tools: (ctx) => (enabled(ctx) ? [RUN_COMMAND] : []),
  grants: ['code'],
  hint: 'Use run_command to run a shell command in the folder.',
  pending: ({ args }) => {
    const { command, timeoutSec } = readCall(args)
    return { tool: 'run_command', args: eventArgs(command, timeoutSec), ok: true, pending: true, summary: firstLine(command) }
  },
  run: async ({ args }, ctx) => {
    const { command, timeoutSec } = readCall(args)
    return run(command, timeoutSec, ctx.workspace!, ctx.signal)
  },
  approval: () => (getSettings().code.commands === 'allow' ? 'auto' : 'ask'),
  allowKey: () => COMMANDS_KEY,
  endpoint: () => 'ollmost://code/run_command',
  // Later turns keep what a command printed, briefly.
  replay: (e) =>
    e.tool === 'run_command' && e.record
      ? {
          name: 'run_command',
          args: { ...e.args, command: capText(String(e.args.command ?? ''), 2_000) },
          record: e.record,
          note: 'Kept in brief from an earlier turn; run it again if you need the full output.'
        }
      : null
}
