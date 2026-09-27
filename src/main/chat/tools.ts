import type { ThinkSetting, ToolEvent } from '@shared/types'
import type { OllamaTool, ToolCall } from '../ollama/client'
import { errorMessage } from '../util'
import type { AssembleInput, PastToolCall } from './assemble'
import { capText, TOOL_RESULT_CHARS } from './results'
import { codeTools } from '../code/tools'
import { mcpTools } from '../mcp/provider'
import { runnerTools } from '../runner/provider'
import { skillTools } from './skillTools'
import { webTools } from './webTools'
import type { Workspace } from '../runner/workspace'
import type { TurnMode } from './turn'

/** What a request's tools let the model do. Decides what the prompt and error messages say Ollmost can't do. */
export type ToolGrant = 'web' | 'code'

/** What this request offers, and the reply it belongs to. */
export interface ToolContext {
  /** The kind of conversation the reply is in: a chat, or a code session working in a folder (see turn.ts). */
  mode: TurnMode
  skills: boolean
  web: boolean
  /** Tool sources switched on for the chat (Conversation.toolSources): `mcp:<server id>`. */
  sources: readonly string[]
  /** The chat holds files the user shared: attachments, or its project's knowledge. */
  privateFiles?: boolean
  /** The folder code runs in, when this reply may run code (see runner/workspace.ts); null otherwise. */
  workspace: Workspace | null
  /** A code session's stage: in `plan` only the reading tools are offered (see Conversation.stage). */
  stage?: 'plan' | 'work'
  /** The reply's stop signal: long-running tools are cancelled with it. */
  signal?: AbortSignal
  /**
   * The most this call's result may add to the request, when the reply's room is shared between several calls.
   * Defaults to TOOL_RESULT_CHARS.
   */
  maxResultChars?: number
  /**
   * The reply this call is part of, for a tool that runs a reply loop of its own (delegate): what a child needs to
   * make the same requests. Unset for a sub-agent's own calls.
   */
  reply?: {
    conversationId: string
    messageId: string
    model: string
    think: ThinkSetting | null
    maxRounds: number
    /** The parts of the parent's prompt input a child's prompt is built from. */
    prompt: Pick<AssembleInput, 'userName' | 'model' | 'contextLength' | 'web' | 'mcpServers' | 'codeRunner' | 'codeSession' | 'skillIndex'>
    /** Tell the chat its usage moved: called on a child's own requests too, not only the parent's rounds. */
    onUsage?: () => void
  }
  /** Set for a sub-agent's own rounds: it is offered no delegate of its own. */
  child?: boolean
  /** This call's index in the reply's tool events, set by the loop for each run. */
  callIndex?: number
  /** A long call may replace what its card shows while it runs (a sub-agent reports its child's calls). */
  progress?: (event: ToolEvent) => void
}

/** A tool's run also knows what the whole request grants (a skill with scripts needs to know if code can run). */
export type RunContext = ToolContext & { grants: ReadonlySet<ToolGrant> }

export interface ToolResult {
  content: string
  event: ToolEvent
  /** Skill id to add to the conversation's active skills, so later turns keep it. */
  loadedSkillId?: string
  /** The model called a tool Ollmost doesn't provide (often a web or code tool it saw in training). */
  unknown?: boolean
  /** The tool exists but this reply may not use it (a write in a session's plan mode): refused with the reason. */
  withheld?: boolean
}

/** How a call is approved: it runs, it asks (and can be allowed for the chat), or it asks each time. */
export type Approval = 'auto' | 'ask' | 'ask-every-time'

/** A call matched to the provider that runs it. `via` is the name the model used when it called an alias. */
export interface ResolvedCall {
  provider: ToolProvider
  name: string
  via: string | null
  args: Record<string, unknown>
}

/** A group of tools: the built-in skill and web tools, the code runner, a code session's tools, MCP servers. */
export interface ToolProvider {
  id: string
  /** The tools offered with this request; none when the provider is off. */
  tools(ctx: ToolContext): OllamaTool[]
  /** What these tools let the model do while they're offered. */
  grants?: ToolGrant[]
  /** A sentence for the unknown-tool reply that points the model at these tools. */
  hint?: string
  /**
   * Claim a call to a name nothing offers (gpt-oss's `browser.open`): return the offered tool it maps to, or
   * null. Only asked after exact names, so an alias can never shadow a real tool such as an MCP server's `fetch`.
   */
  alias?(name: string, args: Record<string, unknown>): string | null
  /**
   * What to show while the call runs. May take a moment: a code session's edit shows its diff before it asks, which
   * means reading the file.
   */
  pending(call: ResolvedCall, ctx: ToolContext): ToolEvent | Promise<ToolEvent>
  /** Run the call. Throwing is fine: the error goes back to the model (a stop is re-thrown instead). */
  run(call: ResolvedCall, ctx: RunContext): Promise<ToolResult>
  /** What later turns keep of a finished call; null or absent keeps nothing. */
  replay?(event: ToolEvent): PastToolCall | null
  /**
   * Whether a call runs straight away ('auto') or waits for the user to allow it ('ask', the default, so a provider
   * that doesn't say never runs unasked). Tools that act on this Mac or the user's accounts ask; the user can still
   * allow one for a whole chat. 'ask-every-time' asks with only Allow once and Deny, for calls where one approval
   * mustn't cover the next (a fetch whose URL can carry data out).
   */
  approval?(call: ResolvedCall, ctx: ToolContext): Approval
  /**
   * Results that only make sense whole (a skill's instructions): capped at TOOL_RESULT_CHARS, but not cut to the
   * call's share of a round's room.
   */
  wholeResults?: boolean
  /**
   * What "Allow for this chat" and a denial cover for this call (see src/shared/toolAllow.ts). Defaults to the tool's
   * name. MCP tools use their server and own name; web_fetch uses the site.
   */
  allowKey?(call: ResolvedCall): string
  /** The user allowed this call for the whole chat (MCP tools record which version of the tool they trusted). */
  allowedForChat?(call: ResolvedCall): void
  /** Where a call goes, for the debugger (a web API, an MCP server). Defaults to ollmost://tools/<name>. */
  endpoint?(call: ResolvedCall): string
}

// In order: a name offered by two providers belongs to the first.
const BUILT_IN: ToolProvider[] = [skillTools, webTools, runnerTools, codeTools, mcpTools]
let registered: ToolProvider[] = []

/** Add a provider; returns a function that removes it. */
export function registerToolProvider(provider: ToolProvider): () => void {
  registered = [...registered, provider]
  return () => {
    registered = registered.filter((p) => p !== provider)
  }
}

const providers = (): ToolProvider[] => [...BUILT_IN, ...registered]
const active = (ctx: ToolContext) => providers().filter((p) => p.tools(ctx).length > 0)

/** Every tool offered with this request, each name once (the first provider to offer a name keeps it). */
export function toolsFor(ctx: ToolContext): OllamaTool[] | undefined {
  const byName = new Map<string, OllamaTool>()
  for (const tool of providers().flatMap((p) => p.tools(ctx))) if (!byName.has(tool.function.name)) byName.set(tool.function.name, tool)
  return byName.size ? [...byName.values()] : undefined
}

export function toolGrants(ctx: ToolContext): Set<ToolGrant> {
  return new Set(active(ctx).flatMap((p) => p.grants ?? []))
}

/** What Ollmost can't do with this request's tools, for an error shown to the user; null when it can do both. */
export function missingAbilities(grants: ReadonlySet<ToolGrant>): string | null {
  const missing = [!grants.has('web') && 'browse the web', !grants.has('code') && 'run code'].filter(Boolean)
  return missing.length ? `Ollmost can't ${missing.join(' or ')}.` : null
}

function argsOf(call: ToolCall): Record<string, unknown> {
  const raw = call.function.arguments
  if (typeof raw === 'string') {
    // Built-in tools like gpt-oss's `python` can send their input as plain text rather than JSON.
    try {
      const parsed = JSON.parse(raw) as unknown
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : { input: raw }
    } catch {
      return raw.trim() ? { input: raw } : {}
    }
  }
  return raw ?? {}
}

/** Match a call to its provider: exact names first, then aliases. Null when nothing offers it. */
export function resolveCall(call: ToolCall, ctx: ToolContext): ResolvedCall | null {
  const name = call.function.name
  const args = argsOf(call)
  const offering = active(ctx)
  const exact = offering.find((p) => p.tools(ctx).some((t) => t.function.name === name))
  if (exact) return { provider: exact, name, via: null, args }
  for (const provider of offering) {
    const target = provider.alias?.(name, args)
    if (target) return { provider, name: target, via: name, args }
  }
  return null
}

/**
 * gpt-oss and others are trained with built-in browser/python tools and will guess at names like
 * "web.run" or "browser.open". A bare "unknown tool" makes them try the next name, so say plainly
 * what exists and what can't be done.
 */
function unknownToolMessage(name: string, ctx: ToolContext, grants: ReadonlySet<ToolGrant>): string {
  const available = (toolsFor(ctx) ?? []).map((t) => t.function.name)
  const list = available.length ? `The only tools available are ${available.join(', ')}.` : 'No tools are available.'
  const web = grants.has('web')
  const code = grants.has('code')
  const lacks =
    !web && !code
      ? 'Ollmost has no internet access, browser, web search or code execution.'
      : !web
        ? 'Ollmost has no internet access, browser or web search.'
        : !code
          ? 'Ollmost cannot run code.'
          : ''
  const limits = [...active(ctx).flatMap((p) => p.hint ?? []), lacks].filter(Boolean).join(' ')
  return `Error: there is no tool named "${name}". ${list} ${limits} Don't try other tool names. Answer the user directly and tell them plainly what you can't do.`
}

// What a tool card can show of a result: enough to see what came back, without storing whole pages per call.
const PREVIEW_CHARS = 1500
const preview = (content: string) => (content.length > PREVIEW_CHARS ? `${content.slice(0, PREVIEW_CHARS)}…` : content)

/**
 * A call the reply stopped on: one still running shows as stopped, not spinning forever; one still waiting for an
 * answer never ran. A sub-agent's own calls settle with it, so none is left asking a question nobody can answer; the
 * sub-agent itself ran, so a question it carried up from one of them leaves it stopped, as Stop does, not "not run".
 */
export function settleToolEvent(event: ToolEvent): ToolEvent {
  if (event.child) {
    const { awaiting, everyTime: _everyTime, ...rest } = event
    const e = { ...rest, child: { ...event.child, events: event.child.events.map(settleToolEvent) } }
    return e.pending || awaiting ? { ...e, pending: false, ok: false, summary: `${e.summary} (stopped)` } : e
  }
  if (event.awaiting) {
    const { awaiting: _awaiting, everyTime: _everyTime, ...rest } = event
    return { ...rest, pending: false, ok: false, summary: `${event.summary} (not run)` }
  }
  return event.pending ? { ...event, pending: false, ok: false, summary: `${event.summary} (stopped)` } : event
}

/** What to show while a call runs, before its result is known. */
export async function pendingEvent(call: ToolCall, ctx: ToolContext): Promise<ToolEvent> {
  const resolved = resolveCall(call, ctx)
  if (resolved) return resolved.provider.pending(resolved, ctx)
  return { tool: call.function.name, args: argsOf(call), ok: true, pending: true, summary: call.function.name, unknown: true }
}

/**
 * Whether a call must wait for the user's answer before it runs. A provider that doesn't say asks. Calls to tools
 * nothing offers never ask: they don't run.
 */
export function approvalFor(call: ToolCall, ctx: ToolContext): Approval {
  const resolved = resolveCall(call, ctx)
  if (!resolved) return 'auto'
  return resolved.provider.approval?.(resolved, ctx) ?? 'ask'
}

/** What an answer to this call covers: "Allow for this chat" is stored under it, and a denial applies to it. */
export function allowKeyFor(call: ToolCall, ctx: ToolContext): string {
  const resolved = resolveCall(call, ctx)
  return (resolved && resolved.provider.allowKey?.(resolved)) ?? resolved?.name ?? call.function.name
}

/** Tell a call's provider that the user allowed it for the chat. */
export function noteAllowedForChat(call: ToolCall, ctx: ToolContext): void {
  const resolved = resolveCall(call, ctx)
  if (resolved) resolved.provider.allowedForChat?.(resolved)
}

/** Where a call goes, for its debugger trace. */
export function toolEndpoint(call: ToolCall, ctx: ToolContext): string {
  const resolved = resolveCall(call, ctx)
  return (resolved && resolved.provider.endpoint?.(resolved)) ?? `ollmost://tools/${resolved?.name ?? call.function.name}`
}

/** What the model hears when the user denies a call, and what the reply shows. The call never ran. */
export function declinedResult(call: ToolCall, pending: ToolEvent): ToolResult {
  const { awaiting: _awaiting, everyTime: _everyTime, ...event } = pending
  return {
    content: `The user declined to run ${call.function.name}, so it didn't run. Don't call it again unless they ask. Carry on without it, and tell them plainly what you couldn't do.`,
    event: { ...event, pending: false, ok: false, declined: true }
  }
}

export async function runTool(call: ToolCall, ctx: ToolContext): Promise<ToolResult> {
  const grants = toolGrants(ctx)
  const resolved = resolveCall(call, ctx)
  if (!resolved) {
    const name = call.function.name
    return {
      content: unknownToolMessage(name, ctx, grants),
      event: { tool: name, args: argsOf(call), ok: false, summary: name, unknown: true },
      unknown: true
    }
  }
  let result: ToolResult
  try {
    result = await resolved.provider.run(resolved, { ...ctx, grants })
  } catch (err) {
    if (ctx.signal?.aborted) throw err
    const message = errorMessage(err)
    result = { content: `Error: ${message}`, event: { tool: resolved.name, args: resolved.args, ok: false, summary: message } }
  }
  const max = resolved.provider.wholeResults ? TOOL_RESULT_CHARS : Math.min(ctx.maxResultChars ?? TOOL_RESULT_CHARS, TOOL_RESULT_CHARS)
  return { ...result, content: capText(result.content, max), event: { preview: preview(result.content), ...result.event } }
}

/** The finished calls behind a reply that later turns keep, in brief, as each tool's provider decides. */
export function replayCalls(events: ToolEvent[]): PastToolCall[] {
  return events.flatMap((e) => {
    if (!e.ok || e.pending) return []
    for (const p of providers()) {
      const past = p.replay?.(e)
      if (past) return [past]
    }
    return []
  })
}
