// Live end-to-end smoke test: drives the built app with Playwright against real Ollama models.
// Usage: npm run build && npm run e2e   (needs the Ollama app running and `ollama signin` for cloud models)
import { execFileSync, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  writeFileSync
} from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import electronPath from 'electron'
import { _electron as electron } from 'playwright'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SHOTS = join(ROOT, 'e2e', 'shots')
const CHAT_MODEL = process.env.OLLMOST_E2E_MODEL ?? 'gpt-oss:120b'
const VISION_MODEL = process.env.OLLMOST_E2E_VISION_MODEL ?? 'kimi-k3'
mkdirSync(SHOTS, { recursive: true })

const userData = mkdtempSync(join(tmpdir(), 'ollmost-e2e-'))
const fixtures = mkdtempSync(join(tmpdir(), 'ollmost-fixtures-'))

// A skill the model should use both when chosen with / and when it loads it on its own.
mkdirSync(join(userData, 'skills', 'haiku-helper'), { recursive: true })
writeFileSync(
  join(userData, 'skills', 'haiku-helper', 'SKILL.md'),
  `---
name: haiku-helper
description: Write poems as a single haiku. Use whenever the user asks for a poem, verse or haiku.
---

# Haiku helper

Answer with exactly one haiku (three lines, 5-7-5 syllables).
After the haiku, on its own line, sign it exactly: — Ollmost Poetry Desk
`
)
writeFileSync(
  join(fixtures, 'brief.txt'),
  'Project brief. The internal codename for this project is BLUE HERON. Launch is planned for March.'
)

// Stand-in for ollama.com/api/usage (undocumented): weekly usage 40%, then a drop that looks like a reset.
let mockWeekly = 0.4
let mockAuth = ''
const usageServer = createServer((req, res) => {
  mockAuth = req.headers.authorization ?? ''
  if (!mockAuth.startsWith('Bearer ')) return res.writeHead(401).end()
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(
    JSON.stringify({
      activity: {
        cost: '3.21000',
        models: [],
        period: { type: 'last_4_weeks', starting_at: '2026-08-26T00:00:00Z', ending_at: '2026-09-23T00:00:00Z' }
      },
      limits: { session: { usage: 0.05, models: [] }, weekly: { usage: mockWeekly, models: [] } }
    })
  )
})
await new Promise((r) => usageServer.listen(0, '127.0.0.1', r))
const USAGE_URL = `http://127.0.0.1:${usageServer.address().port}/api/usage`

const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`)
}

async function launch() {
  const app = await electron.launch({ args: [ROOT], env: { ...process.env, OLLMOST_USER_DATA: userData, OLLMOST_USAGE_URL: USAGE_URL } })
  const win = await app.firstWindow()
  win.on('pageerror', (e) => console.log('[pageerror]', e.message))
  await win.waitForSelector('textarea', { timeout: 20000 })
  await win.waitForTimeout(1500)
  return { app, win }
}

/** Make the next native open dialog return these files. */
async function stubOpenDialog(app, paths) {
  await app.evaluate(({ dialog }, filePaths) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths })
  }, paths)
}

async function pickModel(win, name) {
  await win.click('button[aria-label="Choose model"]')
  await win.fill('input[placeholder="Search models"]', name)
  await win.waitForTimeout(300)
  await win.locator('[data-radix-popper-content-wrapper] button').filter({ hasText: name }).first().click()
}

async function send(win, text) {
  const before = await win.locator('.prose-ollmost').count()
  await win.fill('textarea', text)
  await win.click('button[aria-label="Send"]')
  // Wait for a new reply and for streaming to end. (A fast model can finish before a Stop button is ever seen.)
  await win.waitForFunction(
    (n) => document.querySelectorAll('.prose-ollmost').length > n && !document.querySelector('button[aria-label="Stop"]'),
    before,
    { timeout: 240000 }
  )
  await win.waitForTimeout(600)
  return win.locator('.prose-ollmost').last().innerText()
}

async function newChat(win) {
  await win.getByRole('button', { name: 'New chat' }).first().click()
  await win.waitForSelector('textarea[placeholder="How can I help you today?"]')
}

const { app, win } = await launch()
try {
  // 1. Plain chat + auto title
  await pickModel(win, CHAT_MODEL)
  const reply = await send(win, 'Reply with the single word: pong')
  check('chat streams a reply', /pong/i.test(reply), reply.slice(0, 60))
  await win.waitForTimeout(4000)
  const title = await win.locator('header').first().innerText()
  check('chat gets an automatic title', !!title.trim() && !/New chat/.test(title), title.trim())

  // 1b. /compact: two more exchanges, then the command summarizes all but the last four messages
  await send(win, 'Reply with the single word: one')
  await send(win, 'Reply with the single word: two')
  await win.fill('textarea', '/comp')
  await win.waitForTimeout(300)
  check('typing / offers the compact command', (await win.locator('button:has-text("/compact")').count()) > 0)
  await win.keyboard.press('Enter')
  await win.waitForTimeout(200)
  check('choosing it puts the command in the composer', (await win.inputValue('textarea')).startsWith('/compact '))
  await win.fill('textarea', '/compact keep the words')
  await win.keyboard.press('Enter')
  await win.waitForSelector('[data-testid="compaction"]', { timeout: 120000 })
  const divider = (await win.locator('[data-testid="compaction"]').innerText()).trim()
  check('/compact summarizes the older messages and marks where the summary ends', /Compacted 2 messages/.test(divider), divider)
  await win.locator('[data-testid="compaction"] button').click()
  await win.waitForTimeout(200)
  const opened = (await win.locator('[data-testid="compaction"]').innerText()).trim()
  check('the summary can be read', opened.length > divider.length + 20, opened.slice(divider.length, divider.length + 60))
  check('the compacted messages stay in the transcript', (await win.locator('.prose-ollmost').count()) === 3)
  await win.screenshot({ path: join(SHOTS, 'compact.png') })

  // 2. HTML artifact renders in the sandbox, which blocks network and parent access
  await send(win, 'Make an HTML artifact: a page with a heading "Sandbox test" and nothing else.')
  await win.waitForTimeout(1500)
  const frame = win.frames().find((f) => f.url().startsWith('artifact://'))
  check('HTML artifact renders in a sandboxed frame', !!frame)
  if (frame) {
    const heading = await frame
      .locator('h1')
      .first()
      .innerText()
      .catch(() => '')
    check('artifact content is visible', /sandbox test/i.test(heading), heading)
    const net = await frame.evaluate(() =>
      fetch('https://example.com').then(
        () => 'reached',
        () => 'blocked'
      )
    )
    check('artifact cannot make network requests', net === 'blocked', net)
    const parent = await frame.evaluate(() => {
      try {
        return typeof window.parent.ollmost
      } catch {
        return 'blocked'
      }
    })
    check('artifact cannot reach the app bridge', parent === 'blocked', parent)
  }
  await win.screenshot({ path: join(SHOTS, 'artifact.png') })
  await win
    .locator('aside button[aria-label="Close"]')
    .click()
    .catch(() => {})

  // 2b. The main process only answers Ollmost's own pages: a window showing anything else gets nothing back,
  // even with Ollmost's preload. (Electron doesn't report a window's preload, so the built path is passed in.)
  const ipcFromOtherPage = await app.evaluate(
    async ({ BrowserWindow }, preload) => {
      const other = new BrowserWindow({ show: false, webPreferences: { preload, sandbox: true, contextIsolation: true } })
      try {
        await other.loadURL('data:text/html,<p>Not Ollmost</p>')
        return await other.webContents.executeJavaScript(
          'window.ollmost ? window.ollmost.app.info().then(() => "answered", (e) => "refused: " + e.message) : "no bridge"'
        )
      } finally {
        other.destroy()
      }
    },
    join(ROOT, 'out', 'preload', 'index.js')
  )
  check('IPC from a page that is not Ollmost is refused', ipcFromOtherPage.startsWith('refused'), ipcFromOtherPage.slice(0, 100))
  const ipcFromApp = await win.evaluate(() =>
    window.ollmost.app.info().then(
      () => 'answered',
      (e) => `refused: ${e.message}`
    )
  )
  check("IPC from Ollmost's own window is answered", ipcFromApp === 'answered', ipcFromApp)

  // 3. Manual skill via the / picker
  await newChat(win)
  await win.fill('textarea', '/haiku')
  await win.waitForSelector('text=/haiku-helper')
  await win.keyboard.press('Enter')
  check('slash picker adds a skill chip', await win.locator('button[aria-label="Remove skill haiku-helper"]').isVisible())
  const haiku = await send(win, 'Tell me about rivers.')
  check('manually chosen skill is followed', /Ollmost Poetry Desk/.test(haiku), haiku.replace(/\n/g, ' / ').slice(0, 90))

  // 4. Automatic skill loading through tool calls
  await newChat(win)
  const auto = await send(win, 'Write me a poem about mountains.')
  const pill = await win.locator('text=Using skill').count()
  check('model loads a matching skill by itself', pill > 0 && /Ollmost Poetry Desk/.test(auto), pill ? 'tool call seen' : 'no tool call')
  await win.screenshot({ path: join(SHOTS, 'skills.png') })

  // 5. Image attachment with a vision model
  await newChat(win)
  await pickModel(win, VISION_MODEL)
  await stubOpenDialog(app, [join(SHOTS, 'artifact.png')])
  await win.click('button[aria-label="Add"]')
  await win.getByText('Add files or photos').click()
  await win.waitForSelector('img[alt="artifact.png"]', { timeout: 10000 })
  const seen = await send(win, 'In one sentence, what is shown in this screenshot?')
  check('vision model describes an attached image', seen.length > 20 && !/can't see/i.test(seen), seen.slice(0, 90))

  // 6. Project with instructions + knowledge file
  await win.getByRole('button', { name: 'Projects' }).first().click()
  await win.getByRole('button', { name: 'New project' }).click()
  await win.fill('input[placeholder="Name your project"]', 'Heron launch')
  await win.getByRole('button', { name: 'Create project' }).click()
  await win.waitForSelector('text=Knowledge')
  await stubOpenDialog(app, [join(fixtures, 'brief.txt')])
  await win.click('button[aria-label="Add files"]')
  await win.waitForSelector('text=brief.txt')
  await pickModel(win, CHAT_MODEL)
  const codename = await send(win, 'What is the internal codename of this project? Answer in a few words.')
  // gpt-oss often writes U+202F (narrow no-break space) between words; \s matches it.
  check('project knowledge reaches the model', /blue\s+heron/i.test(codename), codename.slice(0, 60))

  // 7. Chat cost in the title bar
  await win.locator('aside [role="button"]').first().click()
  await win.waitForSelector('button[aria-label="Chat usage"]', { timeout: 10000 })
  const costChip = await win.locator('button[aria-label="Chat usage"]').innerText()
  check('title bar shows chat tokens and cost', /tokens · (≈?\$[\d.]+|local)/.test(costChip), costChip)

  // 8. Account quota: prompt for a key, then show usage and date a reset from a drop
  const before = await win.locator('button[aria-label^="Ollama usage"]').innerText()
  check('quota chip asks for an API key first', /Quota/.test(before), before)
  await win
    .getByRole('button', { name: /Set your name|Settings/ })
    .last()
    .click()
  await win.getByRole('button', { name: 'Usage & cost' }).click()
  await win.fill('input[placeholder="Paste your API key"]', 'ollmost-e2e-key')
  await win.getByRole('button', { name: 'Save', exact: true }).click()
  await win.waitForFunction(() => /40\.0%/.test(document.querySelector('button[aria-label^="Ollama usage"]')?.textContent ?? ''), null, {
    timeout: 10000
  })
  check('quota chip shows weekly usage', true, await win.locator('button[aria-label^="Ollama usage"]').innerText())
  const unknownPace = await win.locator('button[aria-label^="Ollama usage"]').getAttribute('aria-label')
  check('pace is unknown until the reset time is known', /pace unknown/.test(unknownPace), unknownPace)
  check('API key is sent as a bearer token', mockAuth === 'Bearer ollmost-e2e-key')
  mockWeekly = 0.02
  await win.getByRole('button', { name: 'Check now' }).click()
  await win.waitForFunction(
    () => /2\.0% · 6d 2\dh left/.test(document.querySelector('button[aria-label^="Ollama usage"]')?.textContent ?? ''),
    null,
    { timeout: 10000 }
  )
  check('a usage drop dates the weekly reset', true, await win.locator('button[aria-label^="Ollama usage"]').innerText())
  const underPace = await win.locator('button[aria-label^="Ollama usage"]').getAttribute('aria-label')
  check('light usage early in the week is under pace', /under pace/.test(underPace), underPace)
  // Half the allowance gone moments into the week: on course to run out long before the reset.
  mockWeekly = 0.5
  await win.getByRole('button', { name: 'Check now' }).click()
  await win.waitForFunction(
    () => /over pace/.test(document.querySelector('button[aria-label^="Ollama usage"]')?.getAttribute('aria-label') ?? ''),
    null,
    { timeout: 10000 }
  )
  await win.click('button[aria-label^="Ollama usage"]')
  await win.waitForTimeout(500)
  const banner = await win.locator('[data-radix-popper-content-wrapper]').innerText()
  check(
    'heavy usage is over pace with a run-out estimate',
    /Over pace/.test(banner) && /hit the limit in about/.test(banner),
    banner.split('\n').slice(1, 4).join(' | ')
  )
  await win.screenshot({ path: join(SHOTS, 'usage-over-pace.png') })
  await win.keyboard.press('Escape')
  mockWeekly = 0.3
  await win.getByRole('button', { name: 'Check now' }).click()
  await win.waitForTimeout(1500)
  await win.click('button[aria-label^="Ollama usage"]')
  await win.waitForTimeout(500)
  await win.screenshot({ path: join(SHOTS, 'usage-popover.png') })
  await win.keyboard.press('Escape')
  await win.screenshot({ path: join(SHOTS, 'usage-settings.png') })

  // 9. Theme + mode persist across restarts
  await win
    .getByRole('button', { name: /Set your name|Settings/ })
    .last()
    .click()
  await win.getByRole('button', { name: 'Appearance' }).click()
  await win.getByRole('button', { name: 'Dark' }).click()
  await win.getByRole('button', { name: 'Use Nord theme' }).click()
  await win.waitForTimeout(500)
  await win.screenshot({ path: join(SHOTS, 'settings-nord-dark.png') })
} catch (err) {
  check('run completed without errors', false, err.message.split('\n')[0])
  await win.screenshot({ path: join(SHOTS, 'failure.png') }).catch(() => {})
} finally {
  await app.close()
}

const second = await launch()
const dark = await second.win.evaluate(() => document.documentElement.classList.contains('dark'))
const canvas = await second.win.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--o-canvas').trim())
check('theme and dark mode persist after restart', dark && canvas.toLowerCase() === '#2e3440', canvas)
await second.win.screenshot({ path: join(SHOTS, 'home-nord-dark.png') })

// 9b. A dark-only theme overrides Light mode (and says so); popular themes apply both palettes.
{
  const w = second.win
  const themeState = () =>
    w.evaluate(async () => {
      const cs = getComputedStyle(document.documentElement)
      await document.fonts.ready
      return {
        dark: document.documentElement.classList.contains('dark'),
        canvas: cs.getPropertyValue('--o-canvas').trim().toLowerCase(),
        dangerFg: cs.getPropertyValue('--o-dangerFg').trim().toLowerCase(),
        font: getComputedStyle(document.body).fontFamily,
        hackLoaded: [...document.fonts].some((f) => f.family.replace(/"/g, '') === 'Hack' && f.status === 'loaded')
      }
    })
  await w
    .getByRole('button', { name: /Set your name|Settings/ })
    .last()
    .click()
  await w.getByRole('button', { name: 'Appearance' }).click()
  await w.getByRole('button', { name: 'Light', exact: true }).click()
  await w.getByRole('button', { name: 'Use Hack theme' }).click()
  await w.waitForTimeout(500)
  const hack = await themeState()
  check('a dark-only theme stays dark in Light mode', hack.dark && hack.canvas === '#0d140f', hack.canvas)
  check('the Hack theme uses the bundled Hack typeface', /^Hack\b/.test(hack.font) && hack.hackLoaded, hack.font.slice(0, 30))
  check('settings explain why the mode is ignored', await w.getByText('Hack has only a dark palette').isVisible())
  await w.screenshot({ path: join(SHOTS, 'settings-hack.png') })
  await w.getByRole('button', { name: 'Use Catppuccin theme' }).click()
  await w.waitForTimeout(300)
  const latte = await themeState()
  await w.getByRole('button', { name: 'Dark', exact: true }).click()
  await w.waitForTimeout(300)
  const mocha = await themeState()
  check(
    'Catppuccin follows the mode (Latte / Mocha)',
    !latte.dark && latte.canvas === '#eff1f5' && mocha.dark && mocha.canvas === '#1e1e2e',
    `${latte.canvas} / ${mocha.canvas}`
  )
  // Mocha's red is light, so text on a Delete button switches to the theme's dark ink.
  check(
    'danger buttons pick readable text per theme',
    latte.dangerFg === '#ffffff' && mocha.dangerFg === '#1e1e2e',
    `${latte.dangerFg} / ${mocha.dangerFg}`
  )
}
// 9c. The command palette: commands beside search, and a setting's choices previewed live
{
  const w = second.win
  const canvas = () => w.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--o-canvas').trim().toLowerCase())
  const themeId = () => w.evaluate(() => window.ollmost.settings.get().then((s) => s.appearance.themeId))
  const savedTheme = await themeId()
  await w.keyboard.press('Meta+K')
  await w.waitForSelector('[data-testid="palette-rows"]')
  const search = w.locator('input[placeholder="Search chats, projects and commands…"]')
  await search.fill('them')
  await w.waitForTimeout(250)
  check(
    '⌘K lists commands: typing "them" offers Theme',
    (await w.locator('[data-testid="palette-rows"] button', { hasText: 'Theme' }).count()) > 0
  )
  const before = await canvas()
  await w.keyboard.press('Enter')
  await w.waitForSelector('input[placeholder="Choose…"]')
  await w.waitForTimeout(300)
  check('the choices open on the theme in force, changing nothing', (await canvas()) === before, `${await canvas()} (saved ${before})`)
  await w.locator('input[placeholder="Choose…"]').fill('nord')
  await w.waitForTimeout(400)
  const previewed = await canvas()
  check('highlighting a theme previews it before it is saved', previewed !== before && previewed === '#2e3440', `${before} → ${previewed}`)
  await w.keyboard.press('Escape')
  await w
    .waitForFunction((c) => getComputedStyle(document.documentElement).getPropertyValue('--o-canvas').trim().toLowerCase() === c, before, {
      timeout: 3000
    })
    .catch(() => {})
  const afterEscape = { canvas: await canvas(), searchInputs: await search.count() }
  check(
    'Escape puts the saved theme back and returns to the commands',
    afterEscape.canvas === before && afterEscape.searchInputs === 1,
    `${afterEscape.canvas} (saved ${before}), ${afterEscape.searchInputs} search input`
  )
  check('nothing was saved by the preview', (await themeId()) === savedTheme)
  await search.fill('theme')
  await w.keyboard.press('Enter')
  await w.waitForSelector('input[placeholder="Choose…"]')
  await w.locator('input[placeholder="Choose…"]').fill('nord')
  await w.waitForTimeout(250)
  await w.keyboard.press('Enter')
  await w.waitForTimeout(600)
  check(
    'Enter keeps the choice and closes the palette',
    (await themeId()) === 'nord' && (await w.locator('[data-testid="palette-rows"]').count()) === 0
  )
  check('the kept theme is on screen', (await canvas()) === '#2e3440', await canvas())
  // Nothing lingers: a theme picked in Settings right after shows, and a click outside while previewing reverts.
  await w.getByRole('button', { name: 'Use Dracula theme' }).click()
  await w.waitForTimeout(400)
  const dracula = await canvas()
  check(
    'a theme picked in Settings shows after one chosen in the palette',
    dracula !== '#2e3440' && (await themeId()) === 'dracula',
    dracula
  )
  await w.keyboard.press('Meta+K')
  await w.waitForSelector('[data-testid="palette-rows"]')
  await search.fill('theme')
  // Opened with the mouse, the pointer left resting over the list: still on the value in force, nothing previewed.
  await w.locator('[data-testid="palette-rows"] button', { hasText: 'Theme' }).first().click()
  await w.waitForSelector('input[placeholder="Choose…"]')
  await w.waitForTimeout(400)
  check('a list opened by a click still opens on the saved value', (await canvas()) === dracula, await canvas())
  await w.locator('input[placeholder="Choose…"]').fill('nord')
  await w.waitForTimeout(400)
  check('the list previews again', (await canvas()) === '#2e3440')
  await w.mouse.click(8, 400)
  await w.waitForTimeout(500)
  check(
    'a click outside puts the saved theme back',
    (await canvas()) === dracula && (await w.locator('[data-testid="palette-rows"]').count()) === 0,
    await canvas()
  )
  await w.screenshot({ path: join(SHOTS, 'palette-theme.png') })
}
await second.app.close()

// 10–11. Tools against a mock Ollama (deterministic): a model that invents tools must get one
// explanation, lose its tools and still answer; with an API key, web_search/web_fetch work end to
// end, including gpt-oss-style aliases like browser.open.
const mockChats = []
const fakeOllama = createServer(async (req, res) => {
  let raw = ''
  for await (const chunk of req) raw += chunk
  const body = raw ? JSON.parse(raw) : {}
  const json = (obj) => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(obj))
  if (req.url === '/api/tags') return json({ models: [{ name: 'mock-tools:latest' }] })
  if (req.url === '/api/show')
    return json({ capabilities: ['completion', 'tools'], model_info: { 'mock.context_length': 32768 }, details: {} })
  if (req.url !== '/api/chat') return res.writeHead(404).end()
  // Non-streaming: title requests (no tools) get a title; debugger replays of a tool round get its tool call.
  if (!body.stream) {
    if (body.tools?.length) {
      mockChats.push({ toolNames: body.tools.map((t) => t.function.name), toolResults: [], system: body.messages[0].content, replay: true })
      return json({
        message: { role: 'assistant', content: '', tool_calls: [{ function: { name: 'web_search', arguments: { query: 'replayed' } } }] },
        done: true,
        prompt_eval_count: 100,
        eval_count: 5
      })
    }
    return json({ message: { role: 'assistant', content: 'Mock title' }, done: true, prompt_eval_count: 10, eval_count: 2 })
  }
  const toolNames = (body.tools ?? []).map((t) => t.function.name)
  const toolResults = body.messages.filter((m) => m.role === 'tool').map((m) => m.content)
  mockChats.push({ toolNames, toolResults, system: body.messages[0].content })
  let message
  if (toolNames.includes('web_search')) {
    message =
      toolResults.length === 0
        ? {
            role: 'assistant',
            content: '',
            tool_calls: [{ function: { name: 'web_search', arguments: { query: 'top headlines today' } } }]
          }
        : toolResults.length === 1
          ? {
              // Text before the call, so the UI has to show the page read mid-answer.
              role: 'assistant',
              content: 'Found a likely story. Opening it.',
              tool_calls: [{ function: { name: 'browser.open', arguments: { id: 'https://news.example.com/story' } } }]
            }
          : {
              role: 'assistant',
              content: `The lead story is OLLMOST-WEB-OK on Sept\u202F23, per [Example News](https://news.example.com/story).\n\nMore: [preview test](${pageUrl}) and [paypal.com](https://evil.example/login).`
            }
  } else if (toolNames.length) {
    message = {
      role: 'assistant',
      content: '',
      tool_calls: [{ function: { name: 'web.run', arguments: { url: 'https://news.google.com' } } }]
    }
  } else {
    message = { role: 'assistant', content: "I can't browse the web from Ollmost, so I can't fetch today's headlines." }
  }
  res.writeHead(200, { 'content-type': 'application/x-ndjson' })
  res.write(JSON.stringify({ message, done: false }) + '\n')
  res.end(JSON.stringify({ done: true, prompt_eval_count: 100, eval_count: 12, eval_duration: 1e8 }) + '\n')
})
// A page with OpenGraph metadata for link hover previews (served locally; previews normally refuse
// local addresses, so the app is launched with OLLMOST_ALLOW_PRIVATE_PREVIEWS for this test).
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')
const fakePages = createServer((req, res) => {
  if (req.url === '/article') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    return res.end(`<html><head><title>fallback</title>
      <meta property="og:title" content="Preview Title OLLMOST"><meta property="og:description" content="A page used to test hover previews.">
      <meta property="og:site_name" content="Ollmost Test Site"><meta property="og:image" content="/cover.png"><link rel="icon" href="/icon.png">
      </head><body>article</body></html>`)
  }
  if (req.url === '/cover.png' || req.url === '/icon.png') return res.writeHead(200, { 'content-type': 'image/png' }).end(PNG)
  res.writeHead(404).end()
})
await new Promise((r) => fakePages.listen(0, '127.0.0.1', r))
const pageUrl = `http://127.0.0.1:${fakePages.address().port}/article`

const webCalls = []
const fakeWeb = createServer(async (req, res) => {
  let raw = ''
  for await (const chunk of req) raw += chunk
  webCalls.push({ path: req.url, auth: req.headers.authorization, body: raw ? JSON.parse(raw) : {} })
  res.writeHead(200, { 'content-type': 'application/json' })
  if (req.url === '/api/web_search')
    return res.end(
      JSON.stringify({ results: [{ title: 'Example News', url: 'https://news.example.com/story', content: 'Top story snippet' }] })
    )
  res.end(
    JSON.stringify({ title: 'Example story', content: 'Full article text OLLMOST-WEB-MARKER', links: ['https://news.example.com/other'] })
  )
})
await new Promise((r) => fakeOllama.listen(0, '127.0.0.1', r))
await new Promise((r) => fakeWeb.listen(0, '127.0.0.1', r))
const mockUserData = mkdtempSync(join(tmpdir(), 'ollmost-e2e-tools-'))
mkdirSync(join(mockUserData, 'skills', 'news-helper'), { recursive: true })
writeFileSync(
  join(mockUserData, 'skills', 'news-helper', 'SKILL.md'),
  '---\nname: news-helper\ndescription: Summarise news.\n---\n\nSummarise.\n'
)
{
  const app = await electron.launch({
    args: [ROOT],
    env: {
      ...process.env,
      OLLMOST_USER_DATA: mockUserData,
      OLLMOST_WEB_URL: `http://127.0.0.1:${fakeWeb.address().port}`,
      OLLMOST_ALLOW_PRIVATE_PREVIEWS: '1'
    }
  })
  const win = await app.firstWindow()
  await win.waitForSelector('textarea', { timeout: 20000 })
  await win.evaluate(
    (host) => window.ollmost.settings.update({ connection: { mode: 'local', host }, showCloudCatalog: false }),
    `http://127.0.0.1:${fakeOllama.address().port}`
  )
  await win.reload()
  await win.waitForSelector('textarea')
  await win.waitForTimeout(1500)
  try {
    // Without an API key: no web tools, and the model is told why.
    const reply = await send(win, "Get me today's top headlines.")
    check(
      'without a key, web tools are not offered',
      !mockChats[0].toolNames.includes('web_search') && /Settings → Usage & cost/.test(mockChats[0].system),
      mockChats[0].toolNames.join(', ')
    )
    check(
      'an invented tool gets one explanation, then tools are withdrawn',
      mockChats.length === 2 && mockChats[0].toolNames.length > 0 && !mockChats[1].toolNames.length,
      `${mockChats.length} requests`
    )
    check('the explanation says Ollmost has no internet access', /no internet access/.test(mockChats[1]?.toolResults[0] ?? ''))
    check('the turn still ends with an answer', /can't browse the web/.test(reply), reply.slice(0, 60))
    const note = await win
      .locator('text=Tried unavailable')
      .innerText()
      .catch(() => '')
    check(
      'the UI labels it as an unavailable tool, not a file error',
      /web\.run/.test(note) && (await win.locator("text=Couldn't read file").count()) === 0,
      note
    )
    await win.screenshot({ path: join(SHOTS, 'unknown-tool.png') })

    // With a key: search, an aliased page read, and a cited answer.
    await win.evaluate(() => window.ollmost.settings.setApiKey('mock-web-key'))
    mockChats.length = 0
    await win.getByRole('button', { name: 'New chat' }).first().click()
    await win.waitForSelector('textarea[placeholder="How can I help you today?"]')
    const webReply = await send(win, "What's the top news today?")
    check(
      'with a key, web tools are offered and the prompt explains them',
      mockChats[0].toolNames.includes('web_fetch') && /<web>/.test(mockChats[0].system)
    )
    check(
      'web requests carry the API key as a bearer token',
      webCalls.length === 2 && webCalls.every((c) => c.auth === 'Bearer mock-web-key'),
      `${webCalls.length} calls`
    )
    check(
      'gpt-oss-style browser.open is routed to web_fetch',
      webCalls[1]?.path === '/api/web_fetch' && webCalls[1]?.body.url === 'https://news.example.com/story'
    )
    const pageResult = mockChats[2]?.toolResults[1] ?? ''
    check('page content reaches the model framed as untrusted', /OLLMOST-WEB-MARKER/.test(pageResult) && /untrusted data/.test(pageResult))
    check('the answer cites the page', /OLLMOST-WEB-OK/.test(webReply), webReply.slice(0, 70))
    // gpt-oss writes "Sept 23" with U+202F, which the bundled fonts lack; it must still render as a real space.
    const spaceWidth = await win.evaluate(() => {
      const prose = [...document.querySelectorAll('.prose-ollmost')].at(-1)
      const walker = document.createTreeWalker(prose, NodeFilter.SHOW_TEXT)
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const i = node.textContent.indexOf('Sept\u00A023')
        if (i < 0) continue
        const range = document.createRange()
        range.setStart(node, i + 4)
        range.setEnd(node, i + 5)
        return range.getBoundingClientRect().width
      }
      return -1
    })
    check('narrow no-break spaces render as visible spaces', spaceWidth > 2, `${spaceWidth.toFixed(1)}px`)
    const groups = await win.locator('[data-testid="tool-group"]').allInnerTexts()
    const [searchBadge, readBadge] = groups.slice(-2)
    check(
      'badges show the search and the page read',
      /Searched the web:\s+top headlines today\s+· 1 result\b/.test(searchBadge) && /Read\s*Example story/.test(readBadge),
      groups.join(' | ').replace(/\s+/g, ' ')
    )
    const readSitsMidAnswer = await win.evaluate(() => {
      const read = [...document.querySelectorAll('[data-testid="tool-group"]')].at(-1)
      return (
        /Opening it/.test(read?.previousElementSibling?.textContent ?? '') &&
        /OLLMOST-WEB-OK/.test(read?.nextElementSibling?.textContent ?? '')
      )
    })
    check('a call made mid-answer shows where it happened', readSitsMidAnswer)
    await win.screenshot({ path: join(SHOTS, 'web-tools.png') })

    // 12. The debugger window shows the exact requests behind that turn, and can replay one.
    const [dbg] = await Promise.all([app.waitForEvent('window'), win.click('button[aria-label^="Open debugger"]')])
    await dbg.waitForSelector('text=chat · round 1', { timeout: 10000 })
    await dbg.waitForTimeout(800)
    const list = await dbg.locator('.w-\\[420px\\]').innerText()
    const sequence = ['chat · round 1', 'web_search', 'chat · round 2', 'web_fetch', 'chat · round 3', 'title'].every((s) =>
      list.includes(s)
    )
    check('debugger lists every request in the turn, in order', sequence, list.replace(/\s+/g, ' ').slice(0, 160))
    await dbg.locator('button', { hasText: '→ web_search' }).first().click()
    // The trace shown before the click (the title) has a Tools offered row too: wait for the clicked one.
    await dbg.waitForFunction(() => /web_search/.test(document.querySelector('dl')?.textContent ?? ''), null, { timeout: 10000 })
    const overview = await dbg.locator('dl').first().innerText()
    check(
      'overview shows the model, think setting and tools offered',
      /mock-tools:latest/.test(overview) && /web_search/.test(overview),
      overview.replace(/\s+/g, ' ').slice(0, 120)
    )
    await dbg.getByRole('button', { name: 'Prompt anatomy' }).click()
    const anatomyText = await dbg.locator('text=Where the tokens go').locator('..').locator('..').innerText()
    check(
      'prompt anatomy breaks the request into its parts',
      /Web tool guidance/.test(anatomyText) && /Tool definitions \(\d\)/.test(anatomyText) && /Base instructions/.test(anatomyText)
    )
    await dbg.getByRole('button', { name: 'Request', exact: true }).click()
    const requestJson = await dbg.locator('.code-body').first().innerText()
    check('request tab shows the exact JSON sent', /"model": "mock-tools:latest"/.test(requestJson) && /"stream": true/.test(requestJson))
    await dbg.screenshot({ path: join(SHOTS, 'debugger.png') })
    await dbg.getByRole('button', { name: 'Replay', exact: true }).click()
    const before = mockChats.length
    await dbg.getByRole('button', { name: 'Send' }).click()
    await dbg.waitForSelector('text=Tool calls', { timeout: 10000 })
    check('replay re-sends the request without streaming', mockChats.length === before + 1)
    await dbg.screenshot({ path: join(SHOTS, 'debugger-replay.png') })
    await dbg.close()

    // 13. Links (issue #1): hand cursor only on the link, a hover card showing the destination, and
    // an opt-in page preview.
    const newsLink = win.locator('.prose-ollmost a[href="https://news.example.com/story"]').last()
    const cursors = await newsLink.evaluate((a) => ({ link: getComputedStyle(a).cursor, text: getComputedStyle(a.closest('p')).cursor }))
    check(
      'links get the hand cursor; surrounding text keeps the text cursor',
      cursors.link === 'pointer' && cursors.text === 'auto',
      JSON.stringify(cursors)
    )
    // Just after the debugger window closes: bring Ollmost back to the front and move the pointer onto the link from
    // outside it, so the hover card's pointerenter fires.
    await win.bringToFront()
    await win.mouse.move(5, 5)
    await newsLink.hover()
    const card = win.locator('[data-testid="link-card"]')
    await card.waitFor({ timeout: 5000 })
    const cardText = await card.innerText()
    check(
      'hovering a link shows where it goes',
      /news\.example\.com/.test(cardText) && /https:\/\/news\.example\.com\/story/.test(cardText) && /Opens in your browser/.test(cardText),
      cardText.replace(/\s+/g, ' ')
    )
    check('no page is fetched while previews are off', (await card.locator('img').count()) === 0)
    await win.mouse.move(5, 5)
    await card.waitFor({ state: 'detached', timeout: 5000 })
    await win.locator('.prose-ollmost a[href="https://evil.example/login"]').last().hover()
    await card.waitFor({ timeout: 5000 })
    check(
      'a link whose text names another domain gets a warning',
      /The link text says paypal\.com, but it opens evil\.example/.test(await card.innerText())
    )
    await win.mouse.move(5, 5)
    await card.waitFor({ state: 'detached', timeout: 5000 })

    await win.evaluate(() => window.ollmost.settings.update({ links: { previews: true } }))
    await win.reload()
    await win.waitForSelector('textarea')
    await win.locator('aside [role="button"]').first().click()
    await win.waitForSelector(`.prose-ollmost a[href="${pageUrl}"]`)
    await win.locator(`.prose-ollmost a[href="${pageUrl}"]`).last().hover()
    await card.waitFor({ timeout: 5000 })
    await win.waitForFunction(
      () => /Preview Title OLLMOST/.test(document.querySelector('[data-testid="link-card"]')?.textContent ?? ''),
      null,
      { timeout: 8000 }
    )
    const imgs = await card.locator('img').evaluateAll((els) => els.map((e) => e.getAttribute('src')?.slice(0, 15)))
    check(
      'with previews on, the card shows the page title and image',
      imgs.length === 2 && imgs.every((s) => s === 'data:image/png;'),
      imgs.join(', ')
    )
    await win.screenshot({ path: join(SHOTS, 'link-preview.png') })

    // The card's title and URL act as the link; the excerpt doesn't. Record opens instead of launching a browser.
    await app.evaluate(({ shell }) => {
      globalThis.__opened = []
      shell.openExternal = async (url) => void globalThis.__opened.push(url)
    })
    const opened = () => app.evaluate(() => globalThis.__opened)
    const reopenCard = async () => {
      await win.mouse.move(5, 5)
      await card.waitFor({ state: 'detached', timeout: 5000 }).catch(() => {})
      await win.locator(`.prose-ollmost a[href="${pageUrl}"]`).last().hover()
      await card.waitFor({ timeout: 5000 })
    }
    await card.getByText('A page used to test hover previews.').click()
    check('clicking the excerpt does not open the link', (await opened()).length === 0)
    await card.getByText('Preview Title OLLMOST').click()
    await card.waitFor({ state: 'detached', timeout: 5000 }).catch(() => {})
    const closedAfterClick = (await card.count()) === 0
    await reopenCard()
    await card.getByText(pageUrl).click()
    const urls = await opened()
    check(
      'clicking the card title or URL opens the link, then the card closes',
      urls.length === 2 && urls.every((u) => u === pageUrl) && closedAfterClick,
      `${urls.length} opens, closed=${closedAfterClick}`
    )
  } catch (err) {
    check('tool runs completed without errors', false, err.message.split('\n')[0])
    await win.screenshot({ path: join(SHOTS, 'tools-failure.png') }).catch(() => {})
  } finally {
    await app.close()
    fakeOllama.close()
    fakeWeb.close()
    fakePages.close()
  }
}

// 12. MCP servers: added in Settings, switched on per chat, asking before each call. Deterministic against a mock
// model first, then quitting must stop the server, then a live model uses a fixture tool.
const FIXTURE = join(ROOT, 'tests', 'fixtures', 'mcp-server.mjs')
const fixtureRunning = () => {
  try {
    return execFileSync('pgrep', ['-f', FIXTURE]).toString().trim().length > 0
  } catch {
    return false
  }
}
{
  const mcpChats = []
  let mcpDelay = 0
  const mcpOllama = createServer(async (req, res) => {
    let raw = ''
    for await (const chunk of req) raw += chunk
    const body = raw ? JSON.parse(raw) : {}
    const json = (obj) => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(obj))
    if (req.url === '/api/tags') return json({ models: [{ name: 'mock-tools:latest' }] })
    if (req.url === '/api/show')
      return json({ capabilities: ['completion', 'tools'], model_info: { 'mock.context_length': 32768 }, details: {} })
    if (!body.stream) return json({ message: { role: 'assistant', content: 'Mock title' }, done: true })
    const toolNames = (body.tools ?? []).map((t) => t.function.name)
    const lastUser = body.messages.findLastIndex((m) => m.role === 'user')
    const turnResults = body.messages
      .slice(lastUser)
      .filter((m) => m.role === 'tool')
      .map((m) => m.content)
    mcpChats.push({ toolNames, system: body.messages[0].content, turnResults })
    if (mcpDelay) await new Promise((r) => setTimeout(r, mcpDelay))
    const asksForLink = /LINK/.test(body.messages[lastUser]?.content ?? '')
    const asksToRewrite = /REWRITE/.test(body.messages[lastUser]?.content ?? '')
    const message = asksForLink
      ? { role: 'assistant', content: `Here are [the notes](${leakUrl}).` }
      : asksToRewrite
        ? turnResults.length === 0
          ? { role: 'assistant', content: '', tool_calls: [{ function: { name: 'fixture__rewrite', arguments: { name: 'echo' } } }] }
          : { role: 'assistant', content: `Tool said: ${turnResults.at(-1)}` }
        : !toolNames.includes('fixture__echo')
          ? { role: 'assistant', content: 'No tools here.' }
          : turnResults.length === 0
            ? {
                role: 'assistant',
                content: 'Let me check.',
                tool_calls: [{ function: { name: 'fixture__echo', arguments: { text: 'hi' } } }]
              }
            : { role: 'assistant', content: `Tool said: ${turnResults.at(-1)}` }
    res.writeHead(200, { 'content-type': 'application/x-ndjson' })
    res.write(JSON.stringify({ message, done: false }) + '\n')
    res.end(JSON.stringify({ done: true, prompt_eval_count: 100, eval_count: 12, eval_duration: 1e8 }) + '\n')
  })
  await new Promise((r) => mcpOllama.listen(0, '127.0.0.1', r))
  // Where a model-written link in a tool chat points: hovering it must not fetch a preview from here (#63).
  let leakHits = 0
  const leakPages = createServer((req, res) => {
    leakHits++
    res.writeHead(200, { 'content-type': 'text/html' }).end('<html><head><title>Leaked</title></head></html>')
  })
  await new Promise((r) => leakPages.listen(0, '127.0.0.1', r))
  const leakUrl = `http://127.0.0.1:${leakPages.address().port}/notes?d=secret`
  // Another app's config to import from (Claude Code's is pointed at nothing, so the real one isn't read).
  const mcpFiles = mkdtempSync(join(tmpdir(), 'ollmost-e2e-mcp-import-'))
  writeFileSync(
    join(mcpFiles, 'claude_desktop_config.json'),
    JSON.stringify({
      mcpServers: { Imported: { command: 'node', args: [FIXTURE] }, Hosted: { type: 'http', url: 'https://example.com/mcp' } }
    })
  )
  const app = await electron.launch({
    args: [ROOT],
    env: {
      ...process.env,
      OLLMOST_USER_DATA: mkdtempSync(join(tmpdir(), 'ollmost-e2e-mcp-')),
      OLLMOST_CLAUDE_DESKTOP_CONFIG: join(mcpFiles, 'claude_desktop_config.json'),
      OLLMOST_CLAUDE_CODE_CONFIG: join(mcpFiles, 'none.json'),
      // So the only thing that can stop the leak check's preview is the tool-chat rule, not the local-address one.
      OLLMOST_ALLOW_PRIVATE_PREVIEWS: '1'
    }
  })
  const win = await app.firstWindow()
  let quit = false
  try {
    await win.waitForSelector('textarea', { timeout: 20000 })
    await win.evaluate(
      (host) => window.ollmost.settings.update({ connection: { mode: 'local', host }, showCloudCatalog: false }),
      `http://127.0.0.1:${mcpOllama.address().port}`
    )
    await win.reload()
    await win.waitForSelector('textarea')
    await win.waitForTimeout(1500)

    // Add the fixture server through Settings → Tools.
    await win
      .getByRole('button', { name: /Set your name|Settings/ })
      .last()
      .click()
    await win.getByRole('button', { name: 'Tools', exact: true }).click()
    await win.getByRole('button', { name: 'Add server' }).click()
    const dialog = win.getByRole('dialog')
    await dialog.getByPlaceholder('Filesystem', { exact: true }).fill('Fixture')
    await dialog.getByPlaceholder('npx', { exact: true }).fill(process.execPath)
    await dialog.locator('textarea').fill(FIXTURE)
    await dialog.getByRole('button', { name: 'Add variable' }).click()
    await dialog.getByLabel('Variable name').fill('FIXTURE_TOKEN')
    await dialog.getByLabel('Value of FIXTURE_TOKEN').fill('ollmost-e2e-secret')
    await dialog.getByRole('button', { name: 'Add server' }).click()
    await win.locator('[data-testid="mcp-server"]').filter({ hasText: 'Fixture' }).waitFor({ timeout: 5000 })
    const listed = await win.evaluate(() => window.ollmost.mcp.list())
    check(
      'an MCP server added in Settings is saved, its secret kept out of the renderer',
      listed.length === 1 &&
        listed[0].id === 'fixture' &&
        listed[0].envKeys.join() === 'FIXTURE_TOKEN' &&
        !JSON.stringify(listed).includes('ollmost-e2e-secret'),
      JSON.stringify(listed[0]?.envKeys)
    )
    await win.screenshot({ path: join(SHOTS, 'mcp-settings.png') })

    // A new chat starts with the server on, and starts it before anything is sent.
    await newChat(win)
    const chip = win.locator('button[aria-label="Turn off Fixture in this chat"]')
    await chip.waitFor({ timeout: 5000 })
    let status = []
    for (let i = 0; i < 150 && status[0]?.state !== 'ready'; i++) {
      await win.waitForTimeout(200)
      status = await win.evaluate(() => window.ollmost.mcp.status())
    }
    check('the chat starts its server early and lists its tools', status[0].tools.length >= 10, `${status[0].tools.length} tools`)

    const card = win.locator('[data-testid="approval-card"]')
    const last = () => win.locator('.prose-ollmost').last().innerText()
    const idle = () => win.waitForFunction(() => !document.querySelector('button[aria-label="Stop"]'), null, { timeout: 30000 })
    const sendText = async (text) => {
      await win.fill('textarea', text)
      await win.click('button[aria-label="Send"]')
    }

    await sendText('echo hi for me')
    await card.waitFor({ timeout: 15000 })
    const asked = await card.innerText()
    check(
      'the model gets the chat’s MCP tools, and is told about them',
      mcpChats[0]?.toolNames.includes('fixture__echo') && /<mcp_tools>/.test(mcpChats[0].system)
    )
    check(
      'a call waits for approval, naming the tool and its server',
      /Allow the model to use echo from Fixture\?/.test(asked) && /"text": "hi"/.test(asked),
      asked.split('\n')[0]
    )
    await win.screenshot({ path: join(SHOTS, 'mcp-approval.png') })
    await card.getByRole('button', { name: 'Allow once' }).click()
    await idle()
    check('Allow once runs the tool and the model gets its result', /Tool said: echo: hi/.test(await last()), (await last()).slice(0, 60))
    const pill = await win.locator('[data-testid="tool-group"]').last().innerText()
    check('the finished call shows its server and tool', /Fixture/.test(pill) && /echo/.test(pill), pill.replace(/\n/g, ' '))

    await sendText('again please')
    await card.waitFor({ timeout: 15000 })
    await card.getByRole('button', { name: 'Deny' }).click()
    await idle()
    check('Deny tells the model the call did not run', /Tool said: The user declined to run fixture__echo/.test(await last()))

    await sendText('once more')
    await card.waitFor({ timeout: 15000 })
    await card.getByRole('button', { name: 'Allow for this chat' }).click()
    await idle()
    await sendText('and again')
    await idle()
    check('Allow for this chat lets later calls run without asking', (await card.count()) === 0 && /Tool said: echo: hi/.test(await last()))

    // The chat's menu lists what it allows, and can go back to asking.
    await win.getByRole('button', { name: 'Mock title', exact: true }).click()
    await win.getByRole('menuitem', { name: 'Tools allowed in this chat' }).click()
    const allowedMenu = await win.locator('[role="menu"]').last().innerText()
    await win.getByRole('menuitem', { name: 'Ask again before each tool' }).click()
    await sendText('after the reset')
    await card.waitFor({ timeout: 15000 })
    check(
      'the chat menu lists allowed tools, and resetting them brings the question back',
      // Named by the tool's own name and its server, not the name it's offered under.
      /echo\s*·\s*Fixture/.test(allowedMenu),
      allowedMenu.replace(/\n/g, ' ')
    )
    await card.getByRole('button', { name: 'Deny' }).click()
    await idle()

    // Waiting in a chat you aren't looking at: a mark in the sidebar and a toast. Stop leaves the call not run.
    await newChat(win)
    mcpDelay = 1500
    await sendText('echo in the background')
    await win.getByRole('button', { name: 'New chat' }).first().click()
    const mark = win.locator('aside [aria-label="Waiting for your approval"]')
    await mark.waitFor({ timeout: 15000 })
    check(
      'a chat waiting for approval is marked in the sidebar, with a toast',
      (await win.getByText(/waiting for your approval to use a tool/).count()) >= 1
    )
    await mark.locator('xpath=ancestor::div[@role="button"]').locator('span').first().click()
    await card.waitFor({ timeout: 15000 })
    mcpDelay = 0
    await win.click('button[aria-label="Stop"]')
    await idle()
    check(
      'stopping while a call waits leaves it not run',
      /not run/.test(await win.locator('[data-testid="tool-group"]').last().innerText())
    )

    // Per-tool settings: Always allow runs without the card, Off keeps a tool out of the request.
    await win
      .getByRole('button', { name: /Set your name|Settings/ })
      .last()
      .click()
    await win.getByRole('button', { name: 'Tools', exact: true }).click()
    const fixtureRow = win.locator('[data-testid="mcp-server"]').filter({ hasText: 'Fixture' })
    await fixtureRow.getByRole('button', { name: /^Tools \(/ }).click()
    const toolRow = (name) =>
      fixtureRow.locator('[data-testid="mcp-tool"]').filter({ has: win.locator('span.font-mono', { hasText: new RegExp(`^${name}$`) }) })
    await toolRow('echo').getByRole('button', { name: 'Always allow' }).click()
    await toolRow('lookup_codename').getByRole('button', { name: 'Off' }).click()
    await win.waitForFunction(() => /\(1 off\)/.test(document.querySelector('[data-testid="mcp-server"]')?.textContent ?? ''), null, {
      timeout: 5000
    })
    await win.screenshot({ path: join(SHOTS, 'mcp-tool-settings.png') })
    await newChat(win)
    mcpChats.length = 0
    await sendText('echo without asking')
    await idle()
    check(
      'a tool set to Always allow runs without asking, and one set to Off is not offered',
      (await card.count()) === 0 &&
        /Tool said: echo: hi/.test(await last()) &&
        mcpChats[0]?.toolNames.includes('fixture__echo') &&
        !mcpChats[0]?.toolNames.includes('fixture__lookup_codename'),
      mcpChats[0]?.toolNames.join(', ')
    )

    // With previews on, a link the model writes in a tool chat shows where it goes, but nothing is fetched from it.
    await win.evaluate(() => window.ollmost.settings.update({ links: { previews: true } }))
    await win.reload()
    await win.waitForSelector('textarea')
    await win.locator('aside [role="button"]').first().click()
    await sendText('LINK to the notes please')
    await idle()
    const leakLink = win.locator(`.prose-ollmost a[href="${leakUrl}"]`).last()
    await leakLink.hover()
    const linkCard = win.locator('[data-testid="link-card"]')
    await linkCard.waitFor({ timeout: 5000 })
    await win.waitForTimeout(1500)
    check(
      'hovering a model-written link in a tool chat shows its destination but fetches no preview',
      leakHits === 0 && (await linkCard.innerText()).includes('127.0.0.1'),
      `${leakHits} requests`
    )
    await win.mouse.move(5, 5)

    // The server rewrites echo, which is on Always allow: it goes back to Ask, and Settings says why (#64).
    await sendText('REWRITE echo please')
    await card.waitFor({ timeout: 15000 })
    await card.getByRole('button', { name: 'Allow once' }).click()
    await idle()
    const rewroteReply = await last()
    await win
      .getByRole('button', { name: /Set your name|Settings/ })
      .last()
      .click()
    await win.getByRole('button', { name: 'Tools', exact: true }).click()
    const changedRow = win.locator('[data-testid="mcp-server"]').filter({ hasText: 'Fixture' })
    await changedRow.getByRole('button', { name: /^Tools \(/ }).click()
    const echoRow = changedRow.locator('[data-testid="mcp-tool"]').filter({ has: win.locator('span.font-mono', { hasText: /^echo$/ }) })
    await echoRow.locator('[data-testid="mcp-tool-changed"]').waitFor({ timeout: 5000 })
    check(
      'a tool the server changes after it was allowed goes back to Ask, marked as changed',
      /Tool said: rewrote echo/.test(rewroteReply) &&
        (await echoRow.getByRole('button', { name: 'Ask' }).getAttribute('aria-pressed')) === 'true',
      await echoRow.innerText()
    )

    // Paste a README's JSON; import from another app's config.
    await win
      .getByRole('button', { name: /Set your name|Settings/ })
      .last()
      .click()
    await win.getByRole('button', { name: 'Tools', exact: true }).click()
    await win.getByRole('button', { name: 'Paste JSON' }).click()
    await win
      .getByLabel('Server JSON', { exact: true })
      .fill(JSON.stringify({ mcpServers: { Second: { command: 'node', args: [FIXTURE] } } }))
    await win.getByRole('dialog').getByRole('button', { name: 'Add servers' }).click()
    const pasted = await win.locator('[data-testid="import-result"]').innerText()
    await win.getByRole('dialog').getByRole('button', { name: 'Done' }).click()
    check('pasting a README snippet adds its server', /Added Second\./.test(pasted), pasted.replace(/\n/g, ' '))
    await win.getByRole('button', { name: 'Import from Claude Desktop' }).click()
    const offer = await win.getByRole('dialog').innerText()
    await win.getByRole('dialog').getByRole('button', { name: 'Import' }).click()
    const imported = await win.locator('[data-testid="import-result"]').innerText()
    await win.getByRole('dialog').getByRole('button', { name: 'Done' }).click()
    const servers = await win.evaluate(() => window.ollmost.mcp.list())
    check(
      "importing copies another app's local servers, off for new chats, leaving remote ones out",
      /1 local server: Imported/.test(offer) &&
        /1 remote server is left out/.test(offer) &&
        /Added Imported\./.test(imported) &&
        servers.find((x) => x.name === 'Imported')?.defaultOn === false,
      imported.replace(/\n/g, ' ')
    )
    await win.screenshot({ path: join(SHOTS, 'mcp-imported.png') })

    // Quitting stops the server.
    check('the MCP server is running before quitting', fixtureRunning())
    const closed = new Promise((r) => app.process().once('exit', r))
    await app.evaluate(({ app }) => app.quit())
    await closed
    quit = true
    await new Promise((r) => setTimeout(r, 500))
    check('quitting Ollmost stops its MCP servers', !fixtureRunning())
  } catch (err) {
    check('MCP runs completed without errors', false, err.message.split('\n')[0])
    await win.screenshot({ path: join(SHOTS, 'mcp-failure.png') }).catch(() => {})
  } finally {
    if (!quit) await app.close()
    mcpOllama.close()
    leakPages.close()
  }
}

// 12b. Live: a real model uses an MCP tool it can only answer with.
{
  const app = await electron.launch({
    args: [ROOT],
    env: { ...process.env, OLLMOST_USER_DATA: mkdtempSync(join(tmpdir(), 'ollmost-e2e-mcp-live-')) }
  })
  const win = await app.firstWindow()
  try {
    await win.waitForSelector('textarea', { timeout: 20000 })
    await win.evaluate(
      (fixture) => window.ollmost.mcp.save({ name: 'Fixture', command: 'node', args: [fixture], cwd: null, env: {}, defaultOn: true }),
      FIXTURE
    )
    await win.reload()
    await win.waitForSelector('textarea')
    await win.waitForTimeout(1500)
    await pickModel(win, CHAT_MODEL)
    await win.locator('button[aria-label="Turn off Fixture in this chat"]').waitFor({ timeout: 5000 })
    await win.fill('textarea', "What's the internal codename for project Ollmost? Look it up with your tools.")
    await win.click('button[aria-label="Send"]')
    const card = win.locator('[data-testid="approval-card"]')
    await card.waitFor({ timeout: 180000 })
    const asked = await card.innerText()
    await card.getByRole('button', { name: 'Allow once' }).click()
    await win.waitForFunction(() => !document.querySelector('button[aria-label="Stop"]'), null, { timeout: 240000 })
    await win.waitForTimeout(600)
    const answer = await win.locator('.prose-ollmost').last().innerText()
    check(
      `${CHAT_MODEL} uses an MCP tool (after approval) and answers from it`,
      // gpt-oss sometimes writes a non-breaking space between the words.
      /lookup_codename/.test(asked) && /BLUE\s+KESTREL/i.test(answer),
      `asked: ${asked.split('\n')[0]} | answer: ${answer.slice(0, 80)}`
    )
    await win.screenshot({ path: join(SHOTS, 'mcp-live.png') })
  } catch (err) {
    check('live MCP run completed without errors', false, err.message.split('\n')[0])
    await win.screenshot({ path: join(SHOTS, 'mcp-live-failure.png') }).catch(() => {})
  } finally {
    await app.close()
  }
}

/** An SVG that requests the mock server from a script, an external image and a stylesheet, if anything runs it. */
const evilSvg = (port) =>
  `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="40" height="40">` +
  `<style>@import url(http://127.0.0.1:${port}/svg-style);</style>` +
  `<image href="http://127.0.0.1:${port}/svg-image" width="10" height="10"/>` +
  `<script>fetch("http://127.0.0.1:${port}/svg-script")</script><rect width="40" height="40" fill="red"/></svg>`

// 13. The code runner: switched on per chat, asking first, reading the chat's uploads, writing files the user can
// see and save, and running a skill's script from its folder. Deterministic against a mock model, then live.
{
  const runnerChats = []
  const svgHits = []
  const runnerOllama = createServer(async (req, res) => {
    // A scripted SVG a run writes calls home here if anything runs it (#67).
    if (req.url.startsWith('/svg-')) {
      svgHits.push(req.url)
      return res.writeHead(200).end()
    }
    let raw = ''
    for await (const chunk of req) raw += chunk
    const body = raw ? JSON.parse(raw) : {}
    const json = (obj) => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(obj))
    if (req.url === '/api/tags') return json({ models: [{ name: 'mock-tools:latest' }] })
    if (req.url === '/api/show')
      return json({ capabilities: ['completion', 'tools'], model_info: { 'mock.context_length': 32768 }, details: {} })
    if (!body.stream) return json({ message: { role: 'assistant', content: 'Mock title' }, done: true })
    const toolNames = (body.tools ?? []).map((t) => t.function.name)
    const lastUser = body.messages.findLastIndex((m) => m.role === 'user')
    const question = body.messages[lastUser].content
    const results = body.messages
      .slice(lastUser)
      .filter((m) => m.role === 'tool')
      .map((m) => m.content)
    runnerChats.push({ toolNames, system: body.messages[0].content, results })
    const call = (name, args, content = '') => ({ role: 'assistant', content, tool_calls: [{ function: { name, arguments: args } }] })
    let message
    if (/sales/.test(question)) {
      message = !results.length
        ? call('run_code', {
            language: 'python',
            code: [
              'import base64, csv, os',
              "rows = list(csv.DictReader(open('uploads/sales.csv')))",
              "total = sum(int(r['amount']) for r in rows)",
              "open('total.txt', 'w').write(str(total))",
              `open('chart.png', 'wb').write(base64.b64decode('${PNG.toString('base64')}'))`,
              "open('run.command', 'w').write('echo hi')",
              // Executable and read-only: the quarantine mark needs write permission (#67).
              "os.chmod('run.command', 0o555)",
              `open('evil.svg', 'w').write('${evilSvg(runnerOllama.address().port)}')`,
              "print('TOTAL', total)"
            ].join('\n')
          })
        : { role: 'assistant', content: `Result: ${results.at(-1).split('\n').slice(0, 3).join(' ')}` }
    } else if (/note skill/.test(question)) {
      const dir = results[0]?.match(/This skill's files are in (.+?)\. To run one of its scripts/)?.[1]
      message = !results.length
        ? call('load_skill', { name: 'note-maker' })
        : results.length === 1
          ? call('run_code', { language: 'bash', code: `python "${dir}/scripts/make_note.py"` })
          : { role: 'assistant', content: `Skill said: ${results.at(-1).split('\n').slice(0, 3).join(' ')}` }
    } else message = { role: 'assistant', content: 'Plain answer.' }
    res.writeHead(200, { 'content-type': 'application/x-ndjson' })
    res.write(JSON.stringify({ message, done: false }) + '\n')
    res.end(JSON.stringify({ done: true, prompt_eval_count: 100, eval_count: 12, eval_duration: 1e8 }) + '\n')
  })
  await new Promise((r) => runnerOllama.listen(0, '127.0.0.1', r))
  const runnerData = mkdtempSync(join(tmpdir(), 'ollmost-e2e-runner-'))
  // A skill with a script, loaded by the model and run from its own folder.
  mkdirSync(join(runnerData, 'skills', 'note-maker', 'scripts'), { recursive: true })
  writeFileSync(
    join(runnerData, 'skills', 'note-maker', 'SKILL.md'),
    '---\nname: note-maker\ndescription: Makes a note file. Use when asked for a note.\n---\n\nRun scripts/make_note.py.\n'
  )
  writeFileSync(
    join(runnerData, 'skills', 'note-maker', 'scripts', 'make_note.py'),
    "open('note.txt', 'w').write('OLLMOST-SKILL-NOTE')\nprint('note written')\n"
  )
  writeFileSync(join(fixtures, 'sales.csv'), 'region,amount\nnorth,120\nsouth,80\n')
  const app = await electron.launch({ args: [ROOT], env: { ...process.env, OLLMOST_USER_DATA: runnerData } })
  const win = await app.firstWindow()
  try {
    await win.waitForSelector('textarea', { timeout: 20000 })
    await win.evaluate(
      (host) => window.ollmost.settings.update({ connection: { mode: 'local', host }, showCloudCatalog: false }),
      `http://127.0.0.1:${runnerOllama.address().port}`
    )
    await win.reload()
    await win.waitForSelector('textarea')
    await win.waitForTimeout(1500)
    const status = await win.evaluate(() => window.ollmost.runner.status())
    check('the code runner is available (sandbox and Python found)', status.available, status.reason ?? status.python?.version)

    // Attach a CSV and switch the runner on for this chat from the + menu.
    await stubOpenDialog(app, [join(fixtures, 'sales.csv')])
    await win.click('button[aria-label="Add"]')
    await win.getByText('Add files or photos').click()
    await win.waitForSelector('text=sales.csv', { timeout: 10000 })
    await win.click('button[aria-label="Add"]')
    await win.getByRole('menuitem', { name: 'Tools' }).click()
    await win.getByRole('menuitemcheckbox', { name: /Code runner/ }).click()
    await win.keyboard.press('Escape')
    await win.locator('button[aria-label="Turn off the code runner in this chat"]').waitFor({ timeout: 5000 })

    const card = win.locator('[data-testid="approval-card"]')
    const idle = () => win.waitForFunction(() => !document.querySelector('button[aria-label="Stop"]'), null, { timeout: 120000 })
    await win.fill('textarea', 'Add up the sales in my file.')
    await win.click('button[aria-label="Send"]')
    await card.waitFor({ timeout: 30000 })
    const asked = await card.innerText()
    check(
      'a run asks first, showing its code, and the model is told about the runner and the upload',
      /Run this Python in the sandbox\?/.test(asked) &&
        /uploads\/sales\.csv/.test(asked) &&
        runnerChats[0]?.toolNames.includes('run_code') &&
        /<code_runner>/.test(runnerChats[0].system) &&
        /uploads: sales\.csv/.test(runnerChats[0].system)
    )
    await win.screenshot({ path: join(SHOTS, 'runner-approval.png') })
    await card.getByRole('button', { name: 'Allow once' }).click()
    await idle()
    const answer = await win.locator('.prose-ollmost').last().innerText()
    check('the code reads the upload and the model gets what it printed', /Exit code 0\. TOTAL 200/.test(answer), answer.slice(0, 80))
    const files = await win.locator('[data-testid="run-files"]').last().innerText()
    check(
      'files the run wrote are listed',
      /total\.txt/.test(files) && /chart\.png/.test(files) && /evil\.svg/.test(files),
      files.replace(/\n/g, ' ')
    )
    const imageLoaded = await win
      .locator('[data-testid="run-files"] img')
      .last()
      .evaluate((img) => img.complete && img.naturalWidth > 0)
    check('an image the run wrote is previewed', imageLoaded)
    await win.screenshot({ path: join(SHOTS, 'runner-files.png') })

    const chatId = (await win.evaluate(() => window.ollmost.conversations.list()))[0].id
    const savedTo = join(mkdtempSync(join(tmpdir(), 'ollmost-e2e-save-')), 'total-copy.txt')
    await app.evaluate(({ dialog }, filePath) => {
      dialog.showSaveDialog = async () => ({ canceled: false, filePath })
    }, savedTo)
    await win.getByRole('button', { name: 'Save a copy of total.txt' }).click()
    await win.waitForTimeout(800)
    const refused = await win.evaluate(
      (id) =>
        window.ollmost.runner.openFile(id, 'run.command').then(
          () => 'opened',
          (e) => e.message
        ),
      chatId
    )
    const escaped = await win.evaluate(
      (id) =>
        window.ollmost.runner.openFile(id, '../../ollmost.db').then(
          () => 'opened',
          (e) => e.message
        ),
      chatId
    )
    // The scripted SVG: shown inline as an image, never opened, and served so it can't run even if loaded as a page.
    const svgShown = await win
      .locator('[data-testid="run-files"] img[alt="evil.svg"]')
      .last()
      .evaluate((img) => img.complete && img.naturalWidth > 0)
    const svgRefused = await win.evaluate(
      (id) =>
        window.ollmost.runner.openFile(id, 'evil.svg').then(
          () => 'opened',
          (e) => e.message
        ),
      chatId
    )
    const previewButtons = await win.locator('[data-testid="run-files"]').last().locator('button[aria-label^="Preview "]').count()
    await app.evaluate(async ({ BrowserWindow }, url) => {
      const w = new BrowserWindow({ show: false })
      await w.loadURL(url).catch(() => {})
      await new Promise((r) => setTimeout(r, 1500))
      w.destroy()
    }, `ollmost://workspace/${chatId}/evil.svg`)
    await win.waitForTimeout(500)
    check(
      'a scripted SVG a run wrote is shown only as an image, never opened, and loads nothing even as a page',
      svgShown && /only previews documents and images/.test(svgRefused) && previewButtons === 2 && svgHits.length === 0,
      `shown=${svgShown} | ${svgRefused} | preview buttons ${previewButtons} | hits ${svgHits.join(',')}`
    )

    check(
      'Save a copy works; Ollmost won’t open a script a run wrote, or anything outside the chat’s folder',
      (() => {
        try {
          return execFileSync('cat', [savedTo]).toString() === '200'
        } catch {
          return false
        }
      })() &&
        /only previews documents and images/.test(refused) &&
        /no longer in the chat/.test(escaped),
      `${refused} | ${escaped}`
    )

    // Show in Finder shows the whole folder, so every file in it is marked as downloaded, including a read-only
    // script the run left beside the one shown (#67). Finder itself isn't opened.
    await app.evaluate(({ shell }) => {
      globalThis.revealed = []
      shell.showItemInFolder = (p) => globalThis.revealed.push(p)
    })
    await win.getByRole('button', { name: 'Show total.txt in Finder' }).click()
    await win.waitForTimeout(800)
    const revealed = await app.evaluate(() => globalThis.revealed)
    const unmarked = ['total.txt', 'chart.png', 'evil.svg', 'run.command', 'uploads/sales.csv'].filter((f) => {
      if (process.platform !== 'darwin') return false
      try {
        return !execFileSync('/usr/bin/xattr', ['-p', 'com.apple.quarantine', join(runnerData, 'workspaces', chatId, f)], {
          stdio: 'pipe'
        })
          .toString()
          .startsWith('0081;')
      } catch {
        return true
      }
    })
    check(
      'Show in Finder marks every file in the chat’s folder as downloaded, not just the one shown',
      revealed.length === 1 && revealed[0].endsWith('total.txt') && !unmarked.length,
      `shown ${revealed.join(', ') || '(nothing)'}${unmarked.length ? ` | unmarked: ${unmarked.join(', ')}` : ''}`
    )

    // A skill's script, run from the skill's folder (readable inside the sandbox), writing into the chat's folder.
    await win.fill('textarea', 'Use the note skill please.')
    await win.click('button[aria-label="Send"]')
    await card.waitFor({ timeout: 30000 })
    await card.getByRole('button', { name: 'Allow once' }).click()
    await idle()
    const skillAnswer = await win.locator('.prose-ollmost').last().innerText()
    const skillFiles = await win.locator('[data-testid="run-files"]').last().innerText()
    check(
      'a skill’s script runs from its folder and writes into the chat’s',
      /Exit code 0\. note written/.test(skillAnswer) && /note\.txt/.test(skillFiles),
      skillAnswer.slice(0, 80)
    )
  } catch (err) {
    check('code runner runs completed without errors', false, err.message.split('\n')[0])
    await win.screenshot({ path: join(SHOTS, 'runner-failure.png') }).catch(() => {})
  } finally {
    await app.close()
    runnerOllama.close()
  }
}

// 13b. Live: a real model uses the code runner for something it can't do reliably in its head.
{
  const app = await electron.launch({
    args: [ROOT],
    env: { ...process.env, OLLMOST_USER_DATA: mkdtempSync(join(tmpdir(), 'ollmost-e2e-runner-live-')) }
  })
  const win = await app.firstWindow()
  try {
    await win.waitForSelector('textarea', { timeout: 20000 })
    await win.evaluate(() => window.ollmost.settings.update({ runner: { defaultOn: true } }))
    await win.reload()
    await win.waitForSelector('textarea')
    await win.waitForTimeout(1500)
    await pickModel(win, CHAT_MODEL)
    await win.fill('textarea', "What is the SHA-256 hex digest of the exact text 'ollmost' (no newline)? Compute it with run_code.")
    await win.click('button[aria-label="Send"]')
    const card = win.locator('[data-testid="approval-card"]')
    const t0 = Date.now()
    while (Date.now() - t0 < 240000) {
      // The card can still be counted for a moment after it was answered: don't wait on a click that can't land.
      if (await card.count())
        await card
          .getByRole('button', { name: 'Allow for this chat' })
          .click({ timeout: 2000 })
          .catch(() => {})
      if (!(await win.locator('button[aria-label="Stop"]').count()) && !(await card.count())) break
      await win.waitForTimeout(500)
    }
    await win.waitForTimeout(600)
    const answer = await win.locator('.prose-ollmost').last().innerText()
    const digest = createHash('sha256').update('ollmost').digest('hex')
    const ran = await win.locator('button', { hasText: 'Ran Python' }).count()
    check(`${CHAT_MODEL} runs code (after approval) and answers from it`, ran > 0 && answer.includes(digest), answer.slice(0, 90))
    await win.screenshot({ path: join(SHOTS, 'runner-live.png') })
  } catch (err) {
    check('live code runner run completed without errors', false, err.message.split('\n')[0])
    await win.screenshot({ path: join(SHOTS, 'runner-live-failure.png') }).catch(() => {})
  } finally {
    await app.close()
  }
}

// 13c. Code sessions: a model reading, editing and running commands in a folder of the user's (never Ollmost's own),
// with the same approvals as other tools and a Changes panel backed by git run inside the session's own sandbox.
// Deterministic against a mock model, then live.
{
  let gitAvailable = true
  try {
    execFileSync('/usr/bin/xcode-select', ['-p'])
  } catch {
    gitAvailable = false
  }
  check('code sessions: git is available', gitAvailable)
  if (gitAvailable) {
    // A repository of its own, made outside Ollmost with the user's config kept out: only its local identity is set.
    const gitHome = mkdtempSync(join(tmpdir(), 'ollmost-e2e-session-githome-'))
    const gitEnv = { ...process.env, HOME: gitHome, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' }
    const git = (args, cwd) => execFileSync('/usr/bin/git', args, { cwd, env: gitEnv })
    const repo = realpathSync(mkdtempSync(join(tmpdir(), 'ollmost-e2e-session-')))
    git(['init', '-q', '-b', 'main'], repo)
    git(['config', 'user.name', 'Ollmost E2E'], repo)
    git(['config', 'user.email', 'e2e@ollmost.test'], repo)
    writeFileSync(join(repo, 'README.md'), 'Hello from the fixture\n')
    writeFileSync(join(repo, '.gitignore'), 'scratch/\n')
    git(['add', '-A'], repo)
    git(['commit', '-q', '-m', 'Initial commit'], repo)

    const sessionChats = []
    const sessionOllama = createServer(async (req, res) => {
      let raw = ''
      for await (const chunk of req) raw += chunk
      const body = raw ? JSON.parse(raw) : {}
      const json = (obj) => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(obj))
      if (req.url === '/api/tags') return json({ models: [{ name: 'mock-tools:latest' }] })
      if (req.url === '/api/show')
        return json({ capabilities: ['completion', 'tools'], model_info: { 'mock.context_length': 32768 }, details: {} })
      if (!body.stream) return json({ message: { role: 'assistant', content: 'Mock title' }, done: true })
      const toolNames = (body.tools ?? []).map((t) => t.function.name)
      const lastUser = body.messages.findLastIndex((m) => m.role === 'user')
      const results = body.messages
        .slice(lastUser)
        .filter((m) => m.role === 'tool')
        .map((m) => m.content)
      sessionChats.push({ toolNames, system: body.messages[0].content, results })
      const call = (name, args) => ({ role: 'assistant', content: '', tool_calls: [{ function: { name, arguments: args } }] })
      // Only a session offers edit_file, so its presence is what tells this fake apart from the other mock chats.
      const message = !toolNames.includes('edit_file')
        ? { role: 'assistant', content: 'Plain answer.' }
        : results.length === 0
          ? call('read_file', { path: 'README.md' })
          : results.length === 1
            ? call('edit_file', { path: 'README.md', old_string: 'Hello', new_string: 'Bonjour' })
            : results.length === 2
              ? call('run_command', { command: 'echo done' })
              : { role: 'assistant', content: 'Changed the greeting and checked it.' }
      res.writeHead(200, { 'content-type': 'application/x-ndjson' })
      res.write(JSON.stringify({ message, done: false }) + '\n')
      res.end(JSON.stringify({ done: true, prompt_eval_count: 100, eval_count: 12, eval_duration: 1e8 }) + '\n')
    })
    await new Promise((r) => sessionOllama.listen(0, '127.0.0.1', r))
    const sessionData = mkdtempSync(join(tmpdir(), 'ollmost-e2e-sessions-'))
    const app = await electron.launch({ args: [ROOT], env: { ...process.env, OLLMOST_USER_DATA: sessionData } })
    const win = await app.firstWindow()
    try {
      await win.waitForSelector('textarea', { timeout: 20000 })
      await win.evaluate(
        (host) => window.ollmost.settings.update({ connection: { mode: 'local', host }, showCloudCatalog: false }),
        `http://127.0.0.1:${sessionOllama.address().port}`
      )
      await win.reload()
      await win.waitForSelector('textarea')
      await win.waitForTimeout(1500)

      // 1. Open the folder from the sidebar's Code pane.
      await win.getByRole('button', { name: 'Code', exact: true }).click()
      await stubOpenDialog(app, [repo])
      await win.getByRole('button', { name: 'Open folder…' }).click()
      await win.waitForSelector('[data-testid="network-chip"]', { timeout: 10000 })
      const networkChip = await win.locator('[data-testid="network-chip"]').innerText()
      check(
        'opening a folder starts a session named after it, with its branch and no network access',
        (await win.getByText(basename(repo), { exact: true }).first().isVisible()) &&
          (await win.locator('[aria-label="Branch main"]').isVisible()) &&
          /No network/.test(networkChip),
        networkChip
      )

      // 2. Send a message that reads, then asks to edit, the file.
      const card = win.locator('[data-testid="approval-card"]')
      const idle = () => win.waitForFunction(() => !document.querySelector('button[aria-label="Stop"]'), null, { timeout: 60000 })
      await win.fill('textarea', 'Say bonjour instead of hello')
      await win.click('button[aria-label="Send"]')
      await card.waitFor({ timeout: 20000 })
      const groupText = await win.locator('[data-testid="tool-group"]').last().innerText()
      check(
        'the read card appears before the edit is asked for',
        /Read\s+README\.md/.test(groupText),
        groupText.replace(/\n/g, ' ').slice(0, 140)
      )
      const editAsked = await card.innerText()
      check(
        'the edit approval card asks to edit the file, with a diff of the change',
        /Edit\s+README\.md\?/.test(editAsked) &&
          editAsked.includes('-Hello from the fixture') &&
          editAsked.includes('+Bonjour from the fixture'),
        editAsked.replace(/\n/g, ' ').slice(0, 160)
      )
      await win.screenshot({ path: join(SHOTS, 'code-edit-approval.png') })
      await card.getByRole('button', { name: 'Allow once' }).click()

      // 3. The command approval card, allowed for the rest of the session.
      await card.waitFor({ timeout: 20000 })
      const commandAsked = await card.innerText()
      check(
        'the command approval card shows the command it wants to run',
        /Run this command in the sandbox\?/.test(commandAsked) && /echo done/.test(commandAsked),
        commandAsked.replace(/\n/g, ' ').slice(0, 120)
      )
      await card.getByRole('button', { name: 'Allow for this session' }).click()
      await idle()
      const finalReply = await win.locator('.prose-ollmost').last().innerText()
      const commandGroup = await win.locator('[data-testid="tool-group"]').last().innerText()
      check(
        'the command runs and the reply ends with the scripted sentence',
        /echo done/.test(commandGroup) && /Changed the greeting and checked it\./.test(finalReply),
        `${commandGroup.replace(/\n/g, ' ')} | ${finalReply.slice(0, 60)}`
      )

      // 4. What the mock model actually saw in its tool results.
      check(
        'the model is given the numbered file, the edit result and the command exit code',
        (sessionChats[1]?.results[0] ?? '').includes('     1\tHello from the fixture') &&
          (sessionChats[2]?.results[1] ?? '').startsWith('Edited README.md (+1 −1).') &&
          (sessionChats[3]?.results[2] ?? '').startsWith('Exit code 0.') &&
          (sessionChats[3]?.results[2] ?? '').includes('done'),
        JSON.stringify(sessionChats.map((c) => c.results.length))
      )

      // 5. The file changed on disk; nothing of Ollmost's own is left in the folder; git agrees.
      check(
        'the edit landed on disk, and nothing of Ollmost’s own was left in the folder',
        readFileSync(join(repo, 'README.md'), 'utf8') === 'Bonjour from the fixture\n' &&
          !existsSync(join(repo, '.ollmost')) &&
          !existsSync(join(repo, 'uploads'))
      )
      const status = execFileSync('/usr/bin/git', ['status', '--porcelain'], { cwd: repo, env: gitEnv }).toString()
      check('git sees only the one modified file', status === ' M README.md\n', JSON.stringify(status))

      // 6. The Changes panel: git status and a diff, run inside the session's sandbox.
      await win.click('[data-testid="changes-toggle"]')
      const panel = win.locator('[data-testid="changes-panel"]')
      await panel.waitFor({ timeout: 10000 })
      const rows = panel.locator('[data-testid="changes-row"]')
      await win.waitForFunction(() => (document.querySelectorAll('[data-testid="changes-row"]').length ?? 0) === 1, null, {
        timeout: 10000
      })
      const rowText = await rows.first().innerText()
      check('the Changes panel lists the modified file', /README\.md/.test(rowText) && /M/.test(rowText), rowText)
      await win.waitForFunction(
        () => document.querySelector('[data-testid="changes-toggle"]')?.parentElement?.textContent?.trim() === '1',
        null,
        { timeout: 10000 }
      )
      const badgeText = await win.evaluate(
        () => document.querySelector('[data-testid="changes-toggle"]')?.parentElement?.textContent?.trim() ?? ''
      )
      check('the toggle badge counts the rows the panel shows', badgeText === '1', badgeText)
      await rows.first().click()
      await win.waitForFunction(
        () => /\+Bonjour from the fixture/.test(document.querySelector('[data-testid="changes-panel"]')?.textContent ?? ''),
        null,
        { timeout: 10000 }
      )
      check('selecting the row shows its diff', (await panel.innerText()).includes('+Bonjour from the fixture'))
      await win.screenshot({ path: join(SHOTS, 'code-changes.png') })

      // 6b. Plan mode: the model reads and searches but can't edit or run until the plan is approved.
      await win.click('[data-testid="stage-chip"]')
      await win.getByRole('menuitem', { name: 'Plan', exact: true }).click()
      await win.waitForTimeout(300)
      check(
        'the stage chip switches to Plan',
        (await win.locator('[data-testid="stage-chip"]').getAttribute('aria-label')) === 'Stage: Plan'
      )
      check('no Start working card before a plan is written', (await win.getByRole('button', { name: 'Start working' }).count()) === 0)
      const requestsBefore = sessionChats.length
      const plan = await send(win, 'Plan a French greeting')
      const planRequest = sessionChats[requestsBefore]
      // Only the session's own tools are stage-bound; the skills tools ride along whatever the stage.
      const codeToolsIn = (names) =>
        (names ?? []).filter((n) => ['read_file', 'list_files', 'search_files', 'edit_file', 'write_file', 'run_command'].includes(n))
      check(
        'in plan mode the model is offered only the reading tools',
        JSON.stringify(codeToolsIn(planRequest?.toolNames)) === JSON.stringify(['read_file', 'list_files', 'search_files']),
        JSON.stringify(planRequest?.toolNames)
      )
      check('and told how to plan', /<plan_mode>/.test(planRequest?.system ?? ''))
      const startWorking = win.getByRole('button', { name: 'Start working' })
      check('a Start working card follows the plan', await startWorking.isVisible(), plan.slice(0, 40))
      await startWorking.click()
      await win.waitForFunction(
        () => !document.querySelector('button[aria-label="Stop"]') && !!document.querySelector('.prose-ollmost'),
        null,
        { timeout: 120000 }
      )
      await win
        .waitForFunction((n) => document.querySelectorAll('.prose-ollmost').length > n, (await win.locator('.prose-ollmost').count()) - 1, {
          timeout: 120000
        })
        .catch(() => {})
      await win.waitForTimeout(800)
      const workRequest = sessionChats[requestsBefore + 1]
      check(
        'starting work offers every tool again and puts the approved plan in front of the model',
        codeToolsIn(workRequest?.toolNames).length === 6 && /<approved_plan>[\s\S]*Plain answer\./.test(workRequest?.system ?? ''),
        JSON.stringify(workRequest?.toolNames)
      )
      check(
        'the stage chip reads Work again',
        (await win.locator('[data-testid="stage-chip"]').getAttribute('aria-label')) === 'Stage: Work'
      )
      await win.waitForFunction(() => !document.querySelector('button[aria-label="Stop"]'), null, { timeout: 120000 })

      // 7. Deleting the session leaves the folder exactly as it was. The panel stays open: the title's menu must be
      // reachable beside it.
      await win
        .getByRole('button', { name: basename(repo), exact: true })
        .last()
        .click()
      await win.getByRole('menuitem', { name: 'Delete' }).click()
      await win.getByRole('dialog').getByRole('button', { name: 'Delete' }).click()
      await win.waitForSelector('text=No code sessions yet', { timeout: 10000 })
      check('deleting the session removes nothing from its folder', readdirSync(repo).sort().join(' ') === '.git .gitignore README.md')
    } catch (err) {
      check('code sessions run completed without errors', false, err.message.split('\n')[0])
      await win.screenshot({ path: join(SHOTS, 'code-sessions-failure.png') }).catch(() => {})
    } finally {
      await app.close()
      sessionOllama.close()
    }

    // 13d. Live: a real model asks to edit a file in a session on the same repository; denying it stops there.
    if (process.env.OLLMOST_E2E_MODEL) {
      const liveData = mkdtempSync(join(tmpdir(), 'ollmost-e2e-sessions-live-'))
      const liveApp = await electron.launch({ args: [ROOT], env: { ...process.env, OLLMOST_USER_DATA: liveData } })
      const liveWin = await liveApp.firstWindow()
      try {
        await liveWin.waitForSelector('textarea', { timeout: 20000 })
        await liveWin.waitForTimeout(1500)
        await pickModel(liveWin, CHAT_MODEL)
        await liveWin.getByRole('button', { name: 'Code', exact: true }).click()
        await stubOpenDialog(liveApp, [repo])
        await liveWin.getByRole('button', { name: 'Open folder…' }).click()
        await liveWin.waitForSelector('[data-testid="network-chip"]', { timeout: 10000 })
        await liveWin.fill('textarea', 'Change the greeting line of README.md to say Goodbye')
        await liveWin.click('button[aria-label="Send"]')
        const liveCard = liveWin.locator('[data-testid="approval-card"]')
        // The model may look around or run a command first: allow those until it asks to edit.
        let liveAsked = ''
        for (let i = 0; i < 6; i++) {
          await liveCard.waitFor({ timeout: 180000 })
          liveAsked = await liveCard.innerText()
          if (/(Edit|Write)\s+README\.md\?/.test(liveAsked)) break
          await liveCard.getByRole('button', { name: 'Allow once' }).click()
          await liveCard.waitFor({ state: 'detached', timeout: 60000 })
        }
        check(
          `${CHAT_MODEL} asks to edit a file in a code session, with a diff`,
          /(Edit|Write)\s+README\.md\?/.test(liveAsked) && /@@/.test(liveAsked),
          liveAsked.replace(/\n/g, ' ').slice(0, 140)
        )
        await liveWin.screenshot({ path: join(SHOTS, 'code-session-live.png') })
        if (await liveCard.count()) await liveCard.getByRole('button', { name: 'Deny' }).click()
        await liveWin.waitForFunction(() => !document.querySelector('button[aria-label="Stop"]'), null, { timeout: 240000 })
      } catch (err) {
        check('live code session run completed without errors', false, err.message.split('\n')[0])
        await liveWin.screenshot({ path: join(SHOTS, 'code-session-live-failure.png') }).catch(() => {})
      } finally {
        await liveApp.close()
      }
    } else {
      console.log('SKIP  code sessions: live edit check (set OLLMOST_E2E_MODEL to run it)')
    }
  }
}

// 14. Coming from Kiln (#60): data Kiln left next to Ollmost's data folder moves over on the first launch, with its
// chats, files and settings. The secrets Kiln's keychain entry encrypted are asked for again, once.
{
  const home = mkdtempSync(join(tmpdir(), 'ollmost-e2e-kiln-'))
  const DOT_PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')
  writeFileSync(join(fixtures, 'dot.png'), DOT_PNG)
  const mock = createServer(async (req, res) => {
    let raw = ''
    for await (const chunk of req) raw += chunk
    const body = raw ? JSON.parse(raw) : {}
    const json = (obj) => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(obj))
    if (req.url === '/api/tags') return json({ models: [{ name: 'mock-vision:latest' }] })
    if (req.url === '/api/show')
      return json({ capabilities: ['completion', 'vision'], model_info: { 'mock.context_length': 32768 }, details: {} })
    if (!body.stream) return json({ message: { role: 'assistant', content: 'Heron picture' }, done: true })
    res.writeHead(200, { 'content-type': 'application/x-ndjson' })
    res.write(JSON.stringify({ message: { role: 'assistant', content: 'A dot.' }, done: false }) + '\n')
    res.end(JSON.stringify({ done: true, prompt_eval_count: 10, eval_count: 2, eval_duration: 1e8 }) + '\n')
  })
  await new Promise((r) => mock.listen(0, '127.0.0.1', r))
  const host = `http://127.0.0.1:${mock.address().port}`
  const launchAt = async (dir) => {
    const app = await electron.launch({ args: [ROOT], env: { ...process.env, OLLMOST_USER_DATA: dir } })
    const win = await app.firstWindow()
    await win.waitForSelector('textarea', { timeout: 20000 })
    return { app, win }
  }

  // 1. Data as Kiln left it: made by the app on a seed folder, then given Kiln's names and absolute paths.
  const seed = join(home, 'seed')
  let { app, win } = await launchAt(seed)
  let conversationId
  try {
    await win.evaluate((h) => window.ollmost.settings.update({ connection: { mode: 'local', host: h }, showCloudCatalog: false }), host)
    await win.evaluate(
      async (fixture) => {
        await window.ollmost.settings.setApiKey('kiln-era-key')
        await window.ollmost.mcp.save({
          name: 'Tokened',
          command: 'node',
          args: [fixture],
          cwd: null,
          env: { TOKEN: 'secret' },
          defaultOn: false
        })
      },
      join(ROOT, 'tests', 'fixtures', 'mcp-server.mjs')
    )
    await win.reload()
    await win.waitForSelector('textarea')
    await stubOpenDialog(app, [join(fixtures, 'dot.png')])
    await win.click('button[aria-label="Add"]')
    await win.getByText('Add files or photos').click()
    await win.locator('img[alt="dot.png"]').waitFor({ timeout: 10000 })
    await send(win, 'What is this?')
    // The title comes from a separate request once the reply has finished.
    await win.waitForFunction(() => document.body.innerText.includes('Heron picture'), null, { timeout: 15000 })
    conversationId = (await win.evaluate(() => window.ollmost.conversations.list({})))[0].id
  } catch (err) {
    check('data can be made the way Kiln left it', false, err.message.split('\n')[0])
  } finally {
    await app.close()
  }
  if (conversationId) {
    const kiln = join(home, 'Kiln')
    renameSync(seed, kiln)
    for (const suffix of ['', '-wal', '-shm'])
      if (existsSync(join(kiln, `ollmost.db${suffix}`))) renameSync(join(kiln, `ollmost.db${suffix}`), join(kiln, `kiln.db${suffix}`))
    const db = new DatabaseSync(join(kiln, 'kiln.db'))
    db.prepare("UPDATE attachments SET path = ? || '/' || path").run(kiln)
    // Kiln's database: its last schema version, so every migration Ollmost added runs again: the two the rename added
    // (relative paths, trace labels), and later ones. The app made this database, so what those later ones added to
    // the schema is taken out first, or they'd fail on it. A new schema migration means updating this too.
    const KILN_DB_VERSION = 8
    const version = db.prepare('PRAGMA user_version').get().user_version
    check('the Kiln stand-in undoes every migration since Kiln', version === KILN_DB_VERSION + 7, `database version ${version}`)
    db.exec('ALTER TABLE conversations DROP COLUMN plan; ALTER TABLE conversations DROP COLUMN stage')
    db.exec('ALTER TABLE conversations DROP COLUMN compaction')
    db.exec('ALTER TABLE messages DROP COLUMN thinking_segments')
    db.exec('ALTER TABLE conversations DROP COLUMN network')
    db.exec('DROP INDEX conversations_mode; ALTER TABLE conversations DROP COLUMN root; ALTER TABLE conversations DROP COLUMN mode')
    db.exec(`PRAGMA user_version = ${KILN_DB_VERSION}`)
    db.close()
    mkdirSync(join(kiln, 'runner', 'venvs', conversationId, 'bin'), { recursive: true })
    mkdirSync(join(kiln, 'workspaces', conversationId, '.kiln', 'home'), { recursive: true })
    writeFileSync(join(kiln, 'workspaces', conversationId, '.kiln', 'home', 'saved.txt'), 'kept')

    // 2. Ollmost's first launch, while Kiln is still open: it waits, adding nothing to its data folder, and carries on
    // by itself once Kiln has quit. The stand-in for Kiln is Electron holding the Kiln folder's singleton lock, as Kiln
    // does. Electron creates the default data folder, empty, before the app's code runs; OLLMOST_USER_DATA skips that.
    const data = join(home, 'Ollmost')
    mkdirSync(data)
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
    const until = async (test, ms) => {
      for (const end = Date.now() + ms; Date.now() < end; await sleep(250)) if (test()) return true
      return test()
    }
    const lockPid = (folder) => {
      try {
        return Number(readlinkSync(join(folder, 'SingletonLock')).split('-').pop())
      } catch {
        return null
      }
    }
    const alive = (pid) => {
      try {
        return process.kill(pid, 0)
      } catch {
        return false
      }
    }
    writeFileSync(
      join(home, 'kiln.js'),
      `const { app } = require('electron')
app.setPath('userData', ${JSON.stringify(kiln)})
app.requestSingleInstanceLock()
process.on('SIGTERM', () => app.quit())
`
    )
    const standIn = spawn(electronPath, [join(home, 'kiln.js')], { stdio: 'ignore' })
    const locked = await until(() => lockPid(kiln) !== null, 15000)
    const waiting = await electron.launch({ args: [ROOT], env: { ...process.env, OLLMOST_USER_DATA: data } })
    let waitingEnded = false
    waiting.once('close', () => (waitingEnded = true))
    try {
      await sleep(3000)
      check(
        'while Kiln is open, Ollmost waits and adds nothing to its data folder',
        locked && readdirSync(data).length === 0 && existsSync(join(kiln, 'kiln.db'))
      )
      standIn.kill('SIGTERM')
      // The waiting Ollmost quits and relaunches, and the relaunch moves the folder. It gets no further here: it
      // inherits Playwright's loader, which holds back Electron's ready event until Playwright asks for it.
      const moved = await until(() => !existsSync(kiln) && existsSync(join(data, 'kiln.db')), 20000)
      check('once Kiln has quit, Ollmost carries on by itself', moved && (await until(() => waitingEnded, 5000)))
    } finally {
      if (alive(standIn.pid)) standIn.kill('SIGKILL')
      if (!waitingEnded) waiting.process().kill('SIGKILL')
      const relaunched = lockPid(data)
      if (relaunched !== null && alive(relaunched)) {
        process.kill(relaunched, 'SIGTERM')
        if (!(await until(() => !alive(relaunched), 10000))) process.kill(relaunched, 'SIGKILL')
      }
    }

    // 3. Ollmost's first window with the data from Kiln.
    ;({ app, win } = await launchAt(data))
    try {
      check(
        'the Kiln folder is moved, not copied',
        !existsSync(kiln) && existsSync(join(data, 'ollmost.db')) && !existsSync(join(data, 'kiln.db'))
      )
      const notice = win.locator('[data-testid="migration-notice"]')
      const text = (await notice.innerText()).replace(/\n/g, ' ')
      check(
        'a notice says what to enter again',
        /Kiln is now Ollmost/.test(text) && /API key/.test(text) && /Tokened/.test(text),
        text.slice(0, 120)
      )
      const after = await win.evaluate(async () => ({
        settings: await window.ollmost.settings.get(),
        servers: await window.ollmost.mcp.list()
      }))
      check(
        "the API key and the server's values are asked for again",
        !after.settings.connection.hasApiKey && after.servers[0]?.missingEnv.join() === 'TOKEN',
        JSON.stringify(after.servers[0]?.missingEnv)
      )
      await win.screenshot({ path: join(SHOTS, 'from-kiln.png') })
      await notice.getByRole('button', { name: 'Open Settings' }).click()
      check(
        "the notice's Open Settings goes to where the API key is entered",
        await win
          .getByPlaceholder('Paste your API key')
          .waitFor({ timeout: 5000 })
          .then(
            () => true,
            () => false
          )
      )
      await newChat(win)
      await notice.getByRole('button', { name: 'Dismiss' }).click()
      await win.getByText('Heron picture').first().click()
      const img = win.locator('img[src^="ollmost://attachment/"]').first()
      await img.waitFor({ timeout: 10000 })
      const loaded = await img.evaluate((el) =>
        el.complete
          ? el.naturalWidth > 0
          : new Promise((resolve) => {
              el.onload = () => resolve(el.naturalWidth > 0)
              el.onerror = () => resolve(false)
            })
      )
      check('a chat from Kiln opens with its image', loaded)
      const ws = join(data, 'workspaces', conversationId)
      check(
        "Kiln's Python environments are gone, and a chat's own files kept",
        !existsSync(join(data, 'runner', 'venvs')) && readFileSync(join(ws, '.ollmost', 'home', 'saved.txt'), 'utf8') === 'kept'
      )
    } catch (err) {
      check('coming from Kiln completed without errors', false, err.message.split('\n')[0])
      await win.screenshot({ path: join(SHOTS, 'from-kiln-failure.png') }).catch(() => {})
    } finally {
      await app.close()
    }

    // 4. The notice is shown once.
    ;({ app, win } = await launchAt(data))
    try {
      await win.waitForTimeout(1000)
      check('the notice is gone once dismissed', (await win.locator('[data-testid="migration-notice"]').count()) === 0)
    } finally {
      await app.close()
    }
  }
  mock.close()
}

const failed = results.filter((r) => !r.ok).length
console.log(`\n${results.length - failed}/${results.length} checks passed. Screenshots in e2e/shots/, data in ${userData}`)
usageServer.close()
process.exit(failed ? 1 : 0)
