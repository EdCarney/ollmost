import { constants, type Stats } from 'node:fs'
import { lstat, mkdir, open, realpath, stat } from 'node:fs/promises'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import { Worker } from 'node:worker_threads'
import { structuredPatch } from 'diff'
import { NO_LINKS, openNoLinks, readyForSession, type Workspace } from '../runner/workspace'
import { dropSessionPaths } from './pathList'
import searchWorker from './search.worker.js?raw'
import { walkFiles } from './walk'

// A code session's file tools (#93) work in the user's folder outside the sandbox, so Ollmost confines them itself.
// Every path is resolved to a real path inside the folder: a link of the user's that stays inside is followed (a repo
// often has one), one that leaves is refused. A write never goes through a link, never under .git, and never to a name
// the sandbox denies the session's commands, so a file tool can never do what a command can't. Everything runs under
// the session's lock (readyForSession): none of the session's code runs meanwhile, so nothing can put a link on a path
// between a check and the open. Reads still open with no link anywhere in the path, from the real path.

/** How many lines read_file gives at a time unless asked for fewer. */
export const READ_LINES = 2000
/** read_file reads a file whole to number its lines; past this, run_command with sed or head is the way. */
const READ_MAX_BYTES = 8 * 1024 * 1024
/** edit_file and write_file hold the file and its diff in memory, and the event keeps the diff. */
const EDIT_MAX_BYTES = 2 * 1024 * 1024
const DIFF_MAX_CHARS = 100_000
/** A diff that takes longer, or changes more lines, than this is shown as the whole file replaced. */
const DIFF_MAX_MS = 1000
const DIFF_MAX_EDITS = 5000
/** A minified line is cut on its way to the model. */
const LINE_MAX_CHARS = 2000
export const LIST_LIMIT = 500
/** A glob longer than this is refused: its {…} groups expand one call deep each. */
const GLOB_MAX_CHARS = 1000
const LIST_VISIT_LIMIT = 50_000
export const SEARCH_MATCHES = 200
const SEARCH_FILES = 20_000
const SEARCH_FILE_MAX_BYTES = 1024 * 1024
const SEARCH_MAX_MS = 10_000
const MATCH_LINE_CHARS = 300
/** A NUL among the first bytes marks a file as binary, as grep decides. */
const BINARY_PROBE = 8192

/**
 * Names a session's file tools never write, as a part of any path: what the sandbox denies its commands anywhere
 * (sandbox-runtime's mandatory denies: shell startup files, git's own config, editor settings, .mcp.json), and .git
 * whole (the sandbox denies only its hooks, config and modules; a file tool has no business there at all, and `.git`
 * as a file is the gitfile trick: a config elsewhere naming a hooks path the user's own git would run). Denied
 * anywhere in the absolute path, as the sandbox anchors them at /, so a folder chosen inside one changes nothing.
 */
const DENIED_NAMES = new Set([
  '.git',
  '.vscode',
  '.idea',
  '.gitconfig',
  '.gitmodules',
  '.bashrc',
  '.bash_profile',
  '.zshrc',
  '.zprofile',
  '.profile',
  '.ripgreprc',
  '.mcp.json'
])
const DENIED_PAIRS = [
  ['.claude', 'commands'],
  ['.claude', 'agents']
]
/**
 * A name as the file system compares it: APFS ignores case and, more broadly than toLowerCase, folds letters like
 * the long s (ſ) to s and the Kelvin sign to k, so .vſcode is .vscode; HFS+ ignores zero-width and direction marks in
 * a name, as git learned (CVE-2014-9390; the set is git's). Folding more than either does costs nothing here.
 */
const fold = (name: string): string =>
  name
    .replace(/[\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF]/g, '')
    .normalize('NFKC')
    .toUpperCase()
    .toLowerCase()

/** A file tool's refusal: `reason` is short, for the card; the message says what to do instead, for the model. */
export class Refused extends Error {
  constructor(
    readonly reason: string,
    message: string
  ) {
    super(message)
  }
}

interface Located {
  /** The path relative to the folder, normalised, for messages and events. */
  rel: string
  /** The path as given, made absolute. */
  full: string
  /** The real path, inside the folder; for a path that doesn't exist yet, its deepest existing folder's real path and the rest. */
  real: string
  /** What is at the path itself now (by lstat, so a link shows as one), or null when nothing is. */
  target: Stats | null
}

const inside = (path: string, root: string): boolean => path === root || path.startsWith(root + sep)

/**
 * Where `given` is, inside the folder at `root` (a real path), or a refusal. The deepest part that exists is taken by
 * its real path and must be inside the folder; what's below it doesn't exist yet.
 */
export async function locate(root: string, given: unknown): Promise<Located> {
  if (typeof given !== 'string' || !given.trim()) throw new Refused('no path', 'Give the path of a file, relative to the folder.')
  if (given.includes('\0')) throw new Refused('bad path', 'The path has a NUL character in it.')
  const full = resolve(root, given)
  if (!inside(full, root)) throw new Refused('outside the folder', `${given} is outside the folder ${root}. Paths must stay inside it.`)
  const rel = relative(root, full)
  const rest: string[] = []
  let existing = full
  let found = await lstat(existing).catch(() => null)
  while (!found && existing !== root) {
    rest.unshift(basename(existing))
    existing = dirname(existing)
    found = await lstat(existing).catch(() => null)
  }
  if (!found) throw new Refused('not found', `The folder ${root} can’t be read.`)
  const realExisting = await realpath(existing).catch(() => null)
  if (!realExisting) throw new Refused('broken link', `${rel} is a link that leads nowhere.`)
  if (!inside(realExisting, root))
    throw new Refused('outside the folder', `${rel} leads outside the folder through a link. Paths must stay inside it.`)
  return { rel, full, real: join(realExisting, ...rest), target: rest.length ? null : found }
}

/** Why a write to `located` is refused (see DENIED_NAMES), or null. Both the path as given and the real one are checked. */
function writeRefusal(located: Located): Refused | null {
  for (const path of [located.full, located.real]) {
    const parts = path.split(sep).map(fold)
    for (let i = 0; i < parts.length; i++) {
      if (parts[i] === '.git')
        return new Refused(
          'read-only',
          `Can’t write ${located.rel}: .git is off limits to a session’s file tools. Use git commands for what the sandbox allows.`
        )
      const denied = DENIED_NAMES.has(parts[i]) ? parts[i] : DENIED_PAIRS.find(([a, b]) => parts[i] === a && parts[i + 1] === b)?.join('/')
      if (denied)
        return new Refused('read-only', `Can’t write ${located.rel}: ${denied} is read-only for a session, as it is for its commands.`)
    }
  }
  if (located.target?.isSymbolicLink()) return new Refused('is a link', `${located.rel} is a link. Write to what it points at instead.`)
  if (located.target?.isDirectory()) return new Refused('is a folder', `${located.rel} is a folder.`)
  if (located.target && !located.target.isFile()) return new Refused('not a regular file', `${located.rel} is not a regular file.`)
  return null
}

const isBinary = (buffer: Buffer): boolean => buffer.subarray(0, BINARY_PROBE).includes(0)
/** A byte order mark is part of the text here: an edit must write it back. */
const strictUtf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })

/**
 * The text of the file at a located path (a regular file, not too big, not binary), or a refusal. A read decodes
 * leniently; an edit or a write (`strict`) refuses a file that isn't UTF-8, which it would otherwise write back changed.
 */
async function readText(located: Located, maxBytes: number, what: string, strict = false): Promise<string> {
  if (!located.target) throw new Refused('not found', `There is no file at ${located.rel}.`)
  const s = located.target.isSymbolicLink() ? await stat(located.real).catch(() => null) : located.target
  if (!s) throw new Refused('broken link', `${located.rel} is a link that leads nowhere.`)
  if (s.isDirectory()) throw new Refused('is a folder', `${located.rel} is a folder. Use list_files to see what's in it.`)
  if (s.size > maxBytes)
    throw new Refused(
      'too large',
      `${located.rel} is ${Math.round(s.size / 1024)} KB, too large ${what}. Use run_command (head, sed -n, grep) instead.`
    )
  const file = await openNoLinks(located.real)
  if (!file) throw new Refused('not a file', `${located.rel} is not a regular file.`)
  try {
    const buffer = await file.handle.readFile()
    if (isBinary(buffer)) throw new Refused('binary file', `${located.rel} is a binary file.`)
    if (!strict) return buffer.toString('utf8')
    try {
      return strictUtf8.decode(buffer)
    } catch {
      throw new Refused(
        'not UTF-8 text',
        `${located.rel} isn’t UTF-8 text, so Ollmost can’t change it without garbling it. Use run_command (iconv, sed) instead.`
      )
    }
  } finally {
    await file.handle.close()
  }
}

const cutLine = (line: string, max: number): string => (line.length > max ? `${line.slice(0, max)}…` : line)

/** A file's lines: a final newline ends the last line rather than starting an empty one. */
function splitLines(text: string): string[] {
  const lines = text.split('\n')
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop()
  return text === '' ? [] : lines
}

export interface ReadResult {
  rel: string
  /** The numbered lines, cut to the character budget. */
  text: string
  /** The range shown, 1-based and inclusive; from 1 to 0 for an empty file. */
  from: number
  to: number
  total: number
}

/**
 * Lines `offset` (1-based) onwards of a text file, `limit` of them at most (READ_LINES by default), numbered, within
 * `maxChars` (at least one line is given).
 */
export function readFile(
  ws: Workspace,
  path: unknown,
  opts: { offset?: number; limit?: number; maxChars?: number } = {}
): Promise<ReadResult> {
  return readyForSession(ws, async (root) => {
    const located = await locate(root, path)
    const lines = splitLines(await readText(located, READ_MAX_BYTES, 'to read at once'))
    const total = lines.length
    const from = Math.max(1, Math.floor(opts.offset ?? 1))
    if (total === 0) return { rel: located.rel, text: '', from: 1, to: 0, total }
    if (from > total) throw new Refused('offset past the end', `${located.rel} has ${total} lines; offset ${from} is past its end.`)
    const limit = Math.max(1, Math.floor(opts.limit ?? READ_LINES))
    const maxChars = opts.maxChars ?? Number.POSITIVE_INFINITY
    const out: string[] = []
    let chars = 0
    let to = from - 1
    for (let n = from; n < from + limit && n <= total; n++) {
      const line = `${String(n).padStart(6)}\t${cutLine(lines[n - 1], LINE_MAX_CHARS)}`
      if (out.length && chars + 1 + line.length > maxChars) break
      chars += (out.length ? 1 : 0) + line.length
      out.push(line)
      to = n
    }
    return { rel: located.rel, text: out.join('\n'), from, to, total }
  })
}

export interface ListResult {
  rel: string
  files: string[]
  cut: boolean
  /** Which limit cut the listing: the result limit, the visit limit or the time limit. */
  stopped?: 'limit' | 'visits' | 'time'
}

/** The files under `path` (the folder itself when absent) matching `pattern`, as git sees them, up to LIST_LIMIT. */
export function listFiles(ws: Workspace, opts: { pattern?: string; path?: unknown }): Promise<ListResult> {
  return readyForSession(ws, async (root) => {
    checkGlob(opts.pattern)
    const start = await folderIn(root, opts.path)
    const walk = await walkFiles(root, {
      start: start.walkFrom,
      glob: opts.pattern || undefined,
      limit: LIST_LIMIT,
      visitLimit: LIST_VISIT_LIMIT
    })
    return { rel: start.rel, ...walk }
  })
}

/** A listing as the model reads it: the paths, or that there were none, and which limit stopped it. */
export function listingText(r: ListResult, pattern?: string): string {
  const where = r.rel ? ` in ${r.rel}` : ''
  const body = r.files.length
    ? r.files.join('\n')
    : `No files${pattern ? ` match ${pattern}` : ''}${where} (what .gitignore ignores, and .git, are left out; run_command with ls sees everything).`
  const note =
    r.stopped === 'limit'
      ? `\n[… the list stops at ${LIST_LIMIT} files; narrow the pattern or the folder]`
      : r.stopped === 'visits'
        ? '\n[… the folder holds more entries than a listing looks at; narrow the folder]'
        : r.stopped === 'time'
          ? '\n[… the listing stopped at its time limit; narrow the folder]'
          : ''
  return `${body}${note}`
}

function checkGlob(glob: string | undefined): void {
  if (glob && glob.length > GLOB_MAX_CHARS) throw new Refused('pattern too long', `The glob is over ${GLOB_MAX_CHARS} characters.`)
}

/**
 * `given` located (see locate), and what is there by what a link leads to (locate found that inside the folder), or
 * null when nothing is.
 */
async function locateFollowed(root: string, given: unknown): Promise<{ located: Located; stats: Stats | null }> {
  const located = await locate(root, given)
  return { located, stats: located.target && (await stat(located.real).catch(() => null)) }
}

/** A folder to walk from: the root itself when `path` is absent; a real folder inside it otherwise. */
async function folderIn(root: string, path: unknown): Promise<{ rel: string; walkFrom: string }> {
  if (path === undefined || path === null || path === '') return { rel: '', walkFrom: '' }
  const { located, stats } = await locateFollowed(root, path)
  if (!stats) throw new Refused('not found', `There is no folder at ${located.rel}.`)
  if (!stats.isDirectory()) throw new Refused('not a folder', `${located.rel} is not a folder.`)
  return { rel: located.rel, walkFrom: relative(root, located.real) }
}

/**
 * Whether `path` in the session's folder is a folder, by what a link there leads to, without reading it; null when
 * nothing is there. Refuses as locate does: a path outside the folder, or a link that leaves it or leads nowhere.
 */
export function pathKind(ws: Workspace, path: unknown): Promise<{ rel: string; folder: boolean } | null> {
  return readyForSession(ws, async (root) => {
    const { located, stats } = await locateFollowed(root, path)
    return stats && { rel: located.rel, folder: stats.isDirectory() }
  })
}

export interface SearchResult {
  rel: string
  /** `path:line: text`, one per match. */
  lines: string[]
  matches: number
  files: number
  /** Why the search stopped early, if it did. */
  cut: string | null
}

/**
 * Lines matching `pattern` (a JavaScript regular expression) in the text files under `path`, those matching `glob`
 * only when given, up to SEARCH_MATCHES matches. Files over 1 MB and binary files are skipped. The matching runs in
 * a worker thread that is ended at the deadline (`maxMs`, for tests): a pattern that backtracks badly would
 * otherwise freeze the app.
 */
export async function searchFiles(
  ws: Workspace,
  opts: { pattern: unknown; path?: unknown; glob?: string; maxMs?: number; signal?: AbortSignal }
): Promise<SearchResult> {
  if (typeof opts.pattern !== 'string' || !opts.pattern) throw new Refused('no pattern', 'Give a regular expression to search for.')
  const pattern = opts.pattern
  try {
    new RegExp(pattern)
  } catch (err) {
    throw new Refused('invalid pattern', `Not a valid regular expression: ${err instanceof Error ? err.message : String(err)}`)
  }
  return readyForSession(ws, async (root) => {
    checkGlob(opts.glob)
    const start = await folderIn(root, opts.path)
    const maxMs = opts.maxMs ?? SEARCH_MAX_MS
    const began = Date.now()
    // The walk and the matching share the deadline; the walk gets at most half, so some files always get searched.
    const walk = await walkFiles(root, {
      start: start.walkFrom,
      glob: opts.glob || undefined,
      limit: SEARCH_FILES,
      visitLimit: LIST_VISIT_LIMIT,
      maxMs: Math.ceil(maxMs / 2)
    })
    // A stop while the walk ran: nothing was listening for it yet.
    opts.signal?.throwIfAborted()
    const left = Math.max(1, maxMs - (Date.now() - began))
    const found = await searchInWorker(root, walk.files, pattern, left, opts.signal)
    opts.signal?.throwIfAborted()
    const looked =
      walk.stopped === 'time'
        ? 'the folder holds more files than the search could look at in time; narrow the folder'
        : walk.stopped === 'visits'
          ? 'the folder holds more entries than a search looks at; narrow the folder'
          : walk.stopped === 'limit'
            ? `not every file was looked at (the search covers ${SEARCH_FILES} files at most)`
            : null
    const cut = found.timedOut
      ? `the search stopped after ${maxMs / 1000} seconds${looked ? `; ${looked}` : ''}`
      : found.capped
        ? `the search stopped at ${SEARCH_MATCHES} matches`
        : looked
    return { rel: start.rel, lines: found.lines, matches: found.lines.length, files: found.files, cut }
  })
}

/** Run the search worker over `files` (real paths under `root`), ending it after `maxMs` or when the reply stops. */
function searchInWorker(
  root: string,
  files: string[],
  pattern: string,
  maxMs: number,
  signal?: AbortSignal
): Promise<{ lines: string[]; files: number; capped: boolean; timedOut: boolean }> {
  return new Promise((resolve, reject) => {
    const lines: string[] = []
    let hits = 0
    let capped = false
    let done = false
    const worker = new Worker(searchWorker, {
      eval: true,
      workerData: {
        root,
        files,
        pattern,
        maxBytes: SEARCH_FILE_MAX_BYTES,
        maxMatches: SEARCH_MATCHES,
        maxLineChars: MATCH_LINE_CHARS,
        binaryProbe: BINARY_PROBE
      }
    })
    const end = () => void worker.terminate()
    const timer = setTimeout(end, maxMs)
    signal?.addEventListener('abort', end, { once: true })
    worker.on('message', (m: { file?: string; lines?: string[]; done?: boolean; cut?: boolean }) => {
      if (m.lines) {
        lines.push(...m.lines)
        hits++
      }
      if (m.done) {
        done = true
        capped = !!m.cut
      }
    })
    worker.on('error', (err) => {
      clearTimeout(timer)
      reject(err)
    })
    worker.on('exit', () => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', end)
      resolve({ lines, files: hits, capped, timedOut: !done })
    })
  })
}

export interface Change {
  rel: string
  /** A unified diff of the change (cut at 100 KB), with `--- /dev/null` for a new file. */
  diff: string
  added: number
  removed: number
  /** The file's size after the change, in bytes. */
  size: number
  created: boolean
}

/**
 * A unified diff of `before` to `after` for the file at `rel`, and its counts. A diff that would take too long or
 * change too many lines (a whole file rewritten) is shown as every line replaced, which is what it amounts to.
 */
export function unifiedDiff(
  rel: string,
  before: string | null,
  after: string,
  limits: { timeout?: number; maxEditLength?: number } = { timeout: DIFF_MAX_MS, maxEditLength: DIFF_MAX_EDITS }
): Pick<Change, 'diff' | 'added' | 'removed'> {
  const oldName = before === null ? '/dev/null' : `a/${rel}`
  const newName = `b/${rel}`
  const patch = structuredPatch(oldName, newName, before ?? '', after, undefined, undefined, { context: 3, ...limits })
  const hunks = patch ? patch.hunks : [wholeReplacement(before ?? '', after)]
  const out = [`--- ${oldName}`, `+++ ${newName}`]
  let added = 0
  let removed = 0
  for (const hunk of hunks) {
    // As git writes an empty side (a new or emptied file): from line 0, not 1.
    const at = (start: number, lines: number) => (lines === 0 ? '0,0' : `${start},${lines}`)
    out.push(`@@ -${at(hunk.oldStart, hunk.oldLines)} +${at(hunk.newStart, hunk.newLines)} @@`)
    for (const line of hunk.lines) {
      if (line.startsWith('+')) added++
      else if (line.startsWith('-')) removed++
      out.push(line)
    }
  }
  const diff = out.join('\n')
  return { diff: diff.length > DIFF_MAX_CHARS ? `${diff.slice(0, DIFF_MAX_CHARS)}\n[… the diff was cut here]` : diff, added, removed }
}

/** One hunk that removes every old line and adds every new one, marking a missing final newline as a diff does. */
function wholeReplacement(before: string, after: string) {
  const oldLines = splitLines(before)
  const newLines = splitLines(after)
  const side = (lines: string[], sign: string, text: string) =>
    lines.length && !text.endsWith('\n') ? [...lines.map((l) => sign + l), '\\ No newline at end of file'] : lines.map((l) => sign + l)
  return {
    oldStart: 1,
    oldLines: oldLines.length,
    newStart: 1,
    newLines: newLines.length,
    lines: [...side(oldLines, '-', before), ...side(newLines, '+', after)]
  }
}

interface Planned {
  located: Located
  before: string | null
  after: string
}

/** What edit_file would do: the file's text before and after, or a refusal. */
async function planEdit(root: string, args: EditArgs): Promise<Planned> {
  const located = await locate(root, args.path)
  const refused = writeRefusal(located)
  if (refused) throw refused
  const { oldString, newString } = args
  if (typeof oldString !== 'string' || typeof newString !== 'string')
    throw new Refused('bad arguments', 'edit_file needs old_string and new_string.')
  if (!oldString) throw new Refused('empty old_string', 'old_string is empty. To create a file or rewrite it whole, use write_file.')
  if (oldString === newString) throw new Refused('no change', 'old_string and new_string are the same.')
  const before = await readText(located, EDIT_MAX_BYTES, 'to edit here', true)
  // A model writes bare line breaks; when the passage isn't found as written and the file has CR LF line breaks,
  // that is what it meant (a file with both kinds is tried as written first).
  let [oldText, newText] = [oldString, newString]
  let count = before.split(oldText).length - 1
  if (count === 0 && before.includes('\r\n') && !oldString.includes('\r') && !newString.includes('\r')) {
    ;[oldText, newText] = [oldString.replace(/\n/g, '\r\n'), newString.replace(/\n/g, '\r\n')]
    count = before.split(oldText).length - 1
  }
  if (count === 0)
    throw new Refused(
      'old_string not found',
      `old_string was not found in ${located.rel}. Read the file and copy the passage exactly, whitespace included.`
    )
  if (count > 1 && !args.replaceAll)
    throw new Refused(
      `old_string appears ${count} times`,
      `old_string appears ${count} times in ${located.rel}. Include more of the surrounding lines to make it unique, or set replace_all.`
    )
  // A function replacement: a $ in new_string means nothing special.
  const after = args.replaceAll ? before.split(oldText).join(newText) : before.replace(oldText, () => newText)
  return { located, before, after }
}

/** What write_file would do, or a refusal. */
async function planWrite(root: string, args: WriteArgs): Promise<Planned> {
  const located = await locate(root, args.path)
  const refused = writeRefusal(located)
  if (refused) throw refused
  if (typeof args.content !== 'string') throw new Refused('bad arguments', 'write_file needs the content to write.')
  if (Buffer.byteLength(args.content) > EDIT_MAX_BYTES)
    throw new Refused('too large', `The content is over ${EDIT_MAX_BYTES / 1024 / 1024} MB. Write it in parts with run_command.`)
  const before = located.target ? await readText(located, EDIT_MAX_BYTES, 'to replace here', true) : null
  return { located, before, after: args.content }
}

/** Write the planned text: in place when the file exists (its mode kept), as a new file (with its folders) otherwise. */
async function apply(plan: Planned): Promise<Change> {
  const { located, before, after } = plan
  const change = unifiedDiff(located.rel, before, after)
  if (before === null) await mkdir(dirname(located.real), { recursive: true })
  // By the real path, with no link anywhere in it; a new file must not have appeared meanwhile.
  const flags = (before === null ? constants.O_CREAT | constants.O_EXCL : constants.O_TRUNC) | constants.O_WRONLY | NO_LINKS
  const handle = await open(located.real, flags, 0o644)
  try {
    await handle.writeFile(after, 'utf8')
  } finally {
    await handle.close()
  }
  return { rel: located.rel, ...change, size: Buffer.byteLength(after), created: before === null }
}

export interface EditArgs {
  path: unknown
  oldString: unknown
  newString: unknown
  replaceAll?: boolean
}
export interface WriteArgs {
  path: unknown
  content: unknown
}

/** Replace one exact passage of a text file (every occurrence with `replaceAll`). */
export async function editFile(ws: Workspace, args: EditArgs): Promise<Change> {
  try {
    return await readyForSession(ws, async (root) => apply(await planEdit(root, args)))
  } finally {
    // The @ menu's list may no longer be what's there (#129), even after a write that failed partway.
    dropSessionPaths(ws.key)
  }
}

/** Write a whole text file, creating it and its folders, or replacing it. */
export async function writeFile(ws: Workspace, args: WriteArgs): Promise<Change> {
  try {
    return await readyForSession(ws, async (root) => apply(await planWrite(root, args)))
  } finally {
    dropSessionPaths(ws.key)
  }
}

/** The diff edit_file would make, for the approval that asks first. Throws what the edit would. */
export const editDiff = (ws: Workspace, args: EditArgs): Promise<string> =>
  readyForSession(ws, async (root) => {
    const plan = await planEdit(root, args)
    return unifiedDiff(plan.located.rel, plan.before, plan.after).diff
  })

/** The diff write_file would make, as editDiff. */
export const writeDiff = (ws: Workspace, args: WriteArgs): Promise<string> =>
  readyForSession(ws, async (root) => {
    const plan = await planWrite(root, args)
    return unifiedDiff(plan.located.rel, plan.before, plan.after).diff
  })
