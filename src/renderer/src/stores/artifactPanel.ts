import { create } from 'zustand'
import type { Artifact } from '@shared/types'
import { useChangesPanel } from './changesPanel'

interface PanelState {
  open: boolean
  /** A persisted artifact, and which version (1-based) — null means latest. */
  artifactId: string | null
  version: number | null
  /** An artifact that is still streaming inside this assistant message. */
  live: { messageId: string; identifier: string } | null
  tab: 'preview' | 'code'
  width: number

  openArtifact: (artifactId: string, version?: number | null) => void
  openLive: (messageId: string, identifier: string) => void
  /** When a streamed message is saved, swap the live view for the stored version. */
  settleLive: (messageId: string, artifacts: Artifact[]) => void
  setVersion: (version: number) => void
  setTab: (tab: 'preview' | 'code') => void
  setWidth: (width: number) => void
  close: () => void
}

export const useArtifactPanel = create<PanelState>((set, get) => ({
  open: false,
  artifactId: null,
  version: null,
  live: null,
  tab: 'preview',
  width: Math.round(window.innerWidth * 0.45),

  openArtifact: (artifactId, version = null) => {
    useChangesPanel.getState().close()
    set({ open: true, artifactId, version, live: null, tab: 'preview' })
  },
  openLive: (messageId, identifier) => {
    useChangesPanel.getState().close()
    set({ open: true, live: { messageId, identifier }, artifactId: null, version: null })
  },
  settleLive: (messageId, artifacts) => {
    const { live } = get()
    if (!live || live.messageId !== messageId) return
    const artifact = artifacts.find((a) => a.identifier === live.identifier)
    if (artifact) set({ live: null, artifactId: artifact.id, version: null, tab: 'preview' })
    else set({ live: null, open: false })
  },
  setVersion: (version) => set({ version }),
  setTab: (tab) => set({ tab }),
  setWidth: (width) => set({ width }),
  close: () => set({ open: false, live: null })
}))
