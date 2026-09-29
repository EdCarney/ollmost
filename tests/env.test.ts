import { chmodSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { childEnv, INHERITED_ENV, inheritedEnv, loginPath, mergePath, readLoginPath } from '../src/main/env'
import { tempDir } from './tempDir'

const dir = tempDir('ollmost-env-')

/** A stand-in login shell: runs the command Ollmost passes (after -ilc) with the given script around it. */
function fakeShell(name: string, body: string): string {
  const path = join(dir, name)
  writeFileSync(path, `#!/bin/sh\n${body}\n`)
  chmodSync(path, 0o755)
  return path
}

describe('readLoginPath', () => {
  it("reads PATH from the shell's environment, ignoring whatever its startup files print", async () => {
    const shell = fakeShell('noisy', `echo 'Welcome back!'\nPATH=/opt/tools/bin:/usr/bin; export PATH\neval "$2"\necho 'bye'`)
    expect(await readLoginPath(shell)).toBe('/opt/tools/bin:/usr/bin')
  })

  it('still reads it when a startup file fails and the shell exits non-zero', async () => {
    const shell = fakeShell('grumpy', `PATH=/opt/tools/bin:/usr/bin; export PATH\neval "$2"\nexit 3`)
    expect(await readLoginPath(shell)).toBe('/opt/tools/bin:/usr/bin')
  })

  it('gives up on a shell that hangs', async () => {
    const shell = fakeShell('stuck', 'sleep 10')
    const started = Date.now()
    expect(await readLoginPath(shell, 200)).toBeNull()
    expect(Date.now() - started).toBeLessThan(2_000)
  })

  it('returns null for a shell that does not exist', async () => {
    expect(await readLoginPath(join(dir, 'no-such-shell'))).toBeNull()
  })

  it('works with the real login shell', async () => {
    const path = await readLoginPath(process.env.SHELL || '/bin/sh', 10_000)
    expect(path).toMatch(/\/usr\/bin/)
  })
})

describe('loginPath', () => {
  it("puts the login shell's PATH first and keeps Ollmost's own after it", async () => {
    const shell = fakeShell('login', `PATH=/opt/tools/bin:/usr/bin; export PATH\neval "$2"`)
    expect(await loginPath({ shell, basePath: '/usr/bin:/bin' })).toBe('/opt/tools/bin:/usr/bin:/bin')
  })

  it('falls back to the usual tool folders that exist when the shell fails', async () => {
    const homebrew = join(dir, 'homebrew', 'bin')
    mkdirSync(homebrew, { recursive: true })
    const path = await loginPath({
      shell: fakeShell('broken', 'exit 1'),
      basePath: '/usr/bin:/bin',
      fallbackDirs: [homebrew, join(dir, 'missing', 'bin')]
    })
    expect(path).toBe(`/usr/bin:/bin:${homebrew}`)
  })
})

describe('mergePath', () => {
  it('keeps the first of each directory and drops empty entries', () => {
    expect(mergePath('/a:/b:', '/b:/c', null, undefined, '::/a:/d')).toBe('/a:/b:/c:/d')
  })
})

describe('childEnv', () => {
  it("passes on only the inherited variables, the login shell's PATH and the server's own", async () => {
    const keys = ['GITHUB_TOKEN', 'AWS_SECRET_ACCESS_KEY', 'HOME', 'LANG']
    const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]))
    try {
      process.env.GITHUB_TOKEN = 'ghp_secret'
      process.env.AWS_SECRET_ACCESS_KEY = 'aws_secret'
      process.env.HOME = '/Users/me'
      process.env.LANG = 'en_US.UTF-8'
      const env = await childEnv({ API_KEY: 'mine' })
      expect(env.GITHUB_TOKEN).toBeUndefined()
      expect(env.AWS_SECRET_ACCESS_KEY).toBeUndefined()
      expect(env).toMatchObject({ HOME: '/Users/me', LANG: 'en_US.UTF-8', API_KEY: 'mine' })
      expect(env.PATH).toBeTruthy()
      expect(Object.keys(env).every((k) => INHERITED_ENV.includes(k) || k === 'PATH' || k === 'API_KEY')).toBe(true)
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k]
        else process.env[k] = v
      }
    }
  })

  it('leaves out exported shell functions', () => {
    expect(inheritedEnv({ HOME: '/Users/me', TERM: '() { :; }; echo pwned' })).toEqual({ HOME: '/Users/me' })
  })
})
