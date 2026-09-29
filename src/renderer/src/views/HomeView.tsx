import { TriangleAlert } from 'lucide-react'
import type { Endpoint } from '@shared/types'
import { Composer } from '@/components/Composer'
import { MigrationNotice } from '@/components/MigrationNotice'
import { OllmostMark } from '@/components/OllmostMark'
import { TopBar } from '@/components/TopBar'
import { Button } from '@/components/ui'
import { sendMessage } from '@/lib/chatActions'
import { greeting } from '@/lib/format'
import { useApp } from '@/stores/app'

/** Why there are no models when no endpoint reported an error. */
function noModelsNote(endpoints: readonly Endpoint[]): string {
  if (!endpoints.length) return 'No endpoints yet. Add one in Settings → Models.'
  // A switched-off endpoint isn't asked, so it has neither models nor an error.
  if (!endpoints.some((e) => e.enabled)) return 'Your endpoints are all turned off. Turn one on in Settings → Models.'
  return 'None of your endpoints has a model yet. Add one, or add another endpoint in Settings → Models.'
}

export function HomeView() {
  const { settings, models, modelErrors, modelsLoading, modelsReady, loadModels, navigate, skills } = useApp()
  // Not before the first listing has finished: on the first render nothing has been asked yet.
  const noModels = modelsReady && !modelsLoading && models.length === 0

  return (
    <div className="flex h-full flex-col">
      <TopBar />
      <div className="flex flex-1 flex-col items-center justify-center overflow-y-auto px-6 pb-[12vh]">
        <div className="w-full" style={{ maxWidth: 'var(--o-chat-width)' }}>
          <h1 className="mb-8 flex items-center justify-center gap-3 font-reading text-[40px] font-normal tracking-tight text-fg">
            <OllmostMark className="size-9 text-accent" />
            {greeting(settings?.userName ?? '')}
          </h1>

          <MigrationNotice />
          {noModels && (
            <div className="mb-4 flex items-start gap-3 rounded-ollmost border border-line bg-panel p-4 text-sm">
              <TriangleAlert className="mt-0.5 size-4 shrink-0 text-danger" />
              <div className="flex-1">
                <div className="font-medium">
                  {modelErrors.length ? "Couldn't load models from any endpoint" : "Ollmost can't find any models."}
                </div>
                {modelErrors.length ? (
                  // The main process's messages name their endpoint and address. A failed list call (endpointId '') shows
                  // the error as it came.
                  <ul className="mt-1 space-y-0.5 text-muted">
                    {modelErrors.map((e) => (
                      <li key={e.endpointId} className="selectable">
                        {e.message}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <div className="mt-1 text-muted">{noModelsNote(settings?.endpoints ?? [])}</div>
                )}
              </div>
              <div className="flex gap-2">
                <Button size="sm" onClick={() => loadModels(true)}>
                  Retry
                </Button>
                <Button size="sm" variant="ghost" onClick={() => navigate({ name: 'settings', tab: 'models' })}>
                  Settings
                </Button>
              </div>
            </div>
          )}

          <Composer
            conversation={null}
            streaming={false}
            large
            autoFocus
            placeholder="How can I help you today?"
            onSubmit={(input) => sendMessage(null, null, input)}
          />
          {skills.some((s) => s.enabled) && (
            <p className="mt-3 text-center text-xs text-subtle">
              Type <kbd className="rounded border border-line px-1 font-mono">/</kbd> to use a skill
            </p>
          )}
        </div>
      </div>
    </div>
  )
}
