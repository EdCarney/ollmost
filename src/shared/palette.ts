// Ranking for the command palette: which commands a query means, best first.

export interface Rankable {
  id: string
  title: string
  keywords?: string[]
}

/**
 * How well one word of a query matches `text`: 0 for no match; otherwise 4 for a match at the start, 3 at a word's
 * start, 2 anywhere, 1 as letters in order with gaps.
 */
export function matchScore(query: string, text: string): number {
  const q = query.trim().toLowerCase()
  const t = text.toLowerCase()
  if (!q) return 0
  if (t.startsWith(q)) return 4
  if (t.split(/[\s/›-]+/).some((w) => w.startsWith(q))) return 3
  if (t.includes(q)) return 2
  let i = 0
  for (const ch of t) if (ch === q[i]) i++
  return i === q.length ? 1 : 0
}

/** Words a query may carry that name no command: "set default model", "open settings", "go to chats". */
const FILLER = new Set(['set', 'change', 'open', 'go', 'to', 'the', 'a', 'an', 'toggle', 'show', 'switch', 'my'])

/** The words of a query, filler left out unless that leaves nothing. */
function words(query: string): string[] {
  const all = query.trim().toLowerCase().split(/\s+/).filter(Boolean)
  const kept = all.filter((w) => !FILLER.has(w))
  return kept.length ? kept : all
}

/**
 * A command's score for a query: every word must match its title or a keyword, a match in the title counting more
 * than the same match in a keyword; 0 when a word matches nothing.
 */
function commandScore(query: string, c: Rankable): number {
  let total = 0
  for (const w of words(query)) {
    const inTitle = matchScore(w, c.title)
    const inKeyword = Math.max(0, ...(c.keywords ?? []).map((k) => matchScore(w, k)))
    const best = Math.max(inTitle * 10, inKeyword)
    if (!best) return 0
    total += best
  }
  return total
}

const NEVER = Number.MAX_SAFE_INTEGER

/**
 * Commands for a query, best first; among equal matches the recents (ids, most recent first) come first, then the
 * given order. With nothing typed: the recents in their order, then the rest as given.
 */
export function rankCommands<T extends Rankable>(query: string, commands: T[], recent: string[]): T[] {
  const recency = (c: T) => {
    const i = recent.indexOf(c.id)
    return i === -1 ? NEVER : i
  }
  if (!query.trim()) return [...commands].sort((a, b) => recency(a) - recency(b))
  return commands
    .map((c, order) => ({ c, order, score: commandScore(query, c) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || recency(a.c) - recency(b.c) || a.order - b.order)
    .map((x) => x.c)
}
