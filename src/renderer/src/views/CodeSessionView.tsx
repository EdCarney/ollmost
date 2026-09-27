import {
  ArrowDown,
  Bug,
  Check,
  ChevronDown,
  ClipboardList,
  FileDiff,
  FolderClosed,
  GitBranch,
  Globe,
  GlobeLock,
  Hammer,
  ScrollText,
  TriangleAlert
} from 'lucide-react'
import { Fragment, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { CodeNetwork } from '@shared/types'
import { Composer } from '@/components/Composer'
import { ConversationMenu } from '@/components/ConversationMenu'
import { CompactionDivider } from '@/components/CompactionDivider'
import { PlanCard } from '@/components/PlanCard'
import { AssistantMessage, UserMessage } from '@/components/Messages'
import { TopBar } from '@/components/TopBar'
import { ChatCost } from '@/components/UsageBar'
import {
  Badge,
  Button,
  IconButton,
  Menu,
  MenuContent,
  MenuItem,
  MenuLabel,
  MenuSeparator,
  MenuTrigger,
  Spinner,
  Tooltip
} from '@/components/ui'
import { api } from '@/lib/api'
import { approvePlan, continueReply, editMessage, retryLast, runCommand, sendMessage, setStage } from '@/lib/chatActions'
import { folderName } from '@/lib/codeActions'
import { reportError } from '@/stores/app'
import { useChangesPanel } from '@/stores/changesPanel'
import { useChat } from '@/stores/chat'
import { NETWORKS, NETWORK_SHORT_LABEL } from '@/views/ToolsSettings'

/** A code session: the chat's transcript and composer, with the folder it works in and that folder's branch. */
export function CodeSessionView({ id }: { id: string }) {
  const { conversation, messages, artifacts, loading, open, usage, setConversation } = useChat()
  const stream = useChat((s) => s.streams[id])
  const scroller = useRef<HTMLDivElement>(null)
  const pinned = useRef(true)
  const [showJump, setShowJump] = useState(false)
  const [status, setStatus] = useState<{ found: boolean; branch: string | null } | null>(null)

  const refreshStatus = useCallback(() => {
    void api.code.status(id).then(setStatus).catch(reportError)
  }, [id])

  useEffect(() => {
    pinned.current = true
    void open(id)
  }, [id, open])

  useEffect(refreshStatus, [refreshStatus])

  // A reply can switch branches or move things, so look again each time one finishes.
  const streaming = !!stream
  const wasStreaming = useRef(streaming)
  useEffect(() => {
    if (wasStreaming.current && !streaming) refreshStatus()
    wasStreaming.current = streaming
  }, [streaming, refreshStatus])

  // Stick to the bottom while content grows, unless the user scrolled up to read.
  useLayoutEffect(() => {
    const el = scroller.current
    if (el && pinned.current) el.scrollTop = el.scrollHeight
  }, [messages, stream?.content, stream?.thinking, loading])

  const onScroll = () => {
    const el = scroller.current!
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80
    pinned.current = atBottom
    setShowJump(!atBottom)
  }

  const jump = () => {
    pinned.current = true
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight, behavior: 'smooth' })
  }

  const locate = async () => {
    try {
      const updated = await api.code.locate(id)
      if (!updated) return
      setConversation(updated)
      refreshStatus()
    } catch (err) {
      reportError(err)
    }
  }

  const setNetwork = async (network: CodeNetwork) => {
    try {
      setConversation(await api.conversations.update(id, { network }))
    } catch (err) {
      reportError(err)
    }
  }

  // This view is keyed by id (App.tsx), so leaving this session for another one or elsewhere unmounts it: close
  // the Changes panel then, if it was the one open, so it doesn't silently reopen on a later visit to this session.
  useEffect(() => {
    return () => {
      if (useChangesPanel.getState().sessionId === id) useChangesPanel.getState().close()
    }
  }, [id])

  const current = conversation?.id === id ? conversation : null
  const [starting, setStarting] = useState(false)
  // A /compact summary ends after the last message it covers; the divider goes there.
  const compaction = current?.compaction ?? null
  const compactedAfter = compaction ? messages.filter((m) => m.createdAt <= compaction.upTo).at(-1)?.id : null
  const changesOpen = useChangesPanel((s) => s.open && s.sessionId === id)
  const changesCountFor = useChangesPanel((s) => s.countFor)
  const changesCount = useChangesPanel((s) => s.count)
  const changesBadge = changesCountFor === id ? changesCount : 0

  return (
    <div className="flex h-full min-h-0 flex-col">
      <TopBar
        className="border-b border-transparent"
        right={
          current && (
            <>
              <ChatCost usage={usage} model={current.model} />
              <div className="relative">
                <IconButton
                  label="Changes"
                  size="sm"
                  active={changesOpen}
                  aria-pressed={changesOpen}
                  data-testid="changes-toggle"
                  onClick={() => useChangesPanel.getState().toggle(id)}
                >
                  <FileDiff className="size-4" />
                </IconButton>
                {changesBadge > 0 && (
                  <Badge tone="neutral" className="pointer-events-none absolute -right-1.5 -top-1.5">
                    {changesBadge}
                  </Badge>
                )}
              </div>
              <IconButton label="Open debugger (⌘⇧D)" size="sm" onClick={() => api.debug.open(current.id)}>
                <Bug className="size-4" />
              </IconButton>
            </>
          )
        }
      >
        {/* The title's menu must stay reachable: while the Changes panel is open the chips show only their icons, when
            room runs short they shrink before the title, and what still doesn't fit is clipped rather than laid over
            the right side. */}
        <div className="flex min-w-0 flex-1 items-center gap-1.5 overflow-hidden">
          {current?.root && (
            <>
              <Tooltip content={current.root}>
                <button
                  onClick={() => void api.code.reveal(id).catch(reportError)}
                  className="flex min-w-8 shrink-[3] items-center gap-1.5 rounded-md px-1.5 py-1 text-[13px] text-muted hover:bg-hover hover:text-fg"
                >
                  <FolderClosed className="size-3.5 shrink-0" />
                  <span className={`max-w-[180px] truncate${changesOpen ? ' hidden' : ''}`}>{folderName(current.root)}</span>
                </button>
              </Tooltip>
              {status?.branch && (
                <span
                  aria-label={`Branch ${status.branch}`}
                  className="flex min-w-8 shrink-[3] items-center gap-1 px-1.5 py-1 text-[13px] text-muted"
                >
                  <GitBranch className="size-3.5 shrink-0" />
                  <span className={`max-w-[160px] truncate${changesOpen ? ' hidden' : ''}`}>{status.branch}</span>
                </span>
              )}
              <Menu>
                <MenuTrigger asChild>
                  <button
                    data-testid="network-chip"
                    aria-label={`Network: ${NETWORK_SHORT_LABEL[current.network]}`}
                    className="flex min-w-8 shrink-[3] items-center gap-1 rounded-md px-1.5 py-1 text-[13px] text-muted hover:bg-hover hover:text-fg"
                  >
                    {current.network === 'none' ? <GlobeLock className="size-3.5 shrink-0" /> : <Globe className="size-3.5 shrink-0" />}
                    <span className={`max-w-[140px] truncate${changesOpen ? ' hidden' : ''}`}>{NETWORK_SHORT_LABEL[current.network]}</span>
                  </button>
                </MenuTrigger>
                <MenuContent align="start" className="max-w-[260px]">
                  {NETWORKS.map((o) => (
                    <MenuItem
                      key={o.value}
                      icon={o.value === current.network ? <Check className="size-4 text-accent" /> : null}
                      onSelect={() => void setNetwork(o.value)}
                    >
                      {o.label}
                    </MenuItem>
                  ))}
                  <MenuSeparator />
                  <MenuLabel>
                    Registries + git hosts is the only preset that can send data out of your Mac. Takes effect at the next command.
                  </MenuLabel>
                </MenuContent>
              </Menu>
              <Menu>
                <MenuTrigger asChild>
                  <button
                    data-testid="stage-chip"
                    aria-label={current.stage === 'plan' ? 'Stage: Plan' : 'Stage: Work'}
                    className="flex min-w-8 shrink-[3] items-center gap-1 rounded-md px-1.5 py-1 text-[13px] text-muted hover:bg-hover hover:text-fg"
                  >
                    {current.stage === 'plan' ? <ClipboardList className="size-3.5 shrink-0" /> : <Hammer className="size-3.5 shrink-0" />}
                    <span className={`truncate${changesOpen ? ' hidden' : ''}`}>{current.stage === 'plan' ? 'Plan' : 'Work'}</span>
                  </button>
                </MenuTrigger>
                <MenuContent align="start" className="max-w-[280px]">
                  <MenuItem
                    icon={current.stage === 'plan' ? <Check className="size-4 text-accent" /> : null}
                    disabled={!!stream}
                    onSelect={() => void setStage(id, 'plan')}
                  >
                    Plan
                  </MenuItem>
                  <MenuItem
                    icon={current.stage === 'work' ? <Check className="size-4 text-accent" /> : null}
                    disabled={!!stream}
                    onSelect={() => void setStage(id, 'work')}
                  >
                    Work
                  </MenuItem>
                  <MenuSeparator />
                  <MenuLabel>
                    In plan mode the model reads and searches the folder and writes a plan; its edits and commands are withheld until you
                    start working, which keeps that plan for the turns that follow. MCP tools stay on and still ask. Changes once the reply
                    ends.
                  </MenuLabel>
                </MenuContent>
              </Menu>
              <span className="text-subtle">/</span>
            </>
          )}
          {current && (
            <ConversationMenu
              conversation={current}
              trigger={
                <button className="flex min-w-24 items-center gap-1 rounded-md px-1.5 py-1 text-sm font-medium hover:bg-hover">
                  <span className="truncate">{current.title}</span>
                  <ChevronDown className="size-3.5 shrink-0 text-subtle" />
                </button>
              }
            />
          )}
          {current?.instructions.trim() && (
            <Tooltip content={`Session instructions: ${current.instructions.trim().slice(0, 200)}`}>
              <span aria-label="This session has its own instructions" className="flex shrink-0 items-center text-subtle">
                <ScrollText className="size-3.5" />
              </span>
            </Tooltip>
          )}
        </div>
      </TopBar>

      {status && !status.found && current?.root && (
        <div className="shrink-0 px-6 pt-2">
          <div
            className="mx-auto flex items-center gap-2 rounded-ollmost border border-warn/40 bg-[color-mix(in_srgb,var(--o-warn)_8%,transparent)] px-3 py-2.5 text-sm"
            style={{ maxWidth: 'var(--o-chat-width)' }}
          >
            <TriangleAlert className="size-4 shrink-0 text-warn" />
            <div className="selectable min-w-0 flex-1">
              This session's folder is no longer at {current.root} (moved, renamed or deleted).
            </div>
            <Button size="sm" onClick={() => void locate()}>
              Choose folder…
            </Button>
          </div>
        </div>
      )}

      <div ref={scroller} onScroll={onScroll} className="relative min-h-0 flex-1 overflow-y-auto">
        {loading ? (
          <div className="flex h-full items-center justify-center">
            <Spinner />
          </div>
        ) : (
          <div className="mx-auto space-y-8 px-6 pb-10 pt-4" style={{ maxWidth: 'calc(var(--o-chat-width) + 48px)' }}>
            {messages.map((m, i) => (
              <Fragment key={m.id}>
                {m.role === 'user' ? (
                  <UserMessage message={m} disabled={!!stream} onEdit={(content) => editMessage(m, content, messages)} />
                ) : (
                  <AssistantMessage
                    message={m}
                    stream={stream?.messageId === m.id ? stream : undefined}
                    artifacts={artifacts}
                    isLast={i === messages.length - 1}
                    scope="session"
                    onRetry={() => retryLast(id, messages)}
                    onContinue={(reason) => {
                      pinned.current = true
                      void continueReply(id, reason)
                    }}
                  />
                )}
                {compaction && compactedAfter === m.id && <CompactionDivider compaction={compaction} />}
              </Fragment>
            ))}
            {current?.stage === 'plan' && !!current.plan && !stream && (
              <PlanCard
                disabled={starting}
                onStart={() => {
                  pinned.current = true
                  setStarting(true)
                  void approvePlan(id).finally(() => setStarting(false))
                }}
              />
            )}
          </div>
        )}
      </div>

      <div className="relative shrink-0 px-6 pb-5">
        {showJump && (
          <button
            onClick={jump}
            aria-label="Scroll to bottom"
            className="absolute -top-12 left-1/2 flex size-8 -translate-x-1/2 items-center justify-center rounded-full border border-line bg-panel text-muted shadow-md hover:text-fg"
          >
            <ArrowDown className="size-4" />
          </button>
        )}
        <div className="mx-auto" style={{ maxWidth: 'var(--o-chat-width)' }}>
          <Composer
            conversation={current}
            draftKey={id}
            streaming={!!stream}
            autoFocus
            mode="code"
            placeholder={current?.stage === 'plan' ? 'Ask for a plan…' : undefined}
            onStop={() => api.chat.stop(id)}
            onCommand={(cmd) => runCommand(id, cmd)}
            onSubmit={async (input) => {
              pinned.current = true
              return sendMessage(id, null, input)
            }}
          />
          <p className="mt-2 text-center text-[11px] text-subtle">Commands run in a sandbox and ask first. Check what the model changed.</p>
        </div>
      </div>
    </div>
  )
}
