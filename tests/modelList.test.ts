import { describe, expect, it } from 'vitest'
import { mergeLateModels } from '../src/shared/modelList'
import type { ModelInfo, ModelListResult } from '../src/shared/types'

const model = (endpointId: string, name: string) => ({ key: `${endpointId}/${name}`, name, endpoint: { id: endpointId } }) as ModelInfo

const waiting = { endpointId: 'slow', message: 'Still waiting for Slow box at 10.0.0.9:1234…', pending: true as const }
const state: ModelListResult = {
  models: [model('fast', 'a'), model('fast', 'b')],
  errors: [waiting, { endpointId: 'down', message: "Can't reach Down box at 10.0.0.8:1234." }]
}

describe('a late answer from an endpoint', () => {
  it('puts its models in and clears its pending entry, leaving the others as they were', () => {
    const late = [model('slow', 'c')]
    expect(mergeLateModels(state, { endpointId: 'slow', models: late })).toEqual({
      models: [...state.models, ...late],
      errors: [state.errors[1]]
    })
  })

  it('replaces the models the endpoint had, and only those', () => {
    const before: ModelListResult = { models: [model('fast', 'a'), model('slow', 'old')], errors: [] }
    const merged = mergeLateModels(before, { endpointId: 'slow', models: [model('slow', 'new')] })
    expect(merged.models.map((m) => m.key)).toEqual(['fast/a', 'slow/new'])
  })

  it('turns its pending entry into an error, with no pending flag, when it failed', () => {
    const merged = mergeLateModels(state, { endpointId: 'slow', error: "Can't reach Slow box at 10.0.0.9:1234." })
    expect(merged.models).toEqual(state.models)
    expect(merged.errors).toEqual([state.errors[1], { endpointId: 'slow', message: "Can't reach Slow box at 10.0.0.9:1234." }])
    expect(merged.errors.find((e) => e.endpointId === 'slow')).not.toHaveProperty('pending')
  })

  it('does not change the state it was given', () => {
    const copy = structuredClone(state)
    mergeLateModels(state, { endpointId: 'slow', models: [model('slow', 'c')] })
    mergeLateModels(state, { endpointId: 'slow', error: 'no' })
    expect(state).toEqual(copy)
  })
})
