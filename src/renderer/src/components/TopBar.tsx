import { PanelLeft, SquarePen } from 'lucide-react'
import type { ReactNode } from 'react'
import { cn } from '@/lib/format'
import { useApp } from '@/stores/app'
import { IconButton } from './ui'
import { AccountQuota } from './UsageBar'

/**
 * Draggable title bar. When the sidebar is hidden it clears the traffic lights and shows its toggle.
 * The right side carries the Ollama quota chip when there's an ollama.com key or an Ollama endpoint (quotaMode);
 * views can add their own items before it.
 */
export function TopBar({ children, right, className }: { children?: ReactNode; right?: ReactNode; className?: string }) {
  const { sidebarOpen, toggleSidebar, navigate } = useApp()
  return (
    <header className={cn('drag flex h-12 shrink-0 items-center gap-2 px-3', !sidebarOpen && 'pl-[84px]', className)}>
      {!sidebarOpen && (
        <div className="flex items-center gap-0.5">
          <IconButton label="Open sidebar (⌘⇧S)" size="sm" onClick={toggleSidebar}>
            <PanelLeft className="size-4" />
          </IconButton>
          <IconButton label="New chat (⌘N)" size="sm" onClick={() => navigate({ name: 'home' })}>
            <SquarePen className="size-4" />
          </IconButton>
        </div>
      )}
      <div className="flex min-w-0 flex-1 items-center gap-2">{children}</div>
      <div className="flex shrink-0 items-center gap-1">
        {right}
        <AccountQuota />
      </div>
    </header>
  )
}

export function PageHeader({ title, actions }: { title: string; actions?: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 pb-6">
      <h1 className="font-reading text-[28px] font-medium tracking-tight">{title}</h1>
      <div className="flex items-center gap-2">{actions}</div>
    </div>
  )
}
