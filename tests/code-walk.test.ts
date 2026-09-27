import { execFileSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { matchesGlob, walkFiles } from '../src/main/code/walk'

// The files of a code session's folder as git would see them, for list_files and search_files (#91). The walk runs
// outside the sandbox, so it must never follow a link: what it reports lies under the root.

/**
 * A temp folder holding `files` (a relative path and its contents; a path ending in '/' is an empty folder), removed
 * after the describe it's made in. A real path: on a Mac the temp folder is under /var, a link.
 */
function tree(files: Record<string, string> = {}): string {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'ollmost-walk-')))
  afterAll(() => rmSync(root, { recursive: true, force: true }))
  for (const [rel, text] of Object.entries(files)) {
    if (rel.endsWith('/')) {
      mkdirSync(join(root, rel), { recursive: true })
    } else {
      mkdirSync(dirname(join(root, rel)), { recursive: true })
      writeFileSync(join(root, rel), text)
    }
  }
  return root
}

const LIMIT = 1000

describe('walkFiles: order', () => {
  const root = tree({
    'b.txt': '',
    'a/z.txt': '',
    'a/b/c.txt': '',
    'a/a.txt': '',
    'a-b.txt': '',
    'a.txt': '',
    'Z.txt': '',
    '_x.txt': '',
    '9.txt': '',
    '10.txt': '',
    'c/d.txt': '',
    'ж.txt': '',
    'empty/': ''
  })

  it('goes depth first, each folder in code-point order of its names, its contents right after it', async () => {
    expect(await walkFiles(root, { limit: LIMIT })).toEqual({
      files: ['10.txt', '9.txt', 'Z.txt', '_x.txt', 'a/a.txt', 'a/b/c.txt', 'a/z.txt', 'a-b.txt', 'a.txt', 'b.txt', 'c/d.txt', 'ж.txt'],
      cut: false
    })
  })
})

describe('walkFiles: .git', () => {
  const root = tree({
    '.git/HEAD': 'ref: refs/heads/main\n',
    '.git/config': '',
    '.github/ci.yml': '',
    'sub/.git/HEAD': 'ref: refs/heads/main\n',
    'sub/x.ts': '',
    'worktree/.git': 'gitdir: elsewhere\n',
    'worktree/y.ts': ''
  })

  it('never enters a .git folder, at the root or in a submodule, and never lists a .git file', async () => {
    expect((await walkFiles(root, { limit: LIMIT })).files).toEqual(['.github/ci.yml', 'sub/x.ts', 'worktree/y.ts'])
  })
})

describe('walkFiles: .gitignore', () => {
  const root = tree({
    '.gitignore': 'dist/\n*.log\n',
    'app.log': '',
    'dist/bundle.js': '',
    'dist/assets/logo.svg': '',
    'generated.ts': '',
    'rules.txt': '*\n',
    'src/.gitignore': 'generated.ts\n/local.ts\n*.tmp\n!keep.tmp\n',
    'src/a.ts': '',
    'src/debug.log': '',
    'src/deep/generated.ts': '',
    'src/deep/local.ts': '',
    'src/generated.ts': '',
    'src/keep.tmp': '',
    'src/local.ts': '',
    'src/scratch.tmp': '',
    'linked/a.ts': '',
    'z.ts': ''
  })
  // A .gitignore that's a link to a file ignoring everything: it isn't read, and isn't listed either.
  symlinkSync(join(root, 'rules.txt'), join(root, 'linked', '.gitignore'))

  const expected = [
    '.gitignore',
    'generated.ts',
    'linked/a.ts',
    'rules.txt',
    'src/.gitignore',
    'src/a.ts',
    'src/deep/local.ts',
    'src/keep.tmp',
    'z.ts'
  ]

  it('leaves out what the root’s and a folder’s own .gitignore ignore, each relative to its folder', async () => {
    expect(await walkFiles(root, { limit: LIMIT })).toEqual({ files: expected, cut: false })
  })

  it('doesn’t enter an ignored folder', async () => {
    // Every entry outside dist, dist itself included: had the walk gone into dist, it would have run out of looks
    // before z.ts, the last.
    const outside = 20
    expect(await walkFiles(root, { limit: LIMIT, visitLimit: outside })).toEqual({ files: expected, cut: false })
    expect((await walkFiles(root, { limit: LIMIT, visitLimit: outside - 1 })).cut).toBe(true)
  })
})

describe('walkFiles: a large .gitignore', () => {
  // 256 KB is read: a rule, then a long comment, then 'abc' to the last byte, the start of a rule cut in two.
  const head = '*.log\n' + '#'.repeat(256 * 1024 - 10) + '\n'
  const root = tree({ '.gitignore': `${head}abcdef\n`, abc: '', abcdef: '', 'x.log': '' })

  it('uses the rules in its first 256 KB, less the one cut in two', async () => {
    expect(head.length + 'abc'.length).toBe(256 * 1024)
    expect((await walkFiles(root, { limit: LIMIT })).files).toEqual(['.gitignore', 'abc', 'abcdef'])
  })
})

describe('walkFiles: links and other entries', () => {
  const root = tree({ 'real/x.ts': '', 'piped/a.ts': '' })
  symlinkSync(tmpdir(), join(root, 'outside'))
  symlinkSync(join(root, 'real'), join(root, 'inside'))
  symlinkSync(join(root, 'real', 'x.ts'), join(root, 'x-link.ts'))
  execFileSync('mkfifo', [join(root, 'fifo')])
  // A pipe where a .gitignore would be: not read (the walk isn't held up by it), not listed.
  execFileSync('mkfifo', [join(root, 'piped', '.gitignore')])

  it('neither lists nor enters a link (to a folder outside, to one inside, to a file), and skips a pipe', async () => {
    expect(await walkFiles(root, { limit: LIMIT })).toEqual({ files: ['piped/a.ts', 'real/x.ts'], cut: false })
  }, 5_000)
})

describe('walkFiles: a folder that can’t be read', () => {
  const root = tree({ 'a.ts': '', 'locked/b.ts': '', 'z.ts': '' })

  // Root reads a folder whatever its permissions.
  it.skipIf(process.getuid?.() === 0)('is left out, not an error', async () => {
    chmodSync(join(root, 'locked'), 0o000)
    try {
      expect(await walkFiles(root, { limit: LIMIT })).toEqual({ files: ['a.ts', 'z.ts'], cut: false })
    } finally {
      // So the temp folder can be removed.
      chmodSync(join(root, 'locked'), 0o755)
    }
  })
})

describe('walkFiles: start', () => {
  const root = tree({
    '.gitignore': '*.log\n',
    'file.txt': '',
    'lib/y.ts': '',
    'src/.gitignore': 'gen/\n',
    'src/a/b.ts': '',
    'src/a/c.log': '',
    'src/gen/x.ts': '',
    'src/z.ts': ''
  })
  symlinkSync(join(root, 'src'), join(root, 'link'))

  it('walks a subfolder, its paths still relative to the root and the .gitignore files above it applied', async () => {
    const src = { files: ['src/.gitignore', 'src/a/b.ts', 'src/z.ts'], cut: false }
    expect(await walkFiles(root, { start: 'src', limit: LIMIT })).toEqual(src)
    expect(await walkFiles(root, { start: './src/', limit: LIMIT })).toEqual(src)
    expect(await walkFiles(root, { start: 'src/a', limit: LIMIT })).toEqual({ files: ['src/a/b.ts'], cut: false })
    expect((await walkFiles(root, { start: 'src/..', limit: LIMIT })).files).toContain('lib/y.ts')
    expect((await walkFiles(root, { start: '', limit: LIMIT })).files).toContain('lib/y.ts')
  })

  it('starts in an ignored folder without checking it, though the rules above still leave out what’s in it', async () => {
    expect(await walkFiles(root, { start: 'src/gen', limit: LIMIT })).toEqual({ files: [], cut: false })
  })

  it('refuses a start outside the folder', async () => {
    for (const start of ['..', '../x', 'src/../../x', '/tmp']) {
      await expect(walkFiles(root, { start, limit: LIMIT })).rejects.toThrow('outside the folder')
    }
  })

  it('refuses a start that is a link, has one on the way, is missing, or is a file', async () => {
    await expect(walkFiles(root, { start: 'link', limit: LIMIT })).rejects.toThrow('link is a link, not a folder')
    await expect(walkFiles(root, { start: 'link/a', limit: LIMIT })).rejects.toThrow('link is a link, not a folder')
    await expect(walkFiles(root, { start: 'missing', limit: LIMIT })).rejects.toThrow("missing doesn't exist")
    await expect(walkFiles(root, { start: 'file.txt', limit: LIMIT })).rejects.toThrow('file.txt is a file, not a folder')
  })
})

describe('walkFiles: limits', () => {
  const root = tree({ 'a.txt': '', 'b.md': '', 'd/x.txt': '', 'd/y.txt': '', 'e.txt': '' })

  it('stops at the result limit, keeping what it found', async () => {
    expect(await walkFiles(root, { limit: 2 })).toEqual({ files: ['a.txt', 'b.md'], cut: true, stopped: 'limit' })
    expect(await walkFiles(root, { glob: '*.txt', limit: 2 })).toEqual({ files: ['a.txt', 'd/x.txt'], cut: true, stopped: 'limit' })
    // Not cut when it held that many only as it ran out of entries.
    expect(await walkFiles(root, { limit: 5 })).toEqual({ files: ['a.txt', 'b.md', 'd/x.txt', 'd/y.txt', 'e.txt'], cut: false })
  })

  it('stops at the visit limit, counting folders too, keeping what it found', async () => {
    expect(await walkFiles(root, { limit: LIMIT, visitLimit: 4 })).toEqual({
      files: ['a.txt', 'b.md', 'd/x.txt'],
      cut: true,
      stopped: 'visits'
    })
    // A deadline already past stops the walk before its first entry.
    expect(await walkFiles(root, { limit: LIMIT, maxMs: -1 })).toEqual({ files: [], cut: true, stopped: 'time' })
    // Entries: a.txt, b.md, d, d/x.txt, d/y.txt, e.txt.
    expect(await walkFiles(root, { limit: LIMIT, visitLimit: 6 })).toEqual({
      files: ['a.txt', 'b.md', 'd/x.txt', 'd/y.txt', 'e.txt'],
      cut: false
    })
  })
})

describe('walkFiles: a larger tree', () => {
  // Names with '-' and '.' in them, which sort before '/': a plain sort of the paths would put d1-x before d1/…
  const paths: string[] = []
  for (let d = 0; d < 8; d++) {
    for (const folder of [`d${d}`, `d${d}-x`, `d${d}.y`, `d${d}/sub`]) {
      for (let f = 0; f < 6; f++) paths.push(`${folder}/f${f}.${f % 2 ? 'md' : 'ts'}`)
    }
  }
  for (let f = 0; f < 10; f++) paths.push(`top${f}.ts`)
  const root = tree(Object.fromEntries([...paths].reverse().map((p) => [p, ''])))

  /** Depth first with each folder's names in code-point order is the order of the paths compared segment by segment. */
  const walkOrder = (a: string, b: string) => {
    const [x, y] = [a.split('/'), b.split('/')]
    for (let i = 0; i < Math.min(x.length, y.length); i++) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1
    return x.length - y.length
  }

  it('walks every file, in order', async () => {
    expect(paths.length).toBe(202)
    expect(await walkFiles(root, { limit: LIMIT })).toEqual({ files: [...paths].sort(walkOrder), cut: false })
    const md = paths.filter((p) => p.endsWith('.md')).sort(walkOrder)
    expect(await walkFiles(root, { glob: '**/*.md', limit: LIMIT })).toEqual({ files: md, cut: false })
  })
})

describe('matchesGlob', () => {
  it('answers a pattern that would make a RegExp backtrack for ages at once', () => {
    const began = Date.now()
    expect(matchesGlob('*a*a*a*a*a*a*a*a*a*b', `${'a'.repeat(80)}c`)).toBe(false)
    expect(matchesGlob('*a*a*a*a*a*a*a*a*a*b', `${'a'.repeat(80)}b`)).toBe(true)
    expect(matchesGlob('**/a/**/a/**/a/**/a/**/b', `${'a/'.repeat(40)}c`)).toBe(false)
    // Brace groups multiply: the cap on alternatives must bound the work, not only the result.
    expect(matchesGlob('{a,b}'.repeat(40), 'x.ts')).toBe(false)
    expect(matchesGlob(`${'{a,b}'.repeat(40)}.ts`, `${'a'.repeat(40)}.ts`)).toBe(true)
    expect(Date.now() - began).toBeLessThan(500)
  })

  it.each([
    ['*.ts', 'a/b.ts', true],
    ['*.ts', 'b.ts', true],
    ['*.ts', 'a/b.tsx', false],
    ['src/**/*.ts', 'src/x.ts', true],
    ['src/**/*.ts', 'src/a/x.ts', true],
    ['src/**/*.ts', 'src/a/b/x.ts', true],
    ['src/**/*.ts', 'lib/x.ts', false],
    ['src/**/*.ts', 'lib/src/x.ts', false],
    ['**/*.{ts,tsx}', 'a/b.ts', true],
    ['**/*.{ts,tsx}', 'b.tsx', true],
    ['**/*.{ts,tsx}', 'a/b.js', false],
    ['{src,lib}/*.ts', 'lib/a.ts', true],
    ['{src/a,lib}/x.ts', 'src/a/x.ts', true],
    ['src/*', 'src/a', true],
    ['src/*', 'src/a/b', false],
    ['src/**', 'src/a/b', true],
    ['src/**', 'lib/a', false],
    ['**', 'a/b/c', true],
    ['a**b', 'axyb', true],
    ['a**b', 'a/b', false],
    ['?.ts', 'a.ts', true],
    ['?.ts', 'ab.ts', false],
    ['a?b', 'a/b', false],
    ['[a].ts', '[a].ts', true],
    ['[a].ts', 'a.ts', false],
    ['(a)+.ts', '(a)+.ts', true],
    ['a.ts', 'aXts', false],
    ['{a', '{a', true],
    ['*', '.env', true],
    ['*.yml', '.github/ci.yml', true],
    ['./src/*.ts', 'src/a.ts', true],
    ['/src/*.ts', 'src/a.ts', true],
    ['src/*.ts', 'x/src/a.ts', false],
    ['/*.ts', 'b.ts', true],
    ['/*.ts', 'a/b.ts', false],
    ['./*.ts', 'a/b.ts', false],
    ['?.ts', '😀.ts', true],
    ['??.ts', '😀.ts', false],
    ['{a,b}{c,d}.ts', 'bd.ts', true],
    ['{a,b}{c,d}.ts', 'ba.ts', false],
    ['**/**/x', 'a/x', true],
    ['src/**', 'src', true]
  ])('%s against %s is %s', (pattern, path, expected) => {
    expect(matchesGlob(pattern, path)).toBe(expected)
  })
})
