export { contextSizeLabel, formatContext, formatTokens } from '@shared/format'

/** Ollama reports cloud models' sizes as raw parameter counts ("304180418494"); local ones as "20.9B". */
export function formatParams(size: string | null): string | null {
  if (!size) return null
  if (!/^\d+$/.test(size)) return size
  const n = Number(size)
  if (n >= 1e12) return `${(n / 1e12).toFixed(1).replace(/\.0$/, '')}T`
  if (n >= 1e9) return `${Math.round(n / 1e9)}B`
  return `${Math.round(n / 1e6)}M`
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' })

export function relativeTime(ts: number): string {
  const diff = (ts - Date.now()) / 1000
  const abs = Math.abs(diff)
  if (abs < 60) return 'just now'
  if (abs < 3600) return rtf.format(Math.round(diff / 60), 'minute')
  if (abs < 86400) return rtf.format(Math.round(diff / 3600), 'hour')
  if (abs < 86400 * 7) return rtf.format(Math.round(diff / 86400), 'day')
  return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: abs > 86400 * 300 ? 'numeric' : undefined })
}

export function formatDuration(ms: number): string {
  const s = Math.max(1, Math.round(ms / 1000))
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`
}

export function greeting(name: string): string {
  const h = new Date().getHours()
  const part = h < 5 ? 'Up late' : h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening'
  return name ? `${part}, ${name}` : part
}

export function cn(...classes: Array<string | false | null | undefined>): string {
  return classes.filter(Boolean).join(' ')
}
