import { TriangleAlert } from 'lucide-react'
import { Composer } from '@/components/Composer'
import { MigrationNotice } from '@/components/MigrationNotice'
import { OllmostMark } from '@/components/OllmostMark'
import { TopBar } from '@/components/TopBar'
import { Button } from '@/components/ui'
import { sendMessage } from '@/lib/chatActions'
import { greeting } from '@/lib/format'
import { useApp } from '@/stores/app'

export function HomeView() {
  const { settings, models, modelErrors, modelsLoading, loadModels, navigate, skills } = useApp()
  const noModels = !modelsLoading && models.length === 0

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
                <div className="font-medium">Ollmost can't find any models.</div>
                <div className="mt-1 text-muted">
                  {modelErrors.length
                    ? modelErrors.map((e) => <div key={e.endpointId}>{e.message}</div>)
                    : 'Make sure the Ollama app is running.'}
                </div>
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
