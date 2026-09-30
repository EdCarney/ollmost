import { create } from 'zustand'
import type { Artifact, ChatEvent, ChatUsage, Conversation, Message, SendResult, ToolEvent } from '@shared/types'
import { applyPiece, endLiveThinking, type LiveThinking, type Piece } from '@shared/thinkingStream'
import { api } from '@/lib/api'
import { showsConversation, useApp } from './app'
import { useArtifactPanel } from './artifactPanel'
import { useConfirm } from './confirm'

export interface StreamState {
  messageId: string
  content: string
  thinking: string
  /** Each round's thinking, placed where the round began; the last one is live while its `ms` is null. */
  thinkingSegments: LiveThinking[]
  toolEvents: ToolEvent[]
  startedAt: number
}

interface ChatState {
  conversation: Conversation | null
  messages: Message[]
  artifacts: Artifact[]
  /** Token and cost totals for the open chat. */
  usage: ChatUsage | null
  loading: boolean
  /** Keyed by conversation id so a reply keeps streaming while you look at another chat. */
  streams: Record<string, StreamState>
  /** Keyed by conversation id: a /compact in flight, so its chat's Edit and Retry can be disabled meanwhile. */
  compacting: Record<string, boolean>

  open: (id: string) => Promise<void>
  clear: () => void
  /** Apply the immediate result of send/regenerate/edit before events start arriving. */
  began: (result: SendResult, opts: { replaceFrom?: string }) => void
  setConversation: (c: Conversation) => void
  setCompacting: (conversationId: string, value: boolean) => void
  addArtifact: (a: Artifact) => void
}

function placeholder(result: SendResult): Message {
  return {
    id: result.assistantMessageId,
    conversationId: result.conversation.id,
    parentId: result.userMessage?.id ?? null,
    role: 'assistant',
    content: '',
    thinking: null,
    thinkingSegments: null,
    model: result.conversation.model,
    attachments: [],
    toolEvents: [],
    stats: null,
    error: null,
    createdAt: Date.now()
  }
}

const emptyStream = (messageId: string): StreamState => ({
  messageId,
  content: '',
  thinking: '',
  thinkingSegments: [],
  toolEvents: [],
  startedAt: Date.now()
})

// Each open() gets a number; a response is applied only if no later open() started meanwhile.
let openSeq = 0

export const useChat = create<ChatState>((set, get) => ({
  conversation: null,
  messages: [],
  artifacts: [],
  usage: null,
  loading: false,
  streams: {},
  compacting: {},

  open: async (id) => {
    if (get().conversation?.id === id && !get().loading) return
    // Leaving the open chat for another one: a confirm still waiting on it must not resolve into this one instead
    // (see historyLoss's callers in lib/chatActions, which also re-check the chat after the confirm settles).
    useConfirm.getState().answer(false)
    const seq = ++openSeq
    set({ loading: true, conversation: null, messages: [], artifacts: [], usage: null })
    const detail = await api.conversations.get(id)
    // Switched chats before this one loaded: showing it now would put its messages under the new chat.
    if (seq !== openSeq) return
    if (!detail) {
      set({ loading: false })
      useApp.getState().navigate({ name: 'home' })
      return
    }
    set({
      conversation: detail.conversation,
      messages: detail.messages,
      artifacts: detail.artifacts,
      usage: detail.usage,
      loading: false
    })
  },

  clear: () => set({ conversation: null, messages: [], artifacts: [], usage: null }),

  began: (result, { replaceFrom }) => {
    const convId = result.conversation.id
    set((s) => {
      let messages = s.conversation?.id === convId ? s.messages : []
      if (replaceFrom) {
        const idx = messages.findIndex((m) => m.id === replaceFrom)
        if (idx >= 0) messages = messages.slice(0, idx)
      }
      if (result.userMessage && !messages.some((m) => m.id === result.userMessage!.id)) messages = [...messages, result.userMessage]
      else if (result.userMessage) messages = messages.map((m) => (m.id === result.userMessage!.id ? result.userMessage! : m))
      return {
        conversation: result.conversation,
        messages: [...messages, placeholder(result)],
        streams: { ...s.streams, [convId]: s.streams[convId] ?? emptyStream(result.assistantMessageId) }
      }
    })
    useApp.getState().upsertConversation(result.conversation)
  },

  setConversation: (c) => {
    if (get().conversation?.id === c.id) set({ conversation: c })
    useApp.getState().upsertConversation(c)
  },

  setCompacting: (conversationId, value) => set((s) => ({ compacting: { ...s.compacting, [conversationId]: value } })),

  addArtifact: (a) => set((s) => ({ artifacts: [...s.artifacts.filter((x) => x.id !== a.id), a] }))
}))

// ---- Event handling -----------------------------------------------------

/** Deltas since the last frame, in order: thinking keeps its round so the stream's segments can be built. */
const pending = new Map<string, { messageId: string; pieces: Piece[] }>()
let frame = 0

function flush(): void {
  frame = 0
  if (!pending.size) return
  const batch = new Map(pending)
  pending.clear()
  useChat.setState((s) => {
    const streams = { ...s.streams }
    for (const [convId, d] of batch) {
      const prev = streams[convId]?.messageId === d.messageId ? streams[convId] : emptyStream(d.messageId)
      const now = Date.now()
      let { content, thinking, thinkingSegments } = prev
      for (const piece of d.pieces) {
        if ('content' in piece) content += piece.content
        else thinking += piece.thinking
        thinkingSegments = applyPiece(thinkingSegments, piece, now)
      }
      streams[convId] = { ...prev, content, thinking, thinkingSegments }
    }
    return { streams }
  })
}

const onScreen = (conversationId: string) => showsConversation(useApp.getState().route, conversationId)

/** A chat or a code session from the app's lists. */
function listed(conversationId: string): Conversation | undefined {
  const { conversations, sessions } = useApp.getState()
  return conversations.find((c) => c.id === conversationId) ?? sessions.find((c) => c.id === conversationId)
}

function handle(e: ChatEvent): void {
  switch (e.type) {
    case 'delta': {
      const p = pending.get(e.conversationId)
      const entry = p && p.messageId === e.messageId ? p : { messageId: e.messageId, pieces: [] as Piece[] }
      if (e.content) entry.pieces.push({ content: e.content })
      // Thinking from before rounds were placed (an older main process) counts as the first round's.
      if (e.thinking) entry.pieces.push({ thinking: e.thinking, round: e.round ?? { at: 0, index: 0 } })
      pending.set(e.conversationId, entry)
      if (!frame) frame = requestAnimationFrame(flush)
      break
    }
    case 'tool':
      flush()
      useChat.setState((s) => {
        const prev = s.streams[e.conversationId] ?? emptyStream(e.messageId)
        const toolEvents = [...prev.toolEvents]
        toolEvents[e.index] = e.event
        // A call means the round's thinking is over, whether or not any text followed it.
        const thinkingSegments = endLiveThinking(prev.thinkingSegments, Date.now())
        return { streams: { ...s.streams, [e.conversationId]: { ...prev, toolEvents, thinkingSegments } } }
      })
      // The chat on screen shows the question inline; any other one gets a toast (and a mark in the sidebar).
      if (e.event.awaiting && !onScreen(e.conversationId)) {
        const title = listed(e.conversationId)?.title
        // A chat's first reply runs before it has a title.
        const which = title && title !== 'New chat' ? `"${title}"` : 'A new chat'
        useApp.getState().toast(e.event.ask ? `${which} has a question for you.` : `${which} is waiting for your approval to use a tool.`)
      }
      break
    case 'done': {
      pending.delete(e.conversationId)
      useChat.setState((s) => {
        const { [e.conversationId]: _finished, ...streams } = s.streams
        if (s.conversation?.id !== e.conversationId) return { streams }
        const exists = s.messages.some((m) => m.id === e.message.id)
        return {
          streams,
          conversation: e.conversation,
          artifacts: e.artifacts,
          usage: e.usage,
          messages: exists ? s.messages.map((m) => (m.id === e.message.id ? e.message : m)) : [...s.messages, e.message]
        }
      })
      useApp.getState().upsertConversation(e.conversation)
      useArtifactPanel.getState().settleLive(e.message.id, e.artifacts)
      break
    }
    case 'usage':
      if (useChat.getState().conversation?.id === e.conversationId) useChat.setState({ usage: e.usage })
      break
    case 'error':
      if (useChat.getState().conversation?.id !== e.conversationId) useApp.getState().toast(e.error, 'error')
      break
    case 'title': {
      const conv = listed(e.conversationId)
      if (conv) useApp.getState().upsertConversation({ ...conv, title: e.title })
      const current = useChat.getState().conversation
      if (current?.id === e.conversationId) useChat.setState({ conversation: { ...current, title: e.title } })
      break
    }
  }
}

api.events.onChat(handle)
