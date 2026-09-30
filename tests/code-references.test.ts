import { mkdirSync, realpathSync, renameSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { beforeAll, describe, expect, it, vi } from 'vitest'
import { tempDir, trackTempDir } from './tempDir'

// What a code session's @ references send (#129): a file as read_file reads it, a folder as list_files lists it, or
// why it wasn't sent; nothing for a token that names nothing or leads out of the folder.

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
const { resolveReferences } = await import('../src/main/code/references')

const data = tempDir('ollmost-code-refs-')
beforeAll(() => {
  openDatabase(':memory:')
  paths.data = data
  paths.files = join(data, 'files')
  paths.workspaces = join(data, 'workspaces')
  paths.runner = join(data, 'runner')
  updateSettings({ skills: { sources: { ollama: false, claude: false } } })
})

/** A folder of the user's holding `tree`, by its real path, and a session in it. */
function project(tree: Record<string, string | Buffer>) {
  const dir = realpathSync(tempDir('ollmost-refs-'))
  for (const [rel, text] of Object.entries(tree)) {
    mkdirSync(join(dir, dirname(rel)), { recursive: true })
    writeFileSync(join(dir, rel), text)
  }
  const c = createConversation({ projectId: null, model: 'm', think: null, skills: [], mode: 'code', root: dir, title: 'r' })
  return { dir, ws: workspace.workspaceFor(c.id) }
}

/** 1,000 lines of 40 characters: 48,000 once numbered, more than one reference's room. */
const LONG = `${'x'.repeat(40)}\n`.repeat(1000)

describe('resolveReferences', () => {
  it('reads a file as read_file numbers it, and a folder as list_files lists it', async () => {
    const { ws } = project({ 'src/a.ts': 'one\ntwo\n', 'src/b.ts': '' })
    expect(await resolveReferences(ws, 'Compare @src/a.ts with @src')).toEqual([
      { tokens: ['src/a.ts'], path: 'src/a.ts', kind: 'file', lines: { from: 1, to: 2, total: 2 }, text: '     1\tone\n     2\ttwo' },
      { tokens: ['src'], path: 'src/', kind: 'folder', text: 'src/a.ts\nsrc/b.ts' }
    ])
  })

  it('lists the folder itself for @./, and a file named as a folder is nothing', async () => {
    const { ws } = project({ 'a.ts': 'x\n', 'src/b.ts': '' })
    expect(await resolveReferences(ws, 'See @./ but not @a.ts/')).toEqual([
      { tokens: ['./'], path: './', kind: 'folder', text: 'a.ts\nsrc/b.ts' }
    ])
  })

  it('leaves out what names nothing or leads out of the folder, and anything that isn’t a token', async () => {
    const { dir, ws } = project({ 'a.ts': 'x\n' })
    symlinkSync('/etc/hosts', join(dir, 'out'))
    expect(await resolveReferences(ws, 'Mail me@example.com about @missing.ts, @out and\n```\n@a.ts\n```')).toEqual([])
  })

  it('says why a binary file wasn’t sent', async () => {
    const { ws } = project({ 'logo.png': Buffer.from([0x89, 0x50, 0, 0x47]) })
    expect(await resolveReferences(ws, '@logo.png')).toEqual([
      { tokens: ['logo.png'], path: 'logo.png', kind: 'file', refused: 'binary file', text: 'logo.png is a binary file.' }
    ])
  })

  it('cuts a long file where read_file would, and keeps each spelling of one path as one reference', async () => {
    const { ws } = project({ 'big.txt': 'x\n'.repeat(3000) })
    const refs = await resolveReferences(ws, '@big.txt and again @./big.txt, then @big.txt')
    expect(refs).toHaveLength(1)
    expect(refs[0].tokens).toEqual(['big.txt', './big.txt'])
    expect(refs[0].lines).toEqual({ from: 1, to: 2000, total: 3000 })
  })

  it('says when a folder’s listing was cut to fit', async () => {
    const tree: Record<string, string> = {}
    for (let i = 0; i < 400; i++) tree[`src/${'n'.repeat(50)}-${String(i).padStart(3, '0')}.ts`] = ''
    const { ws } = project(tree)
    const [ref] = await resolveReferences(ws, '@src/')
    expect(ref).toMatchObject({ tokens: ['src/'], path: 'src/', kind: 'folder', cut: true })
    expect(ref.text).toMatch(/\n\[… \d+ more characters cut\]$/)
  })

  it('stops reading when the message’s references reach their limit, and says so', async () => {
    const { ws } = project({ 'a.txt': LONG, 'b.txt': LONG, 'c.txt': LONG })
    const refs = await resolveReferences(ws, '@a.txt @b.txt @c.txt')
    expect(refs.map((r) => r.refused ?? (r.lines!.to < 1000 ? 'cut' : 'whole'))).toEqual(['cut', 'cut', 'over the limit'])
    expect(refs[2]).toMatchObject({ path: 'c.txt', kind: 'file' })
    expect(refs[2].text).toMatch(/reached their limit of 48,000 characters, so c\.txt wasn't included/)
    expect(refs.reduce((n, r) => n + r.text.length, 0)).toBeLessThan(48_000)
  })

  it('names a folder past the limit as a folder, the session’s own too', async () => {
    const { dir, ws } = project({ 'a.txt': LONG, 'b.txt': LONG, 'src/c.ts': '' })
    symlinkSync(join(dir, 'src'), join(dir, 'src-link'))
    const refs = await resolveReferences(ws, '@a.txt @b.txt @src @src-link @./ @missing.ts')
    expect(refs.slice(2)).toMatchObject([
      { tokens: ['src'], path: 'src/', kind: 'folder', refused: 'over the limit' },
      { tokens: ['src-link'], path: 'src-link/', kind: 'folder', refused: 'over the limit' },
      { tokens: ['./'], path: './', kind: 'folder', refused: 'over the limit' }
    ])
    expect(refs[2].text).toMatch(/so src\/ wasn't included\. Use list_files for it\.$/)
  })

  it('throws while a command runs in the folder, so the reply can leave them for a Retry', async () => {
    const { ws } = project({ 'a.ts': 'x\n' })
    await lock.codeStarting(ws)
    try {
      await expect(resolveReferences(ws, '@a.ts')).rejects.toBeInstanceOf(lock.CodeRunningError)
    } finally {
      await lock.codeEnded(ws)
    }
  })

  it('throws when the folder is gone', async () => {
    const { dir, ws } = project({ 'a.ts': 'x\n' })
    renameSync(dir, `${dir}-moved`)
    trackTempDir(`${dir}-moved`)
    await expect(resolveReferences(ws, '@a.ts')).rejects.toBeInstanceOf(workspace.RootMissingError)
  })
})
