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

  it('says it is waiting, not that it failed, while endpoints are still answering', () => {
    const waiting = (id: string) => ({ endpointId: id, message: `Still waiting for ${id} at ${id}.local:1234…`, pending: true as const })
    expect(noModelsNotice([ep('a'), ep('b')], [waiting('a'), waiting('b')])).toEqual({
      heading: 'Waiting for a and b…',
      note: null,
      waiting: true
    })
    expect(noModelsNotice([ep('a'), ep('off', { enabled: false })], [waiting('a')])).toMatchObject({ heading: 'Waiting for a…' })
    expect(noModelsNotice([ep('a'), ep('b'), ep('c')], [waiting('a'), waiting('b'), waiting('c')]).heading).toBe('Waiting for a, b and c…')
    // Another endpoint that failed doesn't make the slow one a failure too: it may still answer.
    expect(noModelsNotice([ep('a'), ep('b')], [failed('a'), waiting('b')])).toMatchObject({ heading: 'Waiting for b…', waiting: true })
    // A pending entry for an endpoint that's gone or switched off names no one to wait for.
    expect(noModelsNotice([ep('a')], [waiting('gone')])).not.toHaveProperty('waiting')
  })

  it('says the others have no models when only some failed', () => {
    expect(noModelsNotice([ep('a'), ep('b')], [failed('a')])).toEqual({
      heading: "Ollmost can't find any models.",
      note: 'Your other endpoints have no models yet.'
    })
  })
})
