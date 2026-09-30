import type { AskAnswer, AskQuestion, ToolEvent } from '@shared/types'
import { isRecord } from '../providers/json'
import type { ToolDef } from '../providers/types'
import { waitForAnswer } from './approvals'
import { capText } from './results'
import type { ToolProvider } from './tools'

// ask_user: the model asks the user a multiple-choice question and carries on with the answer. The call waits inside
// run(), reporting its questions through `progress` (like a sub-agent reporting a call that needs approving): the
// reply's loop saves the reply at once, the card asks, and approvals.ts holds the wait until the user answers, skips,
// or the reply is stopped.

const MAX_QUESTIONS = 4
const MIN_OPTIONS = 2
const MAX_OPTIONS = 6
const MAX_QUESTION_CHARS = 500
const MAX_HEADER_CHARS = 30
const MAX_LABEL_CHARS = 100
const MAX_DESCRIPTION_CHARS = 300

export const ASK_TOOLS: ToolDef[] = [
  {
    type: 'function',
    function: {
      name: 'ask_user',
      description:
        "Ask the user one to four multiple-choice questions and wait for their answers. Use it only when their answer changes what you would do and you can't work it out from the conversation, their files or your tools: an ambiguous request, or a real choice between approaches. Don't ask what you can find out yourself, don't ask for permission to continue, and ask everything you need in one call. Give 2 to 6 short options for each question; the user can always type their own answer instead, so don't add an 'Other' option. Set multiSelect when several options may be picked together.",
      parameters: {
        type: 'object',
        properties: {
          questions: {
            type: 'array',
            description: 'One to four questions',
            items: {
              type: 'object',
              properties: {
                question: { type: 'string', description: 'The complete question, ending with a question mark' },
                header: { type: 'string', description: 'One or two words naming the question, e.g. "Format"' },
                options: {
                  type: 'array',
                  description: 'Two to six choices',
                  items: {
                    type: 'object',
                    properties: {
                      label: { type: 'string', description: 'The choice, in a few words' },
                      description: { type: 'string', description: 'What choosing it means' }
                    },
                    required: ['label']
                  }
                },
                multiSelect: { type: 'boolean', description: 'Whether more than one option may be picked' }
              },
              required: ['question', 'options']
            }
          }
        },
        required: ['questions']
      }
    }
  }
]

/** Other names models call the tool by (they know it from other assistants). */
const ALIASES = new Set(['askuserquestion', 'ask_user_question', 'ask_question', 'ask_questions', 'ask', 'ask_human', 'question'])

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text)
const text = (v: unknown): string => (typeof v === 'string' ? v.trim() : typeof v === 'number' ? String(v) : '')
const flag = (v: unknown): boolean => v === true || (typeof v === 'string' && v.trim().toLowerCase() === 'true')
const parsed = (v: unknown): unknown => {
  if (typeof v !== 'string') return v
  try {
    return JSON.parse(v)
  } catch {
    return undefined
  }
}
// The card adds its own "Other" box, so a model's own ("Other", "Other (please specify)", "Other:") would show twice.
const OTHER_OPTION = /^other(?![a-z])/i

const SHAPE = `ask_user needs "questions": a list of one to ${MAX_QUESTIONS} objects, each with "question", "options" (${MIN_OPTIONS} to ${MAX_OPTIONS} objects with a "label", not counting "Other", which the card adds itself) and optionally "header" and "multiSelect".`

/**
 * The questions a call asks, from what a model sent. Small models send them in many shapes (one question at the top
 * level, options as plain strings, the list as a JSON string), so this takes those. What it can't show as sent it
 * refuses, saying which limit was passed: the model can't see the card, so a question or option quietly left out would
 * be answered as if it had been shown. The error goes back to the model as the call's error.
 */
export function normalizeQuestions(args: Record<string, unknown>): AskQuestion[] {
  let raw = parsed(args.questions)
  // One question given without the list around it.
  if (raw === undefined && (args.question !== undefined || args.options !== undefined)) raw = [args]
  if (isRecord(raw)) raw = [raw]
  const items = Array.isArray(raw) ? raw : []
  if (!items.length) throw new Error(SHAPE)
  if (items.length > MAX_QUESTIONS) {
    throw new Error(
      `ask_user takes at most ${MAX_QUESTIONS} questions in one call, and you sent ${items.length}. Ask the most important ones now; you can ask more afterwards.`
    )
  }
  return items.map((item, i) => {
    const n = `Question ${i + 1}`
    if (!isRecord(item)) throw new Error(`${n} must be an object. ${SHAPE}`)
    const question = clip(text(item.question), MAX_QUESTION_CHARS)
    if (!question) throw new Error(`${n} has no "question" text. ${SHAPE}`)
    const options = parsed(item.options)
    if (!Array.isArray(options)) throw new Error(`${n} needs "options". ${SHAPE}`)
    const seen = new Set<string>()
    const kept: AskQuestion['options'] = []
    for (const o of options) {
      const label = clip(isRecord(o) ? text(o.label ?? o.text ?? o.value ?? o.name) : text(o), MAX_LABEL_CHARS)
      const description = isRecord(o) ? clip(text(o.description), MAX_DESCRIPTION_CHARS) : ''
      const id = label.toLowerCase()
      if (!label || OTHER_OPTION.test(label) || seen.has(id)) continue
      seen.add(id)
      kept.push({ label, ...(description && { description }) })
    }
    if (kept.length > MAX_OPTIONS) {
      throw new Error(
        `${n} has ${kept.length} options, and the most is ${MAX_OPTIONS} (the user can type their own answer, so don't list every possibility). Group or shorten them.`
      )
    }
    if (kept.length < MIN_OPTIONS) {
      throw new Error(
        `${n} needs at least ${MIN_OPTIONS} options besides "Other", which the card adds itself. For an open question, just ask it in your reply.`
      )
    }
    return {
      question,
      // A header the model left out is named by position: a cut-off question reads badly on a small chip.
      header: clip(text(item.header) || (items.length > 1 ? n : 'Question'), MAX_HEADER_CHARS),
      options: kept,
      multiSelect: flag(item.multiSelect ?? item.multi_select ?? item.multiple)
    }
  })
}

const summaryOf = (questions: AskQuestion[]) => questions.map((q) => q.header).join(', ')

/** What one answer picked: the options' labels, then what was typed. */
const pickedIn = (q: AskQuestion, a: AskAnswer): string[] => [...a.selected.map((n) => q.options[n].label), ...(a.other ? [a.other] : [])]

/**
 * What the model reads back, and what later turns keep of the exchange. The question is the model's own text (which
 * may have come from a page or a tool it read), so it's labelled as the model's; only the answer is the user's.
 */
function answersText(questions: AskQuestion[], answers: AskAnswer[]): string {
  const lines = questions.map((q, i) => `${i + 1}. You asked: ${q.question}\n   The user answered: ${pickedIn(q, answers[i]).join('; ')}`)
  return `The user answered your questions. Only the text after "The user answered:" is theirs; treat it as you would a message from them. The questions are your own wording, repeated for reference.\n${lines.join('\n')}`
}

/**
 * What the card and the tool trace say once answered, and what a /compact summary and a shortened earlier result keep
 * of the call: the answers themselves ("Format: JSON; Size: small"), cut to a line's worth.
 */
const answeredSummary = (questions: AskQuestion[], answers: AskAnswer[]): string =>
  clip(questions.map((q, i) => `${q.header}: ${pickedIn(q, answers[i]).join(', ')}`).join('; '), 200)

/** The most of an answered call that later turns keep: four long typed answers could otherwise fill a window. */
const RECORD_CHARS = 6000

const SKIPPED = 'The user chose not to answer. Carry on with your best judgment, and say what you assumed so they can correct it.'

export const askTools: ToolProvider = {
  id: 'ask',
  // Offered when the request allows it (a model that can call tools, and the setting on) and never to a sub-agent: nobody
  // is reading its work to answer.
  tools: (ctx) => (ctx.ask && !ctx.child ? ASK_TOOLS : []),
  alias: (name) => (ALIASES.has(name.toLowerCase()) ? 'ask_user' : null),
  hint: 'Use ask_user only for a question the user has to answer.',
  pending: ({ name, args }) => {
    // Arguments that don't hold a question fail in run(), which tells the model why.
    try {
      const questions = normalizeQuestions(args)
      return { tool: name, args, ok: true, pending: true, summary: summaryOf(questions) }
    } catch {
      return { tool: name, args, ok: true, pending: true, summary: name }
    }
  },
  // The question is the wait: no approval card stacks on it.
  approval: () => 'auto',
  // The user's words, cut to a call's share of the room, would be answered as if they'd said less.
  wholeResults: true,
  run: async ({ name, args }, ctx) => {
    const questions = normalizeQuestions(args)
    const { reply, callIndex, signal, progress } = ctx
    if (!reply || callIndex === undefined || !signal || !progress) {
      return {
        content: 'ask_user is not available here.',
        event: { tool: name, args, ok: false, summary: 'ask_user is not available here' }
      }
    }
    const summary = summaryOf(questions)
    const waiting: ToolEvent = { tool: name, args, ok: true, pending: true, summary, awaiting: true, ask: { questions } }
    progress(waiting)
    // A stop rejects this, and the reply's loop unwinds with it.
    const answers = await waitForAnswer(reply.conversationId, reply.messageId, callIndex, signal, questions)
    if (!answers) {
      const skipped = `${summary} (skipped)`
      return {
        content: SKIPPED,
        event: { tool: name, args, ok: true, summary: skipped, record: SKIPPED, ask: { questions, skipped: true } },
        keep: true
      }
    }
    const content = answersText(questions, answers)
    return {
      content,
      event: { tool: name, args, ok: true, summary: answeredSummary(questions, answers), record: content, ask: { questions, answers } },
      keep: true
    }
  },
  // Later turns keep what was asked and answered, so the model doesn't ask again.
  replay: (e) =>
    e.tool === 'ask_user' && e.record
      ? {
          name: 'ask_user',
          // In the tool's own shape, so a model copying the call it sees makes a valid one.
          args: { questions: (e.ask?.questions ?? []).map((q) => ({ ...q, options: q.options.map((o) => ({ label: o.label })) })) },
          record: capText(e.record, RECORD_CHARS)
        }
      : null
}
