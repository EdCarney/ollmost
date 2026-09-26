// What a reply may do, by the kind of conversation it's in: a chat's reply searches, reads and runs a little, then
// answers; a code session's works in a folder for as long as the task takes (#82). The round loop in service.ts is the
// same for both; this is the setup it reads.

export type TurnMode = 'chat' | 'code'

/** Requests a chat reply may make: room for a search, a few page reads and a skill load. The last is tool-free. */
export const DEFAULT_TOOL_ROUNDS = 6
/** Requests a reply may make in a chat with tool sources on (MCP servers), whose tasks take more steps. */
export const TOOL_SOURCE_ROUNDS = 12
/** Requests a code session's reply may make: reading, editing and running until the work is done. */
export const CODE_TOOL_ROUNDS = 60

export interface TurnPolicy {
  mode: TurnMode
  /** Requests the reply may make, the last of them without tools, so every turn ends in words. */
  maxRounds: number
  /** Whether the reply is told how to write artifacts: a chat's may be; a code session's edits files instead. */
  artifacts: boolean
}

/** The policy for one reply. `artifacts` is whether the settings and the model allow them at all. */
export function turnPolicy(input: { mode: TurnMode; sources: readonly string[]; artifacts: boolean; maxToolRounds?: number }): TurnPolicy {
  const usual = input.mode === 'code' ? CODE_TOOL_ROUNDS : input.sources.length ? TOOL_SOURCE_ROUNDS : DEFAULT_TOOL_ROUNDS
  return {
    mode: input.mode,
    maxRounds: Math.max(1, input.maxToolRounds ?? usual),
    artifacts: input.mode === 'chat' && input.artifacts
  }
}
