import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { safeStorage } from 'electron'
import { type ImportedServer, parseServersJson } from '@shared/mcpImport'
import type { McpImportResult, McpImportSource, McpServer, McpServerInput, ToolPolicy } from '@shared/types'
import { mcpAllowKey } from '@shared/toolAllow'
import { anyChatAllows, forgetAllowKeyInChats, forgetServerInChats } from '../db/conversations'
import { readSetting, writeSetting } from '../db/kv'
import { testOverride } from '../testOverrides'

// MCP server definitions live in the settings table under their own key, not in Settings: their environment often
// holds tokens (a GitHub PAT, an API key), so it's encrypted with the OS keychain like the ollama.com key, and only
// the variable names ever reach the renderer.

interface StoredServer extends Omit<McpServer, 'envKeys' | 'missingEnv'> {
  /** The environment as JSON, encrypted with safeStorage and base64-encoded; null when there is none. */
  env: string | null
  envKeys: string[]
  /**
   * Each trusted tool's fingerprint (description, input schema…) from when it was trusted: set to Always allow, or
   * allowed for a chat. A server that changes a tool after that loses the trust (#64).
   */
  trusted?: Record<string, string>
}

/** A server as Ollmost starts it: the stored definition with its environment decrypted. */
export interface ServerConfig extends McpServer {
  env: Record<string, string>
}

const KEY = 'mcpServers'
// Ids of servers that were removed. They're never given out again: chats name servers by id (their tool sources and
// "Allow for this chat" answers), so a new server that reused one could inherit trust given to a different program.
const RETIRED_KEY = 'mcpRetiredIds'

// Read on every tool lookup during a reply, so kept in memory; every write goes through store().
let cache: StoredServer[] | null = null
const stored = (): StoredServer[] => (cache ??= readSetting<StoredServer[]>(KEY, []))
const store = (servers: StoredServer[]) => {
  writeSetting(KEY, servers)
  cache = servers
}

/** The stored environment, or null when it can't be decrypted (the keychain entry that encrypted it is gone). */
function decryptEnv(enc: string | null): Record<string, string> | null {
  if (!enc) return {}
  try {
    const env = JSON.parse(safeStorage.decryptString(Buffer.from(enc, 'base64'))) as unknown
    return env && typeof env === 'object' && !Array.isArray(env) ? (env as Record<string, string>) : null
  } catch {
    return null
  }
}

/** Variables without a readable value. */
const missingEnv = (s: StoredServer, env = decryptEnv(s.env)): string[] => s.envKeys.filter((k) => !env || !(k in env))

const publicView = (s: StoredServer, env = decryptEnv(s.env)): McpServer => {
  const { env: _env, trusted: _trusted, ...server } = s
  return { ...server, missingEnv: missingEnv(s, env) }
}

function encryptEnv(env: Record<string, string>): string | null {
  if (!Object.keys(env).length) return null
  if (!safeStorage.isEncryptionAvailable())
    throw new Error("OS encryption is unavailable, so Ollmost can't store this server's environment.")
  return safeStorage.encryptString(JSON.stringify(env)).toString('base64')
}

/**
 * A server id from its name, used as the prefix of its tool names: lowercase letters, digits and single underscores
 * (so it never contains the `__` that separates it from the tool name), unique among `taken`.
 */
export function serverId(name: string, taken: string[]): string {
  const base =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 24)
      .replace(/_+$/, '') || 'server'
  let id = base
  for (let n = 2; taken.includes(id); n++) id = `${base}_${n}`
  return id
}

export function listServers(): McpServer[] {
  return stored().map((s) => publicView(s))
}

export function getServer(id: string): McpServer | null {
  const s = stored().find((x) => x.id === id)
  return s ? publicView(s) : null
}

export function getServerConfig(id: string): ServerConfig | null {
  const s = stored().find((x) => x.id === id)
  if (!s) return null
  const env = decryptEnv(s.env)
  return { ...publicView(s, env), env: env ?? {} }
}

function validate(input: McpServerInput): void {
  if (!input.name.trim()) throw new Error('Give the server a name.')
  if (!input.command.trim()) throw new Error('Enter the command that starts the server (for example npx or uvx).')
  for (const key of Object.keys(input.env))
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new Error(`"${key}" isn't a valid environment variable name.`)
}

/**
 * Whether an edit changes what the server is: its command, arguments or folder, or any environment value (a new token
 * can switch the account behind the same program). The same edits restart a running server (mcp.save in ipc.ts).
 */
export const changesServer = (
  before: Pick<McpServer, 'command' | 'args' | 'cwd'>,
  after: Pick<McpServer, 'command' | 'args' | 'cwd'>,
  envEdits: Record<string, unknown>
): boolean =>
  before.command !== after.command ||
  JSON.stringify(before.args) !== JSON.stringify(after.args) ||
  before.cwd !== after.cwd ||
  Object.keys(envEdits).length > 0

/**
 * Add a server, or update one (its id stays the same). Returns the saved server. An edit that changes what the server
 * is resets its per-tool settings to Ask and forgets chats' "Allow for this chat" answers for it: those were given to
 * the old program or account.
 */
export function saveServer(input: McpServerInput): McpServer {
  validate(input)
  const servers = stored()
  const existing = input.id ? servers.find((s) => s.id === input.id) : undefined
  if (input.id && !existing) throw new Error('That MCP server no longer exists.')
  const command = input.command.trim()
  const args = input.args.map((a) => a.trim()).filter(Boolean)
  const cwd = input.cwd?.trim() || null
  const replaced = !!existing && changesServer(existing, { command, args, cwd }, input.env)
  const readable = existing ? decryptEnv(existing.env) : {}
  const env: Record<string, string> = { ...(readable ?? {}) }
  for (const [key, value] of Object.entries(input.env)) {
    if (value === null) delete env[key]
    else env[key] = value
  }
  // Values that couldn't be read and weren't entered again (or removed) stay listed, so the server stays locked
  // rather than losing them or starting without them.
  const unread = existing ? missingEnv(existing, readable).filter((k) => !(k in input.env)) : []
  const next: StoredServer = {
    id: existing?.id ?? serverId(input.name, [...servers.map((s) => s.id), ...retiredIds()]),
    name: input.name.trim(),
    command,
    args,
    cwd,
    env: encryptEnv(env),
    envKeys: [...new Set([...Object.keys(env), ...unread])].sort(),
    defaultOn: input.defaultOn,
    tools: replaced ? {} : (existing?.tools ?? {}),
    trusted: replaced ? {} : (existing?.trusted ?? {}),
    changed: replaced ? [] : (existing?.changed ?? [])
  }
  store(existing ? servers.map((s) => (s.id === next.id ? next : s)) : [...servers, next])
  if (replaced) forgetServerInChats(next.id, { source: false })
  return publicView(next)
}

/**
 * Forget every server's environment values, keeping the variable names, and return the ids of servers that had any.
 * For values that can no longer be read (#60): each of those servers then asks for them again.
 */
export function forgetEnvValues(): string[] {
  const servers = stored()
  const had = servers.filter((s) => s.env !== null).map((s) => s.id)
  if (had.length) store(servers.map((s) => (s.env === null ? s : { ...s, env: null })))
  return had
}

const retiredIds = (): string[] => readSetting<string[]>(RETIRED_KEY, [])

/** Remove a server. Its id is retired, and chats forget it (their switch for it and what they allowed). */
export function removeServer(id: string): void {
  const servers = stored()
  if (!servers.some((s) => s.id === id)) return
  store(servers.filter((s) => s.id !== id))
  writeSetting(RETIRED_KEY, [...new Set([...retiredIds(), id])])
  forgetServerInChats(id, { source: true })
}

/** How one of a server's tools is offered (Ask when never set). */
export function toolPolicy(server: McpServer, tool: string): ToolPolicy {
  return server.tools[tool] ?? 'ask'
}

/**
 * Set how a tool is offered. `fingerprint` is the tool as it is now (toolFingerprint in manager.ts): Always allow
 * trusts that version of it. Setting a policy also clears the tool's "changed" mark: you've looked at it again.
 */
export function setToolPolicy(id: string, tool: string, policy: ToolPolicy, fingerprint?: string | null): McpServer {
  const servers = stored()
  const server = servers.find((s) => s.id === id)
  if (!server) throw new Error('That MCP server no longer exists.')
  const tools = { ...server.tools }
  if (policy === 'ask') delete tools[tool]
  else tools[tool] = policy
  const trusted = { ...server.trusted }
  if (policy === 'allow' && fingerprint) trusted[tool] = fingerprint
  const next = { ...server, tools, trusted, changed: (server.changed ?? []).filter((t) => t !== tool) }
  store(servers.map((s) => (s.id === id ? next : s)))
  return publicView(next)
}

/** Record a tool as trusted in the version it is now (a chat allowed it). */
export function recordTrust(id: string, tool: string, fingerprint: string): void {
  const servers = stored()
  const server = servers.find((s) => s.id === id)
  if (!server || server.trusted?.[tool] === fingerprint) return
  const next = { ...server, trusted: { ...server.trusted, [tool]: fingerprint } }
  store(servers.map((s) => (s.id === id ? next : s)))
}

/**
 * Check a server's tools, as it lists them now, against the versions that were trusted. A trusted tool whose
 * fingerprint changed goes back to Ask: Always allow is cleared, chats forget "Allow for this chat" for it, and it's
 * marked as changed for Settings. A trusted tool with no fingerprint yet (Always allow, or allowed in some chat, before
 * fingerprints were kept) is recorded as it is. Returns the tools that went back to Ask.
 */
export function reviewTrust(id: string, current: ReadonlyMap<string, string>): string[] {
  const servers = stored()
  const server = servers.find((s) => s.id === id)
  if (!server) return []
  const tools = { ...server.tools }
  const trusted = { ...server.trusted }
  const reverted: string[] = []
  for (const [tool, fingerprint] of current) {
    const was = trusted[tool]
    if (was === undefined) {
      // Trust given before fingerprints were kept (Always allow, or a chat's answer): take the tool as it is now.
      if (tools[tool] === 'allow' || anyChatAllows(mcpAllowKey(id, tool))) trusted[tool] = fingerprint
      continue
    }
    if (was === fingerprint) continue
    delete trusted[tool]
    const allowed = tools[tool] === 'allow'
    if (allowed) delete tools[tool]
    const chats = forgetAllowKeyInChats(mcpAllowKey(id, tool))
    if (allowed || chats > 0) reverted.push(tool)
  }
  if (!reverted.length && JSON.stringify(trusted) === JSON.stringify(server.trusted ?? {})) return []
  const changed = [...new Set([...(server.changed ?? []), ...reverted])]
  store(servers.map((s) => (s.id === id ? { ...server, tools, trusted, changed } : s)))
  return reverted
}

// ---- Importing --------------------------------------------------------------

/**
 * Add servers read from JSON (pasted, or another app's config), skipping names Ollmost already has. Each gets every
 * tool on Ask; `defaultOn` decides whether new chats start with it.
 */
export function addImported(servers: ImportedServer[], defaultOn: boolean, skipped: string[] = []): McpImportResult {
  const added: McpServer[] = []
  const notes = [...skipped]
  for (const server of servers) {
    const taken = listServers().some((s) => s.name.toLowerCase() === server.name.toLowerCase())
    if (taken) {
      notes.push(`${server.name}: Ollmost already has a server with that name`)
      continue
    }
    try {
      added.push(saveServer({ ...server, defaultOn }))
    } catch (err) {
      notes.push(`${server.name}: ${(err as Error).message}`)
    }
  }
  return { added, skipped: notes }
}

/**
 * Other apps' MCP configs Ollmost can copy servers from. Tests point these elsewhere; the shipped app reads only the
 * usual places, since a config names commands to run (#137).
 */
const IMPORT_FILES: Array<{ id: McpImportSource['id']; label: string; path: () => string }> = [
  {
    id: 'claude-desktop',
    label: 'Claude Desktop',
    path: () =>
      testOverride('OLLMOST_CLAUDE_DESKTOP_CONFIG') ??
      join(homedir(), 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json')
  },
  // Claude Code keeps user-wide servers at the top level of ~/.claude.json (project ones are left alone).
  { id: 'claude-code', label: 'Claude Code', path: () => testOverride('OLLMOST_CLAUDE_CODE_CONFIG') ?? join(homedir(), '.claude.json') }
]

async function readImportFile(path: string) {
  if (!existsSync(path)) return null
  try {
    const data = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>
    // Only the servers: ~/.claude.json holds a lot else, and nothing else is read.
    return data.mcpServers && typeof data.mcpServers === 'object' ? parseServersJson(JSON.stringify({ mcpServers: data.mcpServers })) : null
  } catch {
    return null
  }
}

/** Configs on this Mac that list MCP servers, with how many Ollmost could add. */
export async function importSources(): Promise<McpImportSource[]> {
  const found = await Promise.all(
    IMPORT_FILES.map(async (f) => {
      const parsed = await readImportFile(f.path())
      if (!parsed || !(parsed.servers.length + parsed.skipped.length)) return null
      return { id: f.id, label: f.label, path: f.path(), servers: parsed.servers.map((s) => s.name), unsupported: parsed.skipped.length }
    })
  )
  return found.filter((f): f is McpImportSource => !!f)
}

/** Copy another app's servers into Ollmost (a one-time copy, not a link). They start switched off for new chats. */
export async function importFrom(id: McpImportSource['id']): Promise<McpImportResult> {
  const file = IMPORT_FILES.find((f) => f.id === id)
  const parsed = file ? await readImportFile(file.path()) : null
  if (!parsed) throw new Error('That config has no MCP servers to import.')
  return addImported(parsed.servers, false, parsed.skipped)
}
