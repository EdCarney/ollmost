type ContextModel = { location: 'cloud' | 'local'; contextLength: number | null }

const localWindow = (contextLength: number | null, localNumCtx: number): number => Math.min(contextLength ?? localNumCtx, localNumCtx)

/**
 * The context window a request actually gets. Cloud models run at their full length; local ones run at
 * Ollama's num_ctx, which Ollmost caps at the user's setting. History trimming, meters and num_ctx must all
 * use this one number, or Ollmost budgets for a window Ollama never opens.
 */
export function effectiveContext(model: ContextModel, localNumCtx: number): number | null {
  return model.location === 'cloud' ? model.contextLength : localWindow(model.contextLength, localNumCtx)
}
