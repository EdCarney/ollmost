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

describe('historyLoss', () => {
  it('an edit of the last message loses nothing later: only its own reply is redone', () => {
    const messages = [msg('user', 1), msg('assistant', 2), msg('user', 3), msg('assistant', 4)]
    expect(historyLoss(messages, 2, null)).toEqual({ laterMessages: 0, clearsSummary: false })
  })

  it('an edit of an earlier message counts everything after its own reply', () => {
    const messages = [msg('user', 1), msg('assistant', 2), msg('user', 3), msg('assistant', 4)]
    expect(historyLoss(messages, 0, null)).toEqual({ laterMessages: 2, clearsSummary: false })
  })

  it('a message the summary covers clears it, on top of any later messages', () => {
    const messages = [msg('user', 1), msg('assistant', 2), msg('user', 3), msg('assistant', 4)]
    expect(historyLoss(messages, 0, { upTo: 2 })).toEqual({ laterMessages: 2, clearsSummary: true })
  })

  it('no compaction never clears a summary, however old the message', () => {
    const messages = [msg('user', 1), msg('assistant', 2)]
    expect(historyLoss(messages, 0, null).clearsSummary).toBe(false)
  })

  it('a user message with no reply yet loses no later messages', () => {
    const messages = [msg('user', 1)]
    expect(historyLoss(messages, 0, { upTo: 1 })).toEqual({ laterMessages: 0, clearsSummary: true })
  })

  it('a failed assistant reply still counts as the redone exchange, not as later history', () => {
    const messages = [
      msg('user', 1),
      msg('assistant', 2, { content: '', error: 'The model timed out.' }),
      msg('user', 3),
      msg('assistant', 4)
    ]
    expect(historyLoss(messages, 0, null)).toEqual({ laterMessages: 2, clearsSummary: false })
  })
})
