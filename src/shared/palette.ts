// Ranking for the command palette: which commands a query means, best first.

export interface Rankable {
  id: string
  title: string
  keywords?: string[]
}

/**
 * How well `query` matches `text`: 0 for no match; otherwise 4 for a match at the start, 3 at a word's start, 2
 * anywhere as a whole, 1 as letters in order with gaps.
 */
export function matchScore(query: string, text: string): number {
  const q = query.trim().toLowerCase()
  const t = text.toLowerCase()
  if (!q) return 0
  if (t.startsWith(q)) return 4
  if (t.split(/[\s/-]+/).some((w) => w.startsWith(q))) return 3
  if (t.includes(q)) return 2
  let i = 0
  for (const ch of t) if (ch === q[i]) i++
  return i === q.length ? 1 : 0
}

/** The best match across a command's title and keywords. */
function commandScore(query: string, c: Rankable): number {
  return Math.max(matchScore(query, c.title), ...(c.keywords ?? []).map((k) => matchScore(query, k)))
}

/**
 * Commands for a query, best first; among equal matches the recents (ids, most recent first) come first, then the
 * shorter title ("New chat" before "New code session" for "new"), then the given order. With nothing typed: the
 * recents in their order, then the rest as given.
 */
export function rankCommands<T extends Rankable>(query: string, commands: T[], recent: string[]): T[] {
  const recency = (c: T) => {
    const i = recent.indexOf(c.id)
    return i === -1 ? Infinity : i
  }
  if (!query.trim()) return [...commands].sort((a, b) => recency(a) - recency(b))
  return commands
    .map((c, order) => ({ c, order, score: commandScore(query, c) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || recency(a.c) - recency(b.c) || a.c.title.length - b.c.title.length || a.order - b.order)
    .map((x) => x.c)
}
