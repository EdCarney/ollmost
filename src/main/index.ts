import { appendFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { app, BrowserWindow, dialog, Menu, type MenuItemConstructorOptions, nativeTheme, shell } from 'electron'
import { EVENT_CHANNELS } from '@shared/ipc'
import { BUILTIN_THEMES, usesDark } from '@shared/themes'
import { currentBackground, currentThemeSource } from './background'
import { onWaitingChange } from './chat/approvals'
import { isReplying, markInterruptedReplies, stopAll } from './chat/service'
import { openDatabase } from './db/index'
import { childPath } from './env'
import { settleStaleTraces } from './debug/traces'
import { staleAttachmentPaths } from './db/conversations'
import { removeFiles } from './files/ingest'
import { registerIpc } from './ipc'
import {
  finishMigration,
  kilnPid,
  migrationPending,
  moveFailedText,
  moveKilnData,
  oldDataFolder,
  renameDatabase,
  renameFailedText,
  STILL_OPEN,
  waitForKiln
} from './migrate'
import { initPaths, paths } from './paths'
import { stopAll as stopServers } from './mcp/manager'
import { hasChildren, stopAllGroups, trackProcesses } from './processes'
import { handleProtocols, registerSchemes } from './protocols'
import { codeMayBeRunning } from './runner/lock'
import { OLLMOST_DIR } from './runner/sandbox'
import { clearPreviews, clearPreviewsSync, sweepWorkspaces } from './runner/workspace'
import { refreshPrices } from './usage/pricing'
import { errorMessage } from './util'

app.setName('Ollmost')
// Tests and experiments can point Ollmost at a throwaway data folder.
if (process.env.OLLMOST_USER_DATA) app.setPath('userData', process.env.OLLMOST_USER_DATA)
// Before anything puts files in the data folder (Electron has created it, empty): move the old app's there, if it
// left one (#60).
const dataDir = app.getPath('userData')
const move = moveKilnData(dataDir)
// Waiting for the old app to quit, or after a failed move, this session must not put anything in the data folder, or
// the move would be skipped for good. It uses a folder of its own, the same for every launch meanwhile, so they hand off.
if (move.state === 'kiln-running' || move.state === 'failed') app.setPath('userData', join(tmpdir(), `${app.name}-waiting`))
registerSchemes()

// A second launch hands off to the running instance. app.quit() is asynchronous, so whenReady below
// must also bail out, or this process would touch the shared database (e.g. mark live replies interrupted).
const hasLock = app.requestSingleInstanceLock()
if (!hasLock) app.quit()

let mainWindow: BrowserWindow | null = null

function sendMenu(action: string): void {
  const win = BrowserWindow.getFocusedWindow() ?? mainWindow
  win?.webContents.send(EVENT_CHANNELS.menu, action)
}

function buildMenu(): void {
  const template: MenuItemConstructorOptions[] = [
    {
      label: app.name,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { label: 'Settings…', accelerator: 'CmdOrCtrl+,', click: () => sendMenu('settings') },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' }
      ]
    },
    {
      label: 'File',
      submenu: [
        { label: 'New Chat', accelerator: 'CmdOrCtrl+N', click: () => sendMenu('new-chat') },
        { label: 'Search Chats…', accelerator: 'CmdOrCtrl+K', click: () => sendMenu('search') },
        { label: 'Open Debugger', accelerator: 'CmdOrCtrl+Shift+D', click: () => sendMenu('debugger') },
        { type: 'separator' },
        { role: 'close' }
      ]
    },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        { label: 'Toggle Sidebar', accelerator: 'CmdOrCtrl+Shift+S', click: () => sendMenu('toggle-sidebar') },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
        ...(app.isPackaged ? [] : ([{ type: 'separator' }, { role: 'reload' }, { role: 'toggleDevTools' }] as MenuItemConstructorOptions[]))
      ]
    },
    { role: 'windowMenu' }
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 720,
    minHeight: 500,
    show: false,
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 16, y: 16 },
    backgroundColor: currentBackground(),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: true
    }
  })
  mainWindow.once('ready-to-show', () => mainWindow?.show())

  if (!app.isPackaged && process.env.ELECTRON_RENDERER_URL) mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  else mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
}

// Lock down navigation: the app never navigates away, links open in the browser,
// and sandboxed artifact frames can't navigate anywhere but their own artifact:// page.
app.on('web-contents-created', (_e, contents) => {
  contents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  contents.on('will-navigate', (event, url) => {
    const devUrl = process.env.ELECTRON_RENDERER_URL
    if (devUrl && url.startsWith(devUrl)) return
    event.preventDefault()
    if (/^https?:/i.test(url)) void shell.openExternal(url)
  })
  contents.on('will-frame-navigate', (event) => {
    if (!event.isMainFrame && !event.url.startsWith('artifact:') && event.url !== 'about:blank') event.preventDefault()
  })
})

app.on('second-instance', () => {
  if (mainWindow?.isMinimized()) mainWindow.restore()
  mainWindow?.focus()
})

app.whenReady().then(async () => {
  if (!hasLock) return
  if (move.state === 'kiln-running') return void (await waitThenRelaunch())
  if (move.state === 'failed') {
    const { title, content } = moveFailedText(move.error)
    dialog.showErrorBox(title, content)
    return app.exit(1)
  }
  initPaths(dataDir)
  // The sandbox library anchors its always-denied paths (.git/hooks, .git/config, shell rc files, .vscode and more)
  // at the working directory, so launched from the Dock they cover every folder and from `electron-vite dev` or a
  // terminal only the project. Ollmost never relies on its cwd.
  try {
    process.chdir('/')
  } catch (err) {
    console.warn("Ollmost: couldn't change its working directory to /:", err)
  }
  // A move from the old app finishes here: its database renamed before it opens, the rest once it has.
  const migrating = migrationPending(paths.data, paths.db)
  if (migrating) {
    // Opening the database before it has its new name would start an empty one next to Kiln's.
    try {
      renameDatabase(paths.data, paths.db)
    } catch (err) {
      const { title, content } = renameFailedText(errorMessage(err), paths.data)
      dialog.showErrorBox(title, content)
      return app.exit(1)
    }
  }
  // Before anything starts a process: record live process groups, and stop any a crashed run left behind.
  void trackProcesses(join(paths.data, 'processes.json')).then((n) => {
    if (n) console.warn(`Ollmost: stopped ${n} process ${n === 1 ? 'group' : 'groups'} left running by an earlier session`)
  })
  openDatabase(paths.db)
  if (migrating) await finishMigration(paths.data, OLLMOST_DIR)
  // Ask the login shell for its PATH now, so a tool Ollmost starts later doesn't wait for it.
  void childPath().then((path) => {
    if (process.env.OLLMOST_DEBUG)
      appendFileSync(join(paths.data, 'debug.log'), `${new Date().toISOString()} PATH for spawned tools: ${path}\n`)
  })
  // Code a run left running before a crash (it can outlive its process group) is stopped (#73), and the folders of
  // chats deleted while their code couldn't be stopped go.
  void clearPreviews()
  void sweepWorkspaces({ removeOrphans: true })
    .then((n) => n && console.warn(`Ollmost: stopped ${n} ${n === 1 ? 'process' : 'processes'} code left running in an earlier session`))
    .catch((err) => console.warn("Ollmost: couldn't check for code left running:", err))
  markInterruptedReplies()
  settleStaleTraces()
  await removeFiles(staleAttachmentPaths(Date.now() - 24 * 60 * 60 * 1000))
  handleProtocols()
  registerIpc()
  nativeTheme.themeSource = currentThemeSource()
  buildMenu()
  createWindow()
  watchApprovals()
  // Keep per-token prices current (at most daily); the bundled snapshot covers offline starts.
  void refreshPrices()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

/**
 * Tool calls waiting for approval show on the Dock icon, since they may be in a chat you aren't looking at. A new one
 * bounces the icon once while Ollmost is in the background.
 */
function watchApprovals(): void {
  let shown = 0
  onWaitingChange((count) => {
    app.dock?.setBadge(count ? String(count) : '')
    if (count > shown && !BrowserWindow.getFocusedWindow()) app.dock?.bounce('informational')
    shown = count
  })
}

/** The old app is still open: say so, and relaunch (which moves its data) once it has quit. */
async function waitThenRelaunch(): Promise<void> {
  const from = oldDataFolder(dataDir)
  // On macOS a message box closes by its signal only as a sheet on a window: on its own, it waits for a click.
  const theme = BUILTIN_THEMES[0]
  const window = new BrowserWindow({
    width: 480,
    height: 220,
    title: app.name,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    backgroundColor: (usesDark(theme, 'system', nativeTheme.shouldUseDarkColors) ? theme.dark : theme.light).canvas
  })
  const quit = await waitForKiln(
    () => kilnPid(from) !== null,
    (signal) =>
      dialog.showMessageBox(window, {
        type: 'info',
        message: STILL_OPEN.message,
        detail: STILL_OPEN.detail,
        buttons: [STILL_OPEN.button],
        signal
      })
  )
  if (quit) app.relaunch()
  app.exit(0)
}

// Quitting mid-reply: stop the stream (which denies any call waiting for approval) and save what arrived, then stop
// the processes Ollmost started, before the process exits. Anything still running after that is killed on exit.
let quitting = false
app.on('before-quit', (event) => {
  if (quitting || (!isReplying() && !hasChildren() && !codeMayBeRunning())) return
  event.preventDefault()
  quitting = true
  const timeout = new Promise((resolve) => setTimeout(resolve, 3000))
  // MCP servers get a clean shutdown (stdin closed, then their process group stopped) before anything left is.
  const stopped = stopAll()
    .then(() => stopServers())
    .then(() => stopAllGroups())
    // Code a run left running outside its process group (#73); normally each run's end already stopped it.
    .then(() => sweepWorkspaces())
    .catch((err) => console.warn('Ollmost: while quitting:', err))
  void Promise.race([stopped, timeout]).finally(() => app.quit())
})

app.on('will-quit', () => clearPreviewsSync())

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
