import { withChildEvents } from './toolEvents'
import type { Message, MessageReference, SessionPaths } from './types'

// Typing @ in a code session's composer (#129). The composer and main share these, so what the composer marks is what
// a reply reads: a token is an @ at the start of the text or after whitespace, outside code fences, up to the next
// whitespace, without closing punctuation.

/** An @ token: `start` is at the "@", `end` past the path; `path` has no "@" and no closing punctuation. */
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

/** Punctuation that ends a sentence or closes a bracket, never the end of a path someone meant. */
const TRAILING = /[.,;:!?)\]}>"'`]+$/
/** A path segment starts after one of these, for the fuzzy rank. */
const SEPARATORS = '/._-'

/** "./src/a.ts" and "src/a.ts" are one path. */
export const normalizeAtPath = (path: string): string => path.replace(/^(\.\/)+/, '')

/** Where code fences are, as [start, end] ranges; an unclosed fence runs to the end. */
function fences(text: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = []
  let open = -1
  let at = 0
  for (const line of text.split('\n')) {
    if (line.trimStart().startsWith('```')) {
      if (open < 0) open = at
      else {
        ranges.push([open, at + line.length])
        open = -1
      }
    }
    at += line.length + 1
  }
  if (open >= 0) ranges.push([open, text.length])
  return ranges
}

const inFence = (ranges: ReadonlyArray<[number, number]>, i: number): boolean => ranges.some(([a, b]) => i >= a && i <= b)

/** Every @ token in `text`. A path with spaces isn't supported: the token stops at the space. */
export function findAtTokens(text: string): AtToken[] {
  const ranges = fences(text)
  const tokens: AtToken[] = []
  for (const m of text.matchAll(/(^|\s)@(\S+)/g)) {
    const start = (m.index ?? 0) + m[1].length
    const path = m[2].replace(TRAILING, '')
    if (path && !inFence(ranges, start)) tokens.push({ start, end: start + 1 + path.length, path })
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

/** The query's letters in order, each run starting a path segment (mcf → main/code/files). */
function segmentHits(s: string, q: string): number[] | null {
  const hits: number[] = []
  let i = 0
  while (i < s.length && hits.length < q.length) {
    const starts = (i === 0 || SEPARATORS.includes(s[i - 1])) && !SEPARATORS.includes(s[i])
    if (starts && s[i] === q[hits.length]) {
      while (i < s.length && hits.length < q.length && s[i] === q[hits.length]) hits.push(i++)
    } else i++
  }
  return hits.length === q.length ? hits : null
}

/**
 * How `query` matches `path`, ignoring case: 1, the name starts with it; 2, the name contains it; 3, the path contains
 * it; 4, its letters in order across path segments. Null when it doesn't match.
 */
export function atMatch(path: string, query: string): { rank: number; hits: number[] } | null {
  const q = query.toLowerCase()
  const bare = (path.endsWith('/') ? path.slice(0, -1) : path).toLowerCase()
  const nameAt = bare.lastIndexOf('/') + 1
  const name = bare.slice(nameAt)
  const run = (from: number) => Array.from({ length: q.length }, (_, k) => from + k)
  if (name.startsWith(q)) return { rank: 1, hits: run(nameAt) }
  const inName = name.indexOf(q)
  if (inName >= 0) return { rank: 2, hits: run(nameAt + inName) }
  const inPath = bare.indexOf(q)
  if (inPath >= 0) return { rank: 3, hits: run(inPath) }
  const fuzzy = segmentHits(bare, q)
  return fuzzy ? { rank: 4, hits: fuzzy } : null
}

function row(path: string, hits: number[], touched: AtRow['touched']): AtRow {
  const folder = path.endsWith('/')
  const bare = folder ? path.slice(0, -1) : path
  const cut = bare.lastIndexOf('/')
  return { path, name: `${bare.slice(cut + 1)}${folder ? '/' : ''}`, dir: cut >= 0 ? bare.slice(0, cut) : '', folder, hits, touched }
}

const byCodePoint = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)

/**
 * The menu's rows for `query`: by rank, then the files this session touched, then shorter paths. A bare @ lists the
 * touched files, most recent first, or, before the session has touched any, the folder's top level, folders first.
 */
export function atRows(
  paths: readonly string[],
  query: string,
  touched: readonly TouchedPath[]
): { heading: string | null; rows: AtRow[] } {
  const how = new Map(touched.map((t) => [t.path, t.how]))
  if (!query) {
    const listed = new Set(paths)
    const recent = touched.filter((t) => listed.has(t.path))
    if (recent.length) return { heading: 'Recent in this session', rows: recent.slice(0, AT_ROWS).map((t) => row(t.path, [], t.how)) }
    const top = paths
      .filter((p) => !p.slice(0, -1).includes('/'))
      .sort((a, b) => Number(b.endsWith('/')) - Number(a.endsWith('/')) || byCodePoint(a, b))
    return { heading: 'In this folder', rows: top.slice(0, AT_ROWS).map((p) => row(p, [], how.get(p) ?? null)) }
  }
  const found: Array<{ path: string; rank: number; hits: number[]; touched: AtRow['touched'] }> = []
  for (const path of paths) {
    const m = atMatch(path, query)
    if (m) found.push({ path, ...m, touched: how.get(path) ?? null })
  }
  found.sort(
    (a, b) => a.rank - b.rank || Number(!a.touched) - Number(!b.touched) || a.path.length - b.path.length || byCodePoint(a.path, b.path)
  )
  return { heading: null, rows: found.slice(0, AT_ROWS).map((f) => row(f.path, f.hits, f.touched)) }
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
  return listed.has(p) || (!p.endsWith('/') && listed.has(`${p}/`))
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
