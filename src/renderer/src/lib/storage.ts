// Browser storage for per-viewer conveniences (expanded projects, closed folders, a chat's closed thinking). Reads and writes
// never throw: storage may be unavailable, and every caller works without it.

export function readJson(key: string): unknown {
  try {
    const raw = localStorage.getItem(key)
    return raw ? JSON.parse(raw) : null
  } catch {
    return null
  }
}

export function writeJson(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {
    // Storage may be unavailable; the state is a convenience.
  }
}

/** A stored list of strings, or [] for anything else. */
export const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string') : [])
