import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

// Every model call goes through providers/registry.ts. The reply loop, sub-agents, titles, /compact and replay never
// reach an adapter themselves, so a second kind of server needs no change to them.
const CALLERS = ['src/main/chat', 'src/main/debug', 'src/main/code', 'src/main/runner', 'src/main/mcp', 'src/main/skills']
// Single files that sit beside those folders: the IPC handlers reach models only through the registry too.
const CALLER_FILES = ['src/main/ipc.ts']
const LOOP = ['chat/rounds.ts', 'chat/delegate.ts', 'chat/assemble.ts', 'chat/service.ts', 'debug/replay.ts', 'debug/traces.ts'].map(
  (f) => `src/main/${f}`
)

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? sources(join(dir, e.name)) : e.name.endsWith('.ts') ? [join(dir, e.name)] : []
  )
}

describe('the provider seam', () => {
  it('keeps the reply loop and its callers off the Ollama adapter', () => {
    // Any import of an adapter file: `from '…'`, a bare `import '…'` or a dynamic import().
    const reaching = [...CALLERS.flatMap(sources), ...CALLER_FILES].filter((file) =>
      /'(\.\.?\/)+providers\/ollama\//.test(readFileSync(file, 'utf8'))
    )
    expect(reaching).toEqual([])
  })

  it('leaves no Ollama wire name in the loop', () => {
    const wire = /\b(ChatBody|ChatChunk|OllamaMessage|OllamaToolCall|tool_calls|tool_name|eval_count|prompt_eval_count|eval_duration)\b/
    expect(LOOP.filter((file) => wire.test(readFileSync(file, 'utf8')))).toEqual([])
  })
})
