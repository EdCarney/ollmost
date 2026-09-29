import { mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'
import type { Skill } from '@shared/types'
import { tempDir } from './tempDir'

vi.mock('electron', () => ({ shell: {} }))
vi.mock('../src/main/settings', () => ({
  getSettings: () => ({ skills: { sources: {}, disabled: [], enabledImports: [] } }),
  updateSettings: () => undefined
}))

const { readSkillFile } = await import('../src/main/skills/library')

// A skill folder with a normal file, a symlink that escapes it, and one that stays inside.
const base = tempDir('ollmost-skill-')
const dir = join(base, 'skills', 'helper')
mkdirSync(join(dir, 'references'), { recursive: true })
writeFileSync(join(dir, 'references', 'guide.md'), 'How to help')
writeFileSync(join(base, 'secret.txt'), 'private')
symlinkSync(join(base, 'secret.txt'), join(dir, 'references', 'escape.md'))
symlinkSync(base, join(dir, 'outside'))
symlinkSync(join(dir, 'references', 'guide.md'), join(dir, 'alias.md'))
afterAll(() => rmSync(base, { recursive: true, force: true }))

const skill: Skill = {
  id: 'app:helper',
  name: 'helper',
  description: '',
  source: 'app',
  dir,
  readOnly: false,
  hasScripts: false,
  enabled: true,
  files: []
}

describe('readSkillFile', () => {
  it('reads files inside the skill', async () => {
    expect(await readSkillFile(skill, 'references/guide.md')).toBe('How to help')
  })

  it('follows symlinks that stay inside the skill', async () => {
    expect(await readSkillFile(skill, 'alias.md')).toBe('How to help')
  })

  it('refuses paths that climb out of the folder', async () => {
    await expect(readSkillFile(skill, '../../secret.txt')).rejects.toThrow(/outside the skill folder/)
  })

  it('refuses a symlink that points outside the skill', async () => {
    await expect(readSkillFile(skill, 'references/escape.md')).rejects.toThrow(/outside the skill folder/)
  })

  it('refuses a symlinked directory that leads outside the skill', async () => {
    await expect(readSkillFile(skill, 'outside/secret.txt')).rejects.toThrow(/outside the skill folder/)
  })

  it('reports a missing file clearly', async () => {
    await expect(readSkillFile(skill, 'nope.md')).rejects.toThrow(/No file "nope.md"/)
  })
})
