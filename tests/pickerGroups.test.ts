import { describe, expect, it } from 'vitest'
import { whereOf } from '../src/shared/endpoints'
import { toModelKey } from '../src/shared/modelKey'
import { endpointChips, groupModels } from '../src/shared/pickerGroups'
import type { Endpoint, ModelInfo, ModelListResult, ModelWhere } from '../src/shared/types'

const ep = (id: string, name: string, kind: Endpoint['kind'], baseUrl: string, over: Partial<Endpoint> = {}): Endpoint => ({
  id,
  name,
  kind,
  flavor: kind === 'ollama' ? 'ollama' : 'lmstudio',
  baseUrl,
  enabled: true,
  hasKey: false,
  ...over
})
const model = (e: Endpoint, name: string, where: ModelWhere = whereOf(e.baseUrl)): ModelInfo => ({
  key: toModelKey(e.id, name),
  name,
  endpoint: { id: e.id, name: e.name, kind: e.kind, flavor: e.flavor },
  where,
  billing: where === 'cloud' ? 'priced' : 'local',
  contextControl: 'server',
  contextWindow: null,
  installed: true,
  capabilities: ['completion'],
  contextLength: null,
  family: null,
  parameterSize: null,
  overrides: {},
  detected: {},
  price: null
})

// The mockup's endpoints: Ollama (cloud and this Mac), LM Studio, a vLLM box on the network, llama.cpp offline.
const ollama = ep('ollama', 'Ollama', 'ollama', 'http://127.0.0.1:11434')
const lm = ep('lm-studio', 'LM Studio', 'openai', 'http://localhost:1234/v1')
const box = ep('gpu-box', 'GPU box', 'openai', 'http://192.168.1.20:8000/v1', { flavor: 'vllm' })
const cpp = ep('llama-cpp', 'llama.cpp', 'openai', 'http://localhost:8080/v1', { flavor: 'llamacpp' })
const off = ep('off', 'Off', 'ollama', 'http://10.0.0.9:11434', { enabled: false })
const endpoints = [ollama, lm, box, cpp, off]
const models = [
  model(ollama, 'gpt-oss:120b-cloud', 'cloud'),
  model(ollama, 'kimi-k3:cloud', 'cloud'),
  model(ollama, 'qwen3:8b'),
  model(lm, 'qwen/qwen3-8b'),
  model(lm, 'google/gemma-3-12b'),
  model(box, 'Qwen/Qwen3-32B')
]
const errors: ModelListResult['errors'] = [{ endpointId: 'llama-cpp', message: "Can't reach llama.cpp at localhost:8080." }]
const view = (opts: Partial<Parameters<typeof groupModels>[2]>) =>
  groupModels(models, errors, { query: '', filter: 'all', currentKey: null, endpoints, ...opts }).map((g) => ({
    id: g.id,
    label: g.label,
    where: g.where,
    items: g.items.map((m) => m.name),
    ...(g.error && { error: g.error })
  }))

describe('the picker’s sections', () => {
  it('put the current model’s endpoint first; Ollama keeps its cloud and local sections', () => {
    expect(view({ currentKey: 'lm-studio/qwen/qwen3-8b' })).toEqual([
      { id: 'lm-studio', label: 'LM Studio', where: 'this-mac', items: ['qwen/qwen3-8b', 'google/gemma-3-12b'] },
      { id: 'ollama:cloud', label: 'Ollama cloud', where: 'cloud', items: ['gpt-oss:120b-cloud', 'kimi-k3:cloud'] },
      { id: 'ollama:local', label: 'Ollama', where: 'this-mac', items: ['qwen3:8b'] },
      { id: 'gpu-box', label: 'GPU box', where: 'network', items: ['Qwen/Qwen3-32B'] }
    ])
  })

  it('leave an offline endpoint to its chip, but show why when it’s chosen or it has the chat’s model (Review Focus #2)', () => {
    expect(view({}).map((g) => g.id)).not.toContain('llama-cpp')
    const why = { id: 'llama-cpp', label: 'llama.cpp', where: 'this-mac', items: [], error: "Can't reach llama.cpp at localhost:8080." }
    expect(view({ filter: 'llama-cpp' })).toEqual([why])
    expect(view({ currentKey: 'llama-cpp/qwen3-8b-q4' })[0]).toEqual(why)
  })

  it('filter by chip and by search, dropping sections left empty', () => {
    expect(view({ filter: 'ollama' }).map((g) => g.id)).toEqual(['ollama:cloud', 'ollama:local'])
    expect(view({ query: 'QWEN3' }).map((g) => [g.id, g.items])).toEqual([
      ['ollama:local', ['qwen3:8b']],
      ['lm-studio', ['qwen/qwen3-8b']],
      ['gpu-box', ['Qwen/Qwen3-32B']]
    ])
  })

  it('call an ollama.com endpoint’s section by its own name', () => {
    const cloud = ep('ollama', 'Ollama cloud', 'ollama', 'https://ollama.com')
    const groups = groupModels([model(cloud, 'gpt-oss:120b', 'cloud')], [], {
      query: '',
      filter: 'all',
      currentKey: null,
      endpoints: [cloud]
    })
    expect(groups.map((g) => g.label)).toEqual(['Ollama cloud'])
  })
})

describe('the endpoint chips', () => {
  it('offer All and each enabled endpoint, an offline one marked with its error', () => {
    expect(endpointChips(endpoints, errors)).toEqual([
      { id: 'all', label: 'All', offline: false },
      { id: 'ollama', label: 'Ollama', offline: false },
      { id: 'lm-studio', label: 'LM Studio', offline: false },
      { id: 'gpu-box', label: 'GPU box', offline: false },
      { id: 'llama-cpp', label: 'llama.cpp', offline: true, error: "Can't reach llama.cpp at localhost:8080." }
    ])
  })
})
