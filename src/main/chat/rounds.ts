import { appendFileSync } from 'node:fs'
import { join } from 'node:path'
import type { MessageStats, ModelInfo, ThinkingSegment, ToolDecision, ToolEvent } from '@shared/types'
import { getConversation, updateConversation } from '../db/conversations'
import { insertUsageEvent } from '../db/usage'
import { startTrace, type Trace } from '../debug/traces'
import { type ChatBody, type ChatChunk, chatStream, endpointFor, streamTimeoutsFor, type ToolCall } from '../ollama/client'
import { paths } from '../paths'
import { requestCost } from '../usage/pricing'
import { errorMessage, estimateTokens } from '../util'
import { EVERY_TIME, waitForDecision } from './approvals'
import {
  allowKeyFor,
  approvalFor,
  declinedResult,
  maxResultCharsFor,
  noteAllowedForChat,
  notRunEvent,
  pendingEvent,
  runsInParallel,
  runTool,
  type ToolContext,
  toolEndpoint,
  type ToolResult
} from './tools'

// Sharing a round's room between its tool results: estimateTokens counts 4 characters a token, and a tenth is left
// for the notes and framing around them. Each result still gets a little, so the model sees what came back.
export const CHARS_PER_TOKEN = 4
const ROOM_SHARE = 0.9
const MIN_RESULT_CHARS = 1_500

export type UsageKind = 'chat' | 'delegate'

/** What the rounds have written and done so far; saved by checkpoints and returned at the end. */
export interface RoundsState {
  content: string
  thinking: string
  thinkingSegments: ThinkingSegment[] | null
  toolEvents: ToolEvent[]
}

export interface RoundsInput {
  conversationId: string
  /** The message the reply belongs to: usage rows are keyed by it. */
  messageId: string
  /** The id traces and approvals are keyed by: the message's own, or a sub-agent's `<message id>#<call index>`. */
  loopId: string
  modelName: string
  model: ModelInfo
  /** The request so far; rounds append to its messages and may withdraw its tools. */
  body: ChatBody
  budget: number
  maxRounds: number
  /**
   * How many of the calls a round makes in a row to a tool that allows it (sub-agents) may run at once. 1, or unset,
   * runs every call one at a time, in order.
   */
  parallel?: number
  toolContext: ToolContext
  signal: AbortSignal
  /** Totals the rounds add to (tokens, cost, the reasons the reply ended). */
  stats: MessageStats
  usageKind: UsageKind
  traceKind: 'chat' | 'delegate'
  onDelta: (d: { content?: string; thinking?: string; round?: { at: number; index: number } }) => void
  onToolEvent: (index: number, event: ToolEvent) => void
  /** Another round follows a tool call: a chance to show the chat's totals. */
  onUsage: () => void
  /** A skill the model loaded, to remember for later turns. */
  onLoadedSkill: (id: string) => void
  /** Called now and then with the state so far; `now` when it must be saved at once (before an approval waits). */
  checkpoint: (state: RoundsState, now?: boolean) => void
}

export interface RoundsResult {
  content: string
  thinking: string
  thinkingSegments: ThinkingSegment[]
  toolEvents: ToolEvent[]
  /** Requests made. */
  rounds: number
  /** Set when a request failed; null when the rounds ended or were stopped. */
  error: string | null
  evalNs: number
  thinkStart: number | null
  thinkEnd: number | null
  /** Names the model called that nothing offers. */
  triedUnknown: string[]
}

/**
 * The reply's round loop: stream a request, run the tool calls it makes (asking first where a tool needs it), keep
 * the request within the context window, record each request's usage and trace, and go again until a round makes no
 * calls or the rounds run out (the last never offers tools). A failed request ends it with `error`; a stop ends it
 * quietly.
 */
export async function runRounds(input: RoundsInput): Promise<RoundsResult> {
  const { body, budget, maxRounds, toolContext, conversationId, modelName, model } = input
  const parallel = input.parallel ?? 1
  const stats = input.stats
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
  let thinkStart: number | null = null
  let thinkEnd: number | null = null
  let evalNs = 0
  let error: string | null = null
  let rounds = 0
  let openRound: { content: string; thinking: string; promptEstimate: number } | null = null
  let roundTrace: Trace | null = null

  // Each round is a separate billed request: log it, and roll it into the message's stats.
  const recordRound = (final: ChatChunk | null) => {
    if (!openRound) return null
    const estimated = !final?.eval_count
    const promptTokens = final?.prompt_eval_count ?? openRound.promptEstimate
    const completionTokens = final?.eval_count ?? estimateTokens(openRound.content + openRound.thinking)
    const costUsd = requestCost(modelName, promptTokens, completionTokens)
    insertUsageEvent({
      conversationId,
      messageId: input.messageId,
      model: modelName,
      kind: input.usageKind,
      promptTokens,
      completionTokens,
      costUsd,
      estimated
    })
    stats.promptTokens! += promptTokens
    stats.completionTokens! += completionTokens
    stats.costUsd = stats.costUsd === null || costUsd === null ? null : (stats.costUsd ?? 0) + costUsd
    if (estimated) stats.estimated = true
    openRound = null
    return { promptTokens, completionTokens, costUsd, estimated }
  }

  // The segments so far, the open round's partial thinking included (a checkpoint may be the last save).
  const segmentsNow = (): ThinkingSegment[] | null => {
    const open = openRound?.thinking ? [{ text: openRound.thinking, ...roundAt, ms: roundThinkMs() }] : []
    const all = [...thinkingSegments, ...open]
    return all.length ? all : null
  }
  const checkpoint = (now?: boolean) => input.checkpoint({ content, thinking, thinkingSegments: segmentsNow(), toolEvents }, now)

  const triedUnknown: string[] = []
  try {
    // Rounds made only of writes refused in plan mode: a model that keeps trying loses its tools after the second.
    let refusedRounds = 0
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
      rounds++
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
        kind: input.traceKind,
        conversationId,
        messageId: input.loopId,
        model: modelName,
        round,
        endpoint: endpointFor('/api/chat'),
        request: { ...body, stream: true },
        summary: 'Streaming…'
      })
      let chunks = 0
      for await (const chunk of chatStream(body, input.signal, streamTimeoutsFor(model.location))) {
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
          input.onDelta({ thinking: m.thinking, round: roundAt })
        }
        if (m?.content) {
          if (thinkStart && !thinkEnd) thinkEnd = Date.now()
          if (roundThinkStart && !roundThinkEnd) roundThinkEnd = Date.now()
          content += m.content
          roundContent += m.content
          openRound.content += m.content
          input.onDelta({ content: m.content })
        }
        if (m?.tool_calls?.length) calls.push(...m.tool_calls)
        if (chunk.done) final = chunk
        checkpoint()
      }
      if (final?.prompt_eval_count) lastCount = { actual: final.prompt_eval_count, estimated: openRound.promptEstimate }
      const billed = recordRound(final)
      // After recordRound: it cleared openRound, so the catch below won't push this round's thinking a second time.
      if (roundThinking) thinkingSegments.push({ text: roundThinking, ...roundAt, ms: roundThinkMs() })
      // Another round follows a tool call: show the chat's totals now rather than when the reply ends (the done carries them).
      if (calls.length) input.onUsage()
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
      let onlyWithheld = true

      // One call, once its card shows: ask first where it needs to, run it with its share of the room, show its result.
      const runCall = async ({ call, index, pending }: ShownCall, maxResultChars: number): Promise<ToolResult> => {
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
            input.onToolEvent(index, toolEvents[index])
            checkpoint(true)
            decision = await waitForDecision(conversationId, input.loopId, index, input.signal, everyTime ? EVERY_TIME : undefined)
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
          messageId: input.loopId,
          model: null,
          round,
          endpoint: toolEndpoint(call, toolContext),
          request: { tool: call.function.name, arguments: call.function.arguments },
          summary: `${pending.tool}: ${pending.summary}`
        })
        let result: ToolResult
        if (decision === 'deny') result = declinedResult(call, toolEvents[index])
        else {
          // A report that comes after the call has finished is ignored: it would put back a running card.
          let settled = false
          try {
            result = await runTool(call, {
              ...toolContext,
              maxResultChars,
              callIndex: index,
              progress: (event) => {
                if (settled) return
                // Still pending, and still where it was in the text: only what the card shows changes.
                toolEvents[index] = { ...event, pending: true, at: pending.at }
                input.onToolEvent(index, toolEvents[index])
                // Saved at once when the card waits for the user (a sub-agent's call asking), like the loop's own asks.
                checkpoint(!!event.awaiting)
              }
            })
          } catch (err) {
            // Only a stop gets here (tool failures come back as results); close the trace before unwinding.
            toolTrace.finish({ status: 'aborted', response: { error: 'Stopped by you' }, summary: `${pending.tool}: stopped` })
            throw err
          } finally {
            settled = true
          }
        }
        toolTrace.finish({
          status: result.event.ok ? 'ok' : 'error',
          response: { result: result.content, error: result.event.ok ? undefined : result.event.summary },
          summary: `${result.event.tool}: ${result.event.declined ? 'declined by you' : result.event.summary}`
        })
        roomChars -= result.content.length
        callsLeft--
        toolEvents[index] = { ...result.event, at: pending.at }
        input.onToolEvent(index, toolEvents[index])
        if (result.loadedSkillId) input.onLoadedSkill(result.loadedSkillId)
        checkpoint()
        return result
      }

      for (const batch of batchesOf(calls, parallel, toolContext)) {
        // A batch's calls all show before any runs, in order, so each keeps its place: its index, its card, and a
        // sub-agent's id.
        const shown: ShownCall[] = []
        for (const call of batch) {
          const index = toolEvents.length
          // `at` places the call in the reply's text, where the UI shows it.
          const pending = { ...(await pendingEvent(call, toolContext)), at: content.length }
          toolEvents.push(pending)
          input.onToolEvent(index, pending)
          shown.push({ call, index, pending })
        }
        // Each call's share of the room as it stands now: the calls still to run split it, so a batch's calls never
        // take more than there is between them. No call gets more than its tool's results may be (a sub-agent's
        // reply may be longer than other results).
        const share = Math.max(MIN_RESULT_CHARS, Math.floor(roomChars / callsLeft))
        const shareOf = ({ call }: ShownCall) => Math.min(maxResultCharsFor(call, toolContext), share)
        const results =
          shown.length === 1
            ? [await runCall(shown[0], shareOf(shown[0]))]
            : await runTogether(
                shown,
                parallel,
                input.signal,
                (c) => runCall(c, shareOf(c)),
                // A call still waiting its turn when the reply stopped never ran, and its card says so.
                ({ index, pending }) => {
                  toolEvents[index] = { ...notRunEvent(pending), at: pending.at }
                  input.onToolEvent(index, toolEvents[index])
                }
              )
        // The results go to the model in call order, whichever finished first.
        for (const [i, { call }] of shown.entries()) {
          const result = results[i]
          if (result.unknown) triedUnknown.push(call.function.name)
          else onlyUnknown = false
          if (!result.withheld) onlyWithheld = false
          body.messages.push({ role: 'tool', content: result.content, tool_name: call.function.name })
          const note = `[Ollmost shortened this earlier ${call.function.name} result to make room in the context window. It was: ${result.event.summary}. Call the tool again if you need it in full.]`
          if (result.content.length > note.length) turnResults.push({ index: body.messages.length - 1, round, note })
        }
        // Checked only after the results are recorded, so a call that finished isn't saved as stopped.
        input.signal.throwIfAborted()
      }
      // A model reaching for tools Ollmost lacks keeps guessing names; after one explanation, take the
      // tools away so the next request has to be answered in words.
      if (onlyUnknown) body.tools = undefined
      refusedRounds = calls.length && onlyWithheld ? refusedRounds + 1 : 0
      if (refusedRounds >= 2) body.tools = undefined
      if (content && !content.endsWith('\n')) {
        nextRoundAt = content.length
        content += '\n\n'
        input.onDelta({ content: '\n\n' })
      }
    }
  } catch (err) {
    if (!input.signal.aborted) error = errorMessage(err)
    // A stopped or failed stream still spent tokens; record an estimate for the partial round.
    const partial = openRound ? { content: openRound.content, thinking: openRound.thinking } : null
    if (openRound?.thinking) thinkingSegments.push({ text: openRound.thinking, ...roundAt, ms: roundThinkMs() })
    const billed = partial && (partial.content || partial.thinking) ? recordRound(null) : null
    roundTrace?.finish({
      status: input.signal.aborted ? 'aborted' : 'error',
      response: { ...partial, error: input.signal.aborted ? 'Stopped by you' : (error ?? undefined) },
      promptTokens: billed?.promptTokens,
      completionTokens: billed?.completionTokens,
      costUsd: billed?.costUsd,
      summary: input.signal.aborted ? 'Stopped' : `Error: ${error}`
    })
  }

  return { content, thinking, thinkingSegments, toolEvents, rounds, error, evalNs, thinkStart, thinkEnd, triedUnknown }
}

/** A call the round has shown on its card, waiting to run. */
interface ShownCall {
  call: ToolCall
  /** Its place in the reply's tool events. */
  index: number
  pending: ToolEvent
}

/**
 * A round's calls in order, in batches: calls in a row that may run together (runsInParallel) make one batch when the
 * reply runs more than one at once; every other call is a batch of its own.
 */
function batchesOf(calls: ToolCall[], parallel: number, ctx: ToolContext): ToolCall[][] {
  const batches: Array<{ calls: ToolCall[]; together: boolean }> = []
  for (const call of calls) {
    const together = parallel > 1 && runsInParallel(call, ctx)
    const last = batches.at(-1)
    if (together && last?.together) last.calls.push(call)
    else batches.push({ calls: [call], together })
  }
  return batches.map((b) => b.calls)
}

/**
 * Run a batch's calls, `limit` at a time: as one finishes the next starts, and none starts once one has thrown or the
 * reply is stopped. A throw is usually a stop, though a trace, a save or an event can throw too; either way the calls
 * already running are waited for (a stopped sub-agent reports what it had and closes its traces), and then the first
 * error is thrown. The calls that never started are handed to `unstarted` first. The results are in the batch's order.
 */
async function runTogether<T, R>(
  items: T[],
  limit: number,
  signal: AbortSignal,
  run: (item: T) => Promise<R>,
  unstarted: (item: T) => void
): Promise<R[]> {
  const results: R[] = []
  const failures: unknown[] = []
  let next = 0
  const worker = async () => {
    while (next < items.length && !failures.length && !signal.aborted) {
      const i = next++
      try {
        results[i] = await run(items[i])
      } catch (err) {
        failures.push(err)
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  items.slice(next).forEach(unstarted)
  if (failures.length) throw failures[0]
  // A stop between two calls leaves the rest unstarted, with nothing to return.
  if (next < items.length) signal.throwIfAborted()
  return results
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
export const toolsTokens = (tools: ChatBody['tools']) => (tools?.length ? estimateTokens(JSON.stringify(tools)) : 0)

function estimatePrompt(body: ChatBody): number {
  return body.messages.reduce((n, m) => n + estimateTokens(m.content) + (m.images?.length ?? 0) * 1600, toolsTokens(body.tools))
}
