import { useEffect, useState } from 'react'
import type { Project } from '@shared/types'
import { api } from '@/lib/api'
import { reportError, useApp } from '@/stores/app'
import { useArtifactPanel } from '@/stores/artifactPanel'
import { useChat } from '@/stores/chat'
import { useDrafts } from '@/stores/drafts'
import { Button, Modal, TextField } from './ui'

/** Renames a project, from its row's menu in the sidebar. */
export function RenameProjectDialog({
  project,
  open,
  onOpenChange
}: {
  project: Project
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const loadProjects = useApp((s) => s.loadProjects)
  const [name, setName] = useState(project.name)
  useEffect(() => {
    if (open) setName(project.name)
  }, [open, project.name])

  const save = async () => {
    if (!name.trim()) return
    try {
      await api.projects.update(project.id, { name: name.trim() })
      await loadProjects()
      onOpenChange(false)
    } catch (err) {
      reportError(err)
    }
  }

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title="Rename project"
      footer={
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button variant="primary" disabled={!name.trim()} onClick={save}>
            Save
          </Button>
        </>
      }
    >
      <form
        onSubmit={(e) => {
          e.preventDefault()
          void save()
        }}
      >
        <TextField autoFocus value={name} onChange={(e) => setName(e.target.value)} />
      </form>
    </Modal>
  )
}

/** Asks before deleting a project (#127), then leaves its page or its chat if either is open. */
export function DeleteProjectDialog({
  project,
  open,
  onOpenChange
}: {
  project: Project
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const conversations = useApp((s) => s.conversations)
  const chats = conversations.filter((c) => c.projectId === project.id)
  const count = project.conversationCount ?? chats.length

  const remove = async () => {
    try {
      await api.projects.delete(project.id)
      useDrafts.getState().discard([`project:${project.id}`, ...chats.map((c) => c.id)])
      const app = useApp.getState()
      await Promise.all([app.loadProjects(), app.loadConversations()])
      onOpenChange(false)
      const { route } = useApp.getState()
      const inChat =
        route.name === 'chat' && (chats.some((c) => c.id === route.id) || useChat.getState().conversation?.projectId === project.id)
      if ((route.name === 'project' && route.id === project.id) || inChat) {
        useArtifactPanel.getState().close()
        if (inChat) useChat.getState().clear()
        app.navigate({ name: 'projects' })
      }
    } catch (err) {
      reportError(err)
    }
  }

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title="Delete project?"
      description={`“${project.name}”, its ${count} ${count === 1 ? 'chat' : 'chats'} and its knowledge files will be permanently deleted.`}
      footer={
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button variant="danger" onClick={remove}>
            Delete project
          </Button>
        </>
      }
    />
  )
}
