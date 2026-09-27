import { FolderClosed, MessageSquare, Plus, Search } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { SearchHit } from '@shared/types'
import { ConversationMenu } from '@/components/ConversationMenu'
import { PageHeader, TopBar } from '@/components/TopBar'
import { Button, EmptyState } from '@/components/ui'
import { api } from '@/lib/api'
import { relativeTime } from '@/lib/format'
import { conversationRoute, useApp } from '@/stores/app'

/** Render FTS snippets (matches wrapped in \u0001…\u0002) without touching innerHTML. */
export function Snippet({ text }: { text: string }) {
  // eslint-disable-next-line no-control-regex -- \u0001 and \u0002 are the match markers search asks SQLite to insert
  const parts = text.split(/(\u0001[^\u0002]*\u0002)/)
  return (
    <>
      {parts.map((p, i) =>
        p.startsWith('\u0001') ? (
          <mark key={i} className="rounded-sm bg-accent-soft px-0.5 text-fg">
            {p.slice(1, -1)}
          </mark>
        ) : (
          <span key={i}>{p}</span>
        )
      )}
    </>
  )
}

export function ChatsView() {
  const { conversations, sessions, projects, navigate } = useApp()
  const [query, setQuery] = useState('')
  const [hits, setHits] = useState<SearchHit[] | null>(null)

  useEffect(() => {
    if (!query.trim()) return setHits(null)
    const t = setTimeout(() => api.conversations.search(query).then(setHits), 150)
    return () => clearTimeout(t)
  }, [query])

  const projectName = (id: string | null) => projects.find((p) => p.id === id)?.name

  return (
    <div className="flex h-full flex-col">
      <TopBar />
      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-3xl px-6 pb-12 pt-6">
          <PageHeader
            title="Your chats"
            actions={
              <Button variant="primary" onClick={() => navigate({ name: 'home' })}>
                <Plus className="size-4" /> New chat
              </Button>
            }
          />
          <div className="relative mb-4">
            <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-subtle" />
            <input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search your chats…"
              className="h-11 w-full rounded-ollmost border border-line bg-panel pl-9 pr-3 text-sm outline-none placeholder:text-subtle focus:border-line-strong focus:ring-2 focus:ring-accent-soft"
            />
          </div>

          {hits ? (
            hits.length ? (
              <ul className="divide-y divide-line">
                {hits.map((h) => (
                  <li key={h.conversationId}>
                    <button
                      onClick={() => navigate(conversationRoute(h.conversationId, sessions, h.mode))}
                      className="w-full rounded-lg px-3 py-3 text-left hover:bg-hover"
                    >
                      <div className="text-sm font-medium">{h.title}</div>
                      <div className="mt-0.5 line-clamp-2 text-[13px] text-muted">
                        <Snippet text={h.snippet} />
                      </div>
                      <div className="mt-1 text-xs text-subtle">{relativeTime(h.updatedAt)}</div>
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <EmptyState icon={<Search className="size-5" />} title="No matches">
                Nothing in your chats matches “{query}”.
              </EmptyState>
            )
          ) : conversations.length ? (
            <>
              <div className="mb-2 px-3 text-xs text-subtle">{conversations.length} chats</div>
              <ul className="divide-y divide-line">
                {conversations.map((c) => (
                  <li key={c.id} className="group flex items-center gap-2 rounded-lg px-3 py-3 hover:bg-hover">
                    <button onClick={() => navigate({ name: 'chat', id: c.id })} className="min-w-0 flex-1 text-left">
                      <div className="truncate text-sm font-medium">{c.title}</div>
                      <div className="mt-0.5 flex items-center gap-2 text-xs text-subtle">
                        Last message {relativeTime(c.updatedAt)}
                        {c.projectId && (
                          <span className="flex items-center gap-1">
                            · <FolderClosed className="size-3" /> {projectName(c.projectId)}
                          </span>
                        )}
                      </div>
                    </button>
                    <span className="opacity-0 group-hover:opacity-100 has-[[data-state=open]]:opacity-100">
                      <ConversationMenu conversation={c} align="end" />
                    </span>
                  </li>
                ))}
              </ul>
            </>
          ) : (
            <EmptyState icon={<MessageSquare className="size-5" />} title="No chats yet">
              Start a conversation and it will show up here.
            </EmptyState>
          )}
        </div>
      </div>
    </div>
  )
}
