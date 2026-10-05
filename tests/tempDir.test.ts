import { chmodSync, existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { removeTempDirs, removeTempDirsWith, tempDir, trackTempDir } from './tempDir'

// The helper every test's temp folders go through: tests/setup.ts calls removeTempDirs after each test file.
describe('removing the temp folders a test made', () => {
  it('removes each folder with what’s in it, and a folder tracked after it was moved', () => {
    const dir = tempDir('ollmost-tempdir-')
    mkdirSync(join(dir, 'a', 'b'), { recursive: true })
    writeFileSync(join(dir, 'a', 'b', 'f.txt'), 'x')
    const moved = tempDir('ollmost-tempdir-')
    renameSync(moved, `${moved}-moved`)
    trackTempDir(`${moved}-moved`)
    removeTempDirs()
    expect(existsSync(dir)).toBe(false)
    expect(existsSync(`${moved}-moved`)).toBe(false)
  })

  it('removes folders a test left unwritable or unreadable', () => {
    const dir = tempDir('ollmost-tempdir-')
    const locked = [join(dir, 'runner', 'venvs', 'lib'), join(dir, 'workspaces', 'c1'), join(dir, 'sealed')]
    for (const folder of locked) {
      mkdirSync(join(folder, 'inner'), { recursive: true })
      writeFileSync(join(folder, 'f.txt'), 'x')
    }
    chmodSync(locked[0], 0o555)
    chmodSync(locked[1], 0o555)
    chmodSync(locked[2], 0o000)
    chmodSync(join(dir, 'runner'), 0o500)
    removeTempDirs()
    expect(existsSync(dir)).toBe(false)
  })

  // Node 26's rmSync reports a locked folder as ENOTEMPTY, where Node 22's says EACCES or EPERM (#197). Neither
  // is forced here, since what a given Node throws (and what root is let do) varies: rmSync is stood in for.
  it('retries after ENOTEMPTY as after EACCES, and leaves a folder alone on any other error', () => {
    const failing = (code: string) => {
      const calls: string[] = []
      const rm: typeof rmSync = (path, options) => {
        calls.push(String(path))
        if (calls.length === 1) throw Object.assign(new Error(code), { code })
        rmSync(path, options)
      }
      return { rm, calls }
    }
    for (const code of ['ENOTEMPTY', 'EACCES']) {
      const dir = tempDir('ollmost-tempdir-')
      writeFileSync(join(dir, 'f.txt'), 'x')
      const { rm, calls } = failing(code)
      removeTempDirsWith(rm)
      expect(calls, code).toEqual([dir, dir])
      expect(existsSync(dir), code).toBe(false)
    }
    const dir = tempDir('ollmost-tempdir-')
    const { rm, calls } = failing('EBUSY')
    expect(() => removeTempDirsWith(rm)).not.toThrow()
    expect(calls).toEqual([dir])
    expect(existsSync(dir)).toBe(true)
    rmSync(dir, { recursive: true, force: true })
  })
})
