import { describe, expect, it } from 'vitest'
import { CHAT_TOOL_ROUNDS, CODE_TOOL_ROUNDS, MAX_TOOL_ROUNDS, toolRounds, turnPolicy } from '../src/main/chat/turn'

// What a reply may do depends on the kind of conversation (#82): the round loop reads this and nothing else.

describe('the policy for a reply', () => {
  it('gives a chat and a code session their own default', () => {
    expect(turnPolicy({ mode: 'chat', artifacts: true }).maxRounds).toBe(CHAT_TOOL_ROUNDS)
    expect(turnPolicy({ mode: 'code', artifacts: true }).maxRounds).toBe(CODE_TOOL_ROUNDS)
    expect(CODE_TOOL_ROUNDS).toBeGreaterThan(CHAT_TOOL_ROUNDS)
  })

  it('takes a chat’s or a code session’s rounds from Settings when given, and the constant otherwise', () => {
    expect(turnPolicy({ mode: 'chat', artifacts: true, chatRounds: 40 }).maxRounds).toBe(40)
    expect(turnPolicy({ mode: 'chat', artifacts: true, codeRounds: 20 }).maxRounds).toBe(CHAT_TOOL_ROUNDS)
    expect(turnPolicy({ mode: 'code', artifacts: true, codeRounds: 20 }).maxRounds).toBe(20)
    expect(turnPolicy({ mode: 'code', artifacts: true, chatRounds: 40 }).maxRounds).toBe(CODE_TOOL_ROUNDS)
    expect(turnPolicy({ mode: 'code', artifacts: true, codeRounds: 20, maxToolRounds: 3 }).maxRounds).toBe(3)
  })

  it('honours a caller’s round limit in either mode, never below one round', () => {
    expect(turnPolicy({ mode: 'chat', artifacts: true, maxToolRounds: 3 }).maxRounds).toBe(3)
    expect(turnPolicy({ mode: 'code', artifacts: true, maxToolRounds: 2 }).maxRounds).toBe(2)
    expect(turnPolicy({ mode: 'chat', artifacts: true, maxToolRounds: 0 }).maxRounds).toBe(1)
  })

  // Settings aren't checked over IPC, so a hand-edited round limit can be anything (#183).
  it('keeps a hand-edited round limit whole, from 1 to the most Settings offers, and uses the default for a non-number', () => {
    expect(toolRounds(12, 20)).toBe(12)
    expect(toolRounds(2.5, 20)).toBe(2)
    expect(toolRounds(0, 20)).toBe(1)
    expect(toolRounds(-3, 20)).toBe(1)
    expect(toolRounds(1e9, 20)).toBe(MAX_TOOL_ROUNDS)
    expect(toolRounds(undefined, 20)).toBe(20)
    expect(toolRounds(null, 20)).toBe(20)
    expect(toolRounds('abc', 20)).toBe(20)
    expect(toolRounds('12', 20)).toBe(20)
    expect(toolRounds(Number.NaN, 20)).toBe(20)
    expect(toolRounds(Number.POSITIVE_INFINITY, 20)).toBe(20)
    expect(toolRounds(1e9, 20, 40)).toBe(40)
    // Through the policy: "abc" would otherwise run zero rounds and 2.5 would never reach the tool-free last round.
    const bad = (rounds: unknown) => ({ chatRounds: rounds as number, codeRounds: rounds as number })
    expect(turnPolicy({ mode: 'chat', artifacts: true, ...bad('abc') }).maxRounds).toBe(CHAT_TOOL_ROUNDS)
    expect(turnPolicy({ mode: 'code', artifacts: true, ...bad('abc') }).maxRounds).toBe(CODE_TOOL_ROUNDS)
    expect(turnPolicy({ mode: 'chat', artifacts: true, ...bad(2.5) }).maxRounds).toBe(2)
    expect(turnPolicy({ mode: 'code', artifacts: true, ...bad(500) }).maxRounds).toBe(MAX_TOOL_ROUNDS)
    expect(turnPolicy({ mode: 'chat', artifacts: true, chatRounds: 40, maxToolRounds: 'x' as unknown as number }).maxRounds).toBe(40)
    expect(turnPolicy({ mode: 'chat', artifacts: true, maxToolRounds: 3.9 }).maxRounds).toBe(3)
  })

  it('offers artifacts to a chat when they are allowed, and never to a code session', () => {
    expect(turnPolicy({ mode: 'chat', artifacts: true })).toMatchObject({ mode: 'chat', artifacts: true })
    expect(turnPolicy({ mode: 'chat', artifacts: false }).artifacts).toBe(false)
    expect(turnPolicy({ mode: 'code', artifacts: true })).toMatchObject({ mode: 'code', artifacts: false })
  })
})
