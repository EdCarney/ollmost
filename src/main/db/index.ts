import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { MIGRATIONS, MODEL_KEYS_MIGRATION } from './migrations'

let db: DatabaseSync | null = null

export function openDatabase(file: string): DatabaseSync {
  db = new DatabaseSync(file)
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 3000;')
  migrate(db, file === ':memory:' ? null : join(dirname(file), 'backups'))
  return db
}

export function getDb(): DatabaseSync {
  if (!db) throw new Error('Database not opened')
  return db
}

/** Where the copy made before the model-key migration goes: <userData>/backups, one a day at most. */
export function endpointsBackupPath(dir: string, at: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return join(dir, `ollmost-before-endpoints-${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}.db`)
}

function migrate(d: DatabaseSync, backups: string | null): void {
  const current = (d.prepare('PRAGMA user_version').get() as { user_version: number }).user_version
  // The model-key entry is one-way (an older Ollmost can't read keys), so the database is copied as it is first. A new
  // one has nothing to copy. VACUUM INTO can't run inside a transaction, so it goes before any of them.
  if (backups && current > 0 && current <= MODEL_KEYS_MIGRATION) backUp(d, endpointsBackupPath(backups, new Date()))
  for (let v = current; v < MIGRATIONS.length; v++) {
    transaction(() => {
      d.exec(MIGRATIONS[v])
      d.exec(`PRAGMA user_version = ${v + 1}`)
    }, d)
  }
}

function backUp(d: DatabaseSync, file: string): void {
  if (existsSync(file)) return
  try {
    mkdirSync(dirname(file), { recursive: true })
    d.prepare('VACUUM INTO ?').run(file)
  } catch (err) {
    // A half-written copy would pass for a backup tomorrow. The clean-up failing mustn't hide why the backup did.
    try {
      rmSync(file, { force: true })
    } catch {
      /* nothing to clean up */
    }
    throw new Error(`Ollmost couldn't back up its database before updating it, so it left it as it was: ${(err as Error).message}`, {
      cause: err
    })
  }
}

let depth = 0

/**
 * Run `fn` atomically. A call inside another transaction joins it, so helpers can use this whether or not
 * their caller already opened one. `fn` must be synchronous.
 */
export function transaction<T>(fn: () => T, d: DatabaseSync = getDb()): T {
  if (depth > 0) return fn()
  d.exec('BEGIN')
  depth++
  try {
    const result = fn()
    d.exec('COMMIT')
    return result
  } catch (err) {
    d.exec('ROLLBACK')
    throw err
  } finally {
    depth--
  }
}

type Param = string | number | bigint | null | Uint8Array

export function all<T>(sql: string, ...params: Param[]): T[] {
  return getDb()
    .prepare(sql)
    .all(...params) as T[]
}

export function get<T>(sql: string, ...params: Param[]): T | undefined {
  return getDb()
    .prepare(sql)
    .get(...params) as T | undefined
}

export function run(sql: string, ...params: Param[]): void {
  getDb()
    .prepare(sql)
    .run(...params)
}
