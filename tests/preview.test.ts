import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { gzipSync } from 'node:zlib'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

vi.mock('../src/main/settings', () => ({ getSettings: () => ({ links: { previews: true } }) }))
// The preview module reads its test override through Electron's app (#137); the real electron package would fetch the binary.
vi.mock('electron', () => ({ app: { isPackaged: false } }))

const PNG = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082',
  'hex'
)

// A copy of the module loaded without the test override, so the lookup applies its real checks.
delete process.env.OLLMOST_ALLOW_PRIVATE_PREVIEWS
const { publicOnlyLookup } = await import('../src/main/links/preview')
process.env.OLLMOST_ALLOW_PRIVATE_PREVIEWS = '1'

describe('publicOnlyLookup (checked when the socket connects)', () => {
  // Stands in for DNS, including a rebinding answer that points a public name at the local network.
  const answers: Record<string, Array<{ address: string; family: number }>> = {
    'example.com': [{ address: '93.184.215.14', family: 4 }],
    'rebind.example': [{ address: '192.168.1.1', family: 4 }],
    'mixed.example': [
      { address: '93.184.215.14', family: 4 },
      { address: '127.0.0.1', family: 4 }
    ]
  }
  const lookup = publicOnlyLookup((host, _opts, cb) => cb(null, answers[host] ?? []))
  const run = (host: string, all: boolean) =>
    new Promise<{ err: Error | null; address: unknown; family?: number }>((resolve) =>
      lookup(host, { all }, (err, address, family) => resolve({ err, address, family }))
    )

  it('passes public addresses through, in both callback shapes', async () => {
    expect(await run('example.com', false)).toEqual({ err: null, address: '93.184.215.14', family: 4 })
    expect((await run('example.com', true)).address).toEqual(answers['example.com'])
  })

  it('refuses a name that resolves to the local network at connect time', async () => {
    expect((await run('rebind.example', false)).err?.message).toMatch(/local address/)
  })

  it('refuses when any resolved address is local', async () => {
    expect((await run('mixed.example', true)).err?.message).toMatch(/local address/)
  })

  it('refuses a name with no addresses', async () => {
    expect((await run('nothing.example', false)).err).toBeTruthy()
  })
})

describe('linkPreview', () => {
  let base = ''
  const server = createServer((req, res) => {
    if (req.url === '/start') return res.writeHead(302, { location: '/page' }).end()
    if (req.url === '/page') {
      const html = `<html><head><title>Fallback</title><meta property="og:title" content="Ollmost release notes"><meta property="og:description" content="What changed"><meta property="og:image" content="${base}/img.png"></head><body>…</body></html>`
      return res.writeHead(200, { 'content-type': 'text/html', 'content-encoding': 'gzip' }).end(gzipSync(html))
    }
    if (req.url === '/img.png') return res.writeHead(200, { 'content-type': 'image/png' }).end(PNG)
    res.writeHead(404).end()
  })
  beforeAll(async () => {
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  })
  afterAll(() => server.close())

  it('follows redirects, decompresses the page and inlines the image', async () => {
    // The test pages are on 127.0.0.1, so load a copy with the private-address override on.
    vi.resetModules()
    const { linkPreview } = await import('../src/main/links/preview')
    const preview = await linkPreview(`${base}/start`)
    expect(preview).toMatchObject({ title: 'Ollmost release notes', description: 'What changed' })
    expect(preview?.image).toMatch(/^data:image\/png;base64,/)
  })
})
