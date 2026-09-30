import { ArrowUpRight, ChevronRight, Ellipsis, FolderClosed, Pencil, Pin, PinOff, Plus, Trash2 } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { SIDEBAR_PROJECT_ITEMS, sidebarProjects } from '@shared/sidebarProjects'
import type { ArtifactSummary, Project } from '@shared/types'
import { api } from '@/lib/api'
import { cn } from '@/lib/format'
import { reportError, type Route, useApp } from '@/stores/app'
import { useChat } from '@/stores/chat'
import { useExplorer } from '@/stores/explorer'
import { NewProjectDialog } from '@/views/ProjectsView'
import { ARTIFACT_META } from './ArtifactCard'
import { ConversationRow } from './ConversationMenu'
import { openArtifact, useProjectArtifacts } from './ProjectArtifacts'
import { DeleteProjectDialog, RenameProjectDialog } from './ProjectDialogs'
import { IconButton, Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from './ui'

/**
 * The sidebar's Projects section, like Claude desktop's (#128): the projects in use, each expanding to its latest chats,
 * and each chat to the artifacts made in it, with ↗ to the projects page for the rest and + for a new one.
 */
export function SidebarProjects({ go }: { go: (r: Route) => void }) {
  const { route, projects, conversations } = useApp()
  const openChat = useChat((s) => s.conversation)
  const { projectsCollapsed, toggleProjects } = useExplorer()
  const [creating, setCreating] = useState(false)

  // The project in view: open on its page, or the open chat's. It stays listed even when it isn't among the recent ones,
  // so its row doesn't vanish as one of its chats is opened from it.
  const activeChatId = route.name === 'chat' ? route.id : null
  const chatProject = (id: string) => conversations.find((c) => c.id === id)?.projectId ?? (openChat?.id === id ? openChat.projectId : null)
  const viewedProjectId = route.name === 'project' ? route.id : activeChatId ? chatProject(activeChatId) : null
  const listed = sidebarProjects(projects, conversations, viewedProjectId)
  useEffect(() => {
    if (projects.length) useExplorer.getState().prune(projects.map((p) => p.id))
  }, [projects])
  useEffect(() => {
    if (conversations.length) useExplorer.getState().pruneChats(conversations.map((c) => c.id))
  }, [conversations])

  return (
    <div data-testid="sidebar-projects">
      <div className="flex items-center gap-0.5 pb-1 pl-2.5 pr-1 pt-4">
        <button
          onClick={toggleProjects}
          aria-expanded={!projectsCollapsed}
          aria-label={projectsCollapsed ? 'Show projects' : 'Hide projects'}
          className="flex min-w-0 flex-1 items-center gap-1 text-left text-xs font-medium text-subtle hover:text-fg"
        >
          Projects
          <ChevronRight className={cn('size-3 transition-transform', !projectsCollapsed && 'rotate-90')} />
        </button>
        <IconButton label="Projects page" size="sm" className="size-6" onClick={() => go({ name: 'projects' })}>
          <ArrowUpRight className="size-3.5" />
        </IconButton>
        <IconButton label="Create a project" size="sm" className="size-6" onClick={() => setCreating(true)}>
          <Plus className="size-3.5" />
        </IconButton>
      </div>
      {!projectsCollapsed &&
        listed.map((p) => <ProjectRow key={p.id} project={p} active={p.id === viewedProjectId} activeChatId={activeChatId} go={go} />)}
      <NewProjectDialog open={creating} onOpenChange={setCreating} />
    </div>
  )
}

function ProjectRow({
  project,
  active,
  activeChatId,
  go
}: {
  project: Project
  /** Its page or one of its chats is in view. */
  active: boolean
  activeChatId: string | null
  go: (r: Route) => void
}) {
  const { conversations, loadProjects } = useApp()
  const streams = useChat((s) => s.streams)
  const { expanded, expandedChats, toggle, toggleChat } = useExplorer()
  const [renaming, setRenaming] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const open = expanded.includes(project.id)
  const chats = conversations.filter((c) => c.projectId === project.id)
  const artifacts = useProjectArtifacts(project.id, open)
  // Each chat's artifacts, latest first, as the list comes.
  const byChat = useMemo(() => {
    const out = new Map<string, ArtifactSummary[]>()
    for (const a of artifacts ?? []) out.set(a.conversationId, [...(out.get(a.conversationId) ?? []), a])
    return out
  }, [artifacts])
  const moreChats = Math.max(chats.length, project.conversationCount ?? 0) > SIDEBAR_PROJECT_ITEMS
  const openPage = () => go({ name: 'project', id: project.id })

  const pin = async () => {
    try {
      await api.projects.update(project.id, { pinned: !project.pinned })
      await loadProjects()
    } catch (err) {
      reportError(err)
    }
  }

  return (
    <div data-testid="sidebar-project">
      <div
        className={cn(
          'group flex h-8 items-center gap-1 rounded-lg pl-1.5 pr-1 text-[13px]',
          active ? 'bg-hover text-fg' : 'text-muted hover:bg-hover hover:text-fg'
        )}
      >
        <button
          onClick={() => toggle(project.id)}
          aria-label={`${open ? 'Collapse' : 'Expand'} ${project.name}`}
          aria-expanded={open}
          className="flex size-4 shrink-0 items-center justify-center rounded text-subtle hover:text-fg"
        >
          <ChevronRight className={cn('size-3.5 transition-transform', open && 'rotate-90')} />
        </button>
        <button onClick={openPage} className="flex min-w-0 flex-1 items-center gap-2 text-left">
          <FolderClosed className="size-4 shrink-0" />
          <span className="truncate">{project.name}</span>
        </button>
        <Menu>
          <MenuTrigger asChild>
            <button
              aria-label={`${project.name} options`}
              className={cn(
                'flex size-6 shrink-0 items-center justify-center rounded-md text-muted hover:bg-hover hover:text-fg data-[state=open]:flex',
                active ? 'flex' : 'hidden group-hover:flex'
              )}
            >
              <Ellipsis className="size-4" />
            </button>
          </MenuTrigger>
          <MenuContent align="start">
            <MenuItem icon={project.pinned ? <PinOff className="size-4" /> : <Pin className="size-4" />} onSelect={() => void pin()}>
              {project.pinned ? 'Unpin' : 'Pin'}
            </MenuItem>
            <MenuItem icon={<Pencil className="size-4" />} onSelect={() => setRenaming(true)}>
              Rename
            </MenuItem>
            <MenuSeparator />
            <MenuItem danger icon={<Trash2 className="size-4 text-danger" />} onSelect={() => setDeleting(true)}>
              Delete
            </MenuItem>
          </MenuContent>
        </Menu>
      </div>
      {open && (
        <div className="pl-4" data-testid="sidebar-project-items">
          {chats.slice(0, SIDEBAR_PROJECT_ITEMS).map((c) => {
            const own = byChat.get(c.id) ?? []
            const chatOpen = own.length > 0 && expandedChats.includes(c.id)
            return (
              <div key={c.id} data-testid="sidebar-chat">
                <ConversationRow
                  conversation={c}
                  active={c.id === activeChatId}
                  streaming={!!streams[c.id]}
                  waiting={!!streams[c.id]?.toolEvents.some((e) => e?.awaiting)}
                  onOpen={() => go({ name: 'chat', id: c.id })}
                  expand={own.length ? { open: chatOpen, onToggle: () => toggleChat(c.id) } : null}
                />
                {chatOpen && (
                  <div className="pl-4">
                    {own.slice(0, SIDEBAR_PROJECT_ITEMS).map((a) => (
                      <ArtifactRow key={a.id} artifact={a} />
                    ))}
                    {own.length > SIDEBAR_PROJECT_ITEMS && <ShowAll onClick={openPage}>Show all artifacts</ShowAll>}
                  </div>
                )}
              </div>
            )
          })}
          {moreChats && <ShowAll onClick={openPage}>Show all chats</ShowAll>}
          {!chats.length && <div className="py-1 pl-2.5 text-xs text-subtle">No chats yet</div>}
        </div>
      )}
      <RenameProjectDialog project={project} open={renaming} onOpenChange={setRenaming} />
      <DeleteProjectDialog project={project} open={deleting} onOpenChange={setDeleting} />
    </div>
  )
}

function ArtifactRow({ artifact }: { artifact: ArtifactSummary }) {
  const Icon = ARTIFACT_META[artifact.type].icon
  return (
    <button
      data-testid="sidebar-artifact"
      onClick={() => openArtifact(artifact)}
      className="flex h-8 w-full items-center gap-2 rounded-lg pl-2.5 pr-1 text-left text-[13px] text-muted hover:bg-hover hover:text-fg"
    >
      <Icon className="size-3.5 shrink-0" />
      <span className="truncate">{artifact.title}</span>
    </button>
  )
}

function ShowAll({ onClick, children }: { onClick: () => void; children: string }) {
  return (
    <button
      onClick={onClick}
      className="flex h-7 w-full items-center rounded-lg pl-2.5 text-left text-xs text-subtle hover:bg-hover hover:text-fg"
    >
      {children}
    </button>
  )
}
