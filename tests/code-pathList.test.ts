import { mkdirSync, realpathSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { tempDir } from './tempDir'

// The @ menu's list of a code session's files (#129): the file tools' walker, kept per folder until something may
// have changed what it would find.

vi.mock('electron', () => ({
  safeStorage: { isEncryptionAvailable: () => false },
  shell: {},
  app: { getPath: () => '' }
}))

const { openDatabase } = await import('../src/main/db/index')
const { createConversation } = await import('../src/main/db/conversations')
const { updateSettings } = await import('../src/main/settings')
const { paths } = await import('../src/main/paths')
const workspace = await import('../src/main/runner/workspace')
const lock = await import('../src/main/runner/lock')
const files = await import('../src/main/code/files')
const { dropSessionPaths, sessionPaths, withFolders } = await import('../src/main/code/pathList')

const data = tempDir('ollmost-code-paths-')
beforeAll(() => {
  openDatabase(':memory:')
  paths.data = data
  paths.files = join(data, 'files')
  paths.workspaces = join(data, 'workspaces')
  paths.runner = join(data, 'runner')
  updateSettings({ skills: { sources: { ollama: false, claude: false } } })
})

/** A folder of the user's holding `tree`, by its real path, and a session in it. */
function project(tree: Record<string, string>) {
  const dir = realpathSync(tempDir('ollmost-paths-'))
  for (const [rel, text] of Object.entries(tree)) {
    mkdirSync(join(dir, dirname(rel)), { recursive: true })
    writeFileSync(join(dir, rel), text)
  }
  return { dir, ws: workspace.workspaceFor(session(dir)) }
}
const session = (root: string) =>
  createConversation({ projectId: null, model: 'm', think: null, skills: [], mode: 'code', root, title: 'p' }).id

describe('withFolders', () => {
  it('puts each folder that holds a file first, once, ending in a slash', () => {
    expect(withFolders(['a.ts', 'src/b.ts', 'src/main/c.ts'])).toEqual(['src/', 'src/main/', 'a.ts', 'src/b.ts', 'src/main/c.ts'])
  })
})

describe('sessionPaths', () => {
  it('lists the folder’s files and folders relative to it, leaving out what .gitignore ignores', async () => {
    const { ws } = project({ '.gitignore': 'dist/\n', 'dist/x.js': '', 'README.md': '', 'src/a.ts': '' })
    expect(await sessionPaths(ws)).toEqual({ paths: ['src/', '.gitignore', 'README.md', 'src/a.ts'], cut: false, busy: false })
  })

  it('says when its limit cut the list', async () => {
    const { ws } = project({ 'a.ts': '', 'b.ts': '', 'c.ts': '' })
    expect(await sessionPaths(ws, 2)).toEqual({ paths: ['a.ts', 'b.ts'], cut: true, busy: false })
  })

  it('is kept per folder until a file tool writes there or it is dropped, whichever session asked', async () => {
    const { dir, ws } = project({ 'a.ts': 'x\n' })
    expect((await sessionPaths(ws)).paths).toEqual(['a.ts'])
    writeFileSync(join(dir, 'b.ts'), '')
    expect((await sessionPaths(ws)).paths).toEqual(['a.ts'])
    // Another session on the same folder shares the list, and its write drops it.
    await files.writeFile(workspace.workspaceFor(session(dir)), { path: 'c.ts', content: 'y\n' })
    expect((await sessionPaths(ws)).paths).toEqual(['a.ts', 'b.ts', 'c.ts'])
    writeFileSync(join(dir, 'd.ts'), '')
    dropSessionPaths(dir)
    expect((await sessionPaths(ws)).paths).toEqual(['a.ts', 'b.ts', 'c.ts', 'd.ts'])
  })

  it('says a running command stopped it, and tries again the next time', async () => {
    const { ws } = project({ 'a.ts': '' })
    await lock.codeStarting(ws)
    try {
      expect(await sessionPaths(ws)).toEqual({ paths: [], cut: false, busy: true })
    } finally {
      await lock.codeEnded(ws)
    }
    expect((await sessionPaths(ws)).paths).toEqual(['a.ts'])
  })
})
