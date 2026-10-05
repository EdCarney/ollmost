import * as Dialog from '@radix-ui/react-dialog'
import { Check, ChevronLeft, FolderClosed, MessageSquare, Search, SlidersHorizontal, SquareTerminal, Zap } from 'lucide-react'
import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react'
import { rankCommands } from '@shared/palette'
import type { SearchHit } from '@shared/types'
import { api } from '@/lib/api'
import { cn, relativeTime } from '@/lib/format'
import type { Choice } from '@shared/paletteChoices'
import { type PaletteCommand, paletteCommands, recentCommands, rememberCommand } from '@/lib/paletteCommands'
import { conversationRoute, type Route, useApp } from '@/stores/app'
import { Snippet } from '@/views/ChatsView'

type Row =
  | { kind: 'command'; key: string; section: string; command: PaletteCommand }
  | { kind: 'choice'; key: string; section: string; choice: Choice; current: boolean }
  | { kind: 'route'; key: string; section: string; icon: ReactNode; label: ReactNode; detail?: ReactNode; route: Route }

const GROUP_ICON: Record<PaletteCommand['group'], ReactNode> = {
  Actions: <Zap className="size-4" />,
  'Go to': <ChevronLeft className="size-4 rotate-180" />,
  Settings: <SlidersHorizontal className="size-4" />
}

/**
 * ⌘K: chats and projects by name or content, and commands: actions, places to go, and settings whose choices are
 * previewed live as the highlight moves (Enter keeps one, Escape puts the saved value back).
 */
export function CommandPalette() {
  const { searchOpen, setSearchOpen, conversations, sessions, projects, navigate, updateSettings, setPreviewSettings } = useApp()
  const settings = useApp((s) => s.settings)
  const themes = useApp((s) => s.themes)
  const models = useApp((s) => s.models)
  const route = useApp((s) => s.route)
  const toggleSidebar = useApp((s) => s.toggleSidebar)
  const [query, setQuery] = useState('')
  const [hits, setHits] = useState<SearchHit[]>([])
  // The query the chat search has answered for. Until then, Enter waits for the answer, and whenever it or a project
  // holds the query, commands matched only by scattered letters stay out: typing a chat's name and pressing Enter
  // opens the chat, never a command (#142).
  const [searched, setSearched] = useState('')
  const enterWaiting = useRef(false)
  const [index, setIndex] = useState(0)
  const [choosing, setChoosing] = useState<PaletteCommand | null>(null)
  const input = useRef<HTMLInputElement>(null)
  const list = useRef<HTMLDivElement>(null)

  // Commands come from the app's state when the palette opens (and follow settings, themes and models while open).
  // Built from the saved settings, never the preview, or each previewed choice would rebuild the list under itself.
  const commands = useMemo(
    () => (searchOpen ? paletteCommands({ settings, themes, models, route, navigate, toggleSidebar }) : []),
    [searchOpen, settings, themes, models, route, navigate, toggleSidebar]
  )
  const recents = useMemo(() => (searchOpen ? recentCommands() : []), [searchOpen])

  useEffect(() => {
    if (!searchOpen) {
      setQuery('')
      setHits([])
      setChoosing(null)
      setPreviewSettings(null)
    }
  }, [searchOpen, setPreviewSettings])

  // Whatever is on screen when the palette goes away is the saved state: closing, or this component going, clears
  // the preview.
  useEffect(() => () => setPreviewSettings(null), [setPreviewSettings])

  useEffect(() => {
    // A choice list opens on the value in force (nothing highlighted, and nothing previewed, if it isn't listed);
    // typing, or the command list, starts at the top.
    const current = choosing && !query ? (choosing.choices?.findIndex((c) => c.value === choosing.current) ?? -1) : 0
    setIndex(current)
    setSearched('')
    enterWaiting.current = false
    if (choosing || !query.trim()) return setHits([])
    // An answer for an earlier query can come after a later one's: only the current query's lands.
    let live = true
    const t = setTimeout(
      () =>
        api.conversations.search(query).then((found) => {
          if (!live) return
          setHits(found)
          setSearched(query)
        }),
      120
    )
    return () => {
      live = false
      clearTimeout(t)
    }
  }, [query, choosing])

  const rows = useMemo<Row[]>(() => {
    const q = query.trim().toLowerCase()
    if (choosing) {
      const choices = choosing.choices ?? []
      return choices
        .filter((c) => !q || c.label.toLowerCase().includes(q) || c.value.toLowerCase().includes(q))
        .map((choice) => ({
          kind: 'choice',
          key: choice.value,
          section: choosing.title,
          choice,
          current: choice.value === choosing.current
        }))
    }
    const projectHits = q ? projects.filter((p) => p.name.toLowerCase().includes(q)) : []
    // Loose command matches only once the query is known to name no chat or project (see `searched`).
    const answered = searched === query
    const loose = answered && !hits.length && !projectHits.length
    // A chat or project named exactly what was typed is what Enter means, above any command the words also fit
    // ("api" is a keyword of Usage & cost; "ollama" one of Models).
    const named = answered && [...projectHits.map((p) => p.name), ...hits.map((h) => h.title)].some((t) => t.trim().toLowerCase() === q)
    const ranked = rankCommands(query, commands, recents, { loose }).slice(0, q ? 8 : 6)
    const commandRows: Row[] = ranked.map((command) => ({ kind: 'command', key: `cmd:${command.id}`, section: 'Commands', command }))
    if (!q)
      return [
        ...commandRows,
        ...conversations.slice(0, 8).map((c): Row => ({
          kind: 'route',
          key: c.id,
          section: 'Recent chats',
          icon: <MessageSquare className="size-4" />,
          label: c.title,
          detail: relativeTime(c.updatedAt),
          route: { name: 'chat', id: c.id }
        }))
      ]
    const projectRows = projectHits.map((p): Row => ({
      kind: 'route',
      key: p.id,
      section: 'Projects',
      icon: <FolderClosed className="size-4" />,
      label: p.name,
      route: { name: 'project', id: p.id }
    }))
    const chatRows = hits.map((h): Row => {
      const route = conversationRoute(h.conversationId, sessions, h.mode)
      return {
        kind: 'route',
        key: h.conversationId,
        section: 'Chats',
        icon: route.name === 'code' ? <SquareTerminal className="size-4" /> : <MessageSquare className="size-4" />,
        label: h.title,
        detail: <Snippet text={h.snippet} />,
        route
      }
    })
    return named ? [...projectRows, ...chatRows, ...commandRows] : [...commandRows, ...projectRows, ...chatRows]
  }, [query, choosing, commands, recents, hits, searched, conversations, sessions, projects])

  // Enter pressed before the search answered (it waits 120 ms after typing): choose once it has, from the rows it
  // settles, rather than from whatever command sat at the top meanwhile.
  useEffect(() => {
    if (!enterWaiting.current || searched !== query) return
    enterWaiting.current = false
    void choose(rows[index])
  })

  // While choosing, the highlighted value is on screen before it's saved. Not once the palette is closing: the
  // rows rebuild then, and this must not put a preview back that the close just cleared.
  useEffect(() => {
    if (!searchOpen || !choosing) return
    const row = rows[index]
    const next = row?.kind === 'choice' ? row.choice.patch : null
    // Only a change of value: the store's preview is compared by content so a re-render never re-previews.
    if (JSON.stringify(next) !== JSON.stringify(useApp.getState().previewSettings)) setPreviewSettings(next)
  }, [searchOpen, choosing, rows, index, setPreviewSettings])

  // The highlighted row stays in view as the keys move it.
  useEffect(() => {
    list.current?.querySelector<HTMLElement>(`[data-index="${index}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [index, rows])

  const back = () => {
    setPreviewSettings(null)
    setChoosing(null)
    setQuery('')
    input.current?.focus()
  }

  const choose = async (row: Row | undefined) => {
    if (!row) return
    if (row.kind === 'route') {
      setSearchOpen(false)
      navigate(row.route)
      return
    }
    if (row.kind === 'choice') {
      if (choosing) rememberCommand(choosing.id)
      // Saved first, then closed: what's on screen is then the saved value, with no flash of the old one.
      try {
        await updateSettings(row.choice.patch)
      } finally {
        setSearchOpen(false)
      }
      return
    }
    const { command } = row
    if (command.choices) {
      setChoosing(command)
      setQuery('')
      input.current?.focus()
      return
    }
    rememberCommand(command.id)
    setSearchOpen(false)
    await command.run?.()
  }

  return (
    <Dialog.Root open={searchOpen} onOpenChange={setSearchOpen}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/25" />
        <Dialog.Content
          aria-describedby={undefined}
          onEscapeKeyDown={(e) => {
            // Escape leaves a choice list (putting the saved value back) before it closes the palette.
            if (choosing) {
              e.preventDefault()
              back()
            }
          }}
          className="fixed left-1/2 top-[14vh] z-50 w-[min(640px,calc(100vw-48px))] -translate-x-1/2 overflow-hidden rounded-ollmost-lg border border-line bg-panel shadow-2xl"
        >
          <Dialog.Title className="sr-only">Search and commands</Dialog.Title>
          <div className="flex items-center gap-2 border-b border-line px-4">
            {choosing ? (
              <button
                onClick={back}
                onMouseDown={(e) => e.preventDefault()}
                aria-label="Back to commands"
                className="rounded-md p-0.5 text-subtle hover:text-fg"
              >
                <ChevronLeft className="size-4" />
              </button>
            ) : (
              <Search className="size-4 text-subtle" />
            )}
            {choosing && <span className="shrink-0 text-sm text-muted">{choosing.title}</span>}
            <input
              ref={input}
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'ArrowDown') {
                  e.preventDefault()
                  setIndex((i) => Math.max(0, Math.min(i + 1, rows.length - 1)))
                } else if (e.key === 'ArrowUp') {
                  e.preventDefault()
                  setIndex((i) => Math.max(i - 1, 0))
                } else if (e.key === 'Enter') {
                  e.preventDefault()
                  if (!choosing && query.trim() && searched !== query) enterWaiting.current = true
                  else void choose(rows[index])
                } else if (e.key === 'Backspace' && choosing && !query) {
                  e.preventDefault()
                  back()
                }
              }}
              placeholder={choosing ? 'Choose…' : 'Search chats, projects and commands…'}
              className="h-12 flex-1 bg-transparent text-[15px] outline-none placeholder:text-subtle"
            />
          </div>
          <div ref={list} className="max-h-[50vh] overflow-y-auto p-1.5" data-testid="palette-rows">
            {rows.map((row, i) => (
              <div key={row.key} data-index={i}>
                {(i === 0 || rows[i - 1].section !== row.section) && (
                  <div className="px-3 pb-1 pt-2 text-xs font-medium text-subtle">{row.section}</div>
                )}
                <button
                  // On movement only: mouseenter also fires when the rows change or scroll under a resting pointer.
                  onMouseMove={() => i !== index && setIndex(i)}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => void choose(row)}
                  className={cn('flex w-full items-start gap-3 rounded-lg px-3 py-2 text-left', i === index && 'bg-hover')}
                >
                  <span className="mt-0.5 text-muted">
                    {row.kind === 'command' ? (
                      GROUP_ICON[row.command.group]
                    ) : row.kind === 'choice' ? (
                      row.current ? (
                        <Check className="size-4 text-accent" />
                      ) : (
                        <span className="block size-4" />
                      )
                    ) : (
                      row.icon
                    )}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm">
                      {row.kind === 'command' ? row.command.title : row.kind === 'choice' ? row.choice.label : row.label}
                    </span>
                    {row.kind === 'command' && row.command.choices && <span className="block truncate text-xs text-subtle">Choose…</span>}
                    {row.kind === 'route' && row.detail && <span className="block truncate text-xs text-subtle">{row.detail}</span>}
                  </span>
                  {row.kind === 'command' && <span className="text-xs text-subtle">{row.command.group}</span>}
                </button>
              </div>
            ))}
            {(query.trim() || choosing) && !rows.length && <div className="px-3 py-6 text-center text-sm text-subtle">No results</div>}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
