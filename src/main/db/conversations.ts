import type { ConversationPatch } from '@shared/ipc'
import type {
  Attachment,
  CodeNetwork,
  Compaction,
  Conversation,
  Message,
  MessageStats,
  Role,
  SearchHit,
  ThinkingSegment,
  ThinkSetting,
  ToolEvent
} from '@shared/types'
import { isServerAllowKey } from '@shared/toolAllow'
import { fromStored, toStored } from '../paths'
import { now, parseJson, uid } from '../util'
import { all, get, run, transaction } from './index'

// ---- Conversations ------------------------------------------------------

interface ConversationRow {
  id: string
  project_id: string | null
  title: string
  model: string | null
  think: string | null
  skills: string
  auto_skills: string
  instructions: string
  allowed_tools: string
  tool_sources: string
  mode: string
  root: string | null
  network: string
  compaction: string | null
  pinned: number
  created_at: number
  updated_at: number
}

const NETWORKS: readonly CodeNetwork[] = ['none', 'registries', 'registries-git']
/** A stored preset, or the safe one for anything else (a value a later version wrote, say). */
const toNetwork = (v: string): CodeNetwork => (NETWORKS.includes(v as CodeNetwork) ? (v as CodeNetwork) : 'none')

const toConversation = (r: ConversationRow): Conversation => ({
  id: r.id,
  projectId: r.project_id,
  title: r.title,
  model: r.model,
  think: (r.think as ThinkSetting | null) ?? null,
  skills: parseJson<string[]>(r.skills, []),
  autoSkills: parseJson<string[]>(r.auto_skills, []),
  instructions: r.instructions,
  allowedTools: parseJson<string[]>(r.allowed_tools, []),
  toolSources: parseJson<string[]>(r.tool_sources, []),
  mode: r.mode === 'code' ? 'code' : 'chat',
  root: r.root,
  network: toNetwork(r.network),
  compaction: parseJson<Compaction | null>(r.compaction, null),
  pinned: !!r.pinned,
  createdAt: r.created_at,
  updatedAt: r.updated_at
})

/** Keep or clear a chat's /compact summary (main process only; the renderer never sets it). */
export function setCompaction(id: string, compaction: Compaction | null): Conversation {
  run('UPDATE conversations SET compaction = ? WHERE id = ?', compaction ? JSON.stringify(compaction) : null, id)
  return getConversation(id)!
}

export function listConversations(opts: { projectId?: string; limit?: number; mode?: Conversation['mode'] } = {}): Conversation[] {
  const limit = opts.limit ?? 200
  const filters = [
    ['project_id = ?', opts.projectId],
    ['mode = ?', opts.mode]
  ].filter((f): f is [string, string] => f[1] !== undefined)
  const where = filters.map(([clause]) => clause)
  const args = filters.map(([, value]) => value)
  const rows = all<ConversationRow>(
    `SELECT * FROM conversations${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY updated_at DESC LIMIT ?`,
    ...args,
    limit
  )
  return rows.map(toConversation)
}

/** The folders code sessions were opened on, each once, by its most recently updated session: most recent first. */
export function listCodeRoots(limit = 8): string[] {
  return all<{ root: string }>(
    `SELECT root FROM conversations WHERE mode = 'code' AND root IS NOT NULL GROUP BY root ORDER BY MAX(updated_at) DESC LIMIT ?`,
    limit
  ).map((r) => r.root)
}

export function getConversation(id: string): Conversation | null {
  const row = get<ConversationRow>('SELECT * FROM conversations WHERE id = ?', id)
  return row ? toConversation(row) : null
}

export function createConversation(input: {
  projectId: string | null
  model: string
  think: ThinkSetting | null
  skills: string[]
  toolSources?: string[]
  /** A code session works in `root`, a folder of the user's (its real path); a chat, the default, has none. */
  mode?: 'chat' | 'code'
  root?: string | null
  /** A code session's network preset; 'none' unless given. */
  network?: CodeNetwork
  /** A session is titled after its folder from the start; a chat is 'New chat' until its first reply names it. */
  title?: string
}): Conversation {
  const id = uid()
  const t = now()
  const title = input.title?.trim() || 'New chat'
  run(
    `INSERT INTO conversations (id, project_id, title, model, think, skills, tool_sources, mode, root, network, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id,
    input.projectId,
    title,
    input.model,
    input.think,
    JSON.stringify(input.skills),
    JSON.stringify(input.toolSources ?? []),
    input.mode ?? 'chat',
    input.root ?? null,
    input.network ?? 'none',
    t,
    t
  )
  indexTitle(id, title)
  return getConversation(id)!
}

export function updateConversation(
  id: string,
  patch: ConversationPatch & { touch?: boolean; autoSkills?: string[]; allowedTools?: string[] }
): Conversation {
  const c = getConversation(id)
  if (!c) throw new Error('Conversation not found')
  const next = {
    title: patch.title?.trim() || c.title,
    pinned: patch.pinned ?? c.pinned,
    projectId: patch.projectId !== undefined ? patch.projectId : c.projectId,
    model: patch.model !== undefined ? patch.model : c.model,
    think: patch.think !== undefined ? patch.think : c.think,
    skills: patch.skills ?? c.skills,
    autoSkills: patch.autoSkills ?? c.autoSkills,
    instructions: patch.instructions ?? c.instructions,
    allowedTools: patch.allowedTools ?? c.allowedTools,
    toolSources: patch.toolSources ?? c.toolSources,
    network: patch.network ?? c.network
  }
  run(
    `UPDATE conversations SET title = ?, pinned = ?, project_id = ?, model = ?, think = ?, skills = ?, auto_skills = ?,
       instructions = ?, allowed_tools = ?, tool_sources = ?, network = ?, updated_at = ?
     WHERE id = ?`,
    next.title,
    next.pinned ? 1 : 0,
    next.projectId,
    next.model,
    next.think,
    JSON.stringify(next.skills),
    JSON.stringify(next.autoSkills),
    next.instructions,
    JSON.stringify(next.allowedTools),
    JSON.stringify(next.toolSources),
    next.network,
    patch.touch ? now() : c.updatedAt,
    id
  )
  if (next.title !== c.title) indexTitle(id, next.title)
  return getConversation(id)!
}

/**
 * Point a code session at the folder it was moved to. Apart from updateConversation on purpose: a session's root is
 * where a model may write, so it's set only from the main process (code.locate), after validateRoot checked the
 * folder, and never from a patch the renderer sends.
 */
export function setConversationRoot(id: string, root: string): Conversation {
  const c = getConversation(id)
  if (!c) throw new Error('Conversation not found')
  if (c.mode !== 'code') throw new Error('Not a code session')
  run('UPDATE conversations SET root = ? WHERE id = ?', root, id)
  return getConversation(id)!
}

/**
 * Forget an MCP server in every chat: its "Allow for this chat" answers and, when `source` is set (the server was
 * removed), the switch that turns it on. Used when a server is removed or starts running something else, so a chat
 * never extends its trust to a different program.
 */
export function forgetServerInChats(serverId: string, opts: { source: boolean }): void {
  forgetInChats(
    (key) => isServerAllowKey(key, serverId),
    (source) => opts.source && source === `mcp:${serverId}`
  )
}

/** Whether any chat holds this "Allow for this chat" answer. */
export function anyChatAllows(key: string): boolean {
  return !!get<{ one: number }>(
    'SELECT 1 AS one FROM conversations, json_each(conversations.allowed_tools) WHERE json_each.value = ? LIMIT 1',
    key
  )
}

/** Drop one "Allow for this chat" answer from every chat. Returns how many chats had it. */
export function forgetAllowKeyInChats(key: string): number {
  return forgetInChats(
    (k) => k === key,
    () => false
  )
}

function forgetInChats(dropKey: (key: string) => boolean, dropSource: (source: string) => boolean): number {
  const rows = all<{ id: string; allowed_tools: string; tool_sources: string }>('SELECT id, allowed_tools, tool_sources FROM conversations')
  let changed = 0
  transaction(() => {
    for (const r of rows) {
      const allowed = parseJson<string[]>(r.allowed_tools, [])
      const sources = parseJson<string[]>(r.tool_sources, [])
      const keptAllowed = allowed.filter((k) => !dropKey(k))
      const keptSources = sources.filter((s) => !dropSource(s))
      if (keptAllowed.length === allowed.length && keptSources.length === sources.length) continue
      changed++
      run(
        'UPDATE conversations SET allowed_tools = ?, tool_sources = ? WHERE id = ?',
        JSON.stringify(keptAllowed),
        JSON.stringify(keptSources),
        r.id
      )
    }
  })
  return changed
}

export function touchConversation(id: string): void {
  run('UPDATE conversations SET updated_at = ? WHERE id = ?', now(), id)
}

/** Returns on-disk attachment paths so the caller can delete the files. */
export function deleteConversation(id: string): string[] {
  const paths = all<{ path: string }>(
    'SELECT a.path FROM attachments a JOIN messages m ON m.id = a.message_id WHERE m.conversation_id = ?',
    id
  ).map((r) => fromStored(r.path))
  transaction(() => {
    run('DELETE FROM search_index WHERE conversation_id = ?', id)
    run('DELETE FROM conversations WHERE id = ?', id)
  })
  return paths
}

// ---- Messages -----------------------------------------------------------

interface MessageRow {
  id: string
  conversation_id: string
  parent_id: string | null
  role: string
  content: string
  thinking: string | null
  thinking_segments: string | null
  model: string | null
  tool_events: string
  stats: string | null
  error: string | null
  created_at: number
}

const toMessage = (r: MessageRow, attachments: Attachment[]): Message => ({
  id: r.id,
  conversationId: r.conversation_id,
  parentId: r.parent_id,
  role: r.role as Role,
  content: r.content,
  thinking: r.thinking,
  thinkingSegments: parseJson<ThinkingSegment[] | null>(r.thinking_segments, null),
  model: r.model,
  attachments,
  toolEvents: parseJson<ToolEvent[]>(r.tool_events, []),
  stats: parseJson<MessageStats | null>(r.stats, null),
  error: r.error,
  createdAt: r.created_at
})

export function listMessages(conversationId: string): Message[] {
  const rows = all<MessageRow>('SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at', conversationId)
  const byMessage = new Map<string, Attachment[]>()
  for (const a of all<AttachmentRow>(
    `SELECT a.* FROM attachments a JOIN messages m ON m.id = a.message_id
     WHERE m.conversation_id = ? ORDER BY a.created_at`,
    conversationId
  )) {
    const list = byMessage.get(a.message_id!) ?? []
    list.push(toAttachment(a))
    byMessage.set(a.message_id!, list)
  }
  return rows.map((r) => toMessage(r, byMessage.get(r.id) ?? []))
}

export function getMessage(id: string): Message | null {
  const row = get<MessageRow>('SELECT * FROM messages WHERE id = ?', id)
  if (!row) return null
  const atts = all<AttachmentRow>('SELECT * FROM attachments WHERE message_id = ? ORDER BY created_at', id).map(toAttachment)
  return toMessage(row, atts)
}

export function insertMessage(m: {
  conversationId: string
  parentId: string | null
  role: Role
  content: string
  model?: string | null
}): Message {
  const id = uid()
  run(
    `INSERT INTO messages (id, conversation_id, parent_id, role, content, model, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    id,
    m.conversationId,
    m.parentId,
    m.role,
    m.content,
    m.model ?? null,
    now()
  )
  if (m.content) indexMessage(m.conversationId, id, m.content)
  return getMessage(id)!
}

export function updateMessage(
  id: string,
  patch: {
    content?: string
    thinking?: string | null
    thinkingSegments?: ThinkingSegment[] | null
    model?: string | null
    toolEvents?: ToolEvent[]
    stats?: MessageStats | null
    error?: string | null
  }
): Message {
  const m = getMessage(id)
  if (!m) throw new Error('Message not found')
  const segments = patch.thinkingSegments !== undefined ? patch.thinkingSegments : m.thinkingSegments
  run(
    'UPDATE messages SET content = ?, thinking = ?, thinking_segments = ?, model = ?, tool_events = ?, stats = ?, error = ? WHERE id = ?',
    patch.content ?? m.content,
    patch.thinking !== undefined ? patch.thinking : m.thinking,
    segments ? JSON.stringify(segments) : null,
    patch.model !== undefined ? patch.model : m.model,
    JSON.stringify(patch.toolEvents ?? m.toolEvents),
    JSON.stringify(patch.stats !== undefined ? patch.stats : m.stats),
    patch.error !== undefined ? patch.error : m.error,
    id
  )
  if (patch.content !== undefined) indexMessage(m.conversationId, id, patch.content)
  return getMessage(id)!
}

/**
 * Save a streaming reply's progress. Deliberately one UPDATE: this runs every couple of seconds on the
 * main thread, and search indexing waits for the final save (updateMessage).
 */
export function checkpointMessage(
  id: string,
  patch: { content: string; thinking: string | null; thinkingSegments: ThinkingSegment[] | null; toolEvents: ToolEvent[] }
): void {
  run(
    'UPDATE messages SET content = ?, thinking = ?, thinking_segments = ?, tool_events = ? WHERE id = ?',
    patch.content,
    patch.thinking,
    patch.thinkingSegments ? JSON.stringify(patch.thinkingSegments) : null,
    JSON.stringify(patch.toolEvents),
    id
  )
}

/**
 * Assistant messages that never got their final save: every finished reply has stats, even an
 * errored or stopped one, so no stats and no error means the app quit or crashed mid-reply.
 */
export function unfinishedReplyIds(): string[] {
  return all<{ id: string }>(
    `SELECT id FROM messages WHERE role = 'assistant' AND (stats IS NULL OR stats = 'null') AND error IS NULL`
  ).map((r) => r.id)
}

/** Delete messages created at or after `fromCreatedAt` (used by retry and edit). */
export function deleteMessagesFrom(conversationId: string, fromCreatedAt: number): string[] {
  const doomed = 'SELECT id FROM messages WHERE conversation_id = ? AND created_at >= ?'
  return transaction(() => {
    const paths = all<{ path: string }>(`SELECT path FROM attachments WHERE message_id IN (${doomed})`, conversationId, fromCreatedAt).map(
      (r) => fromStored(r.path)
    )
    // One pass over the search index (message_id is an unindexed FTS column), not one per message.
    run(`DELETE FROM search_index WHERE message_id IN (${doomed})`, conversationId, fromCreatedAt)
    run('DELETE FROM messages WHERE conversation_id = ? AND created_at >= ?', conversationId, fromCreatedAt)
    return paths
  })
}

// ---- Attachments --------------------------------------------------------

export interface AttachmentRow {
  id: string
  message_id: string | null
  kind: string
  name: string
  mime: string
  size: number
  path: string
  text: string | null
  token_est: number
  created_at: number
}

const toAttachment = (r: AttachmentRow): Attachment => ({
  id: r.id,
  messageId: r.message_id,
  kind: r.kind as Attachment['kind'],
  name: r.name,
  mime: r.mime,
  size: r.size,
  tokenEstimate: r.token_est,
  textless: r.kind === 'document' && !r.text
})

export function insertAttachment(a: Omit<AttachmentRow, 'created_at' | 'message_id'>): Attachment {
  run(
    `INSERT INTO attachments (id, message_id, kind, name, mime, size, path, text, token_est, created_at)
     VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?, ?)`,
    a.id,
    a.kind,
    a.name,
    a.mime,
    a.size,
    toStored(a.path),
    a.text,
    a.token_est,
    now()
  )
  return toAttachment(getAttachmentRow(a.id)!)
}

const resolved = (r: AttachmentRow): AttachmentRow => ({ ...r, path: fromStored(r.path) })

export function getAttachmentRow(id: string): AttachmentRow | undefined {
  const row = get<AttachmentRow>('SELECT * FROM attachments WHERE id = ?', id)
  return row && resolved(row)
}

export function attachmentRowsForMessage(messageId: string): AttachmentRow[] {
  return all<AttachmentRow>('SELECT * FROM attachments WHERE message_id = ? ORDER BY created_at', messageId).map(resolved)
}

/** Every file attached to a chat's messages, oldest first. */
export function attachmentRowsForConversation(conversationId: string): AttachmentRow[] {
  return all<AttachmentRow>(
    `SELECT a.* FROM attachments a JOIN messages m ON m.id = a.message_id WHERE m.conversation_id = ? ORDER BY a.created_at`,
    conversationId
  ).map(resolved)
}

export function linkAttachments(ids: string[], messageId: string): void {
  for (const id of ids) run('UPDATE attachments SET message_id = ? WHERE id = ? AND message_id IS NULL', messageId, id)
}

export function deletePendingAttachment(id: string): string | null {
  const row = get<{ path: string }>('SELECT path FROM attachments WHERE id = ? AND message_id IS NULL', id)
  if (!row) return null
  run('DELETE FROM attachments WHERE id = ?', id)
  return fromStored(row.path)
}

/** Uploads that were never sent. */
export function staleAttachmentPaths(olderThan: number): string[] {
  const rows = all<{ id: string; path: string }>('SELECT id, path FROM attachments WHERE message_id IS NULL AND created_at < ?', olderThan)
  transaction(() => {
    for (const r of rows) run('DELETE FROM attachments WHERE id = ?', r.id)
  })
  return rows.map((r) => fromStored(r.path))
}

// ---- Search -------------------------------------------------------------

// Replace-in-place: without a transaction a failed insert would leave the message unsearchable.
function indexMessage(conversationId: string, messageId: string, body: string): void {
  transaction(() => {
    run('DELETE FROM search_index WHERE message_id = ?', messageId)
    run('INSERT INTO search_index (conversation_id, message_id, body) VALUES (?, ?, ?)', conversationId, messageId, body)
  })
}

function indexTitle(conversationId: string, title: string): void {
  transaction(() => {
    run('DELETE FROM search_index WHERE conversation_id = ? AND message_id IS NULL', conversationId)
    run('INSERT INTO search_index (conversation_id, message_id, body) VALUES (?, NULL, ?)', conversationId, title)
  })
}

/** Snippets mark matches with \u0001…\u0002 so the renderer can highlight without HTML. */
export function search(query: string): SearchHit[] {
  const terms = query
    .split(/\s+/)
    .map((t) => t.replace(/"/g, '').trim())
    .filter(Boolean)
  if (!terms.length) return []
  const match = terms.map((t) => `"${t}"*`).join(' ')
  const rows = all<{ conversation_id: string; snip: string; title: string; updated_at: number; mode: 'chat' | 'code' }>(
    `SELECT s.conversation_id, snippet(search_index, 2, char(1), char(2), '…', 14) AS snip, c.title, c.updated_at, c.mode
     FROM search_index s JOIN conversations c ON c.id = s.conversation_id
     WHERE search_index MATCH ? ORDER BY rank LIMIT 100`,
    match
  )
  const seen = new Set<string>()
  const hits: SearchHit[] = []
  for (const r of rows) {
    if (seen.has(r.conversation_id)) continue
    seen.add(r.conversation_id)
    hits.push({
      conversationId: r.conversation_id,
      title: r.title,
      snippet: r.snip,
      updatedAt: r.updated_at,
      mode: r.mode === 'code' ? 'code' : 'chat'
    })
  }
  return hits.slice(0, 30)
}
