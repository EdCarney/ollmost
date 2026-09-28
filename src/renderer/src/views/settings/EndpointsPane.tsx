import { Plus, RefreshCw, Trash2 } from 'lucide-react'
import { useState } from 'react'
import { DEFAULT_CONTEXT, DEFAULT_NUM_CTX, displayAddress, FLAVOR_LABELS, isOllamaCloudUrl, removalText } from '@shared/endpoints'
import { labelForKey, shortModelName } from '@shared/modelLabel'
import { resolveThinkProfile } from '@shared/thinking'
import type { Endpoint, ModelInfo, ModelListResult, ModelOverrides, Settings, ThinkProfile } from '@shared/types'
import { Badge, Button, Field, Switch, TextField } from '@/components/ui'
import { api } from '@/lib/api'
import { cn, contextSizeLabel } from '@/lib/format'
import { reportError, useApp } from '@/stores/app'
import { useConfirm } from '@/stores/confirm'
import { BlurField, Row, Section } from '../settingsParts'
import { AddEndpointDialog } from './AddEndpointDialog'
import { ApiKeyField } from './ApiKeyField'

// Settings → Models, master–detail (option B of the approved mockup): the endpoints on the left with "+ Add
// endpoint", "ollama.com account" and "Defaults"; the chosen one's settings and models on the right.

type Page = { kind: 'endpoint'; id: string } | { kind: 'account' } | { kind: 'defaults' }
type Status = 'ok' | 'offline' | 'off'

const DOT: Record<Status, string> = { ok: 'bg-success', offline: 'bg-danger', off: 'bg-subtle' }
const STATUS: Record<Status, string> = { ok: 'connected', offline: 'offline', off: 'turned off' }
const CONTEXT_SIZES = [8192, 16384, 32768, 65536, 131072]

const statusOf = (e: Endpoint, errors: ModelListResult['errors']): Status =>
  !e.enabled ? 'off' : errors.some((x) => x.endpointId === e.id) ? 'offline' : 'ok'

/** A window-size menu. A saved size off the list keeps an option of its own. */
function ContextSelect({ value, onChange }: { value: number; onChange: (n: number) => void }) {
  const sizes = [...new Set([...CONTEXT_SIZES, value])].sort((a, b) => a - b)
  return (
    <select
      value={value}
      onChange={(e) => onChange(Number(e.target.value))}
      className="h-9 rounded-ollmost border border-line bg-canvas px-2 text-sm outline-none"
    >
      {sizes.map((n) => (
        <option key={n} value={n}>
          {contextSizeLabel(n)}
        </option>
      ))}
    </select>
  )
}

const THINK_LABELS: Record<ThinkProfile['kind'], string> = {
  toggle: 'On / off',
  levels: 'Effort levels',
  always: 'Always on',
  none: 'Hidden'
}
const THINK_KINDS: ReadonlyArray<ThinkProfile['kind']> = ['toggle', 'levels', 'always', 'none']
// The windows a server can be told a model has, for a model it reports none for (or reports wrongly). CONTEXT_SIZES,
// above, stay the endpoint page's num_ctx and "Context when not reported" choices.
const MODEL_CONTEXT_SIZES = [4_096, 8_192, 16_384, 32_768, 65_536, 131_072, 262_144]
const SELECT = 'h-8 rounded-md border border-line bg-canvas px-1.5 text-xs outline-none'

function OnOff({
  label,
  value,
  auto,
  onChange
}: {
  label: string
  value: boolean | undefined
  auto: boolean
  onChange: (v: boolean | undefined) => void
}) {
  return (
    <select
      aria-label={label}
      value={value === undefined ? 'auto' : value ? 'on' : 'off'}
      onChange={(e) => onChange(e.target.value === 'auto' ? undefined : e.target.value === 'on')}
      className={SELECT}
    >
      <option value="auto">Auto ({auto ? 'on' : 'off'})</option>
      <option value="on">On</option>
      <option value="off">Off</option>
    </select>
  )
}

/** What Ollmost learned from an error, and the way to forget it. */
function Learned({ reason, onRedetect }: { reason?: string; onRedetect: () => void }) {
  return (
    <div className="mt-0.5 max-w-44 text-[11px] leading-tight text-subtle">
      {reason ?? 'learned from an error'} ·{' '}
      <button className="text-accent hover:underline" onClick={onRedetect}>
        Re-detect
      </button>
    </div>
  )
}

function ModelRow({ model }: { model: ModelInfo }) {
  const openai = model.endpoint.kind === 'openai'
  const auto = model.auto ?? { capabilities: model.capabilities, contextWindow: model.contextWindow }
  const autoThink = resolveThinkProfile(model.name, auto.capabilities, undefined, model.thinkPreset ?? undefined)
  // On an OpenAI-compatible server "none" still shows reasoning the server sends; it just offers no control.
  const thinkLabel = (kind: ThinkProfile['kind']) => (kind === 'none' && openai ? 'Show only' : THINK_LABELS[kind])
  // The model read back goes into the store by key; the list's `installed` stays as it was listed.
  const replace = (updated: ModelInfo) =>
    useApp.setState((s) => ({ models: s.models.map((x) => (x.key === updated.key ? { ...updated, installed: x.installed } : x)) }))
  const set = async (patch: ModelOverrides) => {
    try {
      replace(await api.models.setOverrides(model.key, { ...model.overrides, ...patch }))
    } catch (err) {
      reportError(err)
    }
  }
  const redetect = async () => {
    try {
      replace(await api.models.redetect(model.key))
    } catch (err) {
      reportError(err)
    }
  }
  return (
    <tr className="border-t border-line align-top">
      <td className="py-2.5 pr-3">
        <div className="text-[13px] font-medium">{model.endpoint.kind === 'ollama' ? shortModelName(model.name) : model.name}</div>
        <div className="mt-0.5 flex flex-wrap gap-1">
          {model.capabilities
            .filter((c) => c !== 'completion')
            .map((c) => (
              <Badge key={c}>{c}</Badge>
            ))}
          {model.contextWindow ? <Badge>{contextSizeLabel(model.contextWindow)}</Badge> : null}
        </div>
      </td>
      <td className="py-2.5 pr-3">
        {model.capabilities.includes('thinking') || openai ? (
          <select
            aria-label="Thinking"
            value={model.overrides.think ?? 'auto'}
            onChange={(e) => void set({ think: e.target.value === 'auto' ? undefined : (e.target.value as ThinkProfile['kind']) })}
            className={SELECT}
          >
            <option value="auto">Auto ({thinkLabel(autoThink.kind)})</option>
            {THINK_KINDS.map((k) => (
              <option key={k} value={k}>
                {thinkLabel(k)}
              </option>
            ))}
          </select>
        ) : (
          <span className="text-xs text-subtle">n/a</span>
        )}
      </td>
      <td className="py-2.5 pr-3">
        <OnOff
          label="Tools"
          value={model.overrides.tools}
          auto={auto.capabilities.includes('tools')}
          onChange={(tools) => void set({ tools })}
        />
        {model.detected.tools === false && model.overrides.tools === undefined && (
          <Learned reason={model.detected.reason} onRedetect={() => void redetect()} />
        )}
      </td>
      <td className="py-2.5 pr-3">
        <OnOff
          label="Vision"
          value={model.overrides.vision}
          auto={auto.capabilities.includes('vision')}
          onChange={(vision) => void set({ vision })}
        />
      </td>
      <td className="py-2.5 pr-3">
        {model.contextControl === 'server' ? (
          <>
            <select
              aria-label="Context"
              value={model.overrides.contextLength ?? 'auto'}
              onChange={(e) => void set({ contextLength: e.target.value === 'auto' ? undefined : Number(e.target.value) })}
              className={SELECT}
            >
              <option value="auto">Auto ({contextSizeLabel(auto.contextWindow) || 'unknown'})</option>
              {MODEL_CONTEXT_SIZES.map((n) => (
                <option key={n} value={n}>
                  {contextSizeLabel(n)}
                </option>
              ))}
            </select>
            {model.detected.contextLength !== undefined && model.overrides.contextLength === undefined && (
              <Learned reason={model.detected.reason} onRedetect={() => void redetect()} />
            )}
          </>
        ) : (
          // Ollama's own models: the endpoint's num_ctx sets the window.
          <span className="text-xs text-subtle" title="Set by this endpoint’s context window">
            {contextSizeLabel(model.contextWindow)}
          </span>
        )}
      </td>
      <td className="py-2.5 pr-3 text-center">
        <Switch label="Artifacts" checked={model.overrides.artifacts !== false} onChange={(v) => void set({ artifacts: v })} />
      </td>
      <td className="py-2.5 text-center">
        {model.capabilities.includes('tools') ? (
          <Switch label="Auto skills" checked={model.overrides.autoSkills !== false} onChange={(v) => void set({ autoSkills: v })} />
        ) : (
          <span className="text-xs text-subtle">n/a</span>
        )}
      </td>
    </tr>
  )
}

/** An endpoint's own key: kept encrypted, sent only to it. */
function EndpointKeyField({ endpoint }: { endpoint: Endpoint }) {
  const [key, setKey] = useState('')
  const endpointsChanged = useApp((s) => s.endpointsChanged)
  const save = async (value: string | null) => {
    try {
      await api.endpoints.setKey(endpoint.id, value)
      setKey('')
      await endpointsChanged()
    } catch (err) {
      reportError(err)
    }
  }
  return (
    <Field
      label="API key"
      hint={
        endpoint.hasKey
          ? `A key is saved, encrypted with your macOS keychain. It's only ever sent to ${endpoint.name}.`
          : "Only if the server asks for one. It's stored encrypted and only ever sent to this server."
      }
    >
      <div className="flex gap-2">
        <TextField
          type="password"
          value={key}
          onChange={(e) => setKey(e.target.value)}
          placeholder={endpoint.hasKey ? '••••••••••••' : 'None'}
        />
        <Button disabled={!key.trim()} onClick={() => void save(key.trim())}>
          Save
        </Button>
        {endpoint.hasKey && (
          <Button variant="ghost" onClick={() => void save(null)}>
            Remove
          </Button>
        )}
      </div>
    </Field>
  )
}

function EndpointPage({ endpoint, onAccount }: { endpoint: Endpoint; onAccount: () => void }) {
  const models = useApp((s) => s.models)
  const modelErrors = useApp((s) => s.modelErrors)
  const modelsLoading = useApp((s) => s.modelsLoading)
  const loadModels = useApp((s) => s.loadModels)
  const endpointsChanged = useApp((s) => s.endpointsChanged)
  const cloud = isOllamaCloudUrl(endpoint.baseUrl)
  const error = modelErrors.find((x) => x.endpointId === endpoint.id)?.message
  const mine = models.filter((m) => m.endpoint.id === endpoint.id)
  // Bumped so a field remounts showing what's stored, not the text typed: the name's when a name edit is refused, the
  // address's when an address edit is refused or saved (an OpenAI endpoint stores its probed base, not what was typed).
  // Apart, so an address probe finishing doesn't remount a name being typed.
  const [nameRev, setNameRev] = useState(0)
  const [addressRev, setAddressRev] = useState(0)

  const update = async (patch: Parameters<typeof api.endpoints.update>[1]) => {
    try {
      await api.endpoints.update(endpoint.id, patch)
      await endpointsChanged()
      if ('baseUrl' in patch) setAddressRev((n) => n + 1)
    } catch (err) {
      if ('name' in patch) setNameRev((n) => n + 1)
      if ('baseUrl' in patch) setAddressRev((n) => n + 1)
      reportError(err)
    }
  }
  const remove = async () => {
    try {
      const { title, body } = removalText(endpoint.name, await api.endpoints.removalImpact(endpoint.id))
      if (!(await useConfirm.getState().ask({ title, body, confirmLabel: 'Remove' }))) return
      await api.endpoints.remove(endpoint.id)
      await endpointsChanged()
    } catch (err) {
      reportError(err)
    }
  }

  return (
    <>
      <Section
        title={endpoint.name}
        description={`${FLAVOR_LABELS[endpoint.flavor]} at ${displayAddress(endpoint.baseUrl)} · ${STATUS[statusOf(endpoint, modelErrors)]}`}
      >
        <Field label="Name">
          <BlurField key={`name-${nameRev}`} value={endpoint.name} onSave={(name) => void update({ name })} />
        </Field>
        <Field label="Address">
          <BlurField
            key={`address-${addressRev}`}
            value={endpoint.baseUrl}
            onSave={(baseUrl) => void update({ baseUrl })}
            placeholder="http://127.0.0.1:11434"
          />
        </Field>
        {cloud ? (
          <Row label="API key" hint="ollama.com takes your ollama.com account key.">
            <Button size="sm" variant="ghost" onClick={onAccount}>
              ollama.com account
            </Button>
          </Row>
        ) : (
          <EndpointKeyField endpoint={endpoint} />
        )}
        {endpoint.kind === 'ollama' && !cloud && (
          <>
            <Row
              label="Context window"
              hint="Ollama's num_ctx for the models this server runs. Bigger remembers more but uses more memory."
            >
              <ContextSelect value={endpoint.numCtx ?? DEFAULT_NUM_CTX} onChange={(numCtx) => void update({ numCtx })} />
            </Row>
            <Row label="Show the Ollama cloud catalog" hint="List every cloud model, not only ones you've pulled.">
              <Switch checked={endpoint.showCloudCatalog ?? false} onChange={(showCloudCatalog) => void update({ showCloudCatalog })} />
            </Row>
          </>
        )}
        {endpoint.kind === 'openai' && (
          <Row label="Context when not reported" hint="The window assumed for a model whose server doesn't say.">
            <ContextSelect
              value={endpoint.defaultContext ?? DEFAULT_CONTEXT}
              onChange={(defaultContext) => void update({ defaultContext })}
            />
          </Row>
        )}
        <Row label="Enabled" hint="A turned-off endpoint's models leave the model picker; its chats keep their history.">
          <Switch checked={endpoint.enabled} onChange={(enabled) => void update({ enabled })} />
        </Row>
        <div>
          <Button size="sm" onClick={() => void remove()}>
            <Trash2 className="size-3.5 text-danger" /> Remove…
          </Button>
        </div>
      </Section>

      <Section
        title={`Models on ${endpoint.name}`}
        description="Thinking controls adapt to each model. Turn off artifacts or automatic skills for models that handle them poorly."
      >
        <div className="flex items-center gap-2">
          <Button size="sm" onClick={() => void loadModels(true)} loading={modelsLoading}>
            {!modelsLoading && <RefreshCw className="size-3.5" />} Refresh models
          </Button>
          {error && <span className="text-xs text-danger">{error}</span>}
        </div>
        {mine.length > 0 ? (
          <div className="overflow-x-auto">
            <table className="w-full text-left">
              <thead>
                <tr className="text-xs text-subtle">
                  <th className="pb-2 font-medium">Model</th>
                  <th className="pb-2 font-medium">Thinking</th>
                  <th className="pb-2 font-medium">Tools</th>
                  <th className="pb-2 font-medium">Vision</th>
                  <th className="pb-2 font-medium">Context</th>
                  <th className="pb-2 text-center font-medium">Artifacts</th>
                  <th className="pb-2 text-center font-medium">Auto skills</th>
                </tr>
              </thead>
              <tbody>
                {mine.map((m) => (
                  <ModelRow key={m.key} model={m} />
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          !error && (
            <p className="text-sm text-subtle">
              {endpoint.enabled ? 'This endpoint lists no models.' : 'Turn the endpoint on to list its models.'}
            </p>
          )
        )}
      </Section>
    </>
  )
}

function AccountPage({ settings }: { settings: Settings }) {
  const loadModels = useApp((s) => s.loadModels)
  return (
    <Section
      title="ollama.com account"
      description="Web search and page reading (for any model), your Ollama quota, and Ollama cloud models. Searches go through ollama.com even when the model runs on this Mac."
    >
      <ApiKeyField hasKey={settings.ollamaAccount.hasKey} onSaved={() => void loadModels(true)} />
    </Section>
  )
}

/** A default-model menu: each endpoint's models under its name, and a saved model that isn't listed marked as such. */
function ModelSelect({
  value,
  onChange,
  emptyLabel,
  endpoints
}: {
  value: string | null
  onChange: (key: string | null) => void
  emptyLabel: string
  endpoints: Endpoint[]
}) {
  const models = useApp((s) => s.models)
  return (
    <select
      value={value ?? ''}
      onChange={(e) => onChange(e.target.value || null)}
      className="h-9 w-64 rounded-ollmost border border-line bg-canvas px-2 text-sm outline-none"
    >
      <option value="">{emptyLabel}</option>
      {value && !models.some((m) => m.key === value) && <option value={value}>{labelForKey(value, endpoints)} (unavailable)</option>}
      {endpoints.map((e) => {
        const items = models.filter((m) => m.endpoint.id === e.id)
        return (
          items.length > 0 && (
            <optgroup key={e.id} label={e.name}>
              {items.map((m) => (
                <option key={m.key} value={m.key}>
                  {m.endpoint.kind === 'ollama' ? shortModelName(m.name) : m.name}
                  {m.where === 'cloud' ? ' (cloud)' : ''}
                </option>
              ))}
            </optgroup>
          )
        )
      })}
    </select>
  )
}

function DefaultsPage({ settings }: { settings: Settings }) {
  const updateSettings = useApp((s) => s.updateSettings)
  return (
    <Section title="Defaults">
      <Row label="Default model" hint="Used for new chats.">
        <ModelSelect
          value={settings.defaultModel}
          onChange={(defaultModel) => void updateSettings({ defaultModel })}
          emptyLabel="Last used"
          endpoints={settings.endpoints}
        />
      </Row>
      <Row label="Title model" hint="Names new chats. A small, fast model works well.">
        <ModelSelect
          value={settings.titleModel}
          onChange={(titleModel) => void updateSettings({ titleModel })}
          emptyLabel="Same as the chat"
          endpoints={settings.endpoints}
        />
      </Row>
    </Section>
  )
}

export function EndpointsPane({ settings }: { settings: Settings }) {
  const modelErrors = useApp((s) => s.modelErrors)
  const endpointsChanged = useApp((s) => s.endpointsChanged)
  const [page, setPage] = useState<Page>(() =>
    settings.endpoints[0] ? { kind: 'endpoint', id: settings.endpoints[0].id } : { kind: 'defaults' }
  )
  const [adding, setAdding] = useState(false)
  // A removed endpoint's page falls back to the first one left.
  const shown = page.kind === 'endpoint' ? (settings.endpoints.find((e) => e.id === page.id) ?? settings.endpoints[0]) : undefined
  const item = (active: boolean) =>
    cn(
      'flex h-8 w-full items-center gap-2 rounded-lg px-2 text-left text-[13px]',
      active ? 'bg-hover font-medium text-fg' : 'text-muted hover:bg-hover hover:text-fg'
    )

  return (
    <div className="flex gap-6">
      <nav aria-label="Endpoints" className="w-40 shrink-0 space-y-0.5 border-r border-line pr-3">
        {settings.endpoints.map((e) => (
          <button key={e.id} className={item(shown?.id === e.id)} onClick={() => setPage({ kind: 'endpoint', id: e.id })}>
            <span className={cn('size-2 shrink-0 rounded-full', DOT[statusOf(e, modelErrors)])} />
            <span className="truncate">{e.name}</span>
          </button>
        ))}
        <button className={item(false)} onClick={() => setAdding(true)}>
          <Plus className="size-3.5" /> Add endpoint
        </button>
        <div className="my-2 border-t border-line" />
        <button className={item(page.kind === 'account')} onClick={() => setPage({ kind: 'account' })}>
          ollama.com account
        </button>
        <button className={item(page.kind === 'defaults')} onClick={() => setPage({ kind: 'defaults' })}>
          Defaults
        </button>
      </nav>
      <div className="min-w-0 flex-1">
        {page.kind === 'endpoint' &&
          (shown ? (
            <EndpointPage key={shown.id} endpoint={shown} onAccount={() => setPage({ kind: 'account' })} />
          ) : (
            <p className="text-sm text-subtle">No endpoints yet. Add one to use its models.</p>
          ))}
        {page.kind === 'account' && <AccountPage settings={settings} />}
        {page.kind === 'defaults' && <DefaultsPage settings={settings} />}
      </div>
      <AddEndpointDialog
        open={adding}
        onOpenChange={setAdding}
        onAdded={async (e) => {
          await endpointsChanged()
          setPage({ kind: 'endpoint', id: e.id })
        }}
      />
    </div>
  )
}
