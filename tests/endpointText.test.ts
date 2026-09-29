import { describe, expect, it } from 'vitest'
import { probeSummary, removalText } from '../src/shared/endpoints'
import type { EndpointProbe } from '../src/shared/types'

const probe = (over: Partial<EndpointProbe>): EndpointProbe => ({
  kind: 'openai',
  flavor: 'lmstudio',
  baseUrl: 'http://localhost:1234/v1',
  version: null,
  models: 0,
  withTools: 0,
  withVision: 0,
  canThink: 0,
  reportsCapabilities: true,
  reportsContext: true,
  ...over
})

describe('what the Add endpoint dialog found', () => {
  it('names the server and counts what it reported', () => {
    expect(probeSummary(probe({ version: '0.4', models: 5, withTools: 4, withVision: 1, canThink: 2 }))).toBe(
      'Found LM Studio 0.4 · 5 models · 4 with tools · 1 with vision · 2 can think'
    )
    expect(probeSummary(probe({ kind: 'ollama', flavor: 'ollama', version: '0.12.3', models: 1 }))).toBe('Found Ollama 0.12.3 · 1 model')
    expect(probeSummary(probe({ flavor: 'llamacpp', version: 'b6600-abc1234', models: 1, withTools: 1 }))).toBe(
      'Found llama.cpp b6600-abc1234 · 1 model · 1 with tools · 0 with vision · 0 can think'
    )
  })

  it('says when a server reports no capabilities, and what applies instead', () => {
    expect(probeSummary(probe({ flavor: 'generic', models: 12, reportsCapabilities: false }))).toBe(
      'Found an OpenAI-compatible server · 12 models · capabilities not reported — defaults apply (tools on, vision off)'
    )
    expect(probeSummary(probe({ flavor: 'vllm', version: '0.11.0', models: 1, reportsCapabilities: false }))).toBe(
      'Found vLLM 0.11.0 · 1 model · capabilities not reported — defaults apply (tools on, vision off)'
    )
  })
})

describe('the question before an endpoint is removed', () => {
  it('says what goes, as the spec words it', () => {
    expect(removalText('LM Studio', { chats: 12, hasKey: true, overrides: 3 })).toEqual({
      title: 'Remove LM Studio?',
      body: ['12 chats use its models; they keep their history but need a new model picked.', 'Its API key and model settings are deleted.']
    })
  })

  it('names only what there is', () => {
    expect(removalText('GPU box', { chats: 1, hasKey: false, overrides: 2 }).body).toEqual([
      '1 chat uses its models; it keeps its history but needs a new model picked.',
      'Its model settings are deleted.'
    ])
    expect(removalText('GPU box', { chats: 0, hasKey: true, overrides: 0 }).body).toEqual([
      'No chats use its models.',
      'Its API key is deleted.'
    ])
    expect(removalText('GPU box', { chats: 0, hasKey: false, overrides: 0 }).body).toEqual(['No chats use its models.'])
  })
})
