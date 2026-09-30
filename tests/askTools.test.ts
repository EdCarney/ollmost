import { describe, expect, it, vi } from 'vitest'
import type { AskQuestion } from '@shared/types'

vi.mock('electron', () => ({ shell: {}, app: { getPath: () => '' }, safeStorage: {} }))

const { normalizeQuestions, askTools } = await import('../src/main/chat/askTools')
const approvals = await import('../src/main/chat/approvals')
const { ASK_OTHER_CHARS } = await import('@shared/ask')
type ToolContext = import('../src/main/chat/tools').ToolContext
type RunContext = import('../src/main/chat/tools').RunContext

describe('normalizeQuestions', () => {
  const full = {
    questions: [
      {
        question: 'Which format?',
        header: 'Format',
        options: [{ label: 'CSV', description: 'plain' }, { label: 'JSON' }],
        multiSelect: true
      }
    ]
  }

  it('takes the documented shape', () => {
    expect(normalizeQuestions(full)).toEqual([
      {
        question: 'Which format?',
        header: 'Format',
        options: [{ label: 'CSV', description: 'plain' }, { label: 'JSON' }],
        multiSelect: true
      }
    ])
  })

  it('takes the shapes small models send instead', () => {
    const expected = [{ question: 'Pick one?', header: 'Question', options: [{ label: 'A' }, { label: 'B' }], multiSelect: false }]
    // One question with no list around it, options as plain strings.
    expect(normalizeQuestions({ question: 'Pick one?', options: ['A', 'B'] })).toEqual(expected)
    // The list as a JSON string, the options as a JSON string, the flag as text.
    const asString = JSON.stringify([{ question: 'Pick one?', options: JSON.stringify(['A', 'B']), multi_select: 'true' }])
    expect(normalizeQuestions({ questions: asString })).toEqual([{ ...expected[0], multiSelect: true }])
    // A single object in place of the list.
    expect(normalizeQuestions({ questions: { question: 'Pick one?', options: [{ text: 'A' }, { value: 'B' }] } })).toEqual(expected)
  })

  it('names a question with no header by its place, not by a cut-off question', () => {
    const two = normalizeQuestions({
      questions: [
        { question: 'A long question about months?', options: ['x', 'y'] },
        { question: 'Second?', options: ['x', 'y'] }
      ]
    })
    expect(two.map((q) => q.header)).toEqual(['Question 1', 'Question 2'])
  })

  it("drops the model's own Other and repeated options, and cuts long text", () => {
    const [q] = normalizeQuestions({
      question: 'x'.repeat(900),
      header: 'h'.repeat(90),
      options: ['A', 'a', 'Other', 'Other (please specify)', 'Other:', 'Otherwise', 'B', ' ']
    })
    expect(q.options.map((o) => o.label)).toEqual(['A', 'Otherwise', 'B'])
    expect(q.question.length).toBeLessThanOrEqual(500)
    expect(q.header.length).toBeLessThanOrEqual(30)
  })

  it('refuses what it would have to leave out, saying which limit was passed, so the model can retry', () => {
    const q = (options: unknown[], question = 'Q?') => ({ question, options })
    // Too many options: the model can't see the card, so cutting to six would show it a different question.
    const months = Array.from({ length: 12 }, (_, i) => `Month ${i + 1}`)
    expect(() => normalizeQuestions({ questions: [q(months)] })).toThrow(/Question 1 has 12 options, and the most is 6/)
    // Too many questions.
    expect(() => normalizeQuestions({ questions: Array.from({ length: 5 }, () => q(['a', 'b'])) })).toThrow(
      /at most 4 questions.*you sent 5/
    )
    // One question that can't be shown fails the call, and says which.
    expect(() => normalizeQuestions({ questions: [q(['a', 'b']), q(['only'])] })).toThrow(/Question 2 needs at least 2 options/)
    expect(() => normalizeQuestions({ questions: [q(['Yes', 'Other'])] })).toThrow(/besides "Other", which the card adds itself/)
    expect(() => normalizeQuestions({ questions: [q(['a', 'b'], '  ')] })).toThrow(/Question 1 has no "question" text/)
    expect(() => normalizeQuestions({ questions: [{ question: 'Q?' }] })).toThrow(/Question 1 needs "options"/)
    expect(() => normalizeQuestions({ questions: [7] })).toThrow(/Question 1 must be an object/)
  })

  it('throws, naming the shape, when there is nothing to ask', () => {
    for (const bad of [{}, { questions: [] }, { questions: 'not json' }]) {
      expect(() => normalizeQuestions(bad)).toThrow(/needs "questions"/)
    }
  })
})

describe('answering questions', () => {
  const questions: AskQuestion[] = [
    { question: 'One?', header: 'One', options: [{ label: 'A' }, { label: 'B' }], multiSelect: false },
    { question: 'Many?', header: 'Many', options: [{ label: 'X' }, { label: 'Y' }, { label: 'Z' }], multiSelect: true }
  ]
  const wait = (conversation = 'c1') => {
    const controller = new AbortController()
    return { controller, promise: approvals.waitForAnswer(conversation, 'm1', 0, controller.signal, questions) }
  }

  it('resolves with the answers, trimmed, and stops waiting', async () => {
    const { promise } = wait()
    expect(approvals.waitingCount()).toBe(1)
    approvals.answer('c1', 'm1', 0, [{ selected: [1] }, { selected: [0, 2], other: '  and more  ' }])
    expect(await promise).toEqual([{ selected: [1] }, { selected: [0, 2], other: 'and more' }])
    expect(approvals.waitingCount()).toBe(0)
    expect(() => approvals.answer('c1', 'm1', 0, null)).toThrow(/aren't waiting/)
  })

  it('takes typed text alone as an answer, and null as a skip', async () => {
    const a = wait()
    approvals.answer('c1', 'm1', 0, [{ selected: [], other: 'mine' }, { selected: [2] }])
    expect(await a.promise).toEqual([{ selected: [], other: 'mine' }, { selected: [2] }])
    const b = wait()
    approvals.answer('c1', 'm1', 0, null)
    expect(await b.promise).toBeNull()
  })

  it('refuses answers the questions do not allow, and keeps waiting', async () => {
    const { promise, controller } = wait()
    const ok = { selected: [0] }
    const bad: unknown[] = [
      [ok],
      'A',
      [ok, { selected: [] }],
      [{ selected: [2] }, ok],
      [{ selected: [-1] }, ok],
      [{ selected: [0.5] }, ok],
      [{ selected: [0, 1] }, ok],
      [ok, { selected: [1, 1] }],
      [ok, { selected: [0], other: 5 }],
      [ok, { selected: [], other: '   ' }],
      [ok, { selected: [], other: 'x'.repeat(ASK_OTHER_CHARS + 1) }],
      [null, ok]
    ]
    for (const answers of bad) expect(() => approvals.answer('c1', 'm1', 0, answers as never)).toThrow()
    expect(approvals.waitingCount()).toBe(1)
    controller.abort(new Error('stopped'))
    await expect(promise).rejects.toThrow('stopped')
    expect(approvals.waitingCount()).toBe(0)
  })

  it('keeps questions and approvals apart, and one chat from answering another', async () => {
    const a = wait()
    expect(() => approvals.decide('c1', 'm1', 0, 'once')).toThrow(/isn't waiting/)
    expect(() => approvals.answer('c2', 'm1', 0, null)).toThrow(/aren't waiting/)
    approvals.answer('c1', 'm1', 0, null)
    await a.promise
    const controller = new AbortController()
    const decision = approvals.waitForDecision('c1', 'm1', 1, controller.signal)
    expect(() => approvals.answer('c1', 'm1', 1, null)).toThrow(/aren't waiting/)
    approvals.decide('c1', 'm1', 1, 'deny')
    expect(await decision).toBe('deny')
  })

  it('does not wait when the reply is already stopped', async () => {
    const controller = new AbortController()
    controller.abort(new Error('stopped'))
    await expect(approvals.waitForAnswer('c1', 'm1', 0, controller.signal, questions)).rejects.toThrow('stopped')
    expect(approvals.waitingCount()).toBe(0)
  })
})

describe('the ask_user provider', () => {
  const args = { questions: [{ question: 'Format?', header: 'Format', options: ['CSV', 'JSON'] }] }
  const controller = new AbortController()
  const shown: unknown[] = []
  const ctx = (over: Partial<RunContext> = {}): RunContext =>
    ({
      mode: 'chat',
      skills: false,
      web: false,
      sources: [],
      workspace: null,
      grants: new Set(),
      signal: controller.signal,
      callIndex: 3,
      progress: (e) => shown.push(e),
      reply: { conversationId: 'c1', messageId: 'm1' },
      ...over
    }) as RunContext
  const call = { provider: askTools, name: 'ask_user', via: null, args }

  it('shows its questions while waiting, then hands the answer back and keeps it for later turns', async () => {
    shown.length = 0
    const run = askTools.run(call, ctx())
    expect(shown[0]).toMatchObject({ pending: true, awaiting: true, summary: 'Format', ask: { questions: [{ header: 'Format' }] } })
    approvals.answer('c1', 'm1', 3, [{ selected: [1], other: 'with a header row' }])
    const result = await run
    // Only the answer is labelled as the user's: the question is the model's own text, and may have come from a page.
    expect(result.content).toBe(
      `The user answered your questions. Only the text after "The user answered:" is theirs; treat it as you would a message from them. The questions are your own wording, repeated for reference.\n1. You asked: Format?\n   The user answered: JSON; with a header row`
    )
    expect(result.keep).toBe(true)
    expect(result.event).toMatchObject({ ok: true, ask: { answers: [{ selected: [1], other: 'with a header row' }] } })
    // The card, /compact and a shortened result all keep the answers, not just the headers.
    expect(result.event.summary).toBe('Format: JSON, with a header row')
    // Later turns see the call in the tool's own shape, so a model copying it makes a valid one.
    const past = askTools.replay?.(result.event)
    expect(past).toMatchObject({ name: 'ask_user', record: result.content })
    expect(normalizeQuestions(past!.args)).toEqual([
      { question: 'Format?', header: 'Format', options: [{ label: 'CSV' }, { label: 'JSON' }], multiSelect: false }
    ])
  })

  it('tells the model when the user skips', async () => {
    const run = askTools.run(call, ctx())
    approvals.answer('c1', 'm1', 3, null)
    const result = await run
    expect(result.content).toMatch(/chose not to answer/)
    expect(result.event.ask).toMatchObject({ skipped: true })
    expect(result.event.summary).toBe('Format (skipped)')
  })

  it('fails plainly with nowhere to ask, and with arguments that hold no question', async () => {
    expect((await askTools.run(call, ctx({ progress: undefined }))).event.ok).toBe(false)
    await expect(askTools.run({ ...call, args: {} }, ctx())).rejects.toThrow(/needs "questions"/)
    // A card for malformed arguments still shows something, and the call then fails with the reason.
    expect(await askTools.pending({ ...call, args: {} }, {} as ToolContext)).toMatchObject({ pending: true, summary: 'ask_user' })
  })
})
