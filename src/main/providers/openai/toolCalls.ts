import type { ChatMessage, IdentifiedToolCall } from '../types'
import { isRecord } from '../json'

interface Slot {
  id: string
  name: string
  args: string
}

/** Arguments as the loop takes them: parsed JSON, else the raw text (argsOf copes with a string). */
function parseArgs(text: string): Record<string, unknown> | string {
  if (!text.trim()) return {}
  try {
    const value: unknown = JSON.parse(text)
    return isRecord(value) ? value : text
  } catch {
    return text
  }
}

/**
 * An id of Ollmost's own, for a tool call whose server sent none: 't' and `n` in base 36, padded to 8 digits — 9
 * letters and digits, the only shape Mistral's chat templates on vLLM accept. `n` is fixed by the caller (see
 * `finish` and `firstMadeUpId`) so a turn's rounds never hand out the same id twice.
 */
export function madeUpToolCallId(n: number): string {
  return `t${n.toString(36).padStart(8, '0')}`
}

const MADE_UP_ID = /^t[0-9a-z]{8}$/

/**
 * Where this turn's next round should start numbering its made-up ids from: one past the highest number already used
 * by a made-up id (`t…`) among the tool calls in `messages`. A server's own id and an earlier turn's `c…` id don't
 * match, so they're ignored; 0 when the history holds no made-up id yet.
 */
export function firstMadeUpId(messages: readonly ChatMessage[]): number {
  let highest = -1
  for (const message of messages) {
    for (const call of message.toolCalls ?? []) {
      if (typeof call.id === 'string' && MADE_UP_ID.test(call.id)) {
        const n = parseInt(call.id.slice(1), 36)
        if (n > highest) highest = n
      }
    }
  }
  return highest + 1
}

/**
 * Collects streamed tool-call fragments by `index`: the first carries the id and the name, later ones append to the
 * arguments. The calls come out whole, since the loop only ever runs complete calls. Arguments are joined as raw text
 * and parsed once at the end, so an escape or a character split across fragments can't break them.
 */
export function createToolCallAccumulator(): { add(deltas: unknown[]): void; finish(first?: number): IdentifiedToolCall[] } {
  const slots = new Map<number, Slot>()
  let last = -1
  return {
    add(deltas) {
      for (const d of deltas) {
        if (!isRecord(d)) continue
        const id = typeof d.id === 'string' ? d.id : ''
        let index: number
        if (typeof d.index === 'number') index = d.index
        // A server that sends each call whole may leave out `index`: the first call, or a new id, starts a new one.
        else if (last < 0 || (id && slots.get(last)?.id && slots.get(last)?.id !== id))
          index = slots.size ? Math.max(...slots.keys()) + 1 : 0
        else index = last
        last = index
        const slot = slots.get(index) ?? { id: '', name: '', args: '' }
        slots.set(index, slot)
        if (id && !slot.id) slot.id = id
        const fn = isRecord(d.function) ? d.function : {}
        // Most servers send the name once; some repeat it with every fragment.
        if (typeof fn.name === 'string' && fn.name && fn.name !== slot.name) slot.name += fn.name
        if (typeof fn.arguments === 'string') slot.args += fn.arguments
        else if (isRecord(fn.arguments)) slot.args = JSON.stringify(fn.arguments)
      }
    },
    // `first` numbers a call with no id from where this turn's earlier rounds left off (see firstMadeUpId), so a
    // later round's request never repeats an id this round made up.
    finish(first = 0) {
      return (
        [...slots.entries()]
          .sort(([a], [b]) => a - b)
          .map(([, slot]) => slot)
          // A call with no name can't run: the loop would report a tool called "".
          .filter((slot) => slot.name)
          .map((slot, n) => ({
            id: slot.id || madeUpToolCallId(first + n),
            function: { name: slot.name, arguments: parseArgs(slot.args) }
          }))
      )
    }
  }
}
