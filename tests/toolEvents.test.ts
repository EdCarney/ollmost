import { describe, expect, it } from 'vitest'
import { childId, withChildEvents } from '../src/shared/toolEvents'
import type { ToolEvent } from '../src/shared/types'

const event = (tool: string, extra: Partial<ToolEvent> = {}): ToolEvent => ({ tool, args: {}, ok: true, summary: tool, ...extra })

describe('withChildEvents', () => {
  it('gives each event followed by its sub-agent’s own calls, in order', () => {
    const read = event('read_file')
    const edit = event('edit_file')
    const delegate = event('delegate', { child: { task: 'Fix it.', events: [read, edit], result: 'Fixed.', rounds: 2 } })
    const before = event('list_files')
    const after = event('write_file')
    expect(withChildEvents([before, delegate, after])).toEqual([before, delegate, read, edit, after])
  })

  it('skips the gaps a live reply’s events can have', () => {
    const search = event('web_search')
    const delegate = event('delegate', { pending: true, child: { task: 'Look.', events: [undefined!, search], result: '', rounds: 1 } })
    expect(withChildEvents([undefined!, delegate])).toEqual([delegate, search])
  })

  it('leaves a reply without sub-agents as it was', () => {
    const events = [event('web_search'), event('web_fetch')]
    expect(withChildEvents(events)).toEqual(events)
  })
})

describe('childId', () => {
  it('keys a sub-agent by its parent’s message and the delegate call’s index there', () => {
    expect(childId('m1', 2)).toBe('m1#2')
  })
})
