import { lstat, realpath, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname } from 'node:path'
import { app, BrowserWindow, dialog, ipcMain, nativeTheme, type OpenDialogOptions, shell } from 'electron'
import { artifactExtension, slugify } from '@shared/artifactParser'
import { normalizeFolder } from '@shared/fileTree'
import { EVENT_CHANNELS, type OllmostApi } from '@shared/ipc'
import { parseServersJson } from '@shared/mcpImport'
import { toModelKey } from '@shared/modelKey'
import { openWith } from '@shared/workspace'
import { BUILTIN_THEMES } from '@shared/themes'
import type { ThemeDef } from '@shared/types'
import { decide } from './chat/approvals'
import { compact, edit, isReplyingIn, regenerate, send, setStage, stop, stopAll } from './chat/service'
import { changes, diff, stopPanelRuns } from './code/changes'
import { readBranch } from './code/git'
import { addArtifactVersion, getArtifact, listAllArtifacts, listArtifacts } from './db/artifacts'
import {
  createConversation,
  deleteConversation,
  deletePendingAttachment,
  getConversation,
  insertAttachment,
  listCodeRoots,
  listConversations,
  listMessages,
  search,
  setConversationRoot,
  updateConversation
} from './db/conversations'
import { deleteCustomTheme, listCustomThemes, saveCustomTheme, writeModelOverrides } from './db/kv'
import { conversationUsage, usageSummary } from './db/usage'
import {
  createProject,
  deleteProject,
  deleteProjectFile,
  getProject,
  insertProjectFile,
  listProjectFiles,
  listProjects,
  moveProjectFile,
  projectFileOnDisk,
  updateProject
} from './db/projects'
import { ingestAll, removeFiles } from './files/ingest'
import { appPages, isAppFrame } from './ipcSender'
import { paths } from './paths'
import { quarantine } from './quarantine'
import { errorMessage } from './util'
import { stageArtifact } from './protocols'
import { installedPackages } from './runner/python'
import { validateRoot } from './runner/root'
import { runnerStatus } from './runner/status'
import {
  copyWorkspaceFile,
  markWorkspaceFiles,
  realRoot,
  removeWorkspace,
  resetEnvironments,
  stageWorkspaceFile,
  workspaceFile,
  workspacePath,
  workspaceFor
} from './runner/workspace'
import { getSettings, setApiKey, updateSettings } from './settings'
import { getAccountUsage, invalidateAccountUsage, lastRawUsage } from './usage/account'
import { currentBackground } from './background'
import { replayRequest } from './debug/replay'
import { clearTraces, getTrace, listTraces, tracesForExport } from './debug/traces'
import { openDebugWindow } from './debug/window'
import { linkPreview } from './links/preview'
import { previewsAllowed } from './chat/exposure'
import {
  addImported,
  changesServer,
  getServer,
  importFrom,
  importSources,
  listServers,
  removeServer,
  saveServer,
  setToolPolicy
} from './mcp/config'
import { dismissMigrationNotice, migrationNotice } from './migrate'
import {
  connect as connectServer,
  forget as forgetServer,
  isActive,
  notify as notifyServers,
  onStatusChange,
  restart as restartServer,
  serverLog,
  statuses as serverStatuses,
  toolFingerprint
} from './mcp/manager'
import { addEndpoint, endpointRemovalImpact, probeNewEndpoint, removeEndpoint, setEndpointKey, updateEndpoint } from './providers/endpoints'
import { listAllModels, modelInfo, onLateModels, redetectModel, resolve } from './providers/registry'
import { getPriceTable, refreshPrices } from './usage/pricing'
import {
  deleteSkill,
  duplicateSkill,
  getSkill,
  invalidateSkills,
  listSkills,
  revealSkill,
  saveSkill,
  setSkillEnabled,
  watchSkills
} from './skills/library'

type Impl = { [G in Exclude<keyof OllmostApi, 'events' | 'files'>]: OllmostApi[G] }

/** A project file's stored copy, checked and marked as downloaded before Finder or Quick Look sees it. */
async function projectFileForShowing(fileId: string): Promise<{ path: string; name: string }> {
  const file = projectFileOnDisk(fileId)
  const gone = 'That file is no longer in Ollmost’s data. Remove it from the project and add it again.'
  if (!file) throw new Error(gone)
  const info = await lstat(file.path).catch(() => null)
  if (!info?.isFile()) throw new Error(gone)
  await quarantine(file.path)
  return file
}

function broadcastSkillsChanged(): void {
  for (const w of BrowserWindow.getAllWindows()) w.webContents.send(EVENT_CHANNELS.skills)
}

/** A folder for a code session, from a folder dialog (unchecked: see validateRoot), or null when cancelled. */
async function chooseFolder(defaultPath?: string): Promise<string | null> {
  const win = BrowserWindow.getFocusedWindow()
  const opts: OpenDialogOptions = {
    properties: ['openDirectory', 'createDirectory'],
    message: 'Choose a folder for Ollmost to work in, such as a project or repository of yours.',
    defaultPath
  }
  const res = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
  return res.canceled ? null : (res.filePaths[0] ?? null)
}

/** A code session's folder, as stored; throws for any other id, since the renderer may send anything. */
function sessionRoot(id: string): string {
  const c = getConversation(id)
  if (!c) throw new Error('That session no longer exists.')
  if (c.mode !== 'code' || !c.root) throw new Error('That chat isn’t a code session.')
  return c.root
}

/** Refuse while a reply runs in a session: its commands work in the folder it started with. */
function assertNotReplying(id: string): void {
  if (isReplyingIn(id))
    throw new Error('Ollmost is still responding in this session. Stop it or let it finish, then choose the folder again.')
}

/** Whether a reply runs in any session on this folder: its file tools and commands would fail while the panel's git runs there. */
const replyingOn = (root: string): boolean =>
  listConversations({ mode: 'code', limit: 1000 }).some((c) => c.root === root && isReplyingIn(c.id))

/** The Changes panel is refused while a reply runs in any session on the folder. */
function assertNoReplyOn(root: string): void {
  if (replyingOn(root))
    throw new Error('Ollmost is still responding in a session on this folder. Stop it or let it finish, then look again.')
}

const impl: Impl = {
  app: {
    info: async () => ({ version: app.getVersion(), dataDir: paths.data, platform: process.platform, home: homedir() }),
    setNativeTheme: async (mode, background) => {
      nativeTheme.themeSource = mode
      for (const w of BrowserWindow.getAllWindows()) w.setBackgroundColor(background)
    },
    openExternal: async (url) => {
      if (/^(https?|mailto):/i.test(url)) await shell.openExternal(url)
    },
    openDataFolder: async () => void (await shell.openPath(paths.data)),
    migrationNotice: async () => {
      const notice = migrationNotice()
      if (!notice) return null
      const servers = notice.servers.map((id) => getServer(id)?.name).filter((name): name is string => !!name)
      return { apiKey: notice.apiKey, servers }
    },
    dismissMigrationNotice: async () => dismissMigrationNotice()
  },

  settings: {
    get: async () => getSettings(),
    update: async (patch) => {
      const before = getSettings().skills.sources
      const next = updateSettings(patch)
      if (patch.usage) invalidateAccountUsage()
      if (JSON.stringify(before) !== JSON.stringify(next.skills.sources)) {
        invalidateSkills()
        watchSkills(broadcastSkillsChanged)
        broadcastSkillsChanged()
      }
      return next
    },
    setApiKey: async (key) => {
      setApiKey(key)
      invalidateAccountUsage()
      return getSettings()
    }
  },

  models: {
    list: (refresh) => listAllModels(refresh),
    info: (key) => modelInfo(key),
    setOverrides: async (key, overrides) => {
      // Saved under the canonical key, which is what every read uses (a bare name from before keys is Ollama's).
      const { endpoint, model } = resolve(key)
      const canonical = toModelKey(endpoint.id, model)
      writeModelOverrides(canonical, overrides)
      return modelInfo(canonical)
    },
    redetect: (key) => redetectModel(key)
  },

  endpoints: {
    list: async () => getSettings().endpoints,
    probe: (input) => probeNewEndpoint(input),
    add: async (input) => addEndpoint(input),
    update: async (id, patch) => updateEndpoint(id, patch),
    removalImpact: async (id) => endpointRemovalImpact(id),
    remove: async (id) => removeEndpoint(id),
    setKey: async (id, key) => setEndpointKey(id, key)
  },

  projects: {
    list: async () => listProjects(),
    get: async (id) => getProject(id),
    create: async (input) => createProject(input),
    update: async (id, patch) => updateProject(id, patch),
    delete: async (id) => {
      // Let replies in the project's chats finish saving before their rows go.
      await stopAll((conversationId) => getConversation(conversationId)?.projectId === id)
      // Which folders are theirs is known from their rows: taken before the rows go.
      const workspaces = listConversations({ projectId: id, limit: 100_000 }).map((c) => workspaceFor(c.id))
      await removeFiles(deleteProject(id))
      // Never throws: folders that can't go now are left for the next start's sweep.
      await Promise.all(workspaces.map(removeWorkspace))
    },
    files: async (id) => listProjectFiles(id),
    addFiles: async (id, sources, folder = '') => {
      // Checked before any file is copied, so a bad folder leaves nothing on disk without a row.
      if (typeof folder !== 'string') throw new Error('Ollmost expected a folder path.')
      const target = normalizeFolder(folder)
      const { ok, errors } = await ingestAll(sources)
      const added = ok.map((f) => {
        if (f.kind === 'image') {
          errors.push(`${f.name}: images can't be project knowledge yet. Attach them to a message instead.`)
          void removeFiles([f.path])
          return null
        }
        return insertProjectFile({
          id: f.id,
          project_id: id,
          name: f.name,
          mime: f.mime,
          size: f.size,
          path: f.path,
          text: f.text,
          token_est: f.tokenEst,
          folder: target
        })
      })
      return { added: added.filter((f) => f !== null), errors }
    },
    removeFile: async (fileId) => {
      const path = deleteProjectFile(fileId)
      if (path) await removeFiles([path])
    },
    moveFile: async (fileId, folder) => moveProjectFile(fileId, folder),
    openFile: async (fileId) => {
      const { path, name } = await projectFileForShowing(fileId)
      // Shown with Quick Look under its own name, never handed to the app for its type: the stored copy lost the
      // mark its original may have carried, and a launcher document would run without a word (#67).
      const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
      if (!win) throw new Error('There’s no window to preview the file in.')
      win.previewFile(path, name)
    },
    revealFile: async (fileId) => {
      const { path } = await projectFileForShowing(fileId)
      shell.showItemInFolder(path)
    }
  },

  conversations: {
    list: async (opts) => listConversations(opts),
    get: async (id) => {
      const conversation = getConversation(id)
      return conversation
        ? { conversation, messages: listMessages(id), artifacts: listArtifacts(id), usage: conversationUsage(id, getSettings().endpoints) }
        : null
    },
    update: async (id, { stage, ...patch }) => {
      // The stage is the reply service's (it keeps or drops the plan); the rest of the patch is a plain update.
      const staged = stage !== undefined ? setStage(id, stage) : null
      if (Object.keys(patch).length) return updateConversation(id, patch)
      if (staged) return staged
      const c = getConversation(id)
      if (!c) throw new Error('Conversation not found')
      return c
    },
    delete: async (id) => {
      // Wait for a reply in progress to stop and save, so it never writes to a deleted chat.
      await stop(id, { quiet: true })
      // Which folder is the chat's is known from its row: taken before the row goes.
      const workspace = workspaceFor(id)
      await removeFiles(deleteConversation(id))
      // A Changes panel run still going in the folder would keep the scratch from being removed.
      await stopPanelRuns(workspace.key)
      await removeWorkspace(workspace)
    },
    search: async (q) => search(q)
  },

  chat: {
    send: async (req) => send(req),
    regenerate: (id, opts) => regenerate(id, opts),
    edit: (messageId, content, opts) => edit(messageId, content, opts),
    compact: (id, opts) => compact(id, opts),
    stop: async (id) => stop(id),
    decide: async (id, messageId, index, decision) => decide(id, messageId, index, decision)
  },

  attachments: {
    ingest: async (sources) => {
      const { ok, errors } = await ingestAll(sources)
      const added = ok.map((f) =>
        insertAttachment({
          id: f.id,
          kind: f.kind,
          name: f.name,
          mime: f.mime,
          size: f.size,
          path: f.path,
          text: f.text,
          token_est: f.tokenEst
        })
      )
      return { added, errors }
    },
    pick: async () => {
      const win = BrowserWindow.getFocusedWindow()
      const opts = { properties: ['openFile', 'multiSelections'] as Array<'openFile' | 'multiSelections'> }
      const res = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
      return res.canceled ? [] : res.filePaths.map((path) => ({ path }))
    },
    remove: async (id) => {
      const path = deletePendingAttachment(id)
      if (path) await removeFiles([path])
    }
  },

  artifacts: {
    list: async (projectId) => listAllArtifacts(typeof projectId === 'string' ? projectId : undefined),
    stage: async (type, content) => stageArtifact(type, content),
    save: async (title, type, language, content) => {
      const win = BrowserWindow.getFocusedWindow()
      const opts = { defaultPath: `${slugify(title)}.${artifactExtension(type, language)}` }
      const res = win ? await dialog.showSaveDialog(win, opts) : await dialog.showSaveDialog(opts)
      if (res.canceled || !res.filePath) return false
      await writeFile(res.filePath, content)
      return true
    },
    createFromBlock: async (input) => {
      const existing = new Set(listArtifacts(input.conversationId).map((a) => a.identifier))
      let identifier = slugify(input.title)
      for (let n = 2; existing.has(identifier); n++) identifier = `${slugify(input.title)}-${n}`
      const id = addArtifactVersion({ ...input, identifier })
      return getArtifact(id)!
    }
  },

  skills: {
    list: () => listSkills(),
    get: (id) => getSkill(id),
    save: (input) => saveSkill(input),
    delete: (id) => deleteSkill(id),
    duplicate: (id) => duplicateSkill(id),
    setEnabled: async (id, enabled) => setSkillEnabled(id, enabled),
    reveal: (id) => revealSkill(id)
  },

  usage: {
    account: (refresh) => getAccountUsage(refresh),
    summary: async (days, since, until) => usageSummary(getSettings().endpoints, days, since, until),
    raw: async () => lastRawUsage(),
    prices: async () => getPriceTable(),
    refreshPrices: () => refreshPrices(true)
  },

  links: {
    // Not in chats with tools or files: a model-written link could carry their data out on hover (#63).
    preview: async (url, conversationId) => (previewsAllowed(conversationId ?? null) ? linkPreview(url) : null)
  },

  runner: {
    status: () => runnerStatus(),
    packages: () => installedPackages(),
    // Every chat's code may write its own environment: none may be running while they're deleted (#71, #76).
    resetEnvironment: () => resetEnvironments(),
    openFile: async (conversationId, path) => {
      if (!(await workspacePath(conversationId, path))) throw new Error('That file is no longer in the chat’s folder.')
      // Whatever opens the file runs outside the sandbox, and the file may carry the chat's data: on a Mac it's shown
      // with Quick Look, not handed to the app for its type, which might run its scripts or load remote content (#67).
      const how = openWith(path, process.platform)
      if (!how) throw new Error('Ollmost only previews documents and images. Use Show in Finder for other files.')
      // A copy, since the previewer reads by path whenever it likes, and code could put a link on that path (#71).
      const copy = await stageWorkspaceFile(conversationId, path)
      if (!copy) throw new Error('That file is no longer in the chat’s folder.')
      await quarantine(copy)
      if (how === 'quick-look') {
        const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
        if (!win) throw new Error('There’s no window to preview the file in.')
        return win.previewFile(copy, basename(path))
      }
      const failed = await shell.openPath(copy)
      if (failed) throw new Error(failed)
    },
    revealFile: async (conversationId, path) => {
      const file = await workspaceFile(conversationId, path)
      if (!file) throw new Error('That file is no longer in the chat’s folder.')
      // Finder shows the whole folder, so every file in it is marked as downloaded, not only this one: macOS then asks
      // before running any script or app a run left there. Not while the chat's code runs: it could swap a folder for
      // a link while they're marked (#71, #76).
      await markWorkspaceFiles(conversationId, path).catch((err) => {
        throw new Error(`Couldn’t mark the chat’s files as downloaded, so they weren’t shown: ${errorMessage(err)}`)
      })
      shell.showItemInFolder(file)
    },
    saveFile: async (conversationId, path) => {
      const file = await workspaceFile(conversationId, path)
      if (!file) throw new Error('That file is no longer in the chat’s folder.')
      const res = await dialog.showSaveDialog({ defaultPath: basename(file) })
      if (res.canceled || !res.filePath) return false
      if (!(await copyWorkspaceFile(conversationId, path, res.filePath))) throw new Error('That file is no longer in the chat’s folder.')
      // A copy without the mark would open like any file of the user's: remove it rather than leave it unmarked.
      await quarantine(res.filePath).catch(async (err) => {
        await rm(res.filePath!, { force: true })
        throw new Error(`Couldn’t mark the copy as downloaded, so it wasn’t saved: ${errorMessage(err)}`)
      })
      return true
    }
  },

  // Code sessions (#86): a conversation working in a folder of the user's, which Ollmost never owns (see workspace.ts).
  code: {
    pickFolder: async () => {
      const picked = await chooseFolder()
      return picked === null ? null : validateRoot(picked)
    },
    create: async ({ root, model, think }) => {
      // Checked again: the renderer may send any path.
      const real = await validateRoot(root)
      return createConversation({
        projectId: null,
        model,
        think,
        skills: [],
        toolSources: [],
        mode: 'code',
        root: real,
        network: getSettings().code.defaultNetwork,
        title: basename(real)
      })
    },
    recentRoots: async () => {
      // Only folders still where they were: one moved, or a link put in its place, is found again with locate.
      const roots = listCodeRoots()
      const found = await Promise.all(roots.map(async (root) => (await realpath(root).catch(() => null)) === root))
      return roots.filter((_, i) => found[i])
    },
    locate: async (id) => {
      const root = sessionRoot(id)
      assertNotReplying(id)
      const picked = await chooseFolder(dirname(root))
      if (picked === null) return null
      const real = await validateRoot(picked)
      // The session may have been deleted, or a reply started in it, while the dialog was open.
      sessionRoot(id)
      assertNotReplying(id)
      return setConversationRoot(id, real)
    },
    status: async (id) => {
      const root = sessionRoot(id)
      const found = await realRoot(workspaceFor(id)).then(
        () => true,
        () => false
      )
      return { found, branch: found ? await readBranch(root) : null }
    },
    reveal: async (id) => {
      sessionRoot(id)
      // Throws RootMissingError when the folder isn't where it was.
      shell.showItemInFolder(await realRoot(workspaceFor(id)))
    },
    changes: async (id) => {
      const root = sessionRoot(id)
      assertNoReplyOn(root)
      return changes(workspaceFor(id), { replying: () => replyingOn(root) })
    },
    diff: async (id, path) => {
      const root = sessionRoot(id)
      assertNoReplyOn(root)
      return diff(workspaceFor(id), path, { replying: () => replyingOn(root) })
    }
  },

  mcp: {
    list: async () => listServers(),
    save: async (input) => {
      const before = input.id ? getServer(input.id) : null
      const server = saveServer(input)
      // A running server picks up a new command or environment only when it starts again; a new name or the
      // "Use in new chats" switch doesn't need that.
      const relaunch = !!before && changesServer(before, server, input.env)
      if (relaunch && isActive(server.id)) void restartServer(server.id)
      else notifyServers()
      return server
    },
    remove: async (id) => {
      removeServer(id)
      await forgetServer(id)
    },
    status: async () => serverStatuses(),
    connect: async (ids) => {
      for (const id of ids) void connectServer(id)
    },
    restart: (id) => restartServer(id),
    log: async (id) => serverLog(id),
    setToolPolicy: async (id, tool, policy) => {
      // Always allow trusts the tool as it is now; if the server changes it later, it asks again (#64).
      const server = setToolPolicy(id, tool, policy, toolFingerprint(id, tool))
      notifyServers()
      return server
    },
    importJson: async (text) => {
      const { servers, skipped } = parseServersJson(text)
      const result = addImported(servers, true, skipped)
      notifyServers()
      return result
    },
    importSources: () => importSources(),
    importFrom: async (id) => {
      const result = await importFrom(id)
      notifyServers()
      return result
    }
  },

  debug: {
    open: async (conversationId) => openDebugWindow(conversationId, currentBackground()),
    list: async (conversationId) => listTraces(conversationId),
    get: async (id) => getTrace(id),
    clear: async (conversationId) => clearTraces(conversationId),
    exportTraces: async (conversationId) => {
      const res = await dialog.showSaveDialog({ defaultPath: `ollmost-traces-${new Date().toISOString().slice(0, 10)}.json` })
      if (res.canceled || !res.filePath) return false
      await writeFile(res.filePath, JSON.stringify(tracesForExport(conversationId), null, 2))
      return true
    },
    replay: (conversationId, model, body, endpointName) => replayRequest(conversationId, model, body, endpointName),
    inspectApp: async () => {
      const main = BrowserWindow.getAllWindows().find((w) => !w.webContents.getURL().includes('#debug'))
      main?.webContents.openDevTools({ mode: 'detach' })
    }
  },

  themes: {
    list: async () => [...BUILTIN_THEMES, ...listCustomThemes()],
    save: async (theme) => {
      if (BUILTIN_THEMES.some((t) => t.id === theme.id)) throw new Error('Built-in themes are read-only; save a copy instead.')
      saveCustomTheme(theme)
      return { ...theme, builtin: false }
    },
    delete: async (id) => deleteCustomTheme(id),
    exportTheme: async (theme) => {
      const res = await dialog.showSaveDialog({ defaultPath: `${slugify(theme.name)}.ollmost-theme.json` })
      if (res.canceled || !res.filePath) return false
      const { builtin: _builtin, ...rest } = theme
      await writeFile(res.filePath, JSON.stringify(rest, null, 2))
      return true
    },
    importTheme: async () => {
      const res = await dialog.showOpenDialog({ properties: ['openFile'], filters: [{ name: 'Theme', extensions: ['json'] }] })
      if (res.canceled || !res.filePaths[0]) return null
      const { readFile } = await import('node:fs/promises')
      const parsed = JSON.parse(await readFile(res.filePaths[0], 'utf8')) as Partial<ThemeDef>
      if (!parsed.light || !parsed.dark || !parsed.name) throw new Error('That file is not a Ollmost theme.')
      const base = BUILTIN_THEMES[0]
      const theme: ThemeDef = {
        id: `custom-${Date.now().toString(36)}`,
        name: parsed.name,
        builtin: false,
        light: { ...base.light, ...parsed.light },
        dark: { ...base.dark, ...parsed.dark },
        fonts: { ...base.fonts, ...parsed.fonts },
        radius: typeof parsed.radius === 'number' ? parsed.radius : base.radius,
        ...(parsed.only === 'light' || parsed.only === 'dark' ? { only: parsed.only } : {})
      }
      saveCustomTheme(theme)
      return theme
    }
  }
}

export function registerIpc(): void {
  const pages = appPages(app.isPackaged)
  for (const [group, methods] of Object.entries(impl)) {
    for (const [name, fn] of Object.entries(methods as Record<string, (...args: unknown[]) => unknown>)) {
      const channel = `${group}:${name}`
      ipcMain.handle(channel, (event, ...args) => {
        // Only Ollmost's own windows may call in (see isAppFrame).
        if (!isAppFrame(event.senderFrame, pages)) {
          const from = event.senderFrame?.url || 'a frame that has gone'
          console.warn(`Ollmost: refused ${channel} from ${from}`)
          throw new Error(`Ollmost refused ${channel}: the call didn't come from one of its own windows.`)
        }
        return fn(...args)
      })
    }
  }
  watchSkills(broadcastSkillsChanged)
  onStatusChange((statuses) => {
    for (const w of BrowserWindow.getAllWindows()) w.webContents.send(EVENT_CHANNELS.mcp, statuses)
  })
  // An endpoint the model list stopped waiting for has answered, or failed.
  onLateModels((update) => {
    for (const w of BrowserWindow.getAllWindows()) w.webContents.send(EVENT_CHANNELS.models, update)
  })
}
