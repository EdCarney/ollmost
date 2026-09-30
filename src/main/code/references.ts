import { findAtTokens, normalizeAtPath } from '@shared/atRefs'
import type { MessageReference } from '@shared/types'
import { capText, TOOL_RESULT_CHARS } from '../chat/results'
import type { Workspace } from '../runner/workspace'
import { listFiles, listingText, pathKind, readFile, Refused } from './files'

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
    // Another spelling of a path already found ("./src/a.ts" after "src/a.ts", "src/" after "src") is that reference,
    // not read again.
    const known = foundAs(refs, token.path)
    if (known) {
      known.tokens.push(token.path)
      continue
    }
    const ref = await resolveOne(ws, token.path, Math.min(TOOL_RESULT_CHARS, room) - BLOCK_CHARS)
    if (!ref) continue
    // Should two spellings still only turn out the same once read, they're one reference all the same.
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

/**
 * The reference already found for `given`'s path, spelled another way. A token's path as locate finds it is the token
 * normalized, less a folder's "/": a token never starts at "/" or has a "..", and "." and empty parts are dropped both ways.
 */
function foundAs(refs: MessageReference[], given: string): MessageReference | undefined {
  const path = normalizeAtPath(given) || './'
  return refs.find((r) => r.path === path || (r.kind === 'folder' && r.path === `${path}/`))
}

async function resolveOne(ws: Workspace, given: string, room: number): Promise<MessageReference | null> {
  const tokens = [given]
  const normal = normalizeAtPath(given)
  // "src/" and "./" name only a folder: "a.ts/" is nothing, as it is to `cat a.ts/` (and to the composer's marks).
  const folderOnly = normal === '' || normal.endsWith('/')
  try {
    if (room < MIN_ROOM) return await pastTheLimit(ws, given, folderOnly)
    if (!folderOnly) {
      try {
        const r = await readFile(ws, given, { maxChars: room })
        return { tokens, path: r.rel, kind: 'file', lines: { from: r.from, to: r.to, total: r.total }, text: r.text }
      } catch (err) {
        if (!(err instanceof Refused) || err.reason !== 'is a folder') throw err
      }
    }
    // A file named as a folder is refused here as "not a folder", which is nothing.
    const listing = await listFiles(ws, { path: given })
    const whole = listingText(listing)
    const text = capText(whole, room)
    return { tokens, path: folderPath(listing.rel), kind: 'folder', ...(listing.cut || text !== whole ? { cut: true } : {}), text }
  } catch (err) {
    if (!(err instanceof Refused)) throw err
    if (NAMES_NOTHING.has(err.reason) || folderOnly) return null
    return { tokens, path: normal, kind: 'file', refused: err.reason, text: err.message }
  }
}

/** A reference past the message's limit: named, so the model knows of it, but not read. Null when it names nothing. */
async function pastTheLimit(ws: Workspace, given: string, folderOnly: boolean): Promise<MessageReference | null> {
  // By what a link leads to: a link to a folder is a folder.
  const found = await pathKind(ws, given)
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
