import { join } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { getDb, openDatabase, transaction } from '../src/main/db/index'
import { paths } from '../src/main/paths'
import {
  createConversation,
  deleteConversation,
  deleteMessagesFrom,
  getMessage,
  insertMessage,
  updateMessage,
  listCodeRoots,
  listConversations,
  listMessages,
  search,
  setCompaction,
  setConversationRoot,
  setMessageReferences,
  updateConversation
} from '../src/main/db/conversations'
import {
  createProject,
  deleteProject,
  insertProjectFile,
  listProjectFiles,
  moveProjectFile,
  projectFileOnDisk,
  projectKnowledge
} from '../src/main/db/projects'
import { conversationUsage, insertUsageEvent, usageSummary } from '../src/main/db/usage'
import { tempDir } from './tempDir'

beforeAll(() => openDatabase(':memory:'))

const chat = (projectId: string | null = null) => createConversation({ projectId, model: 'm', think: null, skills: [], toolSources: [] })
const session = (root: string) =>
  createConversation({ projectId: null, model: 'm', think: null, skills: [], toolSources: [], mode: 'code', root })
const say = (conversationId: string, content: string) => insertMessage({ conversationId, parentId: null, role: 'user', content })

const indexedMessages = (conversationId: string) =>
  (
    getDb().prepare('SELECT COUNT(*) AS n FROM search_index WHERE conversation_id = ? AND message_id IS NOT NULL').get(conversationId) as {
      n: number
    }
  ).n

/** Make the next DELETE on `table` fail, as a disk or constraint error would halfway through. */
function failNextDelete(table: string): () => void {
  getDb().exec(`CREATE TEMP TRIGGER fail_delete BEFORE DELETE ON ${table} BEGIN SELECT RAISE(ABORT, 'disk on fire'); END`)
  return () => getDb().exec('DROP TRIGGER IF EXISTS fail_delete')
}

describe('transactional deletes', () => {
  it('deleting a chat that fails halfway leaves it searchable, not half-deleted', () => {
    const c = chat()
    say(c.id, 'zebra crossing notes')
    const undo = failNextDelete('conversations')
    expect(() => deleteConversation(c.id)).toThrow(/disk on fire/)
    undo()
    // The search rows removed before the failure were rolled back with it.
    expect(search('zebra').map((h) => h.conversationId)).toContain(c.id)
  })

  it('trimming messages that fails halfway keeps both the messages and their search rows', () => {
    const c = chat()
    const first = say(c.id, 'first aardvark')
    say(c.id, 'second aardvark')
    const undo = failNextDelete('messages')
    expect(() => deleteMessagesFrom(c.id, first.createdAt)).toThrow(/disk on fire/)
    undo()
    expect(listMessages(c.id)).toHaveLength(2)
    expect(indexedMessages(c.id)).toBe(2)
  })

  it('trimming messages removes them and their search rows together', () => {
    const c = chat()
    say(c.id, 'keep this okapi')
    const second = say(c.id, 'drop this quokka')
    deleteMessagesFrom(c.id, second.createdAt)
    expect(listMessages(c.id).map((m) => m.content)).toEqual(['keep this okapi'])
    expect(search('quokka')).toHaveLength(0)
    expect(search('okapi').map((h) => h.conversationId)).toContain(c.id)
  })

  it('deleting a project that fails halfway keeps its chats searchable', () => {
    const p = createProject({ name: 'P' })
    const c = chat(p.id)
    say(c.id, 'narwhal plans')
    const undo = failNextDelete('projects')
    expect(() => deleteProject(p.id)).toThrow(/disk on fire/)
    undo()
    expect(search('narwhal').map((h) => h.conversationId)).toContain(c.id)
  })
})

describe('transaction', () => {
  it('lets a nested call join the outer transaction, and rolls back all of it', () => {
    getDb().exec('CREATE TABLE IF NOT EXISTS t (v INTEGER)')
    expect(() =>
      transaction(() => {
        getDb().exec('INSERT INTO t VALUES (1)')
        transaction(() => getDb().exec('INSERT INTO t VALUES (2)'))
        throw new Error('outer fails')
      })
    ).toThrow('outer fails')
    expect(getDb().prepare('SELECT COUNT(*) AS n FROM t').get()).toEqual({ n: 0 })
    // And the depth counter recovered: a fresh transaction still commits.
    transaction(() => getDb().exec('INSERT INTO t VALUES (3)'))
    expect(getDb().prepare('SELECT COUNT(*) AS n FROM t').get()).toEqual({ n: 1 })
  })
})

describe('code sessions', () => {
  const ids = (mode?: 'chat' | 'code') => listConversations({ mode, limit: 100_000 }).map((c) => c.id)

  it('are listed apart from chats, or with them', () => {
    const c = chat()
    const s = session('/work/split')
    expect(ids('chat')).toContain(c.id)
    expect(ids('chat')).not.toContain(s.id)
    expect(ids('code')).toContain(s.id)
    expect(ids('code')).not.toContain(c.id)
    expect(ids()).toEqual(expect.arrayContaining([c.id, s.id]))
  })

  it('keep the title and network they’re made with; a chat gets the defaults', () => {
    expect(chat()).toMatchObject({ mode: 'chat', root: null, title: 'New chat', network: 'none' })
    const s = createConversation({
      projectId: null,
      model: 'm',
      think: null,
      skills: [],
      mode: 'code',
      root: '/work/wombat',
      network: 'registries',
      title: 'wombat'
    })
    expect(s).toMatchObject({ mode: 'code', root: '/work/wombat', title: 'wombat', network: 'registries' })
    expect(search('wombat').map((h) => h.conversationId)).toContain(s.id)
  })

  it('marks a search hit with its conversation’s mode', () => {
    const c = chat()
    say(c.id, 'pangolin notes')
    const s = createConversation({
      projectId: null,
      model: 'm',
      think: null,
      skills: [],
      mode: 'code',
      root: '/work/pangolin',
      title: 'pangolin'
    })
    expect(search('pangolin').find((h) => h.conversationId === c.id)).toMatchObject({ mode: 'chat' })
    expect(search('pangolin').find((h) => h.conversationId === s.id)).toMatchObject({ mode: 'code' })
  })

  it('change their network through a patch, and keep it through other changes', () => {
    const s = session('/work/net')
    expect(s.network).toBe('none')
    expect(updateConversation(s.id, { network: 'registries-git' })).toMatchObject({ network: 'registries-git', root: '/work/net' })
    expect(updateConversation(s.id, { title: 'Renamed' })).toMatchObject({ title: 'Renamed', network: 'registries-git' })
  })

  it('change their folder only through setConversationRoot, never through a patch the renderer could send', () => {
    const s = session('/work/before')
    expect(updateConversation(s.id, { root: '/x' } as never)).toMatchObject({ root: '/work/before' })
    expect(setConversationRoot(s.id, '/work/after')).toMatchObject({ id: s.id, mode: 'code', root: '/work/after' })
    expect(updateConversation(s.id, { title: 'Moved' })).toMatchObject({ title: 'Moved', root: '/work/after' })
    expect(() => setConversationRoot(chat().id, '/work/x')).toThrow(/Not a code session/)
    expect(() => setConversationRoot('no-such-id', '/work/x')).toThrow(/not found/)
  })

  it('give their folders each once, the one with the newest session first, at most as many as asked', () => {
    for (const id of ids('code')) deleteConversation(id)
    session('/work/a')
    const b = session('/work/b')
    session('/work/c')
    session('/work/a')
    chat()
    expect(listCodeRoots()).toEqual(['/work/a', '/work/c', '/work/b'])
    updateConversation(b.id, { touch: true })
    expect(listCodeRoots()).toEqual(['/work/b', '/work/a', '/work/c'])
    expect(listCodeRoots(2)).toEqual(['/work/b', '/work/a'])
    for (let i = 0; i < 10; i++) session(`/work/many-${i}`)
    expect(listCodeRoots()).toEqual([
      '/work/many-9',
      '/work/many-8',
      '/work/many-7',
      '/work/many-6',
      '/work/many-5',
      '/work/many-4',
      '/work/many-3',
      '/work/many-2'
    ])
  })
})

describe('usage summary', () => {
  it('sums between the given moments when asked, and over the last days otherwise', () => {
    // A model of this test's own, so its rows are told from any other test's.
    const model = 'summary-test-model'
    const event = {
      conversationId: null,
      messageId: null,
      model,
      kind: 'chat' as const,
      completionTokens: 10,
      billing: 'priced' as const,
      estimated: false
    }
    const mine = (s: ReturnType<typeof usageSummary>) => s.byModel.find((m) => m.model === model)
    insertUsageEvent({ ...event, promptTokens: 100, costUsd: 1 })
    insertUsageEvent({ ...event, promptTokens: 200, costUsd: 2 })
    insertUsageEvent({ ...event, promptTokens: 400, costUsd: 4 })
    const day = 86_400_000
    const since = Date.now() - 5 * day
    const until = Date.now() - 2 * day
    // Date the rows: one before the period, one inside it, one after it.
    const date = (promptTokens: number, at: number) =>
      getDb().prepare('UPDATE usage_events SET created_at = ? WHERE model = ? AND prompt_tokens = ?').run(at, model, promptTokens)
    date(100, since - 60_000)
    date(200, since + 60_000)
    date(400, until + 60_000)
    expect(mine(usageSummary([], 30))).toMatchObject({ requests: 3, promptTokens: 700, costUsd: 7 })
    expect(mine(usageSummary([], 30, since))).toMatchObject({ requests: 2, promptTokens: 600, costUsd: 6 })
    expect(mine(usageSummary([], 30, since, until))).toMatchObject({ requests: 1, promptTokens: 200, costUsd: 2 })
  })
})

describe('a chat’s last context tokens (the meter) after history changes', () => {
  const usageCreatedAt = (messageId: string) =>
    (getDb().prepare('SELECT created_at AS c FROM usage_events WHERE message_id = ?').get(messageId) as { c: number }).c

  it('goes null right after a compaction, not the stale pre-compaction total', () => {
    const c = chat()
    const m1 = say(c.id, 'before compacting')
    insertUsageEvent({
      conversationId: c.id,
      messageId: m1.id,
      model: 'm',
      kind: 'chat',
      promptTokens: 90_000,
      completionTokens: 10_000,
      costUsd: 0,
      billing: 'local',
      estimated: false
    })
    const at1 = usageCreatedAt(m1.id)
    setCompaction(c.id, { summary: 'so far…', upTo: at1, messages: 1, at: at1 + 1 })
    expect(conversationUsage(c.id, []).lastContextTokens).toBeNull()
  })

  it('counts again once a reply lands after the compaction', () => {
    const c = chat()
    const m1 = say(c.id, 'before compacting')
    insertUsageEvent({
      conversationId: c.id,
      messageId: m1.id,
      model: 'm',
      kind: 'chat',
      promptTokens: 90_000,
      completionTokens: 10_000,
      costUsd: 0,
      billing: 'local',
      estimated: false
    })
    const at1 = usageCreatedAt(m1.id)
    setCompaction(c.id, { summary: 'so far…', upTo: at1, messages: 1, at: at1 + 1 })
    const m2 = say(c.id, 'after compacting')
    insertUsageEvent({
      conversationId: c.id,
      messageId: m2.id,
      model: 'm',
      kind: 'chat',
      promptTokens: 4_000,
      completionTokens: 1_000,
      costUsd: 0,
      billing: 'local',
      estimated: false
    })
    expect(conversationUsage(c.id, []).lastContextTokens).toBe(5_000)
  })

  it('skips a row whose message was deleted (an Edit or Retry), falling back to an earlier one', () => {
    const c = chat()
    const m1 = say(c.id, 'kept')
    insertUsageEvent({
      conversationId: c.id,
      messageId: m1.id,
      model: 'm',
      kind: 'chat',
      promptTokens: 2_000,
      completionTokens: 500,
      costUsd: 0,
      billing: 'local',
      estimated: false
    })
    const m2 = say(c.id, 'edited away')
    insertUsageEvent({
      conversationId: c.id,
      messageId: m2.id,
      model: 'm',
      kind: 'chat',
      promptTokens: 9_000,
      completionTokens: 1_000,
      costUsd: 0,
      billing: 'local',
      estimated: false
    })
    deleteMessagesFrom(c.id, m2.createdAt)
    expect(conversationUsage(c.id, []).lastContextTokens).toBe(2_500)
  })
})

describe('a message’s thinking segments', () => {
  it('round-trips them, and reads none for a message saved before they existed', () => {
    const c = chat()
    const m = insertMessage({ conversationId: c.id, parentId: null, role: 'assistant', content: 'Answer.' })
    expect(getMessage(m.id)?.thinkingSegments).toBeNull()
    const segments = [
      { text: 'Plan.', at: 0, index: 0, ms: 120 },
      { text: 'Check.', at: 7, index: 1, ms: null }
    ]
    updateMessage(m.id, { thinking: 'Plan.Check.', thinkingSegments: segments })
    expect(getMessage(m.id)).toMatchObject({ thinking: 'Plan.Check.', thinkingSegments: segments })
    // A patch without segments keeps them.
    updateMessage(m.id, { error: null })
    expect(getMessage(m.id)?.thinkingSegments).toEqual(segments)
  })
})

describe('a code session’s stage', () => {
  it('starts in working mode with no plan, and keeps a stage and a plan when set', () => {
    const c = session('/Users/me/repo')
    expect(c).toMatchObject({ stage: 'work', plan: null })
    expect(updateConversation(c.id, { stage: 'plan' })).toMatchObject({ stage: 'plan', plan: null })
    expect(updateConversation(c.id, { stage: 'work', plan: 'Read, then edit.' })).toMatchObject({ stage: 'work', plan: 'Read, then edit.' })
    // A patch that says nothing about them leaves them alone.
    expect(updateConversation(c.id, { title: 'Renamed' })).toMatchObject({ stage: 'work', plan: 'Read, then edit.' })
    expect(updateConversation(c.id, { plan: null })).toMatchObject({ plan: null })
  })
})

describe('a project’s files in folders', () => {
  const data = tempDir('ollmost-db-files-')
  beforeAll(() => {
    paths.data = data
  })
  const file = (projectId: string, name: string, folder: string) =>
    insertProjectFile({
      id: `${projectId}-${folder}-${name}`,
      project_id: projectId,
      name,
      mime: 'text/plain',
      size: 3,
      path: join(data, 'files', name),
      text: 'hey',
      token_est: 1,
      folder
    })

  it('keeps each file’s folder, normalized, and names the knowledge by its path', () => {
    const p = createProject({ name: 'Trip' })
    expect(file(p.id, 'readme.md', '').folder).toBe('')
    expect(file(p.id, 'brief.txt', '/docs/').folder).toBe('docs')
    expect(listProjectFiles(p.id).map((f) => `${f.folder}|${f.name}`)).toEqual(['|readme.md', 'docs|brief.txt'])
    expect(projectKnowledge(p.id).map((k) => k.name)).toEqual(['readme.md', 'docs/brief.txt'])
  })

  it('moves a file to another folder', () => {
    const p = createProject({ name: 'Move' })
    const f = file(p.id, 'notes.md', 'docs')
    expect(moveProjectFile(f.id, 'archive/2026').folder).toBe('archive/2026')
    expect(moveProjectFile(f.id, '').folder).toBe('')
    expect(listProjectFiles(p.id)[0].folder).toBe('')
    expect(() => moveProjectFile('missing', 'docs')).toThrow('File not found')
  })

  it('says where a file is kept and what it is called, and nothing for a missing id', () => {
    const p = createProject({ name: 'Disk' })
    const f = file(p.id, 'notes.md', 'docs')
    const onDisk = projectFileOnDisk(f.id)
    expect(onDisk?.name).toBe('notes.md')
    expect(onDisk?.path.startsWith(paths.data)).toBe(true)
    expect(projectFileOnDisk('missing')).toBeNull()
  })
})

describe('message references', () => {
  it('are null until kept, come back with the message, and can be forgotten', () => {
    const c = session('/w/refs')
    const m = say(c.id, 'see @a.ts')
    expect(m.references).toBeNull()
    const refs = [{ tokens: ['a.ts'], path: 'a.ts', kind: 'file' as const, lines: { from: 1, to: 1, total: 1 }, text: '     1\tx' }]
    setMessageReferences(m.id, refs)
    expect(getMessage(m.id)!.references).toEqual(refs)
    expect(listMessages(c.id)[0].references).toEqual(refs)
    // An edit of the message's text keeps them; only setMessageReferences changes them.
    updateMessage(m.id, { content: 'see @a.ts again' })
    expect(getMessage(m.id)!.references).toEqual(refs)
    setMessageReferences(m.id, null)
    expect(getMessage(m.id)!.references).toBeNull()
  })
})
