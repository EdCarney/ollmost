import { create } from 'zustand'
import { readJson, writeJson } from '@/lib/storage'

// The sidebar's width, dragged at its right edge: a per-viewer convenience, kept in browser storage.

const WIDTH_KEY = 'ollmost.sidebar.width'
export const SIDEBAR_WIDTH = { min: 220, default: 272, max: 480 }

export const clampSidebarWidth = (width: number): number => Math.round(Math.min(SIDEBAR_WIDTH.max, Math.max(SIDEBAR_WIDTH.min, width)))

function storedWidth(): number {
  const v = readJson(WIDTH_KEY)
  return typeof v === 'number' && Number.isFinite(v) ? clampSidebarWidth(v) : SIDEBAR_WIDTH.default
}

interface SidebarState {
  width: number
  /** Sets the width while dragging; `save` keeps it for next time (once, as the drag ends). */
  setWidth: (width: number, save?: boolean) => void
}

export const useSidebar = create<SidebarState>((set) => ({
  width: storedWidth(),
  setWidth: (width, save = true) => {
    const next = clampSidebarWidth(width)
    set({ width: next })
    if (save) writeJson(WIDTH_KEY, next)
  }
}))
