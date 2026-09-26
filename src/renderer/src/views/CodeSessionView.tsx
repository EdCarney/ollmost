import { ArrowDown, Bug, ChevronDown, FolderClosed, GitBranch, ScrollText, TriangleAlert } from 'lucide-react'
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Composer } from '@/components/Composer'
import { ConversationMenu } from '@/components/ConversationMenu'
import { AssistantMessage, UserMessage } from '@/components/Messages'
import { TopBar } from '@/components/TopBar'
import { ChatCost } from '@/components/UsageBar'
import { Button, IconButton, Spinner, Tooltip } from '@/components/ui'
import { api } from '@/lib/api'
import { continueReply, editMessage, retryLast, sendMessage } from '@/lib/chatActions'
import { folderName } from '@/lib/codeActions'
import { reportError } from '@/stores/app'
import { useChat } from '@/stores/chat'

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

  const current = conversation?.id === id ? conversation : null

  return (
    <div className="flex h-full min-h-0 flex-col">
      <TopBar
        className="border-b border-transparent"
        right={
          current && (
            <>
              <ChatCost usage={usage} model={current.model} />
              <IconButton label="Open debugger (⌘⇧D)" size="sm" onClick={() => api.debug.open(current.id)}>
                <Bug className="size-4" />
              </IconButton>
            </>
          )
        }
      >
        <div className="flex min-w-0 flex-1 items-center gap-1.5">
          {current?.root && (
            <>
              <Tooltip content={current.root}>
                <button
                  onClick={() => void api.code.reveal(id).catch(reportError)}
                  className="flex min-w-0 items-center gap-1.5 rounded-md px-1.5 py-1 text-[13px] text-muted hover:bg-hover hover:text-fg"
                >
                  <FolderClosed className="size-3.5 shrink-0" />
                  <span className="max-w-[180px] truncate">{folderName(current.root)}</span>
                </button>
              </Tooltip>
              {status?.branch && (
                <span aria-label={`Branch ${status.branch}`} className="flex min-w-0 items-center gap-1 px-1.5 py-1 text-[13px] text-muted">
                  <GitBranch className="size-3.5 shrink-0" />
                  <span className="max-w-[160px] truncate">{status.branch}</span>
                </span>
              )}
              <span className="text-subtle">/</span>
            </>
          )}
          {current && (
            <ConversationMenu
              conversation={current}
              trigger={
                <button className="flex min-w-0 items-center gap-1 rounded-md px-1.5 py-1 text-sm font-medium hover:bg-hover">
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
            {messages.map((m, i) =>
              m.role === 'user' ? (
                <UserMessage key={m.id} message={m} disabled={!!stream} onEdit={(content) => editMessage(m, content, messages)} />
              ) : (
                <AssistantMessage
                  key={m.id}
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
              )
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
            onStop={() => api.chat.stop(id)}
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
