import { describe, expect, it } from 'vitest'
import { CODE_TOOL_ROUNDS, DEFAULT_TOOL_ROUNDS, TOOL_SOURCE_ROUNDS, turnPolicy } from '../src/main/chat/turn'

// What a reply may do depends on the kind of conversation (#82): the round loop reads this and nothing else.

describe('the policy for a reply', () => {
  it('gives a chat a few rounds, more with tool sources on, and a code session many', () => {
    expect(turnPolicy({ mode: 'chat', sources: [], artifacts: true }).maxRounds).toBe(DEFAULT_TOOL_ROUNDS)
    expect(turnPolicy({ mode: 'chat', sources: ['mcp:x'], artifacts: true }).maxRounds).toBe(TOOL_SOURCE_ROUNDS)
    expect(turnPolicy({ mode: 'code', sources: [], artifacts: true }).maxRounds).toBe(CODE_TOOL_ROUNDS)
    expect(turnPolicy({ mode: 'code', sources: ['mcp:x'], artifacts: true }).maxRounds).toBe(CODE_TOOL_ROUNDS)
    expect(CODE_TOOL_ROUNDS).toBeGreaterThan(TOOL_SOURCE_ROUNDS)
  })

  it('honours a caller’s round limit in either mode, never below one round', () => {
    expect(turnPolicy({ mode: 'chat', sources: ['mcp:x'], artifacts: true, maxToolRounds: 3 }).maxRounds).toBe(3)
    expect(turnPolicy({ mode: 'code', sources: [], artifacts: true, maxToolRounds: 2 }).maxRounds).toBe(2)
    expect(turnPolicy({ mode: 'chat', sources: [], artifacts: true, maxToolRounds: 0 }).maxRounds).toBe(1)
  })

  it('offers artifacts to a chat when they are allowed, and never to a code session', () => {
    expect(turnPolicy({ mode: 'chat', sources: [], artifacts: true })).toMatchObject({ mode: 'chat', artifacts: true })
    expect(turnPolicy({ mode: 'chat', sources: [], artifacts: false }).artifacts).toBe(false)
    expect(turnPolicy({ mode: 'code', sources: [], artifacts: true })).toMatchObject({ mode: 'code', artifacts: false })
  })
})
