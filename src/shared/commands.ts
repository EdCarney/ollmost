// Slash commands: actions that run once when sent, unlike skills (instructions applied to every reply). Typed as
// "/name arguments" in the composer; the picker lists them apart from skills.

export interface Command {
  name: string
  description: string
  /** What may follow the name, shown in the picker: "[what to keep]". */
  hint: string
}

export const COMMANDS: readonly Command[] = [
  {
    name: 'compact',
    description: 'Summarize the whole chat so later replies replay the summary instead; the messages stay',
    hint: '[what to keep]'
  }
]

/** The command a composer's text is, with what followed its name, or null for anything that isn't one. */
export function parseCommand(text: string): { name: string; args: string } | null {
  const m = /^\s*\/([a-z][\w-]*)(?:\s+([\s\S]*))?$/i.exec(text)
  if (!m) return null
  const name = m[1].toLowerCase()
  if (!COMMANDS.some((c) => c.name === name)) return null
  return { name, args: (m[2] ?? '').trim().replace(/\s+/g, ' ') }
}
