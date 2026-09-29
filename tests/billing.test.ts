import { describe, expect, it } from 'vitest'
import { billingLabel, chatCostLabel, describeUsageModel, legacyBilling, traceCostTotal } from '@shared/billing'
import type { Endpoint, EndpointFlavor, EndpointKind, ModelBilling, TraceKind } from '@shared/types'

const ep = (id: string, name: string, kind: EndpointKind, flavor: EndpointFlavor, baseUrl: string): Endpoint => ({
  id,
  name,
  kind,
  flavor,
  baseUrl,
  enabled: true,
  hasKey: false
})
const endpoints = [
  ep('ollama', 'Ollama', 'ollama', 'ollama', 'http://127.0.0.1:11434'),
  ep('lm-studio', 'LM Studio', 'openai', 'lmstudio', 'http://localhost:1234/v1')
]

describe('a reply’s cost label', () => {
  it('shows dollars for a priced reply, and nothing while its price is unknown', () => {
    expect(billingLabel('priced', 0.0031)).toBe('$0.0031')
    expect(billingLabel('priced', 0)).toBe('$0')
    expect(billingLabel('priced', null)).toBeNull()
  })

  it('says local or cost not tracked instead of $0', () => {
    expect(billingLabel('local', 0)).toBe('local')
    expect(billingLabel('untracked', 0)).toBe('cost not tracked')
  })

  it('reads a reply saved before billing by its cost alone: $0 as local, anything else priced', () => {
    expect(legacyBilling(0)).toBe('local')
    expect(legacyBilling(0.2)).toBe('priced')
    expect(legacyBilling(null)).toBe('priced')
    expect(legacyBilling(undefined)).toBe('priced')
  })
})

describe('a chat’s cost chip', () => {
  const row = (billing: ModelBilling, costUsd: number | null) => ({ billing, costUsd })

  it('is local when every request ran on this Mac, and not tracked when every one went elsewhere', () => {
    expect(chatCostLabel([row('local', 0), row('local', 0)])).toBe('local')
    expect(chatCostLabel([row('untracked', 0)])).toBe('not tracked')
  })

  it('sums the priced requests when there are any', () => {
    expect(chatCostLabel([row('priced', 0.25), row('priced', 0.5), row('local', 0), row('untracked', 0)])).toBe('$0.750')
  })

  it('is cost unknown when a priced request has no price', () => {
    expect(chatCostLabel([row('priced', 0.25), row('priced', null), row('local', 0)])).toBe('cost unknown')
  })

  it('is not tracked, not $0, when nothing was priced and some went elsewhere', () => {
    expect(chatCostLabel([row('local', 0), row('untracked', 0)])).toBe('not tracked')
  })
})

describe('a usage row’s model and endpoint', () => {
  it('splits the key on its endpoint, keeping an Ollama name that has slashes whole', () => {
    expect(describeUsageModel('ollama/hf.co/bartowski/Qwen3-8B-GGUF:Q4_K_M', endpoints)).toEqual({
      name: 'hf.co/bartowski/Qwen3-8B-GGUF:Q4_K_M',
      endpoint: { id: 'ollama', name: 'Ollama', kind: 'ollama', flavor: 'ollama' }
    })
    expect(describeUsageModel('lm-studio/qwen/qwen3-8b', endpoints)).toEqual({
      name: 'qwen/qwen3-8b',
      endpoint: { id: 'lm-studio', name: 'LM Studio', kind: 'openai', flavor: 'lmstudio' }
    })
  })

  it('reads a bare leftover name with slashes as Ollama’s, whole: its "hf.co" is not an endpoint id', () => {
    expect(describeUsageModel('hf.co/bartowski/Qwen3-8B-GGUF:Q4_K_M', endpoints)).toEqual({
      name: 'hf.co/bartowski/Qwen3-8B-GGUF:Q4_K_M',
      endpoint: { id: 'ollama', name: 'Ollama', kind: 'ollama', flavor: 'ollama' }
    })
  })

  it('reads a key as a removed endpoint’s when Ollama itself is gone, as registry.resolve does', () => {
    const lmStudioOnly = endpoints.filter((e) => e.id !== 'ollama')
    const removed = { id: '', name: 'Removed endpoint', kind: 'openai', flavor: 'generic' }
    expect(describeUsageModel('gpt-oss:20b', lmStudioOnly)).toEqual({ name: 'gpt-oss:20b', endpoint: removed })
    expect(describeUsageModel('ollama/gpt-oss:20b', lmStudioOnly)).toEqual({ name: 'ollama/gpt-oss:20b', endpoint: removed })
  })

  it('reads a leftover bare name as Ollama’s, and a key whose endpoint is gone as a removed endpoint’s', () => {
    expect(describeUsageModel('gpt-oss:20b', endpoints).endpoint.name).toBe('Ollama')
    expect(describeUsageModel('old-box/llama3:8b', endpoints)).toEqual({
      name: 'old-box/llama3:8b',
      endpoint: { id: '', name: 'Removed endpoint', kind: 'openai', flavor: 'generic' }
    })
  })
})

describe('the debugger’s cost total', () => {
  const t = (kind: TraceKind, promptTokens: number | null, costUsd: number | null) => ({ kind, promptTokens, costUsd })

  it('adds billed requests, skipping tool calls and requests that failed before any tokens', () => {
    expect(traceCostTotal([t('chat', 100, 0.25), t('tool', null, null), t('chat', null, null), t('title', 50, 0)])).toBe(0.25)
  })

  it('is unknown when a billed request has no cost: only a priced one without a price has none', () => {
    expect(traceCostTotal([t('chat', 100, 0.25), t('replay', 80, null)])).toBeNull()
  })
})
