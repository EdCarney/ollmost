// Domain types shared by the main process, preload bridge and renderer.

export type ID = string

export interface Project {
  id: ID
  name: string
  description: string
  instructions: string
  pinned: boolean
  createdAt: number
  updatedAt: number
  conversationCount?: number
}

export interface ProjectFile {
  id: ID
  projectId: ID
  name: string
  mime: string
  size: number
  tokenEstimate: number
  /** The folder it sits in, a relative path ('docs/meetings'); '' at the root. */
  folder: string
  createdAt: number
}

/** What the user picked in the composer. Mapped per model by `toOllamaThink`. */
export type ThinkSetting = 'off' | 'on' | 'low' | 'medium' | 'high'

/** What a code session's commands may reach: nothing, package registries, or those and the git hosts. */
export type CodeNetwork = 'none' | 'registries' | 'registries-git'

/** A changed file's state in a session's repository, as git status reports it. */
export type ChangeStatus = 'modified' | 'added' | 'deleted' | 'renamed' | 'untracked' | 'conflict'
export interface ChangedFile {
  /** Relative to the session's folder. */
  path: string
  status: ChangeStatus
  /** Renamed: where it was. */
  from?: string
}
/** What changed in a session's folder, asked of git run inside the session's sandbox. */
export interface CodeChanges {
  /** Whether git found a repository at the folder. */
  repo: boolean
  files: ChangedFile[]
  /** More files changed than listed. */
  cut: boolean
  /** Why git couldn't answer (no Command Line Tools, the folder is missing, git failed or took too long); null when it did. */
  error: string | null
}
/** One changed file's unified diff against HEAD, or against nothing for a file git doesn't track yet. */
export interface CodeDiff {
  diff: string
  /** The diff was longer than shown. */
  cut: boolean
}

/** What /compact made of a chat's older turns: later replies replay the summary instead of them (the messages stay). */
export interface Compaction {
  summary: string
  /** The `createdAt` of the last message the summary covers; replies send only what came after. */
  upTo: number
  /** How many messages the summary stands for. */
  messages: number
  at: number
}

export interface Conversation {
  id: ID
  projectId: ID | null
  title: string
  model: string | null
  think: ThinkSetting | null
  /** Skill ids the user picked (/ or the + menu); applied to every reply. */
  skills: string[]
  /** Skill ids the model loaded itself; kept for later turns but applied only where relevant. */
  autoSkills: string[]
  /** Instructions for this chat only (a system prompt or persona); '' when unset. */
  instructions: string
  /** Tools you chose "Allow for this chat" for: they run here without asking. */
  allowedTools: string[]
  /** Tool sources switched on for this chat: `mcp:<server id>` for each MCP server. */
  toolSources: string[]
  /** A chat, or a code session: agentic work in `root`, a folder of the user's. */
  mode: 'chat' | 'code'
  /** A code session's folder, by its real path; null for a chat. */
  root: string | null
  /** What a code session's commands may reach on the network; 'none' for a chat. */
  network: CodeNetwork
  /** The chat's /compact summary, when one was made; null otherwise. */
  compaction: Compaction | null
  /**
   * A code session's stage: in `plan` the model may read, list and search the folder but not edit it or run
   * commands, until the user starts working. Chats are always `work`.
   */
  stage: 'plan' | 'work'
  /** The plan the user approved by starting work: the model's last reply in plan mode. Null until then. */
  plan: string | null
  pinned: boolean
  createdAt: number
  updatedAt: number
}

export type Role = 'user' | 'assistant'

export interface Attachment {
  id: ID
  messageId: ID | null
  kind: 'image' | 'document'
  name: string
  mime: string
  size: number
  tokenEstimate: number
  /** Extraction produced no usable text (e.g. a scanned PDF). */
  textless: boolean
}

export interface ToolEvent {
  tool: string
  args: Record<string, unknown>
  ok: boolean
  summary: string
  /** Still running (web requests take a few seconds); replaced by the final event at the same index. */
  pending?: boolean
  /**
   * A short record of the result (search titles and links; a page's title, link and opening), replayed to
   * the model on later turns so follow-ups like "open the third result" still work.
   */
  record?: string
  /** How long the reply's text was when the call was made, so the UI shows it there. Unset on older replies. */
  at?: number
  /** The start of what the tool returned to the model, for the tool's card. */
  preview?: string
  /** No tool by this name was offered (the model invented it). Unset on older replies. */
  unknown?: boolean
  /** Waiting for you to allow or deny the call; it hasn't run. */
  awaiting?: boolean
  /** While waiting: the call asks every time, so it can only be allowed once or denied. */
  everyTime?: boolean
  /** You denied the call, so it didn't run. */
  declined?: boolean
  /** Where the tool comes from, for its card: an MCP server's name. */
  source?: string
  /** Files a code run created or changed, relative to the chat's workspace (or, for a file tool, the file it wrote). */
  files?: Array<{ path: string; size: number }>
  /** What edit_file or write_file changed, as a unified diff, for its card and for the approval that asks first. */
  diff?: string
  /** A sub-agent's run (the delegate tool): its task, its own tool calls, and the reply it returned (or, when its
   *  request failed, why). */
  child?: { task: string; context?: string; events: ToolEvent[]; result: string; rounds: number; error?: string }
}

/** Your answer to a tool call that asked first. */
export type ToolDecision = 'once' | 'chat' | 'deny'

export interface MessageStats {
  promptTokens?: number
  completionTokens?: number
  durationMs?: number
  tokensPerSecond?: number
  thinkingMs?: number
  truncatedHistory?: number
  /** Ollama's done_reason for the reply's last request: "length" means it hit a token limit and was cut off. */
  doneReason?: string
  /** Estimated USD for the requests behind this reply; null when the model's price is unknown. */
  costUsd?: number | null
  /** Token counts were estimated (e.g. the reply was stopped). */
  estimated?: boolean
  /** The model was still calling tools when the reply ran out of rounds (this many), so it had to answer. */
  toolRoundLimit?: number
  /** Earlier tool results from this reply that were cut to a note to fit the context window. */
  shortenedToolResults?: number
  /** Tool sources switched on for the chat that couldn't be used for this reply, and why. */
  unavailableTools?: string[]
}

/**
 * One round's thinking, placed where the round began: `at` is how long the reply's text was then, `index` how many
 * tool events the reply had made (round r's thinking sits after round r−1's calls and before round r's).
 */
export interface ThinkingSegment {
  text: string
  at: number
  index: number
  /** How long the round's thinking took, when known. */
  ms: number | null
}

export interface Message {
  id: ID
  conversationId: ID
  parentId: ID | null
  role: Role
  content: string
  thinking: string | null
  /** Each round's thinking, placed where the round began; null for a reply saved before this was kept. */
  thinkingSegments: ThinkingSegment[] | null
  model: string | null
  attachments: Attachment[]
  toolEvents: ToolEvent[]
  stats: MessageStats | null
  error: string | null
  createdAt: number
}

export type ArtifactType = 'markdown' | 'code' | 'html' | 'svg' | 'mermaid'

export interface ArtifactVersion {
  id: ID
  artifactId: ID
  messageId: ID | null
  version: number
  content: string
  createdAt: number
}

export interface Artifact {
  id: ID
  conversationId: ID
  identifier: string
  type: ArtifactType
  title: string
  language: string | null
  createdAt: number
  updatedAt: number
  versions: ArtifactVersion[]
}

export interface ArtifactSummary {
  id: ID
  conversationId: ID
  conversationTitle: string
  projectId: ID | null
  identifier: string
  type: ArtifactType
  title: string
  language: string | null
  versionCount: number
  updatedAt: number
}

export interface ConversationDetail {
  conversation: Conversation
  messages: Message[]
  artifacts: Artifact[]
  usage: ChatUsage
}

export interface SearchHit {
  conversationId: ID
  title: string
  snippet: string
  updatedAt: number
  mode: 'chat' | 'code'
}

// ---- Models -------------------------------------------------------------

export type ThinkProfile =
  { kind: 'none' } | { kind: 'toggle' } | { kind: 'always'; note?: string } | { kind: 'levels'; canDisable: boolean }

export interface ModelOverrides {
  think?: ThinkProfile['kind']
  artifacts?: boolean
  autoSkills?: boolean
}

export interface ModelPrice {
  /** USD per million tokens. */
  input: number
  cachedInput: number | null
  output: number
}

export interface PriceTable {
  prices: Record<string, ModelPrice>
  /** When the table was read from ollama.com/pricing (or the bundled snapshot date). */
  updatedAt: number
  source: 'ollama.com' | 'bundled'
}

export interface ModelInfo {
  name: string
  /** Cloud models run on ollama.com; local ones on this machine. */
  location: 'cloud' | 'local'
  installed: boolean
  capabilities: string[]
  contextLength: number | null
  family: string | null
  parameterSize: string | null
  overrides: ModelOverrides
  /** Published cloud price, if known. Local models are free. */
  price: ModelPrice | null
}

export interface ModelListResult {
  models: ModelInfo[]
  error: string | null
}

// ---- Usage & cost ---------------------------------------------------------

export interface UsageWindow {
  id: string
  label: string
  /** Fraction of the window's allowance used, 0–1. */
  usage: number
  periodMs: number | null
  /** Next reset, when known (Ollama's API doesn't report it). */
  resetAt: number | null
  resetSource: 'configured' | 'detected' | null
  /** Requests per model in this window, across every app using the account. */
  models: Array<{ name: string; requests: number }>
}

export interface AccountUsage {
  plan: string | null
  windows: UsageWindow[]
  spend: {
    cost: number
    label: string
    /**
     * 'credits': worked out from the monthly window's share of the plan's credit pool (credit plans
     * report no dollar figure). 'activity': Ollama's own cost figure.
     */
    source: 'credits' | 'activity'
    /** Size of the monthly credit pool, for "$0.54 of $60". */
    pool: number | null
    periodStart: number | null
    periodEnd: number | null
    models: Array<{ model: string; cost: number }>
  } | null
  fetchedAt: number
  /** Set when there's no API key, so the UI can prompt for one. */
  needsKey: boolean
  error: string | null
}

export interface TokenTotals {
  promptTokens: number
  completionTokens: number
  /** Null when some usage came from a cloud model without a known price. */
  costUsd: number | null
  /** At least one request had no token counts (e.g. stopped mid-stream) and was estimated. */
  estimated: boolean
}

export interface ChatUsage extends TokenTotals {
  byModel: Array<TokenTotals & { model: string; requests: number }>
  /** Tokens the most recent request sent + received, for a context-window meter. */
  lastContextTokens: number | null
}

export interface UsageSummary {
  days: number
  total: TokenTotals & { requests: number }
  byModel: Array<TokenTotals & { model: string; requests: number }>
  byDay: Array<{ day: string; costUsd: number; tokens: number }>
}

// ---- Debugger traces -----------------------------------------------------

export type TraceKind = 'chat' | 'title' | 'tool' | 'replay' | 'compact' | 'delegate'
export type TraceStatus = 'running' | 'ok' | 'error' | 'aborted'

export interface TraceSummary {
  id: string
  conversationId: ID | null
  messageId: ID | null
  kind: TraceKind
  model: string | null
  /** Tool-loop round within a turn (0-based), for chat traces. */
  round: number | null
  status: TraceStatus
  startedAt: number
  durationMs: number | null
  promptTokens: number | null
  completionTokens: number | null
  costUsd: number | null
  /** One-line description: tool call, first words of the reply, error. */
  summary: string
}

export interface TraceTiming {
  /** Time until Ollama's first response byte. */
  ttfbMs: number | null
  /** Time until the first thinking or content token. */
  firstTokenMs: number | null
  totalMs: number | null
  /** Ollama's own durations (from the final chunk). */
  loadMs: number | null
  promptEvalMs: number | null
  evalMs: number | null
}

export interface TraceDetail extends TraceSummary {
  endpoint: string
  /** The exact body sent, with image bytes replaced by size placeholders. */
  request: unknown
  response: {
    content?: string
    thinking?: string
    toolCalls?: unknown[]
    /** Ollama's final chunk (stats, done_reason) without the message. */
    final?: unknown
    /** For tool traces: what was returned to the model. */
    result?: string
    error?: string
    chunks?: number
  }
  timing: TraceTiming
}

// ---- Skills -------------------------------------------------------------

export type SkillSource = 'app' | 'ollama' | 'claude'

export interface Skill {
  id: string
  name: string
  description: string
  source: SkillSource
  dir: string
  readOnly: boolean
  hasScripts: boolean
  enabled: boolean
  files: string[]
}

export interface SkillDetail extends Skill {
  body: string
}

// ---- MCP servers ----------------------------------------------------------

/** Whether a tool asks before each call, runs without asking, or isn't offered at all. */
export type ToolPolicy = 'ask' | 'allow' | 'off'

/** A local (stdio) MCP server Ollmost starts. Environment values stay in the main process; the renderer sees names. */
export interface McpServer {
  /** Fixed when the server is added: its tools are named `<id>__<tool>`. */
  id: string
  name: string
  command: string
  args: string[]
  /** Folder to start it in; null uses your home folder. */
  cwd: string | null
  envKeys: string[]
  /**
   * Variables whose values can't be read (the keychain entry that encrypted them is gone). The server doesn't start
   * until they're entered again: it would run without its token.
   */
  missingEnv: string[]
  /** Switched on in new chats. */
  defaultOn: boolean
  /** Tools set to something other than Ask. */
  tools: Record<string, ToolPolicy>
  /**
   * Tools put back on Ask because the server changed their description or input since you allowed them. Cleared when
   * you set the tool's policy again.
   */
  changed?: string[]
}

export interface McpServerInput {
  /** Set when editing an existing server. */
  id?: string
  name: string
  command: string
  args: string[]
  cwd: string | null
  /** Values to set, by name; null removes one. When editing, names left out keep their saved values. */
  env: Record<string, string | null>
  defaultOn: boolean
}

/** Another app's MCP config that Ollmost can copy servers from. */
export interface McpImportSource {
  id: 'claude-desktop' | 'claude-code'
  label: string
  path: string
  /** Names of the local servers it lists. */
  servers: string[]
  /** Entries Ollmost can't use (remote servers). */
  unsupported: number
}

export interface McpImportResult {
  added: McpServer[]
  /** Entries left out, each as "name: why". */
  skipped: string[]
}

export type McpState = 'stopped' | 'starting' | 'ready' | 'error'

export interface McpToolInfo {
  /** The tool's own name on its server. */
  name: string
  title: string | null
  description: string
  /** Roughly how many tokens its definition adds to every request. */
  tokens: number
}

export interface McpStatus {
  id: string
  state: McpState
  error: string | null
  tools: McpToolInfo[]
  /** What the server calls itself, once connected. */
  serverInfo: { name: string; version: string } | null
}

// ---- Code runner ------------------------------------------------------------

export interface RunnerStatus {
  /** Whether code can run at all; when not, `reason` says why (no sandbox, no Python). */
  available: boolean
  reason: string | null
  python: { path: string; version: string } | null
  /** Ollmost's shared Python environment (chats that may install packages each get their own), created on first use. */
  venv: string
  /** Whether any of Ollmost's Python environments exists. */
  venvExists: boolean
}

// ---- Theming ------------------------------------------------------------

export const PALETTE_KEYS = [
  'canvas',
  'sidebar',
  'panel',
  'hover',
  'bubble',
  'code',
  'fg',
  'muted',
  'subtle',
  'line',
  'lineStrong',
  'accent',
  'accentFg',
  'accentSoft',
  'danger',
  'success',
  'warn',
  'synKeyword',
  'synString',
  'synComment',
  'synFunction',
  'synConstant',
  'synPunctuation'
] as const

export type PaletteKey = (typeof PALETTE_KEYS)[number]
export type Palette = Record<PaletteKey, string>

export interface ThemeDef {
  id: string
  name: string
  builtin: boolean
  light: Palette
  dark: Palette
  fonts: { ui: string; reading: string; mono: string }
  radius: number
  /** A theme with a single palette (e.g. a green-on-black terminal) ignores the light/dark mode. */
  only?: 'light' | 'dark'
}

// ---- Settings -----------------------------------------------------------

export interface Settings {
  userName: string
  preferences: string
  connection: { mode: 'local' | 'direct'; host: string; hasApiKey: boolean }
  defaultModel: string | null
  titleModel: string | null
  showCloudCatalog: boolean
  localNumCtx: number
  appearance: {
    themeId: string
    mode: 'system' | 'light' | 'dark'
    fontSize: number
    chatWidth: number
    responseFont: 'reading' | 'ui'
  }
  artifacts: { enabled: boolean; allowCdn: boolean }
  /** `disabled` turns off app/Ollama skills; Claude skills are off unless listed in `enabledImports`. */
  skills: { sources: { ollama: boolean; claude: boolean }; disabled: string[]; enabledImports: string[]; autoLoad: boolean }
  /** Web search and page reading through Ollama's web API (needs an ollama.com API key). */
  web: { enabled: boolean }
  /**
   * The sandboxed code runner: whether models may run code (asking first, or not), whether new chats start with it,
   * whether code may download Python packages from PyPI, and how long a run may take.
   */
  runner: { mode: 'off' | 'ask' | 'allow'; defaultOn: boolean; pypi: boolean; timeoutSec: number }
  /** A chat's reply: how many tool calls it may make before it stops and offers Continue. */
  chat: { maxRounds: number }
  /**
   * Code sessions (a model working in a folder of the user's): whether its edits and its commands ask first, how long
   * a command may run, how many tool calls a reply may make, and the network preset new sessions start with.
   */
  code: { edits: 'ask' | 'allow'; commands: 'ask' | 'allow'; timeoutSec: number; maxRounds: number; defaultNetwork: CodeNetwork }
  /**
   * Whether a model may delegate to a sub-agent (the delegate tool), how many requests one may make, and how many one
   * reply may run at the same time (1 to 5; 1 runs them one after another).
   */
  delegate: { enabled: boolean; maxRounds: number; parallel: number }
  /** Record every request for the debugger window. */
  debug: { record: boolean }
  /** Hover cards on links; `previews` fetches page title/image from this Mac (off by default for privacy). */
  links: { previews: boolean }
  usage: {
    /** Show quota and chat cost in the title bar. */
    showInHeader: boolean
    /** Which quota window the title bar shows ('auto' picks the longest one reported). */
    headerWindow: string
    /** Known reset moments per window, set by the user or detected from a usage drop. */
    anchors: Record<string, { at: number; source: 'configured' | 'detected' } | null>
    /** Day of month a credit-based plan refreshes. */
    monthlyDay: number | null
    /** Monthly credit pool in USD; null uses the plan's published size. */
    poolUsd: number | null
  }
}

// ---- Chat streaming -----------------------------------------------------

export interface SendRequest {
  conversationId: ID | null
  projectId: ID | null
  content: string
  attachmentIds: ID[]
  model: string
  think: ThinkSetting | null
  skills: string[]
  /** Tool sources for this chat (see Conversation.toolSources). */
  toolSources: string[]
}

export interface SendResult {
  conversation: Conversation
  userMessage: Message | null
  assistantMessageId: ID
}

export type ChatEvent =
  | {
      type: 'delta'
      conversationId: ID
      messageId: ID
      content?: string
      thinking?: string
      /** With `thinking`: where the round it belongs to began (see ThinkingSegment). */
      round?: { at: number; index: number }
    }
  | { type: 'tool'; conversationId: ID; messageId: ID; index: number; event: ToolEvent }
  | { type: 'done'; conversationId: ID; message: Message; artifacts: Artifact[]; conversation: Conversation; usage: ChatUsage }
  /** The chat's totals so far, sent as a round ends with more to come, and after a title request: the chip moves during a reply. */
  | { type: 'usage'; conversationId: ID; usage: ChatUsage }
  | { type: 'error'; conversationId: ID; messageId: ID; error: string }
  | { type: 'title'; conversationId: ID; title: string }

export type FileSource = { path: string } | { name: string; mime: string; data: ArrayBuffer }
