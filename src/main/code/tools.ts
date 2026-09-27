import type { ToolEvent } from '@shared/types'
import { getConversation } from '../db/conversations'
import type { OllamaTool } from '../ollama/client'
import { getSettings } from '../settings'
import { capText, TOOL_RESULT_CHARS } from '../chat/results'
import type { ToolContext, ToolProvider, ToolResult } from '../chat/tools'
import { errorMessage } from '../util'
import { CodeRunningError } from '../runner/lock'
import { firstLine } from '../runner/provider'
import { runSandboxed } from '../runner/sandbox'
import { RootMissingError, type Workspace } from '../runner/workspace'
import * as files from './files'
import { sandboxFor } from './session'

// A code session's tools (#88, #93): run_command in the sandbox, and the file tools, which work in the folder outside
// it under Ollmost's own confinement (see files.ts). Offered only in a session, never in a chat, whose run_code works
// in a folder of Ollmost's own. Few tools with small schemas: Ollama's models do best that way.

/** What "Allow for this session" covers for commands, and for edits (see src/shared/toolAllow.ts). */
export const COMMANDS_KEY = 'code:commands'
export const EDITS_KEY = 'code:edits'
/** What an event keeps of a long argument: the diff carries an edit, and the row would otherwise hold the file twice. */
const ARG_CHARS = 2000
/** What a summary keeps of a path or pattern. */
const SUMMARY_CHARS = 200
const OUTPUT_CHARS = 20_000
const RECORD_CHARS = 500
/** No command runs longer than this, whatever it asks for. */
export const MAX_TIMEOUT_SEC = 30 * 60

const PATH_ARG = { type: 'string', description: "The file's path, relative to the session's folder" }

export const READ_FILE: OllamaTool = {
  type: 'function',
  function: {
    name: 'read_file',
    description: `Read a text file in the session's folder, with line numbers. Gives up to ${files.READ_LINES} lines at a time; use offset and limit to read more or less.`,
    parameters: {
      type: 'object',
      properties: {
        path: PATH_ARG,
        offset: { type: 'number', description: 'The first line to read, counting from 1' },
        limit: { type: 'number', description: 'How many lines to read' }
      },
      required: ['path']
    }
  }
}

export const LIST_FILES: OllamaTool = {
  type: 'function',
  function: {
    name: 'list_files',
    description: `List files in the session's folder as git sees them, up to ${files.LIST_LIMIT} of them. What .gitignore ignores (node_modules, say) and .git are left out; run_command with ls sees everything.`,
    parameters: {
      type: 'object',
      properties: {
        pattern: {
          type: 'string',
          description:
            'A glob the path must match, like src/**/*.ts; a pattern without / (like *.md) matches names in any folder. Every file when absent.'
        },
        path: { type: 'string', description: "A folder to list, relative to the session's folder; the whole folder when absent" }
      }
    }
  }
}

export const SEARCH_FILES: OllamaTool = {
  type: 'function',
  function: {
    name: 'search_files',
    description: `Search the text files in the session's folder for a regular expression (JavaScript syntax, case-sensitive). Gives path:line: text for up to ${files.SEARCH_MATCHES} matches. What .gitignore ignores and .git are left out; run_command with grep sees everything.`,
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'The regular expression to find' },
        path: { type: 'string', description: "A folder to search, relative to the session's folder; the whole folder when absent" },
        glob: { type: 'string', description: 'Only files matching this glob, like *.ts or src/**/*.py' }
      },
      required: ['pattern']
    }
  }
}

export const EDIT_FILE: OllamaTool = {
  type: 'function',
  function: {
    name: 'edit_file',
    description:
      'Replace one exact passage of a text file. old_string must match the file exactly (whitespace and indentation included, without the line numbers read_file shows) and exactly once, unless replace_all is true; read the file first. For a new file, or to rewrite one whole, use write_file.',
    parameters: {
      type: 'object',
      properties: {
        path: PATH_ARG,
        old_string: { type: 'string', description: 'The exact text to replace' },
        new_string: { type: 'string', description: 'What to put in its place' },
        replace_all: { type: 'boolean', description: 'Replace every occurrence of old_string' }
      },
      required: ['path', 'old_string', 'new_string']
    }
  }
}

export const WRITE_FILE: OllamaTool = {
  type: 'function',
  function: {
    name: 'write_file',
    description: 'Write a whole text file: created (with its folders) or replaced. Prefer edit_file for a change to an existing file.',
    parameters: {
      type: 'object',
      properties: {
        path: PATH_ARG,
        content: { type: 'string', description: 'The whole content of the file' }
      },
      required: ['path', 'content']
    }
  }
}

export const RUN_COMMAND: OllamaTool = {
  type: 'function',
  function: {
    name: 'run_command',
    description:
      "Run a shell command with bash in the session's folder, in a sandbox on the user's Mac. Returns the exit code and output (stdout and stderr). Use it to run the project's tests and builds, and to make changes with the project's own tools. Each call is a new shell started in the folder: cd and variables don't carry over.",
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

export const CODE_TOOLS = [READ_FILE, LIST_FILES, SEARCH_FILES, EDIT_FILE, WRITE_FILE, RUN_COMMAND]
const CODE_TOOL_NAMES = new Set(CODE_TOOLS.map((t) => t.function.name))
const EDIT_TOOLS = new Set(['edit_file', 'write_file'])

const enabled = (ctx: { mode: string; workspace: Workspace | null }) => ctx.mode === 'code' && !!ctx.workspace && !ctx.workspace.owned

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined)
/** A number, also when the model wrote it as a string. */
const num = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && v.trim() && Number.isFinite(Number(v)) ? Number(v) : undefined
const cap = (v: string | undefined) => (v === undefined ? undefined : capText(v, ARG_CHARS))
/** A path or pattern as a card's one line. */
const short = (v: string | undefined) => (v === undefined ? '' : v.length > SUMMARY_CHARS ? `${v.slice(0, SUMMARY_CHARS)}…` : v)
/** An object without its undefined values, for an event's args. */
const compact = (o: Record<string, unknown>): Record<string, unknown> =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined))

/** A call's arguments read leniently (a model may use the names it knows from elsewhere), and what the event keeps. */
interface Call {
  event: Record<string, unknown>
  path?: string
  offset?: number
  limit?: number
  pattern?: string
  glob?: string
  edit?: files.EditArgs
  write?: files.WriteArgs
  command: string
  timeoutSec?: number
}

function readCall(name: string, args: Record<string, unknown>): Call {
  const path = str(args.path) ?? str(args.file_path) ?? str(args.file)
  const command = str(args.command) ?? str(args.input) ?? ''
  switch (name) {
    case 'read_file': {
      const offset = num(args.offset)
      const limit = num(args.limit)
      return { event: compact({ path: cap(path), offset, limit }), path, offset, limit, command }
    }
    case 'list_files': {
      const pattern = str(args.pattern) ?? str(args.glob)
      return { event: compact({ pattern: cap(pattern), path: cap(path) }), pattern, path, command }
    }
    case 'search_files': {
      const pattern = str(args.pattern) ?? str(args.regex) ?? str(args.query)
      const glob = str(args.glob)
      return { event: compact({ pattern: cap(pattern), path: cap(path), glob: cap(glob) }), pattern, path, glob, command }
    }
    case 'edit_file': {
      const oldString = str(args.old_string) ?? str(args.old_str)
      const newString = str(args.new_string) ?? str(args.new_str)
      const replaceAll = args.replace_all === true || args.replace_all === 'true'
      return {
        event: compact({ path: cap(path), old_string: cap(oldString), new_string: cap(newString), replace_all: replaceAll || undefined }),
        path,
        edit: { path, oldString, newString, replaceAll },
        command
      }
    }
    case 'write_file': {
      const content = str(args.content) ?? str(args.file_text) ?? str(args.text)
      return { event: compact({ path: cap(path), content: cap(content) }), path, write: { path, content }, command }
    }
    default: {
      const timeoutSec = num(args.timeout_sec)
      return { event: compact({ command, timeout_sec: timeoutSec }), command, timeoutSec }
    }
  }
}

let runs = 0

async function runCommand(command: string, timeoutSec: number | undefined, ws: Workspace, signal?: AbortSignal): Promise<ToolResult> {
  const args = compact({ command, timeout_sec: timeoutSec })
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
  let sandbox: Awaited<ReturnType<typeof sandboxFor>>
  try {
    sandbox = await sandboxFor(ws, network)
  } catch (err) {
    return failed(errorMessage(err), 'not run')
  }
  const n = ++runs
  const result = await runSandboxed({
    command,
    ...sandbox,
    workspace: ws,
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

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`

/** A file tool's result. Throws files.Refused (and the lock's or the folder's errors), which fileTool turns into an error result. */
async function fileToolResult(name: string, c: Call, ws: Workspace, ctx: ToolContext): Promise<ToolResult> {
  const done = (content: string, extra: Partial<ToolEvent> & { summary: string }): ToolResult => ({
    content,
    event: { tool: name, args: c.event, ok: true, ...extra }
  })
  switch (name) {
    case 'read_file': {
      const budget = Math.min(ctx.maxResultChars ?? TOOL_RESULT_CHARS, TOOL_RESULT_CHARS)
      // The lines get what the header (the path, three line numbers and a sentence) leaves of the budget.
      const room = budget - Math.min(String(c.path ?? '').length, ARG_CHARS) - 120
      const r = await files.readFile(ws, c.path, { offset: c.offset, limit: c.limit, maxChars: room })
      const whole = r.from === 1 && r.to === r.total
      const summary = whole ? plural(r.total, 'line') : `lines ${r.from}–${r.to} of ${r.total}`
      const header =
        r.to < r.total ? `${r.rel} (${summary}; call read_file again with offset=${r.to + 1} for more)` : `${r.rel} (${summary})`
      return done(r.text ? `${header}\n\n${r.text}` : header, {
        summary,
        record: `Read ${r.rel} (${summary}). Read it again for the text.`
      })
    }
    case 'list_files': {
      const r = await files.listFiles(ws, { pattern: c.pattern, path: c.path })
      const n = r.files.length
      const where = r.rel ? ` in ${r.rel}` : ''
      const body = n
        ? r.files.join('\n')
        : `No files${c.pattern ? ` match ${c.pattern}` : ''}${where} (what .gitignore ignores, and .git, are left out; run_command with ls sees everything).`
      const note =
        r.stopped === 'limit'
          ? `\n[… the list stops at ${files.LIST_LIMIT} files; narrow the pattern or the folder]`
          : r.stopped === 'visits'
            ? '\n[… the folder holds more entries than a listing looks at; narrow the folder]'
            : r.stopped === 'time'
              ? '\n[… the listing stopped at its time limit; narrow the folder]'
              : ''
      const content = `${body}${note}`
      return done(content, {
        summary: n === 0 ? 'no files' : r.cut ? `${n}+ files` : plural(n, 'file'),
        record: capText(content, RECORD_CHARS)
      })
    }
    case 'search_files': {
      const r = await files.searchFiles(ws, { pattern: c.pattern, path: c.path, glob: c.glob, signal: ctx.signal })
      const where = r.rel ? ` in ${r.rel}` : ''
      const body = r.matches
        ? r.lines.join('\n')
        : `No matches for /${c.pattern}/${where} (what .gitignore ignores, and .git, are left out; run_command with grep sees everything).`
      const content = `${body}${r.cut ? `\n[… ${r.cut}]` : ''}`
      const summary =
        r.matches === 0
          ? `no matches${r.cut ? ' (cut short)' : ''}`
          : r.cut
            ? `${r.matches}+ matches`
            : `${r.matches} ${r.matches === 1 ? 'match' : 'matches'} in ${plural(r.files, 'file')}`
      return done(content, { summary, record: capText(content, RECORD_CHARS) })
    }
    default: {
      const r = name === 'edit_file' ? await files.editFile(ws, c.edit!) : await files.writeFile(ws, c.write!)
      const summary = r.created ? `new file, ${plural(r.added, 'line')}` : `+${r.added} −${r.removed}`
      const verb = name === 'edit_file' ? 'Edited' : 'Wrote'
      const record = `${verb} ${r.rel} (${summary}).`
      // The model gets the diff back for an edit, to see its change in place; what it wrote whole it knows.
      const content = name === 'edit_file' ? `${record}\n\n${r.diff}` : record
      return done(content, { summary, diff: r.diff, files: [{ path: r.rel, size: r.size }], record })
    }
  }
}

async function fileTool(name: string, c: Call, ws: Workspace, ctx: ToolContext): Promise<ToolResult> {
  try {
    return await fileToolResult(name, c, ws, ctx)
  } catch (err) {
    if (ctx.signal?.aborted) throw err
    return failure(name, c, err)
  }
}

/** A file tool's answer when it failed: the message, and the reason in a word or two as the summary. */
function failure(name: string, c: Call, err: unknown): ToolResult {
  const reason =
    err instanceof files.Refused
      ? err.reason
      : err instanceof RootMissingError
        ? 'folder missing'
        : err instanceof CodeRunningError
          ? 'code running'
          : short(errorMessage(err))
  return { content: `Error: ${errorMessage(err)}`, event: { tool: name, args: c.event, ok: false, summary: reason } }
}

/**
 * Edits whose preview failed, by the turn's workspace and the call: such a call answers with the failure instead of
 * asking first (the user would see no diff, and the file isn't touched either way). Kept until the call runs, so the
 * run gives the answer the preview settled on rather than trying the file again. The workspace, not the context: the
 * runner hands a provider a copy of the context, with the same workspace in it.
 */
const previewFailures = new WeakMap<Workspace, Map<string, ToolResult>>()
const callKey = (name: string, args: Record<string, unknown>) => `${name}\0${JSON.stringify(args)}`
const previewFailure = (ctx: ToolContext, name: string, args: Record<string, unknown>) =>
  (ctx.workspace && previewFailures.get(ctx.workspace)?.get(callKey(name, args))) ?? null

export const codeTools: ToolProvider = {
  id: 'code',
  tools: (ctx) => (enabled(ctx) ? CODE_TOOLS : []),
  grants: ['code'],
  hint: 'Use read_file, list_files and search_files to look at the folder, edit_file and write_file to change it, and run_command to run a shell command in it.',
  pending: async ({ name, args }, ctx) => {
    const c = readCall(name, args)
    const base = { tool: name, args: c.event, ok: true, pending: true }
    switch (name) {
      case 'run_command':
        return { ...base, summary: firstLine(c.command) }
      case 'list_files':
        return { ...base, summary: c.pattern ? short(c.pattern) : 'files' }
      case 'search_files':
        return { ...base, summary: short(c.pattern) }
      case 'read_file':
        return { ...base, summary: short(c.path) }
      default: {
        // The diff the edit would make, shown while the call asks. When it can't be made, the call won't ask: it
        // answers with the failure (see previewFailures).
        const ws = ctx.workspace
        if (!ws) return { ...base, summary: short(c.path) }
        const key = callKey(name, args)
        const failures = previewFailures.get(ws) ?? new Map<string, ToolResult>()
        previewFailures.set(ws, failures)
        failures.delete(key)
        try {
          const diff = name === 'edit_file' ? await files.editDiff(ws, c.edit!) : await files.writeDiff(ws, c.write!)
          return { ...base, summary: short(c.path), diff }
        } catch (err) {
          if (ctx.signal?.aborted) throw err
          // A folder that's busy or missing may not be by the time the call runs: it asks as usual and tries then.
          if (!(err instanceof CodeRunningError || err instanceof RootMissingError)) failures.set(key, failure(name, c, err))
          return { ...base, summary: short(c.path) }
        }
      }
    }
  },
  run: async ({ name, args }, ctx) => {
    const c = readCall(name, args)
    if (name === 'run_command') return runCommand(c.command, c.timeoutSec, ctx.workspace!, ctx.signal)
    const failed = previewFailure(ctx, name, args)
    if (failed) {
      previewFailures.get(ctx.workspace!)!.delete(callKey(name, args))
      return failed
    }
    return fileTool(name, c, ctx.workspace!, ctx)
  },
  approval: ({ name, args }, ctx) => {
    const settings = getSettings().code
    if (name === 'run_command') return settings.commands === 'allow' ? 'auto' : 'ask'
    if (EDIT_TOOLS.has(name)) return settings.edits === 'allow' || previewFailure(ctx, name, args) ? 'auto' : 'ask'
    return 'auto'
  },
  allowKey: ({ name }) => (name === 'run_command' ? COMMANDS_KEY : EDIT_TOOLS.has(name) ? EDITS_KEY : name),
  endpoint: ({ name }) => `ollmost://code/${name}`,
  // Later turns keep what a command printed, briefly, and a line about each file call.
  replay: (e) => {
    if (!e.record || !CODE_TOOL_NAMES.has(e.tool)) return null
    if (e.tool === 'run_command')
      return {
        name: 'run_command',
        args: { ...e.args, command: capText(String(e.args.command ?? ''), 2_000) },
        record: e.record,
        note: 'Kept in brief from an earlier turn; run it again if you need the full output.'
      }
    // Only the small arguments: an edit's strings or a file's content would count against no budget.
    const { path, pattern, glob, offset, limit } = e.args
    return {
      name: e.tool,
      args: compact({ path, pattern, glob, offset, limit }),
      record: e.record,
      note:
        e.tool === 'read_file'
          ? 'Kept in brief from an earlier turn; read the file again if you need its text.'
          : 'Kept in brief from an earlier turn.'
    }
  }
}
