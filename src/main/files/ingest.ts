import { readFile, rm, stat, writeFile } from 'node:fs/promises'
import { basename, extname, join } from 'node:path'
import { nativeImage } from 'electron'
import type { FileSource } from '@shared/types'
import { paths } from '../paths'
import type { ChatImage } from '../providers/types'
import { errorMessage, estimateTokens, uid } from '../util'
import { extractText, MODEL_IMAGE_MIMES, mimeFor } from './extract'

const MAX_BYTES = 30 * 1024 * 1024
/** Long edge sent to vision models; larger images cost tokens without helping. */
const MODEL_IMAGE_EDGE = 1568

export interface Ingested {
  id: string
  name: string
  mime: string
  size: number
  path: string
  kind: 'image' | 'document'
  text: string | null
  tokenEst: number
}

async function load(source: FileSource): Promise<{ buf: Buffer; name: string; mime: string }> {
  if ('path' in source) {
    const info = await stat(source.path)
    if (!info.isFile()) throw new Error(`${basename(source.path)} is not a file`)
    if (info.size > MAX_BYTES) throw new Error(`${basename(source.path)} is larger than 30 MB`)
    const name = basename(source.path)
    return { buf: await readFile(source.path), name, mime: mimeFor(name) }
  }
  if (source.data.byteLength > MAX_BYTES) throw new Error(`${source.name} is larger than 30 MB`)
  return { buf: Buffer.from(source.data), name: source.name, mime: mimeFor(source.name, source.mime) }
}

export async function ingest(source: FileSource): Promise<Ingested> {
  const { buf, name, mime } = await load(source)
  const id = uid()
  const path = join(paths.files, `${id}${extname(name).toLowerCase()}`)
  const isImage = MODEL_IMAGE_MIMES.has(mime)
  const text = isImage ? null : await extractText(buf, mime, name)
  await writeFile(path, buf)
  let tokenEst = text ? estimateTokens(text) : 0
  if (isImage) {
    const { width, height } = nativeImage.createFromBuffer(buf).getSize()
    const scale = Math.min(1, MODEL_IMAGE_EDGE / Math.max(width || 1, height || 1))
    tokenEst = Math.ceil((width * scale * height * scale) / 750) || 1600
  }
  return { id, name, mime, size: buf.length, path, kind: isImage ? 'image' : 'document', text, tokenEst }
}

export async function ingestAll(sources: FileSource[]): Promise<{ ok: Ingested[]; errors: string[] }> {
  const ok: Ingested[] = []
  const errors: string[] = []
  for (const s of sources) {
    try {
      ok.push(await ingest(s))
    } catch (err) {
      errors.push(errorMessage(err))
    }
  }
  return { ok, errors }
}

/** An image for a vision model (base64, and the type it's in), downscaled when larger than the model needs. */
export async function imageForModel(path: string, mime: string): Promise<ChatImage> {
  const img = nativeImage.createFromPath(path)
  if (img.isEmpty()) return { data: (await readFile(path)).toString('base64'), mime }
  const { width, height } = img.getSize()
  const longEdge = Math.max(width, height)
  if (longEdge <= MODEL_IMAGE_EDGE && (mime === 'image/png' || mime === 'image/jpeg'))
    return { data: (await readFile(path)).toString('base64'), mime }
  const resized = longEdge > MODEL_IMAGE_EDGE ? img.resize({ width: Math.round((width * MODEL_IMAGE_EDGE) / longEdge) }) : img
  // PNG keeps transparency (JPEG would turn it black); everything else becomes a compact JPEG.
  return mime === 'image/png'
    ? { data: resized.toPNG().toString('base64'), mime }
    : { data: resized.toJPEG(88).toString('base64'), mime: 'image/jpeg' }
}

export async function removeFiles(filePaths: string[]): Promise<void> {
  await Promise.all(filePaths.map((p) => rm(p, { force: true }).catch(() => undefined)))
}
