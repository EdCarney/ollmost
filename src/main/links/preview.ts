import { lookup as dnsLookup, type LookupAddress, type LookupOptions } from 'node:dns'
import { type IncomingMessage, request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import type { Readable } from 'node:stream'
import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib'
import type { LinkPreview } from '@shared/ipc'
import { isBlockedHostname, isPrivateAddress, parseHtmlPreview } from '@shared/links'
import { getSettings } from '../settings'
import { testOverride } from '../testOverrides'

const PAGE_BYTES = 512 * 1024
const IMAGE_BYTES = 400 * 1024
const ICON_BYTES = 64 * 1024
const TIMEOUT_MS = 6000
const MAX_REDIRECTS = 5
const CACHE_TTL = 30 * 60 * 1000
const USER_AGENT = 'Mozilla/5.0 (Macintosh) OllmostLinkPreview/1.0'

// Tests serve pages from 127.0.0.1; the shipped app ignores it (#137).
const allowPrivate = !!testOverride('OLLMOST_ALLOW_PRIVATE_PREVIEWS')

type LookupCallback = (err: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void
type Resolver = (
  hostname: string,
  options: LookupOptions & { all: true },
  callback: (err: NodeJS.ErrnoException | null, addresses: LookupAddress[]) => void
) => void

/**
 * A `lookup` for http(s).request that refuses local-network and loopback addresses. It runs when the socket
 * connects, so the address checked is the address used: a DNS answer that changes between a check and the
 * request (DNS rebinding) can't slip through.
 */
export function publicOnlyLookup(resolve: Resolver = dnsLookup as unknown as Resolver) {
  return (hostname: string, options: LookupOptions, callback: LookupCallback): void => {
    resolve(hostname, { ...options, all: true }, (err, addresses) => {
      if (err) return callback(err, [])
      if (!allowPrivate && (!addresses.length || addresses.some((a) => isPrivateAddress(a.address))))
        return callback(Object.assign(new Error('Resolves to a local address'), { code: 'EPRIVATE' }), [])
      if (options.all) callback(null, addresses)
      else callback(null, addresses[0].address, addresses[0].family)
    })
  }
}

const checkedLookup = publicOnlyLookup()

/** Refuse URLs that would make this Mac talk to its own network (routers, local services). */
function assertPublicUrl(url: URL): void {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('Only http(s) links get previews')
  if (allowPrivate) return
  // IP literals never reach the lookup, so check them (and local-only names) here.
  if (isBlockedHostname(url.hostname) || isPrivateAddress(url.hostname.replace(/^\[|\]$/g, ''))) throw new Error('Local address')
}

function open(url: URL, accept: string, signal: AbortSignal): Promise<IncomingMessage> {
  return new Promise((resolve, reject) => {
    const req = (url.protocol === 'https:' ? httpsRequest : httpRequest)(
      url,
      { headers: { 'User-Agent': USER_AGENT, Accept: accept, 'Accept-Encoding': 'gzip, deflate, br' }, lookup: checkedLookup, signal },
      resolve
    )
    req.on('error', reject)
    req.end()
  })
}

function decoded(res: IncomingMessage): Readable {
  switch ((res.headers['content-encoding'] ?? '').toLowerCase()) {
    case 'gzip':
      return res.pipe(createGunzip())
    case 'deflate':
      return res.pipe(createInflate())
    case 'br':
      return res.pipe(createBrotliDecompress())
    default:
      return res
  }
}

/** GET with manual redirects, re-checking every hop, and a byte cap. */
async function capturedGet(start: string, maxBytes: number, stopAtHead = false): Promise<{ url: string; type: string; body: Buffer }> {
  let url = new URL(start)
  const signal = AbortSignal.timeout(TIMEOUT_MS)
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    assertPublicUrl(url)
    const res = await open(url, stopAtHead ? 'text/html' : '*/*', signal)
    const status = res.statusCode ?? 0
    if (status >= 300 && status < 400 && res.headers.location) {
      res.resume()
      url = new URL(res.headers.location, url)
      continue
    }
    if (status < 200 || status >= 300) {
      res.resume()
      throw new Error(`HTTP ${status}`)
    }
    const chunks: Buffer[] = []
    let size = 0
    const body = decoded(res)
    try {
      for await (const chunk of body) {
        const buf = chunk as Buffer
        chunks.push(buf)
        size += buf.length
        if (size > maxBytes) {
          if (!stopAtHead) throw new Error('Too large')
          break
        }
        // Metadata lives in <head>; stop reading once it's over.
        if (stopAtHead && /<\/head>/i.test(buf.toString('latin1'))) break
      }
    } finally {
      res.destroy()
    }
    return { url: url.toString(), type: String(res.headers['content-type'] ?? ''), body: Buffer.concat(chunks) }
  }
  throw new Error('Too many redirects')
}

async function asDataUrl(src: string | null, maxBytes: number): Promise<string | null> {
  if (!src) return null
  try {
    const { type, body } = await capturedGet(src, maxBytes)
    const mime = type.split(';')[0].trim().toLowerCase()
    if (!mime.startsWith('image/') || !body.length) return null
    return `data:${mime};base64,${body.toString('base64')}`
  } catch {
    return null
  }
}

async function load(href: string): Promise<LinkPreview | null> {
  try {
    const page = await capturedGet(href, PAGE_BYTES, true)
    if (!/text\/html|application\/xhtml/i.test(page.type)) return null
    const meta = parseHtmlPreview(page.body.toString('utf8'), page.url)
    const [image, icon] = await Promise.all([asDataUrl(meta.image, IMAGE_BYTES), asDataUrl(meta.icon, ICON_BYTES)])
    if (!meta.title && !meta.description && !image) return null
    return { ...meta, image, icon }
  } catch {
    return null
  }
}

const cache = new Map<string, { at: number; value: Promise<LinkPreview | null> }>()

/**
 * Page preview for a link, fetched from this Mac only when the user has turned previews on.
 * Cached (including failures) and de-duplicated, so hovering the same link again is instant.
 */
export function linkPreview(href: string): Promise<LinkPreview | null> {
  if (!getSettings().links.previews) return Promise.resolve(null)
  const hit = cache.get(href)
  if (hit && Date.now() - hit.at < CACHE_TTL) return hit.value
  const value = load(href)
  cache.set(href, { at: Date.now(), value })
  if (cache.size > 300) cache.delete(cache.keys().next().value!)
  return value
}
