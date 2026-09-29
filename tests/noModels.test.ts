import { describe, expect, it } from 'vitest'
import { noModelsNotice } from '../src/shared/noModels'
import type { Endpoint } from '../src/shared/types'

const ep = (id: string, over: Partial<Endpoint> = {}): Endpoint => ({
  id,
  name: id,
  kind: 'openai',
  flavor: 'lmstudio',
  baseUrl: `http://${id}.local:1234/v1`,
  enabled: true,
  hasKey: false,
  ...over
})
const failed = (endpointId: string) => ({ endpointId, message: `Can't reach ${endpointId}.` })

describe('Home with no models', () => {
  it('says why when no endpoint failed', () => {
    expect(noModelsNotice([], [])).toEqual({
      heading: "Ollmost can't find any models.",
      note: 'No endpoints yet. Add one in Settings → Models.'
    })
    expect(noModelsNotice([ep('a', { enabled: false })], []).note).toBe(
      'Your endpoints are all turned off. Turn one on in Settings → Models.'
    )
    expect(noModelsNotice([ep('a')], []).note).toBe(
      'None of your endpoints has a model yet. Add one, or add another endpoint in Settings → Models.'
    )
  })

  it('says it couldn’t load from any endpoint when every one asked failed', () => {
    const all = { heading: "Couldn't load models from any endpoint", note: null }
    expect(noModelsNotice([ep('a'), ep('b')], [failed('a'), failed('b')])).toEqual(all)
    // A switched-off endpoint isn't asked, so it doesn't count as one that answered.
    expect(noModelsNotice([ep('a'), ep('off', { enabled: false })], [failed('a')])).toEqual(all)
    // The list call itself failed: nothing was asked.
    expect(noModelsNotice([ep('a'), ep('b')], [{ endpointId: '', message: 'Something broke.' }])).toEqual(all)
  })

  it('says the others have no models when only some failed', () => {
    expect(noModelsNotice([ep('a'), ep('b')], [failed('a')])).toEqual({
      heading: "Ollmost can't find any models.",
      note: 'Your other endpoints have no models yet.'
    })
  })
})
