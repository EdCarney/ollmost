import { BrowserWindow } from 'electron'
import { parseMessage } from '@shared/artifactParser'
import { normalizeSpaces } from '@shared/text'
import { contextOptions, effectiveContext } from '@shared/context'
import { EVENT_CHANNELS } from '@shared/ipc'
import { resolveThinkProfile } from '@shared/thinking'
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
import { resultFromOllama } from '../providers/ollama/adapter'
import { type ChatBody, chatOnce, endpointFor } from '../providers/ollama/wire'
import { modelInfo, resolve } from '../providers/registry'
import type { ChatRequest } from '../providers/types'
import { webAvailable } from '../ollama/web'
import { startTrace, type Trace } from '../debug/traces'
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
import { errorMessage, estimateTokens, now } from '../util'
import { hasPrivateFiles } from './exposure'
import { assemble, type HistoryTurn, promptBudget } from './assemble'
import { TITLE_PROMPT } from './prompts'
import { delegateTools, subAgentsAtOnce } from './delegate'
import { CHARS_PER_TOKEN, runRounds, toolsTokens } from './rounds'
import { missingAbilities, registerToolProvider, replayCalls, settleToolEvent, type ToolContext, toolGrants, toolsFor } from './tools'
import type { WebStatus } from './prompts'
import { turnPolicy } from './turn'

// The delegate tool runs a reply loop of its own, and the loop imports tools.ts, so it joins the built-in providers
// here rather than in tools.ts's list. It comes after them; no MCP tool can take its name (theirs are <server>__<tool>).
registerToolProvider(delegateTools)

/** How long a reply waits for the chat's MCP servers to start; ones still starting are left out of it. */
const SERVER_WAIT_MS = 30_000

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

/** Chats a /compact is summarizing: nothing else may change them until it ends. */
const compacting = new Set<string>()

function assertIdle(conversationId: string): void {
  if (active.has(conversationId)) throw new Error('Ollmost is still responding in this chat.')
  if (compacting.has(conversationId)) throw new Error('Ollmost is still compacting this chat.')
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

/** As much of a plan as the later turns carry in their prompt; a longer one is cut with a mark the model can see. */
const PLAN_CHARS = 12_000
const cutPlan = (plan: string): string => (plan.length > PLAN_CHARS ? `${plan.slice(0, PLAN_CHARS)}\n\n[… the plan was cut here]` : plan)

/**
 * A code session's stage. The plan is the reply written in plan mode (kept as it finishes, see generate); starting
 * work keeps it for the turns that follow, and going back to planning drops it, since a new plan will come.
 */
export function setStage(conversationId: string, stage: 'plan' | 'work'): Conversation {
  assertIdle(conversationId)
  const c = getConversation(conversationId)
  if (!c) throw new Error('Chat not found')
  if (c.mode !== 'code') throw new Error('Only a code session has a plan mode.')
  return updateConversation(conversationId, { stage, plan: stage === 'plan' ? null : c.plan })
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
  const thinkingSegments: ThinkingSegment[] = []
  const toolEvents: ToolEvent[] = []
  const stats: MessageStats = { promptTokens: 0, completionTokens: 0 }
  const startedAt = Date.now()
  let thinkStart: number | null = null
  let thinkEnd: number | null = null
  let genMs = 0
  let error: string | null = null
  let savedAt = Date.now()

  try {
    const conversation = getConversation(conversationId)!
    const settings = getSettings()
    const { provider, model: serverName } = resolve(modelName)
    const model = await modelInfo(modelName)
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
    const running = new Set(serverIds)
    const servers = readyTools()
      .filter((r) => running.has(r.server.id))
      .map((r) => r.server.name)
    // A code session's prompt input matches what a reply's own assemble() gets (its stage and plan aren't on the
    // session record itself).
    const codeSessionForPrompt = codeSession ? { ...codeSession, stage: conversation.stage, plan: conversation.plan } : null
    const toolContext: ToolContext = {
      mode: policy.mode,
      stage: conversation.stage,
      skills: skillIndex.length > 0,
      web: web === 'on',
      sources,
      // Files the user shared are private, and a fetch URL could carry them out (#62).
      privateFiles: hasPrivateFiles(conversation, messages),
      workspace,
      signal: controller.signal,
      reply: {
        conversationId,
        messageId,
        model: modelName,
        think,
        maxRounds: policy.maxRounds,
        prompt: {
          userName: settings.userName,
          model: modelName,
          contextLength: numCtx,
          web,
          mcpServers: servers,
          codeRunner,
          codeSession: codeSessionForPrompt,
          skillIndex
        },
        onUsage: () => emit({ type: 'usage', conversationId, usage: conversationUsage(conversationId) })
      }
    }
    const grants = toolGrants(toolContext)
    const tools = toolsFor(toolContext)
    const maxRounds = policy.maxRounds
    // How many sub-agents this reply may run at the same time; the prompt tells the model the same number.
    const atOnce = subAgentsAtOnce(settings.delegate)

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
      codeSession: codeSessionForPrompt,
      toolTokens: toolsTokens(tools),
      pastTools: toolsCapable,
      subAgents: tools?.some((t) => t.function.name === 'delegate') ?? false,
      subAgentsAtOnce: atOnce,
      project: project ? { name: project.name, instructions: project.instructions } : null,
      chatInstructions: conversation.instructions,
      knowledge: project ? projectKnowledge(project.id) : [],
      skillIndex,
      selectedSkills: await load(selectedIds),
      loadedSkills: await load(loadedIds),
      history,
      compaction: compaction ? { summary: compaction.summary, messages: compaction.messages } : null
    })
    if (assembled.droppedTurns) stats.truncatedHistory = assembled.droppedTurns

    const request: ChatRequest = {
      model: serverName,
      messages: assembled.messages,
      think,
      profile,
      tools,
      // The window the history was fitted to. The adapter decides whether its server takes one (Ollama's num_ctx).
      contextWindow: numCtx
    }

    const result = await runRounds({
      conversationId,
      messageId,
      loopId: messageId,
      modelName,
      model,
      provider,
      body: request,
      budget,
      maxRounds,
      parallel: atOnce,
      toolContext,
      signal: controller.signal,
      stats,
      usageKind: 'chat',
      traceKind: 'chat',
      onDelta: (d) => emit({ type: 'delta', conversationId, messageId, ...d }),
      onToolEvent: (index, event) => emit({ type: 'tool', conversationId, messageId, index, event }),
      onUsage: () => emit({ type: 'usage', conversationId, usage: conversationUsage(conversationId) }),
      onLoadedSkill: (id) => {
        // Remember it for later turns so it doesn't have to be reloaded.
        if (loadedIds.includes(id)) return
        loadedIds = [...loadedIds, id]
        updateConversation(conversationId, { autoSkills: loadedIds })
      },
      checkpoint: (state, immediate = false) => {
        // Save progress now and then, so a quit or crash keeps the partial reply (see markInterruptedReplies).
        if (!immediate && Date.now() - savedAt < CHECKPOINT_MS) return
        savedAt = Date.now()
        checkpointMessage(messageId, { ...state, thinking: state.thinking || null })
      }
    })
    content = result.content
    thinking = result.thinking
    thinkingSegments.push(...result.thinkingSegments)
    toolEvents.push(...result.toolEvents)
    error = result.error
    genMs = result.genMs
    thinkStart = result.thinkStart
    thinkEnd = result.thinkEnd
    if (!error && !controller.signal.aborted && !content.trim() && result.triedUnknown.length)
      error = [
        `The model tried to use tools Ollmost doesn't have (${[...new Set(result.triedUnknown)].join(', ')}) and gave no answer.`,
        missingAbilities(grants)
      ]
        .filter(Boolean)
        .join(' ')
  } catch (err) {
    // Only the setup gets here now (a model that can't be reached, a folder that can't be readied): the rounds
    // report their own failures in `result.error`.
    if (!controller.signal.aborted) error = errorMessage(err)
  }

  // The chat was deleted while replying: there's nothing left to save or show.
  if (!getMessage(messageId)) return

  stats.durationMs = Date.now() - startedAt
  // The server's own generation time, where it reports one (local Ollama models do; cloud ones don't).
  if (genMs && stats.completionTokens) stats.tokensPerSecond = stats.completionTokens / (genMs / 1000)
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
  // A reply written in plan mode is the plan the user may approve; kept here, so the stage's switch never has to guess.
  const finished = getConversation(conversationId)
  if (finished?.stage === 'plan' && finished.mode === 'code' && !error && !controller.signal.aborted && message.content.trim())
    updateConversation(conversationId, { plan: cutPlan(message.content.trim()) })
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

const COMPACT_PROMPT = `You compact a chat's history for the assistant that will carry it on. Write a summary of the conversation given that a later reply can rely on in place of the messages themselves: what the user wanted, what was decided, found or produced, the names, numbers, code and file names that matter, what is still open, and preferences the user stated. End the summary with where things stand: the user's latest request, whether it was finished, and what was about to happen next. When a summary so far is given, fold it in: the result stands for all of it. Write plain prose in the past tense, with no preamble and no headings unless the conversation has clearly separate threads. Keep it under 500 words. Say nothing the conversation didn't.`
const COMPACT_INSTRUCTION = 'Summarize the conversation above, as instructed. Answer with the summary only.'
/** Room a summary request leaves in the window for the summary itself. */
const COMPACT_REPLY_TOKENS = 1500

/** A message's prose in a summary's transcript: a longer one keeps its start and its end, where a reply's conclusion is. */
const TRANSCRIPT_PROSE = { head: 2000, tail: 4000 }
/** A tool call's line in a summary's transcript. */
const TRANSCRIPT_CALL_CHARS = 300
/** The tool calls a message lists in a summary's transcript: a longer run keeps its first and its last. */
const TRANSCRIPT_CALLS = { head: 40, tail: 80 }

/** A message's substance in one line, for a title or a summary: its prose, artifacts by title. */
const proseOf = (content: string): string =>
  parseMessage(content)
    .map((s) => (s.kind === 'text' ? s.text : `[artifact: ${s.title}]`))
    .join(' ')

/** A tool call's arguments in brief: strings cut short, the rest as JSON. */
function argsBrief(args: Record<string, unknown>): string {
  const inner = Object.entries(args)
    .map(([k, v]) => `${k}: ${typeof v === 'string' ? JSON.stringify(v.length > 80 ? `${v.slice(0, 80)}…` : v) : JSON.stringify(v)}`)
    .join(', ')
  return inner ? `(${inner})` : ''
}

/** The start and end of a long prose, with a mark for the middle it cut. */
function proseBrief(prose: string): string {
  const { head, tail } = TRANSCRIPT_PROSE
  if (prose.length <= head + tail) return prose
  return `${prose.slice(0, head)} [… ${prose.length - head - tail} characters cut …] ${prose.slice(-tail)}`
}

/**
 * A single transcript line too big for what's left of the whole piece, even after `transcriptLine`'s own budgets
 * (prose and each call are already capped, but a reply with many calls can still run to tens of thousands of
 * characters). Cut its middle, like `proseBrief`, so the front-cut of what came before doesn't silently drop this
 * one's own tail: its last tool calls, which is usually where an agentic reply's outcome sits.
 */
function cutToFit(line: string, maxChars: number): string {
  if (line.length <= maxChars) return line
  const mark = (n: number) => ` [… ${n} characters cut to fit …] `
  const room = Math.max(0, maxChars - mark(line.length).length)
  const head = Math.ceil(room / 2)
  const tail = room - head
  return `${line.slice(0, head)}${mark(line.length - head - tail)}${line.slice(line.length - tail)}`
}

/**
 * A message as a transcript entry for the summary: who said it, its prose, what was attached, and then each tool
 * call on a line of its own, with what it got back in brief (in a code session most of the substance is in the
 * calls). Prose and calls are cut apart, so a long reply keeps its calls and its conclusion, and a cut says so.
 */
function transcriptLine(m: Message): string {
  const said = [proseBrief(proseOf(m.content)), ...m.attachments.map((a) => `[attached: ${a.name}]`)].filter(Boolean).join(' ')
  const calls = m.toolEvents.map((e) => {
    const call = `[${e.tool}${argsBrief(e.args)}${e.summary ? ` → ${e.summary}` : ''}]`
    return call.length > TRANSCRIPT_CALL_CHARS ? `${call.slice(0, TRANSCRIPT_CALL_CHARS - 1)}…` : call
  })
  const { head, tail } = TRANSCRIPT_CALLS
  const listed =
    calls.length > head + tail
      ? [...calls.slice(0, head), `[… ${calls.length - head - tail} more tool calls]`, ...calls.slice(-tail)]
      : calls
  return [`${m.role === 'user' ? 'User' : 'Assistant'}:${said ? ` ${said}` : ''}`, ...listed].join('\n')
}

/** A chat's /compact summary is stale once a message it covers is edited or retried: the summary stood for it. */
function uncompactFrom(conversationId: string, from: Message): void {
  const c = getConversation(conversationId)?.compaction
  if (c && from.createdAt <= c.upTo) setCompaction(conversationId, null)
}

/**
 * /compact: summarize every message since the last compaction (or the start) with the chat's model, and keep the
 * summary on the chat so later replies replay it and only the messages that came after (the messages stay in the
 * transcript). The request is sized to the model's window: a longer history is summarized in pieces, each folding
 * the summary so far in, which is also how a second compaction folds the earlier summary in with what followed it.
 */
export async function compact(conversationId: string, opts: { focus: string; model: string }): Promise<Conversation> {
  assertIdle(conversationId)
  const conversation = getConversation(conversationId)
  if (!conversation) throw new Error('Chat not found')
  const earlier = conversation.compaction
  // A reply with tool calls and no prose still counts: in a code session the calls are its substance.
  const all = listMessages(conversationId).filter((m) => m.role === 'user' || m.content || m.toolEvents.length)
  const since = earlier ? all.filter((m) => m.createdAt > earlier.upTo) : all
  if (!since.length) throw new Error(earlier ? 'Nothing new to compact since the last summary.' : 'Nothing to compact yet.')
  compacting.add(conversationId)
  try {
    const info = await modelInfo(opts.model)
    const profile = resolveThinkProfile(opts.model, info.capabilities, info.overrides.think)
    const settings = getSettings()
    const focus = opts.focus.trim()
    const system = focus ? `${COMPACT_PROMPT}\n\nAbove all, keep what the user asked for: ${focus}` : COMPACT_PROMPT
    const body = (transcript: string): ChatBody => ({
      model: opts.model,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: transcript }
      ],
      think: profile.kind === 'levels' ? 'low' : profile.kind === 'toggle' ? false : undefined,
      options: { temperature: 0.3, ...contextOptions(info, settings.localNumCtx) }
    })
    // A model with a tiny window still gets a piece worth summarizing rather than one message cut to nothing.
    const budget = Math.max(
      2000,
      promptBudget(effectiveContext(info, settings.localNumCtx)) - estimateTokens(system) - COMPACT_REPLY_TOKENS
    )
    const lines = since.map(transcriptLine)
    let summary = earlier?.summary ?? null
    let i = 0
    while (i < lines.length) {
      // The chat may go while the model works; nothing else can change it (assertIdle), but a delete can.
      if (!getConversation(conversationId)) throw new Error('The chat was deleted while it was being compacted.')
      const head = summary ? `<summary_so_far>\n${summary}\n</summary_so_far>\n\n` : ''
      let used = estimateTokens(head) + estimateTokens(COMPACT_INSTRUCTION) + 40
      const piece: string[] = []
      while (i < lines.length) {
        const cost = estimateTokens(lines[i]) + 2
        if (piece.length && used + cost > budget) break
        // A single message larger than the whole budget is cut to what fits rather than left out.
        piece.push(used + cost > budget ? cutToFit(lines[i], Math.max(200, (budget - used) * CHARS_PER_TOKEN)) : lines[i])
        used += cost
        i++
      }
      const transcript = `${head}<conversation>\n${piece.join('\n\n')}\n</conversation>\n\n${COMPACT_INSTRUCTION}`
      summary = await summarizeOnce(conversationId, opts.model, body(transcript), transcript, piece.length)
    }
    if (!getConversation(conversationId)) throw new Error('The chat was deleted while it was being compacted.')
    const compaction: Compaction = {
      summary: summary!,
      upTo: since[since.length - 1].createdAt,
      messages: (earlier?.messages ?? 0) + since.length,
      // The same clock usage_events.created_at uses (Date.now() runs behind it when several rows land in one
      // millisecond), so a pre-compaction row can never look newer than the compaction itself.
      at: now()
    }
    return setCompaction(conversationId, compaction)
  } finally {
    compacting.delete(conversationId)
  }
}

/** One summary request: traced, billed, its answer cleaned of thinking; an empty answer is an error. */
async function summarizeOnce(
  conversationId: string,
  modelName: string,
  body: ChatBody,
  transcript: string,
  count: number
): Promise<string> {
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
    const summary = (res.message?.content ?? '').replace(/<think>[\s\S]*?<\/think>/g, '').trim()
    const promptTokens = res.prompt_eval_count ?? estimateTokens(transcript)
    const completionTokens = res.eval_count ?? estimateTokens(summary)
    const costUsd = requestCost(modelName, promptTokens, completionTokens)
    // Spent tokens are kept even for a chat deleted meanwhile (with no chat to bill them to), and the chat's usage
    // chip moves after each piece, so a later failure leaves it right.
    const chat = getConversation(conversationId)
    insertUsageEvent({
      conversationId: chat ? conversationId : null,
      messageId: null,
      model: modelName,
      kind: 'compact',
      promptTokens,
      completionTokens,
      costUsd,
      estimated: res.eval_count === undefined
    })
    if (chat) emit({ type: 'usage', conversationId, usage: conversationUsage(conversationId) })
    if (!summary) throw new Error('The model gave no summary; nothing was compacted.')
    const { message: _m, ...finalStats } = res
    trace.finish({
      status: 'ok',
      response: { content: summary, final: finalStats },
      promptTokens,
      completionTokens,
      costUsd,
      summary: `Compacted ${count} messages`
    })
    return summary
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
    .map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${proseOf(m.content).slice(0, 1500)}`)
    .join('\n\n')

  let title = ''
  let titleTrace: Trace | null = null
  try {
    const modelName = getSettings().titleModel || chatModel
    const info = await modelInfo(modelName)
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
      timing: resultFromOllama(res).timing
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
