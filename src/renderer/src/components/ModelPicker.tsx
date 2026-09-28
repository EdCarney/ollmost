import { Brain, Check, ChevronDown, Cloud, Eye, HardDrive, Network, RefreshCw, Search, TriangleAlert, Wrench } from 'lucide-react'
import { useMemo, useState } from 'react'
import { displayAddress } from '@shared/endpoints'
import { labelForKey, modelLabel, shortModelName } from '@shared/modelLabel'
import { endpointChips, groupModels, type PickerGroup } from '@shared/pickerGroups'
import type { Endpoint, ModelInfo } from '@shared/types'
import { cn, formatContext, formatParams } from '@/lib/format'
import { selectEndpoints, useApp } from '@/stores/app'
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

/** A section's heading: the endpoint, and where it runs ("On this Mac", or its address on the network). */
function GroupHeading({ group, endpoint }: { group: PickerGroup; endpoint: Endpoint | undefined }) {
  const Icon = group.where === 'cloud' ? Cloud : group.where === 'this-mac' ? HardDrive : Network
  const where = group.where === 'this-mac' ? 'On this Mac' : group.where === 'network' && endpoint ? displayAddress(endpoint.baseUrl) : null
  return (
    <div className="flex items-center gap-1.5 px-2 pb-1 pt-1.5 text-xs font-medium text-subtle">
      <Icon className="size-3.5" /> {group.label}
      {where && <span className="font-normal">· {where}</span>}
    </div>
  )
}

function ModelRow({ model, selected, onPick }: { model: ModelInfo; selected: boolean; onPick: () => void }) {
  return (
    <button onClick={onPick} className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-hover">
      <span className="flex size-4 items-center justify-center">{selected && <Check className="size-4 text-accent" />}</span>
      <span className="min-w-0 flex-1">
        {/* The section names the endpoint, so a row is the model's own name. */}
        <span className="block truncate text-sm">{model.endpoint.kind === 'ollama' ? shortModelName(model.name) : model.name}</span>
        <span className="block text-xs text-subtle">
          {[
            formatParams(model.parameterSize),
            formatContext(model.contextLength) && `${formatContext(model.contextLength)} context`,
            model.price && `$${model.price.input} / $${model.price.output} per M`
          ]
            .filter(Boolean)
            .join(' · ') || (model.installed ? 'Installed' : 'Available')}
        </span>
      </span>
      <CapabilityIcons model={model} />
    </button>
  )
}

/**
 * The composer's model menu: a search box, endpoint chips (All, then each endpoint; an offline one dashed with ⚠),
 * and a section per endpoint with the current model's first. `value` and `onChange` are model keys.
 */
export function ModelPicker({
  value,
  onChange,
  unavailable
}: {
  value: string | null
  onChange: (key: string) => void
  unavailable?: boolean
}) {
  const models = useApp((s) => s.models)
  const modelErrors = useApp((s) => s.modelErrors)
  const modelsLoading = useApp((s) => s.modelsLoading)
  const loadModels = useApp((s) => s.loadModels)
  const navigate = useApp((s) => s.navigate)
  const endpoints = useApp(selectEndpoints)
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState('all')

  const chips = useMemo(() => endpointChips(endpoints, modelErrors), [endpoints, modelErrors])
  // A chip whose endpoint has gone (removed, turned off) falls back to All.
  const active = chips.some((c) => c.id === filter) ? filter : 'all'
  const groups = useMemo(
    () => groupModels(models, modelErrors, { query, filter: active, currentKey: value, endpoints }),
    [models, modelErrors, query, active, value, endpoints]
  )
  const current = models.find((m) => m.key === value)
  // One endpoint that answers needs no filter. Several, or one that's offline, get the chips.
  const showChips = chips.length > 2 || chips.some((c) => c.offline)
  const pick = (key: string) => {
    onChange(key)
    setOpen(false)
    setQuery('')
  }

  return (
    <PopoverRoot open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          className="flex h-8 max-w-[260px] items-center gap-1 rounded-lg px-2 text-[13px] text-muted hover:bg-hover hover:text-fg"
          aria-label="Choose model"
        >
          <span className="truncate">{current ? modelLabel(current) : labelForKey(value, endpoints)}</span>
          {unavailable && <span className="shrink-0 text-danger">· unavailable</span>}
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
        {showChips && (
          <div role="group" aria-label="Endpoints" className="flex flex-wrap gap-1.5 px-2.5 pb-1 pt-2">
            {chips.map((c) => (
              <button
                key={c.id}
                aria-pressed={active === c.id}
                title={c.error}
                onClick={() => setFilter(c.id)}
                className={cn(
                  'flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-xs',
                  active === c.id
                    ? 'border-fg bg-fg text-canvas'
                    : c.offline
                      ? 'border-dashed border-danger text-danger'
                      : 'border-line text-muted hover:text-fg'
                )}
              >
                {c.label}
                {c.offline && <TriangleAlert className="size-3" />}
              </button>
            ))}
          </div>
        )}
        <div className="max-h-[360px] overflow-y-auto p-1">
          {groups.map((g) => (
            <div key={g.id} className="py-1">
              <GroupHeading group={g} endpoint={endpoints.find((e) => e.id === g.endpointId)} />
              {g.error && (
                <div className="mx-2 mb-1.5 flex items-start justify-between gap-2 rounded-md bg-hover px-2 py-1.5 text-xs text-danger">
                  <span>{g.error}</span>
                  <button className="shrink-0 underline" onClick={() => void loadModels(true)}>
                    Retry
                  </button>
                </div>
              )}
              {g.items.map((m) => (
                <ModelRow key={m.key} model={m} selected={m.key === value} onPick={() => pick(m.key)} />
              ))}
            </div>
          ))}
          {!groups.length && (
            <div className="px-3 py-4 text-sm text-subtle">
              {models.length ? 'No models match.' : modelErrors.length ? 'No endpoint could list its models.' : 'No models yet.'}
            </div>
          )}
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
            className="rounded-md px-2 py-1 text-xs text-muted hover:bg-hover hover:text-fg"
          >
            Model settings
          </button>
        </div>
      </PopoverContent>
    </PopoverRoot>
  )
}
