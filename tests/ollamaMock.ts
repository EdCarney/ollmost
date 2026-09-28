import { appendFileSync, existsSync, readFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { resolve } from 'node:path'

export type Handler = (req: IncomingMessage & { json: Record<string, unknown> }, res: ServerResponse) => unknown

/** A stand-in Ollama daemon for tests: each test sets `handler` to script how /api/chat responds. */
export interface MockOllama {
  url: string
  handler: Handler
  requests: Array<Record<string, unknown>>
  close: () => Promise<void>
}

export async function startMockOllama(): Promise<MockOllama> {
  const mock: MockOllama = {
    url: '',
    handler: (_req, res) => void res.writeHead(500).end('no handler'),
    requests: [],
    close: async () => undefined
  }
  const server: Server = createServer(async (req, res) => {
    let raw = ''
    for await (const part of req) raw += part
    // OLLMOST_MOCK_DUMP=<file> appends every request as received, so a refactor can show it still sends the same bytes.
    if (process.env.OLLMOST_MOCK_DUMP) appendFileSync(process.env.OLLMOST_MOCK_DUMP, `${req.method} ${req.url} ${raw}\n`)
    const json = raw ? (JSON.parse(raw) as Record<string, unknown>) : {}
    mock.requests.push(json)
    await mock.handler(Object.assign(req, { json }), res)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  mock.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  mock.close = () =>
    new Promise((resolve) => {
      server.closeAllConnections()
      server.close(() => resolve())
    })
  return mock
}

export const line = (chunk: Record<string, unknown>): string => `${JSON.stringify(chunk)}\n`

/** Write NDJSON chunks, optionally pausing between them. */
export async function streamChunks(res: ServerResponse, chunks: string[], delayMs = 0): Promise<void> {
  res.writeHead(200, { 'content-type': 'application/x-ndjson' })
  for (const c of chunks) {
    res.write(c)
    if (delayMs) await new Promise((r) => setTimeout(r, delayMs))
  }
}

// ---- OpenAI-compatible servers: server-sent events (PR 3) ----

/** One server-sent event carrying `obj` as its data. */
export const sse = (obj: unknown): string => `data: ${JSON.stringify(obj)}\n\n`

/** OpenAI's end-of-stream marker. */
export const sseDone = 'data: [DONE]\n\n'

/** A chat.completion.chunk event with one choice, as OpenAI-compatible servers stream them. */
export const sseDelta = (delta: Record<string, unknown>, finishReason: string | null = null, extra: Record<string, unknown> = {}): string =>
  sse({
    id: 'chatcmpl-mock',
    object: 'chat.completion.chunk',
    created: 0,
    model: 'mock',
    choices: [{ index: 0, delta, finish_reason: finishReason }],
    ...extra
  })

/** Write SSE text, or raw bytes (to split a character mid-sequence), optionally pausing between pieces. */
export async function streamSse(res: ServerResponse, chunks: Array<string | Uint8Array>, pauseMs = 0): Promise<void> {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
  for (const c of chunks) {
    res.write(c)
    if (pauseMs) await new Promise((r) => setTimeout(r, pauseMs))
  }
}

// Vitest runs from the repo root (vitest.config.ts resolves '@shared' the same way).
export const FIXTURES = resolve('tests/fixtures')

/** A fixture's text, without the `#` marker lines that fixtures written from docs start with. */
export function fixtureText(path: string): string {
  return readFileSync(resolve(FIXTURES, path), 'utf8').replace(/^(#[^\n]*\n)+/, '')
}

export const fixtureJson = <T = unknown>(path: string): T => JSON.parse(fixtureText(path)) as T

/** `text` as UTF-8 bytes in pieces of `size`, so framing, and multi-byte characters, split anywhere. */
export function byteChunks(text: string, size: number): Uint8Array[] {
  const bytes = Buffer.from(text)
  const out: Uint8Array[] = []
  for (let i = 0; i < bytes.length; i += size) out.push(bytes.subarray(i, i + size))
  return out
}

/** A captured stream in the network pieces it arrived in (its .meta.json records their sizes). */
export function capturedChunks(path: string): Uint8Array[] {
  const bytes = Buffer.from(fixtureText(path))
  const metaPath = resolve(FIXTURES, path.replace(/\.[a-z]+$/, '.meta.json'))
  if (!existsSync(metaPath)) return [bytes]
  const { chunks } = JSON.parse(readFileSync(metaPath, 'utf8')) as { chunks: Array<{ bytes: number }> }
  const out: Uint8Array[] = []
  let at = 0
  for (const { bytes: n } of chunks) {
    out.push(bytes.subarray(at, at + n))
    at += n
  }
  return at < bytes.length ? [...out, bytes.subarray(at)] : out
}
