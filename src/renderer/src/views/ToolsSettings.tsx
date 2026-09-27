import { ChevronRight, ClipboardPaste, Download, Plus, RotateCcw, ScrollText, Trash2, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { CodeNetwork, McpImportResult, McpImportSource, McpServer, McpStatus, RunnerStatus, Settings, ToolPolicy } from '@shared/types'
import { Button, Field, Modal, Switch, TextArea, TextField, Tooltip } from '@/components/ui'
import { api } from '@/lib/api'
import { cn } from '@/lib/format'
import { reportError, useApp } from '@/stores/app'
import { Row, Section, Segmented } from './settingsParts'

const DOT: Record<McpStatus['state'], string> = {
  ready: 'bg-success',
  starting: 'bg-warn animate-pulse',
  error: 'bg-danger',
  stopped: 'bg-subtle'
}

const POLICIES: Array<{ value: ToolPolicy; label: string }> = [
  { value: 'ask', label: 'Ask' },
  { value: 'allow', label: 'Always allow' },
  { value: 'off', label: 'Off' }
]

const policyOf = (server: McpServer, tool: string): ToolPolicy => server.tools[tool] ?? 'ask'

const tokens = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}K` : String(n))

function stateText(server: McpServer, status: McpStatus | undefined): string {
  if (server.missingEnv.length)
    return `Needs ${server.missingEnv.join(', ')} again: Ollmost couldn't read the saved values. Edit the server to enter them.`
  if (!status || status.state === 'stopped') return 'Not running. It starts when a chat uses it.'
  if (status.state === 'starting') return 'Starting…'
  if (status.state === 'error') return status.error ?? "Couldn't start."
  const offered = status.tools.filter((t) => policyOf(server, t.name) !== 'off')
  const cost = offered.reduce((sum, t) => sum + t.tokens, 0)
  const off = status.tools.length - offered.length
  return `Running · ${offered.length} ${offered.length === 1 ? 'tool' : 'tools'}${off ? ` (${off} off)` : ''} · about ${tokens(cost)} tokens per request`
}

const commandLine = (s: McpServer) => [s.command, ...s.args.map((a) => (/\s/.test(a) ? JSON.stringify(a) : a))].join(' ')

function ServerRow({ server, status, onEdit }: { server: McpServer; status: McpStatus | undefined; onEdit: () => void }) {
  const [log, setLog] = useState<string[] | null>(null)
  const [confirming, setConfirming] = useState(false)
  const [showTools, setShowTools] = useState(false)
  const loadMcp = useApp((s) => s.loadMcp)
  const state = server.missingEnv.length ? 'error' : (status?.state ?? 'stopped')
  const tools = status?.tools ?? []

  const setPolicy = async (tool: string, policy: ToolPolicy) => {
    try {
      await api.mcp.setToolPolicy(server.id, tool, policy)
      await loadMcp()
    } catch (err) {
      reportError(err)
    }
  }
  const setDefaultOn = async (defaultOn: boolean) => {
    try {
      const { id, name, command, args, cwd } = server
      await api.mcp.save({ id, name, command, args, cwd, env: {}, defaultOn })
      await loadMcp()
    } catch (err) {
      reportError(err)
    }
  }

  const showLog = async () => {
    if (log) return setLog(null)
    try {
      setLog(await api.mcp.log(server.id))
    } catch (err) {
      reportError(err)
    }
  }
  const remove = async () => {
    try {
      await api.mcp.remove(server.id)
      await loadMcp()
    } catch (err) {
      reportError(err)
    }
  }

  return (
    <div data-testid="mcp-server" className="rounded-ollmost border border-line p-3">
      <div className="flex items-start gap-3">
        <span className={cn('mt-1.5 size-2 shrink-0 rounded-full', DOT[state])} aria-label={state} />
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium">{server.name}</div>
          <div className="truncate font-mono text-xs text-subtle">{commandLine(server)}</div>
          <div className={cn('mt-1 text-xs', state === 'error' ? 'text-danger' : 'text-muted')}>{stateText(server, status)}</div>
        </div>
        <div className="flex shrink-0 gap-1">
          <Tooltip content="Restart">
            <Button
              size="sm"
              variant="ghost"
              aria-label={`Restart ${server.name}`}
              onClick={() => void api.mcp.restart(server.id).catch(reportError)}
            >
              <RotateCcw className="size-3.5" />
            </Button>
          </Tooltip>
          <Tooltip content={log ? 'Hide log' : 'Show what the server logged'}>
            <Button size="sm" variant="ghost" aria-label={`Log for ${server.name}`} onClick={() => void showLog()}>
              <ScrollText className="size-3.5" />
            </Button>
          </Tooltip>
          <Button size="sm" variant="ghost" onClick={onEdit}>
            Edit
          </Button>
          {confirming ? (
            <Button size="sm" variant="danger" onClick={() => void remove()} onBlur={() => setConfirming(false)} autoFocus>
              Remove
            </Button>
          ) : (
            <Button size="sm" variant="ghost" aria-label={`Remove ${server.name}`} onClick={() => setConfirming(true)}>
              <Trash2 className="size-3.5" />
            </Button>
          )}
        </div>
      </div>
      <div className="mt-2 flex items-center justify-between gap-4 pl-5">
        <button
          onClick={() => setShowTools(!showTools)}
          disabled={!tools.length}
          aria-expanded={showTools}
          className="flex items-center gap-1 text-xs text-muted hover:text-fg disabled:opacity-50 disabled:hover:text-muted"
        >
          <ChevronRight className={cn('size-3.5 transition-transform', showTools && 'rotate-90')} />
          {tools.length ? `Tools (${tools.length})` : 'Tools appear once it has started'}
        </button>
        <label className="flex items-center gap-2 text-xs text-muted">
          Use in new chats
          <Switch checked={server.defaultOn} onChange={(on) => void setDefaultOn(on)} />
        </label>
      </div>
      {showTools && (
        <ul className="mt-2 divide-y divide-line rounded-md border border-line">
          {tools.map((t) => (
            <li key={t.name} data-testid="mcp-tool" className="flex items-start gap-3 px-3 py-2">
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline gap-2">
                  <span className="font-mono text-xs text-fg">{t.name}</span>
                  <span className="text-[11px] text-subtle">~{tokens(t.tokens)} tokens</span>
                </div>
                {(t.title || t.description) && <div className="mt-0.5 line-clamp-2 text-xs text-muted">{t.description || t.title}</div>}
                {server.changed?.includes(t.name) && (
                  <div data-testid="mcp-tool-changed" className="mt-0.5 text-xs text-warn">
                    The server changed this tool's description or inputs since you allowed it, so it asks again.
                  </div>
                )}
              </div>
              <Segmented
                size="sm"
                label={`${t.name}: when the model uses it`}
                value={policyOf(server, t.name)}
                options={POLICIES}
                onChange={(policy) => void setPolicy(t.name, policy)}
              />
            </li>
          ))}
        </ul>
      )}
      {log && (
        <pre className="selectable mt-3 max-h-60 overflow-auto whitespace-pre-wrap break-words rounded-md border border-line bg-code p-2 font-mono text-[11px] text-muted">
          {log.length ? log.join('\n') : 'Nothing written to stderr yet.'}
        </pre>
      )}
    </div>
  )
}

/** Paste a README's JSON snippet, or copy the servers from Claude Desktop or Claude Code. */
function ImportDialog({ source, onClose }: { source: McpImportSource | 'paste'; onClose: () => void }) {
  const loadMcp = useApp((s) => s.loadMcp)
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<McpImportResult | null>(null)
  const paste = source === 'paste'

  const run = async () => {
    setBusy(true)
    try {
      setResult(paste ? await api.mcp.importJson(text) : await api.mcp.importFrom(source.id))
      await loadMcp()
    } catch (err) {
      reportError(err)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      open
      onOpenChange={(open) => !open && onClose()}
      title={paste ? 'Paste MCP server JSON' : `Import from ${source.label}`}
      description={
        paste
          ? 'The snippet from a server’s README, like {"mcpServers": {"name": {"command": "npx", "args": [...]}}}.'
          : `Copies the local servers in ${source.path} into Ollmost. It’s a one-time copy: later changes there don’t reach Ollmost.`
      }
      wide
      footer={
        result ? (
          <Button variant="primary" onClick={onClose}>
            Done
          </Button>
        ) : (
          <>
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button variant="primary" loading={busy} disabled={paste && !text.trim()} onClick={() => void run()}>
              {paste ? 'Add servers' : 'Import'}
            </Button>
          </>
        )
      }
    >
      {result ? (
        <div className="space-y-2 text-sm" data-testid="import-result">
          <div>
            {result.added.length ? `Added ${result.added.map((s) => s.name).join(', ')}.` : 'No servers were added.'}{' '}
            {result.added.length > 0 && !paste && 'They start switched off for new chats, and every tool asks before it runs.'}
          </div>
          {result.skipped.length > 0 && (
            <div className="space-y-0.5 text-xs text-muted">
              <div>Left out:</div>
              {result.skipped.map((line) => (
                <div key={line}>{line}</div>
              ))}
            </div>
          )}
        </div>
      ) : paste ? (
        <TextArea
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={10}
          autoFocus
          aria-label="Server JSON"
          placeholder={
            '{\n  "mcpServers": {\n    "filesystem": {\n      "command": "npx",\n      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/Users/you/Desktop"]\n    }\n  }\n}'
          }
          className="font-mono text-[12px]"
        />
      ) : (
        <div className="space-y-2 text-sm">
          <div>
            {source.servers.length} local {source.servers.length === 1 ? 'server' : 'servers'}: {source.servers.join(', ')}.
          </div>
          {source.unsupported > 0 && (
            <div className="text-xs text-muted">
              {source.unsupported} remote {source.unsupported === 1 ? 'server is' : 'servers are'} left out: Ollmost runs local servers
              only.
            </div>
          )}
          <div className="text-xs text-muted">
            Their environment variables are copied too, and stored encrypted with your Mac&apos;s keychain. Servers whose names Ollmost
            already has are skipped. Imported servers start switched off for new chats.
          </div>
        </div>
      )}
    </Modal>
  )
}

interface EnvRow {
  key: string
  value: string
  /** Stored, but its value can't be read: it must be entered again. */
  missing?: boolean
  /** Stored already: its value isn't shown, only kept, replaced or removed. */
  saved: boolean
  removed?: boolean
}

function ServerDialog({ server, onClose }: { server: McpServer | null; onClose: () => void }) {
  const loadMcp = useApp((s) => s.loadMcp)
  const [name, setName] = useState(server?.name ?? '')
  const [command, setCommand] = useState(server?.command ?? '')
  const [args, setArgs] = useState(server?.args.join('\n') ?? '')
  const [cwd, setCwd] = useState(server?.cwd ?? '')
  const [defaultOn, setDefaultOn] = useState(server?.defaultOn ?? true)
  const [env, setEnv] = useState<EnvRow[]>(
    server?.envKeys.map((key) => ({ key, value: '', saved: true, missing: server.missingEnv.includes(key) })) ?? []
  )
  const [saving, setSaving] = useState(false)

  const setRow = (i: number, patch: Partial<EnvRow>) => setEnv(env.map((r, j) => (j === i ? { ...r, ...patch } : r)))

  const save = async () => {
    setSaving(true)
    try {
      const values: Record<string, string | null> = {}
      for (const r of env) {
        const key = r.key.trim()
        if (!key) continue
        if (r.removed) values[key] = null
        else if (!r.saved || r.value) values[key] = r.value
      }
      await api.mcp.save({
        id: server?.id,
        name,
        command,
        args: args.split('\n'),
        cwd: cwd.trim() || null,
        env: values,
        defaultOn
      })
      await loadMcp()
      onClose()
    } catch (err) {
      reportError(err)
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal
      open
      onOpenChange={(open) => !open && onClose()}
      title={server ? `Edit ${server.name}` : 'Add an MCP server'}
      description="A local server Ollmost starts with a command, like the ones in an MCP server's README."
      wide
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" loading={saving} onClick={() => void save()}>
            {server ? 'Save' : 'Add server'}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Field label="Name">
          <TextField value={name} onChange={(e) => setName(e.target.value)} placeholder="Filesystem" autoFocus />
        </Field>
        <Field label="Command" hint="Found on your login shell's PATH, as in Terminal.">
          <TextField value={command} onChange={(e) => setCommand(e.target.value)} placeholder="npx" className="font-mono" />
        </Field>
        <Field label="Arguments" hint="One per line.">
          <TextArea
            value={args}
            onChange={(e) => setArgs(e.target.value)}
            rows={3}
            placeholder={'-y\n@modelcontextprotocol/server-filesystem\n/Users/you/Desktop'}
            className="font-mono text-[13px]"
          />
        </Field>
        <div className="space-y-1.5">
          <div className="text-sm font-medium">Environment variables</div>
          {env.map((r, i) => (
            <div key={i} className="flex items-center gap-2">
              <TextField
                value={r.key}
                readOnly={r.saved}
                onChange={(e) => setRow(i, { key: e.target.value })}
                placeholder="NAME"
                aria-label="Variable name"
                className={cn('w-48 font-mono text-[13px]', r.removed && 'line-through opacity-60')}
              />
              <TextField
                value={r.value}
                type="password"
                disabled={r.removed}
                onChange={(e) => setRow(i, { value: e.target.value })}
                placeholder={r.missing ? 'Enter again' : r.saved ? 'Saved (leave blank to keep)' : 'value'}
                aria-label={`Value of ${r.key || 'variable'}`}
                className="flex-1 font-mono text-[13px]"
              />
              <Button
                size="sm"
                variant="ghost"
                aria-label={r.removed ? `Keep ${r.key}` : `Remove ${r.key || 'variable'}`}
                onClick={() => (r.saved ? setRow(i, { removed: !r.removed }) : setEnv(env.filter((_, j) => j !== i)))}
              >
                {r.removed ? <RotateCcw className="size-3.5" /> : <X className="size-3.5" />}
              </Button>
            </div>
          ))}
          <Button size="sm" variant="ghost" onClick={() => setEnv([...env, { key: '', value: '', saved: false }])}>
            <Plus className="size-3.5" /> Add variable
          </Button>
          <div className="text-xs text-subtle">Values are stored encrypted with your Mac's keychain and never shown again.</div>
        </div>
        <Field label="Working folder" hint="Optional. Defaults to your home folder.">
          <TextField value={cwd} onChange={(e) => setCwd(e.target.value)} placeholder="~" className="font-mono text-[13px]" />
        </Field>
        <Row label="Use in new chats" hint="You can switch servers on and off per chat in the + menu, under Tools.">
          <Switch checked={defaultOn} onChange={setDefaultOn} />
        </Row>
      </div>
    </Modal>
  )
}

const RUNNER_MODES: Array<{ value: Settings['runner']['mode']; label: string }> = [
  { value: 'off', label: 'Off' },
  { value: 'ask', label: 'Ask each time' },
  { value: 'allow', label: 'Always allow' }
]
const LIMITS = [30, 120, 300, 600].map((sec) => ({ value: String(sec), label: sec < 60 ? `${sec} s` : `${sec / 60} min` }))

function RunnerSection() {
  const { settings, updateSettings } = useApp()
  const [status, setStatus] = useState<RunnerStatus | null>(null)
  const [packages, setPackages] = useState<Array<{ name: string; version: string }> | null>(null)
  const [showPackages, setShowPackages] = useState(false)
  const refresh = () => {
    void api.runner.status().then(setStatus).catch(reportError)
    void api.runner.packages().then(setPackages).catch(reportError)
  }
  useEffect(refresh, [])
  if (!settings) return null
  const r = settings.runner
  const update = (patch: Partial<Settings['runner']>) => void updateSettings({ runner: patch })

  return (
    <Section
      title="Code runner"
      description="Lets models run Python and bash to calculate, analyse data, make charts and create files, and lets skills run their scripts. Code runs in a macOS sandbox, in a folder of its own for each chat: it can't see your other files, and it has no network access unless you allow PyPI below."
    >
      <div data-testid="runner-status" className={cn('text-xs', status && !status.available ? 'text-danger' : 'text-muted')}>
        {!status
          ? 'Checking…'
          : status.available
            ? `Ready: Python ${status.python?.version} (${status.python?.path}), sandboxed.`
            : status.reason}
      </div>
      <Row label="When a model wants to run code">
        <Segmented label="When a model wants to run code" value={r.mode} options={RUNNER_MODES} onChange={(mode) => update({ mode })} />
      </Row>
      <Row label="Use in new chats" hint="Switch it on or off per chat in the + menu, under Tools.">
        <Switch checked={r.defaultOn} onChange={(defaultOn) => update({ defaultOn })} />
      </Row>
      <Row
        label="Let code download Python packages from PyPI"
        hint="Only pypi.org and files.pythonhosted.org. Each chat installs into its own Python environment, so code in one chat can't change what runs in another. Needed by skills that use packages like python-docx."
      >
        <Switch checked={r.pypi} onChange={(pypi) => update({ pypi })} />
      </Row>
      <Row label="Time limit per run">
        <Segmented
          label="Time limit per run"
          value={String(r.timeoutSec)}
          options={LIMITS}
          onChange={(v) => update({ timeoutSec: Number(v) })}
        />
      </Row>
      <Row
        label="Ollmost's Python environments"
        hint={
          status?.venvExists
            ? `${packages?.length ?? 0} packages installed across your chats. Resetting deletes them; each chat's next run starts a fresh environment.`
            : 'Made the first time code runs.'
        }
      >
        <div className="flex gap-2">
          {!!packages?.length && (
            <Button size="sm" variant="ghost" onClick={() => setShowPackages(!showPackages)}>
              {showPackages ? 'Hide packages' : 'Show packages'}
            </Button>
          )}
          <Button
            size="sm"
            disabled={!status?.venvExists}
            onClick={() => void api.runner.resetEnvironment().then(refresh).catch(reportError)}
          >
            Reset
          </Button>
        </div>
      </Row>
      {showPackages && packages && (
        <div className="selectable max-h-48 overflow-auto rounded-md border border-line bg-code p-2 font-mono text-[11px] text-muted">
          {packages.map((p) => (
            <div key={p.name}>
              {p.name} {p.version}
            </div>
          ))}
        </div>
      )}
    </Section>
  )
}

const ASK_ALLOW: Array<{ value: 'ask' | 'allow'; label: string }> = [
  { value: 'ask', label: 'Ask each time' },
  { value: 'allow', label: 'Always allow' }
]
const COMMAND_LIMITS = [60, 300, 600, 1800].map((sec) => ({ value: String(sec), label: sec < 300 ? `${sec} s` : `${sec / 60} min` }))
const ROUNDS = [30, 60, 100].map((n) => ({ value: String(n), label: String(n) }))
/** The three network presets, with the labels this settings page shows; also used by CodeSessionView's chip. */
export const NETWORKS: Array<{ value: CodeNetwork; label: string }> = [
  { value: 'none', label: 'None' },
  { value: 'registries', label: 'Package registries' },
  { value: 'registries-git', label: 'Registries + git hosts' }
]

/** A short form of each preset's label, for CodeSessionView's compact chip. */
export const NETWORK_SHORT_LABEL: Record<CodeNetwork, string> = {
  none: 'No network',
  registries: 'Registries',
  'registries-git': 'Registries + git'
}

function CodeSessionsSection() {
  const { settings, updateSettings } = useApp()
  const [status, setStatus] = useState<RunnerStatus | null>(null)
  useEffect(() => {
    void api.runner.status().then(setStatus).catch(reportError)
  }, [])
  if (!settings) return null
  const c = settings.code
  const update = (patch: Partial<Settings['code']>) => void updateSettings({ code: patch })

  return (
    <Section
      title="Code sessions"
      description="Lets a model work in a folder you choose: reading files, editing them and running commands, in the same macOS sandbox as the code runner. It can read that folder, the system and your toolchains (nvm, cargo, pyenv and the like) but not the rest of your home folder; it writes only to that folder and a scratch folder of its own; and it has no network access unless a session's preset allows package registries, or those and git hosts."
    >
      <div data-testid="code-status" className={cn('text-xs', status && !status.available ? 'text-danger' : 'text-muted')}>
        {!status
          ? 'Checking…'
          : status.available
            ? "Ready: commands run in the sandbox; edits and reads are Ollmost's own."
            : status.reason}
      </div>
      <Row label="When a model wants to run a command">
        <Segmented
          label="When a model wants to run a command"
          value={c.commands}
          options={ASK_ALLOW}
          onChange={(commands) => update({ commands })}
        />
      </Row>
      <Row label="When a model wants to edit a file">
        <Segmented label="When a model wants to edit a file" value={c.edits} options={ASK_ALLOW} onChange={(edits) => update({ edits })} />
      </Row>
      <Row label="Time limit per command">
        <Segmented
          label="Time limit per command"
          value={String(c.timeoutSec)}
          options={COMMAND_LIMITS}
          onChange={(v) => update({ timeoutSec: Number(v) })}
        />
      </Row>
      <Row label="Tool calls per reply" hint="A reply stops after this many and offers Continue.">
        <Segmented
          label="Tool calls per reply"
          value={String(c.maxRounds)}
          options={ROUNDS}
          onChange={(v) => update({ maxRounds: Number(v) })}
        />
      </Row>
      <Row label="Network for new sessions" hint="Registries + git hosts is the only preset that can send data out of your Mac.">
        <Segmented
          label="Network for new sessions"
          value={c.defaultNetwork}
          options={NETWORKS}
          onChange={(defaultNetwork) => update({ defaultNetwork })}
        />
      </Row>
    </Section>
  )
}

export function ToolsTab() {
  const { mcpServers, mcpStatus, loadMcp } = useApp()
  const [editing, setEditing] = useState<McpServer | 'new' | null>(null)
  const [importing, setImporting] = useState<McpImportSource | 'paste' | null>(null)
  const [sources, setSources] = useState<McpImportSource[]>([])
  useEffect(() => {
    void loadMcp()
    void api.mcp.importSources().then(setSources).catch(reportError)
  }, [loadMcp])

  return (
    <>
      <RunnerSection />
      <CodeSessionsSection />
      <Section
        title="MCP servers"
        description="Local servers that give models more tools: files, notes, calendars, developer tools. Ollmost starts them on this Mac when a chat uses them. They run with your permissions and aren't sandboxed, so add only servers you trust. Models ask before using a tool."
      >
        {mcpServers.length === 0 && <p className="text-sm text-muted">No servers yet.</p>}
        {mcpServers.map((s) => (
          <ServerRow key={s.id} server={s} status={mcpStatus.find((x) => x.id === s.id)} onEdit={() => setEditing(s)} />
        ))}
        <div className="flex flex-wrap gap-2">
          <Button size="sm" onClick={() => setEditing('new')}>
            <Plus className="size-3.5" /> Add server
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setImporting('paste')}>
            <ClipboardPaste className="size-3.5" /> Paste JSON
          </Button>
          {sources.map((src) => (
            <Button key={src.id} size="sm" variant="ghost" onClick={() => setImporting(src)}>
              <Download className="size-3.5" /> Import from {src.label}
            </Button>
          ))}
        </div>
      </Section>
      {editing && <ServerDialog server={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />}
      {importing && <ImportDialog source={importing} onClose={() => setImporting(null)} />}
    </>
  )
}
