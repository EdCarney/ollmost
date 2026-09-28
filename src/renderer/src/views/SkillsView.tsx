import { Copy, FolderOpen, Plus, Search, Sparkles, Trash2 } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import type { Skill, SkillDetail, SkillSource } from '@shared/types'
import { Markdown } from '@/components/Markdown'
import { TopBar } from '@/components/TopBar'
import { Badge, Button, chosenOption, EmptyState, Field, Modal, Spinner, Switch, TextArea, TextField, Tooltip } from '@/components/ui'
import { api } from '@/lib/api'
import { cn } from '@/lib/format'
import { reportError, useApp } from '@/stores/app'

const SOURCE_LABEL: Record<SkillSource, string> = {
  app: 'Your skills',
  ollama: 'From Ollama (~/.ollama/skills)',
  claude: 'From Claude (~/.claude/skills)'
}

const TEMPLATE = `# Skill title

Describe the workflow the model should follow when this skill applies.

## Steps
1. …
2. …

## Output
Describe the format of the result.`

type Draft = { id?: string; name: string; description: string; body: string }

export function SkillsView({ selectedId }: { selectedId?: string }) {
  const { skills, loadSkills, navigate, toast } = useApp()
  const [query, setQuery] = useState('')
  const [detail, setDetail] = useState<SkillDetail | null>(null)
  const [draft, setDraft] = useState<Draft | null>(null)
  const [saving, setSaving] = useState(false)
  const [deleting, setDeleting] = useState(false)

  const selected = skills.find((s) => s.id === selectedId) ?? null

  useEffect(() => {
    setDraft(null)
    if (!selectedId) return setDetail(null)
    void api.skills.get(selectedId).then(setDetail)
  }, [selectedId, skills])

  const groups = useMemo(() => {
    const q = query.toLowerCase()
    const filtered = skills.filter((s) => s.name.includes(q) || s.description.toLowerCase().includes(q))
    return (['app', 'ollama', 'claude'] as SkillSource[])
      .map((source) => ({ source, items: filtered.filter((s) => s.source === source) }))
      .filter((g) => g.items.length)
  }, [skills, query])

  const select = (s: Skill) => navigate({ name: 'skills', id: s.id })

  const save = async () => {
    if (!draft) return
    setSaving(true)
    try {
      const skill = await api.skills.save(draft)
      await loadSkills()
      setDraft(null)
      navigate({ name: 'skills', id: skill.id })
      toast('Skill saved')
    } catch (err) {
      reportError(err)
    } finally {
      setSaving(false)
    }
  }

  const duplicate = async (id: string) => {
    try {
      const copy = await api.skills.duplicate(id)
      await loadSkills()
      navigate({ name: 'skills', id: copy.id })
      toast(`Copied to your skills as “${copy.name}”`)
    } catch (err) {
      reportError(err)
    }
  }

  return (
    <div className="flex h-full flex-col">
      <TopBar />
      <div className="flex min-h-0 flex-1">
        <div className="flex w-80 shrink-0 flex-col border-r border-line">
          <div className="flex items-center justify-between px-4 pb-3 pt-2">
            <h1 className="font-reading text-2xl font-medium tracking-tight">Skills</h1>
            <Button size="sm" variant="primary" onClick={() => setDraft({ name: '', description: '', body: TEMPLATE })}>
              <Plus className="size-3.5" /> New
            </Button>
          </div>
          <div className="relative px-4 pb-3">
            <Search className="absolute left-7 top-1/2 size-4 -translate-y-[70%] text-subtle" />
            <TextField value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search skills" className="pl-9" />
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-4">
            {groups.map((g) => (
              <div key={g.source} className="mb-3">
                <div className="px-2.5 pb-1 pt-2 text-xs font-medium text-subtle">{SOURCE_LABEL[g.source]}</div>
                {g.items.map((s) => (
                  <div
                    key={s.id}
                    role="button"
                    tabIndex={0}
                    onClick={() => select(s)}
                    onKeyDown={(e) => e.key === 'Enter' && select(s)}
                    className={cn('flex items-start gap-2 rounded-lg px-2.5 py-2', s.id === selectedId ? 'bg-hover' : 'hover:bg-hover')}
                  >
                    <Sparkles className={cn('mt-0.5 size-4 shrink-0', s.enabled ? 'text-accent' : 'text-subtle')} />
                    <div className="min-w-0 flex-1">
                      <div className={cn('truncate text-[13px] font-medium', !s.enabled && 'text-subtle')}>{s.name}</div>
                      <div className="line-clamp-2 text-xs text-subtle">{s.description}</div>
                    </div>
                    <span onClick={(e) => e.stopPropagation()} className="mt-0.5">
                      <Switch
                        label={`Enable ${s.name}`}
                        checked={s.enabled}
                        onChange={async (on) => {
                          await api.skills.setEnabled(s.id, on).catch(reportError)
                          await loadSkills()
                        }}
                      />
                    </span>
                  </div>
                ))}
              </div>
            ))}
            {!skills.length && (
              <p className="px-3 py-6 text-sm text-subtle">No skills yet. Create one, or add SKILL.md folders to ~/.ollama/skills.</p>
            )}
          </div>
          <div className="border-t border-line p-2">
            <Button size="sm" variant="ghost" className="w-full justify-start" onClick={() => api.skills.reveal(null)}>
              <FolderOpen className="size-4" /> Open skills folder
            </Button>
          </div>
        </div>

        <div className="min-w-0 flex-1 overflow-y-auto">
          {draft ? (
            <SkillEditor draft={draft} onChange={setDraft} onCancel={() => setDraft(null)} onSave={save} saving={saving} />
          ) : selected && detail ? (
            <div className="mx-auto max-w-3xl px-8 py-6">
              <div className="mb-4 flex items-start justify-between gap-4">
                <div className="min-w-0">
                  <h2 className="font-mono text-xl font-semibold">{detail.name}</h2>
                  <p className="mt-1 text-sm text-muted">{detail.description}</p>
                  <div className="mt-3 flex flex-wrap gap-1.5">
                    <Badge>{SOURCE_LABEL[detail.source]}</Badge>
                    {detail.readOnly && <Badge>Read-only</Badge>}
                    {detail.hasScripts && (
                      <Tooltip content="Ollmost can't run a skill's scripts. The model gets the instructions and is told to produce the result directly.">
                        <span>
                          <Badge tone="warn">Has scripts · instructions only</Badge>
                        </span>
                      </Tooltip>
                    )}
                    {detail.files.length > 0 && <Badge>{detail.files.length} supporting files</Badge>}
                  </div>
                </div>
                <div className="flex shrink-0 gap-2">
                  <Button size="sm" onClick={() => api.skills.reveal(detail.id)}>
                    <FolderOpen className="size-3.5" /> Show
                  </Button>
                  {detail.readOnly ? (
                    <Button size="sm" variant="primary" onClick={() => duplicate(detail.id)}>
                      <Copy className="size-3.5" /> Duplicate to edit
                    </Button>
                  ) : (
                    <>
                      <Button
                        size="sm"
                        onClick={() => setDraft({ id: detail.id, name: detail.name, description: detail.description, body: detail.body })}
                      >
                        Edit
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => setDeleting(true)} aria-label="Delete skill">
                        <Trash2 className="size-3.5" />
                      </Button>
                    </>
                  )}
                </div>
              </div>
              <div className="rounded-ollmost-lg border border-line bg-panel p-6">
                <Markdown text={detail.body} conversationId={null} />
              </div>
              {detail.files.length > 0 && (
                <div className="mt-4 text-xs text-subtle">
                  Supporting files the model can read: {detail.files.slice(0, 20).join(', ')}
                  {detail.files.length > 20 && ` and ${detail.files.length - 20} more`}
                </div>
              )}
            </div>
          ) : selectedId ? (
            <div className="flex h-full items-center justify-center">
              <Spinner />
            </div>
          ) : (
            <EmptyState icon={<Sparkles className="size-5" />} title="Teach the model a workflow">
              Skills are reusable instructions. Turn one on in a chat with the + menu or by typing /, or let models that support tools load
              them automatically when a task matches.
            </EmptyState>
          )}
        </div>
      </div>

      <Modal
        open={deleting}
        onOpenChange={setDeleting}
        title="Delete skill?"
        description="The skill folder will be moved to the Trash."
        footer={
          <>
            <Button variant="ghost" onClick={() => setDeleting(false)}>
              Cancel
            </Button>
            <Button
              variant="danger"
              onClick={async () => {
                if (!detail) return
                try {
                  await api.skills.delete(detail.id)
                  await loadSkills()
                  setDeleting(false)
                  navigate({ name: 'skills' })
                } catch (err) {
                  reportError(err)
                }
              }}
            >
              Delete
            </Button>
          </>
        }
      />
    </div>
  )
}

function SkillEditor({
  draft,
  onChange,
  onCancel,
  onSave,
  saving
}: {
  draft: Draft
  onChange: (d: Draft) => void
  onCancel: () => void
  onSave: () => void
  saving: boolean
}) {
  const [preview, setPreview] = useState(false)
  const nameOk = /^[a-z0-9]+(-[a-z0-9]+)*$/.test(draft.name)
  return (
    <div className="mx-auto flex h-full max-w-3xl flex-col px-8 py-6">
      <h2 className="mb-4 text-lg font-semibold">{draft.id ? 'Edit skill' : 'New skill'}</h2>
      <div className="space-y-4">
        <Field
          label="Name"
          hint={
            draft.name && !nameOk
              ? 'Use lowercase letters, numbers and single hyphens.'
              : 'Lowercase with hyphens, e.g. weekly-report. You can type /name in a chat to use it.'
          }
        >
          <TextField
            value={draft.name}
            onChange={(e) => onChange({ ...draft, name: e.target.value.toLowerCase().replace(/\s+/g, '-') })}
            placeholder="my-skill"
            className="font-mono"
          />
        </Field>
        <Field label="Description" hint="Say what the skill does and when to use it. Models read this to decide when to load the skill.">
          <TextArea
            rows={2}
            value={draft.description}
            onChange={(e) => onChange({ ...draft, description: e.target.value })}
            placeholder="Draft release notes from a list of changes. Use when the user asks for a changelog or release notes."
          />
        </Field>
      </div>
      <div className="mt-4 flex min-h-0 flex-1 flex-col">
        <div className="mb-1.5 flex items-center justify-between">
          <span className="text-sm font-medium">Instructions</span>
          <div className="flex rounded-lg bg-hover p-0.5 text-xs">
            {['Write', 'Preview'].map((t) => (
              <button
                key={t}
                onClick={() => setPreview(t === 'Preview')}
                className={cn('rounded-md px-2.5 py-1', preview === (t === 'Preview') ? chosenOption : 'text-muted')}
              >
                {t}
              </button>
            ))}
          </div>
        </div>
        {preview ? (
          <div className="min-h-[320px] flex-1 overflow-y-auto rounded-ollmost border border-line bg-panel p-5">
            <Markdown text={draft.body} conversationId={null} />
          </div>
        ) : (
          <TextArea
            value={draft.body}
            onChange={(e) => onChange({ ...draft, body: e.target.value })}
            className="min-h-[320px] flex-1 font-mono text-[13px]"
          />
        )}
      </div>
      <div className="mt-4 flex justify-end gap-2">
        <Button variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button variant="primary" loading={saving} disabled={!nameOk || !draft.description.trim()} onClick={onSave}>
          Save skill
        </Button>
      </div>
    </div>
  )
}
