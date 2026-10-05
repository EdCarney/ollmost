// A sub-agent: a fresh reply loop on one task the model describes, with the parent's model, tools and approvals,
// whose reply is the tool result. Only that result enters the parent's context; the child's reading stays here,
// on the parent's tool event, for the transcript (#97).
import { resolveThinkProfile } from '@shared/thinking'
import { childId } from '@shared/toolEvents'
import type { MessageStats, Settings, ToolEvent } from '@shared/types'
import { modelInfo, resolve } from '../providers/registry'
import type { ChatRequest, ToolDef } from '../providers/types'
import { DEFAULT_SUB_AGENT_REPLY_CHARS, DEFAULT_SUB_AGENT_ROUNDS, DEFAULT_SUB_AGENTS_AT_ONCE, getSettings } from '../settings'
import { assemble, promptBudget } from './assemble'
import { addUsage, runRounds, toolsTokens } from './rounds'
import { toolRounds } from './turn'
import { type ResolvedCall, type RunContext, type ToolContext, toolGrants, type ToolProvider, type ToolResult, toolsFor } from './tools'

/** The least and most of a child's reply the parent may get, whatever the setting says (about 250 to 8,000 words). */
const MIN_REPLY_CHARS = 1_500
const MAX_REPLY_CHARS = 48_000
const SUMMARY_CHARS = 60
const RECORD_CHARS = 500
const CUT_MARK = '\n\n[… the sub-agent’s reply was cut here]'
/**
 * The least of a child's reply to cut to, whatever room its call has: the loop keeps every call's share well above
 * this (its MIN_RESULT_CHARS), but that is the loop's floor, not this one's, and a share under the mark's length would
 * send cut() a negative count, which slices from the end (#170). A result over the call's room is capped again by
 * runTool, as any tool's is.
 */
const MIN_CUT_CHARS = 200
/** The most sub-agents one reply may run at the same time, whatever the setting says. */
const MAX_AT_ONCE = 5
/** The most requests a sub-agent may make on one task, whatever the setting says: the largest choice Settings offers. */
const MAX_SUB_AGENT_ROUNDS = 40

const DELEGATE_TOOL: ToolDef = {
  type: 'function',
  function: {
    name: 'delegate',
    description:
      'Hand one task to a sub-agent: a fresh assistant with the same tools as you, which does the task and replies with its result. Use it for a task whose reading would crowd this conversation (research over many pages, a survey of many files). Write the task for someone who knows nothing about this conversation, and say exactly what to return.',
    parameters: {
      type: 'object',
      properties: {
        task: { type: 'string', description: 'What to do, where to look, and exactly what to return.' },
        context: {
          type: 'string',
          description: 'Facts the sub-agent needs: names, paths, the question behind the task, what was already tried.'
        }
      },
      required: ['task']
    }
  }
}

/**
 * Offered to a reply that has something to delegate to: a tool besides skills and this one (web, a code session's
 * tools, run_code, an MCP server's), as each provider decides for this request. Never to a sub-agent.
 */
function offered(ctx: ToolContext): boolean {
  if (ctx.child || !ctx.reply || !getSettings().delegate.enabled) return false
  // Asked as a child without skills, the providers leave out this tool and the skill tools, and only those.
  return !!toolsFor({ ...ctx, child: true, skills: false })?.length
}

/**
 * Requests a sub-agent may make on one task: the setting as a whole number from 1 to 40 (settings aren't checked
 * over IPC), or the default when there's no number (a settings file saved before the setting existed).
 */
export function subAgentRounds(settings: Settings['delegate']): number {
  return toolRounds(settings.maxRounds, DEFAULT_SUB_AGENT_ROUNDS, MAX_SUB_AGENT_ROUNDS)
}

/**
 * How many sub-agents one reply may run at the same time: the setting as a whole number from 1 to 5 (settings aren't
 * checked over IPC), or the default when there's no number (a settings file saved before the setting existed).
 */
export function subAgentsAtOnce(settings: Settings['delegate']): number {
  const n: unknown = settings.parallel
  return typeof n === 'number' && Number.isFinite(n) ? Math.min(MAX_AT_ONCE, Math.max(1, Math.floor(n))) : DEFAULT_SUB_AGENTS_AT_ONCE
}

/**
 * As much of a child's reply as the parent gets, when its call has the room (a longer one is cut with a mark): the
 * setting as a whole number from 1,500 to 48,000 (settings aren't checked over IPC), or the default when there's no
 * number (a settings file saved before the setting existed).
 */
export function subAgentReplyChars(settings: Settings['delegate']): number {
  const n: unknown = settings.resultChars
  return typeof n === 'number' && Number.isFinite(n)
    ? Math.min(MAX_REPLY_CHARS, Math.max(MIN_REPLY_CHARS, Math.floor(n)))
    : DEFAULT_SUB_AGENT_REPLY_CHARS
}

const optional = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined)
const summaryOf = (task: string): string => {
  const line = task.trim().split('\n')[0]
  return line.length > SUMMARY_CHARS ? `${line.slice(0, SUMMARY_CHARS - 1)}…` : line
}
const cut = (s: string, max: number): string => (s.length > max ? s.slice(0, max) + CUT_MARK : s)

export const delegateTools: ToolProvider = {
  id: 'delegate',
  tools: (ctx) => (offered(ctx) ? [DELEGATE_TOOL] : []),
  pending: (call) => {
    const task = String(call.args.task ?? '')
    const child = { task, context: optional(call.args.context), events: [], result: '', rounds: 0 }
    return { tool: 'delegate', args: call.args, ok: true, pending: true, summary: summaryOf(task), child }
  },
  // The child's own calls ask as they would in the parent; a task that needs nothing approved asks nothing.
  approval: () => 'auto',
  // Several delegated together run at the same time, each on its own card, asking there for what it needs.
  parallel: true,
  // A reply may be longer than other tools' results: as long as the setting allows, mark and all, when there's room.
  maxResultChars: () => subAgentReplyChars(getSettings().delegate) + CUT_MARK.length,
  run: (call, ctx) => runChild(call, ctx),
  replay: (e) =>
    e.tool === 'delegate' && e.child?.result
      ? { name: 'delegate', args: { task: e.child.task }, record: e.child.result.slice(0, RECORD_CHARS) }
      : null,
  endpoint: () => 'ollmost://sub-agent'
}

async function runChild(call: ResolvedCall, ctx: RunContext): Promise<ToolResult> {
  const task = String(call.args.task ?? '').trim()
  const context = optional(call.args.context)
  const fail = (summary: string, content = summary): ToolResult => ({
    content,
    event: { tool: 'delegate', args: call.args, ok: false, summary }
  })
  if (!task) return fail('delegate needs a task', 'delegate needs a task: say what to do and what to return.')
  const reply = ctx.reply
  // A child runs on the reply's stop signal: without one, nothing could stop it.
  const signal = ctx.signal
  if (!reply || ctx.callIndex === undefined || !signal) return fail('delegate is not available here')

  const settings = getSettings()
  const { provider, model: serverName } = resolve(reply.model)
  const model = await modelInfo(reply.model)
  const profile = resolveThinkProfile(model.name, model.capabilities, model.overrides.think, model.thinkPreset ?? undefined)
  const numCtx = model.contextWindow
  // The child's context is the parent's, less what only the parent may do (its grants are worked out again).
  const { grants: _grants, ...parent } = ctx
  const childCtx: ToolContext = {
    ...parent,
    child: true,
    reply: undefined,
    callIndex: undefined,
    progress: undefined,
    maxResultChars: undefined
  }
  const tools = toolsFor(childCtx)
  // Where the child's reply is cut: the setting, or less when this call's share of the parent's room is smaller (the
  // parent's value, not the child's cleared one), mark and all, so runTool doesn't cut it again and the card shows
  // exactly what the parent got (unless the share is under the floor, which the loop's never is). The child is told,
  // so it can fit its reply to it.
  const setting = subAgentReplyChars(settings.delegate)
  const replyChars =
    ctx.maxResultChars === undefined ? setting : Math.max(MIN_CUT_CHARS, Math.min(setting, ctx.maxResultChars - CUT_MARK.length))
  const content = context ? `<task>\n${task}\n</task>\n\n<context>\n${context}\n</context>` : `<task>\n${task}\n</task>`
  const assembled = assemble({
    ...reply.prompt,
    // The user isn't reading a sub-agent's request (its prompt says so), so it isn't told who it's talking with.
    userName: '',
    date: new Date(),
    preferences: '',
    artifacts: { enabled: false, allowCdn: false },
    grants: [...toolGrants(childCtx)],
    toolTokens: toolsTokens(tools),
    pastTools: true,
    project: null,
    chatInstructions: '',
    knowledge: [],
    selectedSkills: [],
    loadedSkills: [],
    history: [{ role: 'user', content, documents: [], images: [], hiddenImages: [] }],
    compaction: null,
    child: { task, replyChars }
  })
  const body: ChatRequest = {
    model: serverName,
    messages: assembled.messages,
    think: reply.think,
    profile,
    tools,
    contextWindow: numCtx
  }

  const events: ToolEvent[] = []
  // Requests made so far: a round that calls tools reports its usage before its calls run.
  let rounds = 0
  const summary = summaryOf(task)
  const withCalls = (calls: number) => `${summary} · ${calls} tool call${calls === 1 ? '' : 's'}`
  // What the pill says of a run still going, or stopped or failed: the task, and its calls once it has made any (#169).
  const soFar = (calls: number) => (calls ? withCalls(calls) : summary)
  // Everything the parent's card shows while the child runs: its calls, counted on the pill as they come, and whether
  // one waits for the user.
  const report = () =>
    ctx.progress?.({
      tool: 'delegate',
      args: call.args,
      ok: true,
      summary: soFar(events.length),
      awaiting: events.some((e) => e.awaiting) || undefined,
      child: { task, context, events: [...events], result: '', rounds }
    })
  const stats: MessageStats = { promptTokens: 0, completionTokens: 0 }
  const out = await runRounds({
    conversationId: reply.conversationId,
    messageId: reply.messageId,
    loopId: childId(reply.messageId, ctx.callIndex),
    modelName: reply.model,
    model,
    provider,
    body,
    budget: promptBudget(numCtx),
    maxRounds: subAgentRounds(settings.delegate),
    // A child has no delegate of its own, so nothing of its runs beside anything else.
    parallel: 1,
    toolContext: childCtx,
    signal,
    stats,
    usageKind: 'delegate',
    traceKind: 'delegate',
    onDelta: () => {},
    onToolEvent: (index, event) => {
      events[index] = event
      report()
    },
    onUsage: () => {
      rounds++
      reply.onUsage?.()
    },
    onLoadedSkill: () => {},
    checkpoint: () => {}
  })
  // The child's requests were the parent's reply's too: its tokens and cost join the reply's totals (the chat's usage
  // rows already had them), whether it finished, failed or was stopped (#166). Its tok/s stays its own: the parent's
  // is timed over the parent's rounds alone.
  if (reply.stats) addUsage(reply.stats, stats)
  const child = { task, context, events: out.toolEvents, rounds: out.rounds }
  if (signal.aborted) {
    // Leave the whole child on the parent's event, no longer waiting, then unwind like any stopped tool (saving the
    // reply settles the child's calls with it).
    ctx.progress?.({ tool: 'delegate', args: call.args, ok: false, summary: soFar(child.events.length), child: { ...child, result: '' } })
    throw signal.reason instanceof Error ? signal.reason : new Error('Stopped by you')
  }
  if (out.error)
    return {
      content: `The sub-agent failed: ${out.error}`,
      event: {
        tool: 'delegate',
        args: call.args,
        ok: false,
        summary: `${soFar(child.events.length)} · failed`,
        child: { ...child, result: '', error: out.error }
      }
    }
  // What the parent is told besides the reply: that the child ran out of requests, or that the model cut its reply at
  // its own length limit (the parent's reply would show a warning for that), so it doesn't build on a result that
  // stopped mid-thought as if it were whole (#170). The notes come after the cut, so a long reply can't push them out.
  const notes = [
    stats.toolRoundLimit && `[The sub-agent stopped at its limit of ${stats.toolRoundLimit} requests; this is what it had so far.]`,
    stats.doneReason === 'length' && '[The sub-agent’s reply hit the model’s length limit and was cut off.]'
  ]
    .filter(Boolean)
    .join('\n\n')
  const text = out.content.trim() || (notes ? '' : '[The sub-agent gave no answer.]')
  const result = [cut(text, Math.max(0, replyChars - (notes ? notes.length + 2 : 0))), notes].filter(Boolean).join('\n\n')
  return {
    content: result,
    event: {
      tool: 'delegate',
      args: call.args,
      ok: true,
      summary: withCalls(out.toolEvents.length),
      record: result.slice(0, RECORD_CHARS),
      child: { ...child, result }
    }
  }
}
