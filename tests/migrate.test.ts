import { spawn } from 'node:child_process'
import { chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { tempDir } from './tempDir'

// The migration's keychain use is faked, as in mcp.test.ts: Electron isn't running under vitest.
vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (s: string) => Buffer.from(`enc:${s}`),
    decryptString: (b: Buffer) => b.toString().replace(/^enc:/, '')
  },
  shell: {},
  app: { getPath: () => '' }
}))

const migrate = await import('../src/main/migrate')

/** A folder holding "Kiln" (with a kiln.db) and room for "Ollmost" next to it, as in Application Support. */
function appSupport(): { kiln: string; ollmost: string } {
  const root = tempDir('migrate-')
  const kiln = join(root, 'Kiln')
  mkdirSync(join(kiln, 'files'), { recursive: true })
  writeFileSync(join(kiln, 'kiln.db'), 'db')
  writeFileSync(join(kiln, 'files', 'a.png'), 'png')
  return { kiln, ollmost: join(root, 'Ollmost') }
}

const sleepers: Array<ReturnType<typeof spawn>> = []
const livePid = () => {
  const child = spawn('sleep', ['30'])
  sleepers.push(child)
  return child.pid!
}
afterAll(() => sleepers.forEach((c) => c.kill()))

describe('moving Kiln’s data folder', () => {
  it('moves it, drops Kiln’s lock files and leaves a marker', () => {
    const { kiln, ollmost } = appSupport()
    symlinkSync('Mac-999999', join(kiln, 'SingletonLock'))
    symlinkSync('/nonexistent/socket', join(kiln, 'SingletonSocket'))
    expect(migrate.moveKilnData(ollmost)).toEqual({ state: 'moved' })
    expect(existsSync(kiln)).toBe(false)
    expect(existsSync(join(ollmost, 'files', 'a.png'))).toBe(true)
    expect(readdirSync(ollmost).filter((n) => n.startsWith('Singleton'))).toEqual([])
    expect(existsSync(join(ollmost, migrate.MARKER))).toBe(true)
  })

  it('moves it into the empty folder Electron creates before the app’s code runs', () => {
    const { kiln, ollmost } = appSupport()
    mkdirSync(ollmost)
    expect(migrate.moveKilnData(ollmost)).toEqual({ state: 'moved' })
    expect(existsSync(kiln)).toBe(false)
    expect(existsSync(join(ollmost, 'kiln.db'))).toBe(true)
  })

  it('does nothing when the new folder has something in it, or Kiln left no database', () => {
    const { kiln, ollmost } = appSupport()
    mkdirSync(ollmost)
    writeFileSync(join(ollmost, 'ollmost.db'), 'db')
    expect(migrate.moveKilnData(ollmost)).toEqual({ state: 'none' })
    expect(existsSync(kiln)).toBe(true)
    // A fresh install: no Kiln folder next to it.
    const fresh = join(tempDir('migrate-'), 'Ollmost')
    expect(migrate.moveKilnData(fresh)).toEqual({ state: 'none' })
  })

  it('does nothing while the app itself is still called Kiln', () => {
    const { kiln } = appSupport()
    expect(migrate.moveKilnData(kiln)).toEqual({ state: 'none' })
  })

  it('waits while Kiln is running, creating nothing', () => {
    const { kiln, ollmost } = appSupport()
    const pid = livePid()
    symlinkSync(`Mac-${pid}`, join(kiln, 'SingletonLock'))
    expect(migrate.moveKilnData(ollmost, { isKiln: () => true })).toEqual({ state: 'kiln-running', pid })
    expect(existsSync(ollmost)).toBe(false)
    expect(existsSync(join(kiln, 'kiln.db'))).toBe(true)
  })

  it('moves anyway when the lock is stale: a dead pid, or one another program now has', () => {
    const a = appSupport()
    symlinkSync('Mac-999999', join(a.kiln, 'SingletonLock'))
    expect(migrate.moveKilnData(a.ollmost, { isKiln: () => true }).state).toBe('moved')
    const b = appSupport()
    symlinkSync(`Mac-${livePid()}`, join(b.kiln, 'SingletonLock'))
    // The real check: `sleep` is not Kiln.
    expect(migrate.moveKilnData(b.ollmost).state).toBe('moved')
  })

  it('reports a failed move and leaves everything as it was', () => {
    const { kiln, ollmost } = appSupport()
    const parent = join(kiln, '..')
    chmodSync(parent, 0o555)
    try {
      const result = migrate.moveKilnData(ollmost)
      expect(result.state).toBe('failed')
      expect(existsSync(ollmost)).toBe(false)
      expect(existsSync(join(kiln, 'kiln.db'))).toBe(true)
    } finally {
      chmodSync(parent, 0o755)
    }
  })
})

describe('waiting for Kiln to quit', () => {
  it('goes on once Kiln has quit, closing the message', async () => {
    let running = true
    setTimeout(() => (running = false), 50)
    const shown = (signal: AbortSignal) => new Promise((resolve) => signal.addEventListener('abort', resolve))
    expect(await migrate.waitForKiln(() => running, shown, 10)).toBe(true)
  })

  it('stops when the user quits instead', async () => {
    expect(
      await migrate.waitForKiln(
        () => true,
        async () => undefined,
        10
      )
    ).toBe(false)
  })
})

const { openDatabase } = await import('../src/main/db/index')
const { MIGRATIONS } = await import('../src/main/db/migrations')
const { readSetting, writeSetting } = await import('../src/main/db/kv')
const mcp = await import('../src/main/mcp/config')

const count = (file: string) => {
  const d = new DatabaseSync(file)
  try {
    return (d.prepare('SELECT COUNT(*) AS n FROM t').get() as { n: number }).n
  } finally {
    d.close()
  }
}

/** Kiln's database as a crash leaves it: two rows written only to the WAL, which nothing has checkpointed. */
function crashedDatabase(): string {
  const live = tempDir('migrate-db-')
  const writer = new DatabaseSync(join(live, 'kiln.db'))
  writer.exec('PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0; CREATE TABLE t (x); INSERT INTO t VALUES (1), (2);')
  const crashed = tempDir('migrate-crashed-')
  for (const f of readdirSync(live)) copyFileSync(join(live, f), join(crashed, f))
  writer.close()
  expect(existsSync(join(crashed, 'kiln.db-wal'))).toBe(true)
  return crashed
}

describe('what’s left to do after the move', () => {
  it('is pending after a move, or while Kiln’s database still has its old name', () => {
    const dir = tempDir('migrate-')
    expect(migrate.migrationPending(dir, join(dir, 'ollmost.db'))).toBe(false)
    writeFileSync(join(dir, 'kiln.db'), '')
    expect(migrate.migrationPending(dir, join(dir, 'ollmost.db'))).toBe(true)
    // Not while the app itself still uses kiln.db (before the rename): that's the live database.
    expect(migrate.migrationPending(dir, join(dir, 'kiln.db'))).toBe(false)
    writeFileSync(join(dir, migrate.MARKER), '')
    expect(migrate.migrationPending(dir, join(dir, 'kiln.db'))).toBe(true)
  })
})

describe('renaming Kiln’s database', () => {
  it('keeps transactions only in the WAL', () => {
    const dir = crashedDatabase()
    migrate.renameDatabase(dir, join(dir, 'ollmost.db'))
    expect(existsSync(join(dir, 'kiln.db'))).toBe(false)
    expect(existsSync(join(dir, migrate.MARKER))).toBe(true)
    expect(count(join(dir, 'ollmost.db'))).toBe(2)
  })

  it('finishes a rename a crash interrupted after the WAL was renamed', () => {
    const dir = crashedDatabase()
    renameSync(join(dir, 'kiln.db-wal'), join(dir, 'ollmost.db-wal'))
    renameSync(join(dir, 'kiln.db-shm'), join(dir, 'ollmost.db-shm'))
    migrate.renameDatabase(dir, join(dir, 'ollmost.db'))
    expect(count(join(dir, 'ollmost.db'))).toBe(2)
  })

  it('renames nothing when both databases exist', () => {
    const dir = tempDir('migrate-')
    writeFileSync(join(dir, 'kiln.db'), 'old')
    writeFileSync(join(dir, 'ollmost.db'), 'new')
    migrate.renameDatabase(dir, join(dir, 'ollmost.db'))
    expect(readFileSync(join(dir, 'kiln.db'), 'utf8')).toBe('old')
    expect(readFileSync(join(dir, 'ollmost.db'), 'utf8')).toBe('new')
  })
})

describe('finishing the move', () => {
  beforeAll(() => openDatabase(':memory:'))

  it('forgets Kiln’s secrets, noting once what to ask for again', async () => {
    const dir = tempDir('migrate-')
    writeFileSync(join(dir, migrate.MARKER), '')
    writeSetting('apiKey', Buffer.from('enc:key').toString('base64'))
    const server = mcp.saveServer({ name: 'GitHub', command: 'npx', args: [], cwd: null, env: { TOKEN: 't' }, defaultOn: false })
    await migrate.finishMigration(dir, '.ollmost')
    expect(readSetting('apiKey', null)).toBeNull()
    expect(mcp.getServer(server.id)?.missingEnv).toEqual(['TOKEN'])
    expect(migrate.migrationNotice()).toMatchObject({ apiKey: true, servers: [server.id], dismissed: false })
    expect(existsSync(join(dir, migrate.MARKER))).toBe(false)
    // Run again, as after a crash: what the first run noted is kept, though the secrets are gone now.
    writeFileSync(join(dir, migrate.MARKER), '')
    await migrate.finishMigration(dir, '.ollmost')
    expect(migrate.migrationNotice()).toMatchObject({ apiKey: true, servers: [server.id] })
    migrate.dismissMigrationNotice()
    expect(migrate.migrationNotice()).toBeNull()
  })

  it('deletes the Python environments and renames each chat’s hidden folder, moving a link, not following it', async () => {
    const dir = tempDir('migrate-')
    for (const venv of ['base-venv/bin', 'venvs/c1/bin', 'venv/bin']) mkdirSync(join(dir, 'runner', venv), { recursive: true })
    mkdirSync(join(dir, 'runner', 'scripts', 'c1'), { recursive: true })
    mkdirSync(join(dir, 'workspaces', 'c1', '.kiln', 'home'), { recursive: true })
    writeFileSync(join(dir, 'workspaces', 'c1', '.kiln', 'home', 'saved.txt'), 'kept')
    const outside = tempDir('migrate-outside-')
    writeFileSync(join(outside, 'target.txt'), 'untouched')
    mkdirSync(join(dir, 'workspaces', 'c2'), { recursive: true })
    symlinkSync(outside, join(dir, 'workspaces', 'c2', '.kiln'))
    mkdirSync(join(dir, 'workspaces', 'c3', '.kiln'), { recursive: true })
    mkdirSync(join(dir, 'workspaces', 'c3', '.ollmost'), { recursive: true })
    writeFileSync(join(dir, 'workspaces', 'c3', '.ollmost', 'new.txt'), 'new')

    await migrate.finishMigration(dir, '.ollmost')

    expect(readdirSync(join(dir, 'runner'))).toEqual(['scripts'])
    expect(readFileSync(join(dir, 'workspaces', 'c1', '.ollmost', 'home', 'saved.txt'), 'utf8')).toBe('kept')
    expect(existsSync(join(dir, 'workspaces', 'c1', '.kiln'))).toBe(false)
    expect(readFileSync(join(outside, 'target.txt'), 'utf8')).toBe('untouched')
    expect(existsSync(join(dir, 'workspaces', 'c2', '.kiln'))).toBe(false)
    expect(existsSync(join(dir, 'workspaces', 'c3', '.kiln'))).toBe(false)
    expect(readFileSync(join(dir, 'workspaces', 'c3', '.ollmost', 'new.txt'), 'utf8')).toBe('new')
  })

  it('carries on past a folder it can’t change, keeping the marker so the next launch tries again', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const dir = tempDir('migrate-')
    writeFileSync(join(dir, migrate.MARKER), '')
    // Code can make its own environment and workspace unwritable.
    const locked = [join(dir, 'runner', 'venvs', 'c1', 'lib'), join(dir, 'workspaces', 'c1')]
    mkdirSync(locked[0], { recursive: true })
    writeFileSync(join(locked[0], 'site.py'), '')
    mkdirSync(join(dir, 'workspaces', 'c1', '.kiln'), { recursive: true })
    mkdirSync(join(dir, 'workspaces', 'c2', '.kiln'), { recursive: true })
    for (const folder of locked) chmodSync(folder, 0o555)
    try {
      await migrate.finishMigration(dir, '.ollmost')
      expect(existsSync(join(dir, 'workspaces', 'c2', '.ollmost'))).toBe(true)
      expect(existsSync(join(dir, migrate.MARKER))).toBe(true)
      expect(warn).toHaveBeenCalled()
    } finally {
      for (const folder of locked) chmodSync(folder, 0o755)
      warn.mockRestore()
    }
    await migrate.finishMigration(dir, '.ollmost')
    expect(existsSync(join(dir, 'runner', 'venvs'))).toBe(false)
    expect(existsSync(join(dir, 'workspaces', 'c1', '.ollmost'))).toBe(true)
    expect(existsSync(join(dir, migrate.MARKER))).toBe(false)
  })

  it('relabels the debugger’s recorded endpoints', () => {
    const d = new DatabaseSync(':memory:')
    const index = MIGRATIONS.findIndex((sql) => sql.includes('recorded endpoints'))
    expect(index).toBeGreaterThan(0)
    for (const sql of MIGRATIONS.slice(0, index)) d.exec(sql)
    d.prepare(`INSERT INTO traces (id, kind, status, started_at, data) VALUES ('t1', 'tool', 'ok', 0, ?)`).run(
      JSON.stringify({ endpoint: 'kiln://tools/web_fetch', request: null })
    )
    d.exec(MIGRATIONS[index])
    const data = (d.prepare('SELECT data FROM traces').get() as { data: string }).data
    expect(JSON.parse(data).endpoint).toBe('ollmost://tools/web_fetch')
  })
})
