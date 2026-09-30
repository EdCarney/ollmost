import { Shapes } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { ArtifactSummary, ArtifactType } from '@shared/types'
import { ARTIFACT_META } from '@/components/ArtifactCard'
import { openArtifact } from '@/components/ProjectArtifacts'
import { PageHeader, TopBar } from '@/components/TopBar'
import { EmptyState, Spinner } from '@/components/ui'
import { api } from '@/lib/api'
import { cn, relativeTime } from '@/lib/format'

const FILTERS: Array<{ value: ArtifactType | 'all'; label: string }> = [
  { value: 'all', label: 'All' },
  { value: 'markdown', label: 'Documents' },
  { value: 'code', label: 'Code' },
  { value: 'html', label: 'Web pages' },
  { value: 'svg', label: 'Images' },
  { value: 'mermaid', label: 'Diagrams' }
]

export function ArtifactsView() {
  const [items, setItems] = useState<ArtifactSummary[] | null>(null)
  const [filter, setFilter] = useState<ArtifactType | 'all'>('all')

  useEffect(() => {
    void api.artifacts.list().then(setItems)
  }, [])

  const shown = (items ?? []).filter((a) => filter === 'all' || a.type === filter)

  return (
    <div className="flex h-full flex-col">
      <TopBar />
      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-5xl px-6 pb-12 pt-6">
          <PageHeader title="Artifacts" />
          <div className="mb-6 flex flex-wrap gap-1.5">
            {FILTERS.map((f) => (
              <button
                key={f.value}
                onClick={() => setFilter(f.value)}
                className={cn(
                  'h-8 rounded-full border px-3 text-[13px]',
                  filter === f.value ? 'border-line-strong bg-panel text-fg' : 'border-line text-muted hover:text-fg'
                )}
              >
                {f.label}
              </button>
            ))}
          </div>
          {!items ? (
            <div className="flex justify-center py-16">
              <Spinner />
            </div>
          ) : shown.length ? (
            <div className="grid grid-cols-[repeat(auto-fill,minmax(260px,1fr))] gap-4">
              {shown.map((a) => {
                const Icon = ARTIFACT_META[a.type].icon
                return (
                  <button
                    key={a.id}
                    onClick={() => openArtifact(a)}
                    className="flex flex-col rounded-ollmost-lg border border-line bg-panel p-4 text-left transition-colors hover:border-line-strong"
                  >
                    <span className="mb-3 flex size-10 items-center justify-center rounded-lg border border-line bg-canvas text-muted">
                      <Icon className="size-5" />
                    </span>
                    <span className="truncate text-sm font-medium">{a.title}</span>
                    <span className="mt-0.5 truncate text-xs text-subtle">
                      {[ARTIFACT_META[a.type].label, a.language, a.versionCount > 1 && `${a.versionCount} versions`]
                        .filter(Boolean)
                        .join(' · ')}
                    </span>
                    <span className="mt-3 truncate text-xs text-muted">
                      From “{a.conversationTitle}” · {relativeTime(a.updatedAt)}
                    </span>
                  </button>
                )
              })}
            </div>
          ) : (
            <EmptyState icon={<Shapes className="size-5" />} title="No artifacts yet">
              Ask for a document, a script, a web page or a diagram, and it will be collected here.
            </EmptyState>
          )}
        </div>
      </div>
    </div>
  )
}
