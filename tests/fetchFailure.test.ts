import { describe, expect, it } from 'vitest'
import { fetchFailure, fetchFailureMessage, hostOf } from '../src/main/providers/fetchFailure'
import { fetchFailed } from './fetchFailed'

// Every code Node's TLS layer gives for a certificate it won't trust.
const CERTIFICATE_CODES = [
  'CERT_HAS_EXPIRED',
  'CERT_NOT_YET_VALID',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'ERR_TLS_CERT_ALTNAME_INVALID',
  'CERT_UNTRUSTED',
  'CERT_REVOKED'
]

describe('fetchFailure', () => {
  it('reads a refused connection from the cause’s code', () => {
    expect(fetchFailure(fetchFailed('ECONNREFUSED'))).toEqual({ kind: 'refused', code: 'ECONNREFUSED' })
  })

  it('reads the code of an AggregateError cause, or of its first error when it has none of its own', () => {
    expect(fetchFailure(fetchFailed('ECONNREFUSED', 'aggregate'))).toEqual({ kind: 'refused', code: 'ECONNREFUSED' })
    expect(fetchFailure(fetchFailed('ECONNREFUSED', 'aggregate-no-code'))).toEqual({ kind: 'refused', code: 'ECONNREFUSED' })
  })

  it('accepts a code on the error itself', () => {
    expect(fetchFailure(Object.assign(new Error('x'), { code: 'ENOTFOUND' }))).toEqual({ kind: 'not-found', code: 'ENOTFOUND' })
  })

  it('reads a host that can’t be found', () => {
    for (const code of ['ENOTFOUND', 'EAI_AGAIN']) expect(fetchFailure(fetchFailed(code))).toEqual({ kind: 'not-found', code })
  })

  it.each(CERTIFICATE_CODES)('reads %s as a certificate problem', (code) => {
    expect(fetchFailure(fetchFailed(code))).toEqual({ kind: 'certificate', code })
  })

  it('calls anything else other, keeping the code it had', () => {
    expect(fetchFailure(fetchFailed('ECONNRESET'))).toEqual({ kind: 'other', code: 'ECONNRESET' })
    expect(fetchFailure(fetchFailed('ETIMEDOUT', 'aggregate-no-code'))).toEqual({ kind: 'other', code: 'ETIMEDOUT' })
  })

  it('calls a failure with no cause, or no code, other', () => {
    expect(fetchFailure(new TypeError('fetch failed'))).toEqual({ kind: 'other' })
    expect(fetchFailure(new TypeError('fetch failed', { cause: new Error('x') }))).toEqual({ kind: 'other' })
    expect(fetchFailure(new TypeError('fetch failed', { cause: 'ECONNREFUSED' }))).toEqual({ kind: 'other' })
    expect(fetchFailure('boom')).toEqual({ kind: 'other' })
    expect(fetchFailure(undefined)).toEqual({ kind: 'other' })
  })
})

describe('fetchFailureMessage', () => {
  const endpoint = { subject: 'LM Studio', address: 'localhost:1234', host: 'localhost' }
  const probe = { subject: null, address: 'gpu.lan:8000', host: 'gpu.lan' }
  const fallback = 'the site’s own words'

  it('names an endpoint whose host isn’t found, and where to fix the address', () => {
    for (const code of ['ENOTFOUND', 'EAI_AGAIN'])
      expect(fetchFailureMessage(fetchFailed(code), endpoint, fallback)).toBe(
        "LM Studio's host localhost wasn't found. Check the address in Settings → Models → LM Studio."
      )
  })

  it('has no endpoint to name while an address is being probed', () => {
    expect(fetchFailureMessage(fetchFailed('ENOTFOUND'), probe, fallback)).toBe("The host gpu.lan wasn't found. Check the address.")
  })

  it('says which certificate problem it was', () => {
    for (const code of CERTIFICATE_CODES) {
      expect(fetchFailureMessage(fetchFailed(code), endpoint, fallback)).toBe(
        `LM Studio's certificate at localhost:1234 isn't trusted (${code}).`
      )
      expect(fetchFailureMessage(fetchFailed(code), probe, fallback)).toBe(`The certificate at gpu.lan:8000 isn't trusted (${code}).`)
    }
  })

  it('leaves a refused connection, or anything else, to the site’s own words', () => {
    expect(fetchFailureMessage(fetchFailed('ECONNREFUSED'), endpoint, fallback)).toBe(fallback)
    expect(fetchFailureMessage(fetchFailed('ECONNREFUSED', 'aggregate-no-code'), probe, fallback)).toBe(fallback)
    expect(fetchFailureMessage(fetchFailed('ECONNRESET'), endpoint, fallback)).toBe(fallback)
    expect(fetchFailureMessage(new TypeError('fetch failed'), probe, fallback)).toBe(fallback)
  })
})

describe('hostOf', () => {
  it('is the URL’s hostname, or the text when it isn’t a URL', () => {
    expect(hostOf('http://localhost:1234/v1')).toBe('localhost')
    expect(hostOf('https://gpu.lan:8443')).toBe('gpu.lan')
    expect(hostOf('not a url')).toBe('not a url')
  })
})
