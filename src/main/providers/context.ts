import { DEFAULT_CONTEXT, DEFAULT_NUM_CTX } from '@shared/endpoints'
import type { Endpoint, ModelDetected, ModelInfo, ModelOverrides } from '@shared/types'

/**
 * The window a model's requests get. 'client': Ollmost sets it (Ollama's num_ctx), capped at the endpoint's setting.
 * 'server': the server fixed it when it loaded the model, so the best guess wins: the user's override, then what
 * Ollmost detected, then what the server reported, then the endpoint's default (OpenAI-compatible servers only).
 */
export function contextWindowFor(
  m: { contextControl: ModelInfo['contextControl']; contextLength: number | null; overrides: ModelOverrides; detected: ModelDetected },
  endpoint: Pick<Endpoint, 'kind' | 'numCtx' | 'defaultContext'>
): number | null {
  if (m.contextControl === 'client') {
    const numCtx = endpoint.numCtx ?? DEFAULT_NUM_CTX
    return Math.min(m.contextLength ?? numCtx, numCtx)
  }
  const fallback = endpoint.kind === 'openai' ? (endpoint.defaultContext ?? DEFAULT_CONTEXT) : null
  return m.overrides.contextLength ?? m.detected.contextLength ?? m.contextLength ?? fallback
}
