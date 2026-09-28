import type { ModelDetected, ModelOverrides } from '@shared/types'

/**
 * A model's tools and vision once everything Ollmost knows is applied: the user's override, else what an error taught
 * (a server that refused tools), else what the server reported, which for a server that says nothing already holds
 * the defaults (tools on, vision off). Every other capability passes through, in order.
 */
export function effectiveCapabilities(reported: string[], overrides: ModelOverrides, detected: ModelDetected): string[] {
  const on = {
    tools: overrides.tools ?? detected.tools ?? reported.includes('tools'),
    vision: overrides.vision ?? reported.includes('vision')
  }
  const kept = reported.filter((c) => (c === 'tools' || c === 'vision' ? on[c] : true))
  const added = (['tools', 'vision'] as const).filter((c) => on[c] && !reported.includes(c))
  return [...kept, ...added]
}
