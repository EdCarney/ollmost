import { describe, expect, it } from 'vitest'
import { childId, pausedOnYou, withChildEvents } from '../src/shared/toolEvents'
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

describe('pausedOnYou', () => {
  const asking = event('run_command', { pending: true, awaiting: true })
  const running = event('delegate', { pending: true, child: { task: 'Look.', events: [], result: '', rounds: 1 } })
  const done = event('web_search')

  it('is paused once a call waits for an answer and nothing else still runs', () => {
    expect(pausedOnYou([done, asking])).toBe(true)
  })

  it('is still working while another call runs beside the one asking (#177)', () => {
    expect(pausedOnYou([asking, running])).toBe(false)
  })

  it('is paused when the only other calls wait their turn behind the ones asking: nothing runs', () => {
    const queued = event('delegate', { pending: true, queued: true, child: { task: 'Later.', events: [], result: '', rounds: 0 } })
    expect(pausedOnYou([asking, asking, queued])).toBe(true)
  })

  it('is working while nothing asks, running or not, and over the gaps a live reply’s events can have', () => {
    expect(pausedOnYou([undefined, running])).toBe(false)
    expect(pausedOnYou([done])).toBe(false)
    expect(pausedOnYou([])).toBe(false)
  })

  it('counts a sub-agent asking through its own call as waiting', () => {
    const child = { task: 'Tidy.', events: [event('run_command', { pending: true, awaiting: true })], result: '', rounds: 1 }
    expect(pausedOnYou([event('delegate', { pending: true, awaiting: true, child })])).toBe(true)
  })
})
