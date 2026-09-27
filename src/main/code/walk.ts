import { lstat, readdir } from 'node:fs/promises'
import { isAbsolute, join, normalize, sep } from 'node:path'
import ignore, { type Ignore } from 'ignore'
import { openNoLinks } from '../runner/workspace'

// The files in a code session's folder as git would see them, for the tools that list and search it (#91). Those run
// outside the sandbox, in a folder session code can write, so the walk follows no link: it goes by what a folder's
// listing says each entry is (a stat would follow a link) and enters only real folders, so all it reports lies under
// the root. The caller holds the session's lock, so no session code can swap a folder for a link while it walks. Only
// the .gitignore files in the folder are read, not .git/info/exclude or the user's global excludes.

const VISIT_LIMIT = 50_000
/** A walk stops after this long: every entry is tested against every rule above it, on the main thread. */
const WALK_MAX_MS = 5000
/** Entries between two turns given back to the event loop, so the app draws and answers meanwhile. */
const YIELD_EVERY = 500
/** A .gitignore is read up to this size: its rules are tested against every entry below it. */
const IGNORE_BYTES = 32 * 1024

export interface WalkOptions {
  /** A folder to start in, relative to the root; '' or absent for the root itself. */
  start?: string
  /** A glob the root-relative path of a file must match (see matchesGlob); every file when absent. */
  glob?: string
  /** At most this many files in the result. */
  limit: number
  /** Stop looking after this many entries (files and folders together) have been seen. Default 50_000. */
  visitLimit?: number
  /** Stop looking after this many milliseconds. Default 5000. */
  maxMs?: number
}

export interface Walk {
  /** Root-relative paths, '/'-separated, in walk order. */
  files: string[]
  /** The walk stopped early (a limit was reached), so the result may be incomplete. */
  cut: boolean
  /** Which limit stopped it: the result limit, the visit limit or the time limit. */
  stopped?: 'limit' | 'visits' | 'time'
}

/** A folder's .gitignore rules, and the folder they're relative to (root-relative with a trailing '/', '' for the root). */
interface Rules {
  base: string
  ig: Ignore
}

/**
 * The files under a session's folder as git would see them: depth first, each folder's entries in code-point order of
 * their names (a folder's contents right after it), no .git folder entered, nothing a .gitignore ignores, and only
 * regular files and folders (a link, a pipe or a socket is neither listed nor entered). `root` is an absolute real
 * path. Throws when `start` is outside the root or isn't a folder there; a folder that can't be read is left out.
 */
export async function walkFiles(root: string, opts: WalkOptions): Promise<Walk> {
  const start = startOf(opts.start)
  const above = await rulesAbove(root, start)
  const matches = opts.glob ? globMatcher(opts.glob) : null
  const visitLimit = opts.visitLimit ?? VISIT_LIMIT
  const deadline = Date.now() + (opts.maxMs ?? WALK_MAX_MS)
  const files: string[] = []
  let seen = 0
  let stopped: Walk['stopped']

  const enter = async (dir: string, rules: Rules[]): Promise<void> => {
    const entries = await readdir(join(root, dir), { withFileTypes: true }).catch(() => null)
    if (!entries) return
    if (entries.some((e) => e.name === '.gitignore')) {
      const ig = await readRules(join(root, dir))
      if (ig) rules = [...rules, { base: dir && `${dir}/`, ig }]
    }
    for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
      // Checked before taking the next entry, not after the last one taken: a walk with nothing left isn't cut.
      stopped = files.length >= opts.limit ? 'limit' : seen >= visitLimit ? 'visits' : Date.now() > deadline ? 'time' : undefined
      if (stopped) return
      if (++seen % YIELD_EVERY === 0) await new Promise((resolve) => setImmediate(resolve))
      // A repository's own folder (a submodule has one too), or the .git file of a worktree.
      if (entry.name === '.git') continue
      const path = `${dir && `${dir}/`}${entry.name}`
      if (entry.isDirectory()) {
        if (!ignored(rules, `${path}/`)) await enter(path, rules)
        if (stopped) return
      } else if (entry.isFile() && (!matches || matches(path)) && !ignored(rules, path)) {
        files.push(path)
      }
    }
  }

  await enter(start, above)
  return stopped ? { files, cut: true, stopped } : { files, cut: false }
}

/** `start` as a root-relative folder, '/'-separated ('' for the root). Throws when it would leave the root. */
function startOf(start = ''): string {
  const rel = normalize(start || '.')
  if (isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`)) throw new Error(`${start} is outside the folder`)
  return rel
    .split(sep)
    .filter((part) => part !== '' && part !== '.')
    .join('/')
}

/**
 * The rules of the .gitignore files above `start`, from the root down. Every folder on the way, `start` included, must
 * be a folder and not a link: lstat follows a link anywhere but at the end of a path, so each is checked in turn.
 */
async function rulesAbove(root: string, start: string): Promise<Rules[]> {
  const parts = start ? start.split('/') : []
  const rules: Rules[] = []
  for (let i = 0; i <= parts.length; i++) {
    const rel = parts.slice(0, i).join('/')
    const info = await lstat(join(root, rel)).catch(() => null)
    const problem = !info
      ? "doesn't exist"
      : info.isSymbolicLink()
        ? 'is a link, not a folder'
        : info.isFile()
          ? 'is a file, not a folder'
          : !info.isDirectory()
            ? 'is not a folder'
            : null
    if (problem) throw new Error(`${rel || 'The folder'} ${problem}`)
    if (i === parts.length) break
    const ig = await readRules(join(root, rel))
    if (ig) rules.push({ base: rel && `${rel}/`, ig })
  }
  return rules
}

/** The rules in `dir`'s .gitignore, or null when there's none to read as a plain file (missing, a link, a pipe). */
async function readRules(dir: string): Promise<Ignore | null> {
  const file = await openNoLinks(join(dir, '.gitignore'))
  if (!file) return null
  try {
    const { size } = await file.handle.stat()
    const buffer = Buffer.alloc(Math.min(size, IGNORE_BYTES))
    const { bytesRead } = await file.handle.read(buffer, 0, buffer.length, 0)
    const text = buffer.toString('utf8', 0, bytesRead)
    // Of a larger file only the first 32 KB, less the rule it cuts in two.
    return ignore().add(size <= IGNORE_BYTES ? text : text.slice(0, text.lastIndexOf('\n') + 1))
  } catch {
    return null
  } finally {
    await file.handle.close()
  }
}

/**
 * Whether the .gitignore rules ignore `path` (root-relative; a folder's with a trailing '/'), each file's tested
 * relative to its own folder, the root's first. The first that ignores a path decides, so a deeper `!` only brings
 * back what its own file ignored. Git also lets it bring back a path a shallower .gitignore ignored (as long as no
 * folder above it is ignored); that case is rare enough to go without.
 */
function ignored(rules: Rules[], path: string): boolean {
  return rules.some((r) => r.ig.ignores(path.slice(r.base.length)))
}

/**
 * Whether `path` (root-relative, '/'-separated) matches `pattern`: `*` is any run of characters in a segment (a leading
 * dot too), `?` one character in a segment, `**` as a whole segment zero or more segments (anywhere else, two `*`),
 * `{a,b}` either alternative (groups don't nest), and everything else literal. A pattern with no '/' matches a file's name in any folder;
 * one starting with './' or '/' is taken from the root, as in git (the prefix dropped). Matched without a RegExp,
 * whose backtracking a pattern like `*a*a*a*a*b` makes take seconds on a long name, on the main thread.
 */
export function matchesGlob(pattern: string, path: string): boolean {
  return globMatcher(pattern)(path)
}

/** The test matchesGlob makes, with the pattern taken apart once for a whole walk. */
function globMatcher(pattern: string): (path: string) => boolean {
  const rooted = /^\.?\//.test(pattern)
  let glob = pattern.replace(/^\.?\//, '')
  if (!rooted && !glob.includes('/')) glob = `**/${glob}`
  // Two '**' segments in a row match what one does.
  const alternatives = expandBraces(glob).map((a) => a.split('/').filter((s, i, all) => s !== '**' || all[i - 1] !== '**'))
  return (path) => {
    const parts = path.split('/')
    return alternatives.some((segments) => matchSegments(segments, parts))
  }
}

/** At most this many patterns from one glob's {…} groups; the rest of the alternatives are dropped. */
const MAX_ALTERNATIVES = 100

/** The brace-free patterns a glob stands for: `{a,b}/x` is `a/x` and `b/x`. A '{' with no '}' after it is literal. */
function expandBraces(glob: string): string[] {
  const open = glob.indexOf('{')
  const close = open === -1 ? -1 : glob.indexOf('}', open)
  if (close === -1) return [glob]
  const out: string[] = []
  // Checked before each alternative is expanded, or every group would double the work before the cap could act.
  for (const alternative of glob.slice(open + 1, close).split(',')) {
    if (out.length >= MAX_ALTERNATIVES) break
    for (const rest of expandBraces(glob.slice(0, open) + alternative + glob.slice(close + 1))) {
      if (out.length >= MAX_ALTERNATIVES) break
      out.push(rest)
    }
  }
  return out
}

/**
 * Whether the path's parts match the pattern's segments, a '**' segment taking any number of parts. Each (segment,
 * part) pair is tried once, so the work is bounded by their product however many '**' the pattern has.
 */
function matchSegments(segments: string[], parts: string[]): boolean {
  const failed = new Set<number>()
  const from = (i: number, j: number): boolean => {
    const key = i * (parts.length + 1) + j
    if (failed.has(key)) return false
    let ok: boolean
    if (i === segments.length) ok = j === parts.length
    else if (segments[i] === '**') {
      ok = false
      for (let k = j; k <= parts.length && !ok; k++) ok = from(i + 1, k)
    } else ok = j < parts.length && matchName(segments[i], parts[j]) && from(i + 1, j + 1)
    if (!ok) failed.add(key)
    return ok
  }
  return from(0, 0)
}

/**
 * Whether one name matches one segment: `*` any run of characters, `?` one character (a whole one: an emoji is one),
 * anything else itself. The usual wildcard walk: on a mismatch, the last `*` takes one more character. Never worse
 * than the pattern's length times the name's.
 */
function matchName(segment: string, name: string): boolean {
  const pat = Array.from(segment)
  const chars = Array.from(name)
  let p = 0
  let n = 0
  let starP = -1
  let starN = 0
  while (n < chars.length) {
    if (p < pat.length && (pat[p] === '?' || pat[p] === chars[n])) {
      p++
      n++
    } else if (p < pat.length && pat[p] === '*') {
      starP = p++
      starN = n
    } else if (starP !== -1) {
      p = starP + 1
      n = ++starN
    } else return false
  }
  while (p < pat.length && pat[p] === '*') p++
  return p === pat.length
}
