import type { FileSource } from '@shared/types'
import { api } from './api'

/** Files the user dropped or pasted, as sources the main process can ingest: by path where the OS gives one, else by content. */
export async function toSources(files: File[]): Promise<FileSource[]> {
  return Promise.all(
    files.map(async (file) => {
      const path = api.files.pathFor(file)
      return path ? { path } : { name: file.name || 'pasted-image.png', mime: file.type, data: await file.arrayBuffer() }
    })
  )
}
