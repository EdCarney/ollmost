import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { tempDir } from './tempDir'

// A stand-in for Electron's nativeImage: each test says how big the image is, or that Electron can't read it.
const image = vi.hoisted(() => ({ size: { width: 800, height: 600 }, empty: false }))
vi.mock('electron', () => {
  const img = {
    isEmpty: () => image.empty,
    getSize: () => image.size,
    resize: () => img,
    toPNG: () => Buffer.from('png-bytes'),
    toJPEG: () => Buffer.from('jpeg-bytes')
  }
  return { nativeImage: { createFromPath: () => img } }
})

const { imageForModel } = await import('../src/main/files/ingest')

const dir = tempDir('ollmost-image-')
const file = (name: string) => {
  const path = join(dir, name)
  writeFileSync(path, 'file-bytes')
  return path
}
const b64 = (s: string) => Buffer.from(s).toString('base64')

beforeEach(() => {
  image.size = { width: 800, height: 600 }
  image.empty = false
})

describe('imageForModel', () => {
  it('sends a small PNG or JPEG as it is, with its own type', async () => {
    expect(await imageForModel(file('a.png'), 'image/png')).toEqual({ data: b64('file-bytes'), mime: 'image/png' })
    expect(await imageForModel(file('a.jpg'), 'image/jpeg')).toEqual({ data: b64('file-bytes'), mime: 'image/jpeg' })
  })

  it('re-encodes any other type as JPEG, and says so', async () => {
    expect(await imageForModel(file('a.webp'), 'image/webp')).toEqual({ data: b64('jpeg-bytes'), mime: 'image/jpeg' })
  })

  it('keeps a large PNG a PNG when it shrinks it', async () => {
    image.size = { width: 4000, height: 3000 }
    expect(await imageForModel(file('big.png'), 'image/png')).toEqual({ data: b64('png-bytes'), mime: 'image/png' })
    expect(await imageForModel(file('big.jpg'), 'image/jpeg')).toEqual({ data: b64('jpeg-bytes'), mime: 'image/jpeg' })
  })

  it('sends an image Electron can’t read as it is', async () => {
    image.empty = true
    expect(await imageForModel(file('a.gif'), 'image/gif')).toEqual({ data: b64('file-bytes'), mime: 'image/gif' })
  })
})
