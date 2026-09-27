import { Bug, Download, Search, Trash2, Wrench } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { formatCost } from '@shared/usage'
import type { TraceDetail, TraceKind, TraceSummary } from '@shared/types'
import { IconButton, Switch, Tooltip, TooltipProvider } from '@/components/ui'
import { api } from '@/lib/api'
import { cn, displayModelName, formatTokens } from '@/lib/format'
import { useApp } from '@/stores/app'
import { useTheme } from '@/theme/useTheme'
import { kindLabel, ms, StatusIcon } from './bits'
import { TraceView } from './TraceView'

const KINDS: TraceKind[] = ['chat', 'tool', 'title', 'compact', 'replay']

function initialConversation(): string | null {
  const match = window.location.hash.match(/[?&]c=([^&]+)/)
  return match ? decodeURIComponent(match[1]) : null
}

export function DebugApp() {
  useTheme()
  const { settings, conversations, sessions, loadSettings, loadThemes, loadConversations, updateSettings } = useApp()
  const [conversationId, setConversationId] = useState<string | null>(initialConversation)
  const [traces, setTraces] = useState<TraceSummary[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [detail, setDetail] = useState<TraceDetail | null>(null)
  const [kinds, setKinds] = useState<Set<TraceKind>>(new Set(KINDS))
  const [query, setQuery] = useState('')
  const [follow, setFollow] = useState(true)
  const listRef = useRef<HTMLDivElement>(null)
  const selectedRef = useRef<string | null>(null)
  selectedRef.current = selectedId

  useEffect(() => {
    void Promise.all([loadSettings(), loadThemes(), loadConversations()])
    // The main window may change the theme or add chats while this window is open.
    const refresh = () => void Promise.all([loadSettings(), loadThemes(), loadConversations()])
    window.addEventListener('focus', refresh)
    return () => window.removeEventListener('focus', refresh)
  }, [loadSettings, loadThemes, loadConversations])

  useEffect(() => api.events.onDebugFocus((id) => setConversationId(id)), [])

  const loadTraces = useCallback(async () => {
    const list = await api.debug.list(conversationId)
    setTraces(list)
    setSelectedId((cur) => (cur && list.some((t) => t.id === cur) ? cur : (list.at(-1)?.id ?? null)))
  }, [conversationId])

  useEffect(() => {
    void loadTraces()
  }, [loadTraces])

  const loadDetail = useCallback(async (id: string | null) => setDetail(id ? await api.debug.get(id) : null), [])
  useEffect(() => {
    void loadDetail(selectedId)
  }, [selectedId, loadDetail])

  // Live updates: new requests appear as they start and update as they stream.
  useEffect(
    () =>
      api.events.onTrace((e) => {
        if (e.type === 'cleared') return void loadTraces()
        const t = e.trace
        if (conversationId && t.conversationId !== conversationId) return
        setTraces((list) => {
          const i = list.findIndex((x) => x.id === t.id)
          if (i >= 0) return list.map((x) => (x.id === t.id ? t : x))
          return [...list, t]
        })
        if (follow && t.status === 'running') setSelectedId(t.id)
        if (t.id === selectedRef.current && t.status !== 'running') void loadDetail(t.id)
      }),
    [conversationId, follow, loadTraces, loadDetail]
  )

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase()
    return traces.filter(
      (t) => kinds.has(t.kind) && (!q || t.summary.toLowerCase().includes(q) || (t.model ?? '').toLowerCase().includes(q))
    )
  }, [traces, kinds, query])

  useEffect(() => {
    if (follow && listRef.current) listRef.current.scrollTop = listRef.current.scrollHeight
  }, [shown.length, follow])

  const totals = useMemo(() => {
    const done = traces.filter((t) => t.kind !== 'tool')
    return {
      requests: traces.length,
      prompt: done.reduce((n, t) => n + (t.promptTokens ?? 0), 0),
      completion: done.reduce((n, t) => n + (t.completionTokens ?? 0), 0),
      cost: done.reduce((n, t) => n + (t.costUsd ?? 0), 0)
    }
  }, [traces])

  const toggleKind = (k: TraceKind) =>
    setKinds((set) => {
      const next = new Set(set)
      if (next.has(k)) next.delete(k)
      else next.add(k)
      return next.size ? next : new Set(KINDS)
    })

  // Chats and code sessions are kept in separate lists; either can be picked here.
  const pickable = [...conversations, ...sessions]

  if (!settings) return <div className="h-full bg-canvas" />

  return (
    <TooltipProvider delayDuration={300}>
      <div className="flex h-full flex-col bg-canvas text-fg">
        <header className="flex flex-wrap items-center gap-2 border-b border-line px-3 py-2">
          <Bug className="size-4 text-accent" />
          <select
            aria-label="Conversation"
            value={conversationId ?? ''}
            onChange={(e) => setConversationId(e.target.value || null)}
            className="h-8 max-w-[280px] rounded-lg border border-line bg-panel px-2 text-[13px] outline-none"
          >
            <option value="">All recent requests</option>
            {conversationId && !pickable.some((c) => c.id === conversationId) && <option value={conversationId}>This conversation</option>}
            {pickable.map((c) => (
              <option key={c.id} value={c.id}>
                {c.title}
              </option>
            ))}
          </select>
          <div className="flex rounded-lg bg-hover p-0.5 text-xs">
            {KINDS.map((k) => (
              <button
                key={k}
                onClick={() => toggleKind(k)}
                aria-pressed={kinds.has(k)}
                className={cn('rounded-md px-2 py-1 capitalize', kinds.has(k) ? 'bg-panel text-fg shadow-sm' : 'text-subtle hover:text-fg')}
              >
                {k}
              </button>
            ))}
          </div>
          <div className="relative">
            <Search className="absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-subtle" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Filter"
              className="h-8 w-40 rounded-lg border border-line bg-panel pl-7 pr-2 text-[13px] outline-none placeholder:text-subtle focus:border-line-strong"
            />
          </div>
          <label className="flex items-center gap-1.5 text-xs text-muted">
            <Switch checked={follow} onChange={setFollow} label="Follow live" /> Follow live
          </label>
          <div className="flex-1" />
          <span className="truncate text-xs tabular-nums text-subtle">
            {totals.requests} requests · {formatTokens(totals.prompt)} in / {formatTokens(totals.completion)} out ·{' '}
            {formatCost(totals.cost)}
          </span>
          <Tooltip content={settings.debug.record ? 'Recording every request' : 'Recording is paused'}>
            <label className="flex items-center gap-1.5 text-xs text-muted">
              <Switch checked={settings.debug.record} onChange={(record) => updateSettings({ debug: { record } })} label="Record" />
              <span className={cn('size-2 rounded-full', settings.debug.record ? 'bg-danger' : 'bg-line-strong')} /> Rec
            </label>
          </Tooltip>
          <IconButton label="Export these requests as JSON" size="sm" onClick={() => api.debug.exportTraces(conversationId)}>
            <Download className="size-4" />
          </IconButton>
          <IconButton
            label={conversationId ? "Clear this chat's requests" : 'Clear all requests'}
            size="sm"
            onClick={() => api.debug.clear(conversationId)}
          >
            <Trash2 className="size-4" />
          </IconButton>
          <IconButton label="Inspect app (Chromium DevTools)" size="sm" onClick={() => api.debug.inspectApp()}>
            <Wrench className="size-4" />
          </IconButton>
        </header>

        <div className="flex min-h-0 flex-1">
          <div ref={listRef} className="w-[420px] shrink-0 overflow-y-auto border-r border-line">
            {shown.length === 0 ? (
              <p className="p-6 text-center text-sm text-subtle">
                {settings.debug.record ? 'No requests yet. Send a message and they appear here live.' : 'Recording is paused.'}
              </p>
            ) : (
              shown.map((t, i) => {
                const newTurn = i === 0 || t.messageId !== shown[i - 1].messageId
                return (
                  <div key={t.id}>
                    {newTurn && (
                      <div className="sticky top-0 z-10 border-b border-line bg-sidebar px-3 py-1 text-[11px] font-medium text-subtle">
                        {t.kind === 'delegate' ? 'Sub-agent' : t.messageId ? 'Turn' : t.kind === 'title' ? 'Title' : 'Other'} ·{' '}
                        {new Date(t.startedAt).toLocaleTimeString()}
                      </div>
                    )}
                    <button
                      onClick={() => {
                        setSelectedId(t.id)
                        setFollow(false)
                      }}
                      className={cn(
                        'flex w-full items-start gap-2 border-b border-line px-3 py-2 text-left',
                        t.id === selectedId ? 'bg-accent-soft' : 'hover:bg-hover'
                      )}
                    >
                      <StatusIcon status={t.status} className="mt-0.5 shrink-0" />
                      <span className="min-w-0 flex-1">
                        <span className="flex items-center gap-2 text-xs">
                          <span className="rounded bg-hover px-1.5 py-px font-mono text-[11px] text-muted">{kindLabel(t)}</span>
                          {t.model && <span className="truncate text-subtle">{displayModelName(t.model)}</span>}
                        </span>
                        <span className="mt-0.5 block truncate text-[13px]">{t.summary}</span>
                      </span>
                      <span className="shrink-0 text-right font-mono text-[11px] tabular-nums text-subtle">
                        <span className="block">{ms(t.durationMs)}</span>
                        {t.promptTokens != null && (
                          <span className="block">
                            {formatTokens(t.promptTokens)}→{formatTokens(t.completionTokens ?? 0)}
                          </span>
                        )}
                        {t.costUsd != null && t.costUsd > 0 && <span className="block">{formatCost(t.costUsd)}</span>}
                      </span>
                    </button>
                  </div>
                )
              })
            )}
          </div>
          <div className="min-w-0 flex-1">
            {detail ? (
              <TraceView trace={detail} conversationId={conversationId} />
            ) : (
              <p className="p-10 text-center text-sm text-subtle">Select a request to inspect it.</p>
            )}
          </div>
        </div>
      </div>
    </TooltipProvider>
  )
}
