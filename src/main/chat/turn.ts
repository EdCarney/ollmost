// What a reply may do, by the kind of conversation it's in: a chat's reply searches, reads and runs a little, then
// answers; a code session's works in a folder for as long as the task takes (#82). The round loop in service.ts is the
// same for both; this is the setup it reads.

export type TurnMode = 'chat' | 'code'

/** Requests a chat's reply may make: searching, reading and running a little, then answering. */
export const CHAT_TOOL_ROUNDS = 20
/** Requests a code session's reply may make: reading, editing and running until the work is done. */
export const CODE_TOOL_ROUNDS = 60
/** The most requests any reply may make, whatever a setting says: the largest choice Settings offers. */
export const MAX_TOOL_ROUNDS = 100

/**
 * A round limit as a whole number from 1 to `max`, or `fallback` when it isn't a number at all. Settings aren't
 * checked over IPC, so a hand-edited value can be anything (#183): `"abc"` would run zero rounds and save an empty
 * reply, and `2.5` would never reach the tool-free last round.
 */
export function toolRounds(n: unknown, fallback: number, max = MAX_TOOL_ROUNDS): number {
  return typeof n === 'number' && Number.isFinite(n) ? Math.min(max, Math.max(1, Math.floor(n))) : fallback
}

export interface TurnPolicy {
  mode: TurnMode
  /** Requests the reply may make, the last of them without tools, so every turn ends in words. */
  maxRounds: number
  /** Whether the reply is told how to write artifacts: a chat's may be; a code session's edits files instead. */
  artifacts: boolean
}

/**
 * The policy for one reply. `artifacts` is whether the settings and the model allow them at all; `chatRounds` and
 * `codeRounds` are the Settings values for a chat and a code session (CHAT_TOOL_ROUNDS and CODE_TOOL_ROUNDS when
 * there's none).
 */
export function turnPolicy(input: {
  mode: TurnMode
  artifacts: boolean
  maxToolRounds?: number
  chatRounds?: number
  codeRounds?: number
}): TurnPolicy {
  const usual = input.mode === 'code' ? toolRounds(input.codeRounds, CODE_TOOL_ROUNDS) : toolRounds(input.chatRounds, CHAT_TOOL_ROUNDS)
  return {
    mode: input.mode,
    maxRounds: toolRounds(input.maxToolRounds, usual),
    artifacts: input.mode === 'chat' && input.artifacts
  }
}
