import { appendFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'

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
