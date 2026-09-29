import { existsSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { splitModelKey } from '@shared/modelKey'
import { all, endpointsBackupPath, openDatabase } from '../src/main/db/index'
import { MIGRATIONS, MODEL_KEYS_MIGRATION } from '../src/main/db/migrations'
import { tempDir } from './tempDir'

const HF = 'hf.co/bartowski/Qwen3-8B-GGUF:Q4_K_M'
const folder = () => tempDir('ollmost-endpoints-')

/** A database as the Ollmost before endpoints left it, with a row of every kind that names a model. */
function oldDatabase(dir: string, name = 'ollmost.db'): string {
  const file = join(dir, name)
  const d = new DatabaseSync(file)
  for (const sql of MIGRATIONS.slice(0, MODEL_KEYS_MIGRATION)) d.exec(sql)
  d.exec(`PRAGMA user_version = ${MODEL_KEYS_MIGRATION}`)
  d.exec(`
    INSERT INTO conversations (id, model, created_at, updated_at) VALUES ('c1', 'llama3.2', 1, 1), ('c2', '${HF}', 1, 1), ('c3', NULL, 1, 1);
    INSERT INTO messages (id, conversation_id, role, model, created_at) VALUES ('m1', 'c1', 'assistant', 'qwen3:8b', 1), ('m2', 'c1', 'user', NULL, 2);
    INSERT INTO usage_events (id, model, kind, cost_usd, created_at) VALUES
      ('u1', 'gpt-oss:120b-cloud', 'chat', 0.002, 1), ('u2', 'llama3.2', 'chat', 0, 1), ('u3', 'glm-5.3:cloud', 'title', NULL, 1),
      ('u4', 'kimi-k3', 'chat', 0.5, 1), ('u5', 'qwen3-coder:480b-cloud', 'chat', 0, 1);
    INSERT INTO traces (id, kind, model, status, started_at, data) VALUES
      ('t1', 'chat', 'llama3.2', 'ok', 1, '{"request":{"model":"llama3.2"}}'), ('t2', 'tool', NULL, 'ok', 1, '{}');
    INSERT INTO model_profiles (model, info, overrides) VALUES ('${HF}', '{"capabilities":["completion"]}', '{"artifacts":false}');
  `)
  d.close()
  return file
}

describe('the model-key migration', () => {
  it('puts every stored model on the ollama endpoint, hf.co names whole (Review Focus #1)', () => {
    openDatabase(oldDatabase(folder()))
    expect(all('SELECT id, model FROM conversations ORDER BY id')).toEqual([
      { id: 'c1', model: 'ollama/llama3.2' },
      { id: 'c2', model: `ollama/${HF}` },
      { id: 'c3', model: null }
    ])
    expect(all('SELECT id, model FROM messages ORDER BY id')).toEqual([
      { id: 'm1', model: 'ollama/qwen3:8b' },
      { id: 'm2', model: null }
    ])
    expect(all('SELECT id, model FROM traces ORDER BY id')).toEqual([
      { id: 't1', model: 'ollama/llama3.2' },
      { id: 't2', model: null }
    ])
    // A trace's request is what was sent, so it keeps the raw name.
    expect(all<{ data: string }>("SELECT data FROM traces WHERE id = 't1'")[0].data).toContain('"model":"llama3.2"')
    expect(all('SELECT model, overrides, detected FROM model_profiles')).toEqual([
      { model: `ollama/${HF}`, overrides: '{"artifacts":false}', detected: '{}' }
    ])
    const c2 = all<{ model: string }>("SELECT model FROM conversations WHERE id = 'c2'")[0]
    expect(splitModelKey(c2.model, ['ollama'])).toEqual({ endpointId: 'ollama', model: HF })
    expect(all('PRAGMA user_version')).toEqual([{ user_version: MIGRATIONS.length }])
  })

  it('marks a usage row priced when it cost something, had no known price, or was a cloud model', () => {
    openDatabase(oldDatabase(folder()))
    expect(all('SELECT id, model, billing FROM usage_events ORDER BY id')).toEqual([
      { id: 'u1', model: 'ollama/gpt-oss:120b-cloud', billing: 'priced' },
      { id: 'u2', model: 'ollama/llama3.2', billing: 'local' },
      { id: 'u3', model: 'ollama/glm-5.3:cloud', billing: 'priced' },
      { id: 'u4', model: 'ollama/kimi-k3', billing: 'priced' },
      { id: 'u5', model: 'ollama/qwen3-coder:480b-cloud', billing: 'priced' }
    ])
  })

  it('backs the database up first, as the older Ollmost left it, once a day', () => {
    const dir = folder()
    const file = oldDatabase(dir)
    openDatabase(file)
    const backup = endpointsBackupPath(join(dir, 'backups'), new Date())
    expect(existsSync(backup)).toBe(true)
    const copy = new DatabaseSync(backup)
    expect(copy.prepare('PRAGMA user_version').get()).toEqual({ user_version: MODEL_KEYS_MIGRATION })
    expect(copy.prepare("SELECT model FROM conversations WHERE id = 'c2'").get()).toEqual({ model: HF })
    copy.close()
    // Opening the migrated database again doesn't touch it, and nor does another old one the same day.
    const made = statSync(backup).mtimeMs
    openDatabase(file)
    openDatabase(oldDatabase(dir, 'other.db'))
    expect(statSync(backup).mtimeMs).toBe(made)
  })

  it('leaves the database as it was when it can’t be backed up, and says why', () => {
    const dir = folder()
    const file = oldDatabase(dir)
    // A file where the backups folder goes: the folder can't be made, and the copy it would hold can't be cleaned up.
    writeFileSync(join(dir, 'backups'), '')
    expect(() => openDatabase(file)).toThrow(/^Ollmost couldn't back up its database before updating it/)
    const d = new DatabaseSync(file)
    expect(d.prepare('PRAGMA user_version').get()).toEqual({ user_version: MODEL_KEYS_MIGRATION })
    d.close()
  })

  it('makes no backup of a new database', () => {
    const dir = folder()
    openDatabase(join(dir, 'ollmost.db'))
    expect(existsSync(join(dir, 'backups'))).toBe(false)
  })

  it('names the backup by the local day', () => {
    expect(endpointsBackupPath('/b', new Date(2026, 8, 7, 23, 30))).toBe('/b/ollmost-before-endpoints-2026-09-07.db')
  })
})
