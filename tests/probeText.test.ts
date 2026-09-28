import { describe, expect, it } from 'vitest'
import { probeContextNote, suggestEndpointName } from '@shared/endpoints'

describe('probeContextNote', () => {
  it('says whether context sizes come from the server or the endpoint’s setting', () => {
    expect(probeContextNote({ reportsContext: true, flavor: 'vllm' })).toBe('Context sizes reported by the server')
    expect(probeContextNote({ reportsContext: false, flavor: 'generic' })).toBe(
      'Context sizes not reported — models get 8K unless you change “Context when not reported”'
    )
  })

  // LM Studio reports no size for a model it hasn't loaded yet (FINDINGS Q6), which is every model at add time.
  it('says an LM Studio server reports a size once the model is loaded', () => {
    expect(probeContextNote({ reportsContext: false, flavor: 'lmstudio' })).toBe(
      'Context sizes reported once a model is loaded — until then models get 8K unless you change “Context when not reported”'
    )
    expect(probeContextNote({ reportsContext: true, flavor: 'lmstudio' })).toBe('Context sizes reported by the server')
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
