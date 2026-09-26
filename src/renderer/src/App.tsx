import { X } from 'lucide-react'
import { useEffect } from 'react'
import { ArtifactPanel } from './components/ArtifactPanel'
import { CommandPalette } from './components/CommandPalette'
import { Sidebar } from './components/Sidebar'
import { TooltipProvider } from './components/ui'
import { api } from './lib/api'
import { openFolder } from './lib/codeActions'
import { cn } from './lib/format'
import { useApp } from './stores/app'
import { useArtifactPanel } from './stores/artifactPanel'
import { startUsagePolling } from './stores/usage'
import { useTheme } from './theme/useTheme'
import { ArtifactsView } from './views/ArtifactsView'
import { ChatsView } from './views/ChatsView'
import { ChatView } from './views/ChatView'
import { CodeSessionView } from './views/CodeSessionView'
import { CodeView } from './views/CodeView'
import { HomeView } from './views/HomeView'
import { ProjectsView } from './views/ProjectsView'
import { ProjectView } from './views/ProjectView'
import { SettingsView } from './views/SettingsView'
import { SkillsView } from './views/SkillsView'

function useBootstrap() {
  useEffect(() => {
    const app = useApp.getState()
    void (async () => {
      await Promise.all([app.loadSettings(), app.loadThemes()])
      await Promise.all([app.loadProjects(), app.loadConversations(), app.loadSkills(), app.loadMcp()])
      await app.loadModels()
    })()

    const stopUsage = startUsagePolling()
    const offSkills = api.events.onSkillsChanged(() => void useApp.getState().loadSkills())
    const offMcp = api.events.onMcp((mcpStatus) => {
      useApp.setState({ mcpStatus })
      // A server's tool list can change what's allowed (a changed tool goes back to Ask), so re-read the servers too.
      void api.mcp.list().then((mcpServers) => useApp.setState({ mcpServers }))
    })
    const offMenu = api.events.onMenu((action) => {
      const s = useApp.getState()
      if (action === 'new-chat') {
        useArtifactPanel.getState().close()
        s.navigate({ name: 'home' })
      } else if (action === 'new-code-session') {
        useArtifactPanel.getState().close()
        s.navigate({ name: 'code' })
        void openFolder()
      } else if (action === 'settings') s.navigate({ name: 'settings' })
      else if (action === 'search') s.setSearchOpen(true)
      else if (action === 'toggle-sidebar') s.toggleSidebar()
      else if (action === 'debugger') void api.debug.open(s.route.name === 'chat' || s.route.name === 'code' ? (s.route.id ?? null) : null)
    })
    // The menu accelerator covers ⌘K normally; this also catches it when the menu doesn't see the key.
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        useApp.getState().setSearchOpen(true)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => {
      stopUsage()
      offSkills()
      offMcp()
      offMenu()
      window.removeEventListener('keydown', onKey)
    }
  }, [])
}

function Toasts() {
  const { toasts, dismissToast } = useApp()
  return (
    <div className="pointer-events-none fixed bottom-5 left-1/2 z-[60] flex -translate-x-1/2 flex-col items-center gap-2">
      {toasts.map((t) => (
        <div
          key={t.id}
          role="status"
          className={cn(
            'pointer-events-auto flex max-w-lg items-start gap-3 rounded-ollmost border px-4 py-2.5 text-sm shadow-lg',
            t.kind === 'error' ? 'border-danger/40 bg-panel text-fg' : 'border-line bg-fg text-canvas'
          )}
        >
          {t.kind === 'error' && <span className="mt-1.5 size-2 shrink-0 rounded-full bg-danger" />}
          <span className="selectable flex-1">{t.message}</span>
          <button aria-label="Dismiss" onClick={() => dismissToast(t.id)} className="mt-0.5 opacity-60 hover:opacity-100">
            <X className="size-3.5" />
          </button>
        </div>
      ))}
    </div>
  )
}

function CurrentView() {
  const route = useApp((s) => s.route)
  switch (route.name) {
    case 'home':
      return <HomeView />
    case 'chat':
      // Keyed so each chat gets fresh view state (scroll position, composer menus).
      return <ChatView key={route.id} id={route.id} />
    case 'chats':
      return <ChatsView />
    case 'code':
      return route.id ? <CodeSessionView key={route.id} id={route.id} /> : <CodeView />
    case 'projects':
      return <ProjectsView />
    case 'project':
      return <ProjectView id={route.id} />
    case 'artifacts':
      return <ArtifactsView />
    case 'skills':
      return <SkillsView selectedId={route.id} />
    case 'settings':
      return <SettingsView tab={route.tab} />
  }
}

export function App() {
  useBootstrap()
  useTheme()
  const sidebarOpen = useApp((s) => s.sidebarOpen)
  const settings = useApp((s) => s.settings)
  // A code session's replies can hold artifacts too.
  const showsPanel = useApp((s) => s.route.name === 'chat' || (s.route.name === 'code' && !!s.route.id))

  if (!settings) return <div className="h-full bg-canvas" />

  return (
    <TooltipProvider delayDuration={400}>
      <div className="flex h-full bg-canvas text-fg">
        {sidebarOpen && <Sidebar />}
        <main className="flex min-w-0 flex-1">
          <div className="flex min-w-0 flex-1 flex-col">
            <CurrentView />
          </div>
          {showsPanel && <ArtifactPanel />}
        </main>
      </div>
      <CommandPalette />
      <Toasts />
    </TooltipProvider>
  )
}
