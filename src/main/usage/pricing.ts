import { costOf, parsePricingHtml, priceFor } from '@shared/usage'
import type { ModelPrice, PriceTable } from '@shared/types'
import { readSetting, writeSetting } from '../db/kv'
import { connectionMode, isCloudName } from '../providers/ollama/wire'

// Snapshot of ollama.com/pricing (USD per million tokens), used until the first live refresh.
const BUNDLED: PriceTable = {
  source: 'bundled',
  updatedAt: Date.parse('2026-09-23T00:00:00Z'),
  prices: {
    'deepseek-v4.1-flash': { input: 0.3, cachedInput: 0.006, output: 1.2 },
    'deepseek-v4-flash': { input: 0.44, cachedInput: 0.014, output: 1.32 },
    'deepseek-v4-pro': { input: 1.32, cachedInput: 0.044, output: 3.96 },
    gemma4: { input: 0.14, cachedInput: 0.05, output: 0.4 },
    'glm-5.3': { input: 1.4, cachedInput: 0.26, output: 4.4 },
    'glm-5.3-flash': { input: 0.15, cachedInput: 0.03, output: 0.5 },
    'glm-5.2': { input: 1.4, cachedInput: 0.26, output: 4.4 },
    'glm-5.1': { input: 1.0, cachedInput: 0.2, output: 3.2 },
    'gpt-oss:120b': { input: 0.15, cachedInput: 0.014, output: 0.6 },
    'gpt-oss:20b': { input: 0.07, cachedInput: 0.035, output: 0.3 },
    'kimi-k3': { input: 3.0, cachedInput: 0.3, output: 15.0 },
    'kimi-k2.7-code': { input: 0.95, cachedInput: 0.19, output: 4.0 },
    'kimi-k2.6': { input: 0.95, cachedInput: 0.16, output: 4.0 },
    'minimax-m3': { input: 0.6, cachedInput: 0.12, output: 2.4 },
    'minimax-m2.7': { input: 0.3, cachedInput: 0.06, output: 1.2 },
    'mistral-large-3': { input: 0.5, cachedInput: null, output: 1.5 },
    'nemotron-3-nano': { input: 0.06, cachedInput: null, output: 0.24 },
    'nemotron-3-super': { input: 0.015, cachedInput: 0.015, output: 0.6 },
    'nemotron-3-ultra': { input: 0.1, cachedInput: 0.1, output: 3.0 },
    'qwen3.5:397b': { input: 0.6, cachedInput: null, output: 3.6 }
  }
}

const REFRESH_EVERY = 24 * 60 * 60 * 1000
let refreshing: Promise<PriceTable> | null = null

export function getPriceTable(): PriceTable {
  return readSetting<PriceTable | null>('prices', null) ?? BUNDLED
}

/** Re-read ollama.com/pricing at most daily; keep the previous table if the page changes shape. */
export function refreshPrices(force = false): Promise<PriceTable> {
  const current = getPriceTable()
  if (!force && current.source === 'ollama.com' && Date.now() - current.updatedAt < REFRESH_EVERY) return Promise.resolve(current)
  refreshing ??= (async () => {
    try {
      const res = await fetch('https://ollama.com/pricing', { signal: AbortSignal.timeout(15_000) })
      if (!res.ok) return current
      const prices = parsePricingHtml(await res.text())
      if (Object.keys(prices).length < 5) return current
      const table: PriceTable = { prices, updatedAt: Date.now(), source: 'ollama.com' }
      writeSetting('prices', table)
      return table
    } catch {
      return current
    } finally {
      refreshing = null
    }
  })()
  return refreshing
}

/** Local models cost nothing; cloud models use the published price (null if unknown). */
export function modelPrice(model: string): ModelPrice | null {
  return priceFor(getPriceTable(), model)
}

export function isBilled(model: string): boolean {
  return connectionMode() === 'direct' || isCloudName(model)
}

export function requestCost(model: string, promptTokens: number, completionTokens: number): number | null {
  if (!isBilled(model)) return 0
  return costOf(modelPrice(model), promptTokens, completionTokens)
}
