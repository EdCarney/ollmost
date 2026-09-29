# Ollmost

A desktop chat app in the style of the Claude desktop app, running on your Ollama models (cloud and local) and on OpenAI-compatible servers such as LM Studio, llama.cpp and vLLM.

Features: projects (instructions + knowledge files), pinned chats and projects, searchable history, attachments (images, PDF, DOCX, XLSX, text/code), a model picker that adapts to each model's capabilities, thinking/effort controls, skills (`SKILL.md`), artifacts in a side panel, live token/cost and quota tracking, web search, and fully customisable themes.

## Install

On any Mac (Apple Silicon or Intel), without a checkout:

```sh
curl -fsSL https://raw.githubusercontent.com/EdCarney/ollmost/main/scripts/install.sh | bash
```

This downloads the right build from the latest [release](https://github.com/EdCarney/ollmost/releases/latest), installs it as `/Applications/Ollmost.app` (quitting and replacing any older copy), and opens it. Run it again to upgrade. You'll also need a model server: the [Ollama app](https://ollama.com) (for its cloud models, run `ollama signin` once), or an OpenAI-compatible server such as [LM Studio](https://lmstudio.ai). See [Model endpoints](#model-endpoints).

To install somewhere else, such as your own `~/Applications` (which doesn't need an administrator account), set `OLLMOST_INSTALL_DIR`. The folder is created if it doesn't exist:

```sh
curl -fsSL https://raw.githubusercontent.com/EdCarney/ollmost/main/scripts/install.sh | OLLMOST_INSTALL_DIR=~/Applications bash
```

Use the same setting when you upgrade. The script only replaces the copy in the folder it installs to, so if you switch folders, delete the old `Ollmost.app` yourself.

- **Why `curl`.** Ollmost isn't signed with an Apple Developer ID. Browsers mark downloads as quarantined, and macOS won't open a quarantined unsigned app: it says Ollmost "can't be verified" or "is damaged". `curl` doesn't add that mark. If you downloaded the `.dmg` or `.zip` from the releases page in a browser, either allow it in System Settings → Privacy & Security → Open Anyway, or run `xattr -dr com.apple.quarantine /Applications/Ollmost.app`.
- **Each Mac has its own data.** Chats, projects and skills live in `~/Library/Application Support/Ollmost/` and don't sync. Upgrading leaves them alone.
- **The ollama.com API key is per Mac.** It's encrypted with that Mac's Keychain, so enter it on each machine. After an upgrade, macOS may ask to let Ollmost use "Ollmost Safe Storage"; choose Always Allow.
- **Local Ollama is per Mac too.** Anything that goes through the Ollama app needs it installed and signed in on that machine.

### Coming from Kiln

Ollmost used to be called Kiln. Install Ollmost as above. On its first launch it moves your chats, projects, files and settings over from `~/Library/Application Support/Kiln`, and the installer then removes `Kiln.app`. Quit Kiln first, or Ollmost waits for it.

Two things don't carry over, because your Mac's keychain tied them to Kiln: your ollama.com API key, and your MCP servers' environment values. Ollmost asks for them again. You can delete the old "Kiln Safe Storage" item in Keychain Access. Notifications ask for permission again, and a Dock icon pinned for Kiln needs pinning again for Ollmost.

## Run it from source

Requirements: macOS, Node 22+, and the [Ollama app](https://ollama.com), or an OpenAI-compatible server (see [Model endpoints](#model-endpoints)). For Ollama cloud models, run `ollama signin` once.

```sh
npm install
npm run dev        # development, with hot reload
npm run build      # production bundle in out/
npm run dist       # Ollmost-arm64/x64 .dmg and .zip in dist/  (or: npx electron-builder --mac --dir  for just the .app)
npm run install:mac  # build, then install/replace /Applications/Ollmost.app and open it (OLLMOST_INSTALL_DIR to change the folder)
```

The app icon is an Icon Composer document, `resources/Ollmost.icon`. After changing it, run `node scripts/make-icon.mjs` (needs Xcode 26 or later) and commit the `Assets.car` and `icon.icns` it writes to `resources/`; building doesn't need Xcode.

Your data lives in `~/Library/Application Support/Ollmost/`: a SQLite database (`ollmost.db`), uploaded files, and your own skills (`skills/`).

## Model endpoints

Ollmost talks to Ollama natively, and to any server that speaks the OpenAI chat-completions API. The ones it's built for run on your Mac: [LM Studio](https://lmstudio.ai) (start its server in the Developer tab), llama.cpp's `llama-server`, and vLLM. LM Studio is the one checked against a live server so far; support for llama.cpp and vLLM follows their documentation. You can set up several endpoints at once in Settings → Models. Every model from every endpoint is in one picker (the chips under its search box filter by endpoint), and each chat remembers which endpoint its model is on, so you can switch a chat from one to another.

- **Adding one.** Settings → Models → + Add endpoint. Type the address (presets: Ollama `:11434`, LM Studio `:1234`, llama.cpp `:8080`, vLLM `:8000`), a key if the server needs one, then Check. Ollmost works out what kind of server it is and what its models can do, and says so before you Add it.
- **What works with every endpoint.** Web search and page reading (they go through ollama.com with your ollama.com key, for every model, including local ones), MCP servers, the code runner, skills, code sessions and sub-agents, with any model that can call tools.
- **Capabilities.** Where a server doesn't report what a model can do, Ollmost assumes tools on, vision off, and the endpoint's "context when not reported" (8,192 tokens unless you change it). Each model's Thinking, Tools, Vision and Context can be overridden in its endpoint's table in Settings → Models. If a server turns tools down, Ollmost switches them off for that model and says which server flag they need.
- **Thinking.** Reasoning is shown whenever a server sends it. Ollama models get their control from their family (see Thinking under [How it works](#how-it-works)), and LM Studio's reported options fill it in; on other OpenAI-compatible servers it only shows reasoning until you pick a profile for the model.
- **Cost.** Only Ollama cloud models are priced. A model on this Mac says `local`; anything else says `cost not tracked`.
- **Keys.** An endpoint's own key is only ever sent to that endpoint, and your ollama.com key only to ollama.com.
- **Removing one** asks first and says what goes: its chats keep their history and need a new model picked; its key and model settings are deleted.
- **Going back to an older Ollmost.** Chats now store their model as `endpoint/model`, which an older version can't read. The upgrade backed your database up first, to `backups/ollmost-before-endpoints-<date>.db` in the data folder: to go back, quit Ollmost, put that file back as `ollmost.db`, and delete `ollmost.db-wal` and `ollmost.db-shm` beside it (a leftover copy of the newer data would otherwise be applied to the older one).

## How it works

```
src/main/        Electron main process: SQLite (node:sqlite), model providers (Ollama, OpenAI-compatible), prompt assembly,
                 streaming + tool loop, file extraction, skills library, artifact:// and ollmost:// protocols
src/preload/     typed contextBridge exposing window.ollmost (contract in src/shared/ipc.ts); main answers
                 only Ollmost's own windows (src/main/ipcSender.ts)
src/shared/      types, artifact parser, thinking profiles, built-in themes (used by both sides)
src/renderer/    React UI: views/, components/, stores/ (zustand), theme/
tests/           Vitest unit tests      e2e/   live Playwright run against real models and stand-in servers
```

- **Models.** Each endpoint lists its own models (see [Model endpoints](#model-endpoints)). For Ollama, the daemon's `/api/tags` is merged with the ollama.com catalog when the endpoint's "Show the Ollama cloud catalog" is on. Cloud models are addressed as `name:cloud` / `name:tag-cloud`, so nothing needs pulling. `/api/show` capabilities drive the UI: the image warning, the thinking control, and automatic skills.
- **Thinking.** `src/shared/thinking.ts` maps each model family to a profile, based on probing the models:
  - gpt-oss: effort levels only; it can't be turned off.
  - glm: always on, because `think:false` leaks its reasoning into the reply.
  - Other models: an on/off toggle.

  You can override the profile per model in Settings → Models.
- **Artifacts.** The model writes `<artifact identifier type title language>` tags; `src/shared/artifactParser.ts` turns them into cards and panel content.
  - HTML and SVG render in a sandboxed iframe (`artifact://`) with no same-origin access and `connect-src 'none'`. Scripts from cdnjs, jsDelivr and unpkg are allowed; you can turn that off in Settings.
  - An updated artifact is saved as a new version, since the model rewrites it in full each time.
  - Any code block of 15+ lines can be promoted with "Open as artifact".
- **Projects in the sidebar.** Pinned projects, and the one open on its page, show under **Projects** as a tree: their knowledge files in folders, then their chats. Files can sit in folders (a folder's menu adds files there or makes a folder inside it; a file's menu previews it with Quick Look, reveals it in Finder, moves it or removes it; dropping files onto a folder adds them to it). Folders are the files' paths, nothing more; one you made is remembered on this Mac until you remove it, even while it is empty. The project page keeps instructions, settings and the file list, grouped by folder. A chat in a project still sees all of its files, whatever the folder.
- **Command palette (⌘K).** Search chats and projects by name or content, and run commands: actions (a new chat or code session, the sidebar, the debugger, adding a skill or an MCP server), places to go (every view and settings tab), and settings with choices: theme, appearance mode, response font, text size, chat width, default model, the usage chip. Moving through a setting's choices previews each one live; Enter keeps it, and Escape or closing the palette puts the saved value back. Recent commands come first, and a query of several words ("set default model") finds the command whose title or keywords hold them all.
- **Slash commands.** Typing `/` in a chat's composer lists commands above skills. A command runs once when sent and never becomes a message. The first is **`/compact [what to keep]`**: it summarizes the whole conversation so far with the chat's model (a history longer than the model's window is summarized in pieces, each folding the summary so far in), and later replies replay the summary plus whatever followed it instead of the messages it covers, which stay in the transcript with a divider where the summary ends (click it to read the summary). Compact again and the earlier summary is folded in with what followed. A summarized message's attachments are no longer sent to the model (you're told when this happens); editing or retrying a message asks first when it would delete later messages or clear the summary. Commands from marketplace plugins are planned.
- **Skills.** Ollmost reads `SKILL.md` folders from three places:
  - Its own `skills/` folder, which you can edit.
  - `~/.ollama/skills`, read-only.
  - `~/.claude/skills`, read-only. These start off, because many rely on Claude-only tools.

  A skill you pick with `/` or the + menu applies to every reply. Models that support tools can also call `load_skill` on their own; a skill loaded that way stays loaded for the rest of the chat.
- **Web search.** When an ollama.com API key is saved (Settings → Usage & cost), models that support tools get `web_search` and `web_fetch`. These call Ollama's web API, so pages are fetched by ollama.com and not your Mac. Searches count toward your Ollama usage.
  - The key stays in the main process and never enters a prompt.
  - Web content is marked as untrusted data, so the model is told not to follow instructions found in pages.
  - Every search and page read shows as a badge in the reply, at the point where the model made it. Click a page badge to open it in your browser.
  - gpt-oss-style names (`browser.open`, `web.run`, …) are routed to the real tools, but only when no offered tool has that name. Tools come from providers registered in `src/main/chat/tools.ts` (skills and web today), and an exact name always wins over an alias.
  - Tools a model invents get one explanation, then they're withdrawn so the turn still ends with an answer.
  - A chat's reply gets up to the number of tool rounds set in Settings → Tools → Chats (20 by default). If the model is still using tools after that, it has to answer with what it found, and the reply offers Continue.
  - Every tool result is capped at 24,000 characters, and the calls in one round share what's left of the context window, so several large results at once can't overflow it. When a turn's results outgrow the context window, older ones from that turn are cut to a one-line note and the newest stay whole; the reply's stats say so. The check uses the server's own token count for the previous request when that's higher than Ollmost's estimate.
- **MCP servers.** Add local (stdio) MCP servers in Settings → Tools: a name, the command and arguments from the server's README, and any environment variables it needs. Ollmost starts a server when a chat that uses it opens, and gives it your login shell's PATH, so `npx`, `uvx` and `docker` are found even when Ollmost was opened from the Dock. Apart from PATH, a server inherits only the basics (`HOME`, `USER`, `LOGNAME`, `SHELL`, `TERM`, `TMPDIR`, `LANG`, `LC_ALL`, `LC_CTYPE`) plus its own variables, never the rest of Ollmost's environment. A server that needs more sets it in its own environment: commonly `SSH_AUTH_SOCK` (git over SSH), `HTTPS_PROXY`/`NO_PROXY` and `NODE_EXTRA_CA_CERTS` (corporate networks). This keeps stray secrets out of servers; it isn't a sandbox, since a server can still read your files.
  - Servers are switched on per chat, from the + menu under **Tools**, because every tool definition is sent with every request. New chats start with the servers marked "Use in new chats". Tool definitions count toward the context budget.
  - Tools are offered as `<server>__<tool>`. Each call asks first (below).
  - Environment values are encrypted with the macOS keychain and never sent to the renderer. Servers run with your permissions and aren't sandboxed: add only ones you trust.
  - A server that can't start, or stops, shows why in Settings → Tools, with its stderr log. A reply that couldn't use one of its chat's servers says so.
  - Each tool can be set to **Ask** (the default), **Always allow** or **Off**. Off keeps its definition out of requests; Settings shows roughly how many tokens each tool and server adds to every request.
  - Trust stays with the program it was given to. Editing a server's command, arguments, working folder or any environment value (a new token can mean a different account) sets its tools back to Ask and clears chats' **Allow for this chat** answers for it. A removed server's id is never reused, and chats forget it. A server can also change a tool itself (its description or input) while running or between runs: a tool you allowed goes back to Ask when it does, and Settings marks it as changed. A server that puts changing details in a tool's description (a date, a count, a folder listing) will ask again each time they change.
  - **Paste JSON** takes the `{"mcpServers": {…}}` snippet server READMEs give (also VS Code's `servers` format). **Import from Claude Desktop / Claude Code** appears when those apps' configs list servers: a one-time copy of the local ones (remote servers are left out), switched off for new chats.
  - A chat's menu lists the tools you allowed there (by tool and server, or site), with a way to go back to asking. Going back takes effect at once, even in a reply that's still running.
  - Ollmost talks to servers through its own stdio transport (`src/main/mcp/transport.ts`), so stopping a server also stops what it started (`npx` runs the real server as a child).
- **Code runner.** Models that support tools can run Python 3 or bash with `run_code`, switched on per chat from the + menu under **Tools** (Settings → Tools → Code runner sets whether it asks first, whether new chats start with it, PyPI access and the time limit). It also answers gpt-oss's built-in `python` tool.
  - Code runs under macOS's sandbox via [`@anthropic-ai/sandbox-runtime`](https://github.com/anthropic-experimental/sandbox-runtime), in a folder of its own for each chat (`workspaces/<chat id>` in Ollmost's data folder, deleted with the chat). It can read system files, but not your home folder, other accounts or `/Users/Shared`, other disks (`/Volumes`), or the temp folders (`/private/var/folders`, `/tmp`), except its own folder, your skills, the Python environment it uses and tool folders on your PATH; it writes only to its folder (and, with PyPI allowed, its chat's Python environment), and can't delete or replace that folder, its `.ollmost` folder or the environment; and it has no network access unless you allow PyPI (then only `pypi.org` and `files.pythonhosted.org`). Nothing runs if the sandbox can't start.
  - Files attached to the chat are copied into `uploads/`. Files a run creates are listed on its card, images are previewed, and each can be shown in Finder or saved. Documents and images can also be previewed with Quick Look, never opened in the app for their type: a file a run wrote may carry the chat's data, and an app that runs a document's scripts or loads its remote images or templates could send it out. SVGs are only shown inline as images (no scripts, nothing loaded), and scripts or apps a run wrote are never opened. Showing a file in Finder marks every file in the chat's folder as downloaded (`com.apple.quarantine`), since Finder shows them all, and saved copies are marked too, so macOS asks before running one.
  - Ollmost works in a chat's folders outside the sandbox (copying uploads in, listing what a run wrote, marking files, deleting them), so it never follows a link code left there. Each piece of that work holds the folder's lock from start to finish: none of the chat's code is running (anything a run left is stopped first) and none starts until the work is done, so Show in Finder is refused while a run is going. Ollmost also replaces a link with a folder where it expects one; it opens a file to preview, save or show only if no part of its path is a link; and a preview is of a copy, never the file in the chat's folder. The script a run executes is kept outside the folder (`runner/scripts/<chat id>`), where code can read it but not change it.
  - Python runs in Ollmost's own environments (venvs made from the `python3` on your PATH), so packages never touch your Python. With PyPI allowed, each chat installs into an environment of its own (`runner/venvs/<chat id>`, made inside the sandbox and deleted with the chat), so code in one chat can't plant code (a `sitecustomize.py`, a `.pth` file, a patched package) that runs in another. Other chats share `runner/base-venv`, which has no pip and no run can write. The package list in Settings is read from disk; nothing in a chat's environment runs outside the sandbox.
  - Skills with scripts work: `load_skill` tells the model where the skill's folder is and to run its scripts with `run_code`.
  - Each run is a separate process in its own process group, stopped at the time limit (2 minutes by default), on Stop, or when Ollmost quits. Code can leave its process group (a daemon that calls `setsid()`), so when a run ends Ollmost also stops every process macOS says is in that chat's sandbox (`sandbox_check`: sandboxed, allowed to write the chat's folder but neither the folder above it nor to delete the folder itself, as only Ollmost's pinned policy is), however it was started. It does the same for every chat at startup, in case Ollmost crashed, and when quitting. A deleted chat whose code couldn't be stopped has its folders removed at the next start.
- **Code sessions.** A model can work in a folder you choose, such as a repository, rather than one Ollmost makes for it: open **Code** in the sidebar, then a folder or a recent one. Ollmost never owns that folder: deleting the session leaves it exactly as it was. What Ollmost keeps of its own is the session's scratch, under `runner/sessions/<id>` in its data folder, deleted with the session.
  - Its tools are `read_file`, `list_files`, `search_files`, `edit_file`, `write_file` and `run_command`. The file tools work outside the sandbox, confined by Ollmost itself: every path resolves to its real path and must stay inside the folder (a write never goes through a link), and none of them will write to `.git`, or to the names the sandbox denies a session's commands anywhere in the path (`.gitconfig`, shell rc files, `.vscode`, `.idea`, `.claude/commands` or `.claude/agents`, `.mcp.json`). `run_command` runs in the same macOS sandbox as the code runner.
  - A command can see its folder, the system, your skills, and any toolchain a PATH entry points into (nvm, cargo/rustup, pyenv, rbenv, asdf, volta, fnm, bun, deno, sdkman, mise, pnpm, go), read-only; not the rest of your home folder. It can write only its folder and the session's own scratch, where `HOME` and the package managers' caches point.
  - Network is one of three presets, set per session from the chip in its header, with a default in Settings → Tools → Code sessions: none, package registries, or registries and git hosts — the only preset that can send data out of your Mac. A change takes effect at the next command.
  - **Plan mode.** The Plan chip in a session's header switches it to planning: the model can read, list and search the folder but `edit_file`, `write_file` and `run_command` are withheld from it (not just refused) until you start working, from the chip or the **Start working** card under its plan; starting work keeps the plan it wrote in front of the model's later turns until you go back to planning. MCP tools switched on for the session stay on and still ask.
  - Edits and commands ask before running, with **Allow for this session** to stop asking for that kind for the rest of the session; Settings → Tools → Code sessions can switch either to always allow.
  - The Changes panel shows what changed in the folder: git status and a selected file's diff, run inside the session's own sandbox, with hooks, fsmonitor, an external diff and textconv switched off, and never run outside it — a folder that isn't a repository could otherwise plant a `.git` file naming a program that git would run as you. A folder that isn't a repository shows the session's own edits instead.
  - Inside a session, git can commit locally, with your `user.name` and `user.email` copied into the session's own `HOME`, but can't push, fetch a private remote, sign a commit, change `.git/config` (or point git at another config through `.git/commondir`, `.git/config.worktree` or `.git/worktrees`), run a hook, or set up a submodule (creating a `.git` in a subfolder is refused, so `git init` or `git clone` into one fails); you push yourself.
  - A project's own instructions come from the first of `OLLMOST.md`, `CLAUDE.md` or `AGENTS.md` found in the folder, cut at 32 KB.
  - Commands stop at the session's time limit (Settings → Tools → Code sessions, 5 minutes by default; a command may ask for up to 30), and whatever a command left running is stopped when it ends.
- **Sub-agents.** A model that has tools can hand a task to a sub-agent with the `delegate` tool: a fresh reply with the same tools, which does the task (research over many pages, a survey of many files) and returns only its result, so the reading never enters the chat's context. The transcript shows a card per sub-agent with its task, its tool calls and its result; a sub-agent asks for the same approvals (answered on that card), stops after at most the number of requests set in Settings → Tools → Sub-agents (20 by default; the chat's own reply limit doesn't bound it), and its requests count toward the chat's usage. Sub-agents a model starts together run at the same time, up to the number set there (3 by default; 1 runs them one after another); a local model serves them all from one server, which may queue some. A sub-agent's reply comes back cut at the reply length set there (about 4,000 words by default), or shorter when the chat is short of room, and the sub-agent is told where it will be cut. A sub-agent can't start one of its own.
- **Approving tool calls.** A tool whose provider asks first waits in the reply with an approval card: **Allow once**, **Allow for this chat** or **Deny**. MCP tools and the code runner ask, and so does any tool whose provider doesn't say otherwise. Skills and web search never ask.
  - `web_fetch` asks before every fetch in a chat with tool sources on (MCP servers or the code runner), or with files in it (attachments, or its project's knowledge), with only **Allow once** and **Deny**. A URL can carry data out (`https://evil.example/?d=…`) and a page or tool result could tell the model to send it; allowing a whole site wouldn't be safe on hosts where anyone can read requests (webhook.site, Apps Script, request bins). A denial covers that site for the rest of that reply (a sub-agent keeps its own).
  - A denied call doesn't run, and the model is told not to try it again unless you ask. Stopping the reply, deleting the chat or quitting counts as a no, and a call that was waiting when Ollmost closed shows as not run.
  - A chat you aren't looking at gets a hand icon in the sidebar and a toast, and the Dock icon shows how many calls are waiting.
  - Processes Ollmost starts run in their own process group (`src/main/processes.ts`), so stopping one also stops anything it started, and quitting stops them all. Live groups are listed in `processes.json` in Ollmost's data folder, so if Ollmost is force-quit or crashes, the next start stops whatever it left running.
- **Links.** Hovering a link in a reply shows a card with its destination: site, full URL, and whether it opens in your browser. It warns when the link text names a different domain than the real destination.
  - An opt-in setting (Settings → Web, artifacts & skills) adds the page's title, description and image, fetched from your Mac. Not in chats with tools or files, though: a link the model writes there could carry their contents out (`https://evil.example/?d=…`), so those cards show the destination only.
  - Local-network and loopback addresses are never fetched, including after redirects.
- **Debugger.** The bug icon in a chat's header, or ⌘⇧D, opens a separate **Ollmost Debugger** window. It shows every request the chat made (each chat round, tool call and title) live, grouped by turn. For each request:
  - **Overview:** timings (first byte, first token, total, plus the server's own load/prompt/generation times when it reports them), prompt tokens counted by the server vs Ollmost's estimate, cost, the finish reason, and stream chunk count.
  - **Prompt anatomy:** where the tokens go (system sections, history, this turn, tool definitions, images), a context-window meter, and every message readable.
  - **Request, Response, Tools:** the exact JSON sent (image bytes replaced by size placeholders; API keys are never recorded), the output with thinking and tool calls, the server's final stats, and the tool schemas offered.
  - **Replay:** edit the recorded request and resend it, without streaming, to the endpoint it was sent to (or be told that endpoint no longer exists), like a playground. It's recorded as a replay and counted as usage.

  The debugger can also copy a request as `curl` (keys appear as environment variables: `$OLLAMA_API_KEY` for ollama.com, `$LM_STUDIO_API_KEY` for an endpoint with the id `lm-studio`, and `$OLLAMA_ENDPOINT_API_KEY` for a key on an endpoint whose id is `ollama`, since `$OLLAMA_API_KEY` is for ollama.com only), export traces as JSON, and open Chromium DevTools. Traces are stored locally, deleted with their chat, and capped at the newest 500. Turn recording off under Settings → Data.
- **Usage & cost.** The title bar shows two chips.
  - **This chat:** tokens and estimated cost so far (`local` or `not tracked` when nothing was priced), including retries and title generation, updated as each round of tool calls ends rather than only when the reply does. Click it for a per-model breakdown and how full the context window is.
  - **Your Ollama quota** (when your ollama.com key is saved, or as a prompt to add one when you have an Ollama endpoint switched on): % used, and time left until the next reset. Its mini bar also marks how much of the period has passed.

  Details:
  - Costs use Ollama's published per-token prices, for Ollama cloud models only; a model on this Mac says `local`, and one elsewhere `cost not tracked`. Ollmost re-reads them at most daily from ollama.com/pricing (at startup, when an Ollama endpoint is switched on) and falls back to a bundled snapshot. Each request is also logged locally (`usage_events`) for Settings → Usage & cost.
  - Quota comes from `ollama.com/api/usage`, which is undocumented and **needs an ollama.com API key** (Settings → Usage & cost). The Ollama app's sign-in doesn't cover it.
  - That endpoint doesn't say when limits reset. Ollmost dates a reset itself when it sees usage drop, or you can enter the time shown on ollama.com/settings.
- **Theming.** Every colour, font and radius is a CSS variable (`src/renderer/src/index.css`), and code highlighting, Mermaid diagrams and the debugger window all take their colours from the active theme. Themes are JSON with a light and a dark palette (or a single palette, marked `only`); you can edit, import and export them from Settings → Appearance. Built in: Clay, Nord, Solarized, Gruvbox, High contrast, Catppuccin (Latte/Mocha), GitHub, Dracula (with Alucard), Rosé Pine (with Dawn) and Hack (dark only, in the Hack typeface).
- **Theme legibility.** `tests/themes.test.ts` checks every built-in palette against WCAG contrast floors: 7:1 for body text on the canvas, 4.5:1 for other text, 3:1 for hints, links, status colours, button labels and syntax colours. Where a theme's published colour falls short (usually an accent on a pale light-mode background), only its lightness is adjusted, and the theme's comment in `src/shared/themes.ts` says which colours moved.

## Tests

```sh
npm test                    # unit: parsing, prompt assembly, file extraction, and the chat loop against a mock Ollama
npm run typecheck
npm run lint                # ESLint (typescript-eslint, React hook rules)
npm run format              # Prettier; format:check only reports
npm run build && npm run e2e   # live: needs Ollama running; uses a throwaway data folder
OLLMOST_E2E_OPENAI_URL=http://localhost:1234/v1 npm run e2e   # also a live check against LM Studio (or any OpenAI-compatible server that needs no key); OLLMOST_E2E_OPENAI_MODEL picks the model
```

`npm test` needs no model server: `tests/ollamaMock.ts` is a stand-in server that streams scripted Ollama NDJSON or OpenAI-compatible SSE (LM Studio's streams are replayed from captures in `tests/fixtures/sse/`; llama.cpp's and vLLM's are written from their documentation). The client and reply-loop tests use it to cover split lines, dropped and stalled streams, error chunks, Stop, tool rounds and saving partial replies. CI (`.github/workflows/ci.yml`) runs the typecheck, lint, format check and unit tests on every pull request.

The e2e run checks:
- streaming, auto-titles, and that IPC only answers Ollmost's own windows
- the artifact sandbox, which renders HTML and blocks network requests and access to the app
- manual and automatic skills
- vision attachments
- project knowledge
- the chat cost chip and account quota, including pace and a dated reset
- theme and dark-mode persistence, including dark-only themes and themes that follow the mode
- tool calls against a mock model: an invented tool gets one explanation then is withdrawn, and web search/fetch works end to end, including gpt-oss-style aliases and citations
- the debugger: every request in a turn, its overview, prompt anatomy, exact request JSON, and replay
- link hover cards: the real destination, a warning when the link text names another domain, and opt-in previews
- a delegated search: the sub-agent card shows its search and result, the answer uses it, the debugger lists a Sub-agent turn
- MCP servers: adding one in Settings, per-chat and per-tool approval, secrets kept out of the renderer, importing another app's config, and stopping servers on quit
- a live model using an MCP tool it can only answer with
- the code runner: sandboxed execution, reading uploads, the files a run writes, a skill's script, and refusing to open anything unsafe
- a live model using the code runner for something it can't do reliably in its head
- code sessions: reading, editing and running commands in a folder of the user's with approvals, the diff an edit's approval shows, the folder left untouched by a deleted session, and the Changes panel's git status and diff
- a live model asking to edit a file in a code session, and denying it
- the command palette: a theme previewed live from its choice list, put back on Escape and on a click outside, kept on Enter, and a theme picked in Settings showing after one chosen in the palette
- model endpoints: adding an OpenAI-compatible server in Settings (Check, then Add), its chip in the picker, the picker fitting a short window, a tool round in OpenAI's shape, the `local` label, switching a chat to the Ollama endpoint, and the quota chip going when there's no Ollama endpoint turned on and no key
- coming from Kiln: migrating data on first launch, waiting for Kiln to quit, and the one-time notice

Screenshots go to `e2e/shots/`. Set `OLLMOST_DEBUG=1` to log every request Ollmost sends to a model server to `debug.log` in the data folder, along with the PATH Ollmost gives processes it starts. Apps opened from the Dock get a bare PATH, so Ollmost reads the one your login shell sets up.

## Releasing

1. Bump `version` in `package.json` and merge it to `main`.
2. Tag that commit and push the tag:
   ```sh
   git tag v0.2.0 && git push origin v0.2.0
   ```

`.github/workflows/release.yml` then runs on a macOS runner. It checks the tag matches `package.json`, runs the typecheck and unit tests, builds, and creates the GitHub Release with `Ollmost-arm64.zip`, `Ollmost-x64.zip` and the matching `.dmg`s. The file names don't change between versions, so `releases/latest/download/Ollmost-arm64.zip` (which the install script uses) always points at the newest build.

Builds are signed ad hoc (`identity: '-'` in `electron-builder.yml`), which is enough for Apple Silicon to run them but not for Gatekeeper to trust a browser download. Signing with a Developer ID and notarizing would remove the browser warning and allow auto-updates with `electron-updater`, but needs the paid Apple Developer Program.

## Known limits (deliberately deferred)

- **Web pages go through ollama.com.** Ollmost can't browse local-network pages or sites behind a login.
- **Web content can try prompt injection.** It's marked as untrusted and every fetch is visible, but a determined page could still steer a model's answer. Treat web-sourced answers with the usual care.
- **Fetches don't ask in chats with no tools and no files.** There `web_fetch` runs unasked, though earlier messages can be private too. The model is told never to put conversation details into URLs, but that's an instruction, not a control.
- **Skill scripts need the code runner, and often PyPI.** With the runner off, skills like docx/pptx/xlsx/pdf get their instructions only and the model produces results directly. Their scripts usually need packages (python-docx, openpyxl…), so allow PyPI in Settings → Tools.
- **MCP servers aren't sandboxed, and only local (stdio) ones are supported.** They run with your permissions, like any tool you install; remote servers need a local bridge such as `mcp-remote`.
- **Tool calls can't be undone.** Editing a message or retrying a reply doesn't reverse what a tool changed (a file an MCP server wrote, say). The code runner only ever writes inside the chat's folder.
- **Automatic skill loading depends on the model.** In testing, gpt-oss loaded a clearly matching skill 80–100% of the time. Picking a skill with `/` always works.
- **React artifacts aren't rendered.** They're shown as JSX source.
- **Scanned PDFs have no text layer.** They're flagged, but there's no OCR.
- **Large projects aren't searched.** Project knowledge goes straight into the context window, with a capacity meter. There's no retrieval for oversized projects.
- **Costs are estimates, and upper bounds.** All input is priced at the full rate; Ollama doesn't report cached tokens (charged far less) or apply off-peak rates per request, so Ollmost's figure can sit above the account's own spend line, most of all for long chats and code sessions, which resend most of their prompt. Ollmost sums its figure over the account's period when that's known (a credit plan's reset day, or the period Ollama reports), over the last 30 days otherwise. Quota reset times are inferred unless you set them.
- **Edits don't keep branches.** Editing a message replaces everything after it; the database has room for branch navigation later.
- **A code session's commands are finite.** A dev server or a file watcher a session starts stops when its command's process ends; there's no way to leave one running in the background.
- **A code session's tool results from earlier turns are kept in brief.** A model that needs a file's contents again re-reads it, rather than trusting what it remembers from a summary.
- **No terminal, no git buttons, no attachments and no worktrees in a code session.** It's the model's tools, the chat and the Changes panel; a repository's own `.mcp.json` isn't read either, and there's no per-command allow pattern, only per-kind (edits, commands).
- **In a folder that isn't a repository, a `.git` file a session writes can name a hook or fsmonitor program.** Ollmost's own git, run inside a session's sandbox, won't run it, but your own git, run on the folder later and outside Ollmost, will: treat such a folder the way you'd treat one a script had run in. In a repository, `.git/config`, the hooks, `commondir`, `config.worktree`, `worktrees` and `modules` are read-only to a session, and creating a `.git` in a subfolder (what a submodule your git would enter needs) is refused, in any spelling; an approved command can still bring one in by moving a folder made in the session's scratch into the folder and staging it ([#111](https://github.com/EdCarney/ollmost/issues/111)), so the rule above holds for repositories too.
- **Ollmost's PATH comes from your login shell, read once at startup.** That runs your dotfiles, so whatever they set up (or break) carries into every code session's commands until Ollmost restarts.
- **A large or hostile `.gitignore` can slow a code session's file tools down.** Listing and searching walk the folder respecting it; one pathological pattern can stall a listing.
- **A code session's file tools read and write through hard links, as its commands do.** A hard link to something outside the folder is followed like any file inside it.
- **A code session's writes aren't atomic.** A crash or a forced quit mid-write can leave a file partly written.
- **Non-UTF-8 files can't be edited or written in a code session**, though `read_file` and its commands can still read and change them.
- **An ignored folder lists as empty in a code session.** `list_files` and `search_files` leave out what `.gitignore` ignores; `run_command` with `ls` or `grep` sees everything.
- **Two code sessions on one folder take turns for file work, but their commands can overlap.** The folder's lock serialises reads, edits and writes; two `run_command` calls from different sessions on the same folder can still run at once.
- **A reply and the Changes panel share that same lock.** The panel is refused while a reply runs in any session on the folder (it says so; look again when the reply ends), a reply starting stops a refresh already going (the panel says a reply started), and a refresh already going can cost a starting reply its tools for a moment, the way one session's command can cost another's.
- **Nested code session folders don't share a lock.** A session on a folder and another on a folder inside it don't know about each other ([#94](https://github.com/EdCarney/ollmost/issues/94)).
- **The Changes panel needs the Command Line Tools, and a folder that is a repository's own top level.** A folder inside a repository shows as not one: git is told not to look above the folder (and under your home folder the parent is out of the sandbox's sight anyway); a repository git can't read shows an error line instead of a file list.
- **The panel and a session's git don't read your global git config.** Your global excludes file (`core.excludesFile`) isn't applied, so files your global gitignore hides (`.DS_Store`, editor folders) show as untracked in the panel and to a session's `git status`; a repository's own `.gitignore` applies as usual.
- **The Changes panel shows what git reports, not a tamper-proof review.** A session's commands can hide changes from `git status` (`update-index --skip-worktree`, `.git/info/exclude`): read the panel as you would `git status` in a folder a script worked in.
- **A repository's own clean filter still runs when the Changes panel refreshes.** It's confined by the sandbox like any of the session's own git commands; only the fsmonitor, hooks, an external diff and textconv are switched off for the panel's git.
- **Code sessions are macOS only.** They need the same sandbox as the code runner.
- **tok/s is measured on this Mac when a server doesn't report it.** Ollama's cloud models, LM Studio and vLLM send no generation time, so their replies' tok/s runs from the first token to the end, network time included. A request that streamed no text (only a tool call), or finished within 50 ms of its first token, is left out of the figure.
- **Cost tracking covers Ollama cloud models only.** Other endpoints show `local` (on this Mac) or `cost not tracked`; there's no price editor, and costs a provider reports aren't read.
- **The thinking control is opt-in on OpenAI-compatible servers.** Ollmost shows whatever reasoning the server streams, but only sends a thinking setting once you pick a profile for the model in Settings → Models (LM Studio's reported options are filled in for you).
- **vLLM needs flags for tools.** Start it with `--enable-auto-tool-choice --tool-call-parser <the parser for your model>`; without them it turns tool requests down, and Ollmost switches tools off for that model.
- **llama.cpp needs `--jinja` for tools.** Without it `llama-server` can't use tools, and Ollmost switches them off for that model.
- **Remote and paid OpenAI-compatible APIs aren't officially supported.** You can add one and it will work, but its replies say "cost not tracked", and only a Bearer key is supported.
