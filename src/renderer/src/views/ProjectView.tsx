import { ChevronLeft, Ellipsis, FileText, Pencil, Pin, Plus, Trash2, X } from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import type { ProjectFile } from '@shared/types'
import { Composer } from '@/components/Composer'
import { ConversationMenu } from '@/components/ConversationMenu'
import { TopBar } from '@/components/TopBar'
import { Button, Field, IconButton, Menu, MenuContent, MenuItem, MenuTrigger, Modal, Spinner, TextArea, TextField } from '@/components/ui'
import { api } from '@/lib/api'
import { sendMessage } from '@/lib/chatActions'
import { cn, displayModelName, formatBytes, formatTokens, relativeTime } from '@/lib/format'
import { contextWindowFor, findModel, reportError, useApp } from '@/stores/app'
import { useDrafts } from '@/stores/drafts'

export function ProjectView({ id }: { id: string }) {
  const { projects, conversations, loadProjects, loadConversations, navigate, models, draftModel, projectFilesVersion, touchProjectFiles } =
    useApp()
  const project = projects.find((p) => p.id === id)
  const [files, setFiles] = useState<ProjectFile[]>([])
  const [uploading, setUploading] = useState(false)
  const [editing, setEditing] = useState<'details' | 'instructions' | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [draft, setDraft] = useState({ name: '', description: '', instructions: '' })

  const loadFiles = useCallback(() => api.projects.files(id).then(setFiles), [id])
  // Reloaded when the sidebar's explorer changes the files too.
  useEffect(() => {
    void loadFiles()
  }, [loadFiles, projectFilesVersion])

  if (!project)
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner />
      </div>
    )

  const chats = conversations.filter((c) => c.projectId === id)
  const knowledgeTokens = files.reduce((n, f) => n + f.tokenEstimate, 0)
  const model = findModel(models, draftModel)
  const capacity = contextWindowFor(model)
  const usage = capacity ? knowledgeTokens / capacity : 0

  const save = async (patch: Parameters<typeof api.projects.update>[1]) => {
    try {
      await api.projects.update(id, patch)
      await loadProjects()
      setEditing(null)
    } catch (err) {
      reportError(err)
    }
  }

  const addFiles = async () => {
    const sources = await api.attachments.pick()
    if (!sources.length) return
    setUploading(true)
    try {
      const { errors } = await api.projects.addFiles(id, sources)
      errors.forEach(reportError)
      await loadProjects()
      touchProjectFiles() // reloads the list here and in the explorer
    } catch (err) {
      reportError(err)
    } finally {
      setUploading(false)
    }
  }

  return (
    <div className="flex h-full flex-col">
      <TopBar>
        <button
          onClick={() => navigate({ name: 'projects' })}
          className="flex items-center gap-1 rounded-md px-1.5 py-1 text-[13px] text-muted hover:bg-hover hover:text-fg"
        >
          <ChevronLeft className="size-4" /> All projects
        </button>
      </TopBar>
      <div className="flex min-h-0 flex-1 gap-8 overflow-y-auto px-8 pb-10 pt-4">
        <div className="mx-auto min-w-0 max-w-3xl flex-1">
          <div className="mb-6 flex items-start justify-between gap-4">
            <div className="min-w-0">
              <h1 className="font-reading text-[28px] font-medium tracking-tight">{project.name}</h1>
              {project.description && <p className="mt-1 text-sm text-muted">{project.description}</p>}
            </div>
            <div className="flex shrink-0 items-center gap-1">
              <IconButton
                label={project.pinned ? 'Unpin' : 'Pin'}
                active={project.pinned}
                onClick={() => save({ pinned: !project.pinned })}
              >
                <Pin className={cn('size-4', project.pinned && 'fill-current text-accent')} />
              </IconButton>
              <Menu>
                <MenuTrigger asChild>
                  <button
                    aria-label="Project options"
                    className="flex size-8 items-center justify-center rounded-lg text-muted hover:bg-hover hover:text-fg"
                  >
                    <Ellipsis className="size-4" />
                  </button>
                </MenuTrigger>
                <MenuContent align="end">
                  <MenuItem
                    icon={<Pencil className="size-4" />}
                    onSelect={() => {
                      setDraft({ name: project.name, description: project.description, instructions: project.instructions })
                      setEditing('details')
                    }}
                  >
                    Edit details
                  </MenuItem>
                  <MenuItem danger icon={<Trash2 className="size-4 text-danger" />} onSelect={() => setDeleting(true)}>
                    Delete project
                  </MenuItem>
                </MenuContent>
              </Menu>
            </div>
          </div>

          <Composer
            conversation={null}
            draftKey={`project:${id}`}
            streaming={false}
            placeholder={`Start a chat in ${project.name}…`}
            onSubmit={(input) => sendMessage(null, id, input)}
          />

          <div className="mt-8">
            {chats.length ? (
              <ul className="divide-y divide-line">
                {chats.map((c) => (
                  <li key={c.id} className="group flex items-center gap-2 rounded-lg px-3 py-3 hover:bg-hover">
                    <button onClick={() => navigate({ name: 'chat', id: c.id })} className="min-w-0 flex-1 text-left">
                      <div className="truncate text-sm font-medium">{c.title}</div>
                      <div className="mt-0.5 text-xs text-subtle">Last message {relativeTime(c.updatedAt)}</div>
                    </button>
                    <span className="opacity-0 group-hover:opacity-100 has-[[data-state=open]]:opacity-100">
                      <ConversationMenu conversation={c} align="end" />
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="px-3 text-sm text-subtle">Chats you start in this project will show up here.</p>
            )}
          </div>
        </div>

        <aside className="w-80 shrink-0 space-y-4">
          <section className="rounded-ollmost-lg border border-line bg-panel p-4">
            <div className="mb-2 flex items-center justify-between">
              <h2 className="text-sm font-medium">Instructions</h2>
              <IconButton
                label="Edit instructions"
                size="sm"
                onClick={() => {
                  setDraft({ name: project.name, description: project.description, instructions: project.instructions })
                  setEditing('instructions')
                }}
              >
                <Pencil className="size-3.5" />
              </IconButton>
            </div>
            <p className="line-clamp-6 whitespace-pre-wrap text-[13px] text-muted">
              {project.instructions || 'Add instructions to tailor how the model responds in this project.'}
            </p>
          </section>

          <section className="rounded-ollmost-lg border border-line bg-panel p-4">
            <div className="mb-2 flex items-center justify-between">
              <h2 className="text-sm font-medium">Knowledge</h2>
              <IconButton label="Add files" size="sm" onClick={addFiles} disabled={uploading}>
                {uploading ? <Spinner className="size-3.5" /> : <Plus className="size-4" />}
              </IconButton>
            </div>
            {files.length > 0 && (
              <div className="mb-3">
                <div className="h-1.5 overflow-hidden rounded-full bg-hover">
                  <div
                    className={cn('h-full rounded-full', usage > 0.8 ? 'bg-danger' : 'bg-accent')}
                    style={{ width: `${Math.min(100, Math.max(2, usage * 100))}%` }}
                  />
                </div>
                <div className="mt-1.5 text-xs text-subtle">
                  {capacity
                    ? `${Math.round(usage * 100)}% of ${displayModelName(draftModel)}'s context (${formatTokens(knowledgeTokens)} tokens)`
                    : `${formatTokens(knowledgeTokens)} tokens`}
                </div>
                {usage > 0.8 && (
                  <div className="mt-1 text-xs text-danger">Near the context limit: older chat history will be trimmed to fit.</div>
                )}
              </div>
            )}
            {files.length ? (
              <ul className="space-y-1">
                {[...files]
                  .sort((a, b) => a.folder.localeCompare(b.folder) || a.name.localeCompare(b.name))
                  .map((f) => (
                    <li key={f.id} className="group flex items-center gap-2 rounded-lg px-1.5 py-1.5 hover:bg-hover">
                      <FileText className="size-4 shrink-0 text-muted" />
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-[13px]">
                          {f.folder && <span className="text-subtle">{f.folder}/</span>}
                          {f.name}
                        </div>
                        <div className="text-[11px] text-subtle">
                          {formatBytes(f.size)} · {f.tokenEstimate ? `${formatTokens(f.tokenEstimate)} tokens` : 'no text found'}
                        </div>
                      </div>
                      <button
                        aria-label={`Remove ${f.name}`}
                        onClick={async () => {
                          await api.projects.removeFile(f.id).catch(reportError)
                          touchProjectFiles()
                        }}
                        className="hidden rounded p-1 text-subtle hover:text-fg group-hover:block"
                      >
                        <X className="size-3.5" />
                      </button>
                    </li>
                  ))}
              </ul>
            ) : (
              <p className="text-[13px] text-muted">
                Add PDFs, documents, spreadsheets or text files. Every chat in this project can use them.
              </p>
            )}
          </section>
        </aside>
      </div>

      <Modal
        open={editing === 'instructions'}
        onOpenChange={(o) => !o && setEditing(null)}
        title="Project instructions"
        description="The model follows these in every chat in this project."
        wide
        footer={
          <>
            <Button variant="ghost" onClick={() => setEditing(null)}>
              Cancel
            </Button>
            <Button variant="primary" onClick={() => save({ instructions: draft.instructions })}>
              Save instructions
            </Button>
          </>
        }
      >
        <TextArea
          autoFocus
          rows={14}
          value={draft.instructions}
          onChange={(e) => setDraft({ ...draft, instructions: e.target.value })}
          placeholder="e.g. Answer as a senior data engineer. Prefer Python and SQL examples. Keep answers under 300 words unless asked."
        />
      </Modal>

      <Modal
        open={editing === 'details'}
        onOpenChange={(o) => !o && setEditing(null)}
        title="Edit project"
        footer={
          <>
            <Button variant="ghost" onClick={() => setEditing(null)}>
              Cancel
            </Button>
            <Button
              variant="primary"
              disabled={!draft.name.trim()}
              onClick={() => save({ name: draft.name, description: draft.description })}
            >
              Save
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <Field label="Name">
            <TextField value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
          </Field>
          <Field label="Description">
            <TextArea rows={3} value={draft.description} onChange={(e) => setDraft({ ...draft, description: e.target.value })} />
          </Field>
        </div>
      </Modal>

      <Modal
        open={deleting}
        onOpenChange={setDeleting}
        title="Delete project?"
        description={`“${project.name}”, its ${chats.length} chats and its knowledge files will be permanently deleted.`}
        footer={
          <>
            <Button variant="ghost" onClick={() => setDeleting(false)}>
              Cancel
            </Button>
            <Button
              variant="danger"
              onClick={async () => {
                try {
                  await api.projects.delete(id)
                  useDrafts.getState().discard([`project:${id}`, ...chats.map((c) => c.id)])
                  await Promise.all([loadProjects(), loadConversations()])
                  navigate({ name: 'projects' })
                } catch (err) {
                  reportError(err)
                }
              }}
            >
              Delete project
            </Button>
          </>
        }
      />
    </div>
  )
}
