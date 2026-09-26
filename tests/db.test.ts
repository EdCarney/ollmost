import { beforeAll, describe, expect, it } from 'vitest'
import { getDb, openDatabase, transaction } from '../src/main/db/index'
import {
  createConversation,
  deleteConversation,
  deleteMessagesFrom,
  insertMessage,
  listCodeRoots,
  listConversations,
  listMessages,
  search,
  setConversationRoot,
  updateConversation
} from '../src/main/db/conversations'
import { createProject, deleteProject } from '../src/main/db/projects'

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
