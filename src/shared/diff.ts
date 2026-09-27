/** Lines a unified diff adds and removes. */
export function diffCounts(diff: string): { added: number; removed: number } {
  let added = 0
  let removed = 0
  // The --- and +++ header lines come before the first hunk. Counting by position rather than by prefix keeps a
  // removed line that itself starts with "--" (a Markdown rule reads "----") from passing for a header.
  let inHunk = false
  for (const line of diff.split('\n')) {
    if (line.startsWith('@@')) inHunk = true
    else if (!inHunk) continue
    else if (line.startsWith('+')) added++
    else if (line.startsWith('-')) removed++
  }
  return { added, removed }
}
