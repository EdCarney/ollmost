import { describe, expect, it } from 'vitest'
import { effectiveCapabilities } from '../src/main/providers/capabilities'

describe('effectiveCapabilities', () => {
  it('uses what the server reported when nothing else is known', () => {
    expect(effectiveCapabilities(['completion', 'tools'], {}, {})).toEqual(['completion', 'tools'])
  })

  it('lets what an error taught turn tools off', () => {
    expect(effectiveCapabilities(['completion', 'tools', 'vision'], {}, { tools: false, reason: 'server lacks --jinja' })).toEqual([
      'completion',
      'vision'
    ])
  })

  it('puts the user’s choice above what was learned and what was reported', () => {
    expect(effectiveCapabilities(['completion'], { tools: true, vision: true }, { tools: false })).toEqual([
      'completion',
      'tools',
      'vision'
    ])
    expect(effectiveCapabilities(['completion', 'tools', 'vision'], { tools: false, vision: false }, {})).toEqual(['completion'])
  })

  it('keeps every other capability, in its order', () => {
    expect(effectiveCapabilities(['completion', 'vision', 'tools', 'thinking'], {}, {})).toEqual([
      'completion',
      'vision',
      'tools',
      'thinking'
    ])
    expect(effectiveCapabilities(['completion', 'thinking'], { vision: true }, {})).toEqual(['completion', 'thinking', 'vision'])
  })
})
