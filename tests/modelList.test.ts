import { describe, expect, it } from 'vitest'
import { keepPendingModels, mergeLateModels, nextDraftModel } from '../src/shared/modelList'
import type { Endpoint, ModelInfo, ModelListResult } from '../src/shared/types'

const model = (endpointId: string, name: string) => ({ key: `${endpointId}/${name}`, name, endpoint: { id: endpointId } }) as ModelInfo

const waiting = { endpointId: 'slow', message: 'Still waiting for Slow box at 10.0.0.9:1234…', pending: true as const }
const state: ModelListResult = {
  models: [model('fast', 'a'), model('fast', 'b')],
  errors: [waiting, { endpointId: 'down', message: "Can't reach Down box at 10.0.0.8:1234." }]
}

describe('a new list while an endpoint is still answering', () => {
  it('keeps what that endpoint listed last time, and only that endpoint’s', () => {
    const previous = [model('fast', 'a'), model('slow', 'c'), model('down', 'd'), model('gone', 'e')]
    const next: ModelListResult = { models: [model('fast', 'a2')], errors: state.errors }
    expect(keepPendingModels(previous, next).map((m) => m.key)).toEqual(['fast/a2', 'slow/c'])
  })

  it('is the new list as it came when nothing is pending', () => {
    const next: ModelListResult = { models: [model('fast', 'a2')], errors: [state.errors[1]] }
    expect(keepPendingModels([model('slow', 'c')], next)).toEqual(next.models)
  })
})

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

describe('the model a new chat starts with', () => {
  const ep = (id: string, name: string): Endpoint => ({
    id,
    name,
    kind: 'openai',
    flavor: 'generic',
    baseUrl: `http://${id}.local:1234/v1`,
    enabled: true,
    hasKey: false
  })
  const endpoints = [ep('fast', 'Fast box'), ep('gpu', 'GPU box'), ep('down', 'Down box')]
  const installed = (endpointId: string, name: string) => ({ ...model(endpointId, name), installed: true }) as ModelInfo
  const fastOnly: ModelListResult = { models: [model('fast', 'a'), installed('fast', 'b')], errors: [] }
  const gpuWaiting = { endpointId: 'gpu', message: 'Still waiting for GPU box at gpu.local:1234…', pending: true as const }
  const gpuDown = { endpointId: 'gpu', message: "Can't reach GPU box at gpu.local:1234." }
  const gpuListed: ModelListResult = { models: [...fastOnly.models, model('gpu', 'x')], errors: [] }

  it('switches an auto-picked model to the default once the default is listed', () => {
    const waiting: ModelListResult = { ...fastOnly, errors: [gpuWaiting] }
    expect(nextDraftModel('fast/b', true, 'gpu/x', waiting, endpoints)).toBe('fast/b')
    expect(nextDraftModel('fast/b', true, 'gpu/x', gpuListed, endpoints)).toBe('gpu/x')
  })

  it("keeps the user's own choice when the default is listed", () => {
    expect(nextDraftModel('fast/a', false, 'gpu/x', gpuListed, endpoints)).toBe('fast/a')
  })

  it("keeps a model whose endpoint is still answering, the user's or the auto-picked one", () => {
    const waiting: ModelListResult = { ...fastOnly, errors: [gpuWaiting] }
    expect(nextDraftModel('gpu/x', false, 'fast/a', waiting, endpoints)).toBe('gpu/x')
    expect(nextDraftModel('gpu/x', true, 'gpu/x', waiting, endpoints)).toBe('gpu/x')
  })

  it('replaces a model whose endpoint failed, is gone, or no longer lists it', () => {
    const failed: ModelListResult = { ...fastOnly, errors: [gpuDown] }
    expect(nextDraftModel('gpu/x', false, 'fast/a', failed, endpoints)).toBe('fast/a')
    expect(nextDraftModel('gpu/x', false, null, failed, endpoints)).toBe('fast/b')
    expect(nextDraftModel('gone/x', false, null, fastOnly, endpoints)).toBe('fast/b')
    expect(nextDraftModel('fast/zzz', false, null, fastOnly, endpoints)).toBe('fast/b')
  })

  it('picks the default, else an installed model, else the first, when there is no model yet', () => {
    expect(nextDraftModel(null, true, 'fast/a', fastOnly, endpoints)).toBe('fast/a')
    expect(nextDraftModel(null, true, 'gpu/x', fastOnly, endpoints)).toBe('fast/b')
    expect(nextDraftModel(null, true, null, { models: [model('fast', 'a'), model('fast', 'c')], errors: [] }, endpoints)).toBe('fast/a')
  })

  it('keeps an auto-picked model while the default is not listed', () => {
    expect(nextDraftModel('fast/a', true, 'gpu/x', fastOnly, endpoints)).toBe('fast/a')
  })

  it('has nothing to pick from an empty list, and leaves the model as it is', () => {
    const waiting: ModelListResult = { models: [], errors: [gpuWaiting] }
    expect(nextDraftModel(null, true, 'gpu/x', waiting, endpoints)).toBeNull()
    expect(nextDraftModel('fast/a', false, 'gpu/x', waiting, endpoints)).toBe('fast/a')
  })
})
