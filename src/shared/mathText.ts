// Math in a reply, before remark-math reads it. remark-math takes any `$…$` as inline math, so two prices in one
// paragraph ("$4.1trn of debt … $420bn") became one formula. A `$` that Pandoc wouldn't read as math is escaped
// first: an opening `$` has a non-space right after it, and the math closes at the next `$`, in the same paragraph,
// only if that one has a non-space right before it and no digit right after it. Code spans, fenced code, `$$…$$`
// display math and `\$` are left as they are. Indented code blocks aren't told apart from prose (models fence code).

/** A code fence: its marker and what follows it. Any indent, since list items and quotes nest fences. */
const FENCE = /^(?:[ \t]*>)*[ \t]*(`{3,}|~{3,})(.*)$/
/** A line that ends the paragraph before it: a blank line, or the start of a list item, heading, quote or table row. */
const BLOCK_START = /[ \t]*(?:\n|$|[-*+][ \t]|\d{1,9}[.)][ \t]|#{1,6}[ \t]|>|\|)/y
/** A bare link, which a `\` would break: its `$` are the link's. */
const BARE_LINK = /(?:https?:\/\/|www\.)[^\s<]*/y

const endsParagraph = (s: string, lineStart: number): boolean => {
  BLOCK_START.lastIndex = lineStart
  return BLOCK_START.test(s)
}

/** Where a code span that starts at `start` ends (just past its closing backticks), or the end of its backticks when none closes it. */
function codeSpanEnd(s: string, start: number): number {
  let n = 0
  while (s[start + n] === '`') n++
  for (let j = start + n; j < s.length;) {
    if (s[j] === '\n' && endsParagraph(s, j + 1)) break
    if (s[j] !== '`') {
      j++
      continue
    }
    let m = 0
    while (s[j + m] === '`') m++
    if (m === n) return j + m
    j += m
  }
  return start + n
}

/** The `$` that closes inline math opened by the `$` at `open`, or -1 when that `$` opens none. */
function closingDollar(s: string, open: number): number {
  if (!/\S/.test(s[open + 1] ?? ' ')) return -1
  for (let j = open + 1; j < s.length; j++) {
    const c = s[j]
    if (c === '\\') j++
    else if (c === '`') j = codeSpanEnd(s, j) - 1
    else if (c === '\n' && endsParagraph(s, j + 1)) return -1
    else if (c === '$') return /\s/.test(s[j - 1]) || /\d/.test(s[j + 1] ?? '') ? -1 : j
  }
  return -1
}

/** Escape the `$` in prose (text outside fenced code) that can't open or close inline math. */
function escapeProse(s: string): string {
  let out = ''
  let i = 0
  while (i < s.length) {
    const c = s[i]
    let end = i + 1
    if (c === '\\') end = i + 2
    else if (c === '`') end = codeSpanEnd(s, i)
    else if ((c === 'h' || c === 'w') && !/\w/.test(s[i - 1] ?? '')) {
      BARE_LINK.lastIndex = i
      if (BARE_LINK.test(s)) end = BARE_LINK.lastIndex
    } else if (c === '$' && s[i + 1] === '$') {
      const close = s.indexOf('$$', i + 2)
      end = close < 0 ? i + 2 : close + 2
    } else if (c === '$') {
      const close = closingDollar(s, i)
      if (close < 0) {
        out += '\\$'
        i++
        continue
      }
      end = close + 1
    }
    out += s.slice(i, end)
    i = end
  }
  return out
}

/** Escape each `$` that can't open or close inline math (a price), so remark-math leaves it as text. */
export function escapeStrayDollars(text: string): string {
  if (!text.includes('$')) return text
  const out: string[] = []
  let prose: string[] = []
  let fence: { char: string; length: number } | null = null
  const flush = () => {
    if (prose.length) out.push(escapeProse(prose.join('\n')))
    prose = []
  }
  for (const line of text.split('\n')) {
    const m = FENCE.exec(line)
    if (fence) {
      out.push(line)
      if (m && m[1][0] === fence.char && m[1].length >= fence.length && !m[2].trim()) fence = null
    } else if (m && !(m[1][0] === '`' && m[2].includes('`'))) {
      // A fence left open (a reply still streaming) runs to the end, as Markdown has it.
      flush()
      out.push(line)
      fence = { char: m[1][0], length: m[1].length }
    } else prose.push(line)
  }
  flush()
  return out.join('\n')
}

/**
 * Text ready for remark-math: prices escaped (above), then the \( \) and \[ \] delimiters models often write turned
 * into the dollars remark-math understands. In that order, so math written with \( \) is never taken for a price.
 */
export function normalizeMath(text: string): string {
  return escapeStrayDollars(text)
    .replace(/\\\[([\s\S]+?)\\\]/g, (_m, inner: string) => `$$${inner}$$`)
    .replace(/\\\(([\s\S]+?)\\\)/g, (_m, inner: string) => `$${inner}$`)
}
