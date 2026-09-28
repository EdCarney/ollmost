import { describe, expect, it } from 'vitest'
import { createToolCallAccumulator, firstMadeUpId, madeUpToolCallId } from '../src/main/providers/openai/toolCalls'
import type { ChatMessage } from '../src/main/providers/types'

const start = (index: number, id: string | undefined, name: string) => ({
  index,
  ...(id && { id }),
  type: 'function',
  function: { name, arguments: '' }
})
const frag = (index: number, args: string) => ({ index, function: { arguments: args } })

describe('createToolCallAccumulator', () => {
  it('builds a call from its fragments: id and name first, then the arguments piece by piece', () => {
    const acc = createToolCallAccumulator()
    acc.add([start(0, 'call_abc', 'get_weather')])
    acc.add([frag(0, '{"ci')])
    acc.add([frag(0, 'ty": "Pa')])
    acc.add([frag(0, 'ris"}')])
    expect(acc.finish()).toEqual([{ id: 'call_abc', function: { name: 'get_weather', arguments: { city: 'Paris' } } }])
  })

  // Review Focus #3.
  it('keeps two calls apart when their fragments interleave by index, escapes split across chunks included', () => {
    const acc = createToolCallAccumulator()
    acc.add([start(0, 'call_a', 'write_file')])
    acc.add([start(1, 'call_b', 'web_search')])
    acc.add([frag(0, '{"path": "a.txt", "text": "say \\')])
    acc.add([frag(1, '{"query": "caf\\u00')])
    acc.add([frag(0, '"hi\\" to Ren'), frag(1, 'e9 crème"}')])
    acc.add([frag(0, 'ée"}')])
    expect(acc.finish()).toEqual([
      { id: 'call_a', function: { name: 'write_file', arguments: { path: 'a.txt', text: 'say "hi" to Renée' } } },
      { id: 'call_b', function: { name: 'web_search', arguments: { query: 'café crème' } } }
    ])
  })

  it('takes a whole call sent in one delta', () => {
    const acc = createToolCallAccumulator()
    acc.add([{ index: 0, id: 'c1', type: 'function', function: { name: 'web_fetch', arguments: '{"url":"https://k.io"}' } }])
    expect(acc.finish()).toEqual([{ id: 'c1', function: { name: 'web_fetch', arguments: { url: 'https://k.io' } } }])
  })

  it('passes arguments that aren’t valid JSON through as text', () => {
    const acc = createToolCallAccumulator()
    acc.add([start(0, 'c1', 'run_code'), frag(0, '{"code": "print(1)"')])
    expect(acc.finish()).toEqual([{ id: 'c1', function: { name: 'run_code', arguments: '{"code": "print(1)"' } }])
  })

  it('makes up a 9-character id for a call that came without one, and keeps one the server sent', () => {
    const acc = createToolCallAccumulator()
    acc.add([start(0, undefined, 'a'), start(1, 'srv-id', 'b'), start(2, undefined, 'c')])
    // 't' and the call's place in base 36: Mistral's chat templates on vLLM refuse any id that isn't 9 letters and digits.
    expect(acc.finish().map((c) => c.id)).toEqual(['t00000000', 'srv-id', 't00000002'])
  })

  it("numbers made-up ids from finish's argument, so a turn's later rounds don't repeat one", () => {
    const acc = createToolCallAccumulator()
    acc.add([start(0, undefined, 'a'), start(1, 'srv-id', 'b'), start(2, undefined, 'c')])
    expect(acc.finish(3).map((c) => c.id)).toEqual(['t00000003', 'srv-id', 't00000005'])
  })

  it('reads empty arguments as no arguments', () => {
    const acc = createToolCallAccumulator()
    acc.add([start(0, 'c1', 'list_files')])
    expect(acc.finish()[0].function.arguments).toEqual({})
  })

  it('separates whole calls sent without an index', () => {
    const acc = createToolCallAccumulator()
    acc.add([{ id: 'a', function: { name: 'x', arguments: '{}' } }])
    acc.add([{ id: 'b', function: { name: 'y', arguments: '{"n":1}' } }])
    expect(acc.finish()).toEqual([
      { id: 'a', function: { name: 'x', arguments: {} } },
      { id: 'b', function: { name: 'y', arguments: { n: 1 } } }
    ])
  })

  it('doesn’t double a name a server repeats with every fragment', () => {
    const acc = createToolCallAccumulator()
    acc.add([{ index: 0, id: 'c1', function: { name: 'get_weather', arguments: '{"city":' } }])
    acc.add([{ index: 0, function: { name: 'get_weather', arguments: '"Oslo"}' } }])
    expect(acc.finish()).toEqual([{ id: 'c1', function: { name: 'get_weather', arguments: { city: 'Oslo' } } }])
  })

  it('takes arguments a server sends as an object', () => {
    const acc = createToolCallAccumulator()
    acc.add([{ index: 0, id: 'c1', function: { name: 'f', arguments: { a: 1 } } }])
    expect(acc.finish()[0].function.arguments).toEqual({ a: 1 })
  })

  it('drops a fragment that never got a name, and ignores what isn’t a fragment', () => {
    const acc = createToolCallAccumulator()
    acc.add([null, 'x', frag(3, '{"a":1}'), start(0, 'c1', 'f')])
    expect(acc.finish()).toEqual([{ id: 'c1', function: { name: 'f', arguments: {} } }])
  })

  it('gives nothing when no call came', () => {
    expect(createToolCallAccumulator().finish()).toEqual([])
  })
})

describe('madeUpToolCallId', () => {
  it('is "t" and the number in base 36, padded to 8 digits', () => {
    expect(madeUpToolCallId(0)).toBe('t00000000')
    expect(madeUpToolCallId(35)).toBe('t0000000z')
  })
})

describe('firstMadeUpId', () => {
  it('is 0 when there are no messages', () => {
    expect(firstMadeUpId([])).toBe(0)
  })

  it("is 0 when the history's calls carry only server or earlier-turn ids", () => {
    const messages: ChatMessage[] = [
      {
        role: 'assistant',
        content: '',
        toolCalls: [
          { id: 'srv-id', function: { name: 'a', arguments: {} } },
          { id: 'c00010000', function: { name: 'b', arguments: {} } }
        ]
      }
    ]
    expect(firstMadeUpId(messages)).toBe(0)
  })

  it('is one past the highest made-up id in the history, ignoring one that is not 9 characters', () => {
    const messages: ChatMessage[] = [
      {
        role: 'assistant',
        content: '',
        toolCalls: [
          { id: 't00000000', function: { name: 'a', arguments: {} } },
          { id: 't0000000a', function: { name: 'b', arguments: {} } },
          { id: 't123', function: { name: 'c', arguments: {} } }
        ]
      }
    ]
    expect(firstMadeUpId(messages)).toBe(11)
  })
})
