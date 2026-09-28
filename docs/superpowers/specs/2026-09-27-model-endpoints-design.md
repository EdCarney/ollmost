# Model endpoints: Ollmost talks to Ollama, LM Studio, llama.cpp, vLLM and other OpenAI-compatible servers

Design written 2026-09-27 with the user, section by section, on the state of `main` at d0fb62b (after #122 and
#123), and approved the same day. The round loop is described as it is since #125 and #131 (`claude/sub-agents-2`):
`src/main/chat/rounds.ts` (`runRounds`) and `src/main/chat/delegate.ts`. #175 has since run a round's sub-agents at
the same time, up to a limit set in Settings; the seam keeps that. The codebase review behind it is
`docs/superpowers/specs/2026-09-27-model-endpoints-review.md`, the mockups are in
`docs/superpowers/specs/2026-09-27-model-endpoints-mockups/`, and the plan is
`docs/superpowers/plans/2026-09-27-model-endpoints.md`. All of them came into the repo with the first PR (the
provider seam).

## What this is for

Ollmost is Ollama-first. This change keeps that and adds a second kind of model server: anything that speaks the
OpenAI chat-completions API. The servers we advertise are local ones: LM Studio, llama.cpp's `llama-server`, and
vLLM. Several endpoints can be configured at once. Models from all of them appear in one picker, and every chat
remembers which endpoint its model lives on.

Everything Ollmost runs itself works with any model that can call tools: web search and fetch (through ollama.com,
with the ollama.com key), MCP servers, the code runner, skills, code sessions and sub-agents. What a non-Ollama
endpoint doesn't get is cost tracking, and its thinking control is opt-in.

A remote or paid OpenAI-compatible API can be added and will work, but it isn't advertised or fully supported. Its
replies say "cost not tracked".

## Rulings

Decisions taken with the user, with the cost of each if it turns out wrong.

- **Several endpoints at once, not one active endpoint.** The identity migration below is needed either way: as soon
  as a user switches endpoints, old chats would point at models that aren't there. Cost if wrong: a slightly bigger
  Settings screen.
- **Neutral types behind a `Provider` interface; native Ollama is kept; one hand-written OpenAI-compatible adapter;
  no new dependencies.** Using OpenAI-compatible everywhere (Ollama's `/v1`) would lose `num_ctx` control,
  `/api/show` capabilities, Ollama's think levels and the cloud catalog. An SDK such as the Vercel AI SDK doesn't
  fit the tuned timeouts, traces and mock-server tests. Cost if wrong: we maintain an SSE parser (about 200 lines).
- **Cost tracking covers Ollama cloud only.** Other endpoints are `local` (a loopback address) or `untracked`
  (anything else). There's no price editor and no use of provider-reported costs, but usage rows carry enough
  (model key and `billing`) to add either later without another migration. Cost if wrong: someone on a paid API sees
  "cost not tracked".
- **Capabilities: detect the server type, read what it reports, and let the user override per model.** Defaults
  where a server reports nothing:
  - tools on;
  - vision off;
  - reasoning shown if the server streams it;
  - context from a per-endpoint setting.

  Cost if wrong: a model on a generic server may need one override before tools or vision work.
- **Thinking: shown by default, controlled on request.** Reasoning is shown whenever a server sends it. The control
  is pre-filled where the server reports its options (LM Studio). Elsewhere it's display-only until the user picks a
  profile per model. Cost if wrong: a Qwen3 user on llama.cpp sets one override to turn thinking off.
- **The ollama.com key is an app-level "ollama.com account", separate from endpoints.** It powers web tools (for any
  model), quota, and an Ollama endpoint whose address is ollama.com. Endpoint keys are separate and are never sent to
  ollama.com. Cost if wrong: none worth counting; it's the same key row as today.
- **Model identity is a key string, `endpointId/model`.** The alternative, a `provider` column and a
  `{provider, model}` object across IPC, stores and React keys, costs far more churn for the same result. Cost if
  wrong: discipline, since a raw model name must never leave an adapter and a leaked key would fail loudly at the
  server. This is guarded by a branded type and tests.
- **The database migration is one-way, so the database is backed up first.** An older Ollmost can't read prefixed
  model names. Cost if wrong: a downgrade means restoring the backup.

## Shape

### Providers (`src/main/providers/`)

```
providers/
  types.ts      ChatRequest, ChatMessage, ChatEvent, ChatResult, Provider, ModelKey, Endpoint
  registry.ts   one Provider per enabled endpoint; resolve(key); modelInfo(key); listAllModels()
  secrets.ts    setSecret/getSecret with safeStorage (the ollama.com key keeps its kv row 'apiKey';
                endpoint keys are 'endpointKey:<id>'); #101's credentials use the same helper
  ollama/       today's src/main/ollama/client.ts and models.ts moved here, behind the interface
  openai/       sse.ts, client.ts, discovery.ts, think.ts, thinkSplitter.ts
```

`src/main/ollama/web.ts` (web search and fetch) and `src/main/usage/account.ts` (quota) stay where they are. They
are ollama.com account services tied to the ollama.com key, not to the model that's replying.

```ts
type ModelKey = string & { readonly __brand: 'ModelKey' }   // "ollama/gpt-oss:120b-cloud", "lmstudio/qwen/qwen3-8b"

interface ToolCallOut { id: string; name: string; args: Record<string, unknown> | string }

interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
  thinking?: string                                   // sent back only by the Ollama adapter
  images?: { data: string; mime: string }[]           // base64 without a prefix
  toolCalls?: ToolCallOut[]
  toolCallId?: string                                 // role 'tool'
  toolName?: string                                   // role 'tool'
}

interface ChatRequest {
  model: string                                       // the raw name, as the server knows it
  messages: ChatMessage[]
  tools?: ToolDef[]                                   // today's OllamaTool, renamed; already OpenAI's shape
  think: ThinkSetting | null
  profile: ThinkProfile
  contextWindow: number | null
  temperature?: number
}

type ChatEvent =
  | { type: 'content'; text: string }
  | { type: 'thinking'; text: string }
  | { type: 'toolCall'; call: ToolCallOut }           // only when complete
  | { type: 'done'; usage: { prompt?: number; completion?: number }; finishReason?: string;
      timing?: { loadMs?: number; promptMs?: number; genMs?: number }; raw: unknown }

interface ChatResult { content: string; thinking: string; toolCalls: ToolCallOut[];
  usage: { prompt?: number; completion?: number }; finishReason?: string; timing?: ChatTiming; raw: unknown }

interface Provider {
  endpoint: Endpoint
  listModels(refresh: boolean): Promise<ModelInfo[]>
  modelInfo(model: string, refresh?: boolean): Promise<ModelInfo>
  chatStream(req: ChatRequest, signal: AbortSignal): AsyncGenerator<ChatEvent>
  chatOnce(req: ChatRequest, opts: { signal?: AbortSignal; timeoutMs: number }): Promise<ChatResult>
  wire(req: ChatRequest, stream: boolean): { endpoint: string; body: unknown }   // exactly what is sent (traces, curl)
  wireEndpoint(): string                                                         // where wire bodies go (replay)
  sendWire(body: unknown, opts: { signal?: AbortSignal; timeoutMs: number }): Promise<ChatResult> // replay of an edited body
}
```

Rules:

1. **The shared format follows OpenAI's.** Tool calls carry ids and tool results carry `toolCallId`. The Ollama
   adapter drops the ids Ollmost made up and sends `tool_name`; a call Ollama sent goes back exactly as Ollama sent
   it, with its own id and index.
2. **Adapters deliver a tool call only when it's complete.** The loop keeps its "calls arrive whole" assumption.
3. **Adapters translate `think`/`profile`, `contextWindow` and `temperature` into their server's parameters.**
   No Ollama-only field reaches shared code.
4. **Adapters own their timeouts and error wording.**
5. **Every model call goes through `registry.resolve(key)`:** `rounds.ts`, `delegate.ts`, title, `/compact` and
   replay. A key without a known endpoint prefix resolves to `ollama` with the whole string as the name. That's a
   guard for leftovers; after the migration there should be none.

### Endpoints (settings)

```ts
interface Endpoint {
  id: string            // [a-z0-9-] only (no '.', no '/'); made from the name when added, unique; never changes
  name: string
  kind: 'ollama' | 'openai'
  flavor: 'ollama' | 'lmstudio' | 'llamacpp' | 'vllm' | 'generic'
  baseUrl: string       // Ollama: the server root. OpenAI: the base URL as the server's docs give it (usually …/v1).
  enabled: boolean
  hasKey: boolean       // derived from secrets
  showCloudCatalog?: boolean   // Ollama
  numCtx?: number              // Ollama; today's global localNumCtx
  defaultContext?: number      // OpenAI; used when nothing reports a context size (default 8192)
}
// Settings: endpoints: Endpoint[]; ollamaAccount: { hasKey: boolean }
// Removed: connection, showCloudCatalog, localNumCtx
```

- **Keys.** An Ollama endpoint on `https://ollama.com` authenticates with the ollama.com account key. Every other
  endpoint uses only its own key, sent as `Authorization: Bearer`.
- **IPC.** Endpoints have their own calls: `endpoints.list/add/update/remove/probe/setKey`. They never go through
  `updateSettings`, whose deep-merge drops unknown `connection` fields today.
- **Probing** runs when adding an endpoint and on "Re-detect". It tries, in order:
  1. `GET {root}/api/version` → Ollama;
  2. `GET {root}/api/v1/models` → LM Studio 0.4+;
  3. `GET {root}/props` → llama.cpp;
  4. `GET {base}/models` with `max_model_len` → vLLM;
  5. otherwise, generic OpenAI-compatible if `/models` answers.

  `root` is `baseUrl` with a trailing `/v1` removed. The dialog accepts an address with or without `/v1` and stores
  what the probe confirmed.
- **LM Studio before 0.4** has no `/api/v1/models`, so it's detected as generic. That still works, with default
  capabilities.
- **New ids** are the name lower-cased, with anything outside `[a-z0-9]` turned into `-` ("LM Studio" becomes
  `lm-studio`). A clash gets `-2`, `-3` and so on.
- **Editing.** Name, address, key and the per-kind settings can be edited, and the id stays. So a server that moves
  ports keeps its chats.
- **Removing** asks first and says what goes, following the confirm-before-loss rule. For example: *"Remove LM
  Studio? 12 chats use its models; they keep their history but need a new model picked. Its API key and model
  settings are deleted."* It deletes the key and the endpoint's `model_profiles` rows.
- **Disabled or removed endpoints.** A disabled endpoint's models leave the picker. A chat whose model key resolves
  to a disabled, removed or missing model shows its name with "unavailable", and sending stays blocked until another
  model is picked. A title model that can't be resolved falls back to the chat's model.

### Models

```ts
interface ModelInfo {
  key: ModelKey
  name: string                                        // raw id at the server
  endpoint: { id: string; name: string; kind: Endpoint['kind']; flavor: Endpoint['flavor'] }
  where: 'cloud' | 'this-mac' | 'network'             // shown in the picker and Settings
  billing: 'priced' | 'local' | 'untracked'
  contextControl: 'client' | 'server'                 // 'client': Ollmost sends num_ctx (Ollama, non-cloud models)
  contextWindow: number | null                        // the window this model's requests get (see Context)
  installed: boolean
  capabilities: string[]                              // after overrides: 'completion', 'tools', 'vision', 'thinking'
  contextLength: number | null
  family: string | null
  parameterSize: string | null
  overrides: ModelOverrides                           // + vision?, tools?, contextLength?
  detected: { tools?: false; contextLength?: number; reason?: string }
  price: ModelPrice | null
}
interface ModelListResult { models: ModelInfo[]; errors: { endpointId: string; message: string }[] }
```

- **`where`**
  - `cloud`: an ollama.com endpoint, or a `-cloud`/`:cloud` name through the Ollama app.
  - `this-mac`: the address is `localhost`, `127.0.0.1` or `::1`.
  - `network`: anything else.
- **`billing`**, checked in this order:
  1. `priced`: Ollama cloud models (`where === 'cloud'` on an Ollama endpoint).
  2. `local`: `where === 'this-mac'`.
  3. `untracked`: everything else.
- **Precedence** for each capability and the context size: the user's override, then the detected value, then what
  the server reported, then the default. `model_profiles` gains a `detected` column so the 24h info refresh never
  wipes it. "Re-detect" clears `detected` only.
- **Listing** asks every enabled endpoint in parallel. A failing endpoint adds to `errors`, and the others still
  list.

### The OpenAI-compatible adapter

**Request**, sent as `POST {baseUrl}/chat/completions`:

| Ollmost | Sent as |
|---|---|
| user images | `content: [{type:'text',text}, {type:'image_url', image_url:{url:'data:<mime>;base64,…'}}]`; `imageForModel` returns the mime type of the image it produces |
| assistant tool calls | `tool_calls:[{id, type:'function', function:{name, arguments: JSON.stringify(args)}}]`; `content: ''` when there's no text (`null` if the spike shows a server requires it) |
| tool result | `{role:'tool', tool_call_id, content}` |
| earlier reasoning | not sent |
| tools | as they are; no `tool_choice` |
| think: toggle | `chat_template_kwargs: { enable_thinking: on }` |
| think: levels | `reasoning_effort: 'low' \| 'medium' \| 'high'` |
| think: none / always | nothing |
| context | nothing (fixed on the server) |
| temperature | top-level `temperature` |
| usage | `stream: true, stream_options: { include_usage: true }`; if a server rejects `stream_options`, retry once without it and remember that on the endpoint |

**Stream.**

- **Framing:**
  - Read `data:` lines, skip `:` comments and `event:` lines, and end at `data: [DONE]`.
  - Buffering and stall timers are shared with the NDJSON reader.
  - A stream that ends with neither `finish_reason` nor `[DONE]` throws "connection dropped".
  - `data: {"error":…}` throws its message.
- **Content and reasoning:**
  - `delta.content` becomes a `content` event.
  - `delta.reasoning ?? delta.reasoning_content` becomes a `thinking` event.
- **`thinkSplitter`** runs on `content` when the server doesn't separate reasoning:
  - Only a **leading** `<think>…</think>` block counts.
  - It holds back up to 7 characters so a tag split across chunks still matches.
  - A `</think>` that arrives before any `<think>` near the start (templates that open the block in the prompt)
    marks everything before it as thinking.
- **Tool calls:** fragments are collected by `index`. The first carries `id` and `function.name`; later ones append
  to `function.arguments`. Complete `toolCall` events are sent on `finish_reason` or `[DONE]`. Arguments that aren't
  valid JSON pass through as a string (`argsOf` already handles that). A missing `id` gets `t` + the call's place in
  the stream in base 36, padded to 8 (`t00000000`), because Mistral's chat templates on vLLM refuse any id that isn't
  9 letters and digits. An id the server sent is echoed back unchanged.
- **`done`:**
  - `finishReason` comes from `finish_reason`, so `'length'` keeps the cut-off notice.
  - `usage` comes from `usage.prompt_tokens`/`completion_tokens`.
  - `timing` comes from llama.cpp's `timings.prompt_ms`/`predicted_ms` when present.
- **`chatOnce` / `sendWire`** make a non-streaming request and read `choices[0].message` and `usage` the same way.

**Discovery.**

| Flavor | Source | Read |
|---|---|---|
| lmstudio | `GET {root}/api/v1/models` | `type == 'llm'` only; `capabilities.vision`; `capabilities.trained_for_tool_use`; `capabilities.reasoning` (`allowed_options`, `default`) presets the think profile (on/off → toggle, low/medium/high → levels); `loaded_instances[0].config.context_length ?? max_context_length`; `params_string` |
| llamacpp | `GET {base}/models` + `GET {root}/props` | `n_ctx`; `modalities.vision`; tool support from `chat_template_caps` (exact key taken from llama.cpp's `common/jinja/caps.h` in PR 3; if absent, the default of tools on applies) |
| vllm | `GET {base}/models` | `max_model_len` |
| generic | `GET {base}/models` | ids only; ids matching `/(^|[-_/])(embed|embedding|rerank)/i` are hidden |

Cached in `model_profiles` for 24 hours, as today.

**Timeouts** are chosen by `where`:
- `this-mac` and `network` keep today's local allowances (first byte 10 minutes, idle 3 minutes, tool-call idle
  30 minutes), because some servers hold a tool call back the way Ollama does.
- `cloud` uses a tool-call idle equal to the plain idle.

**Errors** name the endpoint and its address:

| Failure | Message and effect |
|---|---|
| Refused | *"Can't reach LM Studio at localhost:1234. Is its server started?"*, plus a hint for the server type (LM Studio: Developer tab; llama.cpp: `llama-server`; vLLM: `vllm serve`) |
| 401/403 | *"<name> rejected the API key. Check it in Settings → Models → <name>."* |
| 404 for a model | *"<name> doesn't have a model called <model>."* |
| 400 matching `enable-auto-tool-choice` or `--jinja` | *"<name> can't use tools with this model until it's started with …"*; sets `detected.tools = false` with that reason |
| 400 matching `maximum context length is (\d+)` | suggests `/compact` or a new chat; sets `detected.contextLength` |

### The Ollama adapter

Today's behaviour, moved:
- `think` comes from `toOllamaThink`;
- `options.num_ctx` comes from `contextWindow` when `contextControl === 'client'`;
- `options.temperature` is used;
- `thinking` is sent back within a turn;
- the tool-call ids are dropped and `tool_name` is used;
- `done` is built from `prompt_eval_count`/`eval_count`/`done_reason`, plus `load_duration`/`prompt_eval_duration`/
  `eval_duration` converted from ns to ms;
- the cloud catalog and `toDaemonCloudName` behave as today;
- the error messages are today's `friendly()`.

### Callers

- **`rounds.ts` / `delegate.ts`:**
  - `registry.modelInfo(key)` replaces `getModelInfo`.
  - The request is a `ChatRequest`.
  - `for await (ev of provider.chatStream(req, signal))` with a `switch (ev.type)` replaces reading `m.content`,
    `m.thinking`, `m.tool_calls` and `chunk.done`.
  - `recordRound` uses `done.usage`; missing counts are estimated, as today.
  - The `lastCount` calibration uses `done.usage.prompt`.
  - tok/s uses `done.timing.genMs`, or else the time from the first token to `done`.
  - The assistant echo carries `toolCalls` with ids, and tool results carry `toolCallId` and `toolName`.
  - The trace records `provider.wire(req)`.
  - Approvals, shortening, checkpoints and round limits are unchanged. A sub-agent inherits its parent's key.
- **`assemble.ts`:**
  - It emits `ChatMessage[]`.
  - Earlier turns' tool calls get stable ids, `c` + the turn and the call's place in base 36, 4 digits each
    (`c00010000`), so a replayed chat produces byte-identical bodies. Like every id Ollmost makes up (the Ollama
    adapter's for a call Ollama sent without one included), it's 9 letters and digits: Mistral's chat templates on
    vLLM refuse any other shape.
  - Images become `{data, mime}`.
  - Estimates stay at 1600 tokens per image.
- **Title and `/compact`:**
  - The title model is `settings.titleModel` (a `ModelKey`, default "same as the chat").
  - `think` is the lowest the profile allows (`low` for levels, `off` for toggle).
  - `temperature` is 0.3 for titles.
  - `contextWindow` is the chat model's, so Ollama doesn't reload.
  - `cleanTitle`'s `<think>` stripping stays.

### Context (`src/shared/context.ts`)

`effectiveContext(model)` is replaced by `ModelInfo.contextWindow`, computed in main:

- **`client`:** `min(contextLength ?? endpoint.numCtx, endpoint.numCtx)`.
- **`server`:** the user's override, else the detected value, else the loaded or reported size, else
  `endpoint.defaultContext`. For Ollama cloud models it's `contextLength`.

`contextOptions` moves into the Ollama adapter. The renderer's context meter (`stores/app.ts:198`) reads
`contextWindow`.

### Traces, debugger, replay

- **What a trace stores.** The `traces.model` column holds the key. The trace JSON gains
  `dialect: 'ollama' | 'openai'` and `auth: 'ollama.com' | 'endpoint' | null`; the key itself is never stored. If
  either field is missing, the trace is read as Ollama.
- **Replay** resolves the trace's `model` key and calls that endpoint's `sendWire(editedBody)`. If the endpoint is
  gone: *"This trace's endpoint (<name>) no longer exists."*
- **Image hiding.** `redactImages` and `stripImagePlaceholders` handle `image_url` data URLs.
- **Prompt anatomy** (`Anatomy.tsx`, `promptAnatomy`) reads both dialects, keyed on `dialect`.
- **Debugger text.**
  - The timing rows read "Server: model load / prompt processing / generation" and are shown only when reported.
  - "not reported (cloud models omit it)" becomes "not reported by this server".
- **Copy as curl** uses `$OLLAMA_API_KEY` for ollama.com, or `$<ENDPOINT_ID_UPPER>_API_KEY` for a keyed endpoint.
- **`OLLMOST_DEBUG=1`** logs the wire body with images elided.

### Usage, cost, quota

- **Recording.** `usage_events.billing` is written from `ModelInfo.billing` at the time of the reply. Cost:
  - `priced`: `costOf(price, …)`, which is null if there's no price;
  - `local` / `untracked`: 0.
- **Totals.** A total is unknown only when a `priced` row has a null cost. `byDay` and the debugger follow the same
  rule.
- **Labels.**
  - Per reply: `$0.0031`, `local`, or `cost not tracked`. A priced reply with no known price shows no cost, as today.
  - Chat chip: all local → `local`; all untracked → `not tracked`; otherwise the priced sum.
  - Popover rows show each model with its endpoint name and label. The footnote reads *"Priced with Ollama's
    published rates (Ollama cloud models only)."*
- **Settings → Usage & cost.** "Spend in Ollmost" rows show the endpoint name, with the note *"Local and untracked
  endpoints aren't counted."*
- **Quota chip and polling.**
  - ollama.com key saved → as today.
  - No key but an Ollama endpoint exists → today's "add a key" chip.
  - Neither → hidden, and no polling.
- **`/api/me`** goes to the first enabled Ollama endpoint on a loopback address, and is skipped if there is none. A
  failure is remembered for the session.
- **`refreshPrices`** runs only when an Ollama endpoint exists.
- **Web tools** are unchanged. They're on for any tools-capable model when the ollama.com key is saved.

### UI

The mockups were approved.

- **Picker** (option B):
  - The search box has a row of endpoint chips under it (All · each endpoint). An offline endpoint is a dashed ⚠
    chip, and clicking it shows the error and Retry.
  - The list has a section per endpoint, and the current model's endpoint comes first. Ollama keeps its "Cloud" /
    "On this Mac" split. Other sections are headed with the name and where (address for `network`).
  - The trigger reads `model · Endpoint` for non-Ollama models.
  - `displayModelName` and `paletteChoices` share one `modelLabel(info)`.
- **Settings → Models** (option B, master–detail):
  - The left column lists the endpoints (with status dots), "+ Add endpoint", "ollama.com account" and "Defaults".
  - An endpoint's page shows its settings (name, address, key, `numCtx` and cloud catalog for Ollama, "context when
    not reported" for OpenAI, enabled, Re-detect, Remove…). Below them is that endpoint's models table: Thinking |
    Tools | Vision | Context | Artifacts | Auto skills. Each cell shows `Auto (value)`, and a detected value carries
    a short reason.
  - The "ollama.com account" page has the key field and explains what it powers: web search and page reading for
    every model (it goes through ollama.com even for local models), quota, and Ollama cloud models.
  - The "Defaults" page has the default model and title model menus, grouped by endpoint.
- **Add endpoint dialog:**
  - Step 1: address, with presets Ollama `:11434`, LM Studio `:1234`, llama.cpp `:8080` and vLLM `:8000`, plus an
    optional key. Then Check.
  - Step 2: a summary such as *"Found LM Studio 0.4 · 5 models · 4 with tools · 1 with vision · 2 can think"*, or
    for a generic server *"… capabilities not reported — defaults apply (tools on, vision off)"*. Then a name, then
    Add.
- **Wording:**
  - Home (`HomeView.tsx:31`): *"Couldn't load models from any endpoint"*, listing each endpoint's error and linking
    to Settings.
  - `codeActions.ts:12`: *"Check that a model server is running."*
  - Palette keywords "connection", "endpoint", "lm studio", "vllm" and "llama.cpp" all go to the Models tab.
  - README:
    - a "Model endpoints" section;
    - requirements: "the Ollama app, or an OpenAI-compatible server";
    - known limits: no cost tracking off Ollama; the thinking control is opt-in; vLLM needs
      `--enable-auto-tool-choice --tool-call-parser …` for tools; llama.cpp needs `--jinja`; remote paid APIs aren't
      officially supported.

### Migration

1. **Backup.** Before the first migration entry that this change adds, `VACUUM INTO`
   `<userData>/backups/ollmost-before-endpoints-<yyyy-mm-dd>.db`. Skipped if a backup from the same day exists.
2. **SQL** (one appended entry; `migrations.ts` is append-only):
   ```sql
   UPDATE conversations  SET model = 'ollama/' || model WHERE model IS NOT NULL;
   UPDATE messages       SET model = 'ollama/' || model WHERE model IS NOT NULL;
   UPDATE usage_events   SET model = 'ollama/' || model;
   UPDATE traces         SET model = 'ollama/' || model WHERE model IS NOT NULL;
   UPDATE model_profiles SET model = 'ollama/' || model;
   ALTER TABLE model_profiles ADD COLUMN detected TEXT NOT NULL DEFAULT '{}';
   ALTER TABLE usage_events ADD COLUMN billing TEXT NOT NULL DEFAULT 'local';
   UPDATE usage_events SET billing = 'priced'
     WHERE cost_usd IS NULL OR cost_usd > 0 OR model LIKE '%-cloud' OR model LIKE '%:cloud';
   ```
3. **Settings** (`settings.ts`, on load, when `endpoints` is missing):
   - `connection` becomes `endpoints[0]` with `id: 'ollama'`, `kind`/`flavor: 'ollama'` and `enabled: true`.
     - Local mode: `name: 'Ollama'`, `baseUrl: connection.host`, with `showCloudCatalog` and `numCtx: localNumCtx`.
     - Direct mode: `name: 'Ollama cloud'`, `baseUrl: 'https://ollama.com'`.
   - `defaultModel` and `titleModel` get `'ollama/'` prepended.
   - `connection`, `showCloudCatalog` and `localNumCtx` are dropped.
   - The kv row `apiKey` stays as the ollama.com account key.

Steps 2 and 3 both use the id `ollama`, so every pre-upgrade chat resolves to the migrated endpoint.

### Verify in the capture spike

Capture now from **LM Studio and local Ollama**; the user can run both. The llama.cpp and vLLM fixtures are written
from their docs and marked `// unverified: from docs`, and the user checks vLLM later.

Questions for LM Studio:

1. Which parameter toggles or sets reasoning on `/v1/chat/completions`: `reasoning_effort`, something else, or
   nothing? If nothing, LM Studio models are display-only.
2. Are tool calls streamed as deltas or sent whole?
3. Is `stream_options.include_usage` honoured?
4. Is `reasoning` or `reasoning_content` used?
5. Is `content: ''` accepted next to `tool_calls`?
6. Does `/api/v1/models` report `loaded_instances[].config.context_length` for a model loaded just in time?

## Not in this version

- A price editor, provider-reported costs (OpenRouter `usage.cost`), and cached-token pricing for other endpoints.
- APIs other than OpenAI chat completions: the OpenAI Responses API, and native Anthropic or Gemini.
- Authentication other than a Bearer key, and custom headers.
- Pulling, loading or unloading models on non-Ollama servers (LM Studio's load API), and keep-alive or TTL control.
  The Ollama-only issues #11–#13 stay Ollama-only.
- Sending earlier reasoning back to OpenAI-compatible servers.
- Per-endpoint web tools. Web tools stay ollama.com-only.

## Testing

- **One reply loop for both dialects.** The existing reply-loop tests (tool rounds, Stop, saving partial replies,
  result shortening, round limits) run once against the NDJSON mock and once against an SSE mock replaying the same
  script. Both runs must produce the same saved messages, tool events and usage rows. `tests/ollamaMock.ts` gains
  `sse()` helpers and a dialect option.
- **SSE client:** reads split mid-line; missing `[DONE]` is a drop; errors mid-stream; the first-byte, idle and
  tool-idle stalls; Stop; retrying without `stream_options`.
- **Tool calls:** fragmented arguments; parallel calls by `index`; a whole call in one delta; invalid JSON; a
  missing id.
- **`thinkSplitter`:** tags split across chunks; leading block only; a reply that starts mid-thinking; a reply that
  mentions `<think>` is left intact.
- **Discovery:** fixture JSON for each flavor, and the precedence order.
- **Registry:** splitting on the first `/`; `hf.co/...` names; the legacy fallback; disabled and removed endpoints.
- **Migrations:**
  - settings in local and direct modes;
  - the SQL entry on a database seeded with rows of every kind;
  - the `billing` backfill;
  - the backup (following the `db.test.ts` pattern).
- **Usage:** totals mixing priced, local and untracked rows.
- **Traces:** a missing dialect; replay going to the trace's endpoint; `image_url` redaction.
- **e2e (`e2e/run.mjs`):**
  - The five fake-Ollama servers become one `fakeServer({ dialect })` factory, and the "Ollama usage" checks become
    conditional.
  - A new section: Add endpoint (Check, then Add) → pick with a chip → a tool-call round → the "local" label → switch
    endpoints within one chat.
  - An optional live section runs when `OLLMOST_E2E_OPENAI_URL` is set.

## PRs

Preconditions:
- #125 and `claude/sub-agents-2` merged;
- no open PR touching `src/main/chat/` or `src/main/ollama/`;
- #101's code not started, or sharing `providers/secrets.ts`.

0. **Capture spike.** A throwaway script outside the repo records SSE from LM Studio and Ollama. Not merged; its
   output becomes fixtures in PR 3.
1. **The seam.** `providers/types.ts`, `registry.ts` and `secrets.ts`. Ollama moves under `providers/ollama/`. Every
   caller switches to neutral types. **No behaviour change**: every body Ollama receives is byte-identical. Existing
   tests change only their imports, or where they build or read a type that changed (assembled messages, the round
   loop's input). This spec, its review, the mockups and the plan come into the repo with it.
2. **Endpoints and identity.**
   - The migration (backup, SQL, settings) and `ModelKey`.
   - The `ModelInfo` split (`where`, `billing`, `contextControl`, `contextWindow`), IPC, and the renderer lookups by
     key.
   - Settings master–detail, the Add endpoint dialog (Ollama only), and the picker chips.
3. **The OpenAI-compatible adapter.** SSE, tool-call assembly, think mapping, `thinkSplitter`, discovery, errors,
   probing every flavor, the Tools/Vision/Context overrides, and the spike's fixtures. **The first release where
   LM Studio works.**
4. **Usage and polish.** `billing` labels and totals; gating for quota, `/api/me` and pricing; the trace `dialect`
   and replay routing; debugger text; wording; the README.
5. **e2e.** The factory and the endpoints section.

After each PR: CI green, then `OLLMOST_INSTALL_DIR=~/Applications npm run install:mac` for a manual check.
