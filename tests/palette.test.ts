import { describe, expect, it } from 'vitest'
import { matchScore, rankCommands } from '../src/shared/palette'

const cmds = [
  { id: 'theme', title: 'Change theme', keywords: ['appearance', 'colors'] },
  { id: 'mode', title: 'Appearance mode', keywords: ['light', 'dark', 'system'] },
  { id: 'model', title: 'Default model' },
  { id: 'new-chat', title: 'New chat' },
  { id: 'settings', title: 'Open Settings' }
]

describe('matching a palette query', () => {
  it('scores a prefix above a word start, a word start above a substring, and a substring above a scattered match', () => {
    const prefix = matchScore('cha', 'Change theme')
    const wordStart = matchScore('the', 'Change theme')
    const substring = matchScore('ange', 'Change theme')
    const scattered = matchScore('chtm', 'Change theme')
    expect(prefix).toBeGreaterThan(wordStart)
    expect(wordStart).toBeGreaterThan(substring)
    expect(substring).toBeGreaterThan(scattered)
    expect(scattered).toBeGreaterThan(0)
    expect(matchScore('xyz', 'Change theme')).toBe(0)
    expect(matchScore('', 'Change theme')).toBe(0)
  })

  it('ignores case and surrounding spaces', () => {
    expect(matchScore('  CHANGE ', 'change theme')).toBeGreaterThan(0)
  })
})

describe('ranking commands', () => {
  it('lists recent commands first, in recent order, then the rest as given, when nothing is typed', () => {
    expect(rankCommands('', cmds, ['model', 'theme', 'gone']).map((c) => c.id)).toEqual(['model', 'theme', 'mode', 'new-chat', 'settings'])
  })

  it('keeps only what matches the title or a keyword, best matches first, recents breaking ties, then the given order', () => {
    expect(rankCommands('dark', cmds, []).map((c) => c.id)).toEqual(['mode'])
    expect(rankCommands('the', cmds, []).map((c) => c.id)).toEqual(['theme'])
    // "mo" starts a word in both "Appearance mode" and "Default model": the recent one wins the tie, else the order.
    expect(rankCommands('mo', cmds, ['model']).map((c) => c.id)).toEqual(['model', 'mode'])
    expect(rankCommands('mo', cmds, ['mode']).map((c) => c.id)).toEqual(['mode', 'model'])
    expect(rankCommands('mo', cmds, []).map((c) => c.id)).toEqual(['mode', 'model'])
    expect(rankCommands('zzz', cmds, ['model'])).toEqual([])
  })

  it('puts a match in the title above the same match in a keyword', () => {
    const list = [
      { id: 'size', title: 'Text size', keywords: ['font size'] },
      { id: 'font', title: 'Response font', keywords: ['serif'] }
    ]
    expect(rankCommands('font', list, []).map((c) => c.id)).toEqual(['font', 'size'])
  })

  it('takes a query of several words, each matching somewhere, and ignores filler words like set or open', () => {
    expect(rankCommands('set default model', cmds, []).map((c) => c.id)).toEqual(['model'])
    expect(rankCommands('open settings', cmds, []).map((c) => c.id)).toEqual(['settings'])
    expect(rankCommands('dark mode', cmds, []).map((c) => c.id)).toEqual(['mode'])
    expect(rankCommands('change theme', cmds, []).map((c) => c.id)).toEqual(['theme'])
    // Every word must land somewhere: "new theme" matches nothing.
    expect(rankCommands('new theme', cmds, [])).toEqual([])
    // A query that is only filler still matches by its own letters.
    expect(rankCommands('the', cmds, []).map((c) => c.id)).toEqual(['theme'])
  })
})
