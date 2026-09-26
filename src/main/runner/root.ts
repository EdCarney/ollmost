import { readdir, realpath, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { delimiter, dirname, isAbsolute, join, relative, sep } from 'node:path'
import { TOOLCHAIN_ROOTS } from '../code/policy'
import { childPath } from '../env'
import { paths } from '../paths'
import { findPython } from './python'

// A code session works in a folder of the user's, and its commands may change anything there. So some folders are
// refused: ones too broad to hand over (the whole disk, the home folder, the Desktop), ones other apps rely on
// (Library, the folders of keys and tokens in the home folder), and any that holds Ollmost's own data, which a session
// there could rewrite. Every check is on real paths: the sandbox and the reaper match real paths, a link to a refused
// folder is that folder, and /etc is really /private/etc. macOS also gives folders second paths that realpath leaves
// as they are (/System/Volumes/Data/Users/<you> is the home folder, and so is /.nofollow/Users/<you>), so folders are
// compared by identity too (device and inode, which every path to a folder shares), and those paths are refused.

/** Refused as a session's folder itself; a folder inside one is fine. */
const SYSTEM_FOLDERS = [
  '/',
  '/Users',
  '/Users/Shared',
  '/Volumes',
  '/private/tmp',
  '/private/var/folders',
  '/private/var',
  '/System',
  '/Library',
  '/Applications',
  '/private',
  '/usr',
  '/opt',
  '/etc'
]
/** Refused as a session's folder itself too, in the home folder. */
const HOME_FOLDERS = ['Desktop', 'Documents', 'Downloads']
/** Folders in the home folder holding keys, tokens or settings: refused, with every folder inside them and above them. */
const CREDENTIAL_FOLDERS = [
  '.ssh',
  '.aws',
  '.gnupg',
  '.docker',
  '.kube',
  '.azure',
  '.ollama',
  '.claude',
  '.codex',
  '.gemini',
  '.cargo',
  '.npm',
  '.config'
]
/** Where every firmlink's second path is (/System/Volumes/Data/Users is /Users). */
const FIRMLINKS = '/System/Volumes'

/**
 * Where a toolchain root keeps its programs, when that isn't the whole root: a project in ~/go/src (the old GOPATH
 * layout) holds nothing that runs. The other roots hold only installs.
 */
const INSTALLS_IN: Record<string, string[]> = { go: ['bin', 'pkg'] }

/** The sandbox (@anthropic-ai/sandbox-runtime) reads a path with any of these as a pattern, so it can't be given one. */
const PATTERN_CHARS = /[*?[\]\0]/
const PATTERN_REFUSAL = 'Ollmost can’t run commands in a folder whose path has *, ?, [ or ] in it. Rename the folder, or choose another.'

/** A path as written and as its real path: the same, unless there's a link in it. A missing folder is only as written. */
async function spellings(path: string): Promise<string[]> {
  const real = await realpath(path).catch(() => path)
  return real === path ? [path] : [path, real]
}

/** Whether `path` is `dir` or inside it. */
function within(path: string, dir: string): boolean {
  const rel = relative(dir, path)
  return rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)
}

/** `path` and every folder above it, up to `/`. */
function withParents(path: string): string[] {
  const all = [path]
  for (let p = path; dirname(p) !== p; p = dirname(p)) all.push(dirname(p))
  return all
}

interface Identity {
  dev: bigint
  ino: bigint
}
/** What every path to a folder shares, or null when it's missing. As bigints: an inode can be past 2^53. */
const identity = (path: string): Promise<Identity | null> =>
  stat(path, { bigint: true }).then(
    (s) => ({ dev: s.dev, ino: s.ino }),
    () => null
  )
const same = (a: Identity | null, b: Identity | null): boolean => !!a && !!b && a.dev === b.dev && a.ino === b.ino

/**
 * The real path of a folder a code session may work in. Throws with the reason, for the user, when it's not a folder,
 * or it's one Ollmost won't work in (see above). `home` and `data` stand in for the home and data folders in tests.
 */
export async function validateRoot(
  picked: string,
  env: { home?: string; data?: string; path?: string; python?: string | null } = {}
): Promise<string> {
  const data = env.data ?? paths.data
  // Without it, a folder holding Ollmost's database couldn't be refused.
  if (!data) throw new Error('Ollmost can’t check a folder before it knows its own data folder.')
  if (typeof picked !== 'string' || !isAbsolute(picked)) throw new Error(`Ollmost needs the full path of a folder, not “${picked}”.`)
  if (picked.includes('\0')) throw new Error(PATTERN_REFUSAL)
  const real = await realpath(picked).catch(() => null)
  if (!real) throw new Error(`Ollmost can’t find a folder at ${picked}.`)
  if (!(await stat(real).catch(() => null))?.isDirectory())
    throw new Error(`${picked} isn’t a folder. Choose a folder for Ollmost to work in.`)
  const programs = {
    path: env.path ?? (await childPath()),
    python: env.python === undefined ? ((await findPython())?.path ?? null) : env.python
  }
  const refused = await refusal(real, env.home ?? homedir(), data, programs)
  if (refused) throw new Error(refused)
  // After the rules above, which name a folder refused wherever it's reached from, and before the one below, so a
  // folder reached this way isn't said to need a new name.
  const second = secondPath(real)
  if (second) throw new Error(`Ollmost can’t work in a folder reached through ${second}. Choose the folder by its usual path instead.`)
  if (PATTERN_CHARS.test(real)) throw new Error(PATTERN_REFUSAL)
  return real
}

/** Where `real` is one of the second paths macOS gives folders: under /System/Volumes, or /.nofollow, /.vol and the like. */
function secondPath(real: string): string | null {
  if (within(real, FIRMLINKS)) return FIRMLINKS
  const first = real.split(sep)[1]
  return first?.startsWith('.') ? `/${first}` : null
}

/** Why Ollmost won't work in the folder at `real` (a real path), or null when it will. */
async function refusal(
  real: string,
  home: string,
  data: string,
  programs: { path: string; python: string | null }
): Promise<string | null> {
  // The folder's identity, then each folder's above it.
  const chain = await Promise.all(withParents(real).map(identity))
  /** Whether the folder is `dir`. */
  const is = async (dir: string) => (await spellings(dir)).includes(real) || same(chain[0], await identity(dir))
  /** Whether the folder is `dir` or inside it. */
  const under = async (dir: string) => {
    if ((await spellings(dir)).some((d) => within(real, d))) return true
    const id = await identity(dir)
    return chain.some((c) => same(c, id))
  }
  /** Whether the folder is `dir` or above it. */
  const holds = async (dir: string) => {
    const ways = await spellings(dir)
    if (ways.some((d) => within(d, real))) return true
    const above = await Promise.all(ways.flatMap(withParents).map(identity))
    return above.some((id) => same(chain[0], id))
  }

  if (await is(home)) return 'Ollmost can’t work in your home folder itself. Choose a folder inside it.'
  for (const name of HOME_FOLDERS)
    if (await is(join(home, name))) return `Ollmost can’t work in your whole ${name} folder. Choose a folder inside it.`
  for (const dir of SYSTEM_FOLDERS) if (await is(dir)) return `Ollmost can’t work in ${real} itself. Choose a folder inside it.`
  if (await under(data)) return 'That folder is Ollmost’s own: it holds its database and chats. Choose a folder of yours.'
  if (await holds(data))
    return `Ollmost keeps its own files (its database and chats) inside ${real}, so it can’t work there. Choose another folder.`
  if (await under(join(home, 'Library')))
    return 'Ollmost can’t work in your Library folder, where apps keep their settings and data. Choose a folder of your own.'
  for (const name of CREDENTIAL_FOLDERS) {
    if (await under(join(home, name)))
      return `Ollmost can’t work in your ${name} folder, which holds keys or settings other apps rely on. Choose another folder.`
    // A link (dotfile managers make ~/.config one): the folder holding where it leads holds it too.
    if (await holds(join(home, name)))
      return `Ollmost can’t work in ${real}: it holds your ${name} folder, with keys or settings other apps rely on. Choose another folder.`
  }
  // Programs that run outside the sandbox (Ollmost's own python3, whatever the user runs) must be out of a session's
  // reach: the folders on the PATH, and where their programs really are, which a PATH folder's links only point at:
  // the toolchain installs in the home folder, Homebrew's Cellar and opt beside its bin, and the Python install
  // Ollmost's python3 belongs to. A folder inside one of those, or holding one, is refused.
  const pathFolders = programs.path.split(delimiter).filter(isAbsolute)
  for (const dir of pathFolders)
    if (await holds(dir))
      return `Ollmost can’t work in ${real}: it holds ${dir}, a folder of programs on your PATH, which Ollmost and other apps run. Choose another folder.`
  const installs = TOOLCHAIN_ROOTS.flatMap((rel) => (INSTALLS_IN[rel] ?? ['']).map((sub) => join(home, rel, sub)))
  for (const dir of pathFolders) {
    const prefix = dirname(dir)
    const brew = join(prefix, 'bin', 'brew')
    if (await exists(brew)) {
      // Its kegs, its links, and its own code: the folder two above the real brew (the prefix itself on Apple silicon,
      // <prefix>/Homebrew on Intel Macs).
      const repository = dirname(dirname(await realpath(brew).catch(() => brew)))
      installs.push(join(prefix, 'Cellar'), join(prefix, 'opt'), repository)
    }
  }
  if (programs.python) {
    // Its install: two folders up from the real binary (<prefix>/bin/python3), when that looks like one (it has a
    // lib/python3.x): a python3 that is a plain file in ~/bin would otherwise make the home folder the install.
    const prefix = dirname(dirname(await realpath(programs.python).catch(() => programs.python!)))
    const lib = await readdir(join(prefix, 'lib')).catch(() => [] as string[])
    const isHome = (await spellings(home)).includes(prefix) || within(home, prefix)
    if (lib.some((name) => name.startsWith('python3')) && !SYSTEM_FOLDERS.includes(prefix) && !isHome) installs.push(prefix)
  }
  for (const dir of installs) {
    if (await under(dir))
      return `Ollmost can’t work in ${real}: it’s inside ${dir}, which holds programs Ollmost and other apps run. Choose another folder.`
    if (await holds(dir))
      return `Ollmost can’t work in ${real}: it holds ${dir}, which holds programs Ollmost and other apps run. Choose another folder.`
  }
  return null
}

const exists = (path: string): Promise<boolean> =>
  stat(path).then(
    () => true,
    () => false
  )
