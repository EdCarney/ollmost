// Number formatting shared by the renderer and the tests (the renderer's lib isn't in the node project's file list).

/** A model's context window: 128K, 1M, 1.5M. */
export function formatContext(tokens: number | null): string {
  if (!tokens) return ''
  return tokens >= 1_000_000 ? `${(tokens / 1_000_000).toFixed(tokens % 1_000_000 ? 1 : 0)}M` : `${Math.round(tokens / 1000)}K`
}

/** A context size in binary units when it divides evenly (65536 is "64K", 1048576 "1M", not "66K", "1.0M"), else formatContext's. */
export function contextSizeLabel(n: number | null): string {
  if (!n) return ''
  if (n % 1_048_576 === 0) return `${n / 1_048_576}M`
  return n % 1024 === 0 ? `${n / 1024}K` : formatContext(n)
}

/** A token count with a unit: 999, 8.8K, 123K, 8.79M, 10.0M, 100M (two decimals below 10M, one below 100M). */
export function formatTokens(n: number): string {
  if (n >= 1_000_000) {
    const m = n / 1_000_000
    let decimals = m >= 100 ? 0 : m >= 10 ? 1 : 2
    // Rounding can carry into the next tier (9,999,999 would read "10.00M"); then that tier's decimals apply.
    if (decimals > 0 && Number(m.toFixed(decimals)) >= (decimals === 2 ? 10 : 100)) decimals--
    return `${m.toFixed(decimals)}M`
  }
  return n >= 1000 ? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}K` : String(n)
}
