import { create } from 'zustand'
import { afterLiveToggle } from '@shared/thinkingPanes'
import { readJson, strings, writeJson } from '@/lib/storage'

// The chats whose live thinking the reader closed, kept in browser storage (a per-viewer convenience) so a chat
// remembers it across restarts. The rule is in shared/thinkingPanes.ts.

const CLOSED_KEY = 'ollmost.thinking.closed'

interface ThinkingPanesState {
  /** Chats whose live thinking starts closed, oldest choice first. */
  closed: string[]
  /** The reader opened or closed thinking while the model was still thinking, in this chat. */
  liveToggled: (conversationId: string, open: boolean) => void
}

export const useThinkingPanes = create<ThinkingPanesState>((set, get) => ({
  closed: strings(readJson(CLOSED_KEY)),
  liveToggled: (conversationId, open) => {
    const next = afterLiveToggle(get().closed, conversationId, open)
    set({ closed: next })
    writeJson(CLOSED_KEY, next)
  }
}))
