import { chmodSync, lstatSync, mkdtempSync, readdirSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'

// Every temp folder a test makes, so tests/setup.ts can remove them when the file's tests are done. A test file that
// makes its own with mkdtempSync leaves it behind: an `npm test` run adds dozens, and they pile up.
const made: string[] = []

/** A new folder in the temp folder, removed after the test file. */
export function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  made.push(dir)
  return dir
}

/** Have a folder removed after the test file too: one a test moved, or made some other way. Only ever in the temp folder. */
export function trackTempDir(dir: string): void {
  const inTemp = [tmpdir(), realpathSync(tmpdir())].some((t) => dir.startsWith(t + sep))
  if (!inTemp) throw new Error(`trackTempDir: ${dir} isn't in the temp folder`)
  made.push(dir)
}

/** Folders a test left unwritable (as code can, or a chmod test does) can't be emptied until they're writable again. */
function makeWritable(path: string): void {
  const stat = lstatSync(path)
  if (!stat.isDirectory()) return
  chmodSync(path, (stat.mode & 0o7777) | 0o700)
  for (const name of readdirSync(path)) makeWritable(join(path, name))
}

function remove(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code !== 'EACCES' && code !== 'EPERM') return
    // Once more, with the folders writable. Otherwise it stays: a leftover folder isn't worth failing the run for.
    try {
      makeWritable(dir)
      rmSync(dir, { recursive: true, force: true })
    } catch {
      // left in place
    }
  }
}

export function removeTempDirs(): void {
  for (const dir of made.splice(0)) remove(dir)
}
