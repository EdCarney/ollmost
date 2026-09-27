import type { DeepPartial } from './ipc'

/**
 * The settings with a preview laid over them, a section at a time (each top-level key is a section or a value): what
 * the command palette shows while a choice is highlighted, before it's saved. The saved object itself when there's
 * nothing to lay over.
 */
export function withPreview<T extends object>(settings: T, preview: DeepPartial<T> | null): T {
  if (!preview || !Object.keys(preview).length) return settings
  const out = { ...settings } as Record<string, unknown>
  for (const [key, value] of Object.entries(preview)) {
    const base = out[key]
    out[key] =
      value && typeof value === 'object' && !Array.isArray(value) && base && typeof base === 'object' ? { ...base, ...value } : value
  }
  return out as T
}
