import { withChildEvents } from './toolEvents'
import type { Message, MessageReference, SessionPaths } from './types'

// Typing @ in a code session's composer (#129). The composer and main share these, so what the composer marks is what
// a reply reads: a token is an @ at the start of the text or after whitespace, outside code fences, up to the next
// whitespace, without the punctuation after it, naming a path that stays inside the session's folder.

/** An @ token: `start` is at the "@", `end` past the path; `path` as typed, less the "@" and any punctuation after. */
export interface AtToken {
  start: number
  end: number
  path: string
}

/** A row of the @ menu. */
export interface AtRow {
  /** Relative to the session's folder; a folder's ends in "/". */
  path: string
  /** The last part of the path, a folder's with its "/". */
  name: string
  /** The folders above it ("src/main"), "" at the top. */
  dir: string
  folder: boolean
  /** Indices into `path` of the characters the query matched. */
  hits: number[]
  touched: 'edited' | 'read' | null
}

/** A file this session read or edited. */
export interface TouchedPath {
  path: string
  how: 'edited' | 'read'
}

/** The most rows the menu shows. */
export const AT_ROWS = 50

/** Punctuation that ends a sentence or a quote, never the end of a path someone meant. */
const TRAILING = '.,;:!?>"\'`'
/** A closing bracket the path didn't open ends it: "@app/(auth)" keeps its ")"; "(see @a.ts)" doesn't. */
const OPENERS: Record<string, string | undefined> = { ')': '(', ']': '[', '}': '{' }
/** A path segment starts after one of these, for the fuzzy rank. */
const SEPARATORS = '/._-'
/** A line that opens a code fence: three or more backticks, none later in the line (```a``` is inline), or tildes. */
const FENCE_OPEN = /^\s*(`{3,}(?=[^`]*$)|~{3,})/
/** A line that can close one: nothing but a run of backticks or tildes. */
const FENCE_CLOSE = /^\s*(`{3,}|~{3,})\s*$/

/**
 * One spelling per path: "./src/a.ts", "src//a.ts" and "src/./a.ts" are all "src/a.ts", and "./" and "." are "", the
 * folder itself. A leading "/" and any ".." stay, so a caller can tell a path that leaves the folder.
 */
export function normalizeAtPath(path: string): string {
  const segments = path.split('/')
  const kept = segments.filter((s) => s && s !== '.')
  const lead = path.startsWith('/') ? '/' : ''
  if (!kept.length) return lead
  const last = segments[segments.length - 1]
  return `${lead}${kept.join('/')}${last === '' || last === '.' ? '/' : ''}`
}

/** A path that starts outside the folder or climbs out of it: never a reference, so it stays plain text. */
function leaves(path: string): boolean {
  const p = normalizeAtPath(path)
  return p.startsWith('/') || p.startsWith('~') || p.split('/').includes('..')
}

/**
 * Where code fences are, as [start, end] ranges. A fence closes on a line of its own character, at least as many as
 * opened it (CommonMark's rule); an unclosed fence runs to the end.
 */
function fences(text: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = []
  let open: { at: number; fence: string } | null = null
  let at = 0
  for (const line of text.split('\n')) {
    if (!open) {
      const m = FENCE_OPEN.exec(line)
      if (m) open = { at, fence: m[1] }
    } else {
      const m = FENCE_CLOSE.exec(line)
      if (m && m[1][0] === open.fence[0] && m[1].length >= open.fence.length) {
        ranges.push([open.at, at + line.length])
        open = null
      }
    }
    at += line.length + 1
  }
  if (open) ranges.push([open.at, text.length])
  return ranges
}

const inFence = (ranges: ReadonlyArray<[number, number]>, i: number): boolean => ranges.some(([a, b]) => i >= a && i <= b)

const occurrences = (s: string, ch: string): number => s.split(ch).length - 1

/** A token's text without the punctuation after it: a sentence's, and any closing bracket the path didn't open. */
function trimEnd(text: string): string {
  let path = text
  while (path) {
    const last = path[path.length - 1]
    const opener = OPENERS[last]
    const unopened = opener !== undefined && occurrences(path, last) > occurrences(path, opener)
    if (!TRAILING.includes(last) && !unopened) break
    path = path.slice(0, -1)
  }
  return path
}

/**
 * Every @ token in `text`. A path with spaces isn't supported: the token stops at the space. A path that starts at "/"
 * or "~", or has a ".." in it, isn't a token.
 */
export function findAtTokens(text: string): AtToken[] {
  const ranges = fences(text)
  const tokens: AtToken[] = []
  for (const m of text.matchAll(/(^|\s)@(\S+)/g)) {
    const start = (m.index ?? 0) + m[1].length
    const path = trimEnd(m[2])
    // The text as typed is checked too, so "@src/.." isn't read as "@src/" once its dots are taken for a full stop.
    if (!path || inFence(ranges, start) || leaves(path) || leaves(m[2])) continue
    tokens.push({ start, end: start + 1 + path.length, path })
  }
  return tokens
}

/** The @ being typed at the caret, for the menu: where its "@" is and what follows it so far. */
export function atQueryAt(text: string, caret: number): { start: number; query: string } | null {
  const m = /(^|\s)@(\S*)$/.exec(text.slice(0, caret))
  if (!m) return null
  const start = m.index + m[1].length
  return inFence(fences(text), start) ? null : { start, query: m[2] }
}

/** Put "@path " where the typed @ and the rest of its word were, and the caret after it. */
export function insertAtPath(text: string, caret: number, at: { start: number }, path: string): { text: string; caret: number } {
  const head = `${text.slice(0, at.start)}@${path} `
  const tail = text.slice(caret).replace(/^\S*/, '').replace(/^ /, '')
  return { text: head + tail, caret: head.length }
}

/**
 * `s` in lower case, keeping any character whose lower case is longer ("İ" is "i̇", two code units), so an index into
 * it is an index into `s`. No character's lower case is shorter, so one the same length as `s` lines up with it.
 */
function lower(s: string): string {
  const whole = s.toLowerCase()
  if (whole.length === s.length) return whole
  let out = ''
  for (const ch of s) {
    const l = ch.toLowerCase()
    out += l.length === ch.length ? l : ch
  }
  return out
}

const startsSegment = (s: string, i: number): boolean => (i === 0 || SEPARATORS.includes(s[i - 1])) && !SEPARATORS.includes(s[i])

/**
 * The query's letters in order, in runs that each start a path segment (mcf → main/code/files). A run takes as much of
 * the query as it can, and gives some back when a later segment needs it (mac → main/access).
 */
function segmentHits(s: string, q: string): number[] | null {
  // Most paths don't have the query's letters in order at all, which is quick to see.
  let seen = -1
  for (const ch of q) {
    seen = s.indexOf(ch, seen + 1)
    if (seen < 0) return null
  }
  // Where the rest of the query can't be found, so no other way of getting there looks again.
  let failed: Set<number> | undefined
  const from = (i: number, k: number): number[] | null => {
    if (k === q.length) return []
    if (failed?.has(i * q.length + k)) return null
    for (let at = i; at < s.length; at++) {
      if (s[at] !== q[k] || !startsSegment(s, at)) continue
      let n = 1
      while (k + n < q.length && s[at + n] === q[k + n]) n++
      for (; n > 0; n--) {
        const rest = from(at + n, k + n)
        if (rest) return [...Array.from({ length: n }, (_, j) => at + j), ...rest]
      }
    }
    failed ??= new Set()
    failed.add(i * q.length + k)
    return null
  }
  return from(0, 0)
}

/** A path ready to match: its lower case (see `lower`) without a folder's "/", and where its name starts in that. */
interface Entry {
  path: string
  lower: string
  nameAt: number
}

function entry(path: string): Entry {
  const bare = lower(path.endsWith('/') ? path.slice(0, -1) : path)
  return { path, lower: bare, nameAt: bare.lastIndexOf('/') + 1 }
}

/** Each list's entries, made once, since the menu matches the same list at every keystroke: a list is never edited. */
const entries = new WeakMap<readonly string[], Entry[]>()

/** `paths` ready to match, less any with a space: its token would stop at the space, so choosing it names another. */
function entriesOf(paths: readonly string[]): Entry[] {
  let list = entries.get(paths)
  if (!list) {
    list = paths.filter((p) => !/\s/.test(p)).map(entry)
    entries.set(paths, list)
  }
  return list
}

/** How the lower-cased query `q` matches `e`, see atMatch; null too when its rank would be worse than `worst`. */
function matchEntry(e: Entry, q: string, worst = 4): { rank: number; hits: number[] } | null {
  const run = (from: number) => Array.from({ length: q.length }, (_, k) => from + k)
  const inName = e.lower.indexOf(q, e.nameAt)
  if (inName === e.nameAt) return { rank: 1, hits: run(inName) }
  if (inName >= 0) return { rank: 2, hits: run(inName) }
  const inPath = worst >= 3 ? e.lower.indexOf(q) : -1
  if (inPath >= 0) return { rank: 3, hits: run(inPath) }
  const fuzzy = worst >= 4 ? segmentHits(e.lower, q) : null
  return fuzzy ? { rank: 4, hits: fuzzy } : null
}

/**
 * How `query` matches `path`, ignoring case: 1, the name starts with it; 2, the name contains it; 3, the path contains
 * it; 4, its letters in order across path segments. Null when it doesn't match.
 */
export function atMatch(path: string, query: string): { rank: number; hits: number[] } | null {
  return matchEntry(entry(path), lower(query))
}

function row(path: string, hits: number[], touched: AtRow['touched']): AtRow {
  const folder = path.endsWith('/')
  const bare = folder ? path.slice(0, -1) : path
  const cut = bare.lastIndexOf('/')
  return { path, name: `${bare.slice(cut + 1)}${folder ? '/' : ''}`, dir: cut >= 0 ? bare.slice(0, cut) : '', folder, hits, touched }
}

const byCodePoint = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)

type Found = { path: string; rank: number; hits: number[]; touched: AtRow['touched'] }

const byRow = (a: Found, b: Found): number =>
  a.rank - b.rank || Number(!a.touched) - Number(!b.touched) || a.path.length - b.path.length || byCodePoint(a.path, b.path)

/**
 * The menu's rows for `query`: by rank, then the files this session touched, then shorter paths. A bare @ lists the
 * touched files, most recent first, or, before the session has touched any, the folder's top level, folders first. A
 * query with a "/" is a path, so "./src" is "src" and "./" is a bare @.
 */
export function atRows(
  paths: readonly string[],
  query: string,
  touched: readonly TouchedPath[]
): { heading: string | null; rows: AtRow[] } {
  const list = entriesOf(paths)
  const how = new Map(touched.map((t) => [t.path, t.how]))
  const q = lower(query.includes('/') ? normalizeAtPath(query) : query)
  if (!q) {
    const listed = new Set(list.map((e) => e.path))
    const recent = touched.filter((t) => listed.has(t.path))
    if (recent.length) return { heading: 'Recent in this session', rows: recent.slice(0, AT_ROWS).map((t) => row(t.path, [], t.how)) }
    const top = list
      .filter((e) => e.nameAt === 0)
      .map((e) => e.path)
      .sort((a, b) => Number(b.endsWith('/')) - Number(a.endsWith('/')) || byCodePoint(a, b))
    return { heading: 'In this folder', rows: top.slice(0, AT_ROWS).map((p) => row(p, [], how.get(p) ?? null)) }
  }
  // Only the best AT_ROWS are kept, in order, rather than sorting every match: in a large folder most never show. Once
  // they're all better than a fuzzy match, no path is tried for one.
  const best: Found[] = []
  for (const e of list) {
    const m = matchEntry(e, q, best.length === AT_ROWS ? best[AT_ROWS - 1].rank : 4)
    if (!m) continue
    const found = { path: e.path, ...m, touched: how.get(e.path) ?? null }
    if (best.length === AT_ROWS && byRow(found, best[AT_ROWS - 1]) >= 0) continue
    let at = best.length
    while (at > 0 && byRow(found, best[at - 1]) < 0) at--
    best.splice(at, 0, found)
    if (best.length > AT_ROWS) best.pop()
  }
  return { heading: null, rows: best.map((f) => row(f.path, f.hits, f.touched)) }
}

const FILE_TOOLS: Record<string, TouchedPath['how'] | undefined> = { read_file: 'read', edit_file: 'edited', write_file: 'edited' }

/** The files a session's replies read or edited (its sub-agents' too), most recent first; an edit outranks a read. */
export function touchedPaths(messages: ReadonlyArray<Pick<Message, 'toolEvents'>>): TouchedPath[] {
  const how = new Map<string, TouchedPath['how']>()
  for (const e of withChildEvents(messages.flatMap((m) => m.toolEvents)).reverse()) {
    const kind = FILE_TOOLS[e.tool]
    if (!kind || !e.ok || e.pending || e.awaiting || e.declined) continue
    const path = normalizeAtPath(e.files?.[0]?.path ?? (typeof e.args.path === 'string' ? e.args.path : ''))
    if (path) how.set(path, how.get(path) === 'edited' ? 'edited' : kind)
  }
  return [...how].map(([path, h]) => ({ path, how: h }))
}

const names = (path: string, listed: ReadonlySet<string>): boolean => {
  const p = normalizeAtPath(path)
  // "" is the folder itself ("@./"), which is always there.
  return p === '' || listed.has(p) || (!p.endsWith('/') && listed.has(`${p}/`))
}

/** The composer's marks: the tokens that name a listed file or folder. */
export function markedTokens(text: string, listed: ReadonlySet<string>): AtToken[] {
  return findAtTokens(text).filter((t) => names(t.path, listed))
}

/** A sent message's marks: the tokens that were read and sent. */
export function referenceMarks(text: string, references: readonly MessageReference[]): AtToken[] {
  return findAtTokens(text).filter((t) => references.some((r) => r.tokens.includes(t.path)))
}

/** `text` in its marked and plain parts, in order; `marks` in the order findAtTokens gives them. */
export function splitMarked(text: string, marks: readonly AtToken[]): Array<{ text: string; marked: boolean }> {
  const parts: Array<{ text: string; marked: boolean }> = []
  let at = 0
  for (const m of marks) {
    if (m.start > at) parts.push({ text: text.slice(at, m.start), marked: false })
    parts.push({ text: text.slice(m.start, m.end), marked: true })
    at = m.end
  }
  if (at < text.length) parts.push({ text: text.slice(at), marked: false })
  return parts
}

/** `text` (which starts at `offset` in a path) in runs of the characters the query matched and those it didn't. */
export function hitRuns(text: string, hits: readonly number[], offset: number): Array<{ text: string; hit: boolean }> {
  const runs: Array<{ text: string; hit: boolean }> = []
  for (let i = 0; i < text.length; i++) {
    const hit = hits.includes(i + offset)
    const last = runs[runs.length - 1]
    if (last && last.hit === hit) last.text += text[i]
    else runs.push({ text: text[i], hit })
  }
  return runs
}

const count = (n: number): string => n.toLocaleString('en-US')

/** What a reference's chip says after its path: how much was sent, or why none was. Null when all of it was. */
export function referenceNote(ref: MessageReference): string | null {
  if (ref.refused) return `not sent: ${ref.refused}`
  if (ref.lines && ref.lines.to < ref.lines.total)
    return `lines ${count(ref.lines.from)}–${count(ref.lines.to)} of ${count(ref.lines.total)}`
  if (ref.cut) return 'listing cut'
  return null
}

/** The menu's footer: why the list is partial or empty. Null when it's whole. */
export function atFooter(list: SessionPaths): string | null {
  if (list.busy) return "Files can't be listed while a command runs."
  if (!list.cut) return null
  return `Showing matches from the first ${count(list.paths.filter((p) => !p.endsWith('/')).length)} files`
}
