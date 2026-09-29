import type { AskAnswer, AskQuestion, ToolEvent } from '@shared/types'
import type { ToolDef } from '../providers/types'
import { waitForAnswer } from './approvals'
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

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text)
const text = (v: unknown): string => (typeof v === 'string' ? v.trim() : typeof v === 'number' ? String(v) : '')
const flag = (v: unknown): boolean => v === true || (typeof v === 'string' && v.trim().toLowerCase() === 'true')

/**
 * The questions a call asks, from what a model sent. Small models send them in many shapes (one question at the top
 * level, options as plain strings, the list as a JSON string), so this takes those; anything it can't use throws with
 * the shape that works, which goes back to the model as the call's error.
 */
export function normalizeQuestions(args: Record<string, unknown>): AskQuestion[] {
  let raw: unknown = args.questions
  if (typeof raw === 'string') {
    try {
      raw = JSON.parse(raw)
    } catch {
      raw = undefined
    }
  }
  // One question given without the list around it.
  if (raw === undefined && (args.question !== undefined || args.options !== undefined)) raw = [args]
  if (isObject(raw)) raw = [raw]
  const questions: AskQuestion[] = []
  for (const item of Array.isArray(raw) ? raw : []) {
    if (!isObject(item)) continue
    const question = clip(text(item.question), MAX_QUESTION_CHARS)
    let options: unknown = item.options
    if (typeof options === 'string') {
      try {
        options = JSON.parse(options)
      } catch {
        options = undefined
      }
    }
    if (!question || !Array.isArray(options)) continue
    const seen = new Set<string>()
    const kept: AskQuestion['options'] = []
    for (const o of options) {
      const label = clip(isObject(o) ? text(o.label ?? o.text ?? o.value ?? o.name) : text(o), MAX_LABEL_CHARS)
      const description = isObject(o) ? clip(text(o.description), MAX_DESCRIPTION_CHARS) : ''
      // The card adds its own "Other", so a model's would show twice.
      const id = label.toLowerCase()
      if (!label || id === 'other' || seen.has(id)) continue
      seen.add(id)
      kept.push({ label, ...(description && { description }) })
      if (kept.length === MAX_OPTIONS) break
    }
    if (kept.length < MIN_OPTIONS) continue
    questions.push({
      question,
      header: clip(text(item.header) || question.replace(/\?+$/, ''), MAX_HEADER_CHARS),
      options: kept,
      multiSelect: flag(item.multiSelect ?? item.multi_select ?? item.multiple)
    })
    if (questions.length === MAX_QUESTIONS) break
  }
  if (!questions.length) {
    throw new Error(
      `ask_user needs "questions": a list of one to ${MAX_QUESTIONS} objects, each with "question", "options" (${MIN_OPTIONS} to ${MAX_OPTIONS} objects with a "label") and optionally "header" and "multiSelect".`
    )
  }
  return questions
}

const summaryOf = (questions: AskQuestion[]) => questions.map((q) => q.header).join(', ')

/** What the model reads back, and what later turns keep of the exchange. */
function answersText(questions: AskQuestion[], answers: AskAnswer[]): string {
  const lines = questions.map((q, i) => {
    const a = answers[i]
    const picked = a.selected.map((n) => q.options[n].label)
    if (a.other) picked.push(`(typed by the user) ${a.other}`)
    return `${i + 1}. ${q.header}: ${q.question}\n   Answer: ${picked.join('; ')}`
  })
  return `The user answered:\n${lines.join('\n')}`
}

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
      return { content: SKIPPED, event: { tool: name, args, ok: true, summary, record: SKIPPED, ask: { questions, skipped: true } } }
    }
    const content = answersText(questions, answers)
    return { content, event: { tool: name, args, ok: true, summary, record: content, ask: { questions, answers } } }
  },
  // Later turns keep what was asked and answered, so the model doesn't ask again.
  replay: (e) =>
    e.tool === 'ask_user' && e.record
      ? { name: 'ask_user', args: { questions: e.ask?.questions.map((q) => q.header) ?? [] }, record: e.record }
      : null
}
