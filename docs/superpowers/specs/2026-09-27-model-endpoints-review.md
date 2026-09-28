# Generic model endpoints — codebase review (2026-09-27)

Status: brainstorming. Review only; no design approved, nothing changed in the repo.
Goal: point Ollmost at Ollama (native), LM Studio, vLLM, llama.cpp server and other OpenAI-compatible
`/v1/chat/completions` servers.

Line numbers are against `main` @ d0fb62b. The round loop moves to `src/main/chat/rounds.ts` on the
sub-agents branches, so re-anchor after #125 / `claude/sub-agents-2` land.

## How it works today

- `src/main/ollama/client.ts`: one target. `connection.mode` is `local` (daemon at `connection.host`) or
  `direct` (ollama.com + the ollama.com API key). Everything is NDJSON `/api/chat`; `chatOnce` sends
  `stream:false`. It also reads `/api/tags` and `/api/show`. `isCloudName` is `/(:|-)cloud$/`.
- `ChatBody` / `OllamaMessage` / `ChatChunk` are consumed directly by:
  - `service.ts` `generate()`, `compact`/`summarizeOnce`, title;
  - `assemble.ts` (history replay);
  - `debug/replay.ts`, `debug/traces.ts`;
  - on the branch, `rounds.ts` and `delegate.ts`.

  There is no adapter seam.
- Tool definitions (`OllamaTool`) already use the OpenAI function-tool shape. MCP tool names are capped at 64
  characters, the OpenAI limit. `argsOf` in `tools.ts` already accepts arguments sent as a string.
- The renderer thinking stream (`shared/thinkingStream.ts`) doesn't depend on which API is behind it.

## Areas that must change

### Transport and loop
1. **`ollama/client.ts`** becomes one adapter behind a provider interface. It needs a new
   OpenAI-compatible adapter that handles:
   - SSE `data:` lines, with `[DONE]` as the end marker (missing `[DONE]` counts as a dropped connection);
   - `choices[0].delta` content;
   - `reasoning_content` or `reasoning`;
   - tool calls arriving as deltas, merged by `index` and JSON-parsed at the end;
   - `finish_reason`;
   - `usage` sent with `stream_options.include_usage`.
2. **Round loop** (`service.ts:550-606` → `rounds.ts`):
   - `calls.push(...m.tool_calls)` assumes each call arrives whole.
   - The assistant message echoes calls with no id; tool results use `tool_name` (the OpenAI shape needs
     `tool_call_id`).
   - `final.prompt_eval_count` / `eval_count` / `eval_duration` (in ns) / `done_reason` must come from a
     neutral "done" event instead.
3. **`assemble.ts:136-153`**:
   - Earlier tool calls are replayed without ids, so the adapter must synthesise them (`ToolEvent` has no id).
   - Images go out as bare base64 in `images[]`, with the mime type lost in `files/ingest.ts:66-75`.
     OpenAI needs `image_url` data URLs.
4. **Title and `/compact`**:
   - `options.temperature` goes at the top level for OpenAI.
   - `think` needs mapping per provider.
   - `<think>` stripping already exists in the title and compact paths.
5. **`<think>` in streamed content**: servers that don't split reasoning out (llama.cpp without
   `--reasoning-format`, LM Studio with the setting off) need a streaming tag splitter that handles tags split
   across chunks.

### Model identity (a bare name everywhere)
6. Model identity is a bare name string with no provider:
   - the `model` columns of `conversations`, `messages`, `usage_events`, `traces` and `model_profiles`
     (`migrations.ts:30,47,91-96,128,146`);
   - settings `defaultModel` / `titleModel`;
   - IPC `model: string` (`shared/ipc.ts:59,132-140,218`);
   - renderer lookups `findModel`, `thinkProfileFor` and `contextWindowFor` (`stores/app.ts:191-204`);
   - React keys.

   `listModels` builds a `Map` keyed by name, so the same name on two endpoints collapses into one entry.
   Legacy Ollama names can contain `/` (e.g. `hf.co/...`) and `:`, so any "prefix" encoding needs a full
   migration of the existing rows.

### Capabilities and context
7. Capabilities come from `/api/show`, which has no OpenAI-compatible equivalent. The fallback is
   `['completion']`, which means no tools, and so no web tools, skills, code runner or code sessions.
   The options are:
   - server-specific probes: LM Studio's native `/api/v0/models`, vLLM's `/v1/models` `max_model_len`,
     llama.cpp's `/props`;
   - otherwise a per-model manual override for vision, tools, thinking and context length.
8. Context window:
   - `shared/context.ts` sends `num_ctx` for "local". Only Ollama can do that; everywhere else the server
     fixes the window when it loads the model.
   - With an unknown context, history trimming has no budget, and vLLM rejects overflow with a 400.
9. Thinking controls:
   - `shared/thinking.ts` `toOllamaThink` is Ollama-only.
   - OpenAI-compatible servers use `reasoning_effort` (gpt-oss) or `chat_template_kwargs.enable_thinking`
     (Qwen3 on vLLM, llama.cpp or SGLang), or nothing.
   - The default for non-Ollama providers should display reasoning only, with an opt-in override.
10. Timeouts: `streamTimeoutsFor(location)` exists because Ollama holds back tool calls until they're complete.
    With OpenAI-style deltas, tool arguments stream as they're written. The first byte can still be slow
    (a cold load or LM Studio just-in-time load), so each provider sets its own values.

### Settings and secrets
11. `connection {mode, host}` becomes `providers[]`: an id, kind, name, base URL, per-provider key, enabled flag,
    and Ollama-only extras (cloud catalog, `num_ctx`).
    - Gotcha: `updateSettings` (`settings.ts:55-57`) and `SettingsView` `saveConnection` (`:706`) only
      pass `mode` and `host` through, so any new field is silently dropped.
12. There is one API key (kv `apiKey`), used for direct-mode chat, `/api/usage` and web tools. It must become
    per-provider secrets, or an endpoint key could be sent to ollama.com (`account.ts:46`).
    - #101 (git hosting, design PR #124) also needs scoped credential storage. Share one secrets helper.

### Usage, cost and quota
13. What counts as billed is `connectionMode()==='direct' || isCloudName()` (`usage/pricing.ts:68-75`).
    `cost_usd = 0` doubles as the "local" marker in:
    - `Messages.tsx:538`;
    - `UsageBar.tsx:323,353`;
    - `SettingsView.tsx:566`.

    `ModelInfo.location` mixes three things: where the model runs ("On this Mac"), whether it's billed, and
    whether Ollmost controls `num_ctx`.
14. What happens to a new endpoint today:
    - A self-hosted endpoint falls into "local, $0", which is fine for LM Studio or vLLM on your own hardware.
    - A remote vLLM server would be labelled "On this Mac".
    - A paid OpenAI-compatible API would show $0 "local".
    - Name collisions with the ollama.com price table (`priceFor` falls back to the prefix before `:`) could
      apply Ollama prices to another provider's models.
15. The quota chip (`TopBar.tsx:29`, `UsageBar.tsx:132-305`) and polling (`App.tsx:37`) always run.
    `/api/me` goes to `connection.host`, which would 404 on a non-Ollama host and retry on every load.
    All of this should be gated on "an Ollama provider with an ollama.com key".
16. Web tools (`ollama/web.ts`) only need the ollama.com key and are independent of the chat provider. Keep them
    that way; they work with any model that supports tools.

### Debug and tests
17. Traces store the raw Ollama body, the endpoint and the final chunk. Replay re-sends the stored body to the
    *current* `/api/chat`.
    - Needs: provider and dialect on the trace, with a missing value treated as `ollama`.
    - Needs: replay sent to the trace's own provider.
    - `TraceView` labels ("Ollama: model load…"), `Anatomy`, and `toCurl` auth (`shared/debug.ts:102`) need
      updating.
18. Tests:
    - `tests/ollamaMock.ts` needs an SSE dialect.
    - Client tests should run against both adapters.
    - Service tests need a second dialect.
    - `e2e/run.mjs` has five separate fake-Ollama servers and "Ollama usage" selectors; fold the fakes into
      one factory and make the usage checks conditional.
19. User-facing copy:
    - `HomeView.tsx:31`, `codeActions.ts:12`, `client.ts` `friendly()` and the error strings;
    - the `SettingsView` Models tab;
    - `ModelPicker` "On this Mac".
    - `paletteCommands.ts:44` points "connection" at the General tab, but the setting lives on Models.
    - The skills source named `ollama` (`~/.ollama/skills`) has nothing to do with the provider. Leave it.

## Blockers
- **Sequencing:** #125 plus `claude/sub-agents-2` (16 commits, under active work) move the round loop to
  `rounds.ts` and add `delegate.ts`, a second `ChatBody` builder. Start only after both land.
- **Seam:** there are no neutral chat types. First step: a pure refactor with Ollama as the only adapter, with no
  change in behaviour.
- **Model identity:** needs a DB and settings migration before a second provider can exist.
- **Capability discovery:** without it, tools are off on every non-Ollama model.
- **Secrets:** the single shared key must be split before any keyed endpoint.
- **`location` and the `cost=0` sentinel:** must be split into where the model runs, billing, and context control.

## Related open issues to re-target onto the provider interface (or label Ollama-only)
#11 pull/delete, #12 loaded models/`keep_alive`, #13 warm-up, #14 per-model options/`num_ctx`, #16 health polling,
#17 title model evicting the chat model (the same issue exists with LM Studio just-in-time loading),
#18 prompt caching, #19 token calibration, #20 friendlier errors, #30 side-by-side compare (needs model refs).

## Approaches considered
A. **Recommended:** neutral internal request and event types behind a `Provider` interface. The native
   Ollama adapter is kept, and one OpenAI-compatible adapter is hand-written. This matches the repo's
   lean-dependency style.

B. Keep Ollama shapes as the lingua franca and translate OpenAI-compatible traffic to and from them. The diff
   is smaller, but it leaks `num_ctx`, `think`, nanosecond durations and `tool_name` into the generic path,
   and the tool ids have to be smuggled through.

C. Use OpenAI-compatible everywhere, including Ollama's `/v1`. This loses `num_ctx` control (Ollama's `/v1`
   can't set it), `/api/show` capabilities, the Ollama think levels, eval durations and the cloud catalog, which
   is a regression for the main use case.

(D. Vercel AI SDK or a similar library: a heavy dependency that doesn't fit the tuned timeouts, traces and mock
tests.)

## Rough phasing (to be finalised after design approval)
0. After the sub-agents work lands: neutral types and the `Provider` interface, with Ollama as the only adapter.
   No behaviour change.
1. Provider registry and settings migration, per-provider secrets, provider-qualified model refs (DB migration),
   picker grouped by provider.
2. OpenAI-compatible adapter: SSE, tool-call deltas, usage, reasoning fields and the `<think>` splitter, image
   parts, model listing with discovery probes, and manual capability and context overrides.
3. Billing kind instead of `location`/`cost=0`, quota UI gated on Ollama, copy changes, provider-aware traces
   and replay.
4. Tests, the e2e factory, README.

## Open questions (brainstorming, asked one at a time)
1. ~~Several endpoints at once, or one active endpoint at a time?~~ **Decided 2026-09-27: several at once.**
   Models from every configured endpoint appear in one picker, and each chat remembers its provider.
2. ~~Are remote or paid OpenAI-compatible APIs in scope?~~ **Decided 2026-09-27: option A, self-hosted only.**
   - Ollmost is Ollama-first; the support we advertise is for local endpoints (LM Studio, vLLM, llama.cpp).
   - Remote or paid OpenAI-compatible endpoints can be pointed at and will work, but won't get full app support.
     They show "cost not tracked"; there's no price editor and no provider-reported cost.
   - Each endpoint has a billing kind: Ollama cloud is "priced", everything else is "not billed".
   - Usage rows store the endpoint id, so options B and C can be added later without another migration.
   - The Ollama quota chip shows only when an Ollama endpoint with an ollama.com key is set up.
   - Split `cost_usd = 0` into three states: priced, not billed, unknown.
3. ~~How should Ollmost learn what a non-Ollama model can do?~~ **Decided 2026-09-27: option A, auto-detect the
   server type and probe it, with manual per-model overrides.**
   - What each server reports:

     | Server | Where | Context | Vision | Tools | Reasoning |
     |---|---|---|---|---|---|
     | LM Studio 0.4+ | `GET /api/v1/models` | `max_context_length`, `loaded_instances[].config.context_length` | `capabilities.vision` | `capabilities.trained_for_tool_use` | `capabilities.reasoning.{allowed_options,default}` |
     | llama.cpp | `GET /props` | `n_ctx` | `modalities.vision` | `chat_template_caps` (tools need `--jinja`) | `reasoning_content` |
     | vLLM | `GET /v1/models` | `max_model_len` | — | — (needs `--enable-auto-tool-choice`) | `reasoning`, formerly `reasoning_content` |
     | Other OpenAI-compatible | `/v1/models` | — | — | — | — |

   - Prefer the loaded context size over the model's maximum.
   - Defaults for anything not reported:
     - Tools on. On a rejection, show a message naming the server flag and switch tools off for that model.
     - Vision off.
     - Reasoning shown if the server streams it.
     - Context size from a per-endpoint setting.
   - Overrides (vision, tools, thinking, context) live in Settings → Models, in `model_profiles` keyed by
     endpoint plus model.
4. ~~Thinking controls for non-Ollama endpoints?~~ **Decided 2026-09-27: option A, show reasoning by default, with an
   opt-in control.**
   - Reasoning is always shown when a server sends it: `reasoning` / `reasoning_content`, or a new streaming
     `<think>` splitter.
   - The thinking profile is pre-filled where the server reports its options (LM Studio's
     `capabilities.reasoning`). Otherwise it's display-only until you set a profile override per model.
   - Each adapter translates the choice for its server: toggle → `chat_template_kwargs.enable_thinking`,
     levels → `reasoning_effort`.
   - Verify against a real server: LM Studio's docs don't list a thinking parameter on `/v1/chat/completions`.

## Design approvals
- **Section 1: architecture. Approved 2026-09-27.**
  - `src/main/providers/`: `types.ts`, `registry.ts`, `ollama/` (the existing client and models files, moved),
    `openai/`.
  - The `Provider` interface: `listModels`, `modelInfo`, `chatStream` (neutral `ChatEvent`s), `chatOnce`, and
    `wire()` for traces.
  - The shared format follows OpenAI's: tool calls carry ids and results carry `toolCallId`.
  - Adapters deliver each tool call only once it's complete; the OpenAI adapter collects deltas by `index`.
  - Adapters map the think setting, context and temperature into their server's parameters, and own their
    timeouts and error wording.
  - All callers (`rounds.ts`, `delegate.ts`, title, compact, replay) go through `registry.resolve(key)`.
- **Adjustment 2026-09-27: the ollama.com key is an app-level "ollama.com account" setting, separate from
  endpoints.**
  - It powers web tools (usable by ANY tools-capable model, including LM Studio, vLLM and llama.cpp), quota, and
    an Ollama endpoint whose base URL is ollama.com.
  - The quota chip shows whenever the key is saved. This replaces decision 2's "Ollama endpoint + key" gate.
  - Endpoint keys (e.g. vLLM `--api-key`) are stored per endpoint and never sent to ollama.com.
  - Settings text states that web search and fetch go through ollama.com even for local models.
- **Section 2: endpoints, model identity, migration. Approved 2026-09-27.**
  - `settings.endpoints: Endpoint[]`, with fields `id` (slug, `[a-z0-9-]`, never changes), `name`, `kind`,
    `flavor`, `baseUrl`, `enabled`, `hasKey`, and per kind: Ollama `showCloudCatalog`/`numCtx`,
    OpenAI-compatible `defaultContext`.
  - Keys are stored in kv `endpointKey:<id>` (safeStorage). An Ollama endpoint on ollama.com uses the account
    key.
  - Adding an endpoint probes the URL (`/api/version`, `/api/v1/models`, `/props`, `/v1/models`) and fills in
    the details.
  - Removing one asks first and lists what goes.
  - Endpoints get their own IPC (`endpoints.list/add/update/remove/probe/setKey`), outside the settings
    deep-merge.
  - Model identity is `ModelKey = "endpointId/model"` (branded), split on the first `/`. Only
    `registry.resolve` splits it. A string without a known prefix falls back to `ollama`.
  - `ModelInfo` gains `key`, `endpoint`, `where` (cloud | this-mac | network), `billing` (priced | free) and
    `contextControl` (client | server), which replace `location`.
  - `ModelOverrides` gains `vision`, `tools` and `contextLength`.
  - `ModelListResult.errors` is reported per endpoint.
  - Migration:
    - The settings JS turns `connection` into an endpoint with id `ollama`, and prefixes
      `defaultModel`/`titleModel` with `ollama/`.
    - One SQL entry prefixes `model` with `ollama/` in `conversations`, `messages`, `usage_events`, `traces`
      and `model_profiles`.
- **Section 3: the OpenAI-compatible adapter. Approved 2026-09-27.**
  - Request mapping:
    - images as `image_url` data URLs (`imageForModel` returns the mime type);
    - tool calls with ids and JSON-string arguments; `tool` results with `tool_call_id`;
    - ids made up for earlier turns' calls (`call_<turn>_<n>`); earlier reasoning not sent back;
    - think: toggle → `chat_template_kwargs.enable_thinking`, levels → `reasoning_effort`;
    - no context parameter; `temperature` at the top level; `stream_options.include_usage` (retry without it
      once, and remember that per endpoint).
  - SSE parsing:
    - `data:` lines, `[DONE]`; ending without `finish_reason` or `[DONE]` counts as a drop;
    - `delta.reasoning ?? reasoning_content`;
    - a leading-only `<think>` splitter, with a hold-back and support for a reply that starts mid-thinking;
    - tool-call deltas collected by index and delivered complete;
    - `finish_reason`, `usage`, and llama.cpp `timings`.
  - Discovery per flavor, as in the decision 3 table. The generic flavor hides embedding and rerank models by
    name.
  - Timeouts depend on `where`. Errors are worded per server, including flag hints for tools rejections and
    learning the context size from overflow errors.
  - Values Ollmost detects are stored apart from the user's overrides. Precedence: user > detected > reported >
    default.
  - The plan starts with a capture spike: record real SSE from LM Studio, llama.cpp and vLLM as test fixtures.
- **Section 4: callers, traces, replay. Approved 2026-09-27.**
  - `rounds.ts` and `delegate.ts` substitute the neutral pieces: `registry.modelInfo(key)`,
    `ChatRequest{think, profile, contextWindow, tools, messages}`, and `provider.chatStream`, switching on
    `ev.type`. Usage comes from `done.usage`; tok/s from `done.timing.genMs`, else the clock.
  - Assistant echo carries `toolCalls` with ids; results carry `toolCallId` and `toolName`. `provider.wire(req)`
    goes to the trace.
  - Approvals, shortening, checkpoints and round limits don't change.
  - `assemble.ts` emits neutral messages, gives earlier tool calls stable ids (`call_<turn>_<n>`) so requests are
    byte-identical on replay, and sends images as `{data, mime}`.
  - Title and compact: `titleModel` is a `ModelKey`, default "same as chat" (see #17); `think` is the lowest the
    profile allows; `req.temperature`; the same `contextWindow`, so Ollama doesn't reload. `<think>` stripping
    stays.
  - Context: `effectiveContext` depends on `contextControl`.
    - `client`: `min(contextLength ?? endpoint.numCtx, endpoint.numCtx)`.
    - `server`: user > detected > loaded/reported > `endpoint.defaultContext`.
    - Computed in main as `ModelInfo.contextWindow`.
  - Traces:
    - The `model` column holds the key. The JSON gains `dialect` and `auth`; a missing value means Ollama.
    - Replay goes to the trace's own endpoint via `provider.sendWire(body)`.
    - `redactImages`/`stripImagePlaceholders` handle `image_url`; anatomy works in both formats.
    - "Server: …" timing labels; curl env var per endpoint.
  - IPC: `chat.regenerate/edit/compact`, `code.create` and the conversation patch take `ModelKey`;
    `models.info/setOverrides` are keyed by it.
- **Section 5 UI, picker: option B chosen 2026-09-27.**
  - Endpoint filter chips (All · each endpoint) sit under the search box. An offline endpoint is a dashed ⚠ chip;
    clicking it shows the error and Retry.
  - The list below has a section per endpoint. Ollama keeps its Cloud / On this Mac split. The current model's
    endpoint moves to the top.
  - The trigger shows "model · Endpoint" only for non-Ollama models.
  - Mockup: docs/superpowers/specs/2026-09-27-model-endpoints-mockups/picker.html
- **Section 5 UI, Settings: option B chosen 2026-09-27.** Master–detail inside the Models tab.
  - Left column: the endpoints (status dot), "+ Add endpoint", then "ollama.com account" and "Defaults".
  - Right column: the selected endpoint's settings (name, address, key, context when not reported / `num_ctx` for
    Ollama, cloud catalog for Ollama, enabled, Re-detect, Remove…), then that endpoint's models table.
  - The models table has columns Thinking | Tools | Vision | Context | Artifacts | Auto skills. Each shows
    "Auto (value)", and a detected value carries a short reason.
  - "Add endpoint" dialog:
    - Step 1: address (presets :11434 / :1234 / :8080 / :8000) and an optional key, then Check.
    - Step 2: a "Found <server> · N models · capabilities…" summary, a name, then Add.
  - Mockup: docs/superpowers/specs/2026-09-27-model-endpoints-mockups/settings-endpoints.html
- **Section 5: usage, cost, quota, wording. Approved 2026-09-27.**
  - `ModelInfo.billing` refined to `priced | local | untracked`:
    - priced: Ollama cloud models;
    - local: any endpoint on a loopback address;
    - untracked: any other address.
  - Labels: `$x` / "local" / "cost not tracked".
  - `usage_events.billing` column. The migration marks a row priced if its cost is above 0, NULL, or its name
    ends in `-cloud`; otherwise local. It replaces the cost=0 sentinel.
  - Totals are unknown only when a priced row has no price. The per-day view and the debugger use the same rule.
  - Billing is decided when the row is written.
  - Quota chip:
    - key saved → shown;
    - no key but an Ollama endpoint → the "add key" chip;
    - neither → hidden, with no polling.
  - `/api/me` goes to a loopback Ollama endpoint only, and failures are remembered for the session.
  - The pricing fetch runs only when an Ollama endpoint exists.
  - Defaults menus are grouped by endpoint; the title model stays "Same as the chat".
  - Wording: the Home error lists each endpoint, the web toggle notes that it goes through ollama.com, palette
    keywords go to the Models tab, and the README gains a "Model endpoints" section and new known limits.
