import { describe, expect, it } from 'vitest'
import { CHAT_TOOL_ROUNDS, CODE_TOOL_ROUNDS, turnPolicy } from '../src/main/chat/turn'

// What a reply may do depends on the kind of conversation (#82): the round loop reads this and nothing else.

describe('the policy for a reply', () => {
  it('gives a chat and a code session their own default, whether or not the chat has tool sources on', () => {
    expect(turnPolicy({ mode: 'chat', sources: [], artifacts: true }).maxRounds).toBe(CHAT_TOOL_ROUNDS)
    expect(turnPolicy({ mode: 'chat', sources: ['mcp:x'], artifacts: true }).maxRounds).toBe(CHAT_TOOL_ROUNDS)
    expect(turnPolicy({ mode: 'code', sources: [], artifacts: true }).maxRounds).toBe(CODE_TOOL_ROUNDS)
    expect(turnPolicy({ mode: 'code', sources: ['mcp:x'], artifacts: true }).maxRounds).toBe(CODE_TOOL_ROUNDS)
    expect(CODE_TOOL_ROUNDS).toBeGreaterThan(CHAT_TOOL_ROUNDS)
  })

  it('takes a chat’s or a code session’s rounds from Settings when given, and the constant otherwise', () => {
    expect(turnPolicy({ mode: 'chat', sources: [], artifacts: true, chatRounds: 40 }).maxRounds).toBe(40)
    expect(turnPolicy({ mode: 'chat', sources: ['mcp:x'], artifacts: true, chatRounds: 40 }).maxRounds).toBe(40)
    expect(turnPolicy({ mode: 'chat', sources: [], artifacts: true, codeRounds: 20 }).maxRounds).toBe(CHAT_TOOL_ROUNDS)
    expect(turnPolicy({ mode: 'code', sources: [], artifacts: true, codeRounds: 20 }).maxRounds).toBe(20)
    expect(turnPolicy({ mode: 'code', sources: [], artifacts: true, chatRounds: 40 }).maxRounds).toBe(CODE_TOOL_ROUNDS)
    expect(turnPolicy({ mode: 'code', sources: [], artifacts: true, codeRounds: 20, maxToolRounds: 3 }).maxRounds).toBe(3)
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
