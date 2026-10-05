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

/** What rmSync throws for a locked folder: EACCES or EPERM on Node 22, ENOTEMPTY on Node 26 (#197). */
const LOCKED = new Set(['EACCES', 'EPERM', 'ENOTEMPTY'])

function remove(dir: string, rm: typeof rmSync): void {
  try {
    rm(dir, { recursive: true, force: true })
  } catch (err) {
    if (!LOCKED.has((err as NodeJS.ErrnoException).code ?? '')) return
    // Once more, with the folders writable. Otherwise it stays: a leftover folder isn't worth failing the run for.
    try {
      makeWritable(dir)
      rm(dir, { recursive: true, force: true })
    } catch {
      // left in place
    }
  }
}

/** Takes no parameter, so it can be a vitest hook as it is (vitest reads a hook's parameters as fixtures). */
export function removeTempDirs(): void {
  removeTempDirsWith(rmSync)
}

/** For this helper's own tests, which can't count on what a given Node throws for a locked folder: `rm` stands in for rmSync. */
export function removeTempDirsWith(rm: typeof rmSync): void {
  for (const dir of made.splice(0)) remove(dir, rm)
}
