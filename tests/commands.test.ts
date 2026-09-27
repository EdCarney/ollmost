import { describe, expect, it } from 'vitest'
import { COMMANDS, parseCommand } from '../src/shared/commands'

describe('slash commands', () => {
  it('lists /compact with a hint for what to keep', () => {
    expect(COMMANDS.map((c) => c.name)).toEqual(['compact'])
    expect(COMMANDS[0]).toMatchObject({ name: 'compact', hint: '[what to keep]' })
    expect(COMMANDS[0].description).toMatch(/summar/i)
  })

  it('parses a command and its arguments from what was typed', () => {
    expect(parseCommand('/compact')).toEqual({ name: 'compact', args: '' })
    expect(parseCommand('/compact keep the API design decisions')).toEqual({ name: 'compact', args: 'keep the API design decisions' })
    expect(parseCommand('  /compact  spaced  ')).toEqual({ name: 'compact', args: 'spaced' })
    expect(parseCommand('/COMPACT it')).toEqual({ name: 'compact', args: 'it' })
  })

  it('leaves everything else alone: prose, a skill, an unknown or partial command, a command mid-text', () => {
    expect(parseCommand('compact this')).toBeNull()
    expect(parseCommand('/haiku-helper write one')).toBeNull()
    expect(parseCommand('/compac')).toBeNull()
    expect(parseCommand('/compacting')).toBeNull()
    expect(parseCommand('please /compact')).toBeNull()
    expect(parseCommand('/compact\nand then more lines')).toEqual({ name: 'compact', args: 'and then more lines' })
  })
})
