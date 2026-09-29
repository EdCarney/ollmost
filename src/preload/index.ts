import { contextBridge, ipcRenderer, webUtils } from 'electron'
import { EVENT_CHANNELS, INVOKE_CHANNELS, type OllmostApi } from '@shared/ipc'

// Build the invoke-style groups from the channel table so the bridge can't drift from main.
const api: Record<string, unknown> = {}
for (const [group, methods] of Object.entries(INVOKE_CHANNELS)) {
  api[group] = Object.fromEntries(methods.map((m) => [m, (...args: unknown[]) => ipcRenderer.invoke(`${group}:${m}`, ...args)]))
}

function subscribe<T>(channel: string, cb: (payload: T) => void): () => void {
  const listener = (_: Electron.IpcRendererEvent, payload: T) => cb(payload)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

api.events = {
  onChat: (cb) => subscribe(EVENT_CHANNELS.chat, cb),
  onTrace: (cb) => subscribe(EVENT_CHANNELS.trace, cb),
  onDebugFocus: (cb) => subscribe(EVENT_CHANNELS.debugFocus, cb),
  onSkillsChanged: (cb) => subscribe(EVENT_CHANNELS.skills, cb),
  onMenu: (cb) => subscribe(EVENT_CHANNELS.menu, cb),
  onMcp: (cb) => subscribe(EVENT_CHANNELS.mcp, cb),
  onModels: (cb) => subscribe(EVENT_CHANNELS.models, cb)
} satisfies OllmostApi['events']

api.files = { pathFor: (file: File) => webUtils.getPathForFile(file) } satisfies OllmostApi['files']

contextBridge.exposeInMainWorld('ollmost', api as unknown as OllmostApi)
