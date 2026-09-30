import { stat } from 'node:fs/promises'
import { findAtTokens, normalizeAtPath } from '@shared/atRefs'
import type { MessageReference } from '@shared/types'
import { capText, TOOL_RESULT_CHARS } from '../chat/results'
import { readyForSession, type Workspace } from '../runner/workspace'
import { listFiles, listingText, locate, readFile, Refused } from './files'

// The files and folders a code session's message names with @ (#129), read as read_file and list_files read them,
// through the same confined reader, so a link that leaves the folder is refused and nothing is read while a command runs.
// Each read takes the session's lock on its own, one after another: a read inside another's lock would wait for itself.

/** All of one message's references together, in characters: two read_file results' worth. */
export const REFERENCES_TOTAL_CHARS = 2 * TOOL_RESULT_CHARS
/** What a reference's block adds around its text: the tag, its path and its line range. */
const BLOCK_CHARS = 200
/** Below this much room a file isn't read: a few lines of it would only mislead. */
const MIN_ROOM = 1_000
/** Refusals that mean a token names nothing the model may see: it stays plain text, and nothing is sent. */
const NAMES_NOTHING = new Set(['no path', 'bad path', 'outside the folder', 'not found', 'broken link'])

/**
 * What `text`'s @ tokens name in the session's folder, in the order the message names them: a file's numbered lines,
 * cut to the room left; a folder's listing; or why it wasn't sent. Throws the lock's and the folder's errors (a command
 * running, the folder gone), so the reply can leave them unread for a Retry.
 */
export async function resolveReferences(ws: Workspace, text: string): Promise<MessageReference[]> {
  const refs: MessageReference[] = []
  // A spelling already looked at is the reference made from it, or nothing again.
  const seen = new Set<string>()
  let room = REFERENCES_TOTAL_CHARS
  for (const token of findAtTokens(text)) {
    if (seen.has(token.path)) continue
    seen.add(token.path)
    const ref = await resolveOne(ws, token.path, Math.min(TOOL_RESULT_CHARS, room) - BLOCK_CHARS)
    if (!ref) continue
    // Another spelling of a path already read ("./src/a.ts" after "src/a.ts") is the same reference.
    const same = refs.find((r) => r.path === ref.path)
    if (same) {
      same.tokens.push(token.path)
      continue
    }
    refs.push(ref)
    room -= ref.text.length + BLOCK_CHARS
  }
  return refs
}

/** A folder's path as a reference gives it: ending in "/", and "./" for the session's folder itself. */
const folderPath = (rel: string): string => (rel ? `${rel}/` : './')

async function resolveOne(ws: Workspace, given: string, room: number): Promise<MessageReference | null> {
  const tokens = [given]
  // "a.ts/" names a folder, so a file there is nothing, as it is to `cat a.ts/` (and to the composer's marks).
  const folderOnly = normalizeAtPath(given).endsWith('/')
  try {
    if (room < MIN_ROOM) return await pastTheLimit(ws, given, folderOnly)
    try {
      const r = await readFile(ws, given, { maxChars: room })
      if (folderOnly) return null
      return { tokens, path: r.rel, kind: 'file', lines: { from: r.from, to: r.to, total: r.total }, text: r.text }
    } catch (err) {
      if (!(err instanceof Refused) || err.reason !== 'is a folder') throw err
    }
    const listing = await listFiles(ws, { path: given })
    const whole = listingText(listing)
    const text = capText(whole, room)
    return { tokens, path: folderPath(listing.rel), kind: 'folder', ...(listing.cut || text !== whole ? { cut: true } : {}), text }
  } catch (err) {
    if (!(err instanceof Refused)) throw err
    if (NAMES_NOTHING.has(err.reason) || folderOnly) return null
    return { tokens, path: normalizeAtPath(given), kind: 'file', refused: err.reason, text: err.message }
  }
}

/** A reference past the message's limit: named, so the model knows of it, but not read. Null when it names nothing. */
async function pastTheLimit(ws: Workspace, given: string, folderOnly: boolean): Promise<MessageReference | null> {
  const found = await readyForSession(ws, async (root) => {
    const located = await locate(root, given)
    // By what a link leads to, which locate found inside the folder: a link to a folder is a folder.
    const s = located.target && (await stat(located.real).catch(() => null))
    return s && { rel: located.rel, folder: s.isDirectory() }
  })
  if (!found || (folderOnly && !found.folder)) return null
  const path = found.folder ? folderPath(found.rel) : found.rel
  return {
    tokens: [given],
    path,
    kind: found.folder ? 'folder' : 'file',
    refused: 'over the limit',
    text: `This message's references reached their limit of ${REFERENCES_TOTAL_CHARS.toLocaleString('en-US')} characters, so ${path} wasn't included. Use ${found.folder ? 'list_files' : 'read_file'} for it.`
  }
}
