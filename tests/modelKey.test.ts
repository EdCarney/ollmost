import { describe, expect, it } from 'vitest'
import { ENDPOINT_ID, keyPrefix, MIGRATED_ENDPOINT_ID, slugEndpointId, splitModelKey, toModelKey } from '../src/shared/modelKey'

const HF = 'hf.co/bartowski/Qwen3-8B-GGUF:Q4_K_M'

describe('model keys', () => {
  it('put the endpoint id in front of the name the server knows', () => {
    expect(toModelKey('lm-studio', 'qwen/qwen3-8b')).toBe('lm-studio/qwen/qwen3-8b')
    expect(MIGRATED_ENDPOINT_ID).toBe('ollama')
  })

  it('split on the first slash when the prefix is a known endpoint', () => {
    expect(splitModelKey('lm-studio/qwen/qwen3-8b', ['ollama', 'lm-studio'])).toEqual({ endpointId: 'lm-studio', model: 'qwen/qwen3-8b' })
    expect(splitModelKey('ollama/gpt-oss:120b-cloud', ['ollama'])).toEqual({ endpointId: 'ollama', model: 'gpt-oss:120b-cloud' })
  })

  it('keep an Ollama name with slashes whole (Review Focus #1)', () => {
    const key = toModelKey(MIGRATED_ENDPOINT_ID, HF)
    expect(key).toBe(`ollama/${HF}`)
    expect(splitModelKey(key, ['ollama', 'lm-studio'])).toEqual({ endpointId: 'ollama', model: HF })
  })

  it('read a bare name from before keys as Ollama’s, whole', () => {
    expect(splitModelKey('llama3.2', ['ollama'])).toEqual({ endpointId: 'ollama', model: 'llama3.2' })
    expect(splitModelKey(HF, ['ollama'])).toEqual({ endpointId: 'ollama', model: HF })
    // A prefix that names no endpoint isn't split: that's for the registry to judge (see keyPrefix).
    expect(splitModelKey('gone/qwen3', ['ollama'])).toEqual({ endpointId: 'ollama', model: 'gone/qwen3' })
  })

  it('tell a prefix shaped like an endpoint id from a bare name', () => {
    expect(keyPrefix('lm-studio/qwen/qwen3-8b')).toBe('lm-studio')
    expect(keyPrefix(`ollama/${HF}`)).toBe('ollama')
    expect(keyPrefix(HF)).toBeNull()
    expect(keyPrefix('llama3.2')).toBeNull()
    expect(keyPrefix('/x')).toBeNull()
  })
})

describe('endpoint ids', () => {
  it('are made from the name', () => {
    expect(slugEndpointId('LM Studio', [])).toBe('lm-studio')
    expect(slugEndpointId('llama.cpp', [])).toBe('llama-cpp')
    expect(slugEndpointId('  GPU box #2 ', [])).toBe('gpu-box-2')
    expect(slugEndpointId('???', [])).toBe('endpoint')
    expect(ENDPOINT_ID.test(slugEndpointId('Ünïcode Ñame', []))).toBe(true)
  })

  it('take the next free number on a clash, and never "all" (the picker’s filter)', () => {
    expect(slugEndpointId('Ollama', ['ollama'])).toBe('ollama-2')
    expect(slugEndpointId('Ollama', ['ollama', 'ollama-2'])).toBe('ollama-3')
    expect(slugEndpointId('All', [])).toBe('all-2')
  })
})
