import { isRecord } from './json'

export type FetchFailure = { kind: 'certificate'; code: string } | { kind: 'refused' | 'not-found' | 'other'; code?: string }

// Node's TLS codes for a certificate it won't trust: expired, self-signed, no known issuer, the wrong name, revoked.
const CERTIFICATE = /CERT|SELF_SIGNED|UNABLE_TO_(VERIFY|GET_ISSUER)/

const codeOf = (e: unknown): string | undefined => (isRecord(e) && typeof e.code === 'string' ? e.code : undefined)

/**
 * The system's code for a failed fetch. Node's fetch throws TypeError('fetch failed') with the real error as its cause;
 * with `localhost`, both address families are tried and the cause can be an AggregateError, whose own code may be missing.
 */
function codeOfFailure(err: unknown): string | undefined {
  const cause = isRecord(err) ? err.cause : undefined
  const first = isRecord(cause) && Array.isArray(cause.errors) ? cause.errors[0] : undefined
  return codeOf(cause) ?? codeOf(first) ?? codeOf(err)
}

/** What a failed fetch's cause says went wrong, and the code it said it with. */
export function fetchFailure(err: unknown): FetchFailure {
  const code = codeOfFailure(err)
  if (code === undefined) return { kind: 'other' }
  if (code === 'ECONNREFUSED') return { kind: 'refused', code }
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return { kind: 'not-found', code }
  if (CERTIFICATE.test(code)) return { kind: 'certificate', code }
  return { kind: 'other', code }
}

/** The host of an address, or the text itself when it isn't one. */
export function hostOf(url: string): string {
  try {
    return new URL(url).hostname
  } catch {
    return url
  }
}

/**
 * A failed fetch in words: what its cause says when that points at the fix (a host that isn't there, a certificate
 * that isn't trusted), else `fallback`, the site's own words. `subject` is the endpoint's name; null while an address is
 * only being probed.
 */
export function fetchFailureMessage(
  err: unknown,
  where: { subject: string | null; address: string; host: string },
  fallback: string
): string {
  const { subject, address, host } = where
  const failure = fetchFailure(err)
  if (failure.kind === 'not-found')
    return subject
      ? `${subject}'s host ${host} wasn't found. Check the address in Settings → Models → ${subject}.`
      : `The host ${host} wasn't found. Check the address.`
  if (failure.kind === 'certificate')
    return subject
      ? `${subject}'s certificate at ${address} isn't trusted (${failure.code}).`
      : `The certificate at ${address} isn't trusted (${failure.code}).`
  return fallback
}
