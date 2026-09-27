// Number formatting shared by the renderer and the tests (the renderer's lib isn't in the node project's file list).

/** A model's context window: 128K, 1M, 1.5M. */
export function formatContext(tokens: number | null): string {
  if (!tokens) return ''
  return tokens >= 1_000_000 ? `${(tokens / 1_000_000).toFixed(tokens % 1_000_000 ? 1 : 0)}M` : `${Math.round(tokens / 1000)}K`
}

/** A token count with a unit: 999, 8.8K, 123K, 8.79M, 10.0M, 100M (two decimals below 10M, one below 100M). */
export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 100_000_000 ? 0 : n >= 10_000_000 ? 1 : 2)}M`
  return n >= 1000 ? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}K` : String(n)
}
