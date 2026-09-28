import { describe, expect, it } from 'vitest'
import { modelAvailability, unavailableText } from '../src/shared/availability'
import { toModelKey } from '../src/shared/modelKey'
import type { Endpoint, ModelInfo, ModelListResult } from '../src/shared/types'

const ep = (id: string, name: string, over: Partial<Endpoint> = {}): Endpoint => ({
  id,
  name,
  kind: 'ollama',
  flavor: 'ollama',
  baseUrl: 'http://127.0.0.1:11434',
  enabled: true,
  hasKey: false,
  ...over
})
const listed = (e: Endpoint, name: string) =>
  ({ key: toModelKey(e.id, name), name, endpoint: { id: e.id, name: e.name, kind: e.kind, flavor: e.flavor } }) as ModelInfo

const ollama = ep('ollama', 'Ollama')
const lm = ep('lm-studio', 'LM Studio', { kind: 'openai', flavor: 'lmstudio', baseUrl: 'http://localhost:1234/v1' })
const off = ep('gpu-box', 'GPU box', { enabled: false, baseUrl: 'http://192.168.1.20:11434' })
const endpoints = [ollama, lm, off]
const models = [listed(ollama, 'llama3.2'), listed(ollama, 'hf.co/bartowski/Qwen3-8B-GGUF:Q4_K_M')]
const errors: ModelListResult['errors'] = [{ endpointId: 'lm-studio', message: "Can't reach LM Studio at localhost:1234." }]
const check = (key: string | null) => modelAvailability(key, models, endpoints, errors)

describe('whether a chat’s model can be used', () => {
  it('is ok for a listed model, hf.co names and bare names from before keys included', () => {
    expect(check('ollama/llama3.2')).toBe('ok')
    expect(check('ollama/hf.co/bartowski/Qwen3-8B-GGUF:Q4_K_M')).toBe('ok')
    expect(check('llama3.2')).toBe('ok')
  })

  it('says why not: removed, turned off, offline, or no longer listed (Review Focus #2)', () => {
    expect(check('vllm/Qwen/Qwen3-32B')).toBe('endpoint-removed')
    expect(check('gpu-box/qwen3:8b')).toBe('endpoint-disabled')
    expect(check('lm-studio/qwen/qwen3-8b')).toBe('endpoint-offline')
    expect(check('ollama/mistral:7b')).toBe('model-missing')
    expect(check(null)).toBe('none')
  })

  it('words each reason for the composer, naming the model and its endpoint', () => {
    expect(unavailableText('endpoint-offline', 'lm-studio/qwen/qwen3-8b', endpoints)).toBe(
      "qwen/qwen3-8b · LM Studio is unavailable: Ollmost can't reach LM Studio."
    )
    expect(unavailableText('endpoint-disabled', 'gpu-box/qwen3:8b', endpoints)).toBe(
      'qwen3:8b is unavailable: GPU box is turned off in Settings → Models. Turn it on, or pick another model.'
    )
    expect(unavailableText('endpoint-removed', 'vllm/Qwen/Qwen3-32B', endpoints)).toBe(
      'vllm/Qwen/Qwen3-32B is unavailable: its endpoint was removed. Pick another model to keep chatting.'
    )
    expect(unavailableText('model-missing', 'ollama/mistral:7b', endpoints)).toBe(
      'mistral:7b is unavailable: Ollama doesn’t list it any more. Pick another model.'
    )
  })
})
