import { describe, expect, it } from 'vitest'
import {
  AT_ROWS,
  atFooter,
  atMatch,
  atQueryAt,
  atRows,
  findAtTokens,
  hitRuns,
  insertAtPath,
  markedTokens,
  referenceMarks,
  referenceNote,
  splitMarked,
  touchedPaths
} from '@shared/atRefs'
import type { MessageReference, ToolEvent } from '@shared/types'

// Typing @ in a code session (#129): the tokens main reads and the composer marks, and the menu's rows.

describe('findAtTokens', () => {
  it('finds a token at the start and after a space or newline, without closing punctuation', () => {
    expect(findAtTokens('@a.ts and @src/b.ts,\n@c/ (see @d.ts).')).toEqual([
      { start: 0, end: 5, path: 'a.ts' },
      { start: 10, end: 19, path: 'src/b.ts' },
      { start: 21, end: 24, path: 'c/' },
      { start: 30, end: 35, path: 'd.ts' }
    ])
  })

  it('leaves an email address, a mid-word @, text in code fences and a bare @ alone', () => {
    expect(findAtTokens('me@example.com x@y\n```\n@a.ts\n```\n@ @.')).toEqual([])
  })

  it('treats an unclosed fence as code to the end', () => {
    expect(findAtTokens('@a.ts\n```ts\n@b.ts')).toEqual([{ start: 0, end: 5, path: 'a.ts' }])
  })

  it('stops a path at a space: a path with spaces isn’t supported', () => {
    expect(findAtTokens('@my file.txt')).toEqual([{ start: 0, end: 3, path: 'my' }])
  })
})

describe('atQueryAt', () => {
  it('gives the @ being typed at the caret, and nothing mid-word or in a fence', () => {
    expect(atQueryAt('see @src/fi', 11)).toEqual({ start: 4, query: 'src/fi' })
    expect(atQueryAt('@', 1)).toEqual({ start: 0, query: '' })
    expect(atQueryAt('me@exa', 6)).toBeNull()
    expect(atQueryAt('@a b', 4)).toBeNull()
    expect(atQueryAt('```\n@a', 6)).toBeNull()
  })
})

describe('insertAtPath', () => {
  it('replaces the typed @ and the rest of its word with the path and a space, and puts the caret after it', () => {
    expect(insertAtPath('see @fi now', 7, { start: 4 }, 'src/files.ts')).toEqual({ text: 'see @src/files.ts now', caret: 18 })
    expect(insertAtPath('@sr', 3, { start: 0 }, 'src/')).toEqual({ text: '@src/ ', caret: 6 })
    expect(insertAtPath('x @file y', 5, { start: 2 }, 'a.ts')).toEqual({ text: 'x @a.ts y', caret: 8 })
  })
})

describe('atMatch', () => {
  it('ranks a name that starts with the query, then contains it, then a path that does, then letters across segments', () => {
    expect(atMatch('src/main/code/files.ts', 'fil')).toEqual({ rank: 1, hits: [14, 15, 16] })
    expect(atMatch('tests/code-files.test.ts', 'fil')).toEqual({ rank: 2, hits: [11, 12, 13] })
    expect(atMatch('src/main/files/ingest.ts', 'fil')).toEqual({ rank: 3, hits: [9, 10, 11] })
    expect(atMatch('src/main/code/files.ts', 'mcf')).toEqual({ rank: 4, hits: [4, 9, 14] })
    expect(atMatch('src/main/files/', 'FIL')).toEqual({ rank: 1, hits: [9, 10, 11] })
    expect(atMatch('README.md', 'xyz')).toBeNull()
  })
})

describe('atRows', () => {
  const paths = [
    'src/',
    'src/main/',
    'README.md',
    'src/main/files.ts',
    'src/shared/fileTree.ts',
    'tests/code-files.test.ts',
    'src/main/walk.ts'
  ]

  it('orders by rank, then files this session touched, then shorter paths', () => {
    const { heading, rows } = atRows(paths, 'fil', [{ path: 'src/shared/fileTree.ts', how: 'read' }])
    expect(heading).toBeNull()
    expect(rows.map((r) => [r.path, r.touched])).toEqual([
      ['src/shared/fileTree.ts', 'read'],
      ['src/main/files.ts', null],
      ['tests/code-files.test.ts', null]
    ])
    expect(rows[1]).toMatchObject({ name: 'files.ts', dir: 'src/main', folder: false, hits: [9, 10, 11] })
  })

  it('shows the touched files for a bare @, else the folder’s top level, folders first', () => {
    expect(
      atRows(paths, '', [
        { path: 'src/main/walk.ts', how: 'edited' },
        { path: 'gone.ts', how: 'read' }
      ])
    ).toMatchObject({
      heading: 'Recent in this session',
      rows: [{ path: 'src/main/walk.ts', touched: 'edited' }]
    })
    const top = atRows(paths, '', [])
    expect(top.heading).toBe('In this folder')
    expect(top.rows.map((r) => r.path)).toEqual(['src/', 'README.md'])
    expect(top.rows[0]).toMatchObject({ name: 'src/', dir: '', folder: true })
  })

  it('shows at most AT_ROWS rows', () => {
    const many = Array.from({ length: 80 }, (_, i) => `f${i}.ts`)
    expect(atRows(many, 'f', []).rows).toHaveLength(AT_ROWS)
  })
})

describe('touchedPaths', () => {
  const event = (tool: string, extra: Partial<ToolEvent> = {}): ToolEvent => ({ tool, args: {}, ok: true, summary: '', ...extra })

  it('lists what the session read or edited, most recent first, an edit winning over a read', () => {
    const messages = [
      {
        toolEvents: [
          event('read_file', { args: { path: './a.ts' } }),
          event('edit_file', { args: { path: 'b.ts' }, files: [{ path: 'b.ts', size: 1 }] })
        ]
      },
      {
        toolEvents: [
          event('read_file', { args: { path: 'b.ts' } }),
          event('read_file', { args: { path: 'c.ts' }, ok: false }),
          event('delegate', { child: { task: 't', events: [event('read_file', { args: { path: 'd.ts' } })], result: '', rounds: 1 } })
        ]
      }
    ]
    expect(touchedPaths(messages)).toEqual([
      { path: 'd.ts', how: 'read' },
      { path: 'b.ts', how: 'edited' },
      { path: 'a.ts', how: 'read' }
    ])
  })
})

describe('marks', () => {
  it('marks the tokens that name a listed file or folder, however they’re spelled', () => {
    const listed = new Set(['src/', 'src/a.ts'])
    const text = 'Fix @src/a.ts, @./src/a.ts and @src but not @b.ts'
    expect(markedTokens(text, listed).map((t) => t.path)).toEqual(['src/a.ts', './src/a.ts', 'src'])
  })

  it('splits text into its marked and plain parts', () => {
    expect(splitMarked('see @a.ts now', [{ start: 4, end: 9, path: 'a.ts' }])).toEqual([
      { text: 'see ', marked: false },
      { text: '@a.ts', marked: true },
      { text: ' now', marked: false }
    ])
  })

  it('marks in a sent message only what was sent', () => {
    const ref: MessageReference = { tokens: ['a.ts', './a.ts'], path: 'a.ts', kind: 'file', text: '' }
    expect(referenceMarks('@a.ts @./a.ts @b.ts', [ref]).map((t) => t.path)).toEqual(['a.ts', './a.ts'])
  })

  it('splits a name into the runs the query matched', () => {
    expect(hitRuns('files.ts', [14, 15, 16], 14)).toEqual([
      { text: 'fil', hit: true },
      { text: 'es.ts', hit: false }
    ])
  })
})

describe('notes', () => {
  const ref: MessageReference = { tokens: ['a'], path: 'a', kind: 'file', text: '' }

  it('says how much of a file was sent, or why none was', () => {
    expect(referenceNote({ ...ref, lines: { from: 1, to: 2000, total: 5310 } })).toBe('lines 1–2,000 of 5,310')
    expect(referenceNote({ ...ref, lines: { from: 1, to: 3, total: 3 } })).toBeNull()
    expect(referenceNote({ ...ref, refused: 'binary file' })).toBe('not sent: binary file')
    expect(referenceNote({ ...ref, kind: 'folder', cut: true })).toBe('listing cut')
  })

  it('says when the list is partial, or couldn’t be made', () => {
    expect(atFooter({ paths: ['src/', 'a.ts', 'src/b.ts'], cut: true, busy: false })).toBe('Showing matches from the first 2 files')
    expect(atFooter({ paths: [], cut: false, busy: true })).toBe("Files can't be listed while a command runs.")
    expect(atFooter({ paths: ['a.ts'], cut: false, busy: false })).toBeNull()
  })
})
