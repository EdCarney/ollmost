import type { DeepPartial } from './ipc'

const isPlain = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

/**
 * The settings with a preview laid over them, as deep as the preview goes (arrays and values replace, objects merge
 * key by key): what the command palette shows while a choice is highlighted, before it's saved. The saved object
 * itself when there's nothing to lay over.
 */
export function withPreview<T extends object>(settings: T, preview: DeepPartial<T> | null): T {
  if (!preview || !Object.keys(preview).length) return settings
  return merge(settings as Record<string, unknown>, preview as Record<string, unknown>) as T
}

function merge(base: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> {
  const out = { ...base }
  for (const [key, value] of Object.entries(patch)) {
    const below = out[key]
    out[key] = isPlain(value) && isPlain(below) ? merge(below, value) : value
  }
  return out
}
