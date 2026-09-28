import { Download, Monitor, Moon, Palette, Pencil, RefreshCw, Sun, Trash2, Upload } from 'lucide-react'
import { useEffect, useState } from 'react'
import { usesDark } from '@shared/themes'
import { labelForKey, shortModelName } from '@shared/modelLabel'
import type { PriceTable, Settings, ThemeDef, UsageSummary } from '@shared/types'
import { creditPool, formatDollars, formatPercent, spendPeriod } from '@shared/usage'
import { ThemeEditor } from '@/components/ThemeEditor'
import { TopBar } from '@/components/TopBar'
import { Badge, Button, Field, Spinner, Switch } from '@/components/ui'
import { api } from '@/lib/api'
import { cn, formatTokens } from '@/lib/format'
import { reportError, type SettingsTab, useApp } from '@/stores/app'
import { useUsage } from '@/stores/usage'
import { useSystemDark } from '@/theme/useTheme'
import { ApiKeyField } from './settings/ApiKeyField'
import { EndpointsPane } from './settings/EndpointsPane'
import { BlurField, Row, Section, Segmented } from './settingsParts'
import { ToolsTab } from './ToolsSettings'

const TABS: Array<{ id: SettingsTab; label: string }> = [
  { id: 'general', label: 'General' },
  { id: 'appearance', label: 'Appearance' },
  { id: 'models', label: 'Models' },
  { id: 'usage', label: 'Usage & cost' },
  { id: 'features', label: 'Web, artifacts & skills' },
  { id: 'tools', label: 'Tools' },
  { id: 'data', label: 'Data' }
]

export function SettingsView({ tab = 'general' }: { tab?: SettingsTab }) {
  const { settings, navigate } = useApp()
  if (!settings)
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner />
      </div>
    )
  return (
    <div className="flex h-full flex-col">
      <TopBar />
      <div className="flex min-h-0 flex-1 overflow-y-auto">
        <div className={cn('mx-auto flex w-full gap-10 px-8 pb-16 pt-4', tab === 'models' ? 'max-w-5xl' : 'max-w-4xl')}>
          <nav className="w-44 shrink-0">
            <h1 className="mb-4 px-2 font-reading text-2xl font-medium tracking-tight">Settings</h1>
            {TABS.map((t) => (
              <button
                key={t.id}
                onClick={() => navigate({ name: 'settings', tab: t.id })}
                className={cn(
                  'flex h-8 w-full items-center rounded-lg px-2 text-left text-[13px]',
                  tab === t.id ? 'bg-hover font-medium text-fg' : 'text-muted hover:bg-hover hover:text-fg'
                )}
              >
                {t.label}
              </button>
            ))}
          </nav>
          <div className="min-w-0 flex-1 pt-12">
            {tab === 'general' && <GeneralTab settings={settings} />}
            {tab === 'appearance' && <AppearanceTab settings={settings} />}
            {tab === 'models' && <EndpointsPane settings={settings} />}
            {tab === 'usage' && <UsageTab settings={settings} />}
            {tab === 'features' && <FeaturesTab settings={settings} />}
            {tab === 'tools' && <ToolsTab />}
            {tab === 'data' && <DataTab />}
          </div>
        </div>
      </div>
    </div>
  )
}

function GeneralTab({ settings }: { settings: Settings }) {
  const update = useApp((s) => s.updateSettings)
  return (
    <>
      <Section title="Profile">
        <Field label="What should Ollmost call you?">
          <BlurField value={settings.userName} onSave={(userName) => update({ userName })} placeholder="Your name" />
        </Field>
        <Field label="Personal preferences" hint="Included in every chat. Describe your background and how you like responses.">
          <BlurField
            multiline
            rows={6}
            value={settings.preferences}
            onSave={(preferences) => update({ preferences })}
            placeholder="e.g. I'm a data engineer. Prefer concise answers with code in Python. Use British spelling."
          />
        </Field>
      </Section>
    </>
  )
}

function ThemeSwatch({
  theme,
  dark,
  selected,
  onSelect,
  onEdit,
  onDelete
}: {
  theme: ThemeDef
  dark: boolean
  selected: boolean
  onSelect: () => void
  onEdit: () => void
  onDelete?: () => void
}) {
  const p = dark ? theme.dark : theme.light
  const font = theme.fonts.ui
  return (
    <div
      className={cn(
        'group overflow-hidden rounded-ollmost-lg border-2 transition-colors',
        selected ? 'border-accent' : 'border-line hover:border-line-strong'
      )}
    >
      <button onClick={onSelect} className="block w-full text-left" aria-label={`Use ${theme.name} theme`}>
        <div className="flex h-20" style={{ background: p.canvas }}>
          <div className="w-1/4 border-r" style={{ background: p.sidebar, borderColor: p.line }} />
          <div className="flex flex-1 flex-col justify-center gap-1.5 px-3">
            <div className="h-2 w-3/4 rounded-full" style={{ background: p.fg, opacity: 0.8 }} />
            <div className="h-2 w-1/2 rounded-full" style={{ background: p.muted, opacity: 0.6 }} />
            <div className="ml-auto mt-1 h-4 w-8 rounded" style={{ background: p.accent }} />
          </div>
        </div>
      </button>
      <div className="flex items-center justify-between bg-panel px-3 py-2">
        <span className="flex min-w-0 items-baseline gap-1.5">
          <span className="truncate text-[13px] font-medium" style={{ fontFamily: font }}>
            {theme.name}
          </span>
          {theme.only && <span className="shrink-0 text-[11px] text-subtle">{theme.only} only</span>}
        </span>
        <span className="flex gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
          <button onClick={onEdit} aria-label="Customize" className="rounded p-1 text-subtle hover:bg-hover hover:text-fg">
            <Pencil className="size-3.5" />
          </button>
          {onDelete && (
            <button onClick={onDelete} aria-label="Delete theme" className="rounded p-1 text-subtle hover:bg-hover hover:text-danger">
              <Trash2 className="size-3.5" />
            </button>
          )}
        </span>
      </div>
    </div>
  )
}

function AppearanceTab({ settings }: { settings: Settings }) {
  const { themes, updateSettings, loadThemes, toast } = useApp()
  const [editing, setEditing] = useState<ThemeDef | null>(null)
  const a = settings.appearance
  const systemDark = useSystemDark()
  const setAppearance = (patch: Partial<Settings['appearance']>) => updateSettings({ appearance: patch })
  const current = themes.find((t) => t.id === a.themeId) ?? themes[0]

  return (
    <>
      <Section title="Mode">
        <Segmented
          value={a.mode}
          onChange={(mode) => setAppearance({ mode })}
          options={[
            { value: 'system', label: 'System', icon: <Monitor className="size-3.5" /> },
            { value: 'light', label: 'Light', icon: <Sun className="size-3.5" /> },
            { value: 'dark', label: 'Dark', icon: <Moon className="size-3.5" /> }
          ]}
        />
        {current?.only && (
          <p className="text-xs text-subtle">
            {current.name} has only a {current.only} palette, so it stays {current.only} whatever the mode. Other themes follow this
            setting.
          </p>
        )}
      </Section>

      <Section title="Theme" description="Pick a theme, or customize any of them: colours, fonts and corner radius.">
        <div className="grid grid-cols-3 gap-3">
          {themes.map((t) => (
            <ThemeSwatch
              key={t.id}
              theme={t}
              dark={usesDark(t, a.mode, systemDark)}
              selected={t.id === a.themeId}
              onSelect={() => setAppearance({ themeId: t.id })}
              onEdit={() => setEditing(t)}
              onDelete={
                t.builtin
                  ? undefined
                  : async () => {
                      await api.themes.delete(t.id)
                      if (a.themeId === t.id) await setAppearance({ themeId: 'claude' })
                      await loadThemes()
                    }
              }
            />
          ))}
        </div>
        <div className="flex gap-2">
          <Button size="sm" onClick={() => current && setEditing(current)}>
            <Palette className="size-3.5" /> Customize current
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={async () => {
              try {
                const t = await api.themes.importTheme()
                if (t) {
                  await loadThemes()
                  await setAppearance({ themeId: t.id })
                  toast(`Imported “${t.name}”`)
                }
              } catch (err) {
                reportError(err)
              }
            }}
          >
            <Upload className="size-3.5" /> Import
          </Button>
          <Button size="sm" variant="ghost" onClick={() => current && api.themes.exportTheme(current).catch(reportError)}>
            <Download className="size-3.5" /> Export current
          </Button>
        </div>
      </Section>

      <Section title="Reading">
        <Row label="Reply font">
          <Segmented
            value={a.responseFont}
            onChange={(responseFont) => setAppearance({ responseFont })}
            options={[
              { value: 'reading', label: 'Serif' },
              { value: 'ui', label: 'Sans' }
            ]}
          />
        </Row>
        <Row label={`Text size: ${a.fontSize}px`}>
          <input
            type="range"
            min={13}
            max={20}
            value={a.fontSize}
            onChange={(e) => setAppearance({ fontSize: Number(e.target.value) })}
            className="w-48 accent-[var(--o-accent)]"
          />
        </Row>
        <Row label={`Chat width: ${a.chatWidth}px`}>
          <input
            type="range"
            min={600}
            max={1100}
            step={20}
            value={a.chatWidth}
            onChange={(e) => setAppearance({ chatWidth: Number(e.target.value) })}
            className="w-48 accent-[var(--o-accent)]"
          />
        </Row>
      </Section>

      {editing && <ThemeEditor base={editing} open={!!editing} onClose={() => setEditing(null)} />}
    </>
  )
}

const toLocalInput = (ts: number) => {
  const d = new Date(ts - new Date(ts).getTimezoneOffset() * 60_000)
  return d.toISOString().slice(0, 16)
}

function RawUsage({ refreshKey }: { refreshKey: number }) {
  const [raw, setRaw] = useState<{ at: number; json: unknown } | null>(null)
  useEffect(() => {
    void api.usage.raw().then(setRaw)
  }, [refreshKey])
  if (!raw) return null
  return (
    <details className="-mt-2 mb-2 text-xs text-subtle">
      <summary className="cursor-pointer select-none hover:text-fg">
        Raw response from ollama.com ({new Date(raw.at).toLocaleString()})
      </summary>
      <pre className="selectable mt-2 max-h-72 overflow-auto rounded-ollmost border border-line bg-code p-3 font-mono text-[11px] text-muted">
        {JSON.stringify(raw.json, null, 2)}
      </pre>
    </details>
  )
}

function UsageTab({ settings }: { settings: Settings }) {
  const { account, loading, load } = useUsage()
  const update = useApp((s) => s.updateSettings)
  const loadModels = useApp((s) => s.loadModels)
  const [prices, setPrices] = useState<PriceTable | null>(null)
  const [summary, setSummary] = useState<UsageSummary | null>(null)
  const [refreshingPrices, setRefreshingPrices] = useState(false)
  const u = settings.usage
  const weekly = account?.windows.find((w) => w.id === 'weekly')
  const defaultPool = creditPool(account?.plan ?? null, null)
  const activity = (account?.windows ?? []).filter((w) => w.models.length > 0)
  const anchor = u.anchors.weekly

  // The same period as the popover's Ollmost line, so the two say the same thing.
  const period = account ? spendPeriod(account) : null
  const since = period?.since ?? null
  const until = period?.until ?? null
  useEffect(() => {
    void api.usage.prices().then(setPrices)
    void load(true)
  }, [load])
  useEffect(() => {
    void api.usage.summary(30, since ?? undefined, until).then(setSummary)
  }, [since, until])

  const setAnchors = async (patch: Settings['usage']['anchors']) => {
    await update({ usage: { anchors: patch } })
    await load(true)
  }

  return (
    <>
      <Section
        title="Ollama account"
        description="Quota numbers come from ollama.com and need an API key. Token counts and cost estimates for your chats work without one."
      >
        <ApiKeyField hasKey={settings.ollamaAccount.hasKey} />
        <div className="flex items-center gap-2 text-xs text-subtle">
          <Button size="sm" variant="ghost" loading={loading} onClick={() => load(true)}>
            {!loading && <RefreshCw className="size-3.5" />} Check now
          </Button>
          {account?.plan && <Badge tone="accent">{account.plan} plan</Badge>}
          {account?.error ? (
            <span className="text-danger">{account.error}</span>
          ) : (
            account?.windows.map((w) => (
              <span key={w.id}>
                {w.label}: {formatPercent(w.usage)}
              </span>
            ))
          )}
        </div>
      </Section>

      <RawUsage refreshKey={account?.fetchedAt ?? 0} />

      <Section
        title="Plan & reset times"
        description="Ollama's API doesn't say when limits reset. Ollmost works it out the first time it sees your usage drop, or you can copy the time from ollama.com/settings."
      >
        <Row
          label="Weekly limit resets"
          hint={
            anchor
              ? anchor.source === 'configured'
                ? 'Set by you. Repeats every 7 days.'
                : `Detected when usage dropped, around ${new Date(anchor.at).toLocaleString()}. Repeats every 7 days.`
              : 'Not known yet.'
          }
        >
          <div className="flex items-center gap-2">
            <input
              type="datetime-local"
              value={weekly?.resetAt ? toLocalInput(weekly.resetAt) : anchor ? toLocalInput(anchor.at) : ''}
              onChange={(e) => e.target.value && setAnchors({ weekly: { at: new Date(e.target.value).getTime(), source: 'configured' } })}
              className="h-9 rounded-ollmost border border-line bg-canvas px-2 text-sm outline-none"
            />
            {anchor && (
              <Button size="sm" variant="ghost" onClick={() => setAnchors({ weekly: null })}>
                Clear
              </Button>
            )}
          </div>
        </Row>
        <Row
          label="Monthly credit pool"
          hint={`Turns the monthly % into dollars. Leave blank to use your plan's published pool${defaultPool ? ` ($${defaultPool} for ${account?.plan})` : ''}.`}
        >
          <input
            type="number"
            min={1}
            step={1}
            value={u.poolUsd ?? ''}
            placeholder={defaultPool ? String(defaultPool) : '—'}
            onChange={async (e) => {
              await update({ usage: { poolUsd: e.target.value ? Math.max(1, Number(e.target.value)) : null } })
              await load(true)
            }}
            className="h-9 w-24 rounded-ollmost border border-line bg-canvas px-2 text-sm outline-none"
          />
        </Row>
        <Row label="Monthly credits refresh on day" hint="For credit-based plans, which reset on the day your subscription started.">
          <input
            type="number"
            min={1}
            max={31}
            value={u.monthlyDay ?? ''}
            placeholder="—"
            onChange={(e) => update({ usage: { monthlyDay: e.target.value ? Math.min(31, Math.max(1, Number(e.target.value))) : null } })}
            className="h-9 w-20 rounded-ollmost border border-line bg-canvas px-2 text-sm outline-none"
          />
        </Row>
      </Section>

      <Section title="Title bar">
        <Row label="Show quota and chat cost in the title bar">
          <Switch checked={u.showInHeader} onChange={(showInHeader) => update({ usage: { showInHeader } })} />
        </Row>
        <Row label="Quota shown" hint="Automatic shows the weekly limit when Ollama reports one.">
          <select
            value={u.headerWindow}
            onChange={(e) => update({ usage: { headerWindow: e.target.value } })}
            className="h-9 rounded-ollmost border border-line bg-canvas px-2 text-sm outline-none"
          >
            <option value="auto">Automatic</option>
            {(account?.windows ?? []).map((w) => (
              <option key={w.id} value={w.id}>
                {w.label}
              </option>
            ))}
          </select>
        </Row>
      </Section>

      {activity.length > 0 && (
        <Section
          title="Ollama activity, all apps"
          description="Requests per model as reported by ollama.com, including apps other than Ollmost."
        >
          {activity.map((w) => (
            <table key={w.id} className="w-full text-[13px] tabular-nums">
              <thead>
                <tr className="text-xs text-subtle">
                  <th className="pb-2 text-left font-medium">{w.label} window</th>
                  <th className="pb-2 text-right font-medium">Requests</th>
                </tr>
              </thead>
              <tbody>
                {w.models.map((m) => (
                  <tr key={m.name} className="border-t border-line">
                    <td className="py-1.5">{shortModelName(m.name)}</td>
                    <td className="py-1.5 text-right">{m.requests.toLocaleString()}</td>
                  </tr>
                ))}
                <tr className="border-t border-line-strong font-medium">
                  <td className="py-1.5">Total</td>
                  <td className="py-1.5 text-right">{w.models.reduce((n, m) => n + m.requests, 0).toLocaleString()}</td>
                </tr>
              </tbody>
            </table>
          ))}
        </Section>
      )}

      <Section
        title={`Spend in Ollmost, ${period?.label ?? 'last 30 days'}`}
        description="From token counts Ollmost recorded, every prompt token at the full rate, so an upper bound: Ollama charges cached prompt tokens far less. Other apps using your Ollama account aren't included."
      >
        {summary && summary.total.requests > 0 ? (
          <table className="w-full text-[13px] tabular-nums">
            <thead>
              <tr className="text-xs text-subtle">
                <th className="pb-2 text-left font-medium">Model</th>
                <th className="pb-2 text-right font-medium">Requests</th>
                <th className="pb-2 text-right font-medium">Input</th>
                <th className="pb-2 text-right font-medium">Output</th>
                <th className="pb-2 text-right font-medium">Cost</th>
              </tr>
            </thead>
            <tbody>
              {summary.byModel.map((m) => (
                <tr key={m.model} className="border-t border-line">
                  <td className="py-1.5">{labelForKey(m.model, settings.endpoints)}</td>
                  <td className="py-1.5 text-right">{m.requests}</td>
                  <td className="py-1.5 text-right">{formatTokens(m.promptTokens)}</td>
                  <td className="py-1.5 text-right">{formatTokens(m.completionTokens)}</td>
                  <td className="py-1.5 text-right">{m.costUsd === 0 ? 'local' : formatDollars(m.costUsd)}</td>
                </tr>
              ))}
              <tr className="border-t border-line-strong font-medium">
                <td className="py-1.5">Total</td>
                <td className="py-1.5 text-right">{summary.total.requests}</td>
                <td className="py-1.5 text-right">{formatTokens(summary.total.promptTokens)}</td>
                <td className="py-1.5 text-right">{formatTokens(summary.total.completionTokens)}</td>
                <td className="py-1.5 text-right">{formatDollars(summary.total.costUsd)}</td>
              </tr>
            </tbody>
          </table>
        ) : (
          <p className="text-sm text-subtle">No requests recorded yet.</p>
        )}
      </Section>

      <Section
        title="Prices"
        description={
          prices
            ? `Per million tokens, ${prices.source === 'ollama.com' ? 'read from ollama.com/pricing' : 'from the snapshot bundled with Ollmost'} (updated ${new Date(prices.updatedAt).toLocaleDateString()}). Estimates use the full input rate.`
            : undefined
        }
      >
        <Button
          size="sm"
          loading={refreshingPrices}
          onClick={async () => {
            setRefreshingPrices(true)
            try {
              setPrices(await api.usage.refreshPrices())
              await loadModels(true)
            } finally {
              setRefreshingPrices(false)
            }
          }}
        >
          {!refreshingPrices && <RefreshCw className="size-3.5" />} Refresh from ollama.com
        </Button>
        {prices && (
          <table className="w-full text-[13px] tabular-nums">
            <thead>
              <tr className="text-xs text-subtle">
                <th className="pb-2 text-left font-medium">Model</th>
                <th className="pb-2 text-right font-medium">Input</th>
                <th className="pb-2 text-right font-medium">Cached input</th>
                <th className="pb-2 text-right font-medium">Output</th>
              </tr>
            </thead>
            <tbody>
              {Object.entries(prices.prices)
                .sort(([a], [b]) => a.localeCompare(b))
                .map(([name, p]) => (
                  <tr key={name} className="border-t border-line">
                    <td className="py-1.5">{name}</td>
                    <td className="py-1.5 text-right">${p.input.toFixed(2)}</td>
                    <td className="py-1.5 text-right">{p.cachedInput === null ? '—' : `$${p.cachedInput}`}</td>
                    <td className="py-1.5 text-right">${p.output.toFixed(2)}</td>
                  </tr>
                ))}
            </tbody>
          </table>
        )}
      </Section>
    </>
  )
}

function FeaturesTab({ settings }: { settings: Settings }) {
  const update = useApp((s) => s.updateSettings)
  return (
    <>
      <Section title="Artifacts" description="Documents, code, web pages, SVGs and diagrams open in a side panel next to the chat.">
        <Row label="Create artifacts" hint="Adds artifact instructions to the system prompt.">
          <Switch checked={settings.artifacts.enabled} onChange={(enabled) => update({ artifacts: { enabled } })} />
        </Row>
        <Row
          label="Let web pages load libraries from CDNs"
          hint="Allows scripts from cdnjs, jsDelivr and unpkg. Pages still can't make network requests or reach your files."
        >
          <Switch checked={settings.artifacts.allowCdn} onChange={(allowCdn) => update({ artifacts: { allowCdn } })} />
        </Row>
      </Section>
      <Section
        title="Web search"
        description="Models that support tools can search the web and read pages through Ollama's web API. Pages are fetched by ollama.com, not this Mac, and searches count toward your Ollama usage."
      >
        <Row
          label="Let models search the web and read pages"
          hint={
            settings.ollamaAccount.hasKey ? (
              'Uses your saved ollama.com API key.'
            ) : (
              <>
                Needs an ollama.com API key.{' '}
                <button
                  className="text-accent hover:underline"
                  onClick={() => useApp.getState().navigate({ name: 'settings', tab: 'usage' })}
                >
                  Add one in Usage & cost
                </button>
              </>
            )
          }
        >
          <Switch checked={settings.web.enabled} onChange={(enabled) => update({ web: { enabled } })} />
        </Row>
        <Row
          label="Show page previews when hovering links"
          hint="Hovering a link always shows where it goes. With this on, Ollmost also fetches the page's title and image from this Mac, which lets the site know you looked. Local-network addresses are never fetched, and neither are links in chats with tools or files, where a link could carry their contents out."
        >
          <Switch checked={settings.links.previews} onChange={(previews) => update({ links: { previews } })} />
        </Row>
      </Section>
      <Section title="Skills">
        <Row
          label="Load skills automatically"
          hint="Models that support tools can load a matching skill on their own. You can still add skills with / or the + menu."
        >
          <Switch checked={settings.skills.autoLoad} onChange={(autoLoad) => update({ skills: { autoLoad } })} />
        </Row>
        <Row label="Include Ollama skills" hint="Read-only, from ~/.ollama/skills">
          <Switch
            checked={settings.skills.sources.ollama}
            onChange={(ollama) => update({ skills: { sources: { ...settings.skills.sources, ollama } } })}
          />
        </Row>
        <Row
          label="Include Claude skills"
          hint="Read-only, from ~/.claude/skills. Each starts switched off, since many rely on tools only Claude has. Turn on the ones you want on the Skills page."
        >
          <Switch
            checked={settings.skills.sources.claude}
            onChange={(claude) => update({ skills: { sources: { ...settings.skills.sources, claude } } })}
          />
        </Row>
      </Section>
    </>
  )
}

function DataTab() {
  const [info, setInfo] = useState<{ version: string; dataDir: string } | null>(null)
  const { settings, updateSettings, toast } = useApp()
  useEffect(() => {
    void api.app.info().then(setInfo)
  }, [])
  return (
    <>
      <Section
        title="Debugger"
        description="Ollmost can record every request it sends (each chat round, tool call and title) so you can inspect it in the debugger window. Traces include your messages and are stored locally; deleting a chat deletes its traces, and only the newest 500 are kept."
      >
        <Row label="Record requests for the debugger">
          <Switch checked={!!settings?.debug.record} onChange={(record) => updateSettings({ debug: { record } })} />
        </Row>
        <div className="flex gap-2">
          <Button size="sm" onClick={() => api.debug.open(null)}>
            Open debugger
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={async () => {
              await api.debug.clear(null)
              toast('Debug traces cleared')
            }}
          >
            Clear all traces
          </Button>
        </div>
      </Section>
      <Section title="Your data" description="Everything stays on this Mac: chats, projects and files live in a local SQLite database.">
        <Row label="Data folder" hint={<span className="font-mono">{info?.dataDir}</span>}>
          <Button size="sm" onClick={() => api.app.openDataFolder()}>
            Open
          </Button>
        </Row>
        <Row label="Version">
          <span className="text-sm text-muted">{info?.version}</span>
        </Row>
      </Section>
    </>
  )
}
