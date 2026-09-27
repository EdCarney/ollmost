import { describe, expect, it } from 'vitest'
import { formatTokens } from '../src/shared/format'

describe('formatTokens', () => {
  it('shows a count under a thousand as is', () => {
    expect(formatTokens(0)).toBe('0')
    expect(formatTokens(999)).toBe('999')
  })

  it('shows thousands with one decimal below 10K and none above', () => {
    expect(formatTokens(1000)).toBe('1.0K')
    expect(formatTokens(8787)).toBe('8.8K')
    expect(formatTokens(10_000)).toBe('10K')
    expect(formatTokens(123_456)).toBe('123K')
  })

  it('switches to millions at a million: two decimals below 10M, one below 100M, none above', () => {
    expect(formatTokens(1_000_000)).toBe('1.00M')
    expect(formatTokens(8_787_000)).toBe('8.79M')
    expect(formatTokens(8_784_000)).toBe('8.78M')
    expect(formatTokens(10_000_000)).toBe('10.0M')
    expect(formatTokens(99_940_000)).toBe('99.9M')
    expect(formatTokens(100_000_000)).toBe('100M')
    expect(formatTokens(1_234_567_890)).toBe('1235M')
  })

  it('drops a decimal when rounding carries a count into the next tier', () => {
    expect(formatTokens(9_999_999)).toBe('10.0M')
    expect(formatTokens(9_999_500)).toBe('10.0M')
    expect(formatTokens(99_999_999)).toBe('100M')
    expect(formatTokens(99_950_000)).toBe('100M')
  })
})
