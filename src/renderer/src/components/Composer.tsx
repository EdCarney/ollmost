import { ArrowUp, FileText, Paperclip, Plus, Sparkles, Square, SquareTerminal, Terminal, TriangleAlert, Wrench, X } from 'lucide-react'
import { type KeyboardEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { type Command, COMMANDS, parseCommand } from '@shared/commands'
import { normalizeThinkSetting } from '@shared/thinking'
import type { Conversation, FileSource, McpServer, McpStatus, Skill, ThinkSetting } from '@shared/types'
import { api } from '@/lib/api'
import { cn, formatTokens } from '@/lib/format'
import { findModel, reportError, thinkProfileFor, useApp } from '@/stores/app'
import { useChat } from '@/stores/chat'
import { EMPTY_DRAFT, type PendingFile, useDrafts } from '@/stores/drafts'
import { ModelPicker } from './ModelPicker'
import { ThinkingControl } from './ThinkingControl'
import { Menu, MenuCheckItem, MenuContent, MenuItem, MenuLabel, MenuSub, MenuTrigger, Spinner, Tooltip } from './ui'

export interface ComposerSubmit {
  content: string
  attachmentIds: string[]
  model: string
  think: ThinkSetting | null
  skills: string[]
  toolSources: string[]
}

const MCP = 'mcp:'
/** The code runner's tool source (see Conversation.toolSources). */
const CODE = 'code'

/** Model/think/skills/tools for this composer: persisted on the chat once it exists, drafted otherwise. */
function useComposerSettings(conversation: Conversation | null) {
  const { models, draftModel, draftThink, setDraftModel, setDraftThink, mcpServers, settings: appSettings } = useApp()
  const [draftSkills, setDraftSkills] = useState<string[]>([])
  // Null until changed: a new chat starts with the servers marked "on for new chats".
  const [draftSources, setDraftSources] = useState<string[] | null>(null)
  const runner = appSettings?.runner
  const defaultSources = useMemo(
    () => [
      ...(runner && runner.mode !== 'off' && runner.defaultOn ? [CODE] : []),
      ...mcpServers.filter((s) => s.defaultOn).map((s) => `${MCP}${s.id}`)
    ],
    [mcpServers, runner]
  )

  const persist = useCallback(
    async (patch: Partial<Pick<Conversation, 'model' | 'think' | 'skills' | 'toolSources'>>) => {
      if (!conversation) return
      try {
        useChat.getState().setConversation(await api.conversations.update(conversation.id, patch))
      } catch (err) {
        reportError(err)
      }
    },
    [conversation]
  )

  if (conversation) {
    const model = conversation.model ?? draftModel
    return {
      model,
      think: conversation.think,
      skills: conversation.skills,
      toolSources: conversation.toolSources,
      setModel: (name: string) => persist({ model: name, think: normalizeThinkSetting(thinkProfileFor(models, name), conversation.think) }),
      setThink: (think: ThinkSetting) => persist({ think }),
      setSkills: (skills: string[]) => persist({ skills }),
      setToolSources: (toolSources: string[]) => persist({ toolSources }),
      resetDraft: () => {}
    }
  }
  return {
    model: draftModel,
    think: draftThink,
    skills: draftSkills,
    toolSources: draftSources ?? defaultSources,
    setModel: setDraftModel,
    setThink: setDraftThink,
    setSkills: setDraftSkills,
    setToolSources: setDraftSources,
    resetDraft: () => {
      setDraftSkills([])
      setDraftSources(null)
    }
  }
}

/** A server's state, for the Tools menu. */
function serverState(status: McpStatus | undefined): string {
  if (!status || status.state === 'stopped') return 'Starts when you send'
  if (status.state === 'starting') return 'Starting…'
  if (status.state === 'error') return "Couldn't start. See Settings → Tools"
  return `${status.tools.length} ${status.tools.length === 1 ? 'tool' : 'tools'}`
}

async function toSources(files: File[]): Promise<FileSource[]> {
  return Promise.all(
    files.map(async (file) => {
      const path = api.files.pathFor(file)
      return path ? { path } : { name: file.name || 'pasted-image.png', mime: file.type, data: await file.arrayBuffer() }
    })
  )
}

const SLASH_RE = /(^|\s)\/([a-z0-9-]*)$/i

/** One row of the "/" picker. */
type SlashMatch = { kind: 'command'; command: Command } | { kind: 'skill'; skill: Skill }

interface Props {
  conversation: Conversation | null
  /**
   * Where the unsent draft is kept: the chat id in a chat (passed explicitly, since `conversation` is null
   * while the chat loads), "project:<id>" on a project page, or "new" on Home.
   */
  draftKey?: string
  streaming: boolean
  onSubmit: (input: ComposerSubmit) => Promise<boolean>
  /** A slash command sent (see src/shared/commands.ts): it runs once, never as a message. Absent where none can run yet. */
  onCommand?: (cmd: { name: string; args: string; model: string }) => Promise<boolean>
  onStop?: () => void
  placeholder?: string
  autoFocus?: boolean
  large?: boolean
  /** A code session already runs in its own sandbox, so it has no attachments or code-runner toggle. */
  mode?: 'chat' | 'code'
}

export function Composer({
  conversation,
  draftKey,
  streaming,
  onSubmit,
  onCommand,
  onStop,
  placeholder,
  autoFocus,
  large,
  mode = 'chat'
}: Props) {
  const { models, skills: allSkills, navigate, mcpServers, mcpStatus, settings: appSettings } = useApp()
  const runnerOn = !!appSettings && appSettings.runner.mode !== 'off'
  const chatMode = mode === 'chat'
  const settings = useComposerSettings(conversation)
  // Each chat keeps its own unsent text and files, so switching chats never carries them along.
  const key = draftKey ?? conversation?.id ?? 'new'
  const { text, pending } = useDrafts((s) => s.drafts[key]) ?? EMPTY_DRAFT
  const updateDraft = useDrafts((s) => s.update)
  const setText = useCallback((value: string) => updateDraft(key, (d) => ({ ...d, text: value })), [key, updateDraft])
  const setPending = useCallback(
    (fn: (list: PendingFile[]) => PendingFile[]) => updateDraft(key, (d) => ({ ...d, pending: fn(d.pending) })),
    [key, updateDraft]
  )
  const [dragging, setDragging] = useState(false)
  const [slash, setSlash] = useState<{ query: string; index: number } | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const textRef = useRef<HTMLTextAreaElement>(null)

  const model = findModel(models, settings.model)
  const profile = thinkProfileFor(models, settings.model)
  const enabledSkills = allSkills.filter((s) => s.enabled)
  const activeSkills = settings.skills.map((id) => allSkills.find((s) => s.id === id)).filter((s): s is Skill => !!s)
  const activeServers = settings.toolSources
    .map((src) => mcpServers.find((s) => `${MCP}${s.id}` === src))
    .filter((s): s is McpServer => !!s)
  const codeOn = runnerOn && settings.toolSources.includes(CODE)
  const toggleSource = (source: string, on: boolean) =>
    settings.setToolSources(on ? [...settings.toolSources, source] : settings.toolSources.filter((s) => s !== source))

  // Start the servers this chat uses now, so they're ready by the time a message is sent.
  const serverIds = activeServers.map((s) => s.id).join(',')
  useEffect(() => {
    if (serverIds) void api.mcp.connect(serverIds.split(',')).catch(reportError)
  }, [serverIds])

  const uploading = pending.some((p) => !p.attachment)
  const hasImages = pending.some((p) => p.attachment?.kind === 'image')
  const visionMissing = hasImages && model && !model.capabilities.includes('vision')
  const canSend = !!settings.model && !uploading && !submitting && (text.trim().length > 0 || pending.length > 0)

  // ---- attachments ----
  const addFiles = useCallback(
    async (sources: FileSource[], names: string[]) => {
      if (!sources.length) return
      const keys = names.map((n, i) => ({ key: `${Date.now()}-${i}-${n}`, name: n }))
      setPending((p) => [...p, ...keys.map((k) => ({ ...k, attachment: null }))])
      try {
        const { added, errors } = await api.attachments.ingest(sources)
        errors.forEach((e) => reportError(e))
        setPending((p) => {
          const rest = p.filter((x) => !keys.some((k) => k.key === x.key))
          return [...rest, ...added.map((a) => ({ key: a.id, name: a.name, attachment: a }))]
        })
      } catch (err) {
        reportError(err)
        setPending((p) => p.filter((x) => !keys.some((k) => k.key === x.key)))
      }
    },
    [setPending]
  )

  const addFileObjects = useCallback(
    async (files: File[]) =>
      addFiles(
        await toSources(files),
        files.map((f) => f.name || 'Pasted image')
      ),
    [addFiles]
  )

  const pickFiles = async () => {
    const sources = await api.attachments.pick()
    await addFiles(
      sources,
      sources.map((s) => ('path' in s ? s.path.split('/').pop()! : s.name))
    )
  }

  const removePending = (p: PendingFile) => {
    setPending((list) => list.filter((x) => x.key !== p.key))
    if (p.attachment) void api.attachments.remove(p.attachment.id)
  }

  // Drop files anywhere in the window (not for a code session, which has no attachments).
  useEffect(() => {
    if (!chatMode) return
    let depth = 0
    const hasFiles = (e: DragEvent) => e.dataTransfer?.types.includes('Files')
    const enter = (e: DragEvent) => {
      if (!hasFiles(e)) return
      depth++
      setDragging(true)
    }
    const leave = (e: DragEvent) => {
      if (!hasFiles(e)) return
      depth = Math.max(0, depth - 1)
      if (!depth) setDragging(false)
    }
    const over = (e: DragEvent) => hasFiles(e) && e.preventDefault()
    const drop = (e: DragEvent) => {
      if (!hasFiles(e)) return
      e.preventDefault()
      depth = 0
      setDragging(false)
      void addFileObjects([...(e.dataTransfer?.files ?? [])])
    }
    window.addEventListener('dragenter', enter)
    window.addEventListener('dragleave', leave)
    window.addEventListener('dragover', over)
    window.addEventListener('drop', drop)
    return () => {
      window.removeEventListener('dragenter', enter)
      window.removeEventListener('dragleave', leave)
      window.removeEventListener('dragover', over)
      window.removeEventListener('drop', drop)
    }
  }, [addFileObjects, chatMode])

  // ---- textarea ----
  useEffect(() => {
    const el = textRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, window.innerHeight * 0.4)}px`
  }, [text])

  useEffect(() => {
    if (autoFocus) textRef.current?.focus()
  }, [autoFocus, conversation?.id])

  // What "/" offers: commands (run once when sent) above skills (applied to every reply), one list for the keys.
  const slashMatches = useMemo<SlashMatch[]>(() => {
    if (!slash) return []
    const q = slash.query.toLowerCase()
    const commands = COMMANDS.filter((c) => c.name.includes(q)).map((command): SlashMatch => ({ kind: 'command', command }))
    const skills = enabledSkills
      .filter((s) => s.name.toLowerCase().includes(q) && !settings.skills.includes(s.id))
      .slice(0, 8)
      .map((skill): SlashMatch => ({ kind: 'skill', skill }))
    return [...commands, ...skills]
  }, [slash, enabledSkills, settings.skills])

  const updateSlash = (value: string, caret: number) => {
    const m = SLASH_RE.exec(value.slice(0, caret))
    setSlash(m ? { query: m[2], index: 0 } : null)
  }

  const choose = (match: SlashMatch) => (match.kind === 'skill' ? chooseSkill(match.skill) : chooseCommand(match.command))

  /** Put "/name " in the text; the command runs when sent. */
  const chooseCommand = (command: Command) => {
    const el = textRef.current!
    const caret = el.selectionStart
    const before = text.slice(0, caret).replace(SLASH_RE, (_m, lead: string) => `${lead}/${command.name} `)
    setText(before + text.slice(caret))
    setSlash(null)
    requestAnimationFrame(() => {
      el.focus()
      el.setSelectionRange(before.length, before.length)
    })
  }

  const chooseSkill = (skill: Skill) => {
    const el = textRef.current!
    const caret = el.selectionStart
    const before = text.slice(0, caret).replace(SLASH_RE, (_m, lead: string) => lead)
    setText(before + text.slice(caret))
    settings.setSkills([...settings.skills, skill.id])
    setSlash(null)
    requestAnimationFrame(() => {
      el.focus()
      el.setSelectionRange(before.length, before.length)
    })
  }

  const submit = async () => {
    if (!canSend || !settings.model) return
    setSubmitting(true)
    try {
      const command = parseCommand(text)
      if (command) {
        if (!onCommand) {
          useApp.getState().toast(`Nothing to ${command.name} yet: send a message first.`, 'error')
          return
        }
        if (await onCommand({ ...command, model: settings.model })) {
          setText('')
          settings.resetDraft()
        }
        return
      }
      const ok = await onSubmit({
        content: text.trim(),
        attachmentIds: pending.flatMap((p) => (p.attachment ? [p.attachment.id] : [])),
        model: settings.model,
        think: normalizeThinkSetting(profile, settings.think),
        skills: settings.skills,
        toolSources: settings.toolSources
      })
      if (ok) {
        setText('')
        setPending(() => [])
        settings.resetDraft()
      }
    } finally {
      setSubmitting(false)
    }
  }

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (slash && slashMatches.length) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault()
        const dir = e.key === 'ArrowDown' ? 1 : -1
        setSlash({ ...slash, index: (slash.index + dir + slashMatches.length) % slashMatches.length })
        return
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault()
        choose(slashMatches[slash.index])
        return
      }
      if (e.key === 'Escape') {
        setSlash(null)
        return
      }
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault()
      if (!streaming) void submit()
    }
  }

  return (
    <div className="relative">
      {slash && slashMatches.length > 0 && (
        <div className="absolute bottom-full left-0 z-30 mb-2 w-[360px] rounded-ollmost border border-line bg-panel p-1 shadow-[0_8px_30px_rgba(0,0,0,0.12)]">
          {slashMatches.map((match, i) => (
            <div key={match.kind === 'skill' ? `s:${match.skill.id}` : `c:${match.command.name}`}>
              {(i === 0 || slashMatches[i - 1].kind !== match.kind) && (
                <div className="px-2 pb-1 pt-1.5 text-xs font-medium text-subtle">{match.kind === 'command' ? 'Commands' : 'Skills'}</div>
              )}
              <button
                onMouseDown={(e) => {
                  e.preventDefault()
                  choose(match)
                }}
                className={cn('flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left', i === slash.index && 'bg-hover')}
              >
                {match.kind === 'command' ? (
                  <Terminal className="mt-0.5 size-4 shrink-0 text-accent" />
                ) : (
                  <Sparkles className="mt-0.5 size-4 shrink-0 text-accent" />
                )}
                <span className="min-w-0">
                  <span className="block text-sm">
                    /{match.kind === 'command' ? match.command.name : match.skill.name}
                    {match.kind === 'command' && <span className="text-subtle"> {match.command.hint}</span>}
                  </span>
                  <span className="block truncate text-xs text-subtle">
                    {match.kind === 'command' ? match.command.description : match.skill.description}
                  </span>
                </span>
              </button>
            </div>
          ))}
        </div>
      )}

      <div
        className={cn(
          'relative rounded-[calc(var(--o-radius)*1.6)] border bg-panel shadow-[0_2px_12px_rgba(0,0,0,0.05)] transition-colors',
          dragging ? 'border-accent ring-4 ring-accent-soft' : 'border-line focus-within:border-line-strong'
        )}
      >
        {dragging && (
          <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center rounded-[inherit] bg-accent-soft text-sm font-medium text-accent">
            Drop files to attach
          </div>
        )}

        {(pending.length > 0 || activeSkills.length > 0 || activeServers.length > 0 || codeOn) && (
          <div className="flex flex-wrap gap-2 px-3 pt-3">
            {codeOn && (
              <span className="flex h-7 items-center gap-1.5 rounded-lg border border-line pl-2 pr-1 text-xs font-medium text-muted">
                <SquareTerminal className="size-3.5" /> Code runner
                <button
                  aria-label="Turn off the code runner in this chat"
                  onClick={() => toggleSource(CODE, false)}
                  className="rounded p-0.5 hover:bg-hover"
                >
                  <X className="size-3" />
                </button>
              </span>
            )}
            {activeServers.map((s) => (
              <Tooltip key={s.id} content={serverState(mcpStatus.find((x) => x.id === s.id))}>
                <span className="flex h-7 items-center gap-1.5 rounded-lg border border-line pl-2 pr-1 text-xs font-medium text-muted">
                  <Wrench className="size-3.5" /> {s.name}
                  <button
                    aria-label={`Turn off ${s.name} in this chat`}
                    onClick={() => toggleSource(`${MCP}${s.id}`, false)}
                    className="rounded p-0.5 hover:bg-hover"
                  >
                    <X className="size-3" />
                  </button>
                </span>
              </Tooltip>
            ))}
            {activeSkills.map((s) => (
              <span
                key={s.id}
                className="flex h-7 items-center gap-1.5 rounded-lg bg-accent-soft pl-2 pr-1 text-xs font-medium text-accent"
              >
                <Sparkles className="size-3.5" /> {s.name}
                <button
                  aria-label={`Remove skill ${s.name}`}
                  onClick={() => settings.setSkills(settings.skills.filter((id) => id !== s.id))}
                  className="rounded p-0.5 hover:bg-accent-soft"
                >
                  <X className="size-3" />
                </button>
              </span>
            ))}
            {pending.map((p) => (
              <AttachmentChip key={p.key} pending={p} onRemove={() => removePending(p)} />
            ))}
          </div>
        )}

        <textarea
          ref={textRef}
          value={text}
          rows={large ? 3 : 1}
          placeholder={placeholder ?? (chatMode ? 'Reply…' : 'Ask for a change…')}
          onChange={(e) => {
            setText(e.target.value)
            updateSlash(e.target.value, e.target.selectionStart)
          }}
          onKeyDown={onKeyDown}
          onPaste={(e) => {
            const files = [...e.clipboardData.files]
            if (files.length) {
              e.preventDefault()
              void addFileObjects(files)
            }
          }}
          className={cn(
            'block w-full resize-none bg-transparent px-4 text-[15px] leading-relaxed text-fg outline-none placeholder:text-subtle',
            large ? 'min-h-[88px] pt-4' : 'min-h-[52px] pt-3.5'
          )}
        />

        <div className="flex items-center gap-1 px-2.5 pb-2.5">
          <Menu>
            <MenuTrigger asChild>
              <button
                aria-label="Add"
                className="flex size-8 items-center justify-center rounded-lg border border-line text-muted hover:bg-hover hover:text-fg"
              >
                <Plus className="size-4" />
              </button>
            </MenuTrigger>
            <MenuContent side="top">
              {chatMode && (
                <MenuItem icon={<Paperclip className="size-4" />} onSelect={() => void pickFiles()}>
                  Add files or photos
                </MenuItem>
              )}
              <MenuSub
                label="Skills"
                icon={<Sparkles className="size-4" />}
                footer={<MenuItem onSelect={() => navigate({ name: 'skills' })}>Manage skills…</MenuItem>}
              >
                {enabledSkills.length === 0 && <MenuLabel>No skills yet</MenuLabel>}
                {enabledSkills.map((s) => (
                  <MenuCheckItem
                    key={s.id}
                    checked={settings.skills.includes(s.id)}
                    description={s.description}
                    onCheckedChange={(on) =>
                      settings.setSkills(on ? [...settings.skills, s.id] : settings.skills.filter((id) => id !== s.id))
                    }
                  >
                    {s.name}
                  </MenuCheckItem>
                ))}
              </MenuSub>
              <MenuSub
                label="Tools"
                icon={<Wrench className="size-4" />}
                footer={<MenuItem onSelect={() => navigate({ name: 'settings', tab: 'tools' })}>Manage tools…</MenuItem>}
              >
                {chatMode && runnerOn && (
                  <MenuCheckItem
                    checked={settings.toolSources.includes(CODE)}
                    description="Runs Python and bash in a sandbox"
                    onCheckedChange={(on) => toggleSource(CODE, on)}
                  >
                    Code runner
                  </MenuCheckItem>
                )}
                {mcpServers.length === 0 && <MenuLabel>No MCP servers yet</MenuLabel>}
                {mcpServers.map((s) => (
                  <MenuCheckItem
                    key={s.id}
                    checked={settings.toolSources.includes(`${MCP}${s.id}`)}
                    description={serverState(mcpStatus.find((x) => x.id === s.id))}
                    onCheckedChange={(on) => toggleSource(`${MCP}${s.id}`, on)}
                  >
                    {s.name}
                  </MenuCheckItem>
                ))}
              </MenuSub>
            </MenuContent>
          </Menu>

          <ThinkingControl profile={profile} value={settings.think} onChange={settings.setThink} />

          <div className="flex-1" />

          <ModelPicker value={settings.model} onChange={settings.setModel} />

          {streaming ? (
            <Tooltip content="Stop">
              <button
                onClick={onStop}
                aria-label="Stop"
                className="flex size-8 items-center justify-center rounded-lg bg-fg text-canvas hover:opacity-85"
              >
                <Square className="size-3.5 fill-current" />
              </button>
            </Tooltip>
          ) : (
            <button
              onClick={() => void submit()}
              disabled={!canSend}
              aria-label="Send"
              className="flex size-8 items-center justify-center rounded-lg bg-accent text-accent-fg transition-opacity hover:brightness-110 disabled:opacity-35"
            >
              {submitting || uploading ? <Spinner className="text-accent-fg" /> : <ArrowUp className="size-4" strokeWidth={2.5} />}
            </button>
          )}
        </div>
      </div>

      {visionMissing && (
        <p className="mt-2 flex items-center gap-1.5 px-2 text-xs text-muted">
          <TriangleAlert className="size-3.5 text-danger" />
          {model ? `${model.name.replace(/(:|-)cloud$/, '')} can't see images.` : ''} Only the file name will be sent. Pick a model with the
          eye icon to include them.
        </p>
      )}
    </div>
  )
}

function AttachmentChip({ pending, onRemove }: { pending: PendingFile; onRemove: () => void }) {
  const a = pending.attachment
  if (a?.kind === 'image')
    return (
      <div className="group relative size-14 overflow-hidden rounded-lg border border-line">
        <img src={`ollmost://attachment/${a.id}`} alt={a.name} className="size-full object-cover" />
        <RemoveButton onRemove={onRemove} />
      </div>
    )
  return (
    <div className="group relative flex h-14 w-48 items-center gap-2 rounded-lg border border-line bg-canvas px-2.5">
      <div className="flex size-8 shrink-0 items-center justify-center rounded-md bg-hover text-muted">
        {a ? <FileText className="size-4" /> : <Spinner />}
      </div>
      <div className="min-w-0">
        <div className="truncate text-xs font-medium">{pending.name}</div>
        <div className="text-[11px] text-subtle">
          {!a ? 'Reading…' : a.textless ? 'No text found' : `${formatTokens(a.tokenEstimate)} tokens`}
        </div>
      </div>
      <RemoveButton onRemove={onRemove} />
    </div>
  )
}

function RemoveButton({ onRemove }: { onRemove: () => void }) {
  return (
    <button
      aria-label="Remove attachment"
      onClick={onRemove}
      className="absolute right-1 top-1 hidden size-5 items-center justify-center rounded-full bg-fg text-canvas group-hover:flex"
    >
      <X className="size-3" />
    </button>
  )
}
