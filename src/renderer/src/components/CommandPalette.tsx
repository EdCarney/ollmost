import * as Dialog from '@radix-ui/react-dialog'
import { FolderClosed, MessageSquare, Plus, Search, Settings, Sparkles, SquareTerminal } from 'lucide-react'
import { type ReactNode, useEffect, useMemo, useState } from 'react'
import type { SearchHit } from '@shared/types'
import { api } from '@/lib/api'
import { cn, relativeTime } from '@/lib/format'
import { conversationRoute, type Route, useApp } from '@/stores/app'
import { Snippet } from '@/views/ChatsView'

interface Item {
  key: string
  icon: ReactNode
  label: ReactNode
  detail?: ReactNode
  route: Route
}

export function CommandPalette() {
  const { searchOpen, setSearchOpen, conversations, sessions, projects, navigate } = useApp()
  const [query, setQuery] = useState('')
  const [hits, setHits] = useState<SearchHit[]>([])
  const [index, setIndex] = useState(0)

  useEffect(() => {
    if (!searchOpen) {
      setQuery('')
      setHits([])
    }
  }, [searchOpen])

  useEffect(() => {
    setIndex(0)
    if (!query.trim()) return setHits([])
    const t = setTimeout(() => api.conversations.search(query).then(setHits), 120)
    return () => clearTimeout(t)
  }, [query])

  const items = useMemo<Item[]>(() => {
    const q = query.trim().toLowerCase()
    if (!q)
      return [
        { key: 'new', icon: <Plus className="size-4" />, label: 'New chat', route: { name: 'home' } },
        { key: 'projects', icon: <FolderClosed className="size-4" />, label: 'Projects', route: { name: 'projects' } },
        { key: 'code', icon: <SquareTerminal className="size-4" />, label: 'Code sessions', route: { name: 'code' } },
        { key: 'skills', icon: <Sparkles className="size-4" />, label: 'Skills', route: { name: 'skills' } },
        { key: 'settings', icon: <Settings className="size-4" />, label: 'Settings', route: { name: 'settings' } },
        ...conversations.slice(0, 8).map((c) => ({
          key: c.id,
          icon: <MessageSquare className="size-4" />,
          label: c.title,
          detail: relativeTime(c.updatedAt),
          route: { name: 'chat', id: c.id } as Route
        }))
      ]
    const projectItems = projects
      .filter((p) => p.name.toLowerCase().includes(q))
      .map((p) => ({
        key: p.id,
        icon: <FolderClosed className="size-4" />,
        label: p.name,
        detail: 'Project',
        route: { name: 'project', id: p.id } as Route
      }))
    const chatItems = hits.map((h) => {
      const route = conversationRoute(h.conversationId, sessions, h.mode)
      return {
        key: h.conversationId,
        icon: route.name === 'code' ? <SquareTerminal className="size-4" /> : <MessageSquare className="size-4" />,
        label: h.title,
        detail: <Snippet text={h.snippet} />,
        route
      }
    })
    return [...projectItems, ...chatItems]
  }, [query, hits, conversations, sessions, projects])

  const choose = (item: Item | undefined) => {
    if (!item) return
    setSearchOpen(false)
    navigate(item.route)
  }

  return (
    <Dialog.Root open={searchOpen} onOpenChange={setSearchOpen}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/25" />
        <Dialog.Content
          aria-describedby={undefined}
          className="fixed left-1/2 top-[14vh] z-50 w-[min(640px,calc(100vw-48px))] -translate-x-1/2 overflow-hidden rounded-ollmost-lg border border-line bg-panel shadow-2xl"
        >
          <Dialog.Title className="sr-only">Search</Dialog.Title>
          <div className="flex items-center gap-2 border-b border-line px-4">
            <Search className="size-4 text-subtle" />
            <input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'ArrowDown') {
                  e.preventDefault()
                  setIndex((i) => Math.min(i + 1, items.length - 1))
                } else if (e.key === 'ArrowUp') {
                  e.preventDefault()
                  setIndex((i) => Math.max(i - 1, 0))
                } else if (e.key === 'Enter') {
                  e.preventDefault()
                  choose(items[index])
                }
              }}
              placeholder="Search chats and projects…"
              className="h-12 flex-1 bg-transparent text-[15px] outline-none placeholder:text-subtle"
            />
          </div>
          <div className="max-h-[50vh] overflow-y-auto p-1.5">
            {items.map((item, i) => (
              <button
                key={item.key}
                onMouseEnter={() => setIndex(i)}
                onClick={() => choose(item)}
                className={cn('flex w-full items-start gap-3 rounded-lg px-3 py-2 text-left', i === index && 'bg-hover')}
              >
                <span className="mt-0.5 text-muted">{item.icon}</span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm">{item.label}</span>
                  {item.detail && <span className="block truncate text-xs text-subtle">{item.detail}</span>}
                </span>
              </button>
            ))}
            {query.trim() && !items.length && <div className="px-3 py-6 text-center text-sm text-subtle">No results</div>}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
