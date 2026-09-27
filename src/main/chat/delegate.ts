// A sub-agent: a fresh reply loop on one task the model describes, with the parent's model, tools and approvals,
// whose reply is the tool result. Only that result enters the parent's context; the child's reading stays here,
// on the parent's tool event, for the transcript (#97).
import { contextOptions, effectiveContext } from '@shared/context'
import { resolveThinkProfile, toOllamaThink } from '@shared/thinking'
import type { MessageStats, ToolEvent } from '@shared/types'
import type { ChatBody, OllamaTool } from '../ollama/client'
import { getModelInfo } from '../ollama/models'
import { getSettings } from '../settings'
import { assemble, promptBudget } from './assemble'
import { runRounds, toolsTokens } from './rounds'
import { type ResolvedCall, type RunContext, type ToolContext, toolGrants, type ToolProvider, type ToolResult, toolsFor } from './tools'

/** As much of a child's reply as the parent gets; a longer one is cut with a mark. */
export const DELEGATE_RESULT_CHARS = 12_000
const SUMMARY_CHARS = 60
const RECORD_CHARS = 500
const CUT_MARK = '\n\n[… the sub-agent’s reply was cut here]'

/** What a child's traces and approvals are keyed by: its parent's message and the delegate call's index there. */
export const childId = (messageId: string, index: number): string => `${messageId}#${index}`

const DELEGATE_TOOL: OllamaTool = {
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

const optional = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined)
const summaryOf = (task: string): string => {
  const line = task.trim().split('\n')[0]
  return line.length > SUMMARY_CHARS ? `${line.slice(0, SUMMARY_CHARS - 1)}…` : line
}
const cut = (s: string): string => (s.length > DELEGATE_RESULT_CHARS ? s.slice(0, DELEGATE_RESULT_CHARS) + CUT_MARK : s)

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
  const model = await getModelInfo(reply.model)
  const profile = resolveThinkProfile(reply.model, model.capabilities, model.overrides.think)
  const numCtx = effectiveContext(model, settings.localNumCtx)
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
  const content = context ? `<task>\n${task}\n</task>\n\n<context>\n${context}\n</context>` : `<task>\n${task}\n</task>`
  const assembled = assemble({
    ...reply.prompt,
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
    child: { task }
  })
  const body: ChatBody = {
    model: reply.model,
    messages: assembled.messages,
    think: toOllamaThink(profile, reply.think),
    tools,
    options: contextOptions(model, settings.localNumCtx)
  }

  const events: ToolEvent[] = []
  // Requests made so far: a round that calls tools reports its usage before its calls run.
  let rounds = 0
  const summary = summaryOf(task)
  // Everything the parent's card shows while the child runs: its calls, and whether one waits for the user.
  const report = () =>
    ctx.progress?.({
      tool: 'delegate',
      args: call.args,
      ok: true,
      summary,
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
    body,
    budget: promptBudget(numCtx),
    maxRounds: Math.max(1, Math.min(settings.delegate.maxRounds, reply.maxRounds)),
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
  const child = { task, context, events: out.toolEvents, rounds: out.rounds }
  if (signal.aborted) {
    // Leave the whole child on the parent's event, no longer waiting, then unwind like any stopped tool (saving the
    // reply settles the child's calls with it).
    ctx.progress?.({ tool: 'delegate', args: call.args, ok: false, summary, child: { ...child, result: '' } })
    throw signal.reason instanceof Error ? signal.reason : new Error('Stopped by you')
  }
  if (out.error)
    return {
      content: `The sub-agent failed: ${out.error}`,
      event: { tool: 'delegate', args: call.args, ok: false, summary: `${summary} · failed`, child: { ...child, result: '' } }
    }
  let text = out.content.trim()
  if (stats.toolRoundLimit)
    text = `${text}\n\n[The sub-agent stopped at its limit of ${stats.toolRoundLimit} requests; this is what it had so far.]`.trim()
  if (!text) text = '[The sub-agent gave no answer.]'
  const result = cut(text)
  const calls = out.toolEvents.length
  return {
    content: result,
    event: {
      tool: 'delegate',
      args: call.args,
      ok: true,
      summary: `${summary} · ${calls} tool call${calls === 1 ? '' : 's'}`,
      record: result.slice(0, RECORD_CHARS),
      child: { ...child, result }
    }
  }
}
