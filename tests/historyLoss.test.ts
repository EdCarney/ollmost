import { describe, expect, it } from 'vitest'
import { historyLoss } from '../src/shared/historyLoss'
import type { Message } from '../src/shared/types'

function msg(role: 'user' | 'assistant', createdAt: number, extra: Partial<Message> = {}): Message {
  return {
    id: `${role}-${createdAt}`,
    conversationId: 'c1',
    parentId: null,
    role,
    content: role === 'user' ? 'hi' : 'ok',
    thinking: null,
    thinkingSegments: null,
    model: role === 'assistant' ? 'llama3' : null,
    attachments: [],
    toolEvents: [],
    stats: null,
    error: null,
    createdAt,
    ...extra
  }
}

const artifact = (identifier: string, content = 'body') =>
  `<artifact identifier="${identifier}" type="code" language="js" title="T">${content}</artifact>`

const none = { artifactsMayBeDeleted: false, fileEditsMade: false }

describe('historyLoss', () => {
  it('an edit of the last message loses nothing later: only its own reply is redone', () => {
    const messages = [msg('user', 1), msg('assistant', 2), msg('user', 3), msg('assistant', 4)]
    expect(historyLoss(messages, 2, null)).toEqual({ laterMessages: 0, clearsSummary: false, ...none })
  })

  it('an edit of an earlier message counts everything after its own reply', () => {
    const messages = [msg('user', 1), msg('assistant', 2), msg('user', 3), msg('assistant', 4)]
    expect(historyLoss(messages, 0, null)).toEqual({ laterMessages: 2, clearsSummary: false, ...none })
  })

  it('a message the summary covers clears it, on top of any later messages', () => {
    const messages = [msg('user', 1), msg('assistant', 2), msg('user', 3), msg('assistant', 4)]
    expect(historyLoss(messages, 0, { upTo: 2 })).toEqual({ laterMessages: 2, clearsSummary: true, ...none })
  })

  it('no compaction never clears a summary, however old the message', () => {
    const messages = [msg('user', 1), msg('assistant', 2)]
    expect(historyLoss(messages, 0, null).clearsSummary).toBe(false)
  })

  it('a user message with no reply yet loses no later messages', () => {
    const messages = [msg('user', 1)]
    expect(historyLoss(messages, 0, { upTo: 1 })).toEqual({ laterMessages: 0, clearsSummary: true, ...none })
  })

  it('a failed assistant reply still counts as the redone exchange, not as later history', () => {
    const messages = [
      msg('user', 1),
      msg('assistant', 2, { content: '', error: 'The model timed out.' }),
      msg('user', 3),
      msg('assistant', 4)
    ]
    expect(historyLoss(messages, 0, null)).toEqual({ laterMessages: 2, clearsSummary: false, ...none })
  })

  it('flags an artifact a deleted reply made, with no earlier occurrence to keep a version alive', () => {
    const messages = [msg('user', 1), msg('assistant', 2, { content: artifact('a') })]
    expect(historyLoss(messages, 0, null).artifactsMayBeDeleted).toBe(true)
  })

  it('does not flag an artifact that also occurs in a surviving, earlier reply', () => {
    const messages = [
      msg('user', 1),
      msg('assistant', 2, { content: artifact('a') }),
      msg('user', 3),
      msg('assistant', 4, { content: artifact('a', 'updated body') })
    ]
    // Editing the second exchange deletes only its own reply; the identifier's first version survives.
    expect(historyLoss(messages, 2, null).artifactsMayBeDeleted).toBe(false)
  })

  it('flags a deleted reply that edited or wrote a file', () => {
    const messages = [
      msg('user', 1),
      msg('assistant', 2, { toolEvents: [{ tool: 'edit_file', args: {}, ok: true, summary: 'Edited x.ts' }] })
    ]
    expect(historyLoss(messages, 0, null).fileEditsMade).toBe(true)
  })

  it('does not flag a deleted reply whose tool calls never touched a file', () => {
    const messages = [
      msg('user', 1),
      msg('assistant', 2, { toolEvents: [{ tool: 'read_file', args: {}, ok: true, summary: 'Read x.ts' }] })
    ]
    expect(historyLoss(messages, 0, null).fileEditsMade).toBe(false)
  })
})
