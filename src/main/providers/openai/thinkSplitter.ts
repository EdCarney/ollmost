const OPEN = '<think>'
const CLOSE = '</think>'

/**
 * How far into a reply a `</think>` still closes a block the chat template opened in the prompt (the reply starts
 * mid-thinking). A reply that doesn't start with `<think>` is held back only until it's this long plus a tag, so plain
 * replies still start promptly.
 */
export const THINK_NEAR_START = 64

export interface ThinkSplit {
  content: string
  thinking: string
}

/** How many characters at the end of `text` could be the first part of `tag`, split across chunks. */
function partialTail(text: string, tag: string): number {
  for (let k = Math.min(tag.length - 1, text.length); k > 0; k--) if (text.endsWith(tag.slice(0, k))) return k
  return 0
}

/**
 * Splits `<think>…</think>` reasoning out of streamed content, for servers that leave it in the text. Only a leading
 * block counts, so a reply that talks about the tags keeps them.
 */
export function createThinkSplitter(): { push(text: string): ThinkSplit; flush(): ThinkSplit } {
  let mode: 'start' | 'thinking' | 'content' = 'start'
  let held = ''
  // Right after a tag, the whitespace before the next text belongs to neither part.
  let trimNext = false

  const emit = (out: ThinkSplit, part: keyof ThinkSplit, text: string) => {
    if (trimNext) {
      text = text.replace(/^\s+/, '')
      if (text) trimNext = false
    }
    out[part] += text
  }

  const close = (out: ThinkSplit, at: number) => {
    emit(out, 'thinking', held.slice(0, at))
    held = held.slice(at + CLOSE.length)
    mode = 'content'
    trimNext = true
  }

  const run = (final: boolean): ThinkSplit => {
    const out: ThinkSplit = { content: '', thinking: '' }
    for (;;) {
      if (mode === 'content') {
        emit(out, 'content', held)
        held = ''
        return out
      }
      if (mode === 'thinking') {
        const at = held.indexOf(CLOSE)
        if (at >= 0) {
          close(out, at)
          continue
        }
        const keep = final ? 0 : partialTail(held, CLOSE)
        emit(out, 'thinking', held.slice(0, held.length - keep))
        held = held.slice(held.length - keep)
        return out
      }
      // At the start: a thinking block, a reply that began mid-thinking, or a plain reply?
      const lead = held.trimStart()
      if (lead.startsWith(OPEN)) {
        held = lead.slice(OPEN.length)
        mode = 'thinking'
        trimNext = true
        continue
      }
      const at = held.indexOf(CLOSE)
      if (at >= 0 && at < THINK_NEAR_START && !held.slice(0, at).includes(OPEN)) {
        close(out, at)
        continue
      }
      // Still possibly `<think>`, or short enough that a `</think>` near the start could yet arrive.
      const undecided = OPEN.startsWith(lead) || held.length < THINK_NEAR_START + CLOSE.length - 1
      if (undecided && !final) return out
      mode = 'content'
    }
  }

  return {
    push(text) {
      held += text
      return run(false)
    },
    flush: () => run(true)
  }
}
