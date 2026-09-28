import { Brain, Check, ChevronDown, Cloud, Eye, HardDrive, RefreshCw, Search, Wrench } from 'lucide-react'
import { useMemo, useState } from 'react'
import type { ModelInfo } from '@shared/types'
import { cn, displayModelName, formatContext, formatParams } from '@/lib/format'
import { useApp } from '@/stores/app'
import { PopoverContent, PopoverRoot, PopoverTrigger, Spinner, Tooltip } from './ui'

function CapabilityIcons({ model }: { model: ModelInfo }) {
  const caps = [
    { key: 'vision', icon: Eye, label: 'Sees images' },
    { key: 'thinking', icon: Brain, label: 'Can think' },
    { key: 'tools', icon: Wrench, label: 'Uses tools (skills, web search)' }
  ].filter((c) => model.capabilities.includes(c.key))
  return (
    <span className="flex items-center gap-1 text-subtle">
      {caps.map(({ key, icon: Icon, label }) => (
        <Tooltip key={key} content={label}>
          <Icon className="size-3.5" />
        </Tooltip>
      ))}
    </span>
  )
}

export function ModelPicker({ value, onChange }: { value: string | null; onChange: (name: string) => void }) {
  const { models, modelsLoading, modelsError, loadModels, navigate } = useApp()
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')

  const groups = useMemo(() => {
    const q = query.toLowerCase()
    const filtered = models.filter((m) => m.name.toLowerCase().includes(q))
    return [
      { label: 'Cloud', icon: Cloud, items: filtered.filter((m) => m.where === 'cloud') },
      { label: 'On this Mac', icon: HardDrive, items: filtered.filter((m) => m.where !== 'cloud') }
    ].filter((g) => g.items.length)
  }, [models, query])

  const current = models.find((m) => m.name === value)

  return (
    <PopoverRoot open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          className="flex h-8 max-w-[220px] items-center gap-1 rounded-lg px-2 text-[13px] text-muted hover:bg-hover hover:text-fg"
          aria-label="Choose model"
        >
          <span className="truncate">{displayModelName(value)}</span>
          {current?.where === 'cloud' && <Cloud className="size-3.5 shrink-0 text-subtle" />}
          <ChevronDown className="size-3.5 shrink-0" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" side="top" className="w-[340px]" onOpenAutoFocus={(e) => e.preventDefault()}>
        <div className="flex items-center gap-2 border-b border-line px-3">
          <Search className="size-4 text-subtle" />
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search models"
            className="h-10 flex-1 bg-transparent text-sm outline-none placeholder:text-subtle"
          />
        </div>
        <div className="max-h-[360px] overflow-y-auto p-1">
          {modelsError && !models.length && <div className="px-3 py-4 text-sm text-danger">{modelsError}</div>}
          {groups.map((g) => (
            <div key={g.label} className="py-1">
              <div className="flex items-center gap-1.5 px-2 pb-1 pt-1.5 text-xs font-medium text-subtle">
                <g.icon className="size-3.5" /> {g.label}
              </div>
              {g.items.map((m) => (
                <button
                  key={m.name}
                  onClick={() => {
                    onChange(m.name)
                    setOpen(false)
                    setQuery('')
                  }}
                  className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-hover"
                >
                  <span className="flex size-4 items-center justify-center">
                    {m.name === value && <Check className="size-4 text-accent" />}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm">{displayModelName(m.name)}</span>
                    <span className="block text-xs text-subtle">
                      {[
                        formatParams(m.parameterSize),
                        formatContext(m.contextLength) && `${formatContext(m.contextLength)} context`,
                        m.price && `$${m.price.input} / $${m.price.output} per M`
                      ]
                        .filter(Boolean)
                        .join(' · ') || (m.installed ? 'Installed' : 'Available')}
                    </span>
                  </span>
                  <CapabilityIcons model={m} />
                </button>
              ))}
            </div>
          ))}
          {!groups.length && !modelsError && <div className="px-3 py-4 text-sm text-subtle">No models match.</div>}
        </div>
        <div className="flex items-center justify-between border-t border-line px-2 py-1.5">
          <button
            onClick={() => loadModels(true)}
            className="flex items-center gap-1.5 rounded-md px-2 py-1 text-xs text-muted hover:bg-hover hover:text-fg"
          >
            {modelsLoading ? <Spinner className="size-3.5" /> : <RefreshCw className="size-3.5" />} Refresh
          </button>
          <button
            onClick={() => {
              setOpen(false)
              navigate({ name: 'settings', tab: 'models' })
            }}
            className={cn('rounded-md px-2 py-1 text-xs text-muted hover:bg-hover hover:text-fg')}
          >
            Model settings
          </button>
        </div>
      </PopoverContent>
    </PopoverRoot>
  )
}
