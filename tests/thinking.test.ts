import { describe, expect, it } from 'vitest'
import { normalizeThinkSetting, resolveThinkProfile, toOllamaThink } from '@shared/thinking'

const T = ['completion', 'thinking', 'tools']

describe('think profiles', () => {
  it('hides the control for models without the thinking capability', () => {
    expect(resolveThinkProfile('llama3', ['completion'])).toEqual({ kind: 'none' })
    expect(toOllamaThink({ kind: 'none' }, 'on')).toBeUndefined()
  })

  it('uses levels for gpt-oss and never sends false', () => {
    const p = resolveThinkProfile('gpt-oss:120b-cloud', T)
    expect(p).toEqual({ kind: 'levels', canDisable: false })
    expect(toOllamaThink(p, 'high')).toBe('high')
    expect(toOllamaThink(p, 'off')).toBe('low')
    expect(toOllamaThink(p, 'on')).toBe('medium')
  })

  it('omits think for glm so reasoning does not leak into replies', () => {
    const p = resolveThinkProfile('glm-5.3:cloud', T)
    expect(p.kind).toBe('always')
    expect(toOllamaThink(p, 'off')).toBeUndefined()
  })

  it('toggles other families with booleans', () => {
    const p = resolveThinkProfile('kimi-k3:cloud', T)
    expect(p).toEqual({ kind: 'toggle' })
    expect(toOllamaThink(p, 'off')).toBe(false)
    expect(toOllamaThink(p, 'high')).toBe(true)
    expect(normalizeThinkSetting(p, 'low')).toBe('on')
  })

  it('respects user overrides', () => {
    expect(resolveThinkProfile('glm-5.3:cloud', T, 'toggle')).toEqual({ kind: 'toggle' })
    expect(resolveThinkProfile('qwen3.5:397b-cloud', T, 'levels')).toEqual({ kind: 'levels', canDisable: true })
  })

  it('uses a server’s preset when the user set none, and the user’s choice over it', () => {
    expect(resolveThinkProfile('qwen/qwen3-8b', T, undefined, 'toggle')).toEqual({ kind: 'toggle' })
    expect(resolveThinkProfile('openai/gpt-oss-20b', T, undefined, 'levels')).toEqual({ kind: 'levels', canDisable: true })
    expect(resolveThinkProfile('glm-4.6', T, undefined, 'always')).toEqual({ kind: 'always' })
    expect(resolveThinkProfile('qwen/qwen3-8b', T, 'none', 'toggle')).toEqual({ kind: 'none' })
    expect(resolveThinkProfile('qwen/qwen3-8b', ['completion'], undefined, 'toggle')).toEqual({ kind: 'none' })
    // No preset: Ollama's family rules, as before.
    expect(resolveThinkProfile('gpt-oss:20b', T, undefined, undefined)).toEqual({ kind: 'levels', canDisable: false })
  })
})
