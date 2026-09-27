import { describe, expect, it } from 'vitest'
import { historyLoss, historyLossNotice, type HistoryLoss } from '../src/shared/historyLoss'
import type { Artifact, Message } from '../src/shared/types'

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

/** An artifact with one version per message id given, in order. */
function artifact(id: string, title: string, messageIds: string[]): Artifact {
  return {
    id,
    conversationId: 'c1',
    identifier: id,
    type: 'code',
    title,
    language: 'js',
    createdAt: 0,
    updatedAt: 0,
    versions: messageIds.map((messageId, i) => ({
      id: `${id}-v${i + 1}`,
      artifactId: id,
      messageId,
      version: i + 1,
      content: 'x',
      createdAt: 0
    }))
  }
}

const noLoss = { lostArtifacts: [] as Artifact[], fileEditsMade: false }

describe('historyLoss', () => {
  it('an edit of the last message loses nothing later: only its own reply is redone', () => {
    const messages = [msg('user', 1), msg('assistant', 2), msg('user', 3), msg('assistant', 4)]
    expect(historyLoss(messages, 2, null, [])).toEqual({ laterMessages: 0, clearsSummary: false, ...noLoss })
  })

  it('an edit of an earlier message counts everything after its own reply', () => {
    const messages = [msg('user', 1), msg('assistant', 2), msg('user', 3), msg('assistant', 4)]
    expect(historyLoss(messages, 0, null, [])).toEqual({ laterMessages: 2, clearsSummary: false, ...noLoss })
  })

  it('a message the summary covers clears it, on top of any later messages', () => {
    const messages = [msg('user', 1), msg('assistant', 2), msg('user', 3), msg('assistant', 4)]
    expect(historyLoss(messages, 0, { upTo: 2 }, [])).toEqual({ laterMessages: 2, clearsSummary: true, ...noLoss })
  })

  it('no compaction never clears a summary, however old the message', () => {
    const messages = [msg('user', 1), msg('assistant', 2)]
    expect(historyLoss(messages, 0, null, []).clearsSummary).toBe(false)
  })

  it('a user message with no reply yet loses no later messages', () => {
    const messages = [msg('user', 1)]
    expect(historyLoss(messages, 0, { upTo: 1 }, [])).toEqual({ laterMessages: 0, clearsSummary: true, ...noLoss })
  })

  it('a failed assistant reply still counts as the redone exchange, not as later history', () => {
    const messages = [
      msg('user', 1),
      msg('assistant', 2, { content: '', error: 'The model timed out.' }),
      msg('user', 3),
      msg('assistant', 4)
    ]
    expect(historyLoss(messages, 0, null, [])).toEqual({ laterMessages: 2, clearsSummary: false, ...noLoss })
  })

  it('flags an artifact whose only version came from the deleted reply, even with no later messages', () => {
    const messages = [msg('user', 1), msg('assistant', 2)]
    const a = artifact('a', 'Plan', ['assistant-2'])
    expect(historyLoss(messages, 0, null, [a]).lostArtifacts).toEqual([a])
  })

  it('does not flag an artifact that also has a version from a surviving, earlier reply', () => {
    const messages = [msg('user', 1), msg('assistant', 2), msg('user', 3), msg('assistant', 4)]
    const a = artifact('a', 'Plan', ['assistant-2', 'assistant-4'])
    // Editing the second exchange deletes only its own reply; the identifier's first version survives.
    expect(historyLoss(messages, 2, null, [a]).lostArtifacts).toEqual([])
  })

  it('flags a deleted reply’s edit_file or write_file call that ran, even with no later messages', () => {
    const messages = [
      msg('user', 1),
      msg('assistant', 2, { toolEvents: [{ tool: 'edit_file', args: {}, ok: true, summary: 'Edited x.ts' }] })
    ]
    expect(historyLoss(messages, 0, null, []).fileEditsMade).toBe(true)
  })

  it('does not flag a deleted reply whose tool calls never touched a file', () => {
    const messages = [
      msg('user', 1),
      msg('assistant', 2, { toolEvents: [{ tool: 'read_file', args: {}, ok: true, summary: 'Read x.ts' }] })
    ]
    expect(historyLoss(messages, 0, null, []).fileEditsMade).toBe(false)
  })

  it('does not count a declined edit_file call: it never ran', () => {
    const messages = [
      msg('user', 1),
      msg('assistant', 2, { toolEvents: [{ tool: 'edit_file', args: {}, ok: false, declined: true, summary: 'Denied' }] })
    ]
    expect(historyLoss(messages, 0, null, []).fileEditsMade).toBe(false)
  })

  it('does not count a failed edit_file call: it never ran either', () => {
    const messages = [
      msg('user', 1),
      msg('assistant', 2, { toolEvents: [{ tool: 'edit_file', args: {}, ok: false, summary: 'Error: no such file' }] })
    ]
    expect(historyLoss(messages, 0, null, []).fileEditsMade).toBe(false)
  })
})

describe('historyLossNotice', () => {
  const loss = (over: Partial<HistoryLoss> = {}): HistoryLoss => ({ laterMessages: 0, clearsSummary: false, ...noLoss, ...over })

  it('does not ask to retry the latest reply just because it made a new artifact', () => {
    const a = artifact('a', 'Plan', ['assistant-2'])
    expect(historyLossNotice('retry', loss({ lostArtifacts: [a] }))).toBeNull()
  })

  it('does not ask to retry the latest reply just because its edit_file ran', () => {
    expect(historyLossNotice('retry', loss({ fileEditsMade: true }))).toBeNull()
  })

  it('does not ask to edit the last user message just because its reply made an artifact or edited a file', () => {
    const a = artifact('a', 'Plan', ['assistant-2'])
    expect(historyLossNotice('edit', loss({ lostArtifacts: [a] }))).toBeNull()
    expect(historyLossNotice('edit', loss({ fileEditsMade: true }))).toBeNull()
  })

  it('asks with just the count when only later messages are at stake, and offers to delete', () => {
    expect(historyLossNotice('edit', loss({ laterMessages: 2 }))).toEqual({
      title: 'Edit this message?',
      lines: ['Its reply and the 2 messages after it will be deleted.'],
      confirmLabel: 'Edit and delete'
    })
  })

  it('uses the retry verb in its own delete label', () => {
    expect(historyLossNotice('retry', loss({ laterMessages: 3 }))?.confirmLabel).toBe('Retry and delete')
  })

  it('uses the edit verb in its own clear-summary label', () => {
    expect(historyLossNotice('edit', loss({ clearsSummary: true }))?.confirmLabel).toBe('Edit and clear summary')
  })

  it('a summary-only loss never gets the artifact or file lines, even if the reply made one', () => {
    const a = artifact('a', 'Plan', ['assistant-2'])
    const notice = historyLossNotice('retry', loss({ clearsSummary: true, lostArtifacts: [a], fileEditsMade: true }))
    expect(notice).toEqual({
      title: 'Retry this reply?',
      lines: [
        "The chat's summary covers this message, so it will be cleared. Later replies will send the full history again until you run /compact."
      ],
      confirmLabel: 'Retry and clear summary'
    })
  })

  it('names the artifact and the file edit alongside the count, once there are later messages', () => {
    const a = artifact('a', 'Plan', ['assistant-2', 'user-3', 'assistant-4'])
    const notice = historyLossNotice('edit', loss({ laterMessages: 2, lostArtifacts: [a], fileEditsMade: true }))
    expect(notice?.lines).toEqual([
      'Its reply and the 2 messages after it will be deleted.',
      'The artifact “Plan” will be deleted too.',
      'Changes those replies made to files in the folder stay as they are.'
    ])
    expect(notice?.confirmLabel).toBe('Edit and delete')
  })

  it('offers Continue when both later messages and the summary are at stake', () => {
    expect(historyLossNotice('retry', loss({ laterMessages: 2, clearsSummary: true }))?.confirmLabel).toBe('Continue')
  })

  it('names 1, 2-3, and 4+ artifacts differently', () => {
    const one = [artifact('a', 'Plan', ['assistant-2'])]
    const two = [...one, artifact('b', 'Notes', ['assistant-2'])]
    const three = [...two, artifact('c', 'Draft', ['assistant-2'])]
    const four = [...three, artifact('d', 'Sketch', ['assistant-2'])]
    expect(historyLossNotice('edit', loss({ laterMessages: 1, lostArtifacts: one }))?.lines[1]).toBe(
      'The artifact “Plan” will be deleted too.'
    )
    expect(historyLossNotice('edit', loss({ laterMessages: 1, lostArtifacts: two }))?.lines[1]).toBe(
      'The artifacts “Plan” and “Notes” will be deleted too.'
    )
    expect(historyLossNotice('edit', loss({ laterMessages: 1, lostArtifacts: three }))?.lines[1]).toBe(
      'The artifacts “Plan”, “Notes” and “Draft” will be deleted too.'
    )
    expect(historyLossNotice('edit', loss({ laterMessages: 1, lostArtifacts: four }))?.lines[1]).toBe(
      '4 artifacts made in those replies will be deleted too.'
    )
  })
})
