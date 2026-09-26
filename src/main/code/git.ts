import { join } from 'node:path'
import { openNoLinks } from '../runner/workspace'

// What Ollmost reads of a session's repository outside the sandbox: only .git/HEAD, as a plain file. Never git itself:
// a root that isn't a repository lets session code write a .git *file* whose config points elsewhere and names a
// fsmonitor or hooks path, which git run by Ollmost would execute as the user (the plan's P7). Git runs only inside the
// session's sandbox.

const HEAD_BYTES = 1024

/**
 * The branch checked out in `root`: the name in .git/HEAD, or the first 12 characters of a detached commit, or null
 * when there's no .git/HEAD to read as a plain file (not a repository; a worktree, whose .git is a file; a link
 * anywhere in the path; a pipe). Nothing is executed and nothing else is read.
 */
export async function readBranch(root: string): Promise<string | null> {
  const file = await openNoLinks(join(root, '.git', 'HEAD'))
  if (!file) return null
  try {
    const buffer = Buffer.alloc(HEAD_BYTES)
    const { bytesRead } = await file.handle.read(buffer, 0, HEAD_BYTES, 0)
    const head = buffer.toString('utf8', 0, bytesRead).trim()
    const ref = /^ref: refs\/heads\/(\S+)$/.exec(head)
    if (ref) return ref[1]
    return /^[0-9a-f]{40,64}$/.test(head) ? head.slice(0, 12) : null
  } catch {
    return null
  } finally {
    await file.handle.close()
  }
}
