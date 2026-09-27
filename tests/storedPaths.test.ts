import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { beforeAll, describe, expect, it } from 'vitest'
import { getDb, openDatabase } from '../src/main/db/index'
import { MIGRATIONS } from '../src/main/db/migrations'
import * as conversations from '../src/main/db/conversations'
import * as projects from '../src/main/db/projects'
import { paths, toStored } from '../src/main/paths'

const data = mkdtempSync(join(tmpdir(), 'ollmost-paths-'))
beforeAll(() => {
  paths.data = data
  openDatabase(':memory:')
})

const storedPath = (table: string, id: string) =>
  (getDb().prepare(`SELECT path FROM ${table} WHERE id = ?`).get(id) as { path: string }).path
const attach = (id: string, path: string) =>
  conversations.insertAttachment({ id, kind: 'image', name: `${id}.png`, mime: 'image/png', size: 1, path, text: null, token_est: 0 })

describe('stored file paths', () => {
  it('are kept relative to the data folder and handed out absolute', () => {
    const file = join(data, 'files', 'a1.png')
    attach('a1', file)
    expect(storedPath('attachments', 'a1')).toBe('files/a1.png')
    expect(conversations.getAttachmentRow('a1')?.path).toBe(file)
    expect(conversations.deletePendingAttachment('a1')).toBe(file)
  })

  it('follow the data folder when it moves', () => {
    attach('a2', join(data, 'files', 'a2.png'))
    const moved = mkdtempSync(join(tmpdir(), 'ollmost-moved-'))
    paths.data = moved
    try {
      expect(conversations.getAttachmentRow('a2')?.path).toBe(join(moved, 'files', 'a2.png'))
      expect(conversations.staleAttachmentPaths(Number.MAX_SAFE_INTEGER)).toContain(join(moved, 'files', 'a2.png'))
    } finally {
      paths.data = data
    }
  })

  it('refuse a file outside the data folder', () => {
    expect(() => toStored('/etc/hosts')).toThrow(/data folder/)
    expect(() => toStored(join(data, '..', 'elsewhere', 'x.png'))).toThrow(/data folder/)
    expect(() => toStored(data)).toThrow(/data folder/)
  })

  it('are relative for project files too', () => {
    const p = projects.createProject({ name: 'Paths' })
    const file = join(data, 'files', 'pf1.md')
    projects.insertProjectFile({
      id: 'pf1',
      project_id: p.id,
      name: 'a.md',
      mime: 'text/markdown',
      size: 1,
      path: file,
      text: 'a',
      token_est: 1,
      folder: ''
    })
    expect(storedPath('project_files', 'pf1')).toBe('files/pf1.md')
    expect(projects.deleteProject(p.id)).toEqual([file])
  })
})

describe('the migration to relative paths', () => {
  it('rewrites absolute paths from any old data folder to files/<name>, and leaves relative ones', () => {
    const d = new DatabaseSync(':memory:')
    const index = MIGRATIONS.findIndex((sql) => sql.includes('-- File paths relative to the data folder'))
    expect(index).toBeGreaterThan(0)
    for (const sql of MIGRATIONS.slice(0, index)) d.exec(sql)
    const add = d.prepare(
      `INSERT INTO attachments (id, message_id, kind, name, mime, size, path, text, token_est, created_at)
       VALUES (?, NULL, 'image', 'x.png', 'image/png', 1, ?, NULL, 0, 0)`
    )
    add.run('old', '/Users/me/Library/Application Support/Ollmost/files/old.png')
    add.run('new', 'files/new.png')
    d.exec(MIGRATIONS[index])
    const rows = d.prepare('SELECT id, path FROM attachments ORDER BY id').all() as Array<{ id: string; path: string }>
    expect(rows.map((r) => [r.id, r.path])).toEqual([
      ['new', 'files/new.png'],
      ['old', 'files/old.png']
    ])
  })
})
