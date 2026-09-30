import { FolderClosed, MessageSquare, PanelLeft, Plus, Settings, Shapes, Sparkles, SquareTerminal } from 'lucide-react'
import { type PointerEvent, type ReactNode, useRef } from 'react'
import { cn } from '@/lib/format'
import { type Route, useApp } from '@/stores/app'
import { useArtifactPanel } from '@/stores/artifactPanel'
import { useChat } from '@/stores/chat'
import { SIDEBAR_WIDTH, useSidebar } from '@/stores/sidebar'
import { ConversationRow } from './ConversationMenu'
import { OllmostMark } from './OllmostMark'
import { SidebarProjects } from './SidebarProjects'
import { IconButton } from './ui'

function NavItem({
  icon,
  label,
  active,
  onClick,
  accent
}: {
  icon: ReactNode
  label: string
  active?: boolean
  onClick: () => void
  accent?: boolean
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        'flex h-8 w-full items-center gap-2.5 rounded-lg px-2.5 text-[13px] font-medium',
        active ? 'bg-hover text-fg' : 'text-muted hover:bg-hover hover:text-fg'
      )}
    >
      <span className={cn('flex size-5 items-center justify-center', accent && 'rounded-full bg-accent text-accent-fg')}>{icon}</span>
      {label}
    </button>
  )
}

function SectionTitle({ children }: { children: ReactNode }) {
  return <div className="px-2.5 pb-1 pt-4 text-xs font-medium text-subtle">{children}</div>
}

/** The sidebar's right edge: drag it to make the sidebar narrower or wider, double-click it (or use ←/→) to size it. */
function ResizeHandle() {
  const { width, setWidth } = useSidebar()
  const start = useRef<{ x: number; width: number } | null>(null)

  const end = () => {
    if (!start.current) return
    start.current = null
    document.body.style.cursor = ''
    document.body.style.userSelect = ''
    // Kept once, as the drag ends, not on every move.
    setWidth(useSidebar.getState().width)
  }

  return (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize sidebar"
      aria-valuemin={SIDEBAR_WIDTH.min}
      aria-valuemax={SIDEBAR_WIDTH.max}
      aria-valuenow={width}
      tabIndex={0}
      onPointerDown={(e: PointerEvent<HTMLDivElement>) => {
        if (e.button !== 0) return
        e.preventDefault()
        e.currentTarget.setPointerCapture(e.pointerId)
        start.current = { x: e.clientX, width }
        document.body.style.cursor = 'col-resize'
        document.body.style.userSelect = 'none'
      }}
      onPointerMove={(e) => {
        if (start.current) setWidth(start.current.width + e.clientX - start.current.x, false)
      }}
      onPointerUp={end}
      onPointerCancel={end}
      onLostPointerCapture={end}
      onDoubleClick={() => setWidth(SIDEBAR_WIDTH.default)}
      onKeyDown={(e) => {
        if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
        e.preventDefault()
        setWidth(width + (e.key === 'ArrowLeft' ? -16 : 16))
      }}
      className="no-drag group absolute inset-y-0 -right-1 z-20 w-2 cursor-col-resize outline-none"
    >
      <span className="absolute inset-y-0 left-1/2 w-0.5 -translate-x-1/2 transition-colors group-hover:bg-line-strong group-focus-visible:bg-line-strong" />
    </div>
  )
}

export function Sidebar() {
  const { route, navigate, toggleSidebar, conversations, settings } = useApp()
  const streams = useChat((s) => s.streams)
  const width = useSidebar((s) => s.width)

  const go = (r: Route) => {
    if (r.name !== 'chat') useArtifactPanel.getState().close()
    navigate(r)
  }

  const activeChatId = route.name === 'chat' ? route.id : null
  const pinnedChats = conversations.filter((c) => c.pinned)
  const recents = conversations.filter((c) => !c.pinned).slice(0, 40)
  const name = settings?.userName?.trim()

  const row = (c: (typeof conversations)[number]) => (
    <ConversationRow
      key={c.id}
      conversation={c}
      active={c.id === activeChatId}
      streaming={!!streams[c.id]}
      waiting={!!streams[c.id]?.toolEvents.some((e) => e?.awaiting)}
      onOpen={() => go({ name: 'chat', id: c.id })}
    />
  )

  return (
    <aside style={{ width }} className="relative flex h-full shrink-0 flex-col border-r border-line bg-sidebar">
      <ResizeHandle />
      <div className="drag flex h-12 shrink-0 items-center justify-end gap-1 pl-20 pr-2">
        <IconButton label="Close sidebar (⌘⇧S)" onClick={toggleSidebar} size="sm">
          <PanelLeft className="size-4" />
        </IconButton>
      </div>

      <div className="flex items-center gap-2 px-4 pb-3">
        <OllmostMark className="size-5 text-accent" />
        <span className="font-reading text-lg font-semibold tracking-tight">Ollmost</span>
      </div>

      <nav className="space-y-0.5 px-2">
        <NavItem accent icon={<Plus className="size-3.5" strokeWidth={2.5} />} label="New chat" onClick={() => go({ name: 'home' })} />
        <NavItem
          icon={<MessageSquare className="size-4" />}
          label="Chats"
          active={route.name === 'chats'}
          onClick={() => go({ name: 'chats' })}
        />
        <NavItem
          icon={<FolderClosed className="size-4" />}
          label="Projects"
          active={route.name === 'projects' || route.name === 'project'}
          onClick={() => go({ name: 'projects' })}
        />
        <NavItem
          icon={<SquareTerminal className="size-4" />}
          label="Code"
          active={route.name === 'code'}
          onClick={() => go({ name: 'code' })}
        />
        <NavItem
          icon={<Shapes className="size-4" />}
          label="Artifacts"
          active={route.name === 'artifacts'}
          onClick={() => go({ name: 'artifacts' })}
        />
        <NavItem
          icon={<Sparkles className="size-4" />}
          label="Skills"
          active={route.name === 'skills'}
          onClick={() => go({ name: 'skills' })}
        />
      </nav>

      <div className="mt-2 min-h-0 flex-1 overflow-y-auto px-2 pb-3">
        <SidebarProjects go={go} />
        {pinnedChats.length > 0 && (
          <>
            <SectionTitle>Pinned</SectionTitle>
            {pinnedChats.map(row)}
          </>
        )}
        {recents.length > 0 && (
          <>
            <SectionTitle>Recents</SectionTitle>
            {recents.map(row)}
          </>
        )}
      </div>

      <div className="border-t border-line p-2">
        <button
          onClick={() => go({ name: 'settings' })}
          className={cn(
            'flex w-full items-center gap-2.5 rounded-lg p-1.5 text-left hover:bg-hover',
            route.name === 'settings' && 'bg-hover'
          )}
        >
          <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-accent-soft text-xs font-semibold text-accent">
            {(name?.[0] ?? '?').toUpperCase()}
          </span>
          <span className="min-w-0 flex-1 truncate text-[13px]">{name || 'Set your name'}</span>
          <Settings className="size-4 text-subtle" />
        </button>
      </div>
    </aside>
  )
}
