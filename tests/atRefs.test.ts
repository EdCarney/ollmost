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
  normalizeAtPath,
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

  it('opens a fence only on a line of three or more backticks or tildes, and closes it only with as many of the same', () => {
    expect(findAtTokens('```npm test``` fails, see @src/a.ts')).toEqual([{ start: 26, end: 35, path: 'src/a.ts' }])
    expect(findAtTokens('~~~\n@a.ts\n~~~')).toEqual([])
    expect(findAtTokens('````\n```\n@a.ts\n```\n````')).toEqual([])
    expect(findAtTokens('````\n```\n@a.ts\n```\n````\n@b.ts').map((t) => t.path)).toEqual(['b.ts'])
    expect(findAtTokens('````\n@a.ts\n```\n@b.ts')).toEqual([])
    expect(findAtTokens('```\n@a.ts\n~~~\n@b.ts')).toEqual([])
  })

  it('keeps a closing bracket the path opened, and drops one it didn’t', () => {
    expect(findAtTokens('@app/(auth) and @app/[id], (see @d.ts).').map((t) => t.path)).toEqual(['app/(auth)', 'app/[id]', 'd.ts'])
    expect(findAtTokens('(see @app/(auth)). {or @b.ts},').map((t) => t.path)).toEqual(['app/(auth)', 'b.ts'])
  })

  it('reports a path as it’s spelled, and leaves one that starts outside the folder or climbs out of it as plain text', () => {
    expect(findAtTokens('@src//a.ts @./src/./a.ts @./').map((t) => t.path)).toEqual(['src//a.ts', './src/./a.ts', './'])
    expect(findAtTokens('@/etc/hosts @~/x @../x @src/../a.ts @src/.. @./..')).toEqual([])
  })
})

describe('normalizeAtPath', () => {
  it('spells a path one way: no "./" or doubled slashes, and "" for the folder itself', () => {
    expect(normalizeAtPath('./src/./a.ts')).toBe('src/a.ts')
    expect(normalizeAtPath('src//a.ts')).toBe('src/a.ts')
    expect(normalizeAtPath('.//a.ts')).toBe('a.ts')
    expect(normalizeAtPath('src/')).toBe('src/')
    expect(normalizeAtPath('./')).toBe('')
    expect(normalizeAtPath('.')).toBe('')
  })

  it('keeps what shows a path leaves the folder', () => {
    expect(normalizeAtPath('/etc/hosts')).toBe('/etc/hosts')
    expect(normalizeAtPath('src/../a.ts')).toBe('src/../a.ts')
  })
})

describe('atQueryAt', () => {
  it('gives the @ being typed at the caret, and nothing mid-word or in a fence', () => {
    expect(atQueryAt('see @src/fi', 11)).toEqual({ start: 4, query: 'src/fi' })
    expect(atQueryAt('@', 1)).toEqual({ start: 0, query: '' })
    expect(atQueryAt('me@exa', 6)).toBeNull()
    expect(atQueryAt('@a b', 4)).toBeNull()
    expect(atQueryAt('```\n@a', 6)).toBeNull()
    expect(atQueryAt('~~~\n@a', 6)).toBeNull()
  })

  it('reads only up to the caret', () => {
    expect(atQueryAt('see @src/fi now', 11)).toEqual({ start: 4, query: 'src/fi' })
    expect(atQueryAt('@ab cd', 2)).toEqual({ start: 0, query: 'a' })
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

  it('tries a shorter run in one segment when a later segment can take the rest', () => {
    expect(atMatch('main/access.ts', 'mac')).toEqual({ rank: 4, hits: [0, 5, 6] })
  })

  it('keeps each hit on the character it matched when lower case would change a character’s length', () => {
    expect(atMatch('İ/files.ts', 'fil')).toEqual({ rank: 1, hits: [2, 3, 4] })
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

  it('puts the shorter path first when code-point order would put it second', () => {
    expect(atRows(['a/long/files.ts', 'b/files.ts'], 'fil', []).rows.map((r) => r.path)).toEqual(['b/files.ts', 'a/long/files.ts'])
  })

  it('leaves out a path with a space in it, which a token can’t name', () => {
    const spaced = ['My Notes.md', 'My Notes/', 'notes.md']
    expect(atRows(spaced, 'not', []).rows.map((r) => r.path)).toEqual(['notes.md'])
    expect(atRows(spaced, '', [{ path: 'My Notes.md', how: 'read' }])).toMatchObject({
      heading: 'In this folder',
      rows: [{ path: 'notes.md' }]
    })
  })

  it('reads a query that starts "./" as the path after it', () => {
    expect(atRows(paths, './fil', [])).toEqual(atRows(paths, 'fil', []))
    expect(atRows(paths, './', []).heading).toBe('In this folder')
  })

  it('shows at most AT_ROWS rows', () => {
    const many = Array.from({ length: 80 }, (_, i) => `f${i}.ts`)
    expect(atRows(many, 'f', []).rows).toHaveLength(AT_ROWS)
  })

  it('keeps the best AT_ROWS rows wherever they come in the list', () => {
    const many = Array.from({ length: 80 }, (_, i) => `f${79 - i}.ts`)
    const rows = atRows(many, 'f', []).rows.map((r) => r.path)
    expect(rows.slice(0, 11)).toEqual([...Array.from({ length: 10 }, (_, i) => `f${i}.ts`), 'f10.ts'])
    expect(rows[AT_ROWS - 1]).toBe('f49.ts')
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

  it('marks any spelling of a listed path and "./", the folder itself, but nothing outside the folder', () => {
    const listed = new Set(['src/', 'src/a.ts'])
    const text = '@src//a.ts @./src/./a.ts @./ @/etc/hosts @~/x @../x @src/../a.ts'
    expect(markedTokens(text, listed).map((t) => t.path)).toEqual(['src//a.ts', './src/./a.ts', './'])
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
