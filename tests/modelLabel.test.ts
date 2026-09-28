import { describe, expect, it } from 'vitest'
import { labelForKey, modelLabel, shortModelName } from '../src/shared/modelLabel'
import type { Endpoint } from '../src/shared/types'

const ollama = { id: 'ollama', name: 'Ollama', kind: 'ollama', flavor: 'ollama' } as const
const lmStudio: Endpoint = {
  id: 'lm-studio',
  name: 'LM Studio',
  kind: 'openai',
  flavor: 'lmstudio',
  baseUrl: 'http://localhost:1234/v1',
  enabled: true,
  hasKey: false
}

describe('model labels', () => {
  it('shorten an Ollama name as the picker always has', () => {
    expect(shortModelName('gpt-oss:120b-cloud')).toBe('gpt-oss:120b')
    expect(shortModelName('glm-5.3:cloud')).toBe('glm-5.3')
    expect(shortModelName('llama3.2:latest')).toBe('llama3.2')
    expect(modelLabel({ name: 'gpt-oss:120b-cloud', endpoint: ollama })).toBe('gpt-oss:120b')
  })

  it('name the endpoint when it isn’t Ollama', () => {
    expect(modelLabel({ name: 'qwen/qwen3-8b', endpoint: lmStudio })).toBe('qwen/qwen3-8b · LM Studio')
  })

  it('label a stored key the same way, hf.co names whole', () => {
    expect(labelForKey('ollama/gpt-oss:120b-cloud', [])).toBe('gpt-oss:120b')
    expect(labelForKey('ollama/hf.co/bartowski/Qwen3-8B-GGUF:Q4_K_M', [])).toBe('hf.co/bartowski/Qwen3-8B-GGUF:Q4_K_M')
    expect(labelForKey('lm-studio/qwen/qwen3-8b', [lmStudio])).toBe('qwen/qwen3-8b · LM Studio')
    // An endpoint Ollmost doesn't know (removed, or not loaded yet): the key as it is.
    expect(labelForKey('gone/qwen3', [])).toBe('gone/qwen3')
    expect(labelForKey(null, [])).toBe('Choose a model')
  })
})
