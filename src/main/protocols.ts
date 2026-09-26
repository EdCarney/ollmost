import { pathToFileURL } from 'node:url'
import { net, protocol } from 'electron'
import type { ArtifactType } from '@shared/types'
import { IMAGE_FILE } from '@shared/workspace'
import { getAttachmentRow } from './db/conversations'
import { readWorkspaceFile } from './runner/workspace'
import { getSettings } from './settings'
import { uid } from './util'

const CDN_HOSTS = ['https://cdnjs.cloudflare.com', 'https://cdn.jsdelivr.net', 'https://unpkg.com']

/** For images a code run wrote: no scripts, and nothing loaded from anywhere (inline styles only, for SVG). */
const WORKSPACE_CSP = "default-src 'none'; style-src 'unsafe-inline'; sandbox"
/** The media type of each image a chat previews (IMAGE_FILE), by extension. */
const IMAGE_TYPES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml'
}

/** Must run before `app.whenReady()`. */
export function registerSchemes(): void {
  protocol.registerSchemesAsPrivileged([
    { scheme: 'artifact', privileges: { standard: true, secure: true } },
    { scheme: 'ollmost', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }
  ])
}

const staged = new Map<string, { type: ArtifactType; content: string }>()

/** Park HTML/SVG content under a one-off token and return the URL the sandboxed frame should load. */
export function stageArtifact(type: ArtifactType, content: string): string {
  const token = uid()
  staged.set(token, { type, content })
  while (staged.size > 64) staged.delete(staged.keys().next().value!)
  return `artifact://frame/${token}`
}

function frameCsp(allowCdn: boolean): string {
  const cdn = allowCdn ? CDN_HOSTS.join(' ') : ''
  return [
    "default-src 'none'",
    `script-src 'unsafe-inline' 'unsafe-eval' ${cdn}`,
    `style-src 'unsafe-inline' ${cdn} ${allowCdn ? 'https://fonts.googleapis.com' : ''}`,
    `font-src data: ${cdn} ${allowCdn ? 'https://fonts.gstatic.com' : ''}`,
    `img-src data: blob: ${cdn}`,
    'media-src data: blob:',
    'worker-src blob:',
    // No fetch/XHR/WebSocket: model-written pages can't phone home.
    "connect-src 'none'",
    "form-action 'none'",
    "base-uri 'none'",
    "frame-src 'none'"
  ].join('; ')
}

function wrap(type: ArtifactType, content: string): string {
  if (type === 'svg')
    return `<!doctype html><html><head><meta charset="utf-8"><style>
html,body{margin:0;height:100%}body{display:flex;align-items:center;justify-content:center;padding:16px;box-sizing:border-box}
svg{max-width:100%;max-height:calc(100vh - 32px);height:auto}</style></head><body>${content}</body></html>`
  if (/<html[\s>]|<!doctype/i.test(content)) return content
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body>${content}</body></html>`
}

export function handleProtocols(): void {
  protocol.handle('artifact', (req) => {
    const token = new URL(req.url).pathname.slice(1)
    const entry = staged.get(token)
    if (!entry) return new Response('Artifact expired, reopen it from the chat.', { status: 404 })
    return new Response(wrap(entry.type, entry.content), {
      headers: {
        'content-type': 'text/html; charset=utf-8',
        'content-security-policy': frameCsp(getSettings().artifacts.allowCdn),
        'cache-control': 'no-store'
      }
    })
  })

  // Attachments are served by id only, never by path, so the renderer can't read arbitrary files. Images a code run
  // wrote are served by chat and path, only from inside that chat's workspace (see workspaceFile).
  protocol.handle('ollmost', async (req) => {
    const url = new URL(req.url)
    if (url.hostname === 'attachment') {
      const row = getAttachmentRow(url.pathname.slice(1))
      if (row) return net.fetch(pathToFileURL(row.path).toString())
    }
    if (url.hostname === 'workspace') {
      const [conversationId, ...rest] = url.pathname.slice(1).split('/').map(decodeURIComponent)
      const path = rest.join('/')
      const type = IMAGE_TYPES[path.match(IMAGE_FILE)?.[1]?.toLowerCase() ?? '']
      // A code session's files aren't read while its code runs (see openWorkspaceFile): not found, for now.
      const data = type ? await readWorkspaceFile(conversationId, path).catch(() => null) : null
      if (data) {
        // Shown only as <img>, but an SVG loaded any other way would run its scripts: this origin gets none, and loads
        // nothing (#67).
        // A view of the file's bytes, not a copy of them.
        return new Response(new Uint8Array(data.buffer, data.byteOffset, data.byteLength), {
          headers: { 'content-type': type, 'content-security-policy': WORKSPACE_CSP, 'x-content-type-options': 'nosniff' }
        })
      }
    }
    return new Response('Not found', { status: 404 })
  })
}
