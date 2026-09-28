import { CircleCheck, CircleEqual, CircleHelp, ExternalLink, Gauge, KeyRound, RefreshCw, TriangleAlert } from 'lucide-react'
import { useEffect, useState } from 'react'
import { formatDollars, formatPercent, formatTimeLeft, type Pace, type PaceStatus, paceOf, spendPeriod } from '@shared/usage'
import type { AccountUsage, ChatUsage, UsageSummary, UsageWindow } from '@shared/types'
import { withPreview } from '@shared/settingsPreview'
import { billingLabel, chatCostLabel } from '@shared/billing'
import { modelLabel, shortModelName } from '@shared/modelLabel'
import { api } from '@/lib/api'
import { cn, contextSizeLabel, formatTokens, relativeTime } from '@/lib/format'
import { contextWindowFor, findModel, useApp } from '@/stores/app'
import { useUsage } from '@/stores/usage'
import { PopoverContent, PopoverRoot, PopoverTrigger, Spinner } from './ui'

const chip =
  'flex h-7 items-center gap-2 rounded-lg px-2 text-xs text-muted transition-colors hover:bg-hover hover:text-fg data-[state=open]:bg-hover'

/** Which window the title bar shows: the user's pick, else the longest one reported. */
export function headlineWindow(account: AccountUsage | null, preference: string): UsageWindow | null {
  const windows = account?.windows ?? []
  return windows.find((w) => w.id === preference) ?? windows.find((w) => w.id === 'weekly') ?? windows.at(-1) ?? null
}

function periodPhrase(windowId: string): string {
  return windowId === 'monthly' ? 'this month' : windowId === 'weekly' ? 'this week' : windowId === 'session' ? 'this session' : windowId
}

export const PACE_META: Record<PaceStatus, { label: string; icon: typeof CircleCheck; text: string; fill: string }> = {
  under: { label: 'Under pace', icon: CircleCheck, text: 'text-success', fill: 'bg-success' },
  'on-track': { label: 'On pace', icon: CircleEqual, text: 'text-warn', fill: 'bg-warn' },
  over: { label: 'Over pace', icon: TriangleAlert, text: 'text-danger', fill: 'bg-danger' },
  unknown: { label: 'Pace unknown', icon: CircleHelp, text: 'text-subtle', fill: 'bg-accent' }
}

/** Usage fill coloured by pace, with a tick at the target: where you'd be if you spread usage evenly. */
function Meter({ window: w, pace, wide }: { window: UsageWindow; pace: Pace; wide?: boolean }) {
  return (
    <span className={cn('relative block overflow-hidden rounded-full bg-hover', wide ? 'h-2 w-full' : 'h-1.5 w-12')}>
      <span
        className={cn('absolute inset-y-0 left-0 rounded-full', PACE_META[pace.status].fill)}
        style={{ width: `${Math.min(100, w.usage * 100)}%` }}
      />
      {pace.target !== null && (
        <span
          className="absolute inset-y-0 w-0.5 bg-fg/60"
          style={{ left: `calc(${pace.target * 100}% - 1px)` }}
          title="Target: an even share of the allowance for the time gone"
        />
      )}
    </span>
  )
}

function paceSentence(w: UsageWindow, pace: Pace, now: number): string {
  const projected = pace.projected === null ? '' : `${Math.round(pace.projected * 100)}%`
  switch (pace.status) {
    case 'under':
      return `You're below the target of ${formatPercent(pace.target!)} for this point. At this rate you'll use about ${projected} by the reset.`
    case 'on-track':
      return `You're on track to use about ${projected} of your ${w.label.toLowerCase()} allowance by the reset.`
    case 'over':
      if (w.usage >= 1) return `You've hit the limit.${w.resetAt ? ` It resets in ${formatTimeLeft(w.resetAt - now)}.` : ''}`
      return pace.runOutAt && w.resetAt
        ? `At this rate you'll hit the limit in about ${formatTimeLeft(pace.runOutAt - now)}, ${formatTimeLeft(w.resetAt - pace.runOutAt)} before the reset.`
        : `At this rate you'll run out before the reset.`
    default:
      return 'Ollmost needs the reset time to work out your pace.'
  }
}

function PaceBanner({ w, now, onSetReset }: { w: UsageWindow; now: number; onSetReset: () => void }) {
  const pace = paceOf(w, now)
  const meta = PACE_META[pace.status]
  return (
    <div className="flex gap-2.5 rounded-ollmost bg-hover px-3 py-2.5">
      <meta.icon className={cn('mt-0.5 size-4 shrink-0', meta.text)} />
      <div className="min-w-0 text-[13px]">
        <div className={cn('font-medium', pace.status !== 'unknown' && meta.text)}>
          {meta.label}
          <span className="font-normal text-subtle"> · {w.label.toLowerCase()}</span>
        </div>
        <div className="mt-0.5 text-xs text-muted">
          {paceSentence(w, pace, now)}
          {pace.status === 'unknown' && (
            <>
              {' '}
              <button onClick={onSetReset} className="text-accent hover:underline">
                Set it
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  )
}

function WindowDetail({ w, now, onSetReset }: { w: UsageWindow; now: number; onSetReset: () => void }) {
  const pace = paceOf(w, now)
  const meta = PACE_META[pace.status]
  return (
    <div className="space-y-1.5">
      <div className="flex items-baseline justify-between text-[13px]">
        <span className="flex items-center gap-1.5 font-medium text-fg">
          {w.label}
          {pace.status !== 'unknown' && (
            <span className={cn('flex items-center gap-1 text-xs font-normal', meta.text)}>
              <meta.icon className="size-3" /> {meta.label}
            </span>
          )}
        </span>
        <span className="tabular-nums text-fg">{formatPercent(w.usage)} used</span>
      </div>
      <Meter window={w} pace={pace} wide />
      <div className="flex items-start justify-between gap-3 text-xs text-subtle">
        {w.resetAt ? (
          <span>
            Resets in {formatTimeLeft(w.resetAt - now)} ·{' '}
            {new Date(w.resetAt).toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' })}
            {w.resetSource === 'detected' && ' (detected)'}
          </span>
        ) : w.id === 'session' ? (
          <span>Resets within 5 hours of your first request</span>
        ) : (
          <button onClick={onSetReset} className="text-accent hover:underline">
            Reset time unknown: set it
          </button>
        )}
        {pace.target !== null && <span className="shrink-0 tabular-nums">Target {formatPercent(pace.target)}</span>}
      </div>
    </div>
  )
}

export function AccountQuota() {
  const { account, loading, load } = useUsage()
  const { settings, previewSettings, navigate } = useApp()
  const [open, setOpen] = useState(false)
  const [local, setLocal] = useState<UsageSummary | null>(null)
  const [now, setNow] = useState(Date.now())

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 60_000)
    return () => clearInterval(t)
  }, [])
  // Re-read the clock with each fetch, or a just-detected reset can look more than a period away.
  useEffect(() => setNow(Date.now()), [account])
  // Ollmost's own figure is summed over the account's period when that's known, so the two spend lines compare.
  const period = account ? spendPeriod(account) : null
  const since = period?.since ?? null
  const until = period?.until ?? null
  useEffect(() => {
    if (open) void api.usage.summary(30, since ?? undefined, until).then(setLocal)
  }, [open, since, until])

  // The palette previews the header toggle live, before it's saved.
  if (!settings || !withPreview(settings, previewSettings).usage.showInHeader) return null
  const w = headlineWindow(account, settings.usage.headerWindow)
  const pace = w ? paceOf(w, now) : null
  // Per-model request counts cover every app on the account; prefer the longest window that has them.
  const activityWindow = [...(account?.windows ?? [])].reverse().find((x) => x.models.length > 0) ?? null
  const PaceIcon = pace ? PACE_META[pace.status].icon : null
  const goSettings = () => {
    setOpen(false)
    navigate({ name: 'settings', tab: 'usage' })
  }

  return (
    <PopoverRoot open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button className={chip} aria-label={pace ? `Ollama usage: ${PACE_META[pace.status].label.toLowerCase()}` : 'Ollama usage'}>
          {w && pace && PaceIcon ? (
            <>
              <PaceIcon className={cn('size-3.5', PACE_META[pace.status].text)} />
              <Meter window={w} pace={pace} />
              <span className="tabular-nums">
                <span className="font-medium text-fg">{formatPercent(w.usage)}</span>
                {w.resetAt ? ` · ${formatTimeLeft(w.resetAt - now)} left` : ` ${w.label.toLowerCase()}`}
              </span>
            </>
          ) : account?.needsKey ? (
            <>
              <KeyRound className="size-3.5" /> Quota
            </>
          ) : (
            <>
              <Gauge className="size-3.5" /> {account?.error ? 'Usage unavailable' : 'Usage'}
            </>
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-[340px]">
        <div className="flex items-center justify-between border-b border-line px-4 py-3">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium">Ollama usage</span>
            {account?.plan && (
              <span className="rounded-md bg-accent-soft px-1.5 py-0.5 text-[11px] font-medium capitalize text-accent">{account.plan}</span>
            )}
          </div>
          <button onClick={() => load(true)} aria-label="Refresh usage" className="rounded-md p-1 text-subtle hover:bg-hover hover:text-fg">
            {loading ? <Spinner className="size-3.5" /> : <RefreshCw className="size-3.5" />}
          </button>
        </div>
        <div className="space-y-4 px-4 py-3">
          {account?.needsKey ? (
            <div className="space-y-2 text-[13px] text-muted">
              <p>
                Ollama only shares quota numbers with an <b className="font-medium text-fg">ollama.com API key</b>. Your app sign-in isn't
                enough.
              </p>
              {account.error && <p className="text-danger">{account.error}</p>}
              <button onClick={goSettings} className="text-accent hover:underline">
                Add an API key
              </button>
            </div>
          ) : account?.error ? (
            <p className="text-[13px] text-danger">{account.error}</p>
          ) : account?.windows.length ? (
            <>
              {w && <PaceBanner w={w} now={now} onSetReset={goSettings} />}
              {account.windows.map((win) => (
                <WindowDetail key={win.id} w={win} now={now} onSetReset={goSettings} />
              ))}
            </>
          ) : (
            <p className="text-[13px] text-muted">{account ? 'Ollama reported no usage limits for this account.' : 'Loading…'}</p>
          )}

          {(account?.spend || activityWindow || local) && (
            <div className="space-y-2 border-t border-line pt-3 text-[13px]">
              {account?.spend && (
                <div className="flex items-baseline justify-between gap-3">
                  <span className="text-muted">Ollama spend, {account.spend.label.toLowerCase()}</span>
                  <span
                    className="font-medium tabular-nums"
                    title={
                      account.spend.source === 'credits'
                        ? 'Your share of the monthly credit pool. Ollama reports it to 0.1%, so this is approximate.'
                        : undefined
                    }
                  >
                    {account.spend.source === 'credits'
                      ? `≈${formatDollars(account.spend.cost)} of ${formatDollars(account.spend.pool)}`
                      : formatDollars(account.spend.cost)}
                  </span>
                </div>
              )}
              {activityWindow && (
                <div>
                  <div className="flex items-baseline justify-between gap-3">
                    <span className="text-muted">Requests, {periodPhrase(activityWindow.id)} (all apps)</span>
                    <span className="font-medium tabular-nums">
                      {activityWindow.models.reduce((n, m) => n + m.requests, 0).toLocaleString()}
                    </span>
                  </div>
                  <div className="mt-0.5 truncate text-xs text-subtle">
                    {activityWindow.models
                      .slice(0, 3)
                      .map((m) => `${shortModelName(m.name)} ${m.requests.toLocaleString()}`)
                      .join(' · ')}
                  </div>
                </div>
              )}
              {local && (
                <div>
                  <div className="flex items-baseline justify-between gap-3">
                    <span className="text-muted">
                      Ollmost's estimate, {period?.label ?? 'last 30 days'} ({local.total.requests} requests)
                    </span>
                    <span
                      className="font-medium tabular-nums"
                      title="Every prompt token priced at the full input rate. Ollama charges cached prompt tokens far less, and doesn't say which were cached, so the real charge is lower."
                    >
                      {local.total.costUsd === null
                        ? '—'
                        : local.total.requests && local.total.costUsd > 0
                          ? `up to ≈${formatDollars(local.total.costUsd)}`
                          : formatDollars(local.total.costUsd)}
                    </span>
                  </div>
                  {account?.spend && local.total.costUsd !== null && local.total.costUsd > account.spend.cost && (
                    <div className="mt-0.5 text-xs text-subtle">
                      {period
                        ? "Above Ollama's figure because cached prompt tokens are priced in full here; long chats and code sessions resend most of their prompt."
                        : "Above Ollama's figure: this counts 30 days, not the account's period, and prices cached prompt tokens in full."}
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
        <div className="flex items-center justify-between border-t border-line px-2 py-1.5 text-xs">
          <button onClick={goSettings} className="rounded-md px-2 py-1 text-muted hover:bg-hover hover:text-fg">
            Usage settings
          </button>
          <span className="text-subtle">{account ? `Updated ${relativeTime(account.fetchedAt)}` : ''}</span>
          <button
            onClick={() => api.app.openExternal('https://ollama.com/settings')}
            className="flex items-center gap-1 rounded-md px-2 py-1 text-muted hover:bg-hover hover:text-fg"
          >
            ollama.com <ExternalLink className="size-3" />
          </button>
        </div>
      </PopoverContent>
    </PopoverRoot>
  )
}

export function ChatCost({ usage, model: modelName }: { usage: ChatUsage | null; model: string | null }) {
  const models = useApp((s) => s.models)
  const settings = useApp((s) => s.settings)
  const previewSettings = useApp((s) => s.previewSettings)
  // The palette previews the header toggle live, before it's saved.
  if (
    !settings ||
    !withPreview(settings, previewSettings).usage.showInHeader ||
    !usage ||
    usage.promptTokens + usage.completionTokens === 0
  )
    return null
  const model = findModel(models, modelName)
  const total = usage.promptTokens + usage.completionTokens
  const contextWindow = contextWindowFor(model)
  const context = contextWindow && usage.lastContextTokens ? usage.lastContextTokens / contextWindow : null
  const label = chatCostLabel(usage.byModel)
  const cost = usage.estimated && label.startsWith('$') ? `≈${label}` : label

  return (
    <PopoverRoot>
      <PopoverTrigger asChild>
        <button className={chip} aria-label="Chat usage">
          <span className="tabular-nums">
            <span className="text-fg">{formatTokens(total)}</span> tokens · <span className="text-fg">{cost}</span>
          </span>
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-[340px]">
        <div className="border-b border-line px-4 py-3 text-sm font-medium">This chat</div>
        <div className="space-y-3 px-4 py-3 text-[13px]">
          <table className="w-full tabular-nums">
            <thead>
              <tr className="text-xs text-subtle">
                <th className="pb-1 text-left font-medium">Model</th>
                <th className="pb-1 text-right font-medium">In</th>
                <th className="pb-1 text-right font-medium">Out</th>
                <th className="pb-1 text-right font-medium">Cost</th>
              </tr>
            </thead>
            <tbody>
              {usage.byModel.map((m) => (
                <tr key={`${m.model}|${m.billing}`}>
                  <td className="max-w-[140px] py-0.5">
                    <span className="block truncate">{modelLabel(m)}</span>
                    {/* modelLabel already names a non-Ollama endpoint. */}
                    {m.endpoint.kind === 'ollama' && <span className="block truncate text-[11px] text-subtle">{m.endpoint.name}</span>}
                  </td>
                  <td className="py-0.5 text-right">{formatTokens(m.promptTokens)}</td>
                  <td className="py-0.5 text-right">{formatTokens(m.completionTokens)}</td>
                  <td className="whitespace-nowrap py-0.5 text-right">{billingLabel(m.billing, m.costUsd) ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {context !== null && model && (
            <div className="space-y-1 border-t border-line pt-3">
              <div className="flex justify-between text-xs">
                <span className="text-muted">Context window</span>
                <span className="tabular-nums">
                  {formatTokens(usage.lastContextTokens!)} of {contextSizeLabel(contextWindow)} ({Math.round(context * 100)}%)
                </span>
              </div>
              <span className="block h-1.5 overflow-hidden rounded-full bg-hover">
                <span
                  className={cn('block h-full rounded-full', context > 0.8 ? 'bg-danger' : 'bg-accent')}
                  style={{ width: `${Math.min(100, context * 100)}%` }}
                />
              </span>
            </div>
          )}
          <p className="text-xs text-subtle">
            Includes retries and title generation. Priced with Ollama's published rates (Ollama cloud models only). Every prompt token
            counts at the full input rate, so real charges can be lower with cached input or off-peak pricing.
            {usage.estimated && ' Stopped replies are estimated.'}
          </p>
        </div>
      </PopoverContent>
    </PopoverRoot>
  )
}
