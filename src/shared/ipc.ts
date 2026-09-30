import type {
  AccountUsage,
  Artifact,
  ArtifactSummary,
  ArtifactType,
  AskAnswer,
  Attachment,
  ChatEvent,
  CodeChanges,
  CodeDiff,
  CodeNetwork,
  Conversation,
  ConversationDetail,
  Endpoint,
  EndpointFlavor,
  EndpointKind,
  EndpointProbe,
  FileSource,
  ID,
  McpImportResult,
  McpImportSource,
  McpServer,
  McpServerInput,
  McpStatus,
  ModelInfo,
  ModelListResult,
  ModelListUpdate,
  ModelOverrides,
  PriceTable,
  Project,
  ProjectFile,
  RunnerStatus,
  SearchHit,
  SendRequest,
  SendResult,
  Settings,
  Skill,
  SkillDetail,
  ThemeDef,
  ThinkSetting,
  ToolDecision,
  ToolPolicy,
  TraceDetail,
  TraceSummary,
  UsageSummary
} from './types'
import type { MigrationNoticeView } from './migration'

/** A link's page preview; image and icon are data: URLs. */
export interface LinkPreview {
  url: string
  title: string | null
  description: string | null
  siteName: string | null
  image: string | null
  icon: string | null
}

export type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? (T[K] extends unknown[] ? T[K] : DeepPartial<T[K]>) : T[K] }

export interface ConversationPatch {
  title?: string
  pinned?: boolean
  projectId?: ID | null
  model?: string | null
  think?: ThinkSetting | null
  skills?: string[]
  instructions?: string
  toolSources?: string[]
  /** Set to [] to have this chat ask again before every tool. */
  allowedTools?: string[]
  /** A code session's network preset. */
  network?: CodeNetwork
  /** A code session's stage; starting work keeps the model's last reply as the approved plan. */
  stage?: 'plan' | 'work'
}

export interface SkillInput {
  id?: string
  name: string
  description: string
  body: string
}

/**
 * The renderer-facing API. Every method maps 1:1 to an `ipcMain.handle` channel
 * named `<group>:<method>` (see `src/main/ipc.ts` and `src/preload/index.ts`).
 */
export interface OllmostApi {
  app: {
    /** `home` is the user's home folder, for display only (shortened to ~); never use it to build or check a path. */
    info(): Promise<{ version: string; dataDir: string; platform: string; home: string }>
    setNativeTheme(mode: 'system' | 'light' | 'dark', background: string): Promise<void>
    openExternal(url: string): Promise<void>
    openDataFolder(): Promise<void>
    /** After the move from the old app (see @shared/migration): what needs entering again; null once dismissed. */
    migrationNotice(): Promise<MigrationNoticeView | null>
    dismissMigrationNotice(): Promise<void>
  }
  settings: {
    get(): Promise<Settings>
    update(patch: DeepPartial<Settings>): Promise<Settings>
    setApiKey(key: string | null): Promise<Settings>
  }
  models: {
    /**
     * Every enabled endpoint's models. Each is waited for a few seconds: one that hasn't answered by then comes back in
     * `errors` with `pending`, and its answer arrives through events.onModels.
     */
    list(refresh?: boolean): Promise<ModelListResult>
    info(key: string): Promise<ModelInfo>
    setOverrides(key: string, overrides: ModelOverrides): Promise<ModelInfo>
    /** Forget what errors taught Ollmost about this model (tools refused, a context size), and read it again. */
    redetect(key: string): Promise<ModelInfo>
  }
  /** Model servers. Never changed through settings.update: its deep-merge can't hold a list. */
  endpoints: {
    list(): Promise<Endpoint[]>
    /** What answers at an address (refused at once when another endpoint has it). */
    probe(input: { baseUrl: string; apiKey?: string }): Promise<EndpointProbe>
    add(input: { name: string; baseUrl: string; kind: EndpointKind; flavor: EndpointFlavor; apiKey?: string }): Promise<Endpoint>
    update(
      id: string,
      patch: Partial<Pick<Endpoint, 'name' | 'baseUrl' | 'enabled' | 'flavor' | 'showCloudCatalog' | 'numCtx' | 'defaultContext'>>
    ): Promise<Endpoint>
    /** What removing it would lose: the chats on its models, its key, its models' settings. */
    removalImpact(id: string): Promise<{ chats: number; hasKey: boolean; overrides: number }>
    remove(id: string): Promise<void>
    /** Its own key; null removes it. ollama.com's is the account key (settings.setApiKey). */
    setKey(id: string, key: string | null): Promise<Endpoint>
  }
  projects: {
    list(): Promise<Project[]>
    get(id: ID): Promise<Project | null>
    create(input: { name: string; description?: string }): Promise<Project>
    update(id: ID, patch: Partial<Pick<Project, 'name' | 'description' | 'instructions' | 'pinned'>>): Promise<Project>
    delete(id: ID): Promise<void>
    files(id: ID): Promise<ProjectFile[]>
    /** Add files to the project, into `folder` (a relative path; '' or omitted for the root). */
    addFiles(id: ID, sources: FileSource[], folder?: string): Promise<{ added: ProjectFile[]; errors: string[] }>
    removeFile(fileId: ID): Promise<void>
    /** Put a file in another folder ('' for the root); folders are the files' paths, so this is all a move is. */
    moveFile(fileId: ID, folder: string): Promise<ProjectFile>
    /**
     * Preview a project file with Quick Look, never with the app for its type: the stored copy lost its original's
     * download mark, so a launcher document would run without a word (#67). It's marked as downloaded again first.
     */
    openFile(fileId: ID): Promise<void>
    /** Show a project file in Finder. */
    revealFile(fileId: ID): Promise<void>
  }
  conversations: {
    /** Every conversation, or only chats or only code sessions. */
    list(opts?: { projectId?: ID; limit?: number; mode?: Conversation['mode'] }): Promise<Conversation[]>
    get(id: ID): Promise<ConversationDetail | null>
    update(id: ID, patch: ConversationPatch): Promise<Conversation>
    delete(id: ID): Promise<void>
    search(query: string): Promise<SearchHit[]>
  }
  chat: {
    send(req: SendRequest): Promise<SendResult>
    /** Re-run the last assistant turn, optionally on a different model. */
    regenerate(conversationId: ID, opts: { model: string; think: ThinkSetting | null }): Promise<SendResult>
    /** Replace a user message's text, drop everything after it, and re-run. */
    edit(messageId: ID, content: string, opts: { model: string; think: ThinkSetting | null }): Promise<SendResult>
    stop(conversationId: ID): Promise<void>
    /**
     * /compact: summarize every message since the last summary (or the start) with `model` (the composer's); later
     * replies replay the summary instead. `focus` is what the user asked to keep. Returns the updated chat.
     */
    compact(conversationId: ID, opts: { focus: string; model: string }): Promise<Conversation>
    /** Answer a tool call that's waiting for approval: its reply's id and the call's index in its tool events. */
    decide(conversationId: ID, messageId: ID, index: number, decision: ToolDecision): Promise<void>
    /** Answer an ask_user call that's waiting: one answer per question, or null to skip them all. */
    answer(conversationId: ID, messageId: ID, index: number, answers: AskAnswer[] | null): Promise<void>
  }
  attachments: {
    ingest(sources: FileSource[]): Promise<{ added: Attachment[]; errors: string[] }>
    pick(): Promise<FileSource[]>
    remove(id: ID): Promise<void>
  }
  artifacts: {
    /** The latest artifacts, or only those made in a project's chats. */
    list(projectId?: ID): Promise<ArtifactSummary[]>
    /** Stage HTML/SVG for the sandboxed frame; returns an artifact:// URL. */
    stage(type: ArtifactType, content: string): Promise<string>
    save(title: string, type: ArtifactType, language: string | null, content: string): Promise<boolean>
    createFromBlock(input: {
      conversationId: ID
      messageId: ID
      title: string
      type: ArtifactType
      language: string | null
      content: string
    }): Promise<Artifact>
  }
  skills: {
    list(): Promise<Skill[]>
    get(id: string): Promise<SkillDetail | null>
    save(input: SkillInput): Promise<Skill>
    delete(id: string): Promise<void>
    duplicate(id: string): Promise<Skill>
    setEnabled(id: string, enabled: boolean): Promise<void>
    reveal(id: string | null): Promise<void>
  }
  themes: {
    list(): Promise<ThemeDef[]>
    save(theme: ThemeDef): Promise<ThemeDef>
    delete(id: string): Promise<void>
    exportTheme(theme: ThemeDef): Promise<boolean>
    importTheme(): Promise<ThemeDef | null>
  }
  usage: {
    /** Quota windows and recent spend from ollama.com (needs an API key). */
    account(refresh?: boolean): Promise<AccountUsage>
    /** Ollmost's own ledger of requests over the last N days. */
    /** Ollmost's own totals over the last `days`, or between `since` and `until` (ms) when given. */
    summary(days: number, since?: number, until?: number | null): Promise<UsageSummary>
    /** Last raw /api/usage response, for troubleshooting the undocumented endpoint. */
    raw(): Promise<{ at: number; json: unknown } | null>
    prices(): Promise<PriceTable>
    refreshPrices(): Promise<PriceTable>
  }
  links: {
    /**
     * Title, description, image and icon for a link (null when previews are off or unavailable). `conversationId` is the
     * chat the link is shown in: none are fetched in chats with tools or files.
     */
    preview(url: string, conversationId: string | null): Promise<LinkPreview | null>
  }
  runner: {
    /** Whether code can run here, and if not, why. */
    status(): Promise<RunnerStatus>
    /** Packages installed in the chats' Python environments. */
    packages(): Promise<Array<{ name: string; version: string }>>
    /** Delete Ollmost's Python environments and everything installed in them. Refused while code runs in a chat. */
    resetEnvironment(): Promise<void>
    /** A file a run wrote, by its path in the chat’s workspace: preview a copy of it (Quick Look on a Mac), show it in
     * Finder (marking every file in the folder as downloaded; refused while the chat's code runs), or save a copy
     * (marked too). */
    openFile(conversationId: ID, path: string): Promise<void>
    revealFile(conversationId: ID, path: string): Promise<void>
    saveFile(conversationId: ID, path: string): Promise<boolean>
  }
  code: {
    /**
     * Choose a folder for a code session: a folder dialog, then the checks in validateRoot (src/main/runner/root.ts).
     * Its real path, or null when cancelled; throws with the reason when the folder can't be used.
     */
    pickFolder(): Promise<string | null>
    /** Make a session on `root` (a folder pickFolder returned; checked again), titled after the folder. */
    create(input: { root: string; model: string; think: ThinkSetting | null }): Promise<Conversation>
    /** The folders of recent sessions that still exist, most recent first. */
    recentRoots(): Promise<string[]>
    /** A session's folder was moved or renamed: choose it again. The session as updated, or null when cancelled. */
    locate(id: ID): Promise<Conversation | null>
    /** Whether a session's folder is still where it was, and the git branch checked out there (null when not a repository). */
    status(id: ID): Promise<{ found: boolean; branch: string | null }>
    /** Show a session's folder in Finder. */
    reveal(id: ID): Promise<void>
    /**
     * What changed in a session's folder: git status run inside the session's sandbox (never outside it: a folder that
     * isn't a repository lets session code plant a .git file naming programs for git to run). Refused while a reply runs.
     */
    changes(id: ID): Promise<CodeChanges>
    /** One changed file's diff (`path` relative to the folder), from git inside the sandbox. Refused while a reply runs. */
    diff(id: ID, path: string): Promise<CodeDiff>
  }
  mcp: {
    /** Configured servers (environment variable names only, never values). */
    list(): Promise<McpServer[]>
    /** Add a server, or update one; a running server restarts with the new settings. */
    save(input: McpServerInput): Promise<McpServer>
    remove(id: string): Promise<void>
    /** Every server's state and tools. Changes arrive through events.onMcp. */
    status(): Promise<McpStatus[]>
    /** Start these servers if they aren't running (a chat that uses them was opened). */
    connect(ids: string[]): Promise<void>
    restart(id: string): Promise<void>
    /** What the server last wrote to stderr. */
    log(id: string): Promise<string[]>
    /** Ask before each call (the default), run without asking, or don't offer the tool at all. */
    setToolPolicy(id: string, tool: string, policy: ToolPolicy): Promise<McpServer>
    /** Add the servers in a pasted JSON snippet (the `mcpServers` format READMEs use). */
    importJson(text: string): Promise<McpImportResult>
    /** Other apps' configs on this Mac that list MCP servers. */
    importSources(): Promise<McpImportSource[]>
    /** Copy the servers from one of those configs. */
    importFrom(id: McpImportSource['id']): Promise<McpImportResult>
  }
  debug: {
    /** Open (or focus) the debugger window, showing this conversation. */
    open(conversationId: ID | null): Promise<void>
    list(conversationId: ID | null): Promise<TraceSummary[]>
    get(id: string): Promise<TraceDetail | null>
    clear(conversationId: ID | null): Promise<void>
    exportTraces(conversationId: ID | null): Promise<boolean>
    /**
     * Re-send an edited request (non-streaming) to the endpoint the trace went to: `model` is the trace's model key, and
     * `endpointName` the endpoint's name when recorded (for the message when it's gone). Recorded as a 'replay' trace;
     * nothing is added to the chat.
     */
    replay(conversationId: ID | null, model: string | null, body: unknown, endpointName?: string | null): Promise<TraceDetail>
    inspectApp(): Promise<void>
  }
  events: {
    onChat(cb: (e: ChatEvent) => void): () => void
    onTrace(cb: (e: TraceEvent) => void): () => void
    onDebugFocus(cb: (conversationId: ID | null) => void): () => void
    onSkillsChanged(cb: () => void): () => void
    onMenu(cb: (action: string) => void): () => void
    onMcp(cb: (statuses: McpStatus[]) => void): () => void
    /** An endpoint that was still pending in models.list has answered, or failed. */
    onModels(cb: (update: ModelListUpdate) => void): () => void
  }
  files: {
    /** Resolve a dropped File to its on-disk path (empty for pasted data). */
    pathFor(file: File): string
  }
}

/** Channel names for the invoke-style methods, derived from the API shape. */
export const INVOKE_CHANNELS = {
  app: ['info', 'setNativeTheme', 'openExternal', 'openDataFolder', 'migrationNotice', 'dismissMigrationNotice'],
  settings: ['get', 'update', 'setApiKey'],
  models: ['list', 'info', 'setOverrides', 'redetect'],
  endpoints: ['list', 'probe', 'add', 'update', 'removalImpact', 'remove', 'setKey'],
  projects: ['list', 'get', 'create', 'update', 'delete', 'files', 'addFiles', 'removeFile', 'moveFile', 'openFile', 'revealFile'],
  conversations: ['list', 'get', 'update', 'delete', 'search'],
  chat: ['send', 'regenerate', 'edit', 'stop', 'compact', 'decide', 'answer'],
  attachments: ['ingest', 'pick', 'remove'],
  artifacts: ['list', 'stage', 'save', 'createFromBlock'],
  skills: ['list', 'get', 'save', 'delete', 'duplicate', 'setEnabled', 'reveal'],
  themes: ['list', 'save', 'delete', 'exportTheme', 'importTheme'],
  usage: ['account', 'summary', 'raw', 'prices', 'refreshPrices'],
  debug: ['open', 'list', 'get', 'clear', 'exportTraces', 'replay', 'inspectApp'],
  links: ['preview'],
  runner: ['status', 'packages', 'resetEnvironment', 'openFile', 'revealFile', 'saveFile'],
  code: ['pickFolder', 'create', 'recentRoots', 'locate', 'status', 'reveal', 'changes', 'diff'],
  mcp: ['list', 'save', 'remove', 'status', 'connect', 'restart', 'log', 'setToolPolicy', 'importJson', 'importSources', 'importFrom']
} as const satisfies { [G in Exclude<keyof OllmostApi, 'events' | 'files'>]: ReadonlyArray<keyof OllmostApi[G]> }

export const EVENT_CHANNELS = {
  chat: 'event:chat',
  skills: 'event:skills',
  menu: 'event:menu',
  trace: 'event:trace',
  debugFocus: 'event:debug-focus',
  mcp: 'event:mcp',
  models: 'event:models'
} as const

export type TraceEvent = { type: 'upsert'; trace: TraceSummary } | { type: 'cleared'; conversationId: ID | null }
