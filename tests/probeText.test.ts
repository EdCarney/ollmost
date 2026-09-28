import { describe, expect, it } from 'vitest'
import { probeContextNote, suggestEndpointName } from '@shared/endpoints'

describe('probeContextNote', () => {
  it('says whether context sizes come from the server or the endpoint’s setting', () => {
    expect(probeContextNote({ reportsContext: true })).toBe('Context sizes reported by the server')
    expect(probeContextNote({ reportsContext: false })).toBe(
      'Context sizes not reported — models get 8K unless you change “Context when not reported”'
    )
  })
})

describe('suggestEndpointName', () => {
  it('names a new endpoint after its server, numbered when the name is taken', () => {
    expect(suggestEndpointName({ flavor: 'lmstudio' }, [])).toBe('LM Studio')
    expect(suggestEndpointName({ flavor: 'lmstudio' }, ['LM Studio'])).toBe('LM Studio 2')
    expect(suggestEndpointName({ flavor: 'lmstudio' }, ['LM Studio', 'LM Studio 2'])).toBe('LM Studio 3')
    expect(suggestEndpointName({ flavor: 'generic' }, ['Ollama'])).toBe('OpenAI-compatible')
  })
})
