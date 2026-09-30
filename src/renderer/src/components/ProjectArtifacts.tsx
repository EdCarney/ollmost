import { useEffect, useState } from 'react'
import type { ArtifactSummary } from '@shared/types'
import { api } from '@/lib/api'
import { relativeTime } from '@/lib/format'
import { conversationRoute, reportError, useApp } from '@/stores/app'
import { useArtifactPanel } from '@/stores/artifactPanel'
import { ARTIFACT_META } from './ArtifactCard'

/** Opens an artifact where it was made: its chat, with the artifact in the panel. */
export function openArtifact(a: ArtifactSummary): void {
  const app = useApp.getState()
  app.navigate(conversationRoute(a.conversationId, app.sessions))
  useArtifactPanel.getState().openArtifact(a.id)
}

/**
 * The artifacts made in a project's chats, latest first; null until loaded, and never loaded while `enabled` is false.
 * Loaded again when the project's chats change: a reply that made an artifact finishing, or a chat moved in, out or
 * deleted.
 */
export function useProjectArtifacts(projectId: string, enabled = true): ArtifactSummary[] | null {
  const [items, setItems] = useState<ArtifactSummary[] | null>(null)
  // A string, so the store's other changes leave it equal and load nothing.
  const chats = useApp((s) =>
    s.conversations
      .filter((c) => c.projectId === projectId)
      .map((c) => `${c.id}:${c.updatedAt}`)
      .join(' ')
  )
  useEffect(() => {
    if (!enabled) return
    let live = true
    api.artifacts
      .list(projectId)
      .then((list) => live && setItems(list))
      .catch((err) => {
        if (live) setItems([])
        reportError(err)
      })
    return () => {
      live = false
    }
  }, [projectId, enabled, chats])
  return items
}

/** A project page's Artifacts section: every artifact made in its chats. */
export function ProjectArtifacts({ projectId }: { projectId: string }) {
  const items = useProjectArtifacts(projectId)
  return (
    <section data-testid="project-artifacts" className="rounded-ollmost-lg border border-line bg-panel p-4">
      <h2 className="mb-2 text-sm font-medium">Artifacts</h2>
      {items?.length ? (
        <ul className="-mx-1.5">
          {items.map((a) => {
            const Icon = ARTIFACT_META[a.type].icon
            return (
              <li key={a.id}>
                <button
                  onClick={() => openArtifact(a)}
                  className="flex w-full items-center gap-2 rounded-lg px-1.5 py-1 text-left hover:bg-hover"
                >
                  <Icon className="size-4 shrink-0 text-muted" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13px]">{a.title}</span>
                    <span className="block truncate text-[11px] text-subtle">
                      From “{a.conversationTitle}” · {relativeTime(a.updatedAt)}
                    </span>
                  </span>
                </button>
              </li>
            )
          })}
        </ul>
      ) : (
        <p className="text-[13px] text-muted">
          {items ? 'Documents, code, pages and diagrams made in this project’s chats show up here.' : 'Loading…'}
        </p>
      )}
    </section>
  )
}
