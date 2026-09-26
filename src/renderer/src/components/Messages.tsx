import {
  Ban,
  Check,
  ChevronRight,
  Copy,
  Download,
  Eye,
  FileText,
  FolderOpen,
  Globe,
  Hand,
  LoaderCircle,
  Pencil,
  RotateCcw,
  Search,
  Sparkles,
  SquareTerminal,
  TriangleAlert,
  Wrench
} from 'lucide-react'
import { memo, useEffect, useMemo, useRef, useState } from 'react'
import { parseMessage, parseMessageRanges, typeForCodeLanguage } from '@shared/artifactParser'
import { type IndexedToolEvent, interleave } from '@shared/timeline'
import type { Artifact, Message, ToolDecision, ToolEvent } from '@shared/types'
import { IMAGE_FILE, openWith } from '@shared/workspace'
import { formatCost } from '@shared/usage'
import { api } from '@/lib/api'
import { cn, displayModelName, formatBytes, formatDuration, formatTokens } from '@/lib/format'
import { reportError } from '@/stores/app'
import { useArtifactPanel } from '@/stores/artifactPanel'
import type { ContinueReason } from '@/lib/chatActions'
import { type StreamState, useChat } from '@/stores/chat'
import { ArtifactCard } from './ArtifactCard'
import { CodeBlock, useCopy } from './CodeBlock'
import { Markdown } from './Markdown'
import { ThinkingBlock } from './ThinkingBlock'
import { Button, IconButton, TextArea, Tooltip } from './ui'

/** Plain text of a reply for the clipboard: prose plus artifact bodies, without the tags. */
function plainText(content: string): string {
  return parseMessage(content)
    .map((s) => (s.kind === 'text' ? s.text : s.content))
    .join('\n\n')
    .trim()
}

// ---- User -----------------------------------------------------------------

export const UserMessage = memo(function UserMessage({
  message,
  onEdit,
  disabled
}: {
  message: Message
  onEdit: (content: string) => void
  disabled: boolean
}) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(message.content)
  const [copied, copy] = useCopy()

  return (
    <div className="group flex flex-col items-end gap-2">
      {message.attachments.length > 0 && (
        <div className="flex max-w-[85%] flex-wrap justify-end gap-2">
          {message.attachments.map((a) =>
            a.kind === 'image' ? (
              <img
                key={a.id}
                src={`ollmost://attachment/${a.id}`}
                alt={a.name}
                className="max-h-48 max-w-64 rounded-ollmost border border-line object-cover"
              />
            ) : (
              <div key={a.id} className="flex h-12 max-w-56 items-center gap-2 rounded-lg border border-line bg-panel px-2.5">
                <FileText className="size-4 shrink-0 text-muted" />
                <div className="min-w-0">
                  <div className="truncate text-xs font-medium">{a.name}</div>
                  <div className="text-[11px] text-subtle">{a.textless ? 'No text found' : `${formatTokens(a.tokenEstimate)} tokens`}</div>
                </div>
              </div>
            )
          )}
        </div>
      )}
      {editing ? (
        <div className="w-full max-w-[85%] space-y-2">
          <TextArea
            autoFocus
            rows={Math.min(12, draft.split('\n').length + 1)}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            className="bg-panel text-[15px]"
          />
          <div className="flex justify-end gap-2">
            <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>
              Cancel
            </Button>
            <Button
              size="sm"
              variant="primary"
              disabled={!draft.trim() || disabled}
              onClick={() => {
                setEditing(false)
                onEdit(draft.trim())
              }}
            >
              Save & send
            </Button>
          </div>
        </div>
      ) : (
        message.content && (
          <div className="selectable max-w-[85%] whitespace-pre-wrap rounded-ollmost-lg bg-bubble px-4 py-2.5 text-[15px] leading-relaxed">
            {message.content}
          </div>
        )
      )}
      {!editing && (
        <div className="flex gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
          <IconButton label={copied ? 'Copied' : 'Copy'} size="sm" onClick={() => copy(message.content)}>
            {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
          </IconButton>
          <IconButton
            label="Edit"
            size="sm"
            disabled={disabled}
            onClick={() => {
              setDraft(message.content)
              setEditing(true)
            }}
          >
            <Pencil className="size-3.5" />
          </IconButton>
        </div>
      )}
    </div>
  )
})

// ---- Assistant ------------------------------------------------------------

const SKILL_TOOL_NAMES = new Set(['load_skill', 'read_skill_file'])
const WEB_TOOL_NAMES = new Set(['web_search', 'web_fetch'])

export const pill = 'flex max-w-full items-center gap-1.5 rounded-lg border px-2 py-1 font-ui text-xs'

function WebEvent({ e }: { e: ToolEvent }) {
  const Icon = e.pending ? LoaderCircle : e.tool === 'web_search' ? Search : Globe
  const url = typeof e.args.url === 'string' ? e.args.url : null
  const label = e.pending
    ? e.tool === 'web_search'
      ? 'Searching the web:'
      : 'Reading'
    : !e.ok
      ? e.tool === 'web_search'
        ? 'Search failed:'
        : "Couldn't read page:"
      : e.tool === 'web_search'
        ? 'Searched the web:'
        : 'Read'
  const content = (
    <>
      <Icon className={cn('size-3.5 shrink-0', e.pending && 'animate-spin')} />
      <span className="shrink-0">{label}</span>
      <span className="truncate font-medium text-fg">{e.summary}</span>
      {e.ok && !e.pending && e.tool === 'web_search' && typeof e.args.results === 'number' && (
        <span className="shrink-0 text-subtle">
          · {e.args.results} {e.args.results === 1 ? 'result' : 'results'}
        </span>
      )}
    </>
  )
  const cls = cn(pill, e.ok ? 'border-line text-muted' : 'border-danger/40 text-danger')
  // Pages open in the browser, so you can check what the model read.
  return url && e.ok && !e.pending ? (
    <Tooltip content={url}>
      <button onClick={() => void api.app.openExternal(url)} className={cn(cls, 'hover:border-line-strong hover:text-fg')}>
        {content}
      </button>
    </Tooltip>
  ) : (
    <span className={cls}>{content}</span>
  )
}

/**
 * The model called a tool nothing offered (web.run, python…). Older replies have no flag; back then any tool
 * other than the built-in ones had been invented.
 */
const isUnavailable = (e: ToolEvent) => e.unknown ?? (e.at === undefined && !SKILL_TOOL_NAMES.has(e.tool) && !WEB_TOOL_NAMES.has(e.tool))

function SkillEvent({ e }: { e: ToolEvent }) {
  return (
    <span className={cn(pill, e.ok ? 'border-line text-muted' : 'border-danger/40 text-danger')}>
      {e.pending ? <LoaderCircle className="size-3.5 animate-spin" /> : <Sparkles className="size-3.5" />}
      {e.pending ? (
        e.tool === 'load_skill' ? (
          `Loading skill ${e.summary}…`
        ) : (
          'Reading skill file…'
        )
      ) : e.tool === 'load_skill' ? (
        e.ok ? (
          <>
            Using skill <b className="font-medium text-fg">{e.summary}</b>
          </>
        ) : (
          `Skill failed: ${e.summary}`
        )
      ) : e.ok ? (
        `Read ${e.summary}`
      ) : (
        `Couldn't read file: ${e.summary}`
      )}
    </span>
  )
}

export function Detail({ label, text }: { label: string; text: string }) {
  return (
    <div>
      <div className="mb-1 text-subtle">{label}</div>
      <pre className="selectable max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-md border border-line bg-code p-2 font-mono text-[11px] text-fg">
        {text}
      </pre>
    </div>
  )
}

const argsText = (e: ToolEvent) => (Object.keys(e.args).length ? JSON.stringify(e.args, null, 2) : null)

/** A tool's own name: an MCP tool is offered as `<server>__<tool>`, and its card names the server separately. */
const toolName = (e: ToolEvent) => (e.source && e.tool.includes('__') ? e.tool.slice(e.tool.indexOf('__') + 2) : e.tool)

/** Any tool without its own badge (MCP servers and the like): its name, and on click what it was given and returned. */
function ToolCard({ e }: { e: ToolEvent }) {
  const [open, setOpen] = useState(false)
  const Icon = e.pending ? LoaderCircle : Wrench
  const args = argsText(e)
  const expandable = !e.pending && !!(args || e.preview)
  return (
    <div className={cn('max-w-full', open && 'basis-full')}>
      <button
        onClick={() => setOpen(!open)}
        disabled={!expandable}
        aria-expanded={expandable ? open : undefined}
        className={cn(
          pill,
          // A call you denied didn't fail; it just didn't run.
          e.ok || e.declined ? 'border-line text-muted' : 'border-danger/40 text-danger',
          expandable && 'hover:border-line-strong hover:text-fg'
        )}
      >
        <Icon className={cn('size-3.5 shrink-0', e.pending && 'animate-spin')} />
        {e.source && <span className="shrink-0">{e.source}</span>}
        <span className="shrink-0 font-mono text-fg">{toolName(e)}</span>
        {e.summary && e.summary !== e.tool && <span className="truncate">{e.summary}</span>}
        {e.declined && <span className="shrink-0 text-subtle">· declined</span>}
        {expandable && <ChevronRight className={cn('size-3 shrink-0 transition-transform', open && 'rotate-90')} />}
      </button>
      {open && (
        <div className="mt-1.5 space-y-2 rounded-ollmost border border-line bg-panel p-2.5 font-ui text-xs">
          {args && <Detail label="Arguments" text={args} />}
          {e.preview && <Detail label={e.ok ? 'Result' : 'Error'} text={e.preview} />}
        </div>
      )}
    </div>
  )
}

const runLanguage = (e: ToolEvent) => (e.args.language === 'bash' ? 'bash' : 'python')

/** On a Mac, files a run wrote are previewed with Quick Look; elsewhere fewer types are opened (see openWith). */
const PLATFORM = navigator.userAgent.includes('Macintosh') ? 'darwin' : 'other'

/** The files a code run wrote: images shown, and every file can be previewed (documents), shown in Finder or saved. */
function RunFiles({ e, conversationId }: { e: ToolEvent; conversationId: string }) {
  if (!e.files?.length) return null
  const act = (fn: () => Promise<unknown>) => () => void fn().catch(reportError)
  return (
    <div data-testid="run-files" className="basis-full space-y-2">
      {e.files
        .filter((f) => IMAGE_FILE.test(f.path))
        .map((f) => (
          <img
            key={`img-${f.path}`}
            src={`ollmost://workspace/${conversationId}/${f.path.split('/').map(encodeURIComponent).join('/')}`}
            alt={f.path}
            className="max-h-72 max-w-full rounded-ollmost border border-line bg-white"
          />
        ))}
      <div className="flex flex-wrap gap-1.5">
        {e.files.map((f) => (
          <span
            key={f.path}
            className="flex items-center gap-1 rounded-lg border border-line py-0.5 pl-2 pr-0.5 font-ui text-xs text-muted"
          >
            <span className="font-mono text-fg">{f.path}</span>
            <span className="text-subtle">{formatBytes(f.size)}</span>
            {openWith(f.path, PLATFORM) && (
              <IconButton label={`Preview ${f.path}`} size="sm" onClick={act(() => api.runner.openFile(conversationId, f.path))}>
                <Eye className="size-3" />
              </IconButton>
            )}
            <IconButton label={`Show ${f.path} in Finder`} size="sm" onClick={act(() => api.runner.revealFile(conversationId, f.path))}>
              <FolderOpen className="size-3" />
            </IconButton>
            <IconButton label={`Save a copy of ${f.path}`} size="sm" onClick={act(() => api.runner.saveFile(conversationId, f.path))}>
              <Download className="size-3" />
            </IconButton>
          </span>
        ))}
      </div>
    </div>
  )
}

/** A run of the code runner: the language and first line; on click, the code and what it printed. */
export function CodeRunCard({ e, conversationId }: { e: ToolEvent; conversationId: string }) {
  const [open, setOpen] = useState(false)
  const language = runLanguage(e)
  const name = language === 'bash' ? 'bash' : 'Python'
  const label = e.pending ? `Running ${name}…` : e.declined ? `Didn't run ${name}` : e.ok ? `Ran ${name}` : `${name} failed`
  return (
    <>
      <div className={cn('max-w-full', open && 'basis-full')}>
        <button
          onClick={() => setOpen(!open)}
          disabled={e.pending}
          aria-expanded={open}
          className={cn(
            pill,
            e.ok || e.declined || e.pending ? 'border-line text-muted' : 'border-danger/40 text-danger',
            !e.pending && 'hover:border-line-strong hover:text-fg'
          )}
        >
          {e.pending ? <LoaderCircle className="size-3.5 shrink-0 animate-spin" /> : <SquareTerminal className="size-3.5 shrink-0" />}
          <span className="shrink-0">{label}</span>
          {e.summary && <span className="truncate font-mono text-fg">{e.summary}</span>}
          {!e.pending && <ChevronRight className={cn('size-3 shrink-0 transition-transform', open && 'rotate-90')} />}
        </button>
        {open && (
          <div className="mt-1.5 space-y-2 rounded-ollmost border border-line bg-panel p-2.5 font-ui text-xs">
            <div className="max-h-80 overflow-auto">
              <CodeBlock code={String(e.args.code ?? '')} lang={language} />
            </div>
            {e.preview && <Detail label="Output" text={e.preview} />}
          </div>
        )}
      </div>
      <RunFiles e={e} conversationId={conversationId} />
    </>
  )
}

/** A call waiting for your answer: what the model wants to run, and Deny / Allow for this chat / Allow once. */
export function ApprovalCard({
  e,
  conversationId,
  messageId,
  index,
  scope = 'chat'
}: {
  e: ToolEvent
  conversationId: string
  messageId: string
  index: number
  /** What "Allow for this …" allows for, e.g. a code session reusing this card would pass 'session'. */
  scope?: string
}) {
  const [answering, setAnswering] = useState(false)
  const args = argsText(e)
  const code = e.tool === 'run_code' ? String(e.args.code ?? '') : null
  const answer = async (decision: ToolDecision) => {
    setAnswering(true)
    try {
      await api.chat.decide(conversationId, messageId, index, decision)
    } catch (err) {
      reportError(err)
      setAnswering(false)
    }
  }
  return (
    <div data-testid="approval-card" className="basis-full rounded-ollmost border border-warn/50 bg-panel p-3 font-ui text-[13px]">
      <div className="flex items-center gap-2">
        <Hand className="size-4 shrink-0 text-warn" />
        <span className="min-w-0 flex-1">
          {code !== null ? (
            <>Run this {runLanguage(e) === 'bash' ? 'bash script' : 'Python'} in the sandbox?</>
          ) : (
            <>
              Allow the model to use <span className="font-mono font-medium text-fg">{toolName(e)}</span>
              {e.source && (
                <>
                  {' '}
                  from <span className="font-medium text-fg">{e.source}</span>
                </>
              )}
              ?
            </>
          )}
        </span>
      </div>
      {code !== null ? (
        <div className="mt-2 max-h-96 overflow-auto">
          <CodeBlock code={code} lang={runLanguage(e)} />
        </div>
      ) : (
        <>
          {e.summary && e.summary !== e.tool && <div className="mt-1 truncate pl-6 text-xs text-muted">{e.summary}</div>}
          {args && (
            <div className="mt-2">
              <Detail label="Arguments" text={args} />
            </div>
          )}
        </>
      )}
      {e.everyTime && (
        <div className="mt-2 text-xs text-muted">
          In a chat with tools on or files shared, Ollmost asks before every page it fetches: a web address can carry data out.
        </div>
      )}
      <div className="mt-3 flex flex-wrap justify-end gap-2">
        <Button size="sm" variant="ghost" disabled={answering} onClick={() => void answer('deny')}>
          Deny
        </Button>
        {!e.everyTime && (
          <Button size="sm" disabled={answering} onClick={() => void answer('chat')}>
            Allow for this {scope}
          </Button>
        )}
        <Button size="sm" variant="primary" disabled={answering} onClick={() => void answer('once')}>
          Allow once
        </Button>
      </div>
    </div>
  )
}

/** Tool calls made at one point in a reply, in the order they were made. */
export function ToolGroup({
  events,
  conversationId,
  messageId,
  scope = 'chat'
}: {
  events: IndexedToolEvent[]
  conversationId: string
  messageId: string
  /** Passed through to ApprovalCard; see its scope prop. */
  scope?: string
}) {
  const shown = events.filter(({ event }) => !isUnavailable(event))
  // Tools the model invented collapse into one note instead of a row of errors.
  const unavailable = [...new Set(events.filter(({ event }) => isUnavailable(event) && !event.pending).map(({ event }) => event.tool))]
  if (!shown.length && !unavailable.length) return null
  return (
    <div data-testid="tool-group" className="my-3 flex flex-wrap gap-1.5 first:mt-0">
      {shown.map(({ event: e, index }) =>
        e.awaiting ? (
          <ApprovalCard key={index} e={e} conversationId={conversationId} messageId={messageId} index={index} scope={scope} />
        ) : e.tool === 'run_code' ? (
          <CodeRunCard key={index} e={e} conversationId={conversationId} />
        ) : WEB_TOOL_NAMES.has(e.tool) ? (
          <WebEvent key={index} e={e} />
        ) : SKILL_TOOL_NAMES.has(e.tool) ? (
          <SkillEvent key={index} e={e} />
        ) : (
          <ToolCard key={index} e={e} />
        )
      )}
      {unavailable.length > 0 && (
        <Tooltip content="The model tried tools that aren't available in this chat.">
          <span className="flex items-center gap-1.5 rounded-lg border border-line px-2 py-1 font-ui text-xs text-muted">
            <Ban className="size-3.5 text-warn" />
            Tried unavailable {unavailable.length === 1 ? 'tool' : 'tools'}:{' '}
            <span className="font-mono text-fg">{unavailable.join(', ')}</span>
          </span>
        </Tooltip>
      )}
    </div>
  )
}

function statsLine(message: Message): string {
  const s = message.stats
  if (!s) return displayModelName(message.model)
  return [
    displayModelName(message.model),
    s.tokensPerSecond && `${s.tokensPerSecond.toFixed(0)} tok/s`,
    s.completionTokens && `${formatTokens(s.completionTokens)} output tokens`,
    s.durationMs && formatDuration(s.durationMs),
    s.costUsd === 0 ? 'local' : s.costUsd != null ? `${s.estimated ? '≈' : ''}${formatCost(s.costUsd)}` : null,
    s.truncatedHistory && `${s.truncatedHistory} older messages left out to fit the context window`,
    s.shortenedToolResults &&
      `${s.shortenedToolResults} earlier tool ${s.shortenedToolResults === 1 ? 'result' : 'results'} shortened to fit the context window`
  ]
    .filter(Boolean)
    .join(' · ')
}

interface AssistantProps {
  message: Message
  stream: StreamState | undefined
  artifacts: Artifact[]
  isLast: boolean
  onRetry: () => void
  onContinue: (reason: ContinueReason) => void
}

export const AssistantMessage = memo(function AssistantMessage({
  message,
  stream,
  artifacts,
  isLast,
  onRetry,
  onContinue
}: AssistantProps) {
  const streaming = !!stream
  const content = stream ? stream.content : message.content
  const thinking = stream ? stream.thinking : (message.thinking ?? '')
  const toolEvents = stream ? stream.toolEvents : message.toolEvents
  const segments = useMemo(() => parseMessageRanges(content, streaming), [content, streaming])
  // Tool calls sit where they happened in the text.
  const timeline = useMemo(() => interleave(segments, toolEvents), [segments, toolEvents])
  const [copied, copy] = useCopy()
  const conversationId = message.conversationId
  const openLive = useArtifactPanel((s) => s.openLive)
  const openArtifact = useArtifactPanel((s) => s.openArtifact)

  // Like Claude, pop the panel open the first time an artifact starts streaming.
  const opened = useRef(new Set<string>())
  useEffect(() => {
    if (!streaming) return
    for (const s of segments) {
      if (s.kind === 'artifact' && !s.complete && !opened.current.has(s.identifier)) {
        opened.current.add(s.identifier)
        openLive(message.id, s.identifier)
      }
    }
  }, [segments, streaming, message.id, openLive])

  const openAsArtifact = async (code: string, lang: string | null) => {
    try {
      const type = typeForCodeLanguage(lang)
      const title = lang ? `${lang[0].toUpperCase()}${lang.slice(1)} ${type === 'code' ? 'code' : 'snippet'}` : 'Code snippet'
      const artifact = await api.artifacts.createFromBlock({
        conversationId,
        messageId: message.id,
        title,
        type,
        language: lang,
        content: code
      })
      useChat.getState().addArtifact(artifact)
      openArtifact(artifact.id)
    } catch (err) {
      reportError(err)
    }
  }

  const thinkingActive = streaming && !content && !toolEvents.length
  // Waiting on you, not the model: no caret while a tool call waits for approval.
  const working = streaming && !toolEvents.some((e) => e?.awaiting)
  const thinkingMs = stream
    ? stream.thinkingStartedAt && stream.thinkingEndedAt
      ? stream.thinkingEndedAt - stream.thinkingStartedAt
      : null
    : (message.stats?.thinkingMs ?? null)

  const occurrences = new Map<string, number>()
  const rendered = timeline.map((item, i) => {
    if (item.kind === 'tools')
      return <ToolGroup key={`t${item.events[0].index}`} events={item.events} conversationId={conversationId} messageId={message.id} />
    const seg = item.segment
    if (seg.kind === 'text')
      return <Markdown key={i} text={seg.text} conversationId={conversationId} onOpenAsArtifact={streaming ? undefined : openAsArtifact} />
    const n = occurrences.get(seg.identifier) ?? 0
    occurrences.set(seg.identifier, n + 1)
    return <ArtifactCard key={i} segment={seg} messageId={message.id} occurrence={n} artifacts={artifacts} streaming={streaming} />
  })

  return (
    <div className="group">
      <ThinkingBlock thinking={thinking} active={thinkingActive && !!(thinking || streaming)} durationMs={thinkingMs} />
      {rendered}
      {working && !content && !thinking && <div className="stream-caret h-6" aria-label="Waiting for reply" />}
      {working && content && <span className="stream-caret" />}
      {message.error && !streaming && (
        <div className="mt-2 flex items-start gap-2 rounded-ollmost border border-danger/40 bg-[color-mix(in_srgb,var(--o-danger)_8%,transparent)] px-3 py-2.5 text-sm">
          <TriangleAlert className="mt-0.5 size-4 shrink-0 text-danger" />
          <div className="flex-1 selectable">{message.error}</div>
          {isLast && (
            <Button size="sm" onClick={onRetry}>
              Retry
            </Button>
          )}
        </div>
      )}
      {!streaming && !message.error && message.stats?.doneReason === 'length' && (
        <div className="mt-2 flex items-start gap-2 rounded-ollmost border border-warn/40 bg-[color-mix(in_srgb,var(--o-warn)_8%,transparent)] px-3 py-2.5 text-sm">
          <TriangleAlert className="mt-0.5 size-4 shrink-0 text-warn" />
          <div className="flex-1">This reply hit the model's length limit and was cut off.</div>
          {isLast && (
            <Button size="sm" onClick={() => onContinue('length')}>
              Continue
            </Button>
          )}
        </div>
      )}
      {!streaming && message.stats?.unavailableTools?.length ? (
        <div className="mt-2 flex items-start gap-2 rounded-ollmost border border-line px-3 py-2 text-xs text-muted">
          <TriangleAlert className="mt-px size-3.5 shrink-0 text-warn" />
          <div className="selectable space-y-0.5">
            <div>Some of this chat's tools weren't available for this reply:</div>
            {message.stats.unavailableTools.map((line) => (
              <div key={line}>{line}</div>
            ))}
          </div>
        </div>
      ) : null}
      {!streaming && !message.error && message.stats?.doneReason !== 'length' && message.stats?.toolRoundLimit && (
        <div className="mt-2 flex items-start gap-2 rounded-ollmost border border-warn/40 bg-[color-mix(in_srgb,var(--o-warn)_8%,transparent)] px-3 py-2.5 text-sm">
          <TriangleAlert className="mt-0.5 size-4 shrink-0 text-warn" />
          <div className="flex-1">
            The model was still using tools after {message.stats.toolRoundLimit} rounds, so it had to answer with what it had.
          </div>
          {isLast && (
            <Button size="sm" onClick={() => onContinue('rounds')}>
              Continue
            </Button>
          )}
        </div>
      )}
      {!streaming && (message.content || !message.error) && (
        <div
          className={cn('mt-2 flex items-center gap-0.5 transition-opacity', isLast ? 'opacity-100' : 'opacity-0 group-hover:opacity-100')}
        >
          <IconButton label={copied ? 'Copied' : 'Copy'} size="sm" onClick={() => copy(plainText(message.content))}>
            {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
          </IconButton>
          {isLast && (
            <IconButton label="Retry" size="sm" onClick={onRetry}>
              <RotateCcw className="size-3.5" />
            </IconButton>
          )}
          <Tooltip content={statsLine(message)}>
            <span className="ml-1 cursor-default text-xs text-subtle">{displayModelName(message.model)}</span>
          </Tooltip>
          {message.stats?.truncatedHistory ? (
            <Tooltip content={`${message.stats.truncatedHistory} older messages were left out to fit the model's context window.`}>
              <TriangleAlert className="ml-1 size-3.5 text-subtle" />
            </Tooltip>
          ) : null}
        </div>
      )}
    </div>
  )
})
