import { ChevronRight, FileText, FolderClosed, FolderOpen, FolderPlus, MoreHorizontal, Plus } from 'lucide-react'
import { type DragEvent, type KeyboardEvent, type ReactNode, useMemo, useRef, useState } from 'react'
import { buildTree, folderAfterRemoving, normalizeFolder, type TreeNode } from '@shared/fileTree'
import type { Project, ProjectFile } from '@shared/types'
import { api } from '@/lib/api'
import { cn, formatBytes, formatTokens } from '@/lib/format'
import { toSources } from '@/lib/sources'
import { reportError, useApp } from '@/stores/app'
import { folderKey, useExplorer } from '@/stores/explorer'
import { IconButton, Menu, MenuContent, MenuItem, MenuSeparator, MenuSub, MenuTrigger, Spinner } from './ui'

/** A project page's Knowledge section: its files as a tree of folders, to add to, preview, reveal, move and remove. */
export function ProjectFiles({ project, files, summary }: { project: Project; files: ProjectFile[]; summary?: ReactNode }) {
  const { loadProjects, touchProjectFiles } = useApp()
  const { closedFolders, emptyFolders, toggleFolder, openFolder, rememberFolder: rememberKey, forgetFolder: forgetKey } = useExplorer()
  const [naming, setNaming] = useState<{ parent: string; name: string } | null>(null)
  const [over, setOver] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)
  // The folder whose New folder… was chosen, until its menu has closed.
  const namingFrom = useRef<string | null>(null)

  const isOpen = (folder: string) => !closedFolders.includes(folderKey(project.id, folder))
  const toggle = (folder: string) => toggleFolder(project.id, folder)

  const extra = useMemo(() => emptyFolders[project.id] ?? [], [emptyFolders, project.id])
  const tree = useMemo(() => buildTree(files, extra), [files, extra])
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

  const rememberFolder = (folder: string) => rememberKey(project.id, folder)
  const forgetFolder = (folder: string) => forgetKey(project.id, folder)
  const preview = (file: ProjectFile) => void api.projects.openFile(file.id).catch(reportError)
  // The list here and the project's place among the recent ones in the sidebar.
  const changed = () => {
    touchProjectFiles()
    void loadProjects()
  }

  const addTo = async (folder: string, sources = null as Awaited<ReturnType<typeof toSources>> | null) => {
    try {
      const picked = sources ?? (await api.attachments.pick())
      if (!picked.length) return
      setAdding(true)
      const { errors } = await api.projects.addFiles(project.id, picked, folder)
      errors.forEach(reportError)
      // Show where they landed.
      if (folder) openFolder(project.id, folder)
      changed()
    } catch (err) {
      reportError(err)
    } finally {
      setAdding(false)
    }
  }
  const move = async (file: ProjectFile, folder: string) => {
    try {
      await api.projects.moveFile(file.id, folder)
      changed()
    } catch (err) {
      reportError(err)
    }
  }
  const remove = async (file: ProjectFile) => {
    try {
      await api.projects.removeFile(file.id)
      changed()
    } catch (err) {
      reportError(err)
    }
  }
  const removeFolder = async (folder: string) => {
    // A folder is its files' paths: removing it moves them (one at a time) up into its parent and forgets it if it was empty.
    try {
      for (const f of files) {
        const to = folderAfterRemoving(folder, f.folder)
        if (to !== f.folder) await api.projects.moveFile(f.id, to)
      }
      // Empty folders under it move up the same way.
      const kept = extra.filter((f) => f.startsWith(`${folder}/`)).map((f) => folderAfterRemoving(folder, f))
      forgetFolder(folder)
      kept.forEach(rememberFolder)
      changed()
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
      // Handled, so the composer leaves the files alone; still bubbling, so it knows the drag ended. A folder's row
      // sits inside the section, which takes drops for the top level: only the innermost target adds them.
      if (e.defaultPrevented) return
      e.preventDefault()
      setOver(null)
      const dropped = [...e.dataTransfer.files]
      if (dropped.length) await addTo(folder, await toSources(dropped))
    }
  })

  const startNaming = (parent: string) => {
    if (parent) openFolder(project.id, parent)
    setNaming({ parent, name: '' })
  }
  const finishNaming = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Escape') return setNaming(null)
    if (e.key !== 'Enter' || !naming) return
    const name = normalizeFolder(naming.name)
    if (name) rememberFolder(naming.parent ? `${naming.parent}/${name}` : name)
    setNaming(null)
  }

  // The name box opens once its menu has closed, not as New folder… is chosen: Radix runs onSelect while the menu is still
  // open, and its focus trap keeps the box's autoFocus from landing. Radix then hands focus back to the "…" button (which
  // would blur, and so cancel, a box that had focus); keeping that back only for New folder… leaves it for any other way
  // out of the menu.
  const nameAfterMenu = (e: Event) => {
    const parent = namingFrom.current
    if (parent === null) return
    namingFrom.current = null
    e.preventDefault()
    startNaming(parent)
  }

  const moveTargets = (file: ProjectFile) =>
    ['', ...folders].filter((f) => f !== file.folder).map((f) => ({ folder: f, label: f || `${project.name} (top level)` }))

  const renderNodes = (nodes: TreeNode<ProjectFile>[], depth: number) =>
    nodes.map((n) =>
      n.kind === 'folder' ? (
        <div key={`d:${n.path}`}>
          <Row
            depth={depth}
            testid="knowledge-folder"
            over={over === n.path}
            {...dropProps(n.path)}
            onClick={() => toggle(n.path)}
            icon={isOpen(n.path) ? <FolderOpen className="size-4 shrink-0" /> : <FolderClosed className="size-4 shrink-0" />}
            label={n.name}
            chevron={isOpen(n.path)}
            onMenuCloseAutoFocus={nameAfterMenu}
            menu={
              <>
                <MenuItem onSelect={() => void addTo(n.path)}>Add files here…</MenuItem>
                <MenuItem
                  onSelect={() => {
                    namingFrom.current = n.path
                  }}
                >
                  New folder…
                </MenuItem>
                <MenuSeparator />
                <MenuItem danger onSelect={() => void removeFolder(n.path)}>
                  Remove folder
                </MenuItem>
              </>
            }
          />
          {isOpen(n.path) && (
            <div>
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
          testid="knowledge-file"
          {...dropProps(n.file.folder)}
          onClick={() => preview(n.file)}
          icon={<FileText className="size-4 shrink-0" />}
          label={n.name}
          detail={`${formatBytes(n.file.size)} · ${n.file.tokenEstimate ? `${formatTokens(n.file.tokenEstimate)} tokens` : 'no text found'}`}
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

  return (
    <section
      data-testid="knowledge"
      {...dropProps('')}
      className={cn('rounded-ollmost-lg border border-line bg-panel p-4', over === '' && 'ring-1 ring-accent')}
    >
      <div className="mb-2 flex items-center justify-between">
        <h2 className="text-sm font-medium">Knowledge</h2>
        <div className="flex items-center">
          <IconButton label="New folder" size="sm" onClick={() => startNaming('')}>
            <FolderPlus className="size-4" />
          </IconButton>
          <IconButton label="Add files" size="sm" onClick={() => void addTo('')} disabled={adding}>
            {adding ? <Spinner className="size-3.5" /> : <Plus className="size-4" />}
          </IconButton>
        </div>
      </div>
      {summary}
      {naming?.parent === '' && (
        <NameInput depth={0} value={naming.name} onChange={(name) => setNaming({ parent: '', name })} onKeyDown={finishNaming} />
      )}
      {tree.length ? (
        <div className="-mx-1.5">{renderNodes(tree, 0)}</div>
      ) : (
        !naming && (
          <p className="text-[13px] text-muted">
            Add PDFs, documents, spreadsheets or text files, or drop them here. Every chat in this project can use them.
          </p>
        )
      )}
    </section>
  )
}

function Row({
  depth,
  icon,
  label,
  detail,
  chevron,
  over,
  onClick,
  menu,
  onMenuCloseAutoFocus,
  testid,
  ...drop
}: {
  depth: number
  icon: ReactNode
  label: string
  /** A second, smaller line: a file's size and tokens. */
  detail?: string
  /** Present for a folder: whether it's open now. */
  chevron?: boolean
  over?: boolean
  onClick: () => void
  menu: ReactNode
  /** Runs once the menu has closed, for an item that opens something needing focus (the name box): see MenuContent. */
  onMenuCloseAutoFocus?: (e: Event) => void
  testid: string
  onDragOver?: (e: DragEvent) => void
  onDragLeave?: () => void
  onDrop?: (e: DragEvent) => void
}) {
  return (
    <div
      {...drop}
      data-testid={testid}
      className={cn('group flex items-center gap-1 rounded-lg py-1 pr-1 text-[13px] text-fg hover:bg-hover', over && 'ring-1 ring-accent')}
      style={{ paddingLeft: 6 + depth * 14 }}
    >
      {chevron !== undefined ? (
        <button
          onClick={onClick}
          aria-label={`${chevron ? 'Collapse' : 'Expand'} ${label}`}
          aria-expanded={chevron}
          className="flex size-4 shrink-0 items-center justify-center rounded text-subtle hover:text-fg"
        >
          <ChevronRight className={cn('size-3.5 transition-transform', chevron && 'rotate-90')} />
        </button>
      ) : (
        <span className="size-4 shrink-0" />
      )}
      <button onClick={onClick} className="flex min-w-0 flex-1 items-center gap-2 text-left">
        <span className="text-muted">{icon}</span>
        <span className="min-w-0 flex-1">
          <span className="block truncate">{label}</span>
          {detail && <span className="block truncate text-[11px] text-subtle">{detail}</span>}
        </span>
      </button>
      <Menu>
        <MenuTrigger asChild>
          <button
            aria-label={`${label} menu`}
            className="flex size-6 shrink-0 items-center justify-center rounded text-subtle opacity-0 hover:text-fg group-hover:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100"
          >
            <MoreHorizontal className="size-4" />
          </button>
        </MenuTrigger>
        <MenuContent align="end" onCloseAutoFocus={onMenuCloseAutoFocus}>
          {menu}
        </MenuContent>
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
    <div className="flex h-8 items-center gap-2" style={{ paddingLeft: depth * 14 + 20 }}>
      <FolderClosed className="size-4 shrink-0 text-subtle" />
      <input
        autoFocus
        value={value}
        placeholder="Folder name"
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={onKeyDown}
        onBlur={() => onKeyDown({ key: 'Escape' } as KeyboardEvent<HTMLInputElement>)}
        data-testid="knowledge-new-folder"
        className="h-7 min-w-0 flex-1 rounded-md border border-line bg-canvas px-1.5 text-[13px] outline-none"
      />
    </div>
  )
}
