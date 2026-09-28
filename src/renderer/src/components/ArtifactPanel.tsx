import { Check, ChevronDown, Copy, Download, X } from 'lucide-react'
import { useEffect, useId, useMemo, useRef, useState } from 'react'
import { parseMessage } from '@shared/artifactParser'
import { flatten } from '@shared/color'
import type { ArtifactType, Palette, ThemeDef } from '@shared/types'
import { api } from '@/lib/api'
import { cn } from '@/lib/format'
import { reportError } from '@/stores/app'
import { useArtifactPanel } from '@/stores/artifactPanel'
import { useChat } from '@/stores/chat'
import { useActiveTheme } from '@/theme/useTheme'
import { ARTIFACT_META } from './ArtifactCard'
import { CodeBlock, useCopy } from './CodeBlock'
import { Markdown } from './Markdown'
import { chosenOption, IconButton, Menu, MenuContent, MenuItem, MenuTrigger, Spinner } from './ui'

interface Resolved {
  /** The chat the artifact belongs to (its links are previewed only if that chat allows it). */
  conversationId: string
  title: string
  type: ArtifactType
  language: string | null
  content: string
  complete: boolean
  versions: number[]
  version: number | null
}

function useResolvedArtifact(): Resolved | null {
  const { artifactId, version, live } = useArtifactPanel()
  const artifacts = useChat((s) => s.artifacts)
  const stream = useChat((s) => (live && s.conversation ? s.streams[s.conversation.id] : undefined))
  // A live artifact is streaming in the open chat: the one its stream was looked up under.
  const liveChat = useChat((s) => (live ? (s.conversation?.id ?? null) : null))

  return useMemo(() => {
    if (live) {
      if (!stream || stream.messageId !== live.messageId) return null
      const seg = parseMessage(stream.content, true)
        .filter((s) => s.kind === 'artifact' && s.identifier === live.identifier)
        .at(-1)
      if (!seg || seg.kind !== 'artifact' || !liveChat) return null
      return {
        conversationId: liveChat,
        title: seg.title,
        type: seg.type,
        language: seg.language,
        content: seg.content,
        complete: seg.complete,
        versions: [],
        version: null
      }
    }
    const artifact = artifacts.find((a) => a.id === artifactId)
    if (!artifact || !artifact.versions.length) return null
    const v = artifact.versions.find((x) => x.version === version) ?? artifact.versions.at(-1)!
    return {
      conversationId: artifact.conversationId,
      title: artifact.title,
      type: artifact.type,
      language: artifact.language,
      content: v.content,
      complete: true,
      versions: artifact.versions.map((x) => x.version),
      version: v.version
    }
  }, [live, stream, liveChat, artifacts, artifactId, version])
}

function SandboxFrame({ type, content }: { type: ArtifactType; content: string }) {
  const [url, setUrl] = useState<string | null>(null)
  useEffect(() => {
    let cancelled = false
    api.artifacts.stage(type, content).then((u) => !cancelled && setUrl(u))
    return () => {
      cancelled = true
    }
  }, [type, content])
  if (!url)
    return (
      <Centered>
        <Spinner />
      </Centered>
    )
  return (
    <iframe
      key={url}
      src={url}
      title="Artifact preview"
      // No allow-same-origin: the page gets an opaque origin and can't touch the app.
      sandbox="allow-scripts allow-forms"
      className={cn('size-full border-0', type === 'html' ? 'bg-white' : 'bg-transparent')}
    />
  )
}

let mermaidLoader: Promise<typeof import('mermaid').default> | null = null

/**
 * Mermaid's `base` theme coloured from the app palette, so diagrams match the theme instead of
 * Mermaid's own grey. Mermaid derives shades with colour maths, so translucent tokens are flattened.
 */
function mermaidTheme(p: Palette, dark: boolean, theme: ThemeDef) {
  const solid = (c: string) => flatten(c, p.canvas)
  return {
    darkMode: dark,
    fontFamily: theme.fonts.ui,
    background: p.canvas,
    primaryColor: solid(p.panel),
    primaryTextColor: p.fg,
    primaryBorderColor: solid(p.lineStrong),
    secondaryColor: solid(p.accentSoft),
    secondaryTextColor: p.fg,
    secondaryBorderColor: p.accent,
    tertiaryColor: solid(p.code),
    tertiaryTextColor: p.fg,
    tertiaryBorderColor: solid(p.line),
    lineColor: p.muted,
    textColor: p.fg,
    mainBkg: solid(p.panel),
    nodeBorder: solid(p.lineStrong),
    clusterBkg: solid(p.code),
    clusterBorder: solid(p.line),
    titleColor: p.fg,
    edgeLabelBackground: p.canvas,
    noteBkgColor: solid(p.accentSoft),
    noteTextColor: p.fg,
    noteBorderColor: p.accent,
    actorBkg: solid(p.panel),
    actorBorder: solid(p.lineStrong),
    actorTextColor: p.fg,
    actorLineColor: p.muted,
    signalColor: p.fg,
    signalTextColor: p.fg,
    labelBoxBkgColor: solid(p.panel),
    labelTextColor: p.fg,
    activationBkgColor: solid(p.accentSoft),
    activationBorderColor: p.accent,
    pie1: p.accent,
    pie2: p.synFunction,
    pie3: p.synString,
    pie4: p.synConstant,
    pie5: p.synKeyword,
    pie6: p.muted,
    pieStrokeColor: p.canvas,
    pieTitleTextColor: p.fg,
    pieSectionTextColor: p.canvas,
    pieLegendTextColor: p.fg,
    errorBkgColor: p.danger,
    errorTextColor: p.canvas
  }
}

function MermaidView({ source }: { source: string }) {
  const id = useId().replace(/:/g, '')
  const ref = useRef<HTMLDivElement>(null)
  const [error, setError] = useState<string | null>(null)
  const { theme, dark, palette } = useActiveTheme()

  useEffect(() => {
    let cancelled = false
    mermaidLoader ??= import('mermaid').then((m) => m.default)
    mermaidLoader
      .then(async (mermaid) => {
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: 'strict',
          theme: 'base',
          themeVariables: mermaidTheme(palette, dark, theme)
        })
        const { svg } = await mermaid.render(`m${id}${Date.now()}`, source)
        if (!cancelled && ref.current) {
          ref.current.innerHTML = svg
          setError(null)
        }
      })
      .catch((err: Error) => !cancelled && setError(err.message))
    return () => {
      cancelled = true
    }
  }, [source, id, palette, dark, theme])

  return (
    <div className="flex h-full flex-col">
      {error && (
        <div className="m-4 rounded-ollmost border border-danger/40 p-3 text-sm text-danger">Couldn't render this diagram: {error}</div>
      )}
      <div ref={ref} className="flex flex-1 items-start justify-center overflow-auto p-6 [&_svg]:h-auto [&_svg]:max-w-full" />
    </div>
  )
}

function Centered({ children }: { children: React.ReactNode }) {
  return <div className="flex size-full items-center justify-center">{children}</div>
}

function Preview({ artifact }: { artifact: Resolved }) {
  if (!artifact.complete && artifact.type !== 'markdown') return <CodeView artifact={artifact} />
  switch (artifact.type) {
    case 'markdown':
      return (
        <div className="h-full overflow-y-auto px-8 py-6">
          <Markdown text={artifact.content} conversationId={artifact.conversationId} className="mx-auto max-w-2xl" />
        </div>
      )
    case 'html':
    case 'svg':
      return <SandboxFrame type={artifact.type} content={artifact.content} />
    case 'mermaid':
      return <MermaidView source={artifact.content} />
    default:
      return <CodeView artifact={artifact} />
  }
}

function CodeView({ artifact }: { artifact: Resolved }) {
  const ref = useRef<HTMLDivElement>(null)
  // Follow the end of the file while it streams in.
  useEffect(() => {
    if (!artifact.complete && ref.current) ref.current.scrollTop = ref.current.scrollHeight
  }, [artifact.content, artifact.complete])
  const lang =
    artifact.type === 'code' ? artifact.language : artifact.type === 'mermaid' ? 'mermaid' : artifact.type === 'svg' ? 'xml' : artifact.type
  return (
    <div ref={ref} className="h-full overflow-auto bg-code">
      <CodeBlock code={artifact.content} lang={lang} bare />
    </div>
  )
}

export function ArtifactPanel() {
  const panel = useArtifactPanel()
  const artifact = useResolvedArtifact()
  const [copied, copy] = useCopy()
  const dragging = useRef(false)

  useEffect(() => {
    const move = (e: MouseEvent) => {
      if (!dragging.current) return
      const width = Math.min(Math.max(window.innerWidth - e.clientX, 360), window.innerWidth * 0.72)
      panel.setWidth(width)
    }
    const up = () => {
      dragging.current = false
      document.body.style.cursor = ''
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
    return () => {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
    }
  }, [panel])

  if (!panel.open) return null
  const hasPreview = artifact && artifact.type !== 'code'
  const tab = hasPreview ? panel.tab : 'code'
  const meta = artifact ? ARTIFACT_META[artifact.type] : null

  return (
    <aside style={{ width: panel.width }} className="relative flex h-full shrink-0 flex-col border-l border-line bg-canvas">
      <div
        onMouseDown={() => {
          dragging.current = true
          document.body.style.cursor = 'col-resize'
        }}
        className="absolute inset-y-0 -left-1 z-10 w-2 cursor-col-resize"
        aria-hidden
      />
      <header className="drag flex h-12 shrink-0 items-center gap-2 border-b border-line px-3">
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium">{artifact?.title ?? 'Artifact'}</div>
          {meta && (
            <div className="truncate text-xs text-subtle">
              {[meta.label, artifact?.type === 'code' && artifact.language].filter(Boolean).join(' · ')}
            </div>
          )}
        </div>

        {artifact && artifact.versions.length > 1 && (
          <Menu>
            <MenuTrigger asChild>
              <button className="flex h-7 items-center gap-1 rounded-md px-2 text-xs text-muted hover:bg-hover hover:text-fg">
                Version {artifact.version} of {artifact.versions.length} <ChevronDown className="size-3.5" />
              </button>
            </MenuTrigger>
            <MenuContent align="end" className="min-w-[140px]">
              {[...artifact.versions].reverse().map((v) => (
                <MenuItem
                  key={v}
                  onSelect={() => panel.setVersion(v)}
                  icon={v === artifact.version ? <Check className="size-4 text-accent" /> : null}
                >
                  Version {v}
                </MenuItem>
              ))}
            </MenuContent>
          </Menu>
        )}

        {hasPreview && (
          <div className="flex rounded-lg bg-hover p-0.5 text-xs">
            {(['preview', 'code'] as const).map((t) => (
              <button
                key={t}
                onClick={() => panel.setTab(t)}
                className={cn('rounded-md px-2.5 py-1 capitalize', tab === t ? chosenOption : 'text-muted hover:text-fg')}
              >
                {t}
              </button>
            ))}
          </div>
        )}

        <IconButton label={copied ? 'Copied' : 'Copy'} size="sm" disabled={!artifact} onClick={() => artifact && copy(artifact.content)}>
          {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
        </IconButton>
        <IconButton
          label="Download"
          size="sm"
          disabled={!artifact?.complete}
          onClick={() =>
            artifact && api.artifacts.save(artifact.title, artifact.type, artifact.language, artifact.content).catch(reportError)
          }
        >
          <Download className="size-4" />
        </IconButton>
        <IconButton label="Close" size="sm" onClick={panel.close}>
          <X className="size-4" />
        </IconButton>
      </header>
      <div className="min-h-0 flex-1">
        {!artifact ? (
          <Centered>
            <span className="text-sm text-subtle">This artifact isn't available.</span>
          </Centered>
        ) : tab === 'code' ? (
          <CodeView artifact={artifact} />
        ) : (
          <Preview artifact={artifact} />
        )}
      </div>
    </aside>
  )
}
