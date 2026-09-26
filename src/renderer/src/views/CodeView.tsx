import { FolderClosed, FolderOpen, Pin, SquareTerminal } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import type { Conversation } from '@shared/types'
import { ConversationMenu } from '@/components/ConversationMenu'
import { PageHeader, TopBar } from '@/components/TopBar'
import { Button, EmptyState, Tooltip } from '@/components/ui'
import { api } from '@/lib/api'
import { displayPath, folderName, openFolder } from '@/lib/codeActions'
import { displayModelName, relativeTime } from '@/lib/format'
import { reportError, useApp } from '@/stores/app'

export function CodeView() {
  const { sessions, navigate } = useApp()
  const [recent, setRecent] = useState<string[]>([])
  const [home, setHome] = useState<string | null>(null)

  useEffect(() => {
    void api.code.recentRoots().then(setRecent).catch(reportError)
    void api.app
      .info()
      .then((info) => setHome(info.home))
      .catch(reportError)
  }, [])

  // Sessions come most recent first, so each folder's group lands where its latest session would. Within a group,
  // pinned sessions go first (the sort is stable, so each part stays most recent first).
  const groups = useMemo(() => {
    const byRoot = new Map<string, Conversation[]>()
    for (const s of sessions) {
      const root = s.root ?? ''
      byRoot.set(root, [...(byRoot.get(root) ?? []), s])
    }
    return [...byRoot].map(([root, list]) => [root, list.sort((a, b) => Number(b.pinned) - Number(a.pinned))] as const)
  }, [sessions])

  return (
    <div className="flex h-full flex-col">
      <TopBar />
      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-3xl px-6 pb-12 pt-6">
          <PageHeader
            title="Code sessions"
            actions={
              <Button variant="primary" onClick={() => void openFolder()}>
                <FolderOpen className="size-4" /> Open folder…
              </Button>
            }
          />

          {recent.length > 0 && (
            <div className="mb-6">
              <div className="mb-2 text-xs text-subtle">Recent folders</div>
              <div className="flex flex-wrap gap-1.5">
                {recent.map((root) => (
                  <Tooltip key={root} content={root}>
                    <button
                      onClick={() => void openFolder(root)}
                      className="flex max-w-[240px] items-center gap-1.5 rounded-lg border border-line px-2.5 py-1 text-[13px] text-muted hover:border-line-strong hover:text-fg"
                    >
                      <FolderClosed className="size-3.5 shrink-0" />
                      <span className="truncate">{folderName(root)}</span>
                    </button>
                  </Tooltip>
                ))}
              </div>
            </div>
          )}

          {groups.length ? (
            <div className="space-y-6">
              {groups.map(([root, list]) => (
                <section key={root}>
                  <div className="flex items-baseline gap-2 px-3 pb-1">
                    <h2 className="shrink-0 text-sm font-medium">{folderName(root)}</h2>
                    <span className="truncate text-xs text-subtle">{displayPath(root, home)}</span>
                  </div>
                  <ul className="divide-y divide-line">
                    {list.map((c) => (
                      <li key={c.id} className="group flex items-center gap-2 rounded-lg px-3 py-3 hover:bg-hover">
                        <button onClick={() => navigate({ name: 'code', id: c.id })} className="min-w-0 flex-1 text-left">
                          <div className="flex items-center gap-1.5 text-sm font-medium">
                            {c.pinned && <Pin aria-label="Pinned" className="size-3.5 shrink-0 text-subtle" />}
                            <span className="truncate">{c.title}</span>
                          </div>
                          <div className="mt-0.5 text-xs text-subtle">
                            {displayModelName(c.model)} · {relativeTime(c.updatedAt)}
                          </div>
                        </button>
                        <span className="opacity-0 group-hover:opacity-100 has-[[data-state=open]]:opacity-100">
                          <ConversationMenu conversation={c} align="end" />
                        </span>
                      </li>
                    ))}
                  </ul>
                </section>
              ))}
            </div>
          ) : (
            <EmptyState icon={<SquareTerminal className="size-5" />} title="No code sessions yet">
              Open a folder, such as a repository, and a model can work in it: reading files, editing them and running commands.
            </EmptyState>
          )}
        </div>
      </div>
    </div>
  )
}
