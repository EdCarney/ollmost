import type { ModelBilling, ModelWhere } from '@shared/types'

// whereOf is shared (the renderer needs it for an offline endpoint's section); main imports it from here.
export { whereOf } from '@shared/endpoints'

/** Whether Ollmost can price a model's requests. Only Ollama's cloud models have published rates. */
export function billingOf(where: ModelWhere): ModelBilling {
  return where === 'cloud' ? 'priced' : where === 'this-mac' ? 'local' : 'untracked'
}
