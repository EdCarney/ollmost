import { describe, expect, it } from 'vitest'
import { matchScore, rankCommands, SCATTERED, settingsTabCommands } from '../src/shared/palette'

const cmds = [
  { id: 'theme', title: 'Change theme', keywords: ['appearance', 'colors'] },
  { id: 'mode', title: 'Appearance mode', keywords: ['light', 'dark', 'system'] },
  { id: 'model', title: 'Default model' },
  { id: 'new-chat', title: 'New chat' },
  { id: 'settings', title: 'Open Settings' }
]

describe('matching a palette query', () => {
  it('scores the whole text, then a prefix, a whole word, a word start, a substring, then a scattered match', () => {
    const whole = matchScore('change theme', 'Change theme')
    const prefix = matchScore('cha', 'Change theme')
    const wholeWord = matchScore('theme', 'Change theme')
    const wordStart = matchScore('the', 'Change theme')
    const substring = matchScore('ange', 'Change theme')
    const scattered = matchScore('chtm', 'Change theme')
    expect(whole).toBeGreaterThan(prefix)
    expect(prefix).toBeGreaterThan(wholeWord)
    expect(wholeWord).toBeGreaterThan(wordStart)
    expect(wordStart).toBeGreaterThan(substring)
    expect(substring).toBeGreaterThan(scattered)
    expect(scattered).toBe(SCATTERED)
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
    // Punctuation on its own, as in the issue's "open Settings → Tools", is not a word.
    expect(rankCommands('open settings → theme', cmds, []).map((c) => c.id)).toEqual([])
    expect(rankCommands('change → theme', cmds, []).map((c) => c.id)).toEqual(['theme'])
  })

  it('ranks letters scattered through a title below a keyword that starts with the query, and leaves them out when asked', () => {
    const list = [
      { id: 'mode', title: 'Appearance mode', keywords: ['light', 'dark'] },
      { id: 'tools', title: 'Settings › Tools', keywords: ['code runner', 'mcp'] }
    ]
    expect(rankCommands('code', list, []).map((c) => c.id)).toEqual(['tools', 'mode'])
    expect(rankCommands('code', list, [], { loose: false }).map((c) => c.id)).toEqual(['tools'])
  })

  // The queries from #142: chats named "rust", "test" and "api" ran a command on Enter.
  it('never matches a keyword by scattered letters, and a title that way only loosely (#142)', () => {
    const registry = [
      { id: 'debugger', title: 'Open the debugger', keywords: ['requests', 'traces', 'replay'] },
      { id: 'usage', title: 'Settings › Usage & cost', keywords: ['settings', 'preferences', 'quota', 'spend', 'tokens', 'api key'] },
      { id: 'general', title: 'Settings › General', keywords: ['settings', 'preferences', 'name'] }
    ]
    // r-u-s-t is in "requests"; no one typing it means the debugger.
    expect(rankCommands('rust', registry, [])).toEqual([])
    // t-e-s-t is in the Usage & cost title: listed only when loose matches are wanted.
    expect(rankCommands('test', registry, []).map((c) => c.id)).toEqual(['usage'])
    expect(rankCommands('test', registry, [], { loose: false })).toEqual([])
    // A keyword the query starts is a real match either way.
    expect(rankCommands('api', registry, [], { loose: false }).map((c) => c.id)).toEqual(['usage'])
  })

  it('scores a whole word above a word’s start (#142)', () => {
    const list = [
      { id: 'model', title: 'Default model' },
      { id: 'mode', title: 'Appearance mode' }
    ]
    expect(rankCommands('mode', list, []).map((c) => c.id)).toEqual(['mode', 'model'])
    expect(rankCommands('mod', list, []).map((c) => c.id)).toEqual(['model', 'mode'])
  })
})

describe('settings tabs in the palette', () => {
  it('sends connections, endpoints and model servers to the Models tab', () => {
    for (const query of ['connection', 'endpoint', 'lm studio', 'vllm', 'llama.cpp', 'ollama'])
      expect(rankCommands(query, settingsTabCommands(), [])[0]?.tab, query).toBe('models')
  })

  it('keeps your name and preferences on General', () => {
    expect(rankCommands('name', settingsTabCommands(), [])[0]?.tab).toBe('general')
  })
})
