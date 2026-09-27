import { describe, expect, it } from 'vitest'
import { parseMessage, parseMessageRanges } from '../src/shared/artifactParser'
import { interleave, type TimelineItem } from '../src/shared/timeline'
import type { ThinkingSegment, ToolEvent } from '../src/shared/types'

const ev = (tool: string, at?: number): ToolEvent => ({ tool, args: {}, ok: true, summary: tool, ...(at === undefined ? {} : { at }) })

const think = (text: string, at: number, index: number): ThinkingSegment => ({ text, at, index, ms: null })

/** A compact picture of the timeline: text as-is, artifacts as [artifact id], tool groups as tools(a,b), thinking as think(text). */
function shape(content: string, events: ToolEvent[], thinking: ThinkingSegment[] = []): string[] {
  return interleave(parseMessageRanges(content), events, thinking).map((item: TimelineItem) =>
    item.kind === 'tools'
      ? `tools(${item.events.map((e) => `${e.event.tool}#${e.index}`).join(',')})`
      : item.kind === 'thinking'
        ? `think(${item.thinking.text})`
        : item.segment.kind === 'text'
          ? item.segment.text
          : `[artifact ${item.segment.identifier}]`
  )
}

describe('parseMessageRanges', () => {
  it('gives each segment its range in the raw text, and parseMessage stays the same', () => {
    const raw = 'Intro.\n<artifact identifier="a" type="code" title="A">x = 1</artifact>\nOutro.'
    const ranged = parseMessageRanges(raw)
    expect(ranged.map((s) => raw.slice(s.start, s.end))).toEqual([
      'Intro.\n',
      '<artifact identifier="a" type="code" title="A">x = 1</artifact>',
      '\nOutro.'
    ])
    expect(parseMessage(raw)).toEqual(ranged.map(({ start: _s, end: _e, ...seg }) => seg))
  })
})

describe('interleave', () => {
  it('puts a call at the point in the text where it was made', () => {
    const content = 'Let me search.\n\nHere is what I found.'
    expect(shape(content, [ev('web_search', 14)])).toEqual(['Let me search.', 'tools(web_search#0)', '\n\nHere is what I found.'])
  })

  it('keeps calls made at the same point together, in call order', () => {
    const content = 'Checking.\n\nDone.'
    expect(shape(content, [ev('b', 9), ev('a', 9), ev('c', 17)])).toEqual(['Checking.', 'tools(b#0,a#1)', '\n\nDone.', 'tools(c#2)'])
  })

  it('shows calls from before positions were recorded first, as it used to', () => {
    expect(shape('Answer.', [ev('web_search'), ev('web_fetch')])).toEqual(['tools(web_search#0,web_fetch#1)', 'Answer.'])
  })

  it('shows a call still running at the end of the streamed text', () => {
    expect(shape('Let me look.', [ev('web_fetch', 12)])).toEqual(['Let me look.', 'tools(web_fetch#0)'])
    expect(shape('', [ev('web_fetch', 0)])).toEqual(['tools(web_fetch#0)'])
  })

  it('never splits an artifact: a call inside one goes after it', () => {
    const content = 'Here:\n<artifact identifier="page" type="html" title="Page"><p>hi</p></artifact>\nBye.'
    const inside = content.indexOf('<p>')
    expect(shape(content, [ev('tool', inside)])).toEqual(['Here:\n', '[artifact page]', 'tools(tool#0)', '\nBye.'])
  })

  it('never splits a fenced code block: a call inside one goes after its closing fence', () => {
    const content = 'Code:\n```js\nlet a = 1\nlet b = 2\n```\nAfter.'
    const inside = content.indexOf('let b')
    expect(shape(content, [ev('tool', inside)])).toEqual(['Code:\n```js\nlet a = 1\nlet b = 2\n```\n', 'tools(tool#0)', 'After.'])
  })

  it('places a call even when the text around an artifact was trimmed (a stray wrapping fence)', () => {
    const content = 'Look:\n```\n<artifact identifier="n" type="markdown" title="N">note</artifact>\n```\nEnd.'
    const items = shape(content, [ev('tool', content.indexOf('\n```\nEnd') + 2)])
    expect(items).toContain('tools(tool#0)')
    expect(items.filter((i) => i.startsWith('tools'))).toHaveLength(1)
  })

  it('drops whitespace-only text between calls', () => {
    expect(shape('A.\n\n\n\nB.', [ev('x', 2), ev('y', 4)])).toEqual(['A.', 'tools(x#0,y#1)', '\n\nB.'])
  })
})

describe('interleave with thinking', () => {
  it('shows each round’s thinking where the round began: after the calls that ended the round before', () => {
    const content = 'Let me check.\n\nFound it.'
    expect(shape(content, [ev('web_search', 13)], [think('first', 0, 0), think('second', 13, 1)])).toEqual([
      'think(first)',
      'Let me check.',
      'tools(web_search#0)',
      'think(second)',
      '\n\nFound it.'
    ])
  })

  it('keeps a round’s thinking before the calls that round made without any text', () => {
    const content = 'Checking.'
    expect(shape(content, [ev('a', 9), ev('b', 9)], [think('one', 0, 0), think('two', 9, 1)])).toEqual([
      'think(one)',
      'Checking.',
      'tools(a#0)',
      'think(two)',
      'tools(b#1)'
    ])
  })

  it('shows the open round’s thinking last while the reply streams', () => {
    expect(shape('Let me look.', [ev('web_fetch', 12)], [think('now', 12, 1)])).toEqual([
      'Let me look.',
      'tools(web_fetch#0)',
      'think(now)'
    ])
    expect(shape('', [], [think('starting', 0, 0)])).toEqual(['think(starting)'])
  })

  it('shows an old reply’s thinking first, before calls made before positions were recorded', () => {
    expect(shape('Answer.', [ev('web_search'), ev('web_fetch')], [think('old', 0, 0)])).toEqual([
      'think(old)',
      'tools(web_search#0,web_fetch#1)',
      'Answer.'
    ])
  })

  it('never splits a fenced code block for thinking either', () => {
    const content = 'Code:\n```js\nlet a = 1\nlet b = 2\n```\nAfter.'
    const inside = content.indexOf('let b')
    expect(shape(content, [ev('tool', inside)], [think('mid', inside, 1)])).toEqual([
      'Code:\n```js\nlet a = 1\nlet b = 2\n```\n',
      'tools(tool#0)',
      'think(mid)',
      'After.'
    ])
  })
})
