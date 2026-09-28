import type { ThinkProfile, ThinkSetting } from './types'

/**
 * Ollama's `think` parameter means different things to different model families.
 * These rules come from probing the cloud models directly (2026-09):
 *  - gpt-oss ignores `false` and always reasons, but honours "low" | "medium" | "high".
 *  - glm-5.x with `false` still reasons, and the reasoning leaks into the visible reply,
 *    so we never send `false` to it (omitting `think` keeps reasoning in its own field).
 *  - kimi, qwen, deepseek toggle cleanly with true/false.
 */
const FAMILY_RULES: Array<{ match: RegExp; profile: ThinkProfile }> = [
  { match: /^gpt-oss/, profile: { kind: 'levels', canDisable: false } },
  {
    match: /^glm-/,
    profile: { kind: 'always', note: 'Turning thinking off makes this model leak its reasoning into replies.' }
  }
]

export function resolveThinkProfile(
  model: string,
  capabilities: string[],
  override?: ThinkProfile['kind'],
  preset?: ThinkProfile['kind']
): ThinkProfile {
  if (!capabilities.includes('thinking')) return { kind: 'none' }
  // The user's choice, else what the server said it offers (LM Studio), else Ollama's family rules.
  const kind = override ?? preset
  if (kind === 'none' || kind === 'toggle') return { kind }
  if (kind === 'always') return { kind: 'always' }
  if (kind === 'levels') return { kind: 'levels', canDisable: true }
  const rule = FAMILY_RULES.find((r) => r.match.test(model))
  return rule ? rule.profile : { kind: 'toggle' }
}

export function defaultThinkSetting(profile: ThinkProfile): ThinkSetting | null {
  switch (profile.kind) {
    case 'levels':
      return 'medium'
    case 'toggle':
      return 'off'
    default:
      return null
  }
}

/** Coerce a (possibly stale) setting into one the profile supports. */
export function normalizeThinkSetting(profile: ThinkProfile, setting: ThinkSetting | null): ThinkSetting | null {
  if (setting == null) return defaultThinkSetting(profile)
  switch (profile.kind) {
    case 'none':
    case 'always':
      return null
    case 'toggle':
      return setting === 'off' ? 'off' : 'on'
    case 'levels':
      if (setting === 'on') return 'medium'
      if (setting === 'off') return profile.canDisable ? 'off' : 'low'
      return setting
  }
}

/** The value to send as `think` in /api/chat, or undefined to omit the field. */
export function toOllamaThink(profile: ThinkProfile, setting: ThinkSetting | null): boolean | 'low' | 'medium' | 'high' | undefined {
  const s = normalizeThinkSetting(profile, setting)
  switch (profile.kind) {
    case 'none':
    case 'always':
      return undefined
    case 'toggle':
      return s === 'on'
    case 'levels':
      return s === 'off' ? false : (s as 'low' | 'medium' | 'high')
  }
}

export function thinkLabel(setting: ThinkSetting | null): string {
  switch (setting) {
    case 'on':
      return 'Thinking'
    case 'low':
      return 'Low effort'
    case 'medium':
      return 'Medium effort'
    case 'high':
      return 'High effort'
    default:
      return 'No thinking'
  }
}
