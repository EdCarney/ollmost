import type { ToolDef } from '../providers/types'
import { findSkillByName, getSkill, readSkillFile } from '../skills/library'
import type { RunContext, ToolProvider } from './tools'

export const SKILL_TOOLS: ToolDef[] = [
  {
    type: 'function',
    function: {
      name: 'load_skill',
      description:
        'Load the full instructions of a skill from the available skills list. Call this before starting a task that matches a skill description.',
      parameters: {
        type: 'object',
        properties: { name: { type: 'string', description: 'The exact skill name from the list' } },
        required: ['name']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'read_skill_file',
      description: 'Read a supporting file (reference, template, example) that belongs to a loaded skill.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'The skill name' },
          path: { type: 'string', description: 'Path of the file inside the skill folder, e.g. references/guide.md' }
        },
        required: ['name', 'path']
      }
    }
  }
]

/**
 * How a skill's scripts run from here, by what the reply can run: a code session has run_command (never run_code,
 * which is the chat's code runner), not offered in plan mode; a chat has run_code when the code runner is on (#144).
 */
function scriptsHint(dir: string, ctx: RunContext): string {
  const example = `python "${dir}/scripts/<script>" <arguments>`
  if (ctx.mode === 'code')
    return ctx.stage === 'plan'
      ? `[This skill's files are in ${dir}. Its scripts run with run_command, which is not offered in plan mode: once the user starts working, run one with the script's full path, for example: ${example}. Until then, say what the script would do rather than claiming to have run it.]`
      : `[This skill's files are in ${dir}. To run one of its scripts, call run_command with the script's full path, for example: ${example}. Write output files to the session's folder, not the skill's.]`
  return ctx.grants.has('code')
    ? `[This skill's files are in ${dir}. To run one of its scripts, call run_code with language "bash" and a command using the script's full path, for example: ${example}. Write output files to the current folder, not the skill's.]`
    : '[This app cannot execute scripts. Where the skill says to run one, produce the result directly instead.]'
}

/** load_skill and read_skill_file, offered when there are skills the model may load itself. */
export const skillTools: ToolProvider = {
  id: 'skills',
  tools: (ctx) => (ctx.skills ? SKILL_TOOLS : []),
  pending: ({ name, args }) => ({ tool: name, args, ok: true, pending: true, summary: String(args.name ?? '') }),
  // They only read the skills the user installed.
  approval: () => 'auto',
  // A skill's instructions cut to a round's share would be followed half-read, and loading it again gives the same cut.
  wholeResults: true,
  run: async ({ name, args }, ctx) => {
    const skillName = String(args.name ?? '')
    const skill = await findSkillByName(skillName)
    if (!skill) throw new Error(`No enabled skill named "${skillName}"`)
    if (name === 'read_skill_file') {
      const path = String(args.path ?? '')
      return { content: await readSkillFile(skill, path), event: { tool: name, args, ok: true, summary: `${skill.name}/${path}` } }
    }
    const detail = (await getSkill(skill.id))!
    const extra = skill.files.length ? `\n\nSupporting files: ${skill.files.slice(0, 40).join(', ')}` : ''
    const scripts = !skill.hasScripts ? '' : `\n\n${scriptsHint(skill.dir, ctx)}`
    return {
      content: `${detail.body}${extra}${scripts}`,
      event: { tool: name, args, ok: true, summary: skill.name },
      loadedSkillId: skill.id
    }
  }
}
