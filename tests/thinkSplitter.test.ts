import { describe, expect, it } from 'vitest'
import { createThinkSplitter, THINK_NEAR_START } from '../src/main/providers/openai/thinkSplitter'

/** Feed the pieces in turn, then flush; the totals of each part. */
function run(...pieces: string[]): { content: string; thinking: string } {
  const s = createThinkSplitter()
  const out = { content: '', thinking: '' }
  for (const p of [...pieces.map((x) => s.push(x)), s.flush()]) {
    out.content += p.content
    out.thinking += p.thinking
  }
  return out
}

const HOLD = THINK_NEAR_START + '</think>'.length - 1

describe('thinkSplitter', () => {
  it('passes a plain reply through', () => {
    expect(run('Hello ', 'there')).toEqual({ content: 'Hello there', thinking: '' })
  })

  it('splits a leading block from the reply', () => {
    expect(run('<think>\nPlan it.\n</think>\n\nAnswer.')).toEqual({ thinking: 'Plan it.\n', content: 'Answer.' })
  })

  it('allows whitespace before the leading block', () => {
    expect(run('\n  <think>x</think>y')).toEqual({ thinking: 'x', content: 'y' })
  })

  it('matches tags split across chunks', () => {
    expect(run('<th', 'ink>Let me', ' see</thi', 'nk>Ans', 'wer')).toEqual({ thinking: 'Let me see', content: 'Answer' })
  })

  it('holds back at most the start of a closing tag while thinking', () => {
    const s = createThinkSplitter()
    expect(s.push('<think>abcdefghij</thi')).toEqual({ thinking: 'abcdefghij', content: '' })
    expect(s.push('s is not a tag')).toEqual({ thinking: '</this is not a tag', content: '' })
  })

  it('treats a reply that starts mid-thinking as thinking up to its </think>', () => {
    expect(run('Okay, they said hi.\n</th', 'ink>\n\nHello!')).toEqual({ thinking: 'Okay, they said hi.\n', content: 'Hello!' })
  })

  it('leaves a </think> further in than the start in the reply', () => {
    const text = `${'x'.repeat(THINK_NEAR_START)}</think>rest`
    expect(run(text)).toEqual({ content: text, thinking: '' })
  })

  it('leaves a reply that mentions <think> intact', () => {
    const text = 'The <think> tag wraps reasoning, and </think> ends it.'
    expect(run(text)).toEqual({ content: text, thinking: '' })
  })

  it('counts only the leading block', () => {
    expect(run('<think>a</think>b<think>c</think>d')).toEqual({ thinking: 'a', content: 'b<think>c</think>d' })
  })

  it('keeps an unfinished block as thinking when the reply ends inside it', () => {
    expect(run('<think>still going</thi')).toEqual({ thinking: 'still going</thi', content: '' })
  })

  it('gives an empty block no thinking', () => {
    expect(run('<think>\n\n</think>\n\nHi')).toEqual({ thinking: '', content: 'Hi' })
  })

  it('gives a reply that is only the start of a tag back as the reply', () => {
    expect(run('<thi')).toEqual({ content: '<thi', thinking: '' })
  })

  it('releases a plain reply once it is too long to be closing a block', () => {
    const s = createThinkSplitter()
    expect(s.push('x'.repeat(HOLD - 1))).toEqual({ content: '', thinking: '' })
    expect(s.push('y')).toEqual({ content: `${'x'.repeat(HOLD - 1)}y`, thinking: '' })
    expect(s.push('z')).toEqual({ content: 'z', thinking: '' })
  })

  it('splits the same wherever the chunks break', () => {
    const replies = [
      '<think>\nPlan it.\n</think>\n\nAnswer.',
      'Okay, they said hi.\n</think>\n\nHello!',
      'The <think> tag wraps reasoning, and </think> ends it.',
      `${'plain '.repeat(20)}</think> later`,
      '  <think>é — ü</think> Café'
    ]
    for (const text of replies) {
      const whole = run(text)
      for (let cut = 1; cut < text.length; cut++) expect(run(text.slice(0, cut), text.slice(cut))).toEqual(whole)
      expect(run(...text.split(''))).toEqual(whole)
    }
  })
})
