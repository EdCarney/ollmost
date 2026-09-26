import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { validateRoot } from '../src/main/runner/root'

// Which folders a code session may work in (#86). A home and a data folder made under a temp folder stand in for the
// real ones, which a test can't change. A temp folder's path has a link in it on a Mac (/var is /private/var), so
// what's picked and the real path it gives are told apart.

const real = (path: string) => realpathSync.native(path)
const picked = mkdtempSync(join(tmpdir(), 'ollmost-root-'))
const base = real(picked)
const home = join(base, 'home')
const data = join(base, 'data')
for (const dir of [
  'work',
  'a[b]c',
  'a*b',
  'a?b',
  'dotfiles/config',
  'dotfiles/other',
  'home/Desktop/project',
  'home/Documents',
  'home/Downloads',
  'home/Library/x',
  'home/.ssh/keys',
  'data/workspaces',
  'tools/bin/sub',
  'tools/Cellar/python/bin',
  'tools/opt/python',
  'tools/share',
  'home/.nvm/versions/node',
  'home/go/src/project',
  'home/go/bin',
  'home/bin',
  'home/opt/project',
  'home/py/lib/python3',
  'home/projects/x'
])
  mkdirSync(join(base, dir), { recursive: true })
writeFileSync(join(base, 'file.txt'), 'x')
writeFileSync(join(base, 'tools', 'Cellar', 'python', 'bin', 'python3'), '#!/bin/sh\n')
mkdirSync(join(base, 'tools', 'Homebrew', 'bin'), { recursive: true })
mkdirSync(join(base, 'tools', 'Homebrew', 'Library'), { recursive: true })
writeFileSync(join(base, 'tools', 'Homebrew', 'bin', 'brew'), '#!/bin/sh\n')
symlinkSync(join(base, 'tools', 'Homebrew', 'bin', 'brew'), join(base, 'tools', 'bin', 'brew'))
mkdirSync(join(home, 'py', 'bin'), { recursive: true })
writeFileSync(join(home, 'py', 'bin', 'python3'), '#!/bin/sh\n')
symlinkSync(join(base, 'work'), join(base, 'link'))
symlinkSync(home, join(base, 'home-link'))
symlinkSync(join(home, '.ssh', 'keys'), join(base, 'keys-link'))
// As a dotfile manager leaves it: the folder is elsewhere, and a link to it in the home folder.
symlinkSync(join(base, 'dotfiles', 'config'), join(home, '.config'))
// A folder inside a refused system folder: /tmp is /private/tmp.
const inTmp = mkdtempSync('/tmp/ollmost-root-')
afterAll(() => {
  rmSync(base, { recursive: true, force: true })
  rmSync(inTmp, { recursive: true, force: true })
})

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
  '/etc',
  // The same folders by another spelling.
  '/tmp',
  '/var/folders',
  '/var'
]

/** The home and data folders as real paths, and given through a link (the temp folder's /var spelling). */
/** A PATH with a folder of programs under the test's base folder, so a root holding it can be refused. */
const path = `${join(base, 'tools', 'bin')}:${join(home, 'bin')}:/usr/bin:/bin`
/** The python3 Ollmost runs, as Homebrew lays it out: the PATH folder's link leads into the Cellar. */
const python = join(base, 'tools', 'Cellar', 'python', 'bin', 'python3')
const ENVS = [
  ['given as real paths', { home, data, path, python }],
  ['given through a link', { home: join(picked, 'home'), data: join(picked, 'data'), path, python }]
] as const

describe.each(ENVS)('the folder a code session works in, with the home and data folders %s', (_, env) => {
  it.each([
    ['a folder, as its real path', join(picked, 'work'), join(base, 'work')],
    ['a folder given with a trailing slash, as its real path', `${join(base, 'work')}/`, join(base, 'work')],
    ['a link to a folder, as the folder', join(base, 'link'), join(base, 'work')],
    ['a folder inside the Desktop', join(home, 'Desktop', 'project'), join(home, 'Desktop', 'project')],
    ['a folder inside a folder of programs on the PATH', join(base, 'tools', 'bin', 'sub'), join(base, 'tools', 'bin', 'sub')],
    ['a folder beside Homebrew’s Cellar that holds no programs', join(base, 'tools', 'share'), join(base, 'tools', 'share')],
    ['a Go project in the old GOPATH layout', join(home, 'go', 'src', 'project'), join(home, 'go', 'src', 'project')],
    ['~/opt/project, though ~/bin is on the PATH (it isn’t Homebrew)', join(home, 'opt', 'project'), join(home, 'opt', 'project')],
    ['a folder inside a refused system folder', inTmp, real(inTmp)],
    ['a folder beside the one a linked .config leads to', join(base, 'dotfiles', 'other'), join(base, 'dotfiles', 'other')]
  ])('may be %s', async (_, folder, expected) => {
    expect(await validateRoot(folder, env)).toBe(expected)
  })

  it.each([
    ['the home folder', home, /home folder itself/],
    ['the home folder, with a trailing slash', `${home}/`, /home folder itself/],
    ['the home folder, by a path with ..', `${home}/Desktop/..`, /home folder itself/],
    ['a link to the home folder', join(base, 'home-link'), /home folder itself/],
    ['a folder holding a folder of programs on the PATH', join(base, 'tools'), /programs on your PATH/],
    ['a folder of programs on the PATH itself', join(base, 'tools', 'bin'), /programs on your PATH/],
    ['Homebrew’s Cellar beside its bin', join(base, 'tools', 'Cellar'), /holds programs/],
    ['a folder inside that Cellar', join(base, 'tools', 'Cellar', 'python'), /holds programs/],
    ['Homebrew’s opt beside its bin', join(base, 'tools', 'opt', 'python'), /holds programs/],
    ['Homebrew’s own code, in the folder above its real brew', join(base, 'tools', 'Homebrew', 'Library'), /holds programs/],
    ['a folder inside a toolchain install', join(home, '.nvm', 'versions'), /holds programs/],
    ['Go’s bin folder', join(home, 'go', 'bin'), /holds programs/],
    ['the Go folder, which holds its bin', join(home, 'go'), /holds programs/],
    ['the Desktop', join(home, 'Desktop'), /whole Desktop/],
    ['the Documents folder', join(home, 'Documents'), /whole Documents/],
    ['the Downloads folder', join(home, 'Downloads'), /whole Downloads/],
    ['a folder in Library', join(home, 'Library', 'x'), /Library/],
    ['a folder of keys', join(home, '.ssh'), /your \.ssh folder/],
    ['a folder inside a folder of keys', join(home, '.ssh', 'keys'), /your \.ssh folder/],
    ['a link to a folder inside a folder of keys', join(base, 'keys-link'), /your \.ssh folder/],
    ['where a linked .config leads', join(base, 'dotfiles', 'config'), /your \.config folder/],
    ['the folder holding where a linked .config leads', join(base, 'dotfiles'), /holds your \.config folder/],
    ['the data folder', data, /Ollmost.s own/],
    ['a folder in the data folder', join(data, 'workspaces'), /Ollmost.s own/],
    ['the folder the data folder is in', base, /keeps its own files/],
    ['a folder with [ or ] in its path', join(base, 'a[b]c'), /Rename/],
    ['a folder with * in its path', join(base, 'a*b'), /Rename/],
    ['a folder with ? in its path', join(base, 'a?b'), /Rename/],
    ['a path with NUL in it', `${base}/work\0`, /Rename/],
    ['a file', join(base, 'file.txt'), /isn.t a folder/],
    ['a missing folder', join(base, 'missing'), /find/],
    ['a relative path', 'work', /full path/]
  ])('isn’t %s', async (_, folder, message) => {
    await expect(validateRoot(folder, env)).rejects.toThrow(message)
  })

  it('isn’t inside the Python install Ollmost’s python3 belongs to, wherever that is', async () => {
    const python = join(home, 'py', 'bin', 'python3')
    await expect(validateRoot(join(home, 'py', 'lib', 'python3'), { ...env, python })).rejects.toThrow(/holds programs/)
    await expect(validateRoot(join(home, 'py'), { ...env, python })).rejects.toThrow(/holds programs/)
    // No python3 at all (the runner is unavailable then): nothing extra is refused.
    expect(await validateRoot(join(home, 'py', 'lib', 'python3'), { ...env, python: null })).toBe(join(home, 'py', 'lib', 'python3'))
    // A python3 that's a plain file in ~/bin has no install around it: the home folder must not become one.
    writeFileSync(join(home, 'bin', 'python3'), '#!/bin/sh\n')
    expect(await validateRoot(join(home, 'projects', 'x'), { ...env, python: join(home, 'bin', 'python3') })).toBe(
      join(home, 'projects', 'x')
    )
  })

  // Only on a Mac: /var and /tmp are aliases of /private/… there, and elsewhere the test's data folder sits under /tmp.
  it.runIf(process.platform === 'darwin')('isn’t a folder of the system’s itself, however it’s spelled', async () => {
    for (const dir of SYSTEM_FOLDERS.filter((d) => existsSync(d))) await expect(validateRoot(dir, env), dir).rejects.toThrow(/itself/)
  })

  it.runIf(existsSync(home.toUpperCase()))('isn’t the home folder spelled in other letters, where case doesn’t count', async () => {
    await expect(validateRoot(home.toUpperCase(), env)).rejects.toThrow(/home folder itself/)
  })

  // Second paths macOS gives folders, which realpath leaves as they are: a refused folder is known by its identity,
  // and any other folder is to be chosen by its usual path.
  for (const prefix of ['/System/Volumes/Data', '/.nofollow'])
    it.runIf(existsSync(`${prefix}${home}`))(`isn’t reached through ${prefix}`, async () => {
      const cases: Array<[string, RegExp]> = [
        [`${prefix}${home}`, /home folder itself/],
        [`${prefix}${home}/.ssh`, /your \.ssh folder/],
        [`${prefix}${data}`, /Ollmost.s own/],
        [`${prefix}${base}`, /keeps its own files/],
        [`${prefix}${base}/work`, /usual path/],
        [prefix, /usual path/]
      ]
      for (const [folder, message] of cases) await expect(validateRoot(folder, env), folder).rejects.toThrow(message)
    })
})

describe('the folder a code session works in', () => {
  it.runIf(existsSync('/System/Volumes/Data'))('isn’t a new folder reached through /System/Volumes/Data', async () => {
    const dir = real(mkdtempSync(join(tmpdir(), 'ollmost-root-firmlink-')))
    try {
      expect(await validateRoot(dir, { home, data })).toBe(dir)
      await expect(validateRoot(`/System/Volumes/Data${dir}`, { home, data })).rejects.toThrow(/usual path/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('can’t be checked before the data folder is known', async () => {
    await expect(validateRoot(join(base, 'work'), { home, data: '' })).rejects.toThrow(/data folder/)
  })
})
