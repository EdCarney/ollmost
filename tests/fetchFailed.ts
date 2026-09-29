/**
 * What Node's fetch throws when a connection fails: a TypeError('fetch failed') whose cause carries the system's code.
 * With `localhost`, happy eyeballs can make the cause an AggregateError, whose own code may be missing.
 */
export function fetchFailed(code: string, shape: 'plain' | 'aggregate' | 'aggregate-no-code' = 'plain'): TypeError {
  const inner = Object.assign(new Error(`connect ${code}`), { code })
  if (shape === 'plain') return new TypeError('fetch failed', { cause: inner })
  const aggregate = new AggregateError([inner], `connect ${code}`)
  return new TypeError('fetch failed', { cause: shape === 'aggregate' ? Object.assign(aggregate, { code }) : aggregate })
}
