import { appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { BrowserWindow } from 'electron'
import { parseMessage } from '@shared/artifactParser'
import { normalizeSpaces } from '@shared/text'
import { contextOptions, effectiveContext } from '@shared/context'
import { EVENT_CHANNELS } from '@shared/ipc'
import { resolveThinkProfile, toOllamaThink } from '@shared/thinking'
import type {
  ChatEvent,
  Compaction,
  Conversation,
  Message,
  MessageStats,
  SendRequest,
  SendResult,
  ThinkingSegment,
  ThinkSetting,
  ToolDecision,
  ToolEvent
} from '@shared/types'
import { addArtifactVersion, listArtifacts, pruneEmptyArtifacts } from '../db/artifacts'
import {
  attachmentRowsForMessage,
  checkpointMessage,
  createConversation,
  deleteMessagesFrom,
  getConversation,
  getMessage,
  insertMessage,
  linkAttachments,
  listMessages,
  setCompaction,
  unfinishedReplyIds,
  updateConversation,
  updateMessage
} from '../db/conversations'
import { getProject, projectKnowledge, touchProject } from '../db/projects'
import { imageForModel, removeFiles } from '../files/ingest'
import { type ChatBody, type ChatChunk, chatOnce, chatStream, endpointFor, streamTimeoutsFor, type ToolCall } from '../ollama/client'
import { getModelInfo } from '../ollama/models'
import { webAvailable } from '../ollama/web'
import { startTrace, type Trace } from '../debug/traces'
import { paths } from '../paths'
import { getSettings } from '../settings'
import { getSkill, listSkills } from '../skills/library'
import { ensure as ensureServers, readyTools } from '../mcp/manager'
import { MCP_SOURCE } from '../mcp/provider'
import { type CodeSession, prepareCodeSession } from '../code/session'
import { CODE_SOURCE } from '../runner/provider'
import { runnerStatus } from '../runner/status'
import { prepareWorkspace, type Workspace, workspaceFor } from '../runner/workspace'
import { conversationUsage, insertUsageEvent } from '../db/usage'
import { requestCost } from '../usage/pricing'
import { errorMessage, estimateTokens } from '../util'
import { EVERY_TIME, waitForDecision } from './approvals'
import { hasPrivateFiles } from './exposure'
import { assemble, type HistoryTurn, promptBudget } from './assemble'
import { TITLE_PROMPT } from './prompts'
import { TOOL_RESULT_CHARS } from './results'
import {
  allowKeyFor,
  approvalFor,
  declinedResult,
  missingAbilities,
  noteAllowedForChat,
  pendingEvent,
  replayCalls,
  runTool,
  settleToolEvent,
  type ToolContext,
  toolEndpoint,
  toolGrants,
  type ToolResult,
  toolsFor
} from './tools'
import type { WebStatus } from './prompts'
import { turnPolicy } from './turn'

/** How long a reply waits for the chat's MCP servers to start; ones still starting are left out of it. */
const SERVER_WAIT_MS = 30_000
// Sharing a round's room between its tool results: estimateTokens counts 4 characters a token, and a tenth is left
// for the notes and framing around them. Each result still gets a little, so the model sees what came back.
const CHARS_PER_TOKEN = 4
const ROOM_SHARE = 0.9
const MIN_RESULT_CHARS = 1_500

/** Settings for one reply, for callers in the main process (the renderer can't set them). */
export interface ReplyOptions {
  /** Requests the reply may make, the last of them without tools. Defaults to what the conversation's kind allows (see turn.ts). */
  maxToolRounds?: number
}
// How often a streaming reply is saved, so a quit or crash loses at most this much.
const CHECKPOINT_MS = 1500

/**
 * Replies in progress, by conversation. `settled` resolves once the reply has been saved. `quiet` marks a
 * stop made for a delete or a quit, where the chat won't be seen again, so no title is generated.
 */
interface Run {
  controller: AbortController
  flags: { quiet: boolean }
  settled: Promise<void>
}
const active = new Map<string, Run>()

function emit(event: ChatEvent): void {
  for (const win of BrowserWindow.getAllWindows()) win.webContents.send(EVENT_CHANNELS.chat, event)
}

function assertIdle(conversationId: string): void {
  if (active.has(conversationId)) throw new Error('Ollmost is still responding in this chat.')
}

export function send(req: SendRequest, reply: ReplyOptions = {}): SendResult {
  if (!req.content.trim() && !req.attachmentIds.length) throw new Error('Message is empty')
  let conversation: Conversation | null
  if (req.conversationId) {
    conversation = getConversation(req.conversationId)
    if (!conversation) throw new Error('Conversation not found')
    assertIdle(conversation.id)
    conversation = updateConversation(conversation.id, {
      model: req.model,
      think: req.think,
      skills: req.skills,
      toolSources: req.toolSources,
      touch: true
    })
  } else {
    conversation = createConversation({
      projectId: req.projectId,
      model: req.model,
      think: req.think,
      skills: req.skills,
      toolSources: req.toolSources
    })
  }
  const previous = listMessages(conversation.id).at(-1)
  const user = insertMessage({ conversationId: conversation.id, parentId: previous?.id ?? null, role: 'user', content: req.content })
  linkAttachments(req.attachmentIds, user.id)
  if (conversation.projectId) touchProject(conversation.projectId)
  return startAssistant(conversation, getMessage(user.id)!, req.model, req.think, reply)
}

export async function regenerate(
  conversationId: string,
  opts: { model: string; think: ThinkSetting | null },
  reply: ReplyOptions = {}
): Promise<SendResult> {
  assertIdle(conversationId)
  const messages = listMessages(conversationId)
  const lastUserIndex = messages.findLastIndex((m) => m.role === 'user')
  if (lastUserIndex < 0) throw new Error('Nothing to retry')
  await dropAfter(conversationId, messages, lastUserIndex)
  uncompactFrom(conversationId, messages[lastUserIndex])
  const conversation = updateConversation(conversationId, { model: opts.model, think: opts.think, touch: true })
  return startAssistant(conversation, messages[lastUserIndex], opts.model, opts.think, reply)
}

export async function edit(
  messageId: string,
  content: string,
  opts: { model: string; think: ThinkSetting | null },
  reply: ReplyOptions = {}
): Promise<SendResult> {
  const original = getMessage(messageId)
  if (!original || original.role !== 'user') throw new Error('Only your own messages can be edited')
  assertIdle(original.conversationId)
  const messages = listMessages(original.conversationId)
  await dropAfter(
    original.conversationId,
    messages,
    messages.findIndex((m) => m.id === messageId)
  )
  uncompactFrom(original.conversationId, original)
  const user = updateMessage(messageId, { content })
  const conversation = updateConversation(original.conversationId, { model: opts.model, think: opts.think, touch: true })
  return startAssistant(conversation, user, opts.model, opts.think, reply)
}

/**
 * Stop a reply and wait until what it produced has been saved. Pass `quiet` when stopping for a delete or
 * a quit; a plain Stop still lets a new chat get its title.
 */
export function stop(conversationId: string, opts: { quiet?: boolean } = {}): Promise<void> {
  const run = active.get(conversationId)
  if (!run) return Promise.resolve()
  if (opts.quiet) run.flags.quiet = true
  run.controller.abort()
  return run.settled
}

export const isReplying = (): boolean => active.size > 0
/** Whether a reply is running in this conversation. */
export const isReplyingIn = (conversationId: string): boolean => active.has(conversationId)

/**
 * Replies that were still streaming when Ollmost last quit or crashed. Their checkpointed text is kept;
 * they're marked so the chat shows what happened and offers Retry. Run once at startup.
 */
export function markInterruptedReplies(): number {
  const ids = unfinishedReplyIds()
  for (const id of ids) {
    const m = getMessage(id)!
    // Passing the content indexes it for search; checkpoints skip indexing.
    updateMessage(id, {
      content: m.content,
      toolEvents: m.toolEvents.map(settleToolEvent),
      error: 'Ollmost closed before this reply finished.'
    })
  }
  return ids.length
}

/**
 * Quietly stop every reply in progress (or those in chats matching `which`) and wait for each to save.
 * Used before quitting and deleting a project.
 */
export async function stopAll(which: (conversationId: string) => boolean = () => true): Promise<void> {
  await Promise.all([...active.keys()].filter(which).map((id) => stop(id, { quiet: true })))
}

async function dropAfter(conversationId: string, messages: Message[], index: number): Promise<void> {
  const next = messages[index + 1]
  if (!next) return
  await removeFiles(deleteMessagesFrom(conversationId, next.createdAt))
  pruneEmptyArtifacts(conversationId)
}

function startAssistant(
  conversation: Conversation,
  parent: Message,
  model: string,
  think: ThinkSetting | null,
  reply: ReplyOptions
): SendResult {
  const assistant = insertMessage({ conversationId: conversation.id, parentId: parent.id, role: 'assistant', content: '', model })
  const controller = new AbortController()
  const flags = { quiet: false }
  const settled = generate(conversation.id, assistant.id, model, think, controller, flags, reply)
    .catch((err) => console.error('Ollmost: a reply failed to finish', err))
    .finally(() => {
      // Only remove our own entry: a reply that overlapped this one must stay stoppable.
      if (active.get(conversation.id)?.controller === controller) active.delete(conversation.id)
    })
  active.set(conversation.id, { controller, flags, settled })
  return { conversation, userMessage: parent, assistantMessageId: assistant.id }
}

async function toTurn(message: Message, vision: boolean): Promise<HistoryTurn> {
  const turn: HistoryTurn = { role: message.role, content: message.content, documents: [], images: [], hiddenImages: [] }
  if (message.role !== 'user') {
    turn.tools = replayCalls(message.toolEvents)
    return turn
  }
  for (const a of attachmentRowsForMessage(message.id)) {
    if (a.kind === 'image') {
      if (vision) turn.images.push(await imageForModel(a.path, a.mime))
      else turn.hiddenImages.push(a.name)
    } else {
      turn.documents.push({
        name: a.name,
        text: a.text || '[No text could be extracted from this file. It may be a scanned document or an image-only PDF.]'
      })
    }
  }
  return turn
}

async function generate(
  conversationId: string,
  messageId: string,
  modelName: string,
  think: ThinkSetting | null,
  controller: AbortController,
  flags: Run['flags'],
  reply: ReplyOptions
): Promise<void> {
  let content = ''
  let thinking = ''
  // Each round's thinking with where the round began, so the UI can show it there (#109).
  const thinkingSegments: ThinkingSegment[] = []
  let roundAt = { at: 0, index: 0 }
  // Where the next round begins in the text: where the last round's calls sat, before the separator after them.
  let nextRoundAt: number | null = null
  let roundThinkStart: number | null = null
  let roundThinkEnd: number | null = null
  const roundThinkMs = () => (roundThinkStart ? (roundThinkEnd ?? Date.now()) - roundThinkStart : null)
  const toolEvents: ToolEvent[] = []
  const stats: MessageStats = { promptTokens: 0, completionTokens: 0 }
  const startedAt = Date.now()
  let thinkStart: number | null = null
  let thinkEnd: number | null = null
  let evalNs = 0
  let error: string | null = null
  let openRound: { content: string; thinking: string; promptEstimate: number } | null = null
  let roundTrace: Trace | null = null

  // Each round is a separate billed request: log it, and roll it into the message's stats.
  const recordRound = (final: ChatChunk | null) => {
    if (!openRound) return null
    const estimated = !final?.eval_count
    const promptTokens = final?.prompt_eval_count ?? openRound.promptEstimate
    const completionTokens = final?.eval_count ?? estimateTokens(openRound.content + openRound.thinking)
    const costUsd = requestCost(modelName, promptTokens, completionTokens)
    insertUsageEvent({ conversationId, messageId, model: modelName, kind: 'chat', promptTokens, completionTokens, costUsd, estimated })
    stats.promptTokens! += promptTokens
    stats.completionTokens! += completionTokens
    stats.costUsd = stats.costUsd === null || costUsd === null ? null : (stats.costUsd ?? 0) + costUsd
    if (estimated) stats.estimated = true
    openRound = null
    return { promptTokens, completionTokens, costUsd, estimated }
  }

  const delta = (d: { content?: string; thinking?: string; round?: { at: number; index: number } }) =>
    emit({ type: 'delta', conversationId, messageId, ...d })
  // The segments so far, the open round's partial thinking included (a checkpoint may be the last save).
  const segmentsNow = (): ThinkingSegment[] | null => {
    const open = openRound?.thinking ? [{ text: openRound.thinking, ...roundAt, ms: roundThinkMs() }] : []
    const all = [...thinkingSegments, ...open]
    return all.length ? all : null
  }

  // Save progress now and then, so a quit or crash keeps the partial reply (see markInterruptedReplies).
  let savedAt = Date.now()
  const checkpoint = (now = false) => {
    if (!now && Date.now() - savedAt < CHECKPOINT_MS) return
    savedAt = Date.now()
    checkpointMessage(messageId, { content, thinking: thinking || null, thinkingSegments: segmentsNow(), toolEvents })
  }

  try {
    const conversation = getConversation(conversationId)!
    const settings = getSettings()
    const model = await getModelInfo(modelName)
    const profile = resolveThinkProfile(modelName, model.capabilities, model.overrides.think)
    const vision = model.capabilities.includes('vision')
    const toolsCapable = model.capabilities.includes('tools')
    const numCtx = effectiveContext(model, settings.localNumCtx)
    const budget = promptBudget(numCtx)
    const autoSkills = settings.skills.autoLoad && toolsCapable && model.overrides.autoSkills !== false
    const web: WebStatus = !settings.web.enabled ? 'off' : !toolsCapable ? 'unsupported' : webAvailable() ? 'on' : 'no-key'

    const selectedIds = conversation.skills
    let loadedIds = conversation.autoSkills.filter((id) => !selectedIds.includes(id))
    const load = async (ids: string[]) =>
      (await Promise.all(ids.map((id) => getSkill(id))))
        .filter((s) => !!s && s.enabled)
        .map((s) => ({ name: s!.name, body: s!.body, files: s!.files, hasScripts: s!.hasScripts }))
    const skillIndex = autoSkills
      ? (await listSkills()).filter((s) => s.enabled && !selectedIds.includes(s.id) && !loadedIds.includes(s.id))
      : []

    // The chat's MCP servers: started if they aren't running (usually they are, from when the chat was opened).
    const sources = toolsCapable ? conversation.toolSources : []
    // What this reply may do, by the kind of conversation: a code session's row says so (#78).
    const policy = turnPolicy({
      mode: conversation.mode,
      sources,
      artifacts: settings.artifacts.enabled && model.overrides.artifacts !== false,
      maxToolRounds: reply.maxToolRounds,
      codeRounds: settings.code.maxRounds
    })
    const serverIds = sources.filter((s) => s.startsWith(MCP_SOURCE)).map((s) => s.slice(MCP_SOURCE.length))
    const unavailable = serverIds.length ? await ensureServers(serverIds, SERVER_WAIT_MS) : []
    if (!toolsCapable && conversation.toolSources.length)
      unavailable.push(`${modelName} can't use tools, so this chat's tools weren't used.`)

    // The folder code runs in. A chat's is readied (its attachments copied in) only when the code runner is on; a code
    // session's is the user's, readied for its own tools (#88). Either fails when code an earlier run left can't be
    // stopped (#71), a session's also when its folder isn't where it was: the reply then has no code tools, and says so.
    let workspace: Workspace | null = null
    let codeRunner: { pypi: boolean; timeoutSec: number; uploads: string[] } | null = null
    let codeSession: CodeSession | null = null
    const wantsRunner = policy.mode === 'chat' && sources.includes(CODE_SOURCE) && settings.runner.mode !== 'off'
    if (policy.mode === 'code' || wantsRunner) {
      const what = policy.mode === 'code' ? "This session's tools aren't available" : "The code runner isn't available"
      // A session needs the runner too: the reaper that stops what a command leaves running is a Python script.
      const runner = await runnerStatus()
      if (policy.mode === 'code') {
        const ws = workspaceFor(conversationId)
        const session = runner.available
          ? await prepareCodeSession(ws, { network: conversation.network, timeoutSec: settings.code.timeoutSec }).catch(
              (err: unknown) => new Error(errorMessage(err))
            )
          : new Error(runner.reason ?? 'the runner is not available')
        if (session instanceof Error) {
          unavailable.push(`${what}: ${session.message}`)
          // Still a session's reply, with no tools: the prompt says what it is and can't do.
          codeSession = {
            root: ws.root,
            instructions: null,
            branch: null,
            network: conversation.network,
            timeoutSec: settings.code.timeoutSec
          }
        } else {
          workspace = ws
          codeSession = session
        }
      } else if (!runner.available) unavailable.push(`${what}: ${runner.reason}`)
      else {
        const ws = workspaceFor(conversationId)
        const ready = await prepareWorkspace(ws).catch((err: unknown) => new Error(errorMessage(err)))
        if (ready instanceof Error) unavailable.push(`${what}: ${ready.message}`)
        else {
          workspace = ws
          codeRunner = { pypi: settings.runner.pypi, timeoutSec: settings.runner.timeoutSec, uploads: ready.uploads }
        }
      }
    }
    if (unavailable.length) stats.unavailableTools = unavailable

    const project = conversation.projectId ? getProject(conversation.projectId) : null
    const messages = listMessages(conversationId)
    const toolContext: ToolContext = {
      mode: policy.mode,
      skills: skillIndex.length > 0,
      web: web === 'on',
      sources,
      // Files the user shared are private, and a fetch URL could carry them out (#62).
      privateFiles: hasPrivateFiles(conversation, messages),
      workspace,
      signal: controller.signal
    }
    const grants = toolGrants(toolContext)
    const tools = toolsFor(toolContext)
    const maxRounds = policy.maxRounds
    const running = new Set(serverIds)
    const servers = readyTools()
      .filter((r) => running.has(r.server.id))
      .map((r) => r.server.name)

    // After a /compact, the request replays the summary in the system prompt and only the messages that followed.
    const compaction = conversation.compaction
    const history = await Promise.all(
      messages
        .filter((m) => m.id !== messageId && !(m.role === 'assistant' && !m.content) && (!compaction || m.createdAt > compaction.upTo))
        .map((m) => toTurn(m, vision))
    )

    const assembled = assemble({
      model: modelName,
      contextLength: numCtx,
      userName: settings.userName,
      preferences: settings.preferences,
      date: new Date(),
      artifacts: { enabled: policy.artifacts, allowCdn: settings.artifacts.allowCdn },
      web,
      grants: [...grants],
      mcpServers: servers,
      codeRunner,
      codeSession,
      toolTokens: toolsTokens(tools),
      pastTools: toolsCapable,
      project: project ? { name: project.name, instructions: project.instructions } : null,
      chatInstructions: conversation.instructions,
      knowledge: project ? projectKnowledge(project.id) : [],
      skillIndex,
      selectedSkills: await load(selectedIds),
      loadedSkills: await load(loadedIds),
      history,
      compaction: compaction ? { summary: compaction.summary, turns: compaction.turns } : null
    })
    if (assembled.droppedTurns) stats.truncatedHistory = assembled.droppedTurns

    const body: ChatBody = {
      model: modelName,
      messages: assembled.messages,
      think: toOllamaThink(profile, think),
      tools,
      // Cloud models manage their own context; local ones default to a small window unless told otherwise.
      options: contextOptions(model, settings.localNumCtx)
    }

    const triedUnknown: string[] = []
    // What the user denied in this reply, by allow key (not asked about again). What they allowed for the whole chat
    // is read from the chat at each call, so "Ask again before each tool" takes effect mid-reply.
    const declined = new Set<string>()
    const allowedInChat = () => getConversation(conversationId)?.allowedTools ?? []
    // This turn's tool results, oldest first: when the request outgrows the context window, the oldest are shortened.
    const turnResults: Array<{ index: number; round: number; note: string }> = []
    // Ollama's token count for the last request, and what we estimated it at, to correct later estimates.
    let lastCount: { actual: number; estimated: number } | null = null
    const promptTokens = () => {
      const estimate = estimatePrompt(body)
      // Ollama's count plus our estimate of what's been added since, but never below our own estimate: a local
      // model that reused its cache can report fewer tokens than the request holds.
      return lastCount ? Math.max(estimate, lastCount.actual + estimate - lastCount.estimated) : estimate
    }

    for (let round = 0; round < maxRounds; round++) {
      // The last round never offers tools, so every turn ends with an answer in words.
      if (round === maxRounds - 1 && body.tools) {
        body.tools = undefined
        // The model called tools in every round so far: the reply shows that it ran out, and offers Continue.
        if (round > 0) stats.toolRoundLimit = maxRounds
      }
      // assemble() fitted the history; since then each round has added tool results. Keep the newest round's
      // whole and shorten older ones until the request fits (Ollama would otherwise cut the prompt silently).
      while (turnResults.length && turnResults[0].round < round - 1 && promptTokens() > budget) {
        const r = turnResults.shift()!
        body.messages[r.index] = { ...body.messages[r.index], content: r.note }
        stats.shortenedToolResults = (stats.shortenedToolResults ?? 0) + 1
      }
      debugLog(body)
      const calls: ToolCall[] = []
      let roundContent = ''
      let roundThinking = ''
      let final: ChatChunk | null = null
      openRound = { content: '', thinking: '', promptEstimate: estimatePrompt(body) }
      roundAt = { at: nextRoundAt ?? content.length, index: toolEvents.length }
      nextRoundAt = null
      roundThinkStart = null
      roundThinkEnd = null
      roundTrace = startTrace({
        kind: 'chat',
        conversationId,
        messageId,
        model: modelName,
        round,
        endpoint: endpointFor('/api/chat'),
        request: { ...body, stream: true },
        summary: 'Streaming…'
      })
      let chunks = 0
      for await (const chunk of chatStream(body, controller.signal, streamTimeoutsFor(model.location))) {
        chunks++
        roundTrace.firstByte()
        const m = chunk.message
        if (m?.thinking || m?.content) {
          roundTrace.firstToken()
          roundTrace.progress(roundContent || 'Thinking…', estimateTokens(roundContent + roundThinking))
        }
        if (m?.thinking) {
          thinkStart ??= Date.now()
          thinking += m.thinking
          roundThinking += m.thinking
          openRound.thinking += m.thinking
          roundThinkStart ??= Date.now()
          delta({ thinking: m.thinking, round: roundAt })
        }
        if (m?.content) {
          if (thinkStart && !thinkEnd) thinkEnd = Date.now()
          if (roundThinkStart && !roundThinkEnd) roundThinkEnd = Date.now()
          content += m.content
          roundContent += m.content
          openRound.content += m.content
          delta({ content: m.content })
        }
        if (m?.tool_calls?.length) calls.push(...m.tool_calls)
        if (chunk.done) final = chunk
        checkpoint()
      }
      if (final?.prompt_eval_count) lastCount = { actual: final.prompt_eval_count, estimated: openRound.promptEstimate }
      if (roundThinking) thinkingSegments.push({ text: roundThinking, ...roundAt, ms: roundThinkMs() })
      const billed = recordRound(final)
      // Another round follows a tool call: show the chat's totals now rather than when the reply ends (the done carries them).
      if (calls.length) emit({ type: 'usage', conversationId, usage: conversationUsage(conversationId) })
      // The last round's reason is the reply's: "length" means the model was cut off mid-answer.
      if (final?.done_reason) stats.doneReason = final.done_reason
      const { message: _message, ...finalStats } = final ?? { done: true }
      roundTrace.finish({
        status: 'ok',
        response: {
          content: roundContent,
          thinking: roundThinking,
          toolCalls: calls.length ? calls : undefined,
          final: finalStats,
          chunks
        },
        promptTokens: billed?.promptTokens,
        completionTokens: billed?.completionTokens,
        costUsd: billed?.costUsd,
        summary: calls.length ? `→ ${calls.map((c) => c.function.name).join(', ')}` : roundContent.trim() || '(empty reply)',
        ollama: final ?? undefined
      })
      roundTrace = null
      evalNs += final?.eval_duration ?? 0
      if (!calls.length) break

      body.messages.push({ role: 'assistant', content: roundContent, thinking: roundThinking || undefined, tool_calls: calls })
      // The newest round's results are never shortened, so together they must fit what's left of the budget once this
      // turn's older results are (next round). Share that room between the calls as they finish.
      const shortenable = turnResults.reduce(
        (n, r) => n + estimateTokens(String(body.messages[r.index].content)) - estimateTokens(r.note),
        0
      )
      let roomChars = Math.floor((budget - promptTokens() + shortenable) * CHARS_PER_TOKEN * ROOM_SHARE)
      let callsLeft = calls.length
      let onlyUnknown = true
      for (const call of calls) {
        const index = toolEvents.length
        // `at` places the call in the reply's text, where the UI shows it.
        const pending = { ...(await pendingEvent(call, toolContext)), at: content.length }
        toolEvents.push(pending)
        emit({ type: 'tool', conversationId, messageId, index, event: pending })

        // A tool that acts on this Mac or the user's accounts waits for their answer (unless allowed for this chat).
        // Stop, deleting the chat and quitting abort the wait, and the call never runs.
        let decision: ToolDecision | 'auto' = 'auto'
        const allowKey = allowKeyFor(call, toolContext)
        const approval = approvalFor(call, toolContext)
        // A call that asks every time does so even if the chat somehow holds an answer for it.
        const everyTime = approval === 'ask-every-time'
        if (approval !== 'auto' && (everyTime || !allowedInChat().includes(allowKey))) {
          if (declined.has(allowKey)) decision = 'deny'
          else {
            toolEvents[index] = { ...pending, awaiting: true, ...(everyTime && { everyTime }) }
            emit({ type: 'tool', conversationId, messageId, index, event: toolEvents[index] })
            checkpoint(true)
            decision = await waitForDecision(conversationId, messageId, index, controller.signal, everyTime ? EVERY_TIME : undefined)
          }
          if (decision === 'deny') declined.add(allowKey)
          if (decision === 'chat') {
            // Added to the chat's list as it is now, so answers given elsewhere meanwhile (a reset) aren't undone.
            const allowed = allowedInChat()
            if (!allowed.includes(allowKey)) updateConversation(conversationId, { allowedTools: [...allowed, allowKey] })
            noteAllowedForChat(call, toolContext)
          }
        }

        const toolTrace = startTrace({
          kind: 'tool',
          conversationId,
          messageId,
          model: null,
          round,
          endpoint: toolEndpoint(call, toolContext),
          request: { tool: call.function.name, arguments: call.function.arguments },
          summary: `${pending.tool}: ${pending.summary}`
        })
        let result: ToolResult
        if (decision === 'deny') result = declinedResult(call, toolEvents[index])
        else {
          try {
            const maxResultChars = Math.min(TOOL_RESULT_CHARS, Math.max(MIN_RESULT_CHARS, Math.floor(roomChars / callsLeft)))
            result = await runTool(call, { ...toolContext, maxResultChars })
          } catch (err) {
            // Only a stop gets here (tool failures come back as results); close the trace before unwinding.
            toolTrace.finish({ status: 'aborted', response: { error: 'Stopped by you' }, summary: `${pending.tool}: stopped` })
            throw err
          }
        }
        toolTrace.finish({
          status: result.event.ok ? 'ok' : 'error',
          response: { result: result.content, error: result.event.ok ? undefined : result.event.summary },
          summary: `${result.event.tool}: ${result.event.declined ? 'declined by you' : result.event.summary}`
        })
        roomChars -= result.content.length
        callsLeft--
        if (result.unknown) triedUnknown.push(call.function.name)
        else onlyUnknown = false
        toolEvents[index] = { ...result.event, at: pending.at }
        emit({ type: 'tool', conversationId, messageId, index, event: toolEvents[index] })
        if (result.loadedSkillId && !loadedIds.includes(result.loadedSkillId)) {
          // Remember it for later turns so it doesn't have to be reloaded.
          loadedIds = [...loadedIds, result.loadedSkillId]
          updateConversation(conversationId, { autoSkills: loadedIds })
        }
        body.messages.push({ role: 'tool', content: result.content, tool_name: call.function.name })
        const note = `[Ollmost shortened this earlier ${call.function.name} result to make room in the context window. It was: ${result.event.summary}. Call the tool again if you need it in full.]`
        if (result.content.length > note.length) turnResults.push({ index: body.messages.length - 1, round, note })
        checkpoint()
        // Checked only after the result is recorded, so a call that finished isn't saved as stopped.
        controller.signal.throwIfAborted()
      }
      // A model reaching for tools Ollmost lacks keeps guessing names; after one explanation, take the
      // tools away so the next request has to be answered in words.
      if (onlyUnknown) body.tools = undefined
      if (content && !content.endsWith('\n')) {
        nextRoundAt = content.length
        content += '\n\n'
        delta({ content: '\n\n' })
      }
    }
    if (!content.trim() && triedUnknown.length)
      error = [
        `The model tried to use tools Ollmost doesn't have (${[...new Set(triedUnknown)].join(', ')}) and gave no answer.`,
        missingAbilities(grants)
      ]
        .filter(Boolean)
        .join(' ')
  } catch (err) {
    if (!controller.signal.aborted) error = errorMessage(err)
    // A stopped or failed stream still spent tokens; record an estimate for the partial round.
    const partial = openRound ? { content: openRound.content, thinking: openRound.thinking } : null
    if (openRound?.thinking) thinkingSegments.push({ text: openRound.thinking, ...roundAt, ms: roundThinkMs() })
    const billed = partial && (partial.content || partial.thinking) ? recordRound(null) : null
    roundTrace?.finish({
      status: controller.signal.aborted ? 'aborted' : 'error',
      response: { ...partial, error: controller.signal.aborted ? 'Stopped by you' : (error ?? undefined) },
      promptTokens: billed?.promptTokens,
      completionTokens: billed?.completionTokens,
      costUsd: billed?.costUsd,
      summary: controller.signal.aborted ? 'Stopped' : `Error: ${error}`
    })
  }

  // The chat was deleted while replying: there's nothing left to save or show.
  if (!getMessage(messageId)) return

  stats.durationMs = Date.now() - startedAt
  if (evalNs && stats.completionTokens) stats.tokensPerSecond = stats.completionTokens / (evalNs / 1e9)
  if (thinkStart) stats.thinkingMs = (thinkEnd ?? Date.now()) - thinkStart

  const message = updateMessage(messageId, {
    content: content.trimEnd(),
    thinking: thinking || null,
    thinkingSegments: thinkingSegments.length ? thinkingSegments : null,
    // A tool still running when the reply stopped never finished.
    toolEvents: toolEvents.map(settleToolEvent),
    stats,
    error
  })
  saveArtifacts(conversationId, messageId, message.content)
  if (error) emit({ type: 'error', conversationId, messageId, error })
  emit({
    type: 'done',
    conversationId,
    message,
    artifacts: listArtifacts(conversationId),
    conversation: getConversation(conversationId)!,
    usage: conversationUsage(conversationId)
  })

  // A plain Stop still titles a new chat; a stop for a delete or a quit doesn't start a title request.
  if (!error && !flags.quiet && message.content && getConversation(conversationId)?.title === 'New chat')
    void generateTitle(conversationId, modelName)
}

/** With OLLMOST_DEBUG=1, append each request (images elided) to <userData>/debug.log. */
function debugLog(body: ChatBody): void {
  if (!process.env.OLLMOST_DEBUG) return
  const redacted = {
    ...body,
    messages: body.messages.map((m) => (m.images ? { ...m, images: m.images.map(() => '<image>') } : m))
  }
  appendFileSync(join(paths.data, 'debug.log'), `${new Date().toISOString()} ${JSON.stringify(redacted)}\n`)
}

/** Roughly what the tool definitions add to a request: every round sends them all. */
const toolsTokens = (tools: ChatBody['tools']) => (tools?.length ? estimateTokens(JSON.stringify(tools)) : 0)

function estimatePrompt(body: ChatBody): number {
  return body.messages.reduce((n, m) => n + estimateTokens(m.content) + (m.images?.length ?? 0) * 1600, toolsTokens(body.tools))
}

function saveArtifacts(conversationId: string, messageId: string, content: string): void {
  for (const seg of parseMessage(content)) {
    if (seg.kind !== 'artifact' || !seg.content.trim()) continue
    addArtifactVersion({
      conversationId,
      messageId,
      identifier: seg.identifier,
      type: seg.type,
      title: seg.title,
      language: seg.language,
      content: seg.content
    })
  }
}

function cleanTitle(raw: string): string {
  const firstLine = normalizeSpaces(raw)
    .replace(/<think>[\s\S]*?<\/think>/g, '')
    .split('\n')
    .map((l) => l.trim())
    .find(Boolean)
  return (firstLine ?? '')
    .replace(/^(title:\s*)/i, '')
    .replace(/^[#*"'“”‘’`\s]+|[*"'“”‘’`.\s]+$/g, '')
    .slice(0, 60)
}

function fallbackTitle(text: string): string {
  const words = text.replace(/\s+/g, ' ').trim().split(' ').slice(0, 6).join(' ')
  return words.length > 50 ? `${words.slice(0, 50)}…` : words || 'Untitled chat'
}

const COMPACT_PROMPT = `You compact a chat's history for the assistant that will carry it on. Write a summary of the conversation below that a later reply can rely on in place of the messages themselves: what the user wanted, what was decided, found or produced, the names, numbers, code and file names that matter, what is still open, and preferences the user stated. Write plain prose in the past tense, with no preamble and no headings unless the conversation has clearly separate threads. Keep it under 500 words. Say nothing the conversation didn't.`

/** Messages a /compact leaves as they are: the last two exchanges, so the model keeps the immediate context verbatim. */
export const COMPACT_KEEPS = 4

/** A chat's /compact summary is stale once a message it covers is edited or retried: the summary stood for it. */
function uncompactFrom(conversationId: string, from: Message): void {
  const c = getConversation(conversationId)?.compaction
  if (c && from.createdAt <= c.upTo) setCompaction(conversationId, null)
}

/**
 * /compact: summarize every message but the last few with the chat's model, and keep the summary on the chat so
 * later replies replay it instead of those messages (which stay in the transcript). A second compaction folds the
 * earlier summary in with what followed it.
 */
export async function compact(conversationId: string, opts: { focus: string; model: string }): Promise<Conversation> {
  assertIdle(conversationId)
  const conversation = getConversation(conversationId)
  if (!conversation) throw new Error('Chat not found')
  const earlier = conversation.compaction
  const messages = listMessages(conversationId).filter((m) => m.role === 'user' || m.content)
  const since = earlier ? messages.filter((m) => m.createdAt > earlier.upTo) : messages
  const older = since.slice(0, Math.max(0, since.length - COMPACT_KEEPS))
  if (older.length < 2)
    throw new Error(
      `Nothing to compact yet: the last ${COMPACT_KEEPS} messages stay as they are, and there's less than an exchange before them.`
    )
  const prose = (content: string) =>
    parseMessage(content)
      .map((s) => (s.kind === 'text' ? s.text : `[artifact: ${s.title}]`))
      .join(' ')
  const transcript = [
    ...(earlier ? [`Summary of the ${earlier.turns} messages before these:\n${earlier.summary}`] : []),
    ...older.map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${prose(m.content).slice(0, 8000)}`)
  ].join('\n\n')
  const focus = opts.focus.trim()
  const modelName = opts.model
  const info = await getModelInfo(modelName)
  const profile = resolveThinkProfile(modelName, info.capabilities, info.overrides.think)
  const body: ChatBody = {
    model: modelName,
    messages: [
      { role: 'system', content: focus ? `${COMPACT_PROMPT}\n\nAbove all, keep what the user asked for: ${focus}` : COMPACT_PROMPT },
      { role: 'user', content: transcript }
    ],
    think: profile.kind === 'levels' ? 'low' : profile.kind === 'toggle' ? false : undefined,
    options: { temperature: 0.3, ...contextOptions(info, getSettings().localNumCtx) }
  }
  const trace = startTrace({
    kind: 'compact',
    conversationId,
    messageId: null,
    model: modelName,
    endpoint: endpointFor('/api/chat'),
    request: { ...body, stream: false },
    summary: 'Compacting…'
  })
  try {
    const res = await chatOnce(body, { timeoutMs: 5 * 60_000 })
    trace.firstByte()
    const summary = (res.message?.content ?? '').trim()
    const promptTokens = res.prompt_eval_count ?? estimateTokens(transcript)
    const completionTokens = res.eval_count ?? estimateTokens(summary)
    insertUsageEvent({
      conversationId,
      messageId: null,
      model: modelName,
      kind: 'compact',
      promptTokens,
      completionTokens,
      costUsd: requestCost(modelName, promptTokens, completionTokens),
      estimated: res.eval_count === undefined
    })
    if (!summary) throw new Error('The model gave no summary; nothing was compacted.')
    const { message: _m, ...finalStats } = res
    trace.finish({
      status: 'ok',
      response: { content: summary, final: finalStats },
      promptTokens,
      completionTokens,
      summary: `Compacted ${older.length} messages`
    })
    const compaction: Compaction = {
      summary,
      upTo: older[older.length - 1].createdAt,
      turns: (earlier?.turns ?? 0) + older.length,
      at: Date.now()
    }
    return setCompaction(conversationId, compaction)
  } catch (err) {
    trace.finish({ status: 'error', response: { error: errorMessage(err) }, summary: `Error: ${errorMessage(err)}` })
    throw err
  }
}

async function generateTitle(conversationId: string, chatModel: string): Promise<void> {
  const messages = listMessages(conversationId)
  const firstUser = messages.find((m) => m.role === 'user')
  const transcript = messages
    .slice(0, 2)
    .map((m) => {
      const prose = parseMessage(m.content)
        .map((s) => (s.kind === 'text' ? s.text : `[artifact: ${s.title}]`))
        .join(' ')
      return `${m.role === 'user' ? 'User' : 'Assistant'}: ${prose.slice(0, 1500)}`
    })
    .join('\n\n')

  let title = ''
  let titleTrace: Trace | null = null
  try {
    const modelName = getSettings().titleModel || chatModel
    const info = await getModelInfo(modelName)
    const profile = resolveThinkProfile(modelName, info.capabilities, info.overrides.think)
    const titleBody: ChatBody = {
      model: modelName,
      messages: [
        { role: 'system', content: TITLE_PROMPT },
        { role: 'user', content: transcript }
      ],
      think: profile.kind === 'levels' ? 'low' : profile.kind === 'toggle' ? false : undefined,
      // Same num_ctx as the chat: a different one makes Ollama reload a local model just for the title.
      options: { temperature: 0.3, ...contextOptions(info, getSettings().localNumCtx) }
    }
    titleTrace = startTrace({
      kind: 'title',
      conversationId,
      messageId: null,
      model: modelName,
      endpoint: endpointFor('/api/chat'),
      request: { ...titleBody, stream: false },
      summary: 'Generating title…'
    })
    // Bounded: a title is never worth a request that hangs forever (it may still need a cold model load).
    const res = await chatOnce(titleBody, { timeoutMs: 5 * 60_000 })
    titleTrace.firstByte()
    title = cleanTitle(res.message?.content ?? '')
    const promptTokens = res.prompt_eval_count ?? estimateTokens(transcript)
    const completionTokens = res.eval_count ?? estimateTokens(res.message?.content ?? '')
    const costUsd = requestCost(modelName, promptTokens, completionTokens)
    insertUsageEvent({
      conversationId,
      messageId: null,
      model: modelName,
      kind: 'title',
      promptTokens,
      completionTokens,
      costUsd,
      estimated: res.eval_count === undefined
    })
    emit({ type: 'usage', conversationId, usage: conversationUsage(conversationId) })
    const { message: titleMessage, ...titleStats } = res
    titleTrace.finish({
      status: 'ok',
      response: { content: titleMessage?.content, thinking: titleMessage?.thinking, final: titleStats },
      promptTokens,
      completionTokens,
      costUsd,
      summary: `Title: ${title || '(empty)'}`,
      ollama: res
    })
  } catch (err) {
    titleTrace?.finish({ status: 'error', response: { error: errorMessage(err) }, summary: `Title failed: ${errorMessage(err)}` })
    /* fall back below */
  }
  if (!title) title = fallbackTitle(firstUser?.content ?? '')
  if (getConversation(conversationId)?.title !== 'New chat') return
  updateConversation(conversationId, { title })
  emit({ type: 'title', conversationId, title })
}
