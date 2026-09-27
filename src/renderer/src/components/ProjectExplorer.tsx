import { ChevronRight, FileText, FolderClosed, FolderOpen, FolderPlus, MoreHorizontal } from 'lucide-react'
import { type DragEvent, type KeyboardEvent, useCallback, useEffect, useMemo, useState } from 'react'
import { buildTree, folderAfterRemoving, normalizeFolder, type TreeNode } from '@shared/fileTree'
import type { Project, ProjectFile } from '@shared/types'
import { api } from '@/lib/api'
import { cn } from '@/lib/format'
import { toSources } from '@/lib/sources'
import { reportError, useApp } from '@/stores/app'
import { useChat } from '@/stores/chat'
import { useExplorer } from '@/stores/explorer'
import { ConversationRow } from './ConversationMenu'
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuSub, MenuTrigger } from './ui'

/** The projects in the sidebar: each one a tree of its files' folders, then its chats. */
export function ProjectExplorer({ project }: { project: Project }) {
  const { route, navigate, conversations, projectFilesVersion, touchProjectFiles } = useApp()
  const streams = useChat((s) => s.streams)
  const { expanded, emptyFolders, toggle: toggleKey, rememberFolder: rememberKey, forgetFolder: forgetKey } = useExplorer()
  const [files, setFiles] = useState<ProjectFile[] | null>(null)
  const [naming, setNaming] = useState<{ parent: string; name: string } | null>(null)
  const [over, setOver] = useState<string | null>(null)

  const key = (folder: string) => (folder ? `${project.id}/${folder}` : project.id)
  const isOpen = (folder: string) => expanded.includes(key(folder))
  const toggle = (folder: string) => toggleKey(key(folder))
  const open = isOpen('')

  const load = useCallback(() => api.projects.files(project.id).then(setFiles).catch(reportError), [project.id])
  useEffect(() => {
    if (open) void load()
  }, [open, load, projectFilesVersion])

  const extra = useMemo(() => emptyFolders[project.id] ?? [], [emptyFolders, project.id])
  const tree = useMemo(() => buildTree(files ?? [], extra), [files, extra])
  const folders = useMemo(() => {
    const out: string[] = []
    const walk = (nodes: TreeNode<ProjectFile>[]) => {
      for (const n of nodes)
        if (n.kind === 'folder') {
          out.push(n.path)
          walk(n.children)
        }
    }
    walk(tree)
    return out
  }, [tree])
  const chats = conversations.filter((c) => c.projectId === project.id)

  const rememberFolder = (folder: string) => rememberKey(project.id, folder)
  const forgetFolder = (folder: string) => forgetKey(project.id, folder)
  const preview = (file: ProjectFile) => void api.projects.openFile(file.id).catch(reportError)

  const addTo = async (folder: string, sources = null as Awaited<ReturnType<typeof toSources>> | null) => {
    try {
      const picked = sources ?? (await api.attachments.pick())
      if (!picked.length) return
      const { errors } = await api.projects.addFiles(project.id, picked, folder)
      errors.forEach(reportError)
      // Show where they landed.
      if (!open) toggle('')
      if (folder && !isOpen(folder)) toggle(folder)
      touchProjectFiles()
    } catch (err) {
      reportError(err)
    }
  }
  const move = async (file: ProjectFile, folder: string) => {
    try {
      await api.projects.moveFile(file.id, folder)
      touchProjectFiles()
    } catch (err) {
      reportError(err)
    }
  }
  const remove = async (file: ProjectFile) => {
    try {
      await api.projects.removeFile(file.id)
      touchProjectFiles()
    } catch (err) {
      reportError(err)
    }
  }
  const removeFolder = async (folder: string) => {
    // A folder is its files' paths: removing it moves them (one at a time) up into its parent and forgets it if it was empty.
    try {
      for (const f of files ?? []) {
        const to = folderAfterRemoving(folder, f.folder)
        if (to !== f.folder) await api.projects.moveFile(f.id, to)
      }
      forgetFolder(folder)
      touchProjectFiles()
    } catch (err) {
      reportError(err)
    }
  }

  const dropProps = (folder: string) => ({
    onDragOver: (e: DragEvent) => {
      if (!e.dataTransfer.types.includes('Files')) return
      // Taken here, so the composer's window-wide drop target leaves these files alone.
      e.preventDefault()
      e.stopPropagation()
      setOver(folder)
    },
    onDragLeave: () => setOver((o) => (o === folder ? null : o)),
    onDrop: async (e: DragEvent) => {
      e.preventDefault()
      e.stopPropagation()
      setOver(null)
      const dropped = [...e.dataTransfer.files]
      if (dropped.length) await addTo(folder, await toSources(dropped))
    }
  })

  const startNaming = (parent: string) => {
    if (!isOpen(parent) && parent) toggle(parent)
    if (!open) toggle('')
    setNaming({ parent, name: '' })
  }
  const finishNaming = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Escape') return setNaming(null)
    if (e.key !== 'Enter' || !naming) return
    const name = normalizeFolder(naming.name)
    if (name) rememberFolder(naming.parent ? `${naming.parent}/${name}` : name)
    setNaming(null)
  }

  const folderMenu = (folder: string) => (
    <>
      <MenuItem onSelect={() => void addTo(folder)}>Add files here…</MenuItem>
      <MenuItem onSelect={() => startNaming(folder)}>New folder…</MenuItem>
      {folder && (
        <>
          <MenuSeparator />
          <MenuItem danger onSelect={() => void removeFolder(folder)}>
            Remove folder
          </MenuItem>
        </>
      )}
    </>
  )
  const moveTargets = (file: ProjectFile) =>
    ['', ...folders].filter((f) => f !== file.folder).map((f) => ({ folder: f, label: f || `${project.name} (top level)` }))

  const renderNodes = (nodes: TreeNode<ProjectFile>[], depth: number) =>
    nodes.map((n) =>
      n.kind === 'folder' ? (
        <div key={`d:${n.path}`}>
          <Row
            depth={depth}
            testid="explorer-folder"
            over={over === n.path}
            {...dropProps(n.path)}
            onClick={() => toggle(n.path)}
            icon={isOpen(n.path) ? <FolderOpen className="size-3.5 shrink-0" /> : <FolderClosed className="size-3.5 shrink-0" />}
            label={n.name}
            chevron={isOpen(n.path)}
            menu={folderMenu(n.path)}
          />
          {isOpen(n.path) && (
            <div role="group">
              {naming?.parent === n.path && (
                <NameInput
                  depth={depth + 1}
                  value={naming.name}
                  onChange={(name) => setNaming({ parent: n.path, name })}
                  onKeyDown={finishNaming}
                />
              )}
              {renderNodes(n.children, depth + 1)}
            </div>
          )}
        </div>
      ) : (
        <Row
          key={`f:${n.file.id}`}
          depth={depth}
          testid="explorer-file"
          {...dropProps(n.file.folder)}
          onClick={() => preview(n.file)}
          icon={<FileText className="size-3.5 shrink-0" />}
          label={n.name}
          menu={
            <>
              <MenuItem onSelect={() => preview(n.file)}>Preview</MenuItem>
              <MenuItem onSelect={() => void api.projects.revealFile(n.file.id).catch(reportError)}>Reveal in Finder</MenuItem>
              {moveTargets(n.file).length > 0 && (
                <MenuSub label="Move to">
                  {moveTargets(n.file).map((t) => (
                    <MenuItem key={t.folder || '/'} onSelect={() => void move(n.file, t.folder)}>
                      {t.label}
                    </MenuItem>
                  ))}
                </MenuSub>
              )}
              <MenuSeparator />
              <MenuItem danger onSelect={() => void remove(n.file)}>
                Remove from project
              </MenuItem>
            </>
          }
        />
      )
    )

  const active = route.name === 'project' && route.id === project.id
  return (
    <div data-testid="explorer-project" role="tree" aria-label={project.name}>
      <Row
        depth={0}
        testid="explorer-root"
        active={active}
        over={over === ''}
        {...dropProps('')}
        onClick={() => navigate({ name: 'project', id: project.id })}
        onToggle={() => toggle('')}
        icon={<FolderClosed className="size-3.5 shrink-0" />}
        label={project.name}
        chevron={open}
        menu={
          <>
            {folderMenu('')}
            <MenuSeparator />
            <MenuItem onSelect={() => navigate({ name: 'project', id: project.id })}>Open project page</MenuItem>
          </>
        }
      />
      {open && (
        <div role="group">
          {naming?.parent === '' && (
            <NameInput depth={1} value={naming.name} onChange={(name) => setNaming({ parent: '', name })} onKeyDown={finishNaming} />
          )}
          {files === null ? (
            <div className="px-2.5 py-1 pl-9 text-xs text-subtle">Loading…</div>
          ) : (
            <>
              {renderNodes(tree, 1)}
              {!tree.length && !naming && (
                <button
                  onClick={() => void addTo('')}
                  className="flex h-7 w-full items-center gap-2 rounded-lg px-2.5 pl-9 text-left text-xs text-subtle hover:bg-hover hover:text-fg"
                >
                  <FolderPlus className="size-3.5" /> Add files…
                </button>
              )}
            </>
          )}
          {chats.map((c) => (
            <div key={c.id} className="pl-4">
              <ConversationRow
                conversation={c}
                active={route.name === 'chat' && route.id === c.id}
                streaming={!!streams[c.id]}
                waiting={!!streams[c.id]?.toolEvents.some((e) => e?.awaiting)}
                onOpen={() => navigate({ name: 'chat', id: c.id })}
              />
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function Row({
  depth,
  icon,
  label,
  chevron,
  active,
  over,
  onClick,
  onToggle,
  menu,
  testid,
  ...drop
}: {
  depth: number
  icon: React.ReactNode
  label: string
  /** Present for a node that opens: whether it's open now. */
  chevron?: boolean
  active?: boolean
  over?: boolean
  onClick: () => void
  /** For the project row, whose click opens its page: the chevron opens the tree instead. */
  onToggle?: () => void
  menu: React.ReactNode
  testid: string
  onDragOver?: (e: DragEvent) => void
  onDragLeave?: () => void
  onDrop?: (e: DragEvent) => void
}) {
  return (
    <div
      {...drop}
      data-testid={testid}
      role="treeitem"
      aria-expanded={chevron}
      aria-selected={active}
      className={cn(
        'group flex h-7 items-center gap-1 rounded-lg pr-1 text-[13px]',
        active ? 'bg-hover text-fg' : 'text-muted hover:bg-hover hover:text-fg',
        over && 'ring-1 ring-accent'
      )}
      style={{ paddingLeft: 6 + depth * 14 }}
    >
      {chevron !== undefined ? (
        <button
          onClick={(e) => {
            e.stopPropagation()
            ;(onToggle ?? onClick)()
          }}
          aria-label={`${chevron ? 'Collapse' : 'Expand'} ${label}`}
          className="flex size-4 shrink-0 items-center justify-center rounded text-subtle hover:text-fg"
        >
          <ChevronRight className={cn('size-3.5 transition-transform', chevron && 'rotate-90')} />
        </button>
      ) : (
        <span className="size-4 shrink-0" />
      )}
      <button onClick={onClick} className="flex min-w-0 flex-1 items-center gap-1.5 text-left">
        {icon}
        <span className="truncate">{label}</span>
      </button>
      <Menu>
        <MenuTrigger asChild>
          <button
            aria-label={`${label} menu`}
            className="flex size-5 shrink-0 items-center justify-center rounded text-subtle opacity-0 hover:text-fg group-hover:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100"
          >
            <MoreHorizontal className="size-3.5" />
          </button>
        </MenuTrigger>
        <MenuContent align="end">{menu}</MenuContent>
      </Menu>
    </div>
  )
}

function NameInput({
  depth,
  value,
  onChange,
  onKeyDown
}: {
  depth: number
  value: string
  onChange: (v: string) => void
  onKeyDown: (e: KeyboardEvent<HTMLInputElement>) => void
}) {
  return (
    <div className="flex h-7 items-center gap-1.5" style={{ paddingLeft: 6 + depth * 14 + 20 }}>
      <FolderClosed className="size-3.5 shrink-0 text-subtle" />
      <input
        autoFocus
        value={value}
        placeholder="Folder name"
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={onKeyDown}
        onBlur={() => onKeyDown({ key: 'Escape' } as KeyboardEvent<HTMLInputElement>)}
        data-testid="explorer-new-folder"
        className="h-6 min-w-0 flex-1 rounded-md border border-line bg-panel px-1.5 text-[13px] outline-none"
      />
    </div>
  )
}
