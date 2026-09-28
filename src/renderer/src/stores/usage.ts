import { create } from 'zustand'
import type { AccountUsage, Settings } from '@shared/types'
import { type QuotaMode, quotaMode } from '@shared/usage'
import { api } from '@/lib/api'
import { useApp } from './app'

interface UsageState {
  account: AccountUsage | null
  loading: boolean
  load: (refresh?: boolean) => Promise<void>
}

export const useUsage = create<UsageState>((set) => ({
  account: null,
  loading: false,
  load: async (refresh = false) => {
    set({ loading: true })
    try {
      const account = await api.usage.account(refresh)
      set({ account })
      // The main process may have dated a reset from this reading; pick up the new schedule.
      if (account.windows.some((w) => w.resetSource === 'detected')) await useApp.getState().loadSettings()
    } finally {
      set({ loading: false })
    }
  }
}))

const POLL_MS = 2 * 60_000

/** Poll while visible, and re-check shortly after each reply finishes. Returns a function that stops it. */
function poll(): () => void {
  let afterReply: ReturnType<typeof setTimeout> | null = null
  void useUsage.getState().load()
  const timer = setInterval(() => {
    if (document.visibilityState === 'visible') void useUsage.getState().load(true)
  }, POLL_MS)
  const offChat = api.events.onChat((e) => {
    if (e.type !== 'done') return
    if (afterReply) clearTimeout(afterReply)
    // Ollama's counters lag a little behind the request, so wait a few seconds.
    afterReply = setTimeout(() => void useUsage.getState().load(true), 4000)
  })
  return () => {
    clearInterval(timer)
    offChat()
    if (afterReply) clearTimeout(afterReply)
  }
}

/**
 * Keep the quota chip's numbers as live as the settings call for (quotaMode): with the ollama.com key, poll; with only
 * an Ollama endpoint, read once (the plan, and the "add a key" prompt); with neither, fetch nothing. It follows settings
 * changes, so saving a key starts polling and switching off the last Ollama endpoint stops it.
 */
export function startUsagePolling(): () => void {
  let mode: QuotaMode | null = null
  let stop: (() => void) | null = null
  const apply = (settings: Settings | null) => {
    const next = settings ? quotaMode(settings) : null
    if (next === mode) return
    mode = next
    stop?.()
    stop = null
    if (next === 'show') stop = poll()
    else if (next === 'add-key') void useUsage.getState().load()
    else useUsage.setState({ account: null })
  }
  apply(useApp.getState().settings)
  const unsubscribe = useApp.subscribe((s) => apply(s.settings))
  return () => {
    unsubscribe()
    stop?.()
  }
}
