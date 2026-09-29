import { execFileSync } from 'node:child_process'
import { mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { readBranch } from '../src/main/code/git'
import { tempDir } from './tempDir'

// A session's branch is read from .git/HEAD as a plain file, never through a link and never by running git (#86).

// A real path: on a Mac the temp folder is under /var, a link, and readBranch reads nothing through one.
const base = realpathSync.native(tempDir('ollmost-git-'))
afterAll(() => rmSync(base, { recursive: true, force: true }))

let made = 0
/** A folder with a .git folder, and in it a HEAD holding `head` when given. */
function repo(head?: string): string {
  const dir = join(base, `repo-${made++}`)
  mkdirSync(join(dir, '.git'), { recursive: true })
  if (head !== undefined) writeFileSync(join(dir, '.git', 'HEAD'), head)
  return dir
}
const HASH = '0123456789abcdef0123456789abcdef01234567'

describe('readBranch', () => {
  it('reads the branch checked out, or the start of a detached commit', async () => {
    expect(await readBranch(repo('ref: refs/heads/main\n'))).toBe('main')
    expect(await readBranch(repo('ref: refs/heads/feature/x\n'))).toBe('feature/x')
    expect(await readBranch(repo(`${HASH}\n`))).toBe(HASH.slice(0, 12))
  })

  it('gives null for a folder that isn’t a repository, or a HEAD that isn’t one', async () => {
    const plain = join(base, 'plain')
    mkdirSync(plain)
    expect(await readBranch(plain)).toBeNull()
    expect(await readBranch(repo())).toBeNull()
    expect(await readBranch(repo('what is this\n'))).toBeNull()
    expect(await readBranch(repo('ref: refs/tags/v1\n'))).toBeNull()
  })

  it('gives null for a worktree, whose .git is a file', async () => {
    const worktree = join(base, 'worktree')
    mkdirSync(worktree)
    writeFileSync(join(worktree, '.git'), `gitdir: ${repo('ref: refs/heads/main\n')}/.git\n`)
    expect(await readBranch(worktree)).toBeNull()
  })

  it('is not held up by a named pipe where HEAD should be', async () => {
    const piped = repo()
    execFileSync('mkfifo', [join(piped, '.git', 'HEAD')])
    expect(await readBranch(piped)).toBeNull()
  }, 5_000)

  it('reads nothing through a link, as HEAD or anywhere above it', async () => {
    const elsewhere = repo('ref: refs/heads/main\n')
    const linkedHead = repo()
    symlinkSync(join(elsewhere, '.git', 'HEAD'), join(linkedHead, '.git', 'HEAD'))
    expect(await readBranch(linkedHead)).toBeNull()
    const linkedGit = join(base, 'linked-git')
    mkdirSync(linkedGit)
    symlinkSync(join(elsewhere, '.git'), join(linkedGit, '.git'))
    // Elsewhere than a Mac, O_NOFOLLOW checks only the last part of the path (the sandbox is macOS only anyway).
    if (process.platform === 'darwin') expect(await readBranch(linkedGit)).toBeNull()
    expect(await readBranch(elsewhere)).toBe('main')
  })
})
