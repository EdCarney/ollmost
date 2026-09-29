import { describe, expect, it, vi } from 'vitest'
import type { AskQuestion } from '@shared/types'

vi.mock('electron', () => ({ shell: {}, app: { getPath: () => '' }, safeStorage: {} }))

const { normalizeQuestions, askTools } = await import('../src/main/chat/askTools')
const approvals = await import('../src/main/chat/approvals')
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
    const expected = [{ question: 'Pick one?', header: 'Pick one', options: [{ label: 'A' }, { label: 'B' }], multiSelect: false }]
    // One question with no list around it, options as plain strings.
    expect(normalizeQuestions({ question: 'Pick one?', options: ['A', 'B'] })).toEqual(expected)
    // The list as a JSON string, the options as a JSON string, the flag as text.
    const asString = JSON.stringify([{ question: 'Pick one?', options: JSON.stringify(['A', 'B']), multi_select: 'true' }])
    expect(normalizeQuestions({ questions: asString })).toEqual([{ ...expected[0], multiSelect: true }])
    // A single object in place of the list.
    expect(normalizeQuestions({ questions: { question: 'Pick one?', options: [{ text: 'A' }, { value: 'B' }] } })).toEqual(expected)
  })

  it("drops the model's own Other and repeated options, and clamps counts and lengths", () => {
    const q = normalizeQuestions({
      questions: [
        { question: 'Q?', options: ['A', 'a', 'Other', 'B', 'C', 'D', 'E', 'F', 'G', ' '] },
        ...Array.from({ length: 6 }, (_, i) => ({ question: `Q${i}`, options: ['x', 'y'] })),
        { question: 'x'.repeat(900), header: 'h'.repeat(90), options: ['x', 'y'] }
      ]
    })
    expect(q).toHaveLength(4)
    expect(q[0].options.map((o) => o.label)).toEqual(['A', 'B', 'C', 'D', 'E', 'F'])
    const long = normalizeQuestions({ question: 'x'.repeat(900), header: 'h'.repeat(90), options: ['x', 'y'] })[0]
    expect(long.question.length).toBeLessThanOrEqual(500)
    expect(long.header.length).toBeLessThanOrEqual(30)
  })

  it('skips a question it cannot use, and throws, naming the shape, when none is left', () => {
    expect(
      normalizeQuestions({ questions: [{ question: 'no options' }, { question: 'one?', options: ['only'] }, full.questions[0]] })
    ).toHaveLength(1)
    for (const bad of [{}, { questions: [] }, { questions: 'not json' }, { question: 'q', options: ['solo'] }, { questions: [7, null] }]) {
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
      [ok, { selected: [], other: 'x'.repeat(approvals.OTHER_CHARS + 1) }],
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
    expect(result.content).toBe('The user answered:\n1. Format: Format?\n   Answer: JSON; (typed by the user) with a header row')
    expect(result.event).toMatchObject({ ok: true, ask: { answers: [{ selected: [1], other: 'with a header row' }] } })
    expect(askTools.replay?.(result.event)).toMatchObject({ name: 'ask_user', record: result.content })
  })

  it('tells the model when the user skips', async () => {
    const run = askTools.run(call, ctx())
    approvals.answer('c1', 'm1', 3, null)
    const result = await run
    expect(result.content).toMatch(/chose not to answer/)
    expect(result.event.ask).toMatchObject({ skipped: true })
  })

  it('fails plainly with nowhere to ask, and with arguments that hold no question', async () => {
    expect((await askTools.run(call, ctx({ progress: undefined }))).event.ok).toBe(false)
    await expect(askTools.run({ ...call, args: {} }, ctx())).rejects.toThrow(/needs "questions"/)
    // A card for malformed arguments still shows something, and the call then fails with the reason.
    expect(await askTools.pending({ ...call, args: {} }, {} as ToolContext)).toMatchObject({ pending: true, summary: 'ask_user' })
  })
})
