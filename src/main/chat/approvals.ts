import { ASK_OTHER_CHARS } from '@shared/ask'
import type { AskAnswer, AskQuestion, ToolDecision } from '@shared/types'

// Tool calls waiting for the user, by `messageId:index` (the call's place in its reply): to allow or deny a call, or
// to answer the model's questions (ask_user). A reply waits here until the user answers, or until its stop signal
// fires (Stop, deleting the chat, quitting). Each kind of wait only takes its own kind of answer.

type Waiting =
  | {
      kind: 'decision'
      conversationId: string
      /** The answers this call takes: a call that asks every time can't be allowed for the chat. */
      choices: readonly ToolDecision[]
      answer: (decision: ToolDecision) => void
    }
  | {
      kind: 'question'
      conversationId: string
      /** What was asked: an answer is checked against this, never against anything the renderer sends back. */
      questions: readonly AskQuestion[]
      /** null when the user skipped the questions. */
      answer: (answers: AskAnswer[] | null) => void
    }

const DECISIONS: readonly ToolDecision[] = ['once', 'chat', 'deny']
/** The answers to a call that asks every time. */
export const EVERY_TIME: readonly ToolDecision[] = ['once', 'deny']
const waiting = new Map<string, Waiting>()
const listeners = new Set<(count: number) => void>()

const key = (messageId: string, index: number) => `${messageId}:${index}`
const changed = () => listeners.forEach((cb) => cb(waiting.size))

/**
 * Hold a wait until it's answered, or until the reply's stop signal fires (which rejects with its reason). `make` gets
 * the function that settles the wait with a value, and returns the entry to register.
 */
function hold<T>(messageId: string, index: number, signal: AbortSignal, make: (settle: (value: T) => void) => Waiting): Promise<T> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason)
    const k = key(messageId, index)
    const done = () => {
      waiting.delete(k)
      signal.removeEventListener('abort', onAbort)
      changed()
    }
    const onAbort = () => {
      done()
      reject(signal.reason)
    }
    signal.addEventListener('abort', onAbort, { once: true })
    waiting.set(
      k,
      make((value) => {
        done()
        resolve(value)
      })
    )
    changed()
  })
}

/** Wait for the user's answer to a call. Rejects with the signal's reason if the reply is stopped first. */
export function waitForDecision(
  conversationId: string,
  messageId: string,
  index: number,
  signal: AbortSignal,
  choices: readonly ToolDecision[] = DECISIONS
): Promise<ToolDecision> {
  return hold(messageId, index, signal, (answer) => ({ kind: 'decision', conversationId, choices, answer }))
}

/** Answer a waiting call. Throws when it isn't waiting any more (answered in another window, or stopped). */
export function decide(conversationId: string, messageId: string, index: number, decision: ToolDecision): void {
  // IPC arguments aren't type-checked: anything but the three answers must not count as a yes.
  if (!DECISIONS.includes(decision)) throw new Error(`Unknown answer to a tool call: ${String(decision)}`)
  const w = waiting.get(key(messageId, index))
  if (!w || w.kind !== 'decision' || w.conversationId !== conversationId) {
    throw new Error("That tool call isn't waiting for an answer any more.")
  }
  if (!w.choices.includes(decision)) throw new Error('That tool call can only be allowed once or denied.')
  w.answer(decision)
}

/** Wait for the user's answers to a call's questions. Resolves to null if they skip; rejects if the reply is stopped. */
export function waitForAnswer(
  conversationId: string,
  messageId: string,
  index: number,
  signal: AbortSignal,
  questions: readonly AskQuestion[]
): Promise<AskAnswer[] | null> {
  return hold(messageId, index, signal, (answer) => ({ kind: 'question', conversationId, questions, answer }))
}

/**
 * The answers as the model's questions allow them: one per question, each picking real options (one, unless the
 * question takes several) and/or holding text. Returns them cleaned (text trimmed); throws for anything else, since
 * IPC arguments aren't type-checked.
 */
export function checkAnswers(questions: readonly AskQuestion[], answers: unknown): AskAnswer[] {
  if (!Array.isArray(answers) || answers.length !== questions.length) throw new Error('Answer every question, or skip them all.')
  return questions.map((q, i) => {
    const a = answers[i] as { selected?: unknown; other?: unknown } | null
    if (!a || typeof a !== 'object' || !Array.isArray(a.selected)) throw new Error('Malformed answer.')
    const selected = a.selected as unknown[]
    const valid = selected.every((n) => Number.isInteger(n) && (n as number) >= 0 && (n as number) < q.options.length)
    if (!valid || new Set(selected).size !== selected.length) throw new Error('That answer picks an option the question lacks.')
    if (selected.length > 1 && !q.multiSelect) throw new Error('That question takes one option.')
    if (a.other !== undefined && typeof a.other !== 'string') throw new Error('Malformed answer.')
    const other = (a.other ?? '').trim()
    if (other.length > ASK_OTHER_CHARS) throw new Error(`Keep an answer under ${ASK_OTHER_CHARS} characters.`)
    if (!selected.length && !other) throw new Error('Answer every question, or skip them all.')
    return { selected: selected as number[], ...(other && { other }) }
  })
}

/** Answer (or, with null, skip) waiting questions. Throws when they aren't waiting any more, or the answers don't fit. */
export function answer(conversationId: string, messageId: string, index: number, answers: AskAnswer[] | null): void {
  const w = waiting.get(key(messageId, index))
  if (!w || w.kind !== 'question' || w.conversationId !== conversationId) {
    throw new Error("Those questions aren't waiting for an answer any more.")
  }
  w.answer(answers === null ? null : checkAnswers(w.questions, answers))
}

/** How many calls are waiting, across every chat. */
export const waitingCount = (): number => waiting.size

/** Follow the number of waiting calls (for the Dock badge). Returns a function that stops following. */
export function onWaitingChange(cb: (count: number) => void): () => void {
  listeners.add(cb)
  return () => listeners.delete(cb)
}
