import { create } from 'zustand'
import { useArtifactPanel } from './artifactPanel'

interface ChangesPanelState {
  open: boolean
  /** The session the panel is showing (or was last toggled open for). */
  sessionId: string | null
  width: number
  /** A changed file's path whose diff is shown below the list. */
  selected: string | null
  /** The session `count` belongs to; the toggle's badge shows it only when this matches the session on screen. */
  countFor: string | null
  /** The number of rows the panel is showing for `countFor`: git's files, or the session's own edits in the fallback. */
  count: number

  toggle: (sessionId: string) => void
  close: () => void
  setWidth: (width: number) => void
  select: (path: string | null) => void
  setCount: (sessionId: string, count: number) => void
}

/** What the panel must leave: the sidebar, and a session column wide enough for its top bar's title and chips. */
const SIDEBAR_PX = 272
const SESSION_MIN_PX = 560
/** A panel width within bounds: at least 360, at most 72% of the window, and leaving the session column its room. */
export const panelWidth = (width: number): number =>
  Math.max(360, Math.min(width, window.innerWidth * 0.72, window.innerWidth - SIDEBAR_PX - SESSION_MIN_PX))

export const useChangesPanel = create<ChangesPanelState>((set, get) => ({
  open: false,
  sessionId: null,
  width: panelWidth(Math.round(window.innerWidth * 0.45)),
  selected: null,
  countFor: null,
  count: 0,

  toggle: (sessionId) => {
    const { open, sessionId: current } = get()
    if (open && current === sessionId) {
      set({ open: false, selected: null })
      return
    }
    useArtifactPanel.getState().close()
    set({ open: true, sessionId, selected: null })
  },
  close: () => set({ open: false, selected: null }),
  setWidth: (width) => set({ width: panelWidth(width) }),
  select: (path) => set({ selected: path }),
  setCount: (sessionId, count) => set({ countFor: sessionId, count })
}))
