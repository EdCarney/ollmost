import type { ModelInfo, ModelListResult } from '@shared/types'
import { errorMessage } from '../util'
import { OllamaProvider } from './ollama/adapter'
import type { Provider } from './types'

// Every model call goes through here. The reply loop, sub-agents, titles, /compact and replay ask for a model's
// provider; none of them reaches for a server itself. For now there is one server: the Ollama app, or ollama.com.
const ollama = new OllamaProvider()

/** The provider a model is served by, and the model's name there. */
export function resolve(model: string): { provider: Provider; model: string } {
  return { provider: ollama, model }
}

export function modelInfo(model: string, refresh = false): Promise<ModelInfo> {
  const r = resolve(model)
  return r.provider.modelInfo(r.model, refresh)
}

/** Every model on offer, or, when none can be listed, why. */
export async function listAllModels(refresh = false): Promise<ModelListResult> {
  try {
    return { models: await ollama.listModels(refresh), error: null }
  } catch (err) {
    return { models: [], error: errorMessage(err) }
  }
}
