import { describe, expect, it } from 'vitest'
import { buildTree, folderAfterRemoving, normalizeFolder } from '../src/shared/fileTree'

describe('a folder path', () => {
  it('is trimmed of slashes and spaces, never climbs, and is empty at the root', () => {
    expect(normalizeFolder('')).toBe('')
    expect(normalizeFolder('/docs/')).toBe('docs')
    expect(normalizeFolder(' docs / notes ')).toBe('docs/notes')
    expect(normalizeFolder('docs//notes')).toBe('docs/notes')
    expect(normalizeFolder('../etc')).toBe('etc')
    expect(normalizeFolder('docs/../../x')).toBe('docs/x')
    expect(normalizeFolder('.')).toBe('')
  })

  it('takes a backslash as a separator and drops control characters', () => {
    expect(normalizeFolder('docs\\notes')).toBe('docs/notes')
    expect(normalizeFolder('do\ncs/\tnotes\u0000')).toBe('docs/notes')
    expect(normalizeFolder('docs\u2028/\u202enotes\u0085')).toBe('docs/notes')
  })

  it('moves a removed folder’s files up into its parent, keeping what was under them', () => {
    expect(folderAfterRemoving('docs', 'docs')).toBe('')
    expect(folderAfterRemoving('docs', 'docs/meetings')).toBe('meetings')
    expect(folderAfterRemoving('docs/meetings', 'docs/meetings/2026')).toBe('docs/2026')
    expect(folderAfterRemoving('docs', 'other')).toBe('other')
    expect(folderAfterRemoving('docs', 'docsier')).toBe('docsier')
  })
})

describe('a project’s file tree', () => {
  const files = [
    { id: 'a', name: 'readme.md', folder: '' },
    { id: 'b', name: 'brief.txt', folder: 'docs' },
    { id: 'c', name: 'agenda.md', folder: 'docs/meetings' },
    { id: 'd', name: 'Zed.txt', folder: '' },
    { id: 'e', name: 'notes.md', folder: 'docs' }
  ]

  it('nests folders from the files’ paths, folders first, each level sorted by name without regard to case', () => {
    const tree = buildTree(files)
    expect(tree.map((n) => (n.kind === 'folder' ? `${n.name}/` : n.name))).toEqual(['docs/', 'readme.md', 'Zed.txt'])
    const docs = tree[0]
    expect(docs.kind === 'folder' && docs.path).toBe('docs')
    expect(docs.kind === 'folder' && docs.children.map((n) => (n.kind === 'folder' ? `${n.name}/` : n.name))).toEqual([
      'meetings/',
      'brief.txt',
      'notes.md'
    ])
    const meetings = docs.kind === 'folder' ? docs.children[0] : null
    expect(meetings?.kind === 'folder' && meetings.path).toBe('docs/meetings')
    expect(meetings?.kind === 'folder' && meetings.children.map((n) => n.kind === 'file' && n.file.id)).toEqual(['c'])
  })

  it('keeps an empty folder the viewer made until a file lands in it', () => {
    const tree = buildTree(files, ['drafts', 'docs'])
    expect(tree.map((n) => n.name)).toEqual(['docs', 'drafts', 'readme.md', 'Zed.txt'])
    expect(buildTree([], ['a/b']).map((n) => (n.kind === 'folder' ? n.children.map((c) => c.name) : null))).toEqual([['b']])
  })
})
