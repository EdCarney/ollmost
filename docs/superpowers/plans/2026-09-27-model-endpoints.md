# Model Endpoints Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ollmost talks to Ollama natively and to any OpenAI-compatible server (LM Studio, llama.cpp, vLLM, generic), several at once. Models from every endpoint appear in one picker, and each chat remembers its endpoint.

**Architecture:** Neutral chat types sit behind a `Provider` interface (`src/main/providers/`). The existing Ollama client becomes one adapter, and a hand-written OpenAI-compatible adapter (SSE, tool-call deltas, reasoning fields, a `<think>` splitter) is the other. Model identity becomes a key string `endpointId/model`, migrated from bare names. `ModelInfo.location` is replaced by `where` / `billing` / `contextControl` / `contextWindow`.

**Tech Stack:** Electron + React + TypeScript, `node:sqlite`, zustand, vitest, Playwright (e2e). No new runtime dependencies.

**Spec:** `docs/superpowers/specs/2026-09-27-model-endpoints-design.md` (approved 2026-09-27). The codebase review behind it is `docs/superpowers/specs/2026-09-27-model-endpoints-review.md`. The UI mockups are in `docs/superpowers/specs/2026-09-27-model-endpoints-mockups/` (`picker.html` option B, `settings-endpoints.html` option B). The spec, the review, the mockups and this plan (`docs/superpowers/plans/2026-09-27-model-endpoints.md`) are committed on `claude/model-endpoints-plan`; PR 1's branch starts from it, so they ship with PR 1.

**Anchors:** Line numbers and code shapes are against `main` @ 24f4623. Sub-agents (#125, and `claude/sub-agents-2` via #131) merged on 2026-09-27, so `src/main/chat/rounds.ts` and `delegate.ts` are on `main`. Since the parts were drafted (at 97b17f9), #173, #174, #179, #180 and #175 merged. 4b69183 gave `src/main/ollama/client.ts` a plain-English out-of-memory error (`notEnoughMemory()`, used by `friendly()` and the in-stream `chunk.error`), and 9d00209 set a compaction's clock from `now()` in `service.ts`; #179/#180 also touched `Composer.tsx`, `CompactionDivider.tsx`, `ui/index.tsx`, `db/usage.ts` (the meter skips rows from before a compaction or of deleted messages), `tests/db.test.ts`, `tests/service.test.ts` and `e2e/run.mjs`. #175 (parallel sub-agents, merged 2026-09-27 as 24f4623, after #179/#180) runs a round's calls in batches in `rounds.ts` (`RoundsInput.parallel`; `runCall`, `batchesOf`, `runTogether` and `ShownCall`; a call the limit kept waiting when the reply stopped is saved through `notRunEvent`; the results go to the model in call order in a loop of their own), adds `subAgentsAtOnce()` and `parallel: true` to `delegate.ts`, `runsInParallel()` and `notRunEvent()` to `tools.ts`, `subAgentsAtOnce` to `assemble.ts` and `prompts.ts`, and `Settings.delegate.parallel` (default `DEFAULT_SUB_AGENTS_AT_ONCE = 3`, exported by `settings.ts`) to `types.ts`; it grew `tests/service.test.ts` by about 385 lines, added tests to `tests/assemble.test.ts` and `tests/tools.test.ts`, and created `tests/settings.test.ts`. The parts' line numbers and quoted code were checked against d8064b4, and again against 24f4623 in every file #175 touched. **Before starting each PR, re-read every file its tasks name.** Code that moved since this plan was written wins over the plan's line numbers, but never over its behaviour. The only open PR is #124 (the design doc for #101, docs only).

## Global Constraints

- **Preconditions before PR 1** (all satisfied, checked 2026-09-27; Task 1.1 Step 1 checks them again):
  - Sub-agents merged: #125 and #131. Done 2026-09-27.
  - #175 (parallel sub-agents) merged. Done 2026-09-27 (24f4623). The plan keeps its behaviour: Tasks 1.6, 2.2 and 3.10 say how.
  - #179 (composer and popover fixes) merged. Done 2026-09-27 (faec839), with #180 (d8064b4), both before #175.
  - No other open PR touches `src/main/chat/`, `src/main/ollama/`, `src/main/settings.ts` or `src/shared/types.ts`. Done: the only open PR is #124, docs only.
  - #101's code is not started, or it uses `src/main/providers/secrets.ts`. Done: not started; #124 is its design doc only.
- No new runtime dependencies: `package.json` `dependencies` stay unchanged.
- Every task ends green on `npm run typecheck && npm run lint && npm run format:check && npm test`.
- Prettier: no semicolons, single quotes, `trailingComma: none`, `printWidth: 140`. Tests live in `tests/*.test.ts` and import from `../src/...`; `@shared` is aliased to `src/shared`.
- `src/main/db/migrations.ts` is append-only. Never edit a shipped entry.
- Endpoint ids match `[a-z0-9-]+` (no `.`, no `/`). The migrated endpoint's id is exactly `ollama`.
- Model keys are `endpointId/model`, split on the **first** `/`. Only `splitModelKey` (shared) and `registry.resolve` (main) split them.
- The ollama.com account key is sent only to `https://ollama.com` (chat on an ollama.com endpoint, `/api/usage`, web tools). Endpoint keys are sent only to their own endpoint. No key is ever written into a trace, a log or `debug.log`.
- User-facing errors name the endpoint and its address. The spec's quoted strings are the copy.
- Removing an endpoint asks first and says what goes (chats affected, key, model settings), following the confirm-before-loss rule.
- Branches are `claude/<name>`, one PR per phase. Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. PR bodies end with `🤖 Generated with [Claude Code](https://claude.com/claude-code)`. Merge only when the user says so.
- After each PR, the user installs and checks it: `OLLMOST_INSTALL_DIR=~/Applications npm run install:mac`.
- **PR 1 changes no behaviour.** Every request body the Ollama mock receives in `tests/service.test.ts` must be byte-identical before and after. In particular, tool-call ids never appear in an Ollama body.
- **Tool-call ids Ollmost makes up are 9 characters of `[A-Za-z0-9]`** (Mistral's chat templates on vLLM refuse any other shape): `c` + turn and call in base 36 for an earlier turn's call (`c00010000`), `t` + the call's place in the stream for a call its server sent without one (`t00000000`). An id a server sent is echoed back unchanged.
- **An OpenAI-compatible endpoint stores its API base** (what `probeEndpoint` returned, usually `<root>/v1`); `normalizeBaseUrl`'s root is only what addresses are compared by.

## Running this plan remotely

A cloud agent can implement most of this plan from the branch alone. Everything it needs is committed: this plan, the spec, the codebase review, the mockups, and (after Task 0.1) the capture recordings. Three kinds of step need the user's Mac:

- **Task 0.1, the capture spike.** It needs LM Studio at `localhost:1234` and a local Ollama. Only PR 3 depends on it. A remote agent may do PRs 1–2 without it, and must stop before Task 3.1 if `docs/superpowers/plans/2026-09-27-model-endpoints-capture/FINDINGS.md` is missing.
- **e2e runs** (`npm run build && npm run e2e`: Task 2.9, PR 5, and any step that runs e2e). Sections 1–9 need a live, signed-in Ollama. A remote agent runs `npm run typecheck && npm run lint && npm run format:check && npm test`, writes the e2e run into the PR's test plan as "to run on the user's Mac", and does not mark it passed.
- **The install check after each PR** (`OLLMOST_INSTALL_DIR=~/Applications npm run install:mac`) is always the user's.

CI runs the unit suite on Ubuntu and on macOS. The tests that need macOS's sandbox skip themselves on Linux, so a Linux agent's `npm test` passing is expected, with the macOS CI job covering the rest. Open PRs, but never merge; the user merges.

## Review Focus

These five inputs are the ones most likely to hurt a real user, and no task's main tests exercise them. Each has a pinning test added to the task that owns the code.

1. **An existing chat whose Ollama model name contains `/`** (`hf.co/bartowski/Qwen3-8B-GGUF:Q4_K_M`). After the migration it must resolve to the `ollama` endpoint and send exactly `hf.co/bartowski/Qwen3-8B-GGUF:Q4_K_M` to Ollama. *Pinned in Task 2.1 (`splitModelKey`) and Task 2.3 (migration round-trip).*
2. **An endpoint that's down when the app starts** (LM Studio closed). The picker still lists every other endpoint. That endpoint shows a ⚠ chip with its error, and a chat using it shows "unavailable" with a working Retry instead of a blank model list. *Pinned in Task 2.4 (`listAllModels` with one endpoint refusing) and Task 2.7 (`groupModels`).*
3. **Two parallel tool calls whose argument fragments interleave by `index`**, with an escape sequence (`\"`, `é`) split across chunks. Each call's arguments come out exactly. *Pinned in Task 3.4.*
4. **Stop pressed mid-stream on an SSE endpoint.** The partial reply is saved with estimated usage, and the error is not "connection dropped". *Pinned in Task 3.6 (abort surfaces as `AbortError`) and Task 3.10 (the service-level stop test runs on both dialects).*
5. **Endpoint addresses typed loosely:** `localhost:1234`, `http://localhost:1234/`, `http://localhost:1234/v1/`. Each normalises to one root, which the duplicate check compares, and each probes to one stored `baseUrl` (an OpenAI-compatible server keeps its API base, `…/v1`). Adding an address that's already configured is refused with *"<name> already uses this address."* *Pinned in Task 2.6 (`normalizeBaseUrl` and the duplicate check) and Task 3.7 (the three spellings probe to one base; a base typed with its own path is kept).*

---

## File Structure

```
src/main/providers/                      NEW (PR 1 unless noted)
  types.ts        neutral ChatMessage/ChatRequest/ChatEvent/ChatResult/ToolCall/ToolDef/Provider
  secrets.ts      setSecret/getSecret (safeStorage); OLLAMA_ACCOUNT_SECRET, endpointSecretName()
  registry.ts     resolve(), modelInfo(), listAllModels(), invalidateProviders()
  stream.ts       (PR 3) createStallTimer(), shared by both wires
  where.ts        (PR 2) whereOf(), billingOf()
  context.ts      (PR 2) contextWindowFor()
  capabilities.ts (PR 3) effectiveCapabilities()
  probe.ts        (PR 2, all flavours in PR 3) normalizeBaseUrl(), sameServer(), probeEndpoint(), apiBaseUrl() (PR 3)
  endpoints.ts    (PR 2) the endpoints IPC's logic: addEndpoint(), updateEndpoint(), removeEndpoint(), setEndpointKey()
  ollama/
    wire.ts       moved from src/main/ollama/client.ts (HTTP + NDJSON; behaviour unchanged)
    models.ts     moved from src/main/ollama/models.ts
    adapter.ts    OllamaProvider: toOllamaBody(), ollamaEvents(), resultFromOllama()
  openai/         (PR 3)
    sse.ts        sseData(): SSE framing
    thinkSplitter.ts
    toolCalls.ts  createToolCallAccumulator()
    body.ts       toOpenAIBody(), openAIThink()
    discovery.ts  discoverModels() per flavour
    errors.ts     friendlyOpenAIError()
    adapter.ts    OpenAIProvider
src/main/ollama/web.ts                   stays (ollama.com web tools)
src/main/usage/{pricing,account}.ts      stay; changed in PR 2 (requestCost signature) and PR 4 (gating)
src/shared/endpoints.ts                  (PR 2) defaults, whereOf(), displayAddress(), probeSummary(), removalText()
src/shared/modelKey.ts                   (PR 2) ModelKey, toModelKey(), splitModelKey(), MIGRATED_ENDPOINT_ID
src/shared/modelLabel.ts                 (PR 2) modelLabel(); replaces displayModelName and paletteChoices' copy
src/shared/pickerGroups.ts               (PR 2) groupModels(), endpointChips()
src/shared/availability.ts               (PR 2) modelAvailability()
src/shared/billing.ts                    (PR 4) billingLabel(), chatCostLabel()
src/renderer/src/components/ModelPicker.tsx          rewritten (PR 2)
src/renderer/src/views/settings/EndpointsPane.tsx    NEW (PR 2): master–detail of the Models tab
src/renderer/src/views/settings/AddEndpointDialog.tsx NEW (PR 2; every flavour in PR 3)
tests/ollamaMock.ts                      gains sse helpers (PR 3)
tests/fixtures/sse/*.sse, tests/fixtures/discovery/*.json   (PR 3, from the capture spike)
```

## Shared contracts

Every task uses these exact names. A task that needs to change one says so explicitly and updates every later use. Each
part also opens with its own "Contract additions" (and PR 3 with "Contract changes"); where they changed a contract
below, this block already shows the result.

```ts
// ---- src/main/providers/types.ts (PR 1) ----
import type { Endpoint, ModelInfo, ThinkProfile, ThinkSetting } from '@shared/types'   // Endpoint since PR 2

/** A tool call as the loop and tools.ts see it: today's shape plus an id. Adapters and assemble() always set `id`. */
export interface ToolCall { id?: string; function: { name: string; arguments: Record<string, unknown> | string } }
export type IdentifiedToolCall = ToolCall & { id: string }
// Ids Ollmost makes up are 9 characters of [A-Za-z0-9] (Mistral's chat templates on vLLM refuse any other shape):
//   an earlier turn's call (assemble.ts, PR 1): 'c' + turn.toString(36).padStart(4, '0') + n.toString(36).padStart(4, '0')
//   a call its server sent without an id (Ollama adapter, PR 1; OpenAI accumulator, PR 3): 't' + n.toString(36).padStart(8, '0'),
//     n counting that stream's calls. An id the server sent is echoed back unchanged.
/** Today's OllamaTool, renamed: already the OpenAI function-tool shape. */
export interface ToolDef { type: 'function'; function: { name: string; description: string; parameters: Record<string, unknown> } }
export interface ChatImage { data: string; mime: string }  // base64 without a data: prefix
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
  thinking?: string
  images?: ChatImage[]
  toolCalls?: ToolCall[]
  toolCallId?: string
  toolName?: string
}
export interface ChatRequest {
  model: string                // raw name at the server
  messages: ChatMessage[]
  tools?: ToolDef[]
  think: ThinkSetting | null
  profile: ThinkProfile
  contextWindow: number | null
  temperature?: number
}
export interface RequestUsage { prompt?: number; completion?: number }
export interface ChatTiming { loadMs?: number; promptMs?: number; genMs?: number }
export type ChatEvent =
  | { type: 'content'; text: string }          // text '' = "a chunk arrived with nothing in it" (times the first byte)
  | { type: 'thinking'; text: string }
  | { type: 'toolCall'; call: IdentifiedToolCall }
  | { type: 'done'; usage: RequestUsage; finishReason?: string; timing?: ChatTiming; raw: unknown }   // raw: closing record, no reply text
export interface ChatResult {
  content: string; thinking: string; toolCalls: IdentifiedToolCall[]
  usage: RequestUsage; finishReason?: string; timing?: ChatTiming; raw: unknown
}
export interface WireRequest { endpoint: string; body: unknown }
export interface Provider {
  readonly id: string                         // PR 1: 'ollama'. PR 2: endpoint.id
  readonly endpoint: Endpoint                 // PR 2
  listModels(refresh: boolean): Promise<ModelInfo[]>          // throws when nothing can be listed
  modelInfo(model: string, refresh?: boolean): Promise<ModelInfo>
  chatStream(req: ChatRequest, signal: AbortSignal): AsyncGenerator<ChatEvent>
  chatOnce(req: ChatRequest, opts: { signal?: AbortSignal; timeoutMs: number }): Promise<ChatResult>
  wire(req: ChatRequest, stream: boolean): WireRequest        // exactly what chatStream/chatOnce send
  wireEndpoint(): string                                      // where wire() bodies are POSTed (traces, replay, curl)
  sendWire(body: unknown, opts: { signal?: AbortSignal; timeoutMs: number }): Promise<ChatResult>
}

// ---- src/main/providers/secrets.ts (PR 1) ----
export const OLLAMA_ACCOUNT_SECRET = 'apiKey'   // the existing kv row
export function endpointSecretName(id: string): string          // 'endpointKey:' + id
export function setSecret(name: string, value: string | null): void
export function getSecret(name: string): string | null

// ---- src/main/providers/ollama/adapter.ts ----
// PR 1: toOllamaBody(req), ollamaTimeouts(model), new OllamaProvider()   (Ollama only, settings-driven)
// PR 2 (and every later use):
export function toOllamaBody(req: ChatRequest, clientContext: boolean): ChatBody
export function ollamaTimeouts(endpoint: Pick<Endpoint, 'baseUrl'>, model: string): StreamTimeouts
export class OllamaProvider implements Provider { constructor(readonly endpoint: Endpoint) }
// ollamaEvents(chunks), resultFromOllama(res), toOllamaMessage(m) keep PR 1's signatures.

// ---- src/main/providers/registry.ts ----
// PR 1 (Ollama only):
export function resolve(model: string): { provider: Provider; model: string }
export function modelInfo(model: string, refresh?: boolean): Promise<ModelInfo>
export function listAllModels(refresh?: boolean): Promise<ModelListResult>   // today's { models, error }
// PR 2 (several endpoints, keys):
export function resolve(key: string): { provider: Provider; endpoint: Endpoint; model: string }  // throws EndpointGoneError
export class EndpointGoneError extends Error { constructor(readonly endpointId: string) }
export function modelInfo(key: string, refresh?: boolean): Promise<ModelInfo>
export function listAllModels(refresh?: boolean): Promise<ModelListResult>
export function invalidateProviders(): void                      // after any endpoint change
// PR 3:
export function createProvider(endpoint: Endpoint): Provider      // OpenAIProvider for kind 'openai', else OllamaProvider
export function redetectModel(key: string): Promise<ModelInfo>

// ---- src/shared/modelKey.ts (PR 2) ----
export type ModelKey = string & { readonly __brand: 'ModelKey' }
export const MIGRATED_ENDPOINT_ID = 'ollama'
export function toModelKey(endpointId: string, model: string): ModelKey
export function splitModelKey(key: string, knownIds: readonly string[]): { endpointId: string; model: string }
// prefix before the first '/' is a known id → split; otherwise { endpointId: 'ollama', model: key }
export function keyPrefix(key: string): string | null   // a prefix shaped like an id that names no endpoint = removed

// ---- src/shared/types.ts additions (PR 2) ----
export type EndpointKind = 'ollama' | 'openai'
export type EndpointFlavor = 'ollama' | 'lmstudio' | 'llamacpp' | 'vllm' | 'generic'
export interface Endpoint {
  id: string; name: string; kind: EndpointKind; flavor: EndpointFlavor
  baseUrl: string              // Ollama: the server root. OpenAI: the API base the probe confirmed (usually root + /v1)
  enabled: boolean; hasKey: boolean
  showCloudCatalog?: boolean; numCtx?: number          // Ollama
  defaultContext?: number; streamOptions?: boolean     // OpenAI; streamOptions false once rejected
}
export interface EndpointProbe {
  kind: EndpointKind; flavor: EndpointFlavor; baseUrl: string /* what to store */; version: string | null
  models: number; withTools: number; withVision: number; canThink: number
  reportsCapabilities: boolean; reportsContext: boolean
}
export type ModelWhere = 'cloud' | 'this-mac' | 'network'
export type ModelBilling = 'priced' | 'local' | 'untracked'
export interface ModelDetected { tools?: false; contextLength?: number; reason?: string }
// ModelOverrides gains: vision?: boolean; tools?: boolean; contextLength?: number
// ModelInfo: removes `location`; gains
//   key: ModelKey; endpoint: { id: string; name: string; kind: EndpointKind; flavor: EndpointFlavor }
//   where: ModelWhere; billing: ModelBilling; contextControl: 'client' | 'server'; contextWindow: number | null
//   detected: ModelDetected
//   PR 3 (optional): thinkPreset?: ThinkProfile['kind'] | null; auto?: { capabilities: string[]; contextWindow: number | null }
// ModelListResult: { models: ModelInfo[]; errors: Array<{ endpointId: string; message: string }> }
// Settings: removes connection, showCloudCatalog, localNumCtx; gains endpoints: Endpoint[]; ollamaAccount: { hasKey: boolean }
// MessageStats gains (PR 2): billing?: ModelBilling

// ---- src/shared/ipc.ts (PR 2) ----
endpoints: {
  list(): Promise<Endpoint[]>
  probe(input: { baseUrl: string; apiKey?: string }): Promise<EndpointProbe>
  add(input: { name: string; baseUrl: string; kind: EndpointKind; flavor: EndpointFlavor; apiKey?: string }): Promise<Endpoint>
  update(id: string, patch: Partial<Pick<Endpoint, 'name' | 'baseUrl' | 'enabled' | 'flavor' | 'showCloudCatalog' | 'numCtx' | 'defaultContext'>>): Promise<Endpoint>
  removalImpact(id: string): Promise<{ chats: number; hasKey: boolean; overrides: number }>
  remove(id: string): Promise<void>
  setKey(id: string, key: string | null): Promise<Endpoint>
}
models: {
  list(refresh?: boolean): Promise<ModelListResult>
  info(key: string): Promise<ModelInfo>
  setOverrides(key: string, overrides: ModelOverrides): Promise<ModelInfo>
  redetect(key: string): Promise<ModelInfo>   // PR 3: clears `detected`, refetches info
}
debug: {
  replay(conversationId: ID | null, model: string | null, body: unknown, endpointName?: string | null): Promise<TraceDetail>  // PR 4
  // PR 4 removes debug.target()
}
// settings.setApiKey stays: it sets the ollama.com account key.

// ---- src/main/providers/endpoints.ts (PR 2; the endpoints IPC's logic) ----
export function addEndpoint(input): Endpoint                     // PR 2: Ollama only. PR 3: every kind; an OpenAI endpoint keeps its API base
export function updateEndpoint(id, patch): Endpoint              // PR 2
export function updateEndpoint(id, patch): Promise<Endpoint>     // PR 3: re-probes an OpenAI endpoint's edited address
// assertAddressFree, probeNewEndpoint, endpointRemovalImpact, removeEndpoint, setEndpointKey: see PR 2's contract additions

// ---- src/main/db/kv.ts (PR 2): all keyed by model key ----
readModelProfile(key): { info; fetchedAt; overrides; detected: ModelDetected }
writeModelInfo(key, info); writeModelOverrides(key, overrides); writeModelDetected(key, detected)
deleteEndpointProfiles(endpointId): number   // DELETE ... WHERE model LIKE endpointId || '/%'

// ---- usage (PR 2 writes, PR 4 reads) ----
insertUsageEvent({ ..., model: string /* key */, billing: ModelBilling, ... })       // PR 2: billing required
requestCost(info: Pick<ModelInfo, 'billing' | 'price'>, promptTokens, completionTokens): number | null
// priced → costOf(price, …) (null if no price); local/untracked → 0
conversationUsage(conversationId: string, endpoints: readonly Endpoint[]): ChatUsage                          // PR 4
usageSummary(endpoints: readonly Endpoint[], days: number, sinceMs?: number, untilMs?: number | null): UsageSummary  // PR 4

// ---- traces and replay (PR 1: timing; PR 4: dialect/auth/endpoint) ----
Trace.finish({ ..., timing?: ChatTiming })               // replaces `ollama?: ChatChunk`; fills TraceTiming's loadMs/promptEvalMs/evalMs
startTrace({ ..., dialect?: 'ollama' | 'openai', auth?: 'ollama.com' | 'endpoint' | null, endpointId?: string, endpointName?: string })  // PR 4
replayRequest(conversationId: string | null, raw: unknown): Promise<TraceDetail>          // PR 1 (sends to resolve(raw.model))
replayRequest(conversationId: string | null, model: string | null, raw: unknown, endpointName?: string | null): Promise<TraceDetail>  // PR 4

// ---- rounds.ts (PR 1) ----
// RoundsInput: body: ChatRequest (was ChatBody); gains provider: Provider; keeps model: ModelInfo; modelName carries the key since PR 2
//   keeps #175's parallel?: number. ShownCall, batchesOf() and runTogether() keep their shape, on the neutral ToolCall;
//   a batch's results still go to the model in call order, each as { role: 'tool', content, toolName, toolCallId }.
// RoundsResult: evalNs → genMs: number. PR 1: Σ done.timing.genMs only (no behaviour change).
//   PR 3: each round's done.timing.genMs, else its first token → done (every server, Ollama's cloud models included).

// ---- PR 2 helpers ----
whereOf(baseUrl: string): 'this-mac' | 'network'                         // src/shared/endpoints.ts; providers/where.ts re-exports it
billingOf(where: ModelWhere): ModelBilling                                // cloud→priced, this-mac→local, network→untracked
contextWindowFor(m: { contextControl; contextLength; overrides; detected }, endpoint: Pick<Endpoint, 'kind' | 'numCtx' | 'defaultContext'>): number | null
normalizeBaseUrl(input: string): string                                   // providers/probe.ts: the server root (/v1 dropped); what addresses are compared by
sameServer(a: string, b: string): boolean                                 // localhost = 127.0.0.1 = [::1]
probeEndpoint(baseUrl: string, apiKey?: string): Promise<EndpointProbe>   // PR 2 Ollama only; PR 3 all flavours. Its baseUrl is what's stored
slugEndpointId(name: string, taken: readonly string[]): string            // src/shared/modelKey.ts
modelLabel(m: Pick<ModelInfo, 'name' | 'endpoint'>): string                // src/shared/modelLabel.ts
labelForKey(key: string | null | undefined, endpoints: readonly Endpoint[]): string
groupModels(models, errors, opts: { query: string; filter: string /* 'all' | endpointId */; currentKey: string | null; endpoints: Endpoint[] }): PickerGroup[]
interface PickerGroup { id: string; endpointId: string; label: string; where: ModelWhere; items: ModelInfo[]; error?: string }
endpointChips(endpoints: Endpoint[], errors: ModelListResult['errors']): Array<{ id: string; label: string; offline: boolean; error?: string }>
modelAvailability(key: string | null, models: ModelInfo[], endpoints: Endpoint[], errors: ModelListResult['errors']):
  'ok' | 'none' | 'endpoint-removed' | 'endpoint-disabled' | 'endpoint-offline' | 'model-missing'
// renderer store (stores/app.ts): modelErrors: ModelListResult['errors'], modelsReady, endpointsChanged(), selectEndpoints

// ---- PR 3 helpers ----
createStallTimer(abort: () => void): { arm(ms: number, message: string): void; stalled(): string | null; clear(): void }   // providers/stream.ts
sseData(body: ReadableStream<Uint8Array>): AsyncGenerator<string, boolean>   // yields each data payload; returns true at [DONE], false at a bare end
createThinkSplitter(): { push(text: string): { content: string; thinking: string }; flush(): { content: string; thinking: string } }
createToolCallAccumulator(): { add(deltas: unknown[]): void; finish(): IdentifiedToolCall[] }
toOpenAIBody(req: ChatRequest, opts: { stream: boolean; streamOptions: boolean }): Record<string, unknown>
openAIThink(profile: ThinkProfile, setting: ThinkSetting | null): Record<string, unknown>
discoverModels(endpoint: Endpoint, apiKey: string | null): Promise<DiscoveredModel[]>
interface DiscoveredModel { name: string; capabilities: string[]; contextLength: number | null; parameterSize: string | null; thinkPreset: ThinkProfile['kind'] | null; reportsCapabilities: boolean }
effectiveCapabilities(reported: string[], overrides: ModelOverrides, detected: ModelDetected): string[]
friendlyOpenAIError(endpoint: Pick<Endpoint, 'name' | 'baseUrl' | 'flavor'>, status: number, body: string, model?: string): { error: Error; detected?: ModelDetected }
resolveThinkProfile(model: string, capabilities: string[], override?: ThinkProfile['kind'], preset?: ThinkProfile['kind']): ThinkProfile   // src/shared/thinking.ts
apiBaseUrl(input: string): string                                         // providers/probe.ts: the address as typed, its path whole
class OpenAIProvider implements Provider { constructor(endpoint: Endpoint, opts?: { timeouts?: StreamTimeouts }) }

// ---- PR 4 helpers ----
billingLabel(b: ModelBilling, costUsd: number | null): string | null      // '$0.0031' | 'local' | 'cost not tracked' | null
chatCostLabel(rows: Array<{ billing: ModelBilling; costUsd: number | null }>): string   // 'local' | 'not tracked' | '$0.04' | 'cost unknown'
```

## Task Index

The task headings as the parts have them. `delegate.ts` and traces moved into Task 1.6 (with the loop); PR 2's
Task 2.6 also fixes the e2e script's wiring and its Kiln stand-in, so e2e stays green from PR 2 on.

| PR | Task | Title |
|---|---|---|
| 0 | 0.1 | Capture spike (on the user's Mac; recordings committed as docs) |
| 1 | 1.1 | Neutral types and secrets |
| 1 | 1.2 | Move the Ollama client and models under `providers/ollama/` |
| 1 | 1.3 | The Ollama adapter: `toOllamaBody` and `ollamaEvents` |
| 1 | 1.4 | The registry (Ollama only) |
| 1 | 1.5 | `assemble.ts` emits neutral messages; `imageForModel` returns the mime type |
| 1 | 1.6 | `rounds.ts` on neutral events |
| 1 | 1.7 | Title, `/compact` and replay through the provider |
| 1 | 1.8 | Clean-up, spec notes, PR |
| 2 | 2.1 | `modelKey.ts`: keys, splitting, endpoint ids |
| 2 | 2.2 | Endpoint settings and the settings migration |
| 2 | 2.3 | The database migration and backup |
| 2 | 2.4 | Registry over several endpoints; the `ModelInfo` split; `model_profiles` by key |
| 2 | 2.5 | Main-process callers use keys; usage rows carry `billing` |
| 2 | 2.6 | Endpoints IPC: list, probe (Ollama), add, update, remove, keys |
| 2 | 2.7 | Renderer: keys everywhere, `modelLabel`, `groupModels`, and the picker (option B) |
| 2 | 2.8 | Settings → Models master–detail and the Add endpoint dialog (Ollama) |
| 2 | 2.9 | Unavailable models in the composer; the title-model fallback; PR |
| 3 | 3.1 | SSE mock helpers and fixtures from the spike |
| 3 | 3.2 | `createStallTimer` shared; `sseData` |
| 3 | 3.3 | `thinkSplitter` |
| 3 | 3.4 | Tool-call delta accumulator |
| 3 | 3.5 | `toOpenAIBody` and `openAIThink` |
| 3 | 3.6 | `OpenAIProvider`: stream, once, sendWire, errors, `stream_options` retry |
| 3 | 3.7 | Discovery per flavour and `probeEndpoint` for every flavour |
| 3 | 3.8 | Capability and context overrides, precedence, Re-detect, the settings columns |
| 3 | 3.9 | Add endpoint for every flavour |
| 3 | 3.10 | One reply loop, both dialects (service tests parametrised); PR |
| 4 | 4.1 | Billing labels and totals |
| 4 | 4.2 | Gating for quota, `/api/me` and pricing |
| 4 | 4.3 | Traces: dialect and auth, replay routing, image redaction, anatomy, curl, labels |
| 4 | 4.4 | Wording, palette, README; PR |
| 5 | 5.1 | One `fakeServer({ dialect })` factory in `e2e/run.mjs` |
| 5 | 5.2 | e2e: the endpoints flow, and an optional live section; PR |

---

## Contract additions (PR 0–1)

PR 1 uses these names on top of the plan's Shared contracts. Later parts use them as written here, except where PR 2
changes them for endpoints (`toOllamaBody(req, clientContext)`, `ollamaTimeouts(endpoint, model)`,
`new OllamaProvider(endpoint)`, `getModelInfo(endpoint, t, name, refresh)`, the registry by key): PR 3 onward uses
PR 2's versions.

```ts
// ---- src/main/providers/types.ts (PR 1) ----
// Provider gains:
wireEndpoint(): string   // where wire() bodies are POSTed: a replayed trace's endpoint (PR 1), curl's target (PR 4)
// ChatEvent 'content' may carry text '': "a chunk arrived with nothing in it". The loop marks the first byte by it and
// otherwise ignores it. ChatEvent 'done'.raw and ChatResult.raw are the server's closing record without the reply text
// (Ollama: the final chunk minus `message`); traces store them as response.final.

// ---- src/main/providers/ollama/wire.ts (PR 1; src/main/ollama/client.ts moved) ----
export interface OllamaToolCall { id?: string; function: { index?: number; name: string; arguments: Record<string, unknown> | string } }
// client.ts's `ToolCall`, renamed so it can't be confused with the neutral one; newer Ollama versions send `id` and `index`.
// ChatChunk gains load_duration?: number and prompt_eval_duration?: number (Ollama always sent them; the type lacked them).
// ChatBody.tools is ToolDef[]. OllamaTool is gone: every tool provider imports ToolDef from providers/types.

// ---- src/main/providers/ollama/models.ts (PR 1; moved) ----
export async function getModelInfo(name: string, refresh = false): Promise<ModelInfo>   // gains `refresh`

// ---- src/main/providers/ollama/adapter.ts (PR 1) ----
export function toOllamaMessage(m: ChatMessage): OllamaMessage
export function toOllamaBody(req: ChatRequest): ChatBody
export function ollamaEvents(chunks: AsyncIterable<ChatChunk>): AsyncGenerator<ChatEvent>
export function resultFromOllama(res: ChatChunk): ChatResult
export function ollamaTimeouts(model: string): StreamTimeouts
export class OllamaProvider implements Provider          // PR 1: no constructor arguments; id 'ollama'
// Ids: a call Ollama sent keeps Ollama's own `id`, else gets 't' + n.toString(36).padStart(8, '0') (n counts calls in
// that request: t00000000, t00000001…). An echoed call goes back to Ollama exactly as Ollama sent it; an id Ollmost
// made up never reaches Ollama.
// Every id Ollmost makes up is 9 characters of [A-Za-z0-9]: Mistral's chat templates on vLLM refuse any other shape.

// ---- src/main/chat/assemble.ts (PR 1) ----
// HistoryTurn.images: ChatImage[]; Assembled.messages: ChatMessage[]
// An earlier turn's calls get 'c' + turn.toString(36).padStart(4, '0') + n.toString(36).padStart(4, '0') (c00010000 is
// turn 1's first call): turn = the index in AssembleInput.history (not among the kept turns), n = the call's place in
// that turn. Dropping older turns to fit renames nothing.

// ---- src/main/files/ingest.ts (PR 1) ----
export async function imageForModel(path: string, mime: string): Promise<ChatImage>

// ---- src/main/chat/rounds.ts (PR 1) ----
// RoundsInput keeps `model: ModelInfo`: runRounds stops reading it in PR 1 (the adapter picks the timeouts), and PR 2
// prices rounds by it. RoundsResult.genMs in PR 1 is Σ done.timing.genMs only (see "Contract changes").

// ---- tests/ollamaMock.ts (PR 1) ----
// OLLMOST_MOCK_DUMP=<absolute file>: the mock appends `<method> <url> <raw body>` for every request it receives.
```

## Contract changes (PR 0–1)

1. **`RoundsResult.genMs` has no wall-clock fallback in PR 1.** The contract says "Σ done.timing.genMs, else
   first-token→done wall clock". Ollama cloud models report no `eval_duration`, so today they get no tok/s at all; a
   wall-clock fallback in PR 1 would start showing tok/s on every cloud reply, which is a behaviour change. PR 1 sums
   `timing.genMs` only (0 when nothing reports it, exactly like `evalNs`). The fallback belongs to PR 3, where servers
   without timings arrive; whoever writes that task decides whether cloud Ollama replies get it too.
2. **Traces and `Trace.finish({ timing })` move in Task 1.6, not 1.7.** `runRounds` is `Trace.finish`'s main caller and
   `RoundsInput`'s new types force `delegate.ts` to change in the same task. Task 1.7 keeps the index's scope for the
   title, `/compact` and replay.

---

## PR 0 — Capture spike

**This runs on the user's Mac**, because it needs LM Studio at `localhost:1234` and a local Ollama. A cloud agent can't do it.

The script and everything it writes live in `docs/superpowers/plans/2026-09-27-model-endpoints-capture/`, beside this plan. Nothing in that folder ships in the app. Its recordings are committed as docs (Step 6), so that PR 3 can copy them into test fixtures, even when PR 3 runs somewhere else.

Only PR 3 needs this task. PRs 1 and 2 can start without it.

### Task 0.1: Capture spike (on the user's Mac; recordings committed as docs)

**Files:**
- Create: `docs/superpowers/plans/2026-09-27-model-endpoints-capture/capture.mjs`
- Create (by running it): `docs/superpowers/plans/2026-09-27-model-endpoints-capture/out/lmstudio/<case>.{sse,json}`, `out/ollama/<case>.{ndjson,json}`, one `<case>.meta.json` beside each, and `capture/FINDINGS.draft.md`
- Create (by hand): `docs/superpowers/plans/2026-09-27-model-endpoints-capture/FINDINGS.md`
- Test: none (a spike); Step 4 checks the draft against the raw bytes

**Interfaces:**
- Consumes: LM Studio's server at `http://localhost:1234` (`GET /v1/models`, `GET /api/v1/models`, `GET /api/v0/models`, `POST /v1/chat/completions`); Ollama at `http://localhost:11434` (`GET /api/version`, `GET /api/tags`, `POST /api/show`, `POST /api/chat`).
- Produces: raw fixtures for Task 3.1. Each `<case>.meta.json` holds the request, the status, the content type and every network chunk's arrival time and size, so the SSE mock can replay the same splits. Ollama streams are NDJSON, so they're saved as `.ndjson`, not `.sse`. `FINDINGS.md` answers the spec's six LM Studio questions plus three Ollama ones (O1–O3), for Task 3.4 (tool deltas), Task 3.5 (think mapping, `content: ''`), Task 3.6 (`stream_options`) and Task 3.7 (LM Studio discovery).

- [ ] **Step 1: Get the servers ready**

  - **LM Studio 0.4 or later:**
    - Start its server on port 1234 and turn on just-in-time model loading (Developer tab → Settings).
    - Download a model that calls tools and thinks, e.g. `qwen/qwen3-8b`.
    - If there's room, also download a vision model (e.g. `google/gemma-3-4b`) and `openai/gpt-oss-20b`, which takes
      reasoning levels.
    - Unload everything with `lms unload --all`: question 6 needs a cold start.
    - Note the version that `lms version` prints.
  - **Ollama:** it must be running with a local tools-and-thinking model (`ollama pull qwen3:8b`) and a vision model
    (`ollama pull gemma3:4b`).

  The script picks models from what each server reports and prefers local Ollama models, so it spends no cloud quota. To
  choose a model yourself, set `LMSTUDIO_TOOLS_MODEL`, `LMSTUDIO_VISION_MODEL`, `LMSTUDIO_THINK_MODEL`,
  `OLLAMA_TOOLS_MODEL`, `OLLAMA_VISION_MODEL` or `OLLAMA_THINK_MODEL`.

- [ ] **Step 2: Write the script**

```js
#!/usr/bin/env node
// Capture spike for the model-endpoints work (plan Task 0.1). It lives beside the plan. Its recordings are committed as
// docs so PR 3 can turn them into fixtures, and nothing here ships in the app.
// It records exactly what LM Studio's OpenAI-compatible API and local Ollama's /api/chat send back for the cases PR 3's
// fixtures need, then drafts answers to the spec's "Verify in the capture spike" questions.
//
//   node capture.mjs              capture from both servers, then write FINDINGS.draft.md
//   node capture.mjs lmstudio     one server only (or: ollama)
//   node capture.mjs --analyse    redo FINDINGS.draft.md from what out/ already holds
//
// Env: LMSTUDIO_URL (default http://localhost:1234), OLLAMA_URL (default http://localhost:11434). Models are picked from
// what each server reports; LMSTUDIO_TOOLS_MODEL, LMSTUDIO_VISION_MODEL, LMSTUDIO_THINK_MODEL, OLLAMA_TOOLS_MODEL,
// OLLAMA_VISION_MODEL and OLLAMA_THINK_MODEL choose one instead.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { deflateSync } from 'node:zlib'

const HERE = dirname(fileURLToPath(import.meta.url))
const OUT = join(HERE, 'out')
const LMSTUDIO = (process.env.LMSTUDIO_URL ?? 'http://localhost:1234').replace(/\/+$/, '')
const OLLAMA = (process.env.OLLAMA_URL ?? 'http://localhost:11434').replace(/\/+$/, '')
// A just-in-time load of a big model can take minutes; a server that isn't there fails at once anyway.
const TIMEOUT_MS = 10 * 60_000

// ---- A small PNG, made here so the script needs no files ------------------------------------------------------------

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})

function crc32(buf) {
  let c = 0xffffffff
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function pngChunk(type, data) {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([length, body, crc])
}

/** A size×size square of one colour, as base64 PNG (8-bit RGB). */
function squarePng(size, [r, g, b]) {
  const header = Buffer.alloc(13)
  header.writeUInt32BE(size, 0)
  header.writeUInt32BE(size, 4)
  header[8] = 8 // bits per channel
  header[9] = 2 // RGB
  const row = Buffer.from([0, ...Array.from({ length: size }, () => [r, g, b]).flat()]) // filter type 0, then the pixels
  const pixels = Buffer.concat(Array.from({ length: size }, () => row))
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  const png = [signature, pngChunk('IHDR', header), pngChunk('IDAT', deflateSync(pixels)), pngChunk('IEND', Buffer.alloc(0))]
  return Buffer.concat(png).toString('base64')
}

const RED_SQUARE = squarePng(64, [220, 30, 30])

// ---- Recording ------------------------------------------------------------------------------------------------------

/** Send one request and save the response exactly as its bytes arrived, with when each network chunk came. */
async function record(server, name, ext, url, body) {
  const dir = join(OUT, server)
  mkdirSync(dir, { recursive: true })
  const meta = { url, request: body ?? null, status: null, contentType: null, firstByteMs: null, totalMs: null, chunks: [], error: null }
  const started = Date.now()
  const parts = []
  try {
    const res = await fetch(url, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS)
    })
    meta.status = res.status
    meta.contentType = res.headers.get('content-type')
    if (res.body)
      for await (const part of res.body) {
        meta.firstByteMs ??= Date.now() - started
        meta.chunks.push({ atMs: Date.now() - started, bytes: part.byteLength })
        parts.push(Buffer.from(part))
      }
  } catch (err) {
    meta.error = err instanceof Error ? `${err.name}: ${err.message}` : String(err)
  }
  meta.totalMs = Date.now() - started
  const bytes = Buffer.concat(parts)
  writeFileSync(join(dir, `${name}.${ext}`), bytes)
  writeFileSync(join(dir, `${name}.meta.json`), `${JSON.stringify(meta, null, 2)}\n`)
  const outcome = meta.error ?? `HTTP ${meta.status}`
  console.log(`${server}/${name}.${ext}  ${outcome}  ${bytes.length} bytes in ${meta.chunks.length} chunks, ${meta.totalMs} ms`)
  return { ...meta, text: bytes.toString('utf8') }
}

const parse = (text) => {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

// ---- The cases ------------------------------------------------------------------------------------------------------

const WEATHER = {
  type: 'function',
  function: {
    name: 'get_weather',
    description: 'The current weather in a city.',
    parameters: { type: 'object', properties: { city: { type: 'string', description: 'The city, e.g. Paris' } }, required: ['city'] }
  }
}
const ask = (content) => [{ role: 'user', content }]
const HELLO = 'Say hello in five words.'
const ONE_CALL = "What's the weather in Paris right now? Use the get_weather tool."
const TWO_CALLS = 'Use get_weather for Paris and for Tokyo, calling the tool for both cities at once in one turn, then compare them.'
const SUM = 'What is 17 × 23? Think it through, then reply with just the number.'
const WEATHER_RESULT = '{"city":"Paris","forecast":"sunny","celsius":21}'
const COLOUR = 'What colour is this square? One word.'

/**
 * A turn Ollmost replays in PR 3: an assistant message with only tool calls, then the result, matched by id. The id is
 * one Ollmost makes up for an earlier turn's call (turn 0, call 0): 9 letters and digits, the shape Mistral's chat
 * templates on vLLM insist on.
 */
const openAIHistory = (content) => [
  { role: 'user', content: ONE_CALL },
  { role: 'assistant', content, tool_calls: [{ id: 'c00000000', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Paris"}' } }] },
  { role: 'tool', tool_call_id: 'c00000000', content: WEATHER_RESULT }
]

/** The same turn as Ollmost sends it to Ollama today (no ids), or with OpenAI-style ids added. */
const ollamaHistory = (ids) => [
  { role: 'user', content: ONE_CALL },
  { role: 'assistant', content: '', tool_calls: [{ ...(ids && { id: 'c00000000' }), function: { name: 'get_weather', arguments: { city: 'Paris' } } }] },
  { role: 'tool', ...(ids && { tool_call_id: 'c00000000' }), tool_name: 'get_weather', content: WEATHER_RESULT }
]

function pickLmStudio(native, openai) {
  const list = (native?.models ?? native?.data ?? []).filter((m) => (m.type ?? 'llm') === 'llm')
  const id = (m) => m?.key ?? m?.id ?? null
  const first = (test) => id(list.find(test))
  const chatIds = (openai?.data ?? []).map((m) => m.id).filter((i) => !/(^|[-_/])(embed|embedding|rerank)/i.test(i))
  return {
    tools: process.env.LMSTUDIO_TOOLS_MODEL ?? first((m) => m.capabilities?.trained_for_tool_use) ?? id(list[0]) ?? chatIds[0] ?? null,
    vision: process.env.LMSTUDIO_VISION_MODEL ?? first((m) => m.capabilities?.vision),
    think: process.env.LMSTUDIO_THINK_MODEL ?? first((m) => m.capabilities?.reasoning)
  }
}

async function lmstudio() {
  const server = 'lmstudio'
  // Question 6 compares this cold listing with one taken right after a just-in-time load.
  const native = parse((await record(server, 'models-api-v1-before', 'json', `${LMSTUDIO}/api/v1/models`)).text)
  await record(server, 'models-api-v0', 'json', `${LMSTUDIO}/api/v0/models`)
  const openai = parse((await record(server, 'models-v1', 'json', `${LMSTUDIO}/v1/models`)).text)
  const models = pickLmStudio(native, openai)
  console.log(`LM Studio models: ${JSON.stringify(models)}`)
  if (!models.tools) return console.log('LM Studio: nothing to capture with. Is the server started? Or set LMSTUDIO_TOOLS_MODEL.')

  const chat = (name, body) => record(server, name, body.stream ? 'sse' : 'json', `${LMSTUDIO}/v1/chat/completions`, body)
  const usage = { stream: true, stream_options: { include_usage: true } }
  await chat('plain', { model: models.tools, messages: ask(HELLO), ...usage })
  await record(server, 'models-api-v1-after-load', 'json', `${LMSTUDIO}/api/v1/models`)
  await chat('plain-no-usage', { model: models.tools, messages: ask(HELLO), stream: true })
  await chat('plain-once', { model: models.tools, messages: ask(HELLO), stream: false })
  await chat('tool-single', { model: models.tools, messages: ask(ONE_CALL), tools: [WEATHER], ...usage })
  await chat('tool-parallel', { model: models.tools, messages: ask(TWO_CALLS), tools: [WEATHER], ...usage })
  await chat('tool-single-once', { model: models.tools, messages: ask(ONE_CALL), tools: [WEATHER], stream: false })
  await chat('history-empty-content', { model: models.tools, messages: openAIHistory(''), tools: [WEATHER], ...usage })
  await chat('history-null-content', { model: models.tools, messages: openAIHistory(null), tools: [WEATHER], ...usage })
  if (models.vision) {
    const image = { type: 'image_url', image_url: { url: `data:image/png;base64,${RED_SQUARE}` } }
    await chat('image', { model: models.vision, messages: [{ role: 'user', content: [{ type: 'text', text: COLOUR }, image] }], ...usage })
  }
  if (models.think) {
    const think = (name, extra) => chat(name, { model: models.think, messages: ask(SUM), ...usage, ...extra })
    await think('think-default', {})
    await think('think-effort-low', { reasoning_effort: 'low' })
    await think('think-effort-high', { reasoning_effort: 'high' })
    await think('think-reasoning-object', { reasoning: { effort: 'low' } })
    await think('think-kwargs-off', { chat_template_kwargs: { enable_thinking: false } })
    await think('think-kwargs-on', { chat_template_kwargs: { enable_thinking: true } })
  }
  await chat('error-unknown-model', { model: 'ollmost-no-such-model', messages: ask('hi'), stream: false })
  await record(server, 'models-api-v1-after', 'json', `${LMSTUDIO}/api/v1/models`)
}

async function pickOllama(tags) {
  // Local models only: the spike shouldn't spend the user's cloud quota.
  const local = (tags?.models ?? []).filter((m) => !m.remote_host && !/(:|-)cloud$/.test(m.name)).map((m) => m.name)
  const capabilities = new Map()
  for (const name of local.slice(0, 30)) {
    const show = parse((await record('ollama', `show-${name.replace(/[^a-z0-9.-]+/gi, '_')}`, 'json', `${OLLAMA}/api/show`, { model: name })).text)
    capabilities.set(name, show?.capabilities ?? [])
  }
  const first = (cap) => local.find((n) => (capabilities.get(n) ?? []).includes(cap)) ?? null
  return {
    tools: process.env.OLLAMA_TOOLS_MODEL ?? first('tools'),
    vision: process.env.OLLAMA_VISION_MODEL ?? first('vision'),
    think: process.env.OLLAMA_THINK_MODEL ?? first('thinking')
  }
}

async function ollama() {
  const server = 'ollama'
  await record(server, 'version', 'json', `${OLLAMA}/api/version`)
  const models = await pickOllama(parse((await record(server, 'tags', 'json', `${OLLAMA}/api/tags`)).text))
  console.log(`Ollama models: ${JSON.stringify(models)}`)
  if (!models.tools) return console.log('Ollama: no local model with tools. Pull one (ollama pull qwen3:8b) or set OLLAMA_TOOLS_MODEL.')

  const chat = (name, body) => record(server, name, body.stream === false ? 'json' : 'ndjson', `${OLLAMA}/api/chat`, body)
  await chat('plain', { model: models.tools, messages: ask(HELLO), stream: true })
  await chat('plain-once', { model: models.tools, messages: ask(HELLO), stream: false })
  await chat('tool-single', { model: models.tools, messages: ask(ONE_CALL), tools: [WEATHER], stream: true })
  await chat('tool-parallel', { model: models.tools, messages: ask(TWO_CALLS), tools: [WEATHER], stream: true })
  await chat('history-tool-name', { model: models.tools, messages: ollamaHistory(false), tools: [WEATHER], stream: true })
  await chat('history-tool-call-id', { model: models.tools, messages: ollamaHistory(true), tools: [WEATHER], stream: true })
  if (models.vision)
    await chat('image', { model: models.vision, messages: [{ role: 'user', content: COLOUR, images: [RED_SQUARE] }], stream: true })
  if (models.think) {
    await chat('think-on', { model: models.think, messages: ask(SUM), think: true, stream: true })
    await chat('think-off', { model: models.think, messages: ask(SUM), think: false, stream: true })
    await chat('think-low', { model: models.think, messages: ask(SUM), think: 'low', stream: true })
  }
}

// ---- Drafting answers from the raw files ----------------------------------------------------------------------------

const read = (server, file) => {
  const path = join(OUT, server, file)
  return existsSync(path) ? readFileSync(path, 'utf8') : null
}
const metaOf = (server, name) => parse(read(server, `${name}.meta.json`) ?? '')
const statusOf = (server, name) => {
  const m = metaOf(server, name)
  return !m ? 'not captured' : (m.error ?? `HTTP ${m.status}`)
}

/** An SSE body's data payloads, and whether it ended with [DONE]. */
function sse(text) {
  const events = []
  let done = false
  for (const raw of (text ?? '').split('\n')) {
    const line = raw.replace(/\r$/, '')
    if (!line.startsWith('data:')) continue
    const data = line.slice(5).trim()
    if (data === '[DONE]') done = true
    else events.push(parse(data) ?? { unparsed: data })
  }
  return { events, done }
}
const ndjson = (text) =>
  (text ?? '')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => parse(l) ?? { unparsed: l })
const choicesOf = (events) => events.flatMap((e) => e.choices ?? [])
const deltasOf = (events) => choicesOf(events).map((c) => c.delta ?? {})

function lmThinking(name) {
  const text = read('lmstudio', `${name}.sse`)
  if (text === null) return `   - \`${name}\`: not captured`
  if (metaOf('lmstudio', name)?.status !== 200) return `   - \`${name}\`: ${statusOf('lmstudio', name)} ${text.slice(0, 200)}`
  const { events } = sse(text)
  const deltas = deltasOf(events)
  const reasoning = deltas.map((d) => d.reasoning ?? d.reasoning_content ?? '').join('')
  const content = deltas.map((d) => d.content ?? '').join('')
  const usage = events.find((e) => e.usage)?.usage
  const tags = /<\/?think>/.test(content) ? ' (content carries think tags)' : ''
  return `   - \`${name}\`: ${reasoning.length} reasoning chars, ${content.length} content chars${tags}; completion_tokens ${usage?.completion_tokens ?? '—'}, reasoning_tokens ${usage?.completion_tokens_details?.reasoning_tokens ?? '—'}`
}

function lmToolCalls(name) {
  const text = read('lmstudio', `${name}.sse`)
  if (text === null) return `   - \`${name}\`: not captured`
  const { events, done } = sse(text)
  const byIndex = new Map()
  for (const f of deltasOf(events).flatMap((d) => d.tool_calls ?? [])) byIndex.set(f.index, [...(byIndex.get(f.index) ?? []), f])
  const calls = [...byIndex].map(([index, fs]) => {
    const laterIds = [...new Set(fs.slice(1).map((f) => f.id).filter(Boolean))]
    const args = fs.map((f) => f.function?.arguments ?? '').join('')
    return `index ${index}: ${fs.length} fragment(s), id ${JSON.stringify(fs[0].id ?? null)} and name ${JSON.stringify(fs[0].function?.name ?? null)} on the first, ids on later ones ${JSON.stringify(laterIds)}, arguments ${JSON.stringify(args)}`
  })
  const finish = choicesOf(events)
    .map((c) => c.finish_reason)
    .filter(Boolean)
  return `   - \`${name}\`: ${calls.join(' | ') || 'no tool calls'}; finish_reason ${finish.join(',') || '—'}; ends with [DONE]: ${done}`
}

function lmUsage(name) {
  const text = read('lmstudio', `${name}.sse`)
  if (text === null) return `   - \`${name}\`: not captured`
  const carrier = sse(text).events.find((e) => e.usage)
  return `   - \`${name}\`: ${carrier ? `usage ${JSON.stringify(carrier.usage)} in a chunk whose choices are ${JSON.stringify(carrier.choices)}` : 'no usage anywhere'}`
}

function deltaKeys() {
  const seen = new Set()
  const names = ['plain', 'tool-single', 'think-default', 'think-effort-low', 'think-effort-high', 'think-kwargs-on', 'think-reasoning-object']
  for (const name of names) for (const d of deltasOf(sse(read('lmstudio', `${name}.sse`)).events)) Object.keys(d).forEach((k) => seen.add(k))
  return [...seen].sort().join(', ') || '(nothing captured)'
}

function lmHistory(name) {
  const text = read('lmstudio', `${name}.sse`)
  if (text === null) return `   - \`${name}\`: not captured`
  const reply = deltasOf(sse(text).events)
    .map((d) => d.content ?? '')
    .join('')
  return `   - \`${name}\`: ${statusOf('lmstudio', name)}; reply ${JSON.stringify((reply || text).slice(0, 160))}`
}

function lmLoaded(file) {
  const list = parse(read('lmstudio', file) ?? '')
  if (!list) return `   - \`${file}\`: not captured, or not JSON`
  const models = list.models ?? list.data ?? []
  const loaded = models
    .filter((m) => m.loaded_instances?.length)
    .map((m) => `${m.key ?? m.id} (context_length ${JSON.stringify(m.loaded_instances.map((i) => i.config?.context_length ?? null))}, max_context_length ${m.max_context_length ?? '—'})`)
  return `   - \`${file}\`: ${models.length} models; loaded: ${loaded.join('; ') || 'none'}`
}

function ollamaCalls(name) {
  const text = read('ollama', `${name}.ndjson`)
  if (text === null) return `   - \`${name}\`: not captured`
  const calls = ndjson(text).flatMap((c) => c.message?.tool_calls ?? [])
  return `   - \`${name}\`: ${calls.map((c) => JSON.stringify(c)).join(' ') || 'no tool calls'}`
}

function ollamaFinal(name) {
  const text = read('ollama', `${name}.ndjson`)
  if (text === null) return `   - \`${name}\`: not captured`
  const final = ndjson(text).find((c) => c.done)
  return `   - \`${name}\`: final chunk keys ${final ? Object.keys(final).join(', ') : '(no done chunk)'}`
}

function draft() {
  const thinkCases = ['think-default', 'think-effort-low', 'think-effort-high', 'think-reasoning-object', 'think-kwargs-off', 'think-kwargs-on']
  const lines = [
    `# Capture findings: draft (${new Date().toISOString().slice(0, 10)})`,
    '',
    'Read by the script from `out/`. Check every line against the raw files before writing FINDINGS.md.',
    '',
    '## LM Studio',
    '',
    '1. Which parameter changes reasoning on `/v1/chat/completions`? Compare the reasoning lengths:',
    ...thinkCases.map(lmThinking),
    '2. Are tool calls streamed as deltas or sent whole?',
    ...['tool-single', 'tool-parallel'].map(lmToolCalls),
    '3. Is `stream_options.include_usage` honoured?',
    ...['plain', 'plain-no-usage'].map(lmUsage),
    `4. \`reasoning\` or \`reasoning_content\`? Delta keys seen: ${deltaKeys()}`,
    "5. Is `content: ''` accepted next to `tool_calls` (and `null`)?",
    ...['history-empty-content', 'history-null-content'].map(lmHistory),
    '6. Does `loaded_instances[].config.context_length` appear after a just-in-time load?',
    ...['models-api-v1-before.json', 'models-api-v1-after-load.json', 'models-api-v1-after.json'].map(lmLoaded),
    '',
    '## Ollama',
    '',
    'O1. Do native tool calls carry `id` or `function.index`?',
    ...['tool-single', 'tool-parallel'].map(ollamaCalls),
    `O2. Does \`/api/chat\` take \`tool_call_id\`? history-tool-name: ${statusOf('ollama', 'history-tool-name')}; history-tool-call-id: ${statusOf('ollama', 'history-tool-call-id')}`,
    'O3. Which durations does the final chunk carry?',
    ...['plain', 'tool-single'].map(ollamaFinal),
    ''
  ]
  writeFileSync(join(HERE, 'FINDINGS.draft.md'), lines.join('\n'))
  console.log(`Draft: ${join(HERE, 'FINDINGS.draft.md')}`)
}

const args = process.argv.slice(2)
if (!args.includes('--analyse')) {
  const only = args.filter((a) => !a.startsWith('--'))
  if (!only.length || only.includes('lmstudio')) await lmstudio()
  if (!only.length || only.includes('ollama')) await ollama()
}
draft()
```

- [ ] **Step 3: Run it**

Run: `node docs/superpowers/plans/2026-09-27-model-endpoints-capture/capture.mjs`
Expected: one line per capture, for example `lmstudio/tool-parallel.sse  HTTP 200  4213 bytes in 37 chunks, 5120 ms`. Every
chat case is `HTTP 200` except `error-unknown-model`, which is a 4xx. `history-null-content`, `think-reasoning-object` and
Ollama's `think-low` on a model that isn't gpt-oss may also be 4xx, and those answers count as findings. The run ends
with `Draft: …/capture/FINDINGS.draft.md`. If a server wasn't reachable, its lines say
`TypeError: fetch failed`: start it and run `node capture.mjs lmstudio` (or `ollama`) again.

- [ ] **Step 4: Check the draft against the raw bytes**

Run:
```bash
cd docs/superpowers/plans/2026-09-27-model-endpoints-capture
tail -4 out/lmstudio/plain.sse           # a usage chunk (empty choices), then data: [DONE]
tail -4 out/lmstudio/plain-no-usage.sse  # no usage chunk
grep -c '"tool_calls"' out/lmstudio/tool-parallel.sse   # >1 means the calls came as deltas
grep -o '"tool_calls":\[[^]]*\]' out/ollama/tool-single.ndjson   # O1: is there an "id"? an "index"?
cat out/lmstudio/history-empty-content.meta.json | grep '"status"'
```
Expected: each command agrees with the matching line of `FINDINGS.draft.md`. If a line disagrees, the raw file is
right: write the correct answer by hand in the next step.

- [ ] **Step 5: Write `FINDINGS.md`**

Write `docs/superpowers/plans/2026-09-27-model-endpoints-capture/FINDINGS.md` in this shape. Every answer names the files that show
it and what it means for PR 3:

```markdown
# Capture spike findings: LM Studio <version>, Ollama <version> (<date>)

Models: LM Studio tools <…>, vision <…>, think <…>. Ollama tools <…>, vision <…>, think <…>.

## LM Studio

1. **What changes reasoning on `/v1/chat/completions`?** <`reasoning_effort` / `chat_template_kwargs.enable_thinking` /
   `reasoning.effort` / nothing>, from `think-*.sse` (reasoning chars: default N, low N, high N, kwargs-off N). →
   Task 3.5: `openAIThink` sends <…> for LM Studio. If nothing works: LM Studio models are display-only.
2. **Tool calls: deltas or whole?** <…>, from `tool-single.sse`/`tool-parallel.sse`: <fragments per call; does `id`
   come on the first fragment only; how are the parallel calls indexed; finish_reason>. → Task 3.4's fixtures.
3. **Is `stream_options.include_usage` honoured?** <yes: a final chunk with `choices: []` and `usage` / no>. → Task 3.6.
4. **`reasoning` or `reasoning_content`?** <…>, from the delta keys. → Task 3.6 reads `delta.reasoning ?? delta.reasoning_content`
   either way; say which the fixtures use.
5. **Is `content: ''` accepted next to `tool_calls`?** <status of history-empty-content>; `null`: <status>. →
   Task 3.5 sends <'' / null>.
6. **Does `loaded_instances[].config.context_length` appear after a just-in-time load?** <before: …; after the load:
   …>. → Task 3.7 prefers it over `max_context_length` <when present>.

## Ollama

O1. **Do native tool calls carry `id` / `function.index`?** <…>. (PR 1 echoes Ollama's calls exactly either way; this
    decides what PR 4's debugger shows.)
O2. **Does `/api/chat` accept `tool_call_id`?** <…>.
O3. **Which durations does the final chunk carry for a local model?** <load_duration, prompt_eval_duration, eval_duration …>.

## Surprises

- <anything a fixture or the adapter must allow for: comment lines, `event:` lines, keep-alives, error shapes>
```

- [ ] **Step 6: Commit the recordings as docs, and push**

Commit on whichever branch the implementation is on: `claude/model-endpoints-plan` if PR 1 hasn't started, otherwise the open PR's branch. `out/` needs `-f` because the root `.gitignore` ignores `out` (the build folder). `FINDINGS.draft.md` isn't committed.

```bash
C=docs/superpowers/plans/2026-09-27-model-endpoints-capture
git add $C/capture.mjs $C/FINDINGS.md
git add -f $C/out
git commit -m "Capture spike: how LM Studio and Ollama really answer, for PR 3's fixtures

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
git push
```

Tell the user the one-line answer to each question. Task 3.1 copies the captures it needs into `tests/fixtures/sse/` and `tests/fixtures/discovery/`. **If `FINDINGS.md` isn't on the branch when PR 3 starts, stop and ask the user to run this task.**

---

## PR 1 — The seam (no behaviour change)

Branch: `claude/model-endpoints-seam`, created from `claude/model-endpoints-plan`: `main` @ `24f4623` plus the spec,
its review, the mockups and this plan (docs only). The docs ship with PR 1; nothing else on that branch differs from
`main`.

Line numbers are against `main` @ `24f4623` (#179, #180 and then #175 merged). Since `97b17f9`, `main` gained 4b69183
(a plain-English out-of-memory error in `src/main/ollama/client.ts`, +10 lines from line 59), 9d00209 (a compaction's
clock in `service.ts`, +2 lines from line 711) and #175 (parallel sub-agents: `rounds.ts` +8 lines above the loop,
+31 where its per-call loop became `runCall`, `batchesOf` and `runTogether`, and +57 after `runRounds`; `service.ts` +2
at line 413, +1 at 440 and +1 at 470; `delegate.ts` +15; `tools.ts` +5 from line 129 and +11 further down;
`assemble.ts` +2 from line 87; `settings.ts` +3 from line 8; `tests/service.test.ts` +15 from line 1980 and +369 more
below line 2136); the numbers below include all of them. When an earlier task in this PR has already edited a
file, the step also names the code to find, and that name wins.

Ollama moves behind a `Provider` interface, and every caller speaks the neutral types in `src/main/providers/types.ts`.
"No behaviour change" means the following:

- **Requests are the same bytes.** Every request body the mock Ollama receives in `tests/service.test.ts` is
  byte-identical before and after, #175's tests of sub-agents running at the same time included. Task 1.1 dumps them
  before anything changes and Task 1.8 compares. `tests/ollamaAdapter.test.ts` pins the same thing unit by unit.
- **Parallel sub-agents run as they do on `main`.** #175's batches stay: calls a round makes in a row to a tool that
  may run beside others (`delegate`) still run up to Settings' limit at once, a call the limit kept waiting is still
  saved as not run when the reply stops, and the results still go to the model in call order. Only the shape each
  result is pushed in changes (neutral, with its call's id), and an Ollama body leaves the id out.
- **Tool calls go back as Ollama sent them.** A call Ollama sent is echoed back exactly as Ollama sent it, with its own
  id and index if it gave them. An id Ollmost made up (`t00000000` for a call that came without one, `c00010000` for an
  earlier turn's call) never appears in an Ollama body.
- **Nothing the user sees in the chat changes.** Saved messages, stats (tok/s included), usage rows, errors and the chat
  UI stay as they are.
- **The debugger is measured at the seam.** This is the only place a difference can show, and it's only in the debugger:
  - a trace's `chunks` counts events, so a chunk that held two tool calls counts twice;
  - a trace's tool calls carry the neutral id, which is Ollama's own when Ollama sends one;
  - the `OLLMOST_DEBUG=1` log line is the wire body, so it gains `"stream":true`.

Existing tests change only where the types they build or read change: `tests/assemble.test.ts` reads neutral messages,
and the `runRounds` block in `tests/service.test.ts` passes a provider and a `ChatRequest`. #175's tests (the
`runRounds` test of calls that run together, and the `describe('sub-agents')` tests of two or three delegations at
once) don't change at all. The equivalence of what reaches Ollama is proven by the new identity tests, not by leaving
those assertions alone.

### Task 1.1: Neutral types and secrets

**Files:**
- Create: `src/main/providers/types.ts`
- Create: `src/main/providers/secrets.ts`
- Modify: `src/main/settings.ts:1,5,66-81` (the ollama.com key goes through `secrets.ts`)
- Modify: `tests/ollamaMock.ts:1-27` (`OLLMOST_MOCK_DUMP`, for the body-identity check)
- Test: `tests/secrets.test.ts`

**Interfaces:**
- Consumes: `readSetting`, `writeSetting`, `deleteSetting` (`src/main/db/kv.ts`); Electron's `safeStorage`; `ModelInfo`, `ThinkProfile`, `ThinkSetting` (`@shared/types`).
- Produces: every name in the Shared contracts' `providers/types.ts` block (`ToolCall`, `IdentifiedToolCall`, `ToolDef`, `ChatImage`, `ChatMessage`, `ChatRequest`, `RequestUsage`, `ChatTiming`, `ChatEvent`, `ChatResult`, `WireRequest`, `Provider`), with `Provider.wireEndpoint(): string` added. From `secrets.ts`: `OLLAMA_ACCOUNT_SECRET = 'apiKey'`, `endpointSecretName(id)`, `setSecret(name, value)`, `getSecret(name)`. `getApiKey`/`setApiKey` keep their signatures and now wrap `getSecret`/`setSecret`.

- [ ] **Step 1: Check the preconditions and branch**

Run:
```bash
cd ~/projects/anthropic_local
git fetch origin
git log origin/main --oneline -1 --grep 'sub-agents-2'          # the #131 merge
git log origin/main --oneline -1 --grep 'parallel-sub-agents'   # the #175 merge, 24f4623
gh pr view 125 --json state --jq .state                          # MERGED
gh pr list --state open --json number,headRefName --jq '.[] | "\(.number) \(.headRefName)"'
```
Expected: both merge commits are listed and #125 is `MERGED`. For every open PR, `gh pr diff <number> --name-only` must
list nothing under `src/main/chat/` or `src/main/ollama/`. On 2026-09-27 the only one was #124 (the #101 design), docs
only. If #101's code has started, it must use `src/main/providers/secrets.ts`: say so on its PR. If any check fails,
stop and tell the user.

Then branch from `claude/model-endpoints-plan`, which carries the spec, its review, the mockups and this plan:
```bash
git switch -c claude/model-endpoints-seam claude/model-endpoints-plan
git rebase origin/main                                           # only if main has moved past 24f4623
git diff --name-only origin/main...HEAD
```
Expected: the last command lists only files under `docs/superpowers/` (the spec, `…-review.md`, the mockups folder and
this plan). Anything else means the branch isn't what this plan expects: stop and tell the user.

- [ ] **Step 2: Record what the mock Ollama receives today**

Nothing under `src/` changes before this baseline is taken. In `tests/ollamaMock.ts`, add the import at the top and the
dump line after the body is read. Lines 1–2 become:

```ts
import { appendFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
```

and lines 22–25 become:

```ts
    let raw = ''
    for await (const part of req) raw += part
    // OLLMOST_MOCK_DUMP=<file> appends every request as received, so a refactor can show it still sends the same bytes.
    if (process.env.OLLMOST_MOCK_DUMP) appendFileSync(process.env.OLLMOST_MOCK_DUMP, `${req.method} ${req.url} ${raw}\n`)
    const json = raw ? (JSON.parse(raw) as Record<string, unknown>) : {}
    mock.requests.push(json)
```

Run:
```bash
rm -f /tmp/ollmost-seam-before.txt
OLLMOST_MOCK_DUMP=/tmp/ollmost-seam-before.txt npx vitest run tests/service.test.ts
wc -l /tmp/ollmost-seam-before.txt
```
Expected: PASS, and the file has several hundred lines. The baseline covers every service test on `main` @ 24f4623,
#175's included: `runRounds`' "runs calls that may go together at once…" and the `describe('sub-agents')` tests of two
or three delegations at once, of Settings' limit, of Stop while they run, and of a call between two delegations. Their
children reach the mock in either order from run to run, which is fine: Task 1.8 sorts both dumps before comparing.
Keep it until Task 1.8. If it's lost, rebuild it from `main` with this step's mock in place, without touching the
branch:
```bash
git worktree add /tmp/ollmost-seam-base origin/main
cp tests/ollamaMock.ts /tmp/ollmost-seam-base/tests/ollamaMock.ts
ln -s "$PWD/node_modules" /tmp/ollmost-seam-base/node_modules
(cd /tmp/ollmost-seam-base && OLLMOST_MOCK_DUMP=/tmp/ollmost-seam-before.txt npx vitest run tests/service.test.ts)
git worktree remove --force /tmp/ollmost-seam-base
```

- [ ] **Step 3: Write the failing test**

`tests/secrets.test.ts`:
```ts
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

// A stand-in keychain: "sealed:" marks what it encrypted, and it refuses anything else.
const keychain = vi.hoisted(() => ({ available: true }))
vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: () => keychain.available,
    encryptString: (s: string) => Buffer.from(`sealed:${s}`),
    decryptString: (b: Buffer) => {
      const s = b.toString()
      if (!s.startsWith('sealed:')) throw new Error('not sealed here')
      return s.slice('sealed:'.length)
    }
  }
}))

const { openDatabase } = await import('../src/main/db/index')
const { readSetting, writeSetting } = await import('../src/main/db/kv')
const { endpointSecretName, getSecret, OLLAMA_ACCOUNT_SECRET, setSecret } = await import('../src/main/providers/secrets')
const { getApiKey, setApiKey } = await import('../src/main/settings')

beforeAll(() => openDatabase(':memory:'))
beforeEach(() => {
  keychain.available = true
})

describe('secrets', () => {
  it('names an endpoint key by its endpoint, and keeps the ollama.com key in the row it always had', () => {
    expect(endpointSecretName('lm-studio')).toBe('endpointKey:lm-studio')
    expect(OLLAMA_ACCOUNT_SECRET).toBe('apiKey')
  })

  it('stores a secret encrypted and trimmed, and reads it back', () => {
    setSecret('endpointKey:lm-studio', '  sk-local  ')
    expect(readSetting<string | null>('endpointKey:lm-studio', null)).toBe(Buffer.from('sealed:sk-local').toString('base64'))
    expect(getSecret('endpointKey:lm-studio')).toBe('sk-local')
  })

  it('deletes a secret set to null or empty', () => {
    setSecret('endpointKey:a', 'k')
    setSecret('endpointKey:a', null)
    expect(readSetting<string | null>('endpointKey:a', null)).toBeNull()
    setSecret('endpointKey:b', 'k')
    setSecret('endpointKey:b', '')
    expect(getSecret('endpointKey:b')).toBeNull()
  })

  it('reads a row this keychain cannot open as no secret', () => {
    writeSetting('endpointKey:c', Buffer.from('another Mac').toString('base64'))
    expect(getSecret('endpointKey:c')).toBeNull()
  })

  it('refuses to store a secret without OS encryption', () => {
    keychain.available = false
    expect(() => setSecret('endpointKey:d', 'k')).toThrow('OS encryption is unavailable; cannot store the API key')
    expect(getSecret('endpointKey:d')).toBeNull()
  })

  it('is what the settings API key reads and writes', () => {
    setApiKey('ollama-key')
    expect(getSecret(OLLAMA_ACCOUNT_SECRET)).toBe('ollama-key')
    setSecret(OLLAMA_ACCOUNT_SECRET, 'rotated')
    expect(getApiKey()).toBe('rotated')
    setApiKey(null)
    expect(getSecret(OLLAMA_ACCOUNT_SECRET)).toBeNull()
  })
})
```

- [ ] **Step 4: Run it to verify it fails**

Run: `npx vitest run tests/secrets.test.ts`
Expected: FAIL. The module `../src/main/providers/secrets` can't be found ("Failed to load url" or "Cannot find module").

- [ ] **Step 5: Implement**

`src/main/providers/types.ts`:
```ts
import type { ModelInfo, ThinkProfile, ThinkSetting } from '@shared/types'

// The shapes every model server is spoken to in. Shared code builds and reads only these; each adapter translates them
// to and from its server's API, so nothing one server needs (Ollama's num_ctx, OpenAI's tool_call_id) leaks out.

/** A tool call as the loop and tools.ts see it: today's shape plus an id. Adapters and assemble() always set `id`. */
export interface ToolCall {
  id?: string
  function: { name: string; arguments: Record<string, unknown> | string }
}

export type IdentifiedToolCall = ToolCall & { id: string }

/** A tool offered with a request: the OpenAI function-tool shape, which Ollama takes as it is. */
export interface ToolDef {
  type: 'function'
  function: { name: string; description: string; parameters: Record<string, unknown> }
}

/** An image for a vision model: base64 without a `data:` prefix, and the type it's encoded in. */
export interface ChatImage {
  data: string
  mime: string
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
  /** An earlier round's reasoning in this turn; only an adapter whose server takes it back sends it. */
  thinking?: string
  images?: ChatImage[]
  toolCalls?: ToolCall[]
  /** For a tool result: the call it answers. */
  toolCallId?: string
  /** For a tool result: the tool that produced it. */
  toolName?: string
}

export interface ChatRequest {
  /** The model's name at its server, never a key with an endpoint in front. */
  model: string
  messages: ChatMessage[]
  tools?: ToolDef[]
  /** The user's choice; the adapter turns it into its server's parameter through `profile`. */
  think: ThinkSetting | null
  profile: ThinkProfile
  /** The window the request was fitted to; an adapter whose server takes a context size sends it. */
  contextWindow: number | null
  temperature?: number
}

export interface RequestUsage {
  prompt?: number
  completion?: number
}

/** The server's own durations for a request, in ms, when it reports them. */
export interface ChatTiming {
  loadMs?: number
  promptMs?: number
  genMs?: number
}

/**
 * What a streamed reply is made of. `content` may be empty: a chunk that carried nothing, which only tells the loop the
 * server is there. A `toolCall` comes only once the call is complete. `done` ends a finished reply; its `raw` is the
 * server's closing record without the reply's text, which the debugger shows.
 */
export type ChatEvent =
  | { type: 'content'; text: string }
  | { type: 'thinking'; text: string }
  | { type: 'toolCall'; call: IdentifiedToolCall }
  | { type: 'done'; usage: RequestUsage; finishReason?: string; timing?: ChatTiming; raw: unknown }

/** A reply read whole: titles, /compact and replay. */
export interface ChatResult {
  content: string
  thinking: string
  toolCalls: IdentifiedToolCall[]
  usage: RequestUsage
  finishReason?: string
  timing?: ChatTiming
  raw: unknown
}

/** A request as it goes over the wire: where to, and the exact body. */
export interface WireRequest {
  endpoint: string
  body: unknown
}

/** One model server behind the seam. Every model call reaches it through registry.resolve(). */
export interface Provider {
  readonly id: string
  /** Every model it serves; throws when nothing can be listed. */
  listModels(refresh: boolean): Promise<ModelInfo[]>
  modelInfo(model: string, refresh?: boolean): Promise<ModelInfo>
  chatStream(req: ChatRequest, signal: AbortSignal): AsyncGenerator<ChatEvent>
  chatOnce(req: ChatRequest, opts: { signal?: AbortSignal; timeoutMs: number }): Promise<ChatResult>
  /** Exactly what chatStream (`stream` true) or chatOnce (false) sends; traces record it. */
  wire(req: ChatRequest, stream: boolean): WireRequest
  /** Where wire bodies go: the endpoint a replayed trace is sent to. */
  wireEndpoint(): string
  /** Send a body already in this server's shape (a replayed trace, perhaps edited), not streamed. */
  sendWire(body: unknown, opts: { signal?: AbortSignal; timeoutMs: number }): Promise<ChatResult>
}
```

`src/main/providers/secrets.ts`:
```ts
import { safeStorage } from 'electron'
import { deleteSetting, readSetting, writeSetting } from '../db/kv'

// Keys never leave the main process. At rest each one is encrypted with the OS keychain, in a kv row of its own.

/** The ollama.com account key (web tools, quota, an Ollama endpoint on ollama.com), in the row it always had. */
export const OLLAMA_ACCOUNT_SECRET = 'apiKey'

/** The row an endpoint's own key lives in. */
export function endpointSecretName(id: string): string {
  return `endpointKey:${id}`
}

/** Store a secret, or delete it when `value` is null or empty. */
export function setSecret(name: string, value: string | null): void {
  if (!value) return deleteSetting(name)
  if (!safeStorage.isEncryptionAvailable()) throw new Error('OS encryption is unavailable; cannot store the API key')
  writeSetting(name, safeStorage.encryptString(value.trim()).toString('base64'))
}

/** A stored secret, or null when there is none or this keychain can't open it (a database from another Mac). */
export function getSecret(name: string): string | null {
  const enc = readSetting<string | null>(name, null)
  if (!enc) return null
  try {
    return safeStorage.decryptString(Buffer.from(enc, 'base64'))
  } catch {
    return null
  }
}
```

`src/main/settings.ts`: line 1 (`import { safeStorage } from 'electron'`) goes. Line 5 becomes
`import { readSetting, writeSetting } from './db/kv'`, followed by the new import
`import { getSecret, OLLAMA_ACCOUNT_SECRET, setSecret } from './providers/secrets'`. Lines 66–81 (the key functions,
below #175's `DEFAULT_SUB_AGENTS_AT_ONCE` and `DEFAULTS`, which stay as they are) become:

```ts
// The ollama.com API key never leaves the main process; see providers/secrets.ts.
export function setApiKey(key: string | null): void {
  setSecret(OLLAMA_ACCOUNT_SECRET, key)
}

export function getApiKey(): string | null {
  return getSecret(OLLAMA_ACCOUNT_SECRET)
}
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx vitest run tests/secrets.test.ts`, then
`npx prettier --write src/main/providers tests/secrets.test.ts tests/ollamaMock.ts src/main/settings.ts`, then
`npm run typecheck && npm run lint && npm run format:check && npm test`.
Expected: PASS. `types.ts` has no caller yet; the typecheck is what proves it compiles.

- [ ] **Step 7: Commit**

```bash
git add src/main/providers/types.ts src/main/providers/secrets.ts src/main/settings.ts tests/secrets.test.ts tests/ollamaMock.ts
git commit -m "Neutral chat types for every model server, and one place for secrets

The ollama.com key keeps its kv row and now goes through providers/secrets.ts, which endpoint keys (and #101's
credentials) will share. The Ollama mock can dump what it receives, so the refactor that follows can show it sends
the same bytes.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 1.2: Move the Ollama client and models under `providers/ollama/`

**Files:**
- Move: `src/main/ollama/client.ts` → `src/main/providers/ollama/wire.ts`
- Move: `src/main/ollama/models.ts` → `src/main/providers/ollama/models.ts`
- Modify (imports only, plus `OllamaTool` → `ToolDef`): `src/main/ollama/web.ts:2`, `src/main/usage/pricing.ts:4`, `src/main/usage/account.ts:4`, `src/main/ipc.ts:46,96`, `src/main/chat/rounds.ts:7`, `src/main/chat/service.ts:37-38`, `src/main/chat/delegate.ts:8-9,24`, `src/main/chat/assemble.ts:3`, `src/main/chat/tools.ts:2,90,153-154`, `src/main/chat/webTools.ts:2,8`, `src/main/chat/skillTools.ts:1,5`, `src/main/runner/provider.ts:7,25`, `src/main/mcp/provider.ts:4,81`, `src/main/code/tools.ts:3,33,50,69,86,105,121`, `src/main/debug/replay.ts:4`
- Test: `tests/client.test.ts:10`, `tests/service.test.ts:51` (import paths only)

**Interfaces:**
- Consumes: `ToolCall`, `ToolDef` (Task 1.1).
- Produces: `src/main/providers/ollama/wire.ts` with every export `client.ts` had (`OLLAMA_CLOUD`, `OllamaMessage`, `ChatBody`, `ChatChunk`, `OllamaError`, `StreamTimeouts`, `STREAM_TIMEOUTS`, `streamTimeoutsFor`, `chatStream`, `chatOnce`, `TagModel`, `listTags`, `ShowResponse`, `showModel`, `isCloudName`, `endpointFor`, `connectionMode`). Two things change: `ToolCall` becomes `OllamaToolCall` (it gains `id?` and `function.index?`), and `OllamaTool` is removed in favour of `ToolDef`. `ChatChunk` gains `load_duration?` and `prompt_eval_duration?`. `src/main/providers/ollama/models.ts` keeps every export unchanged.

The files move as they are on `main` when this task starts. `client.ts` there includes 4b69183's out-of-memory error
(`NOT_ENOUGH_MEMORY_RE` and `notEnoughMemory(detail, model?)` above `friendly()`). The moved wire keeps every behaviour
it had:
- `friendly()`'s messages: a 401/403 asks for the key (direct mode) or `ollama signin` (local); a 429 is the usage
  limit; a 404 "not found" names the model; Ollama's "model requires more system memory" becomes *"Not enough memory to
  load “<model>”. Lower the context window in Settings → Models, or pick a smaller or more quantized model."*; anything
  else is Ollama's own detail, or "Ollama returned HTTP <status>".
- `chatStream`'s in-stream `chunk.error` goes through `notEnoughMemory(chunk.error, body.model)` too (both places).
- `request()`'s "Can't reach Ollama at …" / "Can't reach https://ollama.com" / "took too long" wording, and the first-byte,
  idle and tool-idle stall messages.

- [ ] **Step 1: Move the files**

```bash
mkdir -p src/main/providers/ollama
git mv src/main/ollama/client.ts src/main/providers/ollama/wire.ts
git mv src/main/ollama/models.ts src/main/providers/ollama/models.ts
```

- [ ] **Step 2: Rewrite the top of `wire.ts`**

Lines 1–41 of `src/main/providers/ollama/wire.ts` (the import through `ChatChunk`) become:

```ts
// Ollama's HTTP API: /api/chat as NDJSON, /api/tags and /api/show. Only the adapter (adapter.ts) and the model list
// (models.ts) call it; everything else speaks the neutral types in ../types.ts.
import { getApiKey, getSettings } from '../../settings'
import type { ToolDef } from '../types'

export const OLLAMA_CLOUD = 'https://ollama.com'

/** A tool call as Ollama sends it. Newer versions give each call an `id` and say which came first (`index`). */
export interface OllamaToolCall {
  id?: string
  function: { index?: number; name: string; arguments: Record<string, unknown> | string }
}

export interface OllamaMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
  thinking?: string
  images?: string[]
  tool_calls?: OllamaToolCall[]
  tool_name?: string
}

export interface ChatBody {
  model: string
  messages: OllamaMessage[]
  think?: boolean | 'low' | 'medium' | 'high'
  tools?: ToolDef[]
  options?: Record<string, unknown>
  keep_alive?: string
}

export interface ChatChunk {
  message?: { role: string; content?: string; thinking?: string; tool_calls?: OllamaToolCall[] }
  done: boolean
  done_reason?: string
  prompt_eval_count?: number
  eval_count?: number
  /** Nanoseconds, like every Ollama duration. */
  load_duration?: number
  prompt_eval_duration?: number
  eval_duration?: number
  total_duration?: number
  error?: string
}
```

Nothing below line 41 changes: `OllamaError`, `target()`, `NOT_ENOUGH_MEMORY_RE`, `notEnoughMemory()`, `friendly()`
(with its not-enough-memory branch) and everything after them stay exactly as `main` has them.

- [ ] **Step 3: Rewrite the imports of `models.ts`**

Lines 2–6 of `src/main/providers/ollama/models.ts` become:

```ts
import { type CachedModelInfo, readModelProfile, writeModelInfo, writeModelOverrides } from '../../db/kv'
import { getSettings } from '../../settings'
import { errorMessage } from '../../util'
import { modelPrice } from '../../usage/pricing'
import { connectionMode, isCloudName, listTags, showModel } from './wire'
```

- [ ] **Step 4: Point every importer at the new places**

| File | Line(s) | Becomes |
|---|---|---|
| `src/main/ollama/web.ts` | 2 | `import { OLLAMA_CLOUD, OllamaError } from '../providers/ollama/wire'` |
| `src/main/usage/pricing.ts` | 4 | `import { connectionMode, isCloudName } from '../providers/ollama/wire'` |
| `src/main/usage/account.ts` | 4 | `import { OLLAMA_CLOUD } from '../providers/ollama/wire'` |
| `src/main/ipc.ts` | 46 | `import { getModelInfo, listModels, setModelOverrides } from './providers/ollama/models'` |
| `src/main/ipc.ts` | 96 | `import { connectionMode, endpointFor } from './providers/ollama/wire'` |
| `src/main/chat/rounds.ts` | 7 | `import { type ChatBody, type ChatChunk, chatStream, endpointFor, streamTimeoutsFor } from '../providers/ollama/wire'` and a new line after it: `import type { ToolCall } from '../providers/types'` |
| `src/main/chat/service.ts` | 37–38 | `import { type ChatBody, chatOnce, endpointFor } from '../providers/ollama/wire'` and `import { getModelInfo } from '../providers/ollama/models'` |
| `src/main/chat/delegate.ts` | 8–9 | `import type { ChatBody } from '../providers/ollama/wire'`, `import { getModelInfo } from '../providers/ollama/models'` and `import type { ToolDef } from '../providers/types'`; line 24 `const DELEGATE_TOOL: ToolDef = {`. Lines 7 and 10 (#175's `Settings` type and `DEFAULT_SUB_AGENTS_AT_ONCE` import) stay |
| `src/main/chat/assemble.ts` | 3 | `import type { OllamaMessage } from '../providers/ollama/wire'` |
| `src/main/chat/tools.ts` | 2 | `import type { ToolCall, ToolDef } from '../providers/types'`; `OllamaTool` → `ToolDef` at lines 90, 153 and 154. #175's `runsInParallel(call: ToolCall, …)` and `notRunEvent` take the neutral `ToolCall` as they are |
| `src/main/chat/webTools.ts` | 2 | `import type { ToolDef } from '../providers/types'`; line 8 `export const WEB_TOOLS: ToolDef[] = [` |
| `src/main/chat/skillTools.ts` | 1 | `import type { ToolDef } from '../providers/types'`; line 5 `export const SKILL_TOOLS: ToolDef[] = [` |
| `src/main/runner/provider.ts` | 7 | `import type { ToolDef } from '../providers/types'`; line 25 `export const RUN_CODE: ToolDef = {` |
| `src/main/mcp/provider.ts` | 4 | `import type { ToolDef } from '../providers/types'`; line 81 `definition: ToolDef` |
| `src/main/code/tools.ts` | 3 | `import type { ToolDef } from '../providers/types'`; `OllamaTool` → `ToolDef` at lines 33, 50, 69, 86, 105 and 121 |
| `src/main/debug/replay.ts` | 4 | `import { type ChatBody, chatOnce, endpointFor } from '../providers/ollama/wire'` |
| `tests/client.test.ts` | 10 | `const { chatOnce, chatStream, OllamaError, STREAM_TIMEOUTS, streamTimeoutsFor } = await import('../src/main/providers/ollama/wire')` |
| `tests/service.test.ts` | 51 | `const { getModelInfo } = await import('../src/main/providers/ollama/models')` |

The `OllamaTool` → `ToolDef` renames are mechanical:
```bash
sed -i '' 's/OllamaTool/ToolDef/g' src/main/chat/tools.ts src/main/chat/webTools.ts src/main/chat/skillTools.ts src/main/chat/delegate.ts \
  src/main/runner/provider.ts src/main/mcp/provider.ts src/main/code/tools.ts
```
Then fix each import line as the table says: the `sed` leaves them pointing at `../ollama/client`. `rounds.ts` compiles
unchanged below its imports. Its `calls: ToolCall[]` now holds neutral calls, which Ollama's calls fit, and it echoes
them into a `ChatBody` as before; #175's `ShownCall` and `batchesOf(calls: ToolCall[], …)` read the same `ToolCall`,
now the neutral one.

Run: `git grep -nE "(\.|main)/ollama/(client|models)'|OllamaTool([^C]|$)" -- src tests`
Expected: no output. The pattern skips `providers/ollama/…` and `OllamaToolCall`.

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run tests/client.test.ts tests/service.test.ts`, then
`npx prettier --write src/main tests/client.test.ts tests/service.test.ts`, then
`npm run typecheck && npm run lint && npm run format:check && npm test`.
Expected: PASS, with no test changed beyond the two import lines. That includes `tests/client.test.ts`'s two
not-enough-memory tests (4b69183): "turns a not-enough-memory error chunk into a friendly, model-naming message" and
"turns a not-enough-memory HTTP error into a friendly, model-naming message".

- [ ] **Step 6: Commit**

```bash
git add -A src/main tests/client.test.ts tests/service.test.ts
git commit -m "Move the Ollama client and model list under providers/ollama

client.ts becomes wire.ts: the HTTP and NDJSON side of Ollama, unchanged. Tool definitions are ToolDef everywhere,
the OpenAI function-tool shape they already had, and a call Ollama sends is an OllamaToolCall.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 1.3: The Ollama adapter: `toOllamaBody` and `ollamaEvents`

**Files:**
- Create: `src/main/providers/ollama/adapter.ts`
- Modify: `src/main/providers/ollama/models.ts:130-136` (`getModelInfo` gains `refresh`)
- Test: `tests/ollamaAdapter.test.ts`

**Interfaces:**
- Consumes: `ChatRequest`, `ChatMessage`, `ChatEvent`, `ChatResult`, `ChatTiming`, `ChatImage`, `ToolCall`, `IdentifiedToolCall`, `Provider`, `WireRequest` (Task 1.1); from `wire.ts`: `ChatBody`, `ChatChunk`, `OllamaMessage`, `OllamaToolCall`, `OllamaError`, `StreamTimeouts`, `streamTimeoutsFor`, `chatStream`, `chatOnce`, `connectionMode`, `isCloudName`, `endpointFor` (Task 1.2); `listModels`, `getModelInfo` (`models.ts`); `toOllamaThink(profile, setting)` (`@shared/thinking`).
- Produces:
```ts
export function toOllamaMessage(m: ChatMessage): OllamaMessage
export function toOllamaBody(req: ChatRequest): ChatBody
export function ollamaEvents(chunks: AsyncIterable<ChatChunk>): AsyncGenerator<ChatEvent>
export function resultFromOllama(res: ChatChunk): ChatResult
export function ollamaTimeouts(model: string): StreamTimeouts
export class OllamaProvider implements Provider { readonly id = 'ollama' }
```
  Where a model runs is today's `location` rule: cloud = `connectionMode() === 'direct' || isCloudName(name)`. Only a
  local request with a `contextWindow` sends `options.num_ctx`, and only local models get the long tool-call idle.

- [ ] **Step 1: Write the failing test**

`tests/ollamaAdapter.test.ts`:
```ts
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ThinkProfile, ThinkSetting } from '@shared/types'
import type { ChatChunk } from '../src/main/providers/ollama/wire'
import type { ChatEvent, ChatRequest, ToolDef } from '../src/main/providers/types'
import { line, type MockOllama, startMockOllama, streamChunks } from './ollamaMock'

// Only the connection Settings → Models points at is faked.
const conn = vi.hoisted(() => ({ mode: 'local' as 'local' | 'direct', host: '' }))
vi.mock('../src/main/settings', () => ({
  getSettings: () => ({ connection: { mode: conn.mode, host: conn.host } }),
  getApiKey: () => null
}))

const { ollamaEvents, OllamaProvider, ollamaTimeouts, resultFromOllama, toOllamaBody } = await import('../src/main/providers/ollama/adapter')
const { STREAM_TIMEOUTS } = await import('../src/main/providers/ollama/wire')

let ollama: MockOllama
beforeAll(async () => {
  ollama = await startMockOllama()
  conn.host = ollama.url
})
afterAll(() => ollama.close())
beforeEach(() => {
  conn.mode = 'local'
})

const weather: ToolDef = {
  type: 'function',
  function: { name: 'get_weather', description: 'Weather for a city', parameters: { type: 'object', properties: { city: { type: 'string' } } } }
}
const plain: ChatRequest = { model: 'llama3.2', messages: [{ role: 'user', content: 'hi' }], think: null, profile: { kind: 'none' }, contextWindow: null }

async function* from<T>(items: T[]): AsyncGenerator<T> {
  for (const item of items) yield item
}
async function collect<T>(items: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = []
  for await (const item of items) out.push(item)
  return out
}
const callsIn = (events: ChatEvent[]) => events.flatMap((e) => (e.type === 'toolCall' ? [e.call] : []))
/** JSON keeps key order, so equal strings mean Ollama gets equal bytes. */
const bytes = (value: unknown) => JSON.stringify(value)

describe('toOllamaBody: Ollama gets the bytes it got before the seam', () => {
  it('sends past calls, an image turn and this turn’s tool round exactly as before', async () => {
    // This turn's first round as Ollama streamed it: the call carries Ollama's own id and index.
    const round = await collect(
      ollamaEvents(
        from<ChatChunk>([
          {
            message: {
              role: 'assistant',
              content: '',
              tool_calls: [{ id: 'call_ab12', function: { index: 0, name: 'get_weather', arguments: { city: 'Paris' } } }]
            },
            done: false
          },
          { done: true, done_reason: 'stop', prompt_eval_count: 40, eval_count: 9 }
        ])
      )
    )
    const calls = callsIn(round)
    const request: ChatRequest = {
      model: 'llama3.2',
      messages: [
        { role: 'system', content: 'You are helpful.' },
        { role: 'user', content: 'what is in the news?' },
        // An earlier turn's call, as assemble() replays it: its made-up id must never reach Ollama.
        { role: 'assistant', content: '', toolCalls: [{ id: 'c00010000', function: { name: 'web_search', arguments: { query: 'news' } } }] },
        { role: 'tool', toolName: 'web_search', toolCallId: 'c00010000', content: '1. Ollmosts are back' },
        { role: 'assistant', content: 'Ollmosts are back.' },
        { role: 'user', content: 'what is this?', images: [{ data: 'iVBORw0KGgo=', mime: 'image/png' }] },
        // This turn's round as runRounds echoes it, then the result.
        { role: 'assistant', content: 'Let me check.', thinking: 'They want the weather.', toolCalls: calls },
        { role: 'tool', content: 'sunny', toolName: 'get_weather', toolCallId: calls[0].id }
      ],
      tools: [weather],
      think: 'on',
      profile: { kind: 'toggle' },
      contextWindow: 8192
    }
    // What service.ts, assemble.ts and rounds.ts sent before the seam, written out by hand.
    const before = {
      model: 'llama3.2',
      messages: [
        { role: 'system', content: 'You are helpful.' },
        { role: 'user', content: 'what is in the news?' },
        { role: 'assistant', content: '', tool_calls: [{ function: { name: 'web_search', arguments: { query: 'news' } } }] },
        { role: 'tool', tool_name: 'web_search', content: '1. Ollmosts are back' },
        { role: 'assistant', content: 'Ollmosts are back.' },
        { role: 'user', content: 'what is this?', images: ['iVBORw0KGgo='] },
        {
          role: 'assistant',
          content: 'Let me check.',
          thinking: 'They want the weather.',
          tool_calls: [{ id: 'call_ab12', function: { index: 0, name: 'get_weather', arguments: { city: 'Paris' } } }]
        },
        { role: 'tool', content: 'sunny', tool_name: 'get_weather' }
      ],
      think: true,
      tools: [weather],
      options: { num_ctx: 8192 }
    }
    expect(bytes(toOllamaBody(request))).toBe(bytes(before))
  })

  it('gives a call Ollama sent without an id one of its own, and never sends that id', async () => {
    const [call] = callsIn(
      await collect(
        ollamaEvents(
          from<ChatChunk>([
            { message: { role: 'assistant', content: '', tool_calls: [{ function: { name: 'get_weather', arguments: { city: 'Oslo' } } }] }, done: false }
          ])
        )
      )
    )
    // Nine letters and digits, like every id Ollmost makes up (Mistral's templates on vLLM refuse any other shape).
    expect(call).toEqual({ id: 't00000000', function: { name: 'get_weather', arguments: { city: 'Oslo' } } })
    const body = toOllamaBody({
      ...plain,
      messages: [
        { role: 'assistant', content: '', toolCalls: [call] },
        { role: 'tool', content: 'rain', toolName: 'get_weather', toolCallId: call.id }
      ]
    })
    expect(bytes(body.messages)).toBe(
      bytes([
        { role: 'assistant', content: '', tool_calls: [{ function: { name: 'get_weather', arguments: { city: 'Oslo' } } }] },
        { role: 'tool', content: 'rain', tool_name: 'get_weather' }
      ])
    )
  })

  it('sends a title or summary as before: the least thinking, then temperature before num_ctx', () => {
    const titleOf = (profile: ThinkProfile, think: ThinkSetting | null) =>
      toOllamaBody({
        model: 'qwen3:8b',
        messages: [
          { role: 'system', content: 'T' },
          { role: 'user', content: 'U' }
        ],
        think,
        profile,
        contextWindow: 32_768,
        temperature: 0.3
      })
    expect(bytes(titleOf({ kind: 'toggle' }, 'off'))).toBe(
      bytes({
        model: 'qwen3:8b',
        messages: [
          { role: 'system', content: 'T' },
          { role: 'user', content: 'U' }
        ],
        think: false,
        options: { temperature: 0.3, num_ctx: 32_768 }
      })
    )
    expect(titleOf({ kind: 'levels', canDisable: false }, 'low').think).toBe('low')
    expect(bytes(titleOf({ kind: 'always' }, null))).not.toContain('"think"')
    expect(bytes(titleOf({ kind: 'none' }, null))).not.toContain('"think"')
  })

  it('leaves the window to cloud models: no num_ctx for a -cloud name, nor for any model in direct mode', () => {
    const cloud: ChatRequest = {
      model: 'gpt-oss:120b-cloud',
      messages: [{ role: 'user', content: 'hi' }],
      think: 'medium',
      profile: { kind: 'levels', canDisable: false },
      contextWindow: 131_072
    }
    expect(bytes(toOllamaBody(cloud))).toBe('{"model":"gpt-oss:120b-cloud","messages":[{"role":"user","content":"hi"}],"think":"medium"}')
    conn.mode = 'direct'
    expect(toOllamaBody({ ...cloud, model: 'gpt-oss:120b' }).options).toBeUndefined()
    expect(toOllamaBody({ ...cloud, model: 'gpt-oss:120b', temperature: 0.3 }).options).toEqual({ temperature: 0.3 })
  })

  it('sends no options for a local request with no window', () => {
    expect(bytes(toOllamaBody(plain))).toBe('{"model":"llama3.2","messages":[{"role":"user","content":"hi"}]}')
  })
})

describe('ollamaEvents', () => {
  it('turns NDJSON chunks into neutral events, in order', async () => {
    const final: ChatChunk = {
      message: { role: 'assistant', content: '' },
      done: true,
      done_reason: 'stop',
      prompt_eval_count: 12,
      eval_count: 5,
      load_duration: 2_500_000,
      prompt_eval_duration: 1_000_000,
      eval_duration: 4_000_000_000
    }
    const events = await collect(
      ollamaEvents(
        from<ChatChunk>([
          { message: { role: 'assistant', content: '' }, done: false },
          { message: { role: 'assistant', content: '', thinking: 'Hmm.' }, done: false },
          { message: { role: 'assistant', content: 'Hi' }, done: false },
          {
            message: {
              role: 'assistant',
              content: '',
              tool_calls: [
                { function: { name: 'a', arguments: {} } },
                { function: { name: 'b', arguments: '{"x":1}' } }
              ]
            },
            done: false
          },
          final
        ])
      )
    )
    const { message: _message, ...closing } = final
    expect(events).toEqual([
      // A chunk with nothing in it still says Ollama is there.
      { type: 'content', text: '' },
      { type: 'thinking', text: 'Hmm.' },
      { type: 'content', text: 'Hi' },
      { type: 'toolCall', call: { id: 't00000000', function: { name: 'a', arguments: {} } } },
      { type: 'toolCall', call: { id: 't00000001', function: { name: 'b', arguments: '{"x":1}' } } },
      { type: 'done', usage: { prompt: 12, completion: 5 }, finishReason: 'stop', timing: { loadMs: 2.5, promptMs: 1, genMs: 4000 }, raw: closing }
    ])
  })

  it('reports no usage or timing a server leaves out', async () => {
    expect(await collect(ollamaEvents(from<ChatChunk>([{ done: true }])))).toEqual([
      { type: 'done', usage: {}, timing: {}, raw: { done: true } }
    ])
  })

  it('reads a reply that came whole', () => {
    expect(
      resultFromOllama({
        message: { role: 'assistant', content: 'Title', thinking: 'short' },
        done: true,
        done_reason: 'stop',
        prompt_eval_count: 7,
        eval_count: 2
      })
    ).toEqual({
      content: 'Title',
      thinking: 'short',
      toolCalls: [],
      usage: { prompt: 7, completion: 2 },
      finishReason: 'stop',
      timing: {},
      raw: { done: true, done_reason: 'stop', prompt_eval_count: 7, eval_count: 2 }
    })
  })
})

describe('OllamaProvider', () => {
  const provider = new OllamaProvider()
  const req: ChatRequest = { ...plain, contextWindow: 4096 }

  it('streams /api/chat with exactly the body wire() describes', async () => {
    ollama.handler = (_req, res) =>
      streamChunks(res, [line({ message: { role: 'assistant', content: 'Hello' }, done: false }), line({ done: true, eval_count: 1 })]).then(() =>
        res.end()
      )
    const events = await collect(provider.chatStream(req, new AbortController().signal))
    expect(events.map((e) => e.type)).toEqual(['content', 'done'])
    const wire = provider.wire(req, true)
    expect(wire.endpoint).toBe(`${ollama.url}/api/chat`)
    expect(ollama.requests.at(-1)).toEqual(wire.body)
    expect(bytes(wire.body)).toBe('{"model":"llama3.2","messages":[{"role":"user","content":"hi"}],"options":{"num_ctx":4096},"stream":true}')
  })

  it('reads a chatOnce reply', async () => {
    ollama.handler = (_req, res) =>
      void res.writeHead(200).end(JSON.stringify({ message: { role: 'assistant', content: 'A title' }, done: true, eval_count: 2 }))
    const res = await provider.chatOnce(req, { timeoutMs: 2_000 })
    expect(res).toMatchObject({ content: 'A title', usage: { completion: 2 } })
    expect(ollama.requests.at(-1)).toMatchObject({ stream: false })
  })

  it('sends a replayed body as it is, not streamed', async () => {
    ollama.handler = (_req, res) =>
      void res.writeHead(200).end(JSON.stringify({ message: { role: 'assistant', content: 'again' }, done: true, eval_count: 1 }))
    const res = await provider.sendWire({ model: 'llama3.2', messages: [{ role: 'user', content: 'hi' }], stream: false }, { timeoutMs: 2_000 })
    expect(res.content).toBe('again')
    expect(bytes(ollama.requests.at(-1))).toBe('{"model":"llama3.2","messages":[{"role":"user","content":"hi"}],"stream":false}')
    expect(provider.wireEndpoint()).toBe(`${ollama.url}/api/chat`)
  })

  it('gives only models on this Mac the long quiet allowance for tool calls', () => {
    expect(ollamaTimeouts('llama3.2')).toEqual(STREAM_TIMEOUTS)
    expect(ollamaTimeouts('gpt-oss:120b-cloud').toolIdleMs).toBe(STREAM_TIMEOUTS.idleMs)
    conn.mode = 'direct'
    expect(ollamaTimeouts('gpt-oss:120b').toolIdleMs).toBe(STREAM_TIMEOUTS.idleMs)
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/ollamaAdapter.test.ts`
Expected: FAIL. The module `../src/main/providers/ollama/adapter` can't be found.

- [ ] **Step 3: Implement**

In `src/main/providers/ollama/models.ts`, lines 130–136 become:
```ts
export async function getModelInfo(name: string, refresh = false): Promise<ModelInfo> {
  try {
    return toModelInfo(name, await fetchInfo(name, refresh), true)
  } catch {
    return toModelInfo(name, { capabilities: ['completion'], contextLength: null, family: null, parameterSize: null }, false)
  }
}
```

`src/main/providers/ollama/adapter.ts`:
```ts
import { toOllamaThink } from '@shared/thinking'
import type { ModelInfo } from '@shared/types'
import type { ChatEvent, ChatImage, ChatMessage, ChatRequest, ChatResult, ChatTiming, IdentifiedToolCall, Provider, ToolCall, WireRequest } from '../types'
import { getModelInfo, listModels as listOllamaModels } from './models'
import {
  type ChatBody,
  type ChatChunk,
  chatOnce as postChat,
  chatStream as streamChat,
  connectionMode,
  endpointFor,
  isCloudName,
  OllamaError,
  type OllamaMessage,
  type OllamaToolCall,
  type StreamTimeouts,
  streamTimeoutsFor
} from './wire'

// Ollama's side of the seam: neutral requests become /api/chat bodies, NDJSON chunks become neutral events. A body is
// byte for byte what Ollmost sent before the seam existed (tests/ollamaAdapter.test.ts holds it to that).

/** Where a model runs, by the one rule: everything through ollama.com, and `-cloud` names through the app. */
const runsInCloud = (model: string): boolean => connectionMode() === 'direct' || isCloudName(model)

/**
 * The long tool-call allowance is only for models on this Mac: Ollama holds a call back until its arguments are
 * complete, and a slow local model can be quiet for minutes. A cloud model that goes quiet has dropped.
 */
export function ollamaTimeouts(model: string): StreamTimeouts {
  return streamTimeoutsFor(runsInCloud(model) ? 'cloud' : 'local')
}

// Each call Ollama sent, by the neutral call made from it. The next round echoes a call back exactly as Ollama sent it,
// its own id and index included. A call assemble() rebuilt from history has no entry and goes back without the id
// Ollmost gave it.
const sentByOllama = new WeakMap<ToolCall, OllamaToolCall>()

function identify(raw: OllamaToolCall, n: number): IdentifiedToolCall {
  // An id of Ollmost's own is 9 letters and digits ("t" and the call's place in base 36): Mistral's chat templates on
  // vLLM refuse any other shape, and the loop's calls may reach such a server later in the chat.
  const call = { id: raw.id ?? `t${n.toString(36).padStart(8, '0')}`, function: raw.function }
  sentByOllama.set(call, raw)
  return call
}

/** One message in Ollama's shape, key by key in the order it was built (JSON keeps that order). */
export function toOllamaMessage(m: ChatMessage): OllamaMessage {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(m)) {
    if (value === undefined) continue
    if (key === 'images') out.images = (value as ChatImage[]).map((image) => image.data)
    else if (key === 'toolCalls') out.tool_calls = (value as ToolCall[]).map((call) => sentByOllama.get(call) ?? { function: call.function })
    else if (key === 'toolName') out.tool_name = value
    // Ollama matches a result to its call by order and tool_name.
    else if (key !== 'toolCallId') out[key] = value
  }
  return out as unknown as OllamaMessage
}

/**
 * The /api/chat body for a request. A local model gets the request's window as num_ctx on every call, titles included:
 * a request with a different num_ctx makes Ollama reload the model. Cloud models manage their own context.
 */
export function toOllamaBody(req: ChatRequest): ChatBody {
  const numCtx = runsInCloud(req.model) || req.contextWindow == null ? undefined : req.contextWindow
  const options =
    req.temperature === undefined && numCtx === undefined
      ? undefined
      : { ...(req.temperature !== undefined && { temperature: req.temperature }), ...(numCtx !== undefined && { num_ctx: numCtx }) }
  return {
    model: req.model,
    messages: req.messages.map(toOllamaMessage),
    think: toOllamaThink(req.profile, req.think),
    tools: req.tools,
    options
  }
}

const nsToMs = (ns: number | undefined): number | undefined => (typeof ns === 'number' ? ns / 1e6 : undefined)
const timingOf = (c: ChatChunk): ChatTiming => ({
  loadMs: nsToMs(c.load_duration),
  promptMs: nsToMs(c.prompt_eval_duration),
  genMs: nsToMs(c.eval_duration)
})
const usageOf = (c: ChatChunk) => ({ prompt: c.prompt_eval_count, completion: c.eval_count })

/** The final chunk without the reply's text: its counts, durations and done_reason. */
function closing(c: ChatChunk): unknown {
  const { message: _message, ...rest } = c
  return rest
}

/** Ollama's NDJSON chunks as neutral events. Ollama sends each tool call whole. */
export async function* ollamaEvents(chunks: AsyncIterable<ChatChunk>): AsyncGenerator<ChatEvent> {
  let calls = 0
  for await (const chunk of chunks) {
    const m = chunk.message
    let said = false
    if (m?.thinking) {
      said = true
      yield { type: 'thinking', text: m.thinking }
    }
    if (m?.content) {
      said = true
      yield { type: 'content', text: m.content }
    }
    for (const raw of m?.tool_calls ?? []) {
      said = true
      yield { type: 'toolCall', call: identify(raw, calls++) }
    }
    if (chunk.done) yield { type: 'done', usage: usageOf(chunk), finishReason: chunk.done_reason, timing: timingOf(chunk), raw: closing(chunk) }
    // A chunk with nothing in it still says Ollama is there: the loop times the first byte by it.
    else if (!said) yield { type: 'content', text: '' }
  }
}

/** A /api/chat reply that came whole. */
export function resultFromOllama(res: ChatChunk): ChatResult {
  return {
    content: res.message?.content ?? '',
    thinking: res.message?.thinking ?? '',
    toolCalls: (res.message?.tool_calls ?? []).map((raw, n) => identify(raw, n)),
    usage: usageOf(res),
    finishReason: res.done_reason,
    timing: timingOf(res),
    raw: closing(res)
  }
}

/** The Ollama app, or ollama.com in direct mode: whichever Settings → Models points at. */
export class OllamaProvider implements Provider {
  readonly id = 'ollama'

  async listModels(refresh: boolean): Promise<ModelInfo[]> {
    const { models, error } = await listOllamaModels(refresh)
    // The list carries an error only when it's empty; the registry reports it in place of the models.
    if (error) throw new OllamaError(error)
    return models
  }

  modelInfo(model: string, refresh = false): Promise<ModelInfo> {
    return getModelInfo(model, refresh)
  }

  async *chatStream(req: ChatRequest, signal: AbortSignal): AsyncGenerator<ChatEvent> {
    yield* ollamaEvents(streamChat(toOllamaBody(req), signal, ollamaTimeouts(req.model)))
  }

  async chatOnce(req: ChatRequest, opts: { signal?: AbortSignal; timeoutMs: number }): Promise<ChatResult> {
    return resultFromOllama(await postChat(toOllamaBody(req), opts))
  }

  wire(req: ChatRequest, stream: boolean): WireRequest {
    return { endpoint: this.wireEndpoint(), body: { ...toOllamaBody(req), stream } }
  }

  wireEndpoint(): string {
    return endpointFor('/api/chat')
  }

  async sendWire(body: unknown, opts: { signal?: AbortSignal; timeoutMs: number }): Promise<ChatResult> {
    return resultFromOllama(await postChat(body as ChatBody, opts))
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/ollamaAdapter.test.ts`, then
`npx prettier --write src/main/providers tests/ollamaAdapter.test.ts`, then
`npm run typecheck && npm run lint && npm run format:check && npm test`.
Expected: PASS. Nothing calls the adapter yet.

- [ ] **Step 5: Commit**

```bash
git add src/main/providers/ollama/adapter.ts src/main/providers/ollama/models.ts tests/ollamaAdapter.test.ts
git commit -m "The Ollama adapter: neutral requests in, neutral events out, same bytes on the wire

toOllamaBody builds what service.ts, assemble.ts and rounds.ts built before, key for key; a call Ollama sent is
echoed back exactly as it came, and an id Ollmost made up never reaches Ollama. num_ctx and the tool-call allowance
follow the same cloud-or-local rule as before.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 1.4: The registry (Ollama only)

**Files:**
- Create: `src/main/providers/registry.ts`
- Modify: `src/main/ipc.ts:46,204-206` (`models.list` and `models.info` through the registry)
- Modify: `src/main/chat/service.ts:38,294,671,792`, `src/main/chat/delegate.ts:9,104` (`getModelInfo` → `modelInfo`)
- Test: `tests/registry.test.ts`

**Interfaces:**
- Consumes: `OllamaProvider` (Task 1.3); `ModelInfo`, `ModelListResult` (today's `{ models; error: string | null }`); `errorMessage` (`src/main/util.ts`).
- Produces:
```ts
export function resolve(model: string): { provider: Provider; model: string }   // PR 1: always Ollama, the whole name
export function modelInfo(model: string, refresh?: boolean): Promise<ModelInfo>
export function listAllModels(refresh?: boolean): Promise<ModelListResult>      // PR 1: today's { models, error } shape
```

- [ ] **Step 1: Write the failing test**

`tests/registry.test.ts`:
```ts
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { type MockOllama, startMockOllama } from './ollamaMock'

vi.mock('electron', () => ({
  safeStorage: { isEncryptionAvailable: () => false, encryptString: () => Buffer.alloc(0), decryptString: () => '' }
}))

const { openDatabase } = await import('../src/main/db/index')
const { updateSettings } = await import('../src/main/settings')
const { listAllModels, modelInfo, resolve } = await import('../src/main/providers/registry')

let ollama: MockOllama
beforeAll(async () => {
  openDatabase(':memory:')
  ollama = await startMockOllama()
  // The cloud catalog would reach ollama.com; these tests list only what the mock app has.
  updateSettings({ connection: { mode: 'local', host: ollama.url }, showCloudCatalog: false })
  ollama.handler = (req, res) => {
    if (req.url === '/api/tags')
      return void res.writeHead(200).end(JSON.stringify({ models: [{ name: 'llama3.2' }, { name: 'hf.co/bartowski/Qwen3-8B-GGUF:Q4_K_M' }] }))
    if (req.url === '/api/show')
      return void res
        .writeHead(200)
        .end(JSON.stringify({ capabilities: ['completion', req.json.model === 'llama3.2' ? 'tools' : 'vision'], model_info: { 'llama.context_length': 8192 } }))
    res.writeHead(404).end()
  }
})
afterAll(() => ollama.close())

describe('registry (Ollama only)', () => {
  it('resolves every model to the Ollama provider, by its whole name', () => {
    expect(resolve('llama3.2').provider.id).toBe('ollama')
    expect(resolve('llama3.2').model).toBe('llama3.2')
    // A name with '/' in it is still one Ollama name.
    expect(resolve('hf.co/bartowski/Qwen3-8B-GGUF:Q4_K_M').model).toBe('hf.co/bartowski/Qwen3-8B-GGUF:Q4_K_M')
  })

  it('lists the models with no error, as models.list did', async () => {
    const out = await listAllModels(true)
    expect(out.error).toBeNull()
    expect(out.models.map((m) => m.name)).toEqual(['hf.co/bartowski/Qwen3-8B-GGUF:Q4_K_M', 'llama3.2'])
  })

  it('reads one model’s info through its provider', async () => {
    expect(await modelInfo('llama3.2')).toMatchObject({ name: 'llama3.2', location: 'local', capabilities: ['completion', 'tools'], contextLength: 8192 })
  })

  it('reports an app it can’t reach as the list’s error, with no models', async () => {
    updateSettings({ connection: { mode: 'local', host: 'http://127.0.0.1:1' } })
    try {
      expect(await listAllModels(true)).toEqual({ models: [], error: expect.stringMatching(/^Can't reach Ollama at http:\/\/127\.0\.0\.1:1\./) })
    } finally {
      updateSettings({ connection: { mode: 'local', host: ollama.url } })
    }
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/registry.test.ts`
Expected: FAIL. The module `../src/main/providers/registry` can't be found.

- [ ] **Step 3: Implement**

`src/main/providers/registry.ts`:
```ts
import type { ModelInfo, ModelListResult } from '@shared/types'
import { errorMessage } from '../util'
import { OllamaProvider } from './ollama/adapter'
import type { Provider } from './types'

// Every model call goes through here. The reply loop, sub-agents, titles, /compact and replay ask for a model's
// provider; none of them reaches for a server itself. For now there is one server: the Ollama app, or ollama.com.
const ollama = new OllamaProvider()

/** The provider a model is served by, and the model's name there. */
export function resolve(model: string): { provider: Provider; model: string } {
  return { provider: ollama, model }
}

export function modelInfo(model: string, refresh = false): Promise<ModelInfo> {
  const r = resolve(model)
  return r.provider.modelInfo(r.model, refresh)
}

/** Every model on offer, or, when none can be listed, why. */
export async function listAllModels(refresh = false): Promise<ModelListResult> {
  try {
    return { models: await ollama.listModels(refresh), error: null }
  } catch (err) {
    return { models: [], error: errorMessage(err) }
  }
}
```

`src/main/ipc.ts`: line 46 becomes two lines:
```ts
import { setModelOverrides } from './providers/ollama/models'
import { listAllModels, modelInfo } from './providers/registry'
```
and the `models` handlers (lines 204–206 at the anchor, one lower now) become:
```ts
    list: (refresh) => listAllModels(refresh),
    info: (name) => modelInfo(name),
    setOverrides: (name, overrides) => setModelOverrides(name, overrides)
```

`src/main/chat/service.ts`: line 38 becomes `import { modelInfo } from '../providers/registry'`, and the three calls
change name only:
- line 294 `const model = await modelInfo(modelName)`
- line 671 `const info = await modelInfo(opts.model)`
- line 792 `const info = await modelInfo(modelName)`

`src/main/chat/delegate.ts`: the `getModelInfo` import (line 9) becomes `import { modelInfo } from '../providers/registry'`,
and the call in `runChild` (line 104 at the anchor) becomes `const model = await modelInfo(reply.model)`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/registry.test.ts tests/service.test.ts`, then
`npx prettier --write src/main tests/registry.test.ts`, then
`npm run typecheck && npm run lint && npm run format:check && npm test`.
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/main/providers/registry.ts src/main/ipc.ts src/main/chat/service.ts src/main/chat/delegate.ts tests/registry.test.ts
git commit -m "A registry every model call goes through, with Ollama its only provider for now

resolve() hands back a model's provider and its name there; the model list and model info come through it, with
the same result and error as before.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 1.5: `assemble.ts` emits neutral messages; `imageForModel` returns the mime type

**Files:**
- Modify: `src/main/chat/assemble.ts:3,42-43,94-99,150-167,238-242`
- Modify: `src/main/files/ingest.ts:65-75`
- Modify: `src/main/chat/service.ts:452-459` and `src/main/chat/delegate.ts:138-144`. Until Task 1.6 they still send a `ChatBody`, so they pass `assembled.messages.map(toOllamaMessage)`.
- Test: `tests/assemble.test.ts:74-77,257-265` (the neutral shape) plus two new tests; `tests/imageForModel.test.ts` (new); `tests/ollamaAdapter.test.ts` (one new test). #175's "tells a reply that may delegate whether its sub-agents run at the same time" (lines 141–156) reads only the system prompt and stays as it is.

**Interfaces:**
- Consumes: `ChatMessage`, `ChatImage` (Task 1.1); `toOllamaMessage` (Task 1.3).
- Produces: `HistoryTurn.images: ChatImage[]`; `Assembled.messages: ChatMessage[]`. An earlier turn's calls get ids `'c' + turn.toString(36).padStart(4, '0') + n.toString(36).padStart(4, '0')` (`c00010000`: 9 letters and digits, the only shape Mistral's chat templates on vLLM accept), where `turn` is the turn's index in `AssembleInput.history` and `n` the call's place in it. The tool results carry `toolName` and `toolCallId`. `imageForModel(path, mime): Promise<ChatImage>`: the mime is the image's own when it's sent as it is, `image/png` for a resized PNG, and `image/jpeg` for anything re-encoded.

- [ ] **Step 1: Write the failing tests**

In `tests/assemble.test.ts`, the image test (lines 74–77) becomes:
```ts
  it('passes images through for vision models, with their type', () => {
    const image = { data: 'AAAA', mime: 'image/png' }
    const { messages } = assemble({ ...base, history: [turn('user', 'what is this', { images: [image] })] })
    expect(messages[1].images).toEqual([image])
  })
```

The first test in `describe('past web calls')` (lines 257–265) becomes the one below, and the two tests after it are new:
```ts
  it('replays them as a tool call and result before the reply that used them', () => {
    const roles = assemble({ ...base, history }).messages.map((m) => m.role)
    expect(roles).toEqual(['system', 'user', 'assistant', 'tool', 'assistant', 'user'])
    const [call, result] = assemble({ ...base, history }).messages.slice(2, 4)
    expect(call.toolCalls).toEqual([{ id: 'c00010000', function: { name: 'web_search', arguments: { query: 'news' } } }])
    expect(result).toMatchObject({ role: 'tool', toolName: 'web_search', toolCallId: 'c00010000' })
    expect(result.content).toContain('https://b.example/pots')
    expect(result.content).toMatch(/Untrusted web data/)
  })

  it('names each call by its turn and place, the same on every request', () => {
    const both: HistoryTurn = {
      ...turn('assistant', 'Both.'),
      tools: [
        { name: 'web_search', args: { query: 'a' }, record: 'A' },
        { name: 'web_fetch', args: { url: 'https://b.example' }, record: 'B' }
      ]
    }
    const longer = [...history, both, turn('user', 'and now?')]
    const first = assemble({ ...base, history: longer }).messages
    // 'c', the turn's index and the call's place, 4 base-36 digits each: 9 letters and digits, as Mistral's templates want.
    expect(first.flatMap((m) => m.toolCalls?.map((c) => c.id) ?? [])).toEqual(['c00010000', 'c00030000', 'c00030001'])
    expect(first.filter((m) => m.role === 'tool').map((m) => m.toolCallId)).toEqual(['c00010000', 'c00030000', 'c00030001'])
    // The same history makes the same request, byte for byte.
    expect(JSON.stringify(assemble({ ...base, history: longer }).messages)).toBe(JSON.stringify(first))
  })

  it('keeps a call’s id when older turns are dropped to fit', () => {
    const found: HistoryTurn = { ...turn('assistant', 'Found it.'), tools: [{ name: 'web_search', args: { query: 'b' }, record: 'B' }] }
    const longer = [turn('user', 'x'.repeat(400_000)), turn('assistant', 'long ago'), turn('user', 'q2'), found, turn('user', 'q3')]
    const { messages, droppedTurns } = assemble({ ...base, contextLength: 32_000, history: longer })
    expect(droppedTurns).toBe(2)
    expect(messages.flatMap((m) => m.toolCalls?.map((c) => c.id) ?? [])).toEqual(['c00030000'])
  })
```

`tests/imageForModel.test.ts`:
```ts
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// A stand-in for Electron's nativeImage: each test says how big the image is, or that Electron can't read it.
const image = vi.hoisted(() => ({ size: { width: 800, height: 600 }, empty: false }))
vi.mock('electron', () => {
  const img = {
    isEmpty: () => image.empty,
    getSize: () => image.size,
    resize: () => img,
    toPNG: () => Buffer.from('png-bytes'),
    toJPEG: () => Buffer.from('jpeg-bytes')
  }
  return { nativeImage: { createFromPath: () => img } }
})

const { imageForModel } = await import('../src/main/files/ingest')

const dir = mkdtempSync(join(tmpdir(), 'ollmost-image-'))
const file = (name: string) => {
  const path = join(dir, name)
  writeFileSync(path, 'file-bytes')
  return path
}
const b64 = (s: string) => Buffer.from(s).toString('base64')

beforeEach(() => {
  image.size = { width: 800, height: 600 }
  image.empty = false
})

describe('imageForModel', () => {
  it('sends a small PNG or JPEG as it is, with its own type', async () => {
    expect(await imageForModel(file('a.png'), 'image/png')).toEqual({ data: b64('file-bytes'), mime: 'image/png' })
    expect(await imageForModel(file('a.jpg'), 'image/jpeg')).toEqual({ data: b64('file-bytes'), mime: 'image/jpeg' })
  })

  it('re-encodes any other type as JPEG, and says so', async () => {
    expect(await imageForModel(file('a.webp'), 'image/webp')).toEqual({ data: b64('jpeg-bytes'), mime: 'image/jpeg' })
  })

  it('keeps a large PNG a PNG when it shrinks it', async () => {
    image.size = { width: 4000, height: 3000 }
    expect(await imageForModel(file('big.png'), 'image/png')).toEqual({ data: b64('png-bytes'), mime: 'image/png' })
    expect(await imageForModel(file('big.jpg'), 'image/jpeg')).toEqual({ data: b64('jpeg-bytes'), mime: 'image/jpeg' })
  })

  it('sends an image Electron can’t read as it is', async () => {
    image.empty = true
    expect(await imageForModel(file('a.gif'), 'image/gif')).toEqual({ data: b64('file-bytes'), mime: 'image/gif' })
  })
})
```

In `tests/ollamaAdapter.test.ts`, add `import { assemble } from '../src/main/chat/assemble'` to the imports and
`toOllamaMessage` to the adapter's destructured names. Then append:
```ts
describe('assemble() through the adapter', () => {
  it('replays history to Ollama exactly as before: calls without ids, results by tool_name, images as base64', () => {
    const { messages } = assemble({
      model: 'llama3.2',
      contextLength: 8192,
      userName: '',
      preferences: '',
      date: new Date('2026-09-27'),
      artifacts: { enabled: false, allowCdn: false },
      web: 'off',
      grants: [],
      pastTools: true,
      project: null,
      chatInstructions: '',
      knowledge: [],
      skillIndex: [],
      selectedSkills: [],
      loadedSkills: [],
      history: [
        { role: 'user', content: 'what is in the news?', documents: [], images: [], hiddenImages: [] },
        {
          role: 'assistant',
          content: 'Ollmosts are back.',
          tools: [{ name: 'web_search', args: { query: 'news' }, record: '1. Ollmosts are back', note: 'Kept in brief.' }],
          documents: [],
          images: [],
          hiddenImages: []
        },
        { role: 'user', content: 'what is this?', documents: [], images: [{ data: 'iVBORw0KGgo=', mime: 'image/png' }], hiddenImages: [] }
      ]
    })
    expect(bytes(messages.slice(1).map(toOllamaMessage))).toBe(
      bytes([
        { role: 'user', content: 'what is in the news?' },
        { role: 'assistant', content: '', tool_calls: [{ function: { name: 'web_search', arguments: { query: 'news' } } }] },
        { role: 'tool', tool_name: 'web_search', content: '1. Ollmosts are back\n\nKept in brief.' },
        { role: 'assistant', content: 'Ollmosts are back.' },
        { role: 'user', content: 'what is this?', images: ['iVBORw0KGgo='] }
      ])
    )
  })
})
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run tests/assemble.test.ts tests/imageForModel.test.ts tests/ollamaAdapter.test.ts`
Expected: FAIL:
- in `assemble.test.ts`, `expected undefined to deeply equal [ { id: 'c00010000', … } ]` and the two id tests;
- in `imageForModel.test.ts`, `expected 'ZmlsZS1ieXRlcw==' to deeply equal { data: 'ZmlsZS1ieXRlcw==', mime: 'image/png' }`.

The new adapter test already passes, because `toOllamaMessage` passes Ollama-shaped keys through. It pins the result.

- [ ] **Step 3: Implement**

`src/main/chat/assemble.ts`, line 3:
```ts
import type { ChatImage, ChatMessage } from '../providers/types'
```
Lines 42–43 (in `HistoryTurn`):
```ts
  /** Images for a vision model, with their type; only filled when the model has vision. */
  images: ChatImage[]
```
Lines 94–99:
```ts
export interface Assembled {
  messages: ChatMessage[]
  /** Oldest turns dropped to fit the context window. */
  droppedTurns: number
  estimatedTokens: number
}
```
Lines 150–167:
```ts
function turnToMessages(turn: HistoryTurn, index: number): ChatMessage[] {
  if (turn.role === 'assistant') {
    // Replayed as the tool calls and results they were, so the model sees what it looked up without learning to write
    // tool summaries into its answers. A call's id comes from its turn and place: the same history always makes the
    // same request, which a server's prompt cache relies on. It's 'c' and both in base 36, 4 digits each: 9 letters and
    // digits, the only shape Mistral's chat templates on vLLM accept.
    const tools = turn.tools ?? []
    const ids = tools.map((_, n) => `c${index.toString(36).padStart(4, '0')}${n.toString(36).padStart(4, '0')}`)
    const calls: ChatMessage[] = tools.length
      ? [
          { role: 'assistant', content: '', toolCalls: tools.map((t, n) => ({ id: ids[n], function: { name: t.name, arguments: t.args } })) },
          ...tools.map(
            (t, n): ChatMessage => ({ role: 'tool', toolName: t.name, toolCallId: ids[n], content: t.note ? `${t.record}\n\n${t.note}` : t.record })
          )
        ]
      : []
    return [...calls, { role: 'assistant', content: turn.content }]
  }
  const docs = turn.documents.map((d) => documentBlock(d.name, d.text, 'attachment'))
  const hidden = turn.hiddenImages.map((n) => `[The user attached an image, “${n}”, but the current model can't see images.]`)
  const content = [...docs, ...hidden, turn.content].filter(Boolean).join('\n\n')
  return [turn.images.length ? { role: 'user', content, images: turn.images } : { role: 'user', content }]
}
```
Lines 238–242 (the end of `assemble()`):
```ts
  // A turn's index in the whole history, not among those kept, names its calls: dropping older turns renames nothing.
  const first = history.length - kept.length
  return {
    messages: [{ role: 'system', content: system }, ...kept.flatMap((t, i) => turnToMessages(t, first + i))],
    droppedTurns: history.length - kept.length,
    estimatedTokens: used + estimateTokens(system)
  }
```

`src/main/files/ingest.ts`: add `import type { ChatImage } from '../providers/types'` to the imports. Lines 65–75 become:
```ts
/** An image for a vision model (base64, and the type it's in), downscaled when larger than the model needs. */
export async function imageForModel(path: string, mime: string): Promise<ChatImage> {
  const img = nativeImage.createFromPath(path)
  if (img.isEmpty()) return { data: (await readFile(path)).toString('base64'), mime }
  const { width, height } = img.getSize()
  const longEdge = Math.max(width, height)
  if (longEdge <= MODEL_IMAGE_EDGE && (mime === 'image/png' || mime === 'image/jpeg'))
    return { data: (await readFile(path)).toString('base64'), mime }
  const resized = longEdge > MODEL_IMAGE_EDGE ? img.resize({ width: Math.round((width * MODEL_IMAGE_EDGE) / longEdge) }) : img
  // PNG keeps transparency (JPEG would turn it black); everything else becomes a compact JPEG.
  return mime === 'image/png'
    ? { data: resized.toPNG().toString('base64'), mime }
    : { data: resized.toJPEG(88).toString('base64'), mime: 'image/jpeg' }
}
```
`toTurn` in `service.ts` (line 258) doesn't change: `turn.images.push(await imageForModel(a.path, a.mime))` now pushes a
`ChatImage`.

The two `ChatBody` builders keep sending Ollama's shape until Task 1.6. Add
`import { toOllamaMessage } from '../providers/ollama/adapter'` to `service.ts` and to `delegate.ts`. Then set
`messages: assembled.messages.map(toOllamaMessage),` in `service.ts`'s `const body: ChatBody` (line 454) and in
`delegate.ts`'s `const body: ChatBody` (line 140 at the anchor). #175's `subAgentsAtOnce: atOnce` in `service.ts`'s
`assemble({ … })` call and `AssembleInput.subAgentsAtOnce` stay as they are.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/assemble.test.ts tests/imageForModel.test.ts tests/ollamaAdapter.test.ts tests/service.test.ts`, then
`npx prettier --write src/main tests/assemble.test.ts tests/imageForModel.test.ts tests/ollamaAdapter.test.ts`, then
`npm run typecheck && npm run lint && npm run format:check && npm test`.
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/main/chat/assemble.ts src/main/files/ingest.ts src/main/chat/service.ts src/main/chat/delegate.ts \
  tests/assemble.test.ts tests/imageForModel.test.ts tests/ollamaAdapter.test.ts
git commit -m "Assemble history as neutral messages, with stable ids for earlier tool calls and images that know their type

An earlier turn's calls are named by their place in the whole history ('c', the turn and the call in base 36: 9
letters and digits, as Mistral's templates on vLLM require), so the same chat always makes the same request; Ollama
still gets them without ids. imageForModel says which type it produced.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 1.6: `rounds.ts` on neutral events

`delegate.ts` and `Trace.finish` move here with the loop. `RoundsInput`'s new `body` and `provider` force `delegate.ts`
to change in the same task, and `runRounds` is `Trace.finish`'s main caller. The title and replay keep calling Ollama
directly until Task 1.7, so they read their trace timing through `resultFromOllama` for one task.

#175's parallel sub-agents stay exactly as `main` has them. `RoundsInput.parallel`, `runCall`, `batchesOf`,
`runTogether`, `ShownCall`, the `notRunEvent` card for a call the limit kept waiting, and the loop that pushes a batch's
results in call order all keep their code. This task changes only the request and its stream, the echo, the shape of
each result pushed, the types (`ChatRequest`; the neutral `ToolCall` in `ShownCall` and `batchesOf`), the trace timing
and `genMs`, and `debugLog`/`toolsTokens`/`estimatePrompt`. In `delegate.ts`, `subAgentsAtOnce`, `parallel: true` and
the child's `parallel: 1` stay; in `service.ts`, `atOnce`, `subAgentsAtOnce: atOnce` and `parallel: atOnce` stay.

**Files:**
- Modify: `src/main/chat/rounds.ts:1-10,49-52,85,90,99,115,122-126,164,168,188-265,383-392,423,483-498` (lines 277–382
  and 426–481, #175's `runCall`, batch loop head, `ShownCall`, `batchesOf` and `runTogether`, keep their code)
- Modify: `src/main/debug/traces.ts:1-7,86-104`
- Modify: `src/main/chat/service.ts` (imports 1–59; `generate()` 287–517; the title's `trace.finish`, line 839)
- Modify: `src/main/chat/delegate.ts` (imports 4–10; `runChild` 103–106, 138–144, 161–168)
- Modify: `src/main/debug/replay.ts:4,51`
- Test: `tests/service.test.ts` (imports; the `runRounds` block's `setup()`, 2046–2082; three new tests)

**Interfaces:**
- Consumes: `Provider`, `ChatRequest`, `ChatEvent`, `ChatTiming`, `IdentifiedToolCall`, `ToolCall` (Task 1.1); `resolve`, `modelInfo` (Task 1.4); `resultFromOllama` (Task 1.3); #175's `notRunEvent`, `runsInParallel` (`./tools`) and `subAgentsAtOnce` (`./delegate`), unchanged.
- Produces:
```ts
// rounds.ts
export interface RoundsInput { /* … */ model: ModelInfo; provider: Provider; body: ChatRequest; /* … */ parallel?: number /* #175's, unchanged */ }
export interface RoundsResult { /* … */ genMs: number /* replaces evalNs */ }
export const toolsTokens = (tools: ChatRequest['tools']) => number
// traces.ts
Trace.finish({ status, response, promptTokens?, completionTokens?, costUsd?, summary, timing?: ChatTiming })   // `ollama` is gone
```
  The loop's echo is `{ role: 'assistant', content, thinking, toolCalls }`, and each result is
  `{ role: 'tool', content, toolName, toolCallId }`, in that key order. That order gives today's Ollama bytes. A
  batch's results are still pushed in call order, whichever call finished first (#175).

- [ ] **Step 1: Write the failing tests**

In `tests/service.test.ts`:
- after line 7, add `import type { ChatEvent as ProviderEvent, ChatRequest, Provider } from '../src/main/providers/types'`;
- line 37 becomes `const { getTrace, listTraces } = await import('../src/main/debug/traces')`;
- after line 51, add `const { resolve } = await import('../src/main/providers/registry')`.

In `describe('runRounds')`, `setup()`'s `body` and `input` (lines 2050–2080) gain what a `ChatRequest` and the loop now need.
#175's test in this block ("runs calls that may go together at once…") builds on `setup()` and passes `parallel` itself
(`runRounds({ ...one.input, budget: 3000, parallel: 1 })`), so it needs nothing more:
```ts
    const body: RoundsInput['body'] = {
      model: 'llama3.2',
      messages: [
        { role: 'system', content: 'test' },
        { role: 'user', content: 'hi' }
      ],
      tools: echo.tools({ mode: 'chat', skills: false, web: false, sources: [], workspace: null }),
      think: null,
      profile: { kind: 'none' },
      contextWindow: null
    }
```
and, in `input`, after `model,`:
```ts
      provider: resolve('llama3.2').provider,
```

Add these two tests at the end of `describe('runRounds')`, after #175's "runs calls that may go together at once…":
```ts
  it('echoes a call exactly as Ollama sent it, and never sends an id Ollmost made up', async () => {
    const off = registerToolProvider(echo)
    try {
      const calls = [
        { function: { index: 0, name: 'echo', arguments: { text: 'a' } } },
        { id: 'call_ollama', function: { index: 1, name: 'echo', arguments: { text: 'b' } } }
      ]
      chat = (b, res, n) =>
        n === 1
          ? void res.writeHead(200).end(line({ message: { role: 'assistant', content: '', tool_calls: calls }, done: false }) + line({ done: true }))
          : reply('done')(b, res, n)
      const { input } = await setup()
      await runRounds(input)
      expect(JSON.stringify((chatCalls[1].messages as unknown[]).slice(2))).toBe(
        JSON.stringify([
          { role: 'assistant', content: '', tool_calls: calls },
          { role: 'tool', content: 'echo: a', tool_name: 'echo' },
          { role: 'tool', content: 'echo: b', tool_name: 'echo' }
        ])
      )
    } finally {
      off()
    }
  })

  it('runs on any provider’s neutral events: ids on the echo and the result, usage, timing and why it ended', async () => {
    const off = registerToolProvider(echo)
    try {
      const { conversation, stats, input } = await setup()
      const script: ProviderEvent[][] = [
        [
          { type: 'thinking', text: 'Echo it.' },
          { type: 'content', text: 'Let me echo.' },
          { type: 'toolCall', call: { id: 'call_x', function: { name: 'echo', arguments: '{"text":"hi"}' } } },
          { type: 'done', usage: { prompt: 20, completion: 6 }, finishReason: 'tool_calls', timing: { genMs: 1000 }, raw: { id: 'r1' } }
        ],
        [
          { type: 'content', text: 'done' },
          { type: 'done', usage: { prompt: 40, completion: 2 }, finishReason: 'stop', timing: { genMs: 500 }, raw: { id: 'r2' } }
        ]
      ]
      const requests: ChatRequest[] = []
      const provider: Provider = {
        id: 'fake',
        listModels: () => Promise.resolve([]),
        modelInfo: () => Promise.reject(new Error('not used')),
        async *chatStream(req) {
          requests.push(structuredClone(req))
          yield* script[requests.length - 1]
        },
        chatOnce: () => Promise.reject(new Error('not used')),
        wire: (req, stream) => ({ endpoint: 'fake://chat', body: { model: req.model, stream } }),
        wireEndpoint: () => 'fake://chat',
        sendWire: () => Promise.reject(new Error('not used'))
      }
      const out = await runRounds({ ...input, provider })
      expect(out).toMatchObject({ content: 'Let me echo.\n\ndone', thinking: 'Echo it.', rounds: 2, error: null, genMs: 1500 })
      expect(requests[1].messages.slice(-2)).toEqual([
        { role: 'assistant', content: 'Let me echo.', thinking: 'Echo it.', toolCalls: [{ id: 'call_x', function: { name: 'echo', arguments: '{"text":"hi"}' } }] },
        { role: 'tool', content: 'echo: hi', toolName: 'echo', toolCallId: 'call_x' }
      ])
      expect(stats).toMatchObject({ promptTokens: 60, completionTokens: 8, doneReason: 'stop' })
      expect(stats.estimated).toBeUndefined()
      const first = listTraces(conversation.id).find((t) => t.kind === 'delegate')!
      expect(getTrace(first.id)).toMatchObject({ endpoint: 'fake://chat', request: { model: 'llama3.2', stream: true }, response: { final: { id: 'r1' } } })
    } finally {
      off()
    }
  })
```

And add this test to `describe('reply loop')`:
```ts
  it('times a reply by the server’s own durations', async () => {
    chat = (_b, res) =>
      streamChunks(res, [
        line({ message: { role: 'assistant', content: 'Timed' }, done: false }),
        line({
          done: true,
          done_reason: 'stop',
          prompt_eval_count: 10,
          eval_count: 3,
          load_duration: 2_500_000,
          prompt_eval_duration: 1_000_000,
          eval_duration: 1_500_000_000
        })
      ]).then(() => res.end())
    const r = start()
    const done = await doneEvent(r.conversation.id)
    // Three tokens in Ollama's own 1.5 s of generation.
    expect(done.message.stats?.tokensPerSecond).toBe(2)
    const trace = listTraces(r.conversation.id).find((t) => t.kind === 'chat')!
    expect(getTrace(trace.id)?.timing).toMatchObject({ loadMs: 3, promptEvalMs: 1, evalMs: 1500 })
  })
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run tests/service.test.ts -t "runRounds|own durations"`
Expected: FAIL in `runs on any provider’s neutral events`. `runRounds` ignores `provider` and sends to the mock Ollama,
so `out` has no `genMs` and the content isn't the script's. The other two new tests PASS already: they pin today's echo
and timing.

- [ ] **Step 3: Implement**

`src/main/debug/traces.ts`: add `import type { ChatTiming } from '../providers/types'` to the imports. Lines 86–104 become:
```ts
  finish(result: {
    status: TraceStatus
    response: TraceDetail['response']
    promptTokens?: number | null
    completionTokens?: number | null
    costUsd?: number | null
    summary: string
    /** The server's own durations for the request, when it reports them. */
    timing?: ChatTiming
  }): TraceDetail {
    const now = Date.now()
    const ms = (v?: number) => (typeof v === 'number' ? Math.round(v) : null)
    const timing: TraceTiming = {
      ttfbMs: this.firstByteAt ? this.firstByteAt - this.startedAt : null,
      firstTokenMs: this.firstTokenAt ? this.firstTokenAt - this.startedAt : null,
      totalMs: now - this.startedAt,
      loadMs: ms(result.timing?.loadMs),
      promptEvalMs: ms(result.timing?.promptMs),
      evalMs: ms(result.timing?.genMs)
    }
```

`src/main/chat/rounds.ts`. The imports up to `util` (lines 1–10 at the anchor; Task 1.2's `../providers/types` import
made them lines 1–11) become:
```ts
import { appendFileSync } from 'node:fs'
import { join } from 'node:path'
import type { MessageStats, ModelInfo, ThinkingSegment, ToolDecision, ToolEvent } from '@shared/types'
import { getConversation, updateConversation } from '../db/conversations'
import { insertUsageEvent } from '../db/usage'
import { startTrace, type Trace } from '../debug/traces'
import { paths } from '../paths'
import type { ChatEvent, ChatRequest, IdentifiedToolCall, Provider, ToolCall } from '../providers/types'
import { requestCost } from '../usage/pricing'
import { errorMessage, estimateTokens } from '../util'
```
`ToolCall` stays for #175's `ShownCall` and `batchesOf`. The `./approvals`, `./results` and `./tools` imports after
these (the last with #175's `notRunEvent` and `runsInParallel`) stay as they are.

In `RoundsInput`, `model: ModelInfo` stays; `body: ChatBody` and its comment (lines 49–52, from `modelName: string`)
become:
```ts
  modelName: string
  model: ModelInfo
  /** The model's server: every round's request goes through it. */
  provider: Provider
  /** The request so far; rounds append to its messages and may withdraw its tools. */
  body: ChatRequest
```
`budget`, `maxRounds` and #175's `parallel?: number` (with its doc comment) follow as they are.

In `RoundsResult`, `evalNs: number` (line 85) becomes:
```ts
  /** The server's own generation time over the rounds that reported it; 0 when none did. */
  genMs: number
```
After `RoundsResult`'s closing brace (line 90), before `runRounds`'s doc comment, add:
```ts

/** The event that ends a finished round: its usage, timing and the reason it ended. */
type DoneEvent = Extract<ChatEvent, { type: 'done' }>

```
In `runRounds`:
- the destructuring (line 99) and #175's line after it become (`model` is no longer read here: the adapter picks the
  timeouts; `parallel` is unchanged):
```ts
  const { body, budget, maxRounds, toolContext, conversationId, modelName, provider } = input
  const parallel = input.parallel ?? 1
```
- `let evalNs = 0` (line 115) becomes `let genMs = 0`;
- `recordRound` (lines 122–126) begins:
```ts
  const recordRound = (done: DoneEvent | null) => {
    if (!openRound) return null
    const estimated = !done?.usage.completion
    const promptTokens = done?.usage.prompt ?? openRound.promptEstimate
    const completionTokens = done?.usage.completion ?? estimateTokens(openRound.content + openRound.thinking)
```
  The rest of `recordRound` is unchanged. The two comments at lines 164 and 168 say "The server's" where they say
  "Ollama's".

The round's request and stream (lines 188–263, from `debugLog(body)` through `if (!calls.length) break`) become:
```ts
      const wire = provider.wire(body, true)
      debugLog(wire.body)
      const calls: IdentifiedToolCall[] = []
      let roundContent = ''
      let roundThinking = ''
      let done: DoneEvent | null = null
      openRound = { content: '', thinking: '', promptEstimate: estimatePrompt(body) }
      roundAt = { at: nextRoundAt ?? content.length, index: toolEvents.length }
      nextRoundAt = null
      roundThinkStart = null
      roundThinkEnd = null
      roundTrace = startTrace({
        kind: input.traceKind,
        conversationId,
        messageId: input.loopId,
        model: modelName,
        round,
        endpoint: wire.endpoint,
        request: wire.body,
        summary: 'Streaming…'
      })
      // Events, not network chunks: an adapter sends an empty `content` for a chunk that carried nothing.
      let chunks = 0
      for await (const ev of provider.chatStream(body, input.signal)) {
        chunks++
        roundTrace.firstByte()
        if ((ev.type === 'thinking' || ev.type === 'content') && ev.text) {
          roundTrace.firstToken()
          roundTrace.progress(roundContent || 'Thinking…', estimateTokens(roundContent + roundThinking))
        }
        switch (ev.type) {
          case 'thinking':
            if (!ev.text) break
            thinkStart ??= Date.now()
            thinking += ev.text
            roundThinking += ev.text
            openRound.thinking += ev.text
            roundThinkStart ??= Date.now()
            input.onDelta({ thinking: ev.text, round: roundAt })
            break
          case 'content':
            if (!ev.text) break
            if (thinkStart && !thinkEnd) thinkEnd = Date.now()
            if (roundThinkStart && !roundThinkEnd) roundThinkEnd = Date.now()
            content += ev.text
            roundContent += ev.text
            openRound.content += ev.text
            input.onDelta({ content: ev.text })
            break
          // An adapter sends a call only once it's complete, so it can run as it is.
          case 'toolCall':
            calls.push(ev.call)
            break
          case 'done':
            done = ev
            break
        }
        checkpoint()
      }
      if (done?.usage.prompt) lastCount = { actual: done.usage.prompt, estimated: openRound.promptEstimate }
      const billed = recordRound(done)
      // After recordRound: it cleared openRound, so the catch below won't push this round's thinking a second time.
      if (roundThinking) thinkingSegments.push({ text: roundThinking, ...roundAt, ms: roundThinkMs() })
      // Another round follows a tool call: show the chat's totals now rather than when the reply ends (the done carries them).
      if (calls.length) input.onUsage()
      // The last round's reason is the reply's: "length" means the model was cut off mid-answer.
      if (done?.finishReason) stats.doneReason = done.finishReason
      roundTrace.finish({
        status: 'ok',
        response: {
          content: roundContent,
          thinking: roundThinking,
          toolCalls: calls.length ? calls : undefined,
          final: done?.raw ?? { done: true },
          chunks
        },
        promptTokens: billed?.promptTokens,
        completionTokens: billed?.completionTokens,
        costUsd: billed?.costUsd,
        summary: calls.length ? `→ ${calls.map((c) => c.function.name).join(', ')}` : roundContent.trim() || '(empty reply)',
        timing: done?.timing
      })
      roundTrace = null
      genMs += done?.timing?.genMs ?? 0
      if (!calls.length) break
```
The echo (line 265) becomes:
```ts
      body.messages.push({ role: 'assistant', content: roundContent, thinking: roundThinking || undefined, toolCalls: calls })
```
From there to the results, #175's code stays as it is: the room (`shortenable`, `roomChars`, `callsLeft`,
`onlyUnknown`, `onlyWithheld`), `runCall` (lines 277–352: the approval, the tool trace, `runTool` with its
`maxResultChars` and `callIndex`, the result's card), and the batch loop's head (lines 354–382:
`for (const batch of batchesOf(calls, parallel, toolContext))`, the cards shown before any call runs, the batch's
`maxResultChars`, and `runTogether(…)` with its `notRunEvent` callback). `calls` now holds `IdentifiedToolCall`s,
which `batchesOf`'s `ToolCall[]` takes, so each shown call keeps its id. In the loop that hands a batch's results to the
model in call order (lines 383–392), only the push changes; the loop becomes:
```ts
        // The results go to the model in call order, whichever finished first.
        for (const [i, { call }] of shown.entries()) {
          const result = results[i]
          if (result.unknown) triedUnknown.push(call.function.name)
          else onlyUnknown = false
          if (!result.withheld) onlyWithheld = false
          body.messages.push({ role: 'tool', content: result.content, toolName: call.function.name, toolCallId: call.id })
          const note = `[Ollmost shortened this earlier ${call.function.name} result to make room in the context window. It was: ${result.event.summary}. Call the tool again if you need it in full.]`
          if (result.content.length > note.length) turnResults.push({ index: body.messages.length - 1, round, note })
        }
```
The `input.signal.throwIfAborted()` after it, the tool withdrawals and the separator stay. A shortened result keeps its
`toolName` and `toolCallId`: the shortening spreads the message and replaces only `content`.

In the `return` (line 423), `evalNs` becomes `genMs`. `ShownCall`, `batchesOf` and `runTogether` (lines 426–481) keep
their code; their `ToolCall` is now the neutral one, from the import above. Lines 483–498 (`debugLog`, `toolsTokens`,
`estimatePrompt`) become:
```ts
/** With OLLMOST_DEBUG=1, append each request as it's sent (images elided) to <userData>/debug.log. */
function debugLog(body: unknown): void {
  if (!process.env.OLLMOST_DEBUG) return
  const redacted = JSON.stringify(body, (key, value: unknown) =>
    key === 'images' && Array.isArray(value) ? value.map(() => '<image>') : value
  )
  appendFileSync(join(paths.data, 'debug.log'), `${new Date().toISOString()} ${redacted}\n`)
}

/** Roughly what the tool definitions add to a request: every round sends them all. */
export const toolsTokens = (tools: ChatRequest['tools']) => (tools?.length ? estimateTokens(JSON.stringify(tools)) : 0)

function estimatePrompt(body: ChatRequest): number {
  return body.messages.reduce((n, m) => n + estimateTokens(m.content) + (m.images?.length ?? 0) * 1600, toolsTokens(body.tools))
}
```

`src/main/chat/service.ts`:
- line 6 becomes `import { resolveThinkProfile } from '@shared/thinking'`;
- remove Task 1.5's `import { toOllamaMessage } from '../providers/ollama/adapter'` and add
  `import { resultFromOllama } from '../providers/ollama/adapter'` in its place;
- the registry import becomes `import { modelInfo, resolve } from '../providers/registry'`, and
  `import type { ChatRequest } from '../providers/types'` goes after it.

In `generate()`:
- `let evalNs = 0` (line 287) becomes `let genMs = 0`;
- `const model = await modelInfo(modelName)` (line 294) becomes these two lines:
```ts
    const { provider, model: serverName } = resolve(modelName)
    const model = await modelInfo(modelName)
```
- #175's `const atOnce = subAgentsAtOnce(settings.delegate)` (line 415) and `subAgentsAtOnce: atOnce` in the
  `assemble({ … })` call (line 440) stay;
- lines 452–468 (the `ChatBody` and the start of the `runRounds` call, through `budget,`) become:
```ts
    const request: ChatRequest = {
      model: serverName,
      messages: assembled.messages,
      think,
      profile,
      tools,
      // The window the history was fitted to. The adapter decides whether its server takes one (Ollama's num_ctx).
      contextWindow: numCtx
    }

    const result = await runRounds({
      conversationId,
      messageId,
      loopId: messageId,
      modelName,
      model,
      provider,
      body: request,
      budget,
```
  and the call goes on as it is: `maxRounds,`, #175's `parallel: atOnce,`, `toolContext,` and the rest;
- `evalNs = result.evalNs` (line 497) becomes `genMs = result.genMs`;
- line 517 becomes:
```ts
  // The server's own generation time, where it reports one (local Ollama models do; cloud ones don't).
  if (genMs && stats.completionTokens) stats.tokensPerSecond = stats.completionTokens / (genMs / 1000)
```
In `generateTitle`, `ollama: res` (line 839) becomes `timing: resultFromOllama(res).timing`.

`src/main/debug/replay.ts`: add `import { resultFromOllama } from '../providers/ollama/adapter'`. Line 51, `ollama: res`,
becomes `timing: resultFromOllama(res).timing`.

`src/main/chat/delegate.ts`. Every import from `@shared/context` through `../settings` (lines 4–10 at the anchor;
Tasks 1.2, 1.4 and 1.5 have edited them since) becomes the following. `Settings` and `DEFAULT_SUB_AGENTS_AT_ONCE` are
#175's, for `subAgentsAtOnce()`:
```ts
import { effectiveContext } from '@shared/context'
import { resolveThinkProfile } from '@shared/thinking'
import { childId } from '@shared/toolEvents'
import type { MessageStats, Settings, ToolEvent } from '@shared/types'
import { modelInfo, resolve } from '../providers/registry'
import type { ChatRequest, ToolDef } from '../providers/types'
import { DEFAULT_SUB_AGENTS_AT_ONCE, getSettings } from '../settings'
```
`MAX_AT_ONCE`, `subAgentsAtOnce()` and the provider's `parallel: true` stay as they are. In `runChild`, the model
lookup (lines 103–106) becomes:
```ts
  const settings = getSettings()
  const { provider, model: serverName } = resolve(reply.model)
  const model = await modelInfo(reply.model)
  const profile = resolveThinkProfile(reply.model, model.capabilities, model.overrides.think)
  const numCtx = effectiveContext(model, settings.localNumCtx)
```
The body (lines 138–144) becomes:
```ts
  const body: ChatRequest = {
    model: serverName,
    messages: assembled.messages,
    think: reply.think,
    profile,
    tools,
    contextWindow: numCtx
  }
```
and the `runRounds` call (lines 161–188) gains `provider,` after `model,` (line 166). Its head becomes the following;
everything from `signal,` on stays, and so does #175's `parallel: 1` (a child has no delegate of its own):
```ts
  const out = await runRounds({
    conversationId: reply.conversationId,
    messageId: reply.messageId,
    loopId: childId(reply.messageId, ctx.callIndex),
    modelName: reply.model,
    model,
    provider,
    body,
    budget: promptBudget(numCtx),
    maxRounds: Math.max(1, Math.min(settings.delegate.maxRounds, reply.maxRounds)),
    // A child has no delegate of its own, so nothing of its runs beside anything else.
    parallel: 1,
    toolContext: childCtx,
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/service.test.ts`, then
`npx prettier --write src/main tests/service.test.ts`, then
`npm run typecheck && npm run lint && npm run format:check && npm test`.
Expected: PASS, the three new tests included, and #175's tests unchanged:
- `describe('runRounds')`: "runs calls that may go together at once, each with an even share of the room, their
  results in call order";
- `describe('sub-agent settings and usage')`: "defaults sub-agents to on, capped at 20 rounds, 3 at once" and "runs 1
  to 5 sub-agents at once…";
- `describe('sub-agents')`: "two delegations in one round run in order" (Settings at 1), "two delegations in one round
  run at the same time", "runs no more sub-agents at once than Settings allows…", "reads the setting where it is
  used…", "Stop while two sub-agents run together…", "Stop leaves a sub-agent the limit kept waiting unstarted…", "a
  sub-agent that fails beside one that answers…", "asks on one sub-agent’s card while another beside it finishes",
  "two sub-agents asking at once…" and "a call between two delegations runs between them…";
- `tests/tools.test.ts`: "lets a call run beside others only when its provider allows it and it never asks".

If one of them fails, the batch code was changed: put it back as `main` has it.

- [ ] **Step 5: Commit**

```bash
git add src/main/chat/rounds.ts src/main/chat/service.ts src/main/chat/delegate.ts src/main/debug/traces.ts src/main/debug/replay.ts tests/service.test.ts
git commit -m "Run the reply loop on neutral events from the model's provider

runRounds streams through the provider it's given and switches on content, thinking, tool calls and done. Usage,
tok/s and the reason a reply ended come from the done event; the echo carries each call's id and each result names
the call it answers. Sub-agents still run in batches, their results in call order. Traces take the server's timing
in ms. Ollama gets the same bytes as before.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 1.7: Title, `/compact` and replay through the provider

This task finishes what the index calls "`delegate.ts`, title, `/compact`, replay and traces through the provider".
`delegate.ts` and traces moved with the loop in Task 1.6.

**Files:**
- Modify: `src/main/chat/service.ts` (imports 1–59; `compact()` 660–723; `summarizeOnce()` 725–778; `generateTitle()` 780–849)
- Modify: `src/main/debug/replay.ts` (the whole file)
- Test: `tests/service.test.ts` (three new tests and one import)

**Interfaces:**
- Consumes: `resolve`, `modelInfo` (Task 1.4); `Provider.wire`, `chatOnce`, `wireEndpoint`, `sendWire`; `ChatRequest`, `ChatResult` (Task 1.1).
- Produces: `summarizeOnce(conversationId, modelName, provider: Provider, request: ChatRequest, transcript, count)` (private). `replayRequest(conversationId, raw)` keeps its signature and sends through `resolve(raw.model).provider.sendWire`. After this task nothing under `src/main/chat/` or `src/main/debug/` imports `providers/ollama/`.

- [ ] **Step 1: Write the failing tests**

In `tests/service.test.ts`, after the registry import add
`const { replayRequest } = await import('../src/main/debug/replay')`.

Add to `describe('reply loop')`:
```ts
  it('titles through the chat model’s provider, sending the body it always sent', async () => {
    const once = vi.spyOn(resolve('llama3.2').provider, 'chatOnce')
    try {
      chat = reply('Hi there')
      const r = start()
      await doneEvent(r.conversation.id)
      await waitFor(() => once.mock.calls.length > 0)
      expect(once).toHaveBeenCalledWith(expect.objectContaining({ model: 'llama3.2', think: null, contextWindow: 8192, temperature: 0.3 }), {
        timeoutMs: 300_000
      })
      await waitFor(() => titleCalls.length > 0)
      // No think for a model that can't think, the temperature before the chat's num_ctx, and not streamed.
      expect(Object.keys(titleCalls[0])).toEqual(['model', 'messages', 'options', 'stream'])
      expect(JSON.stringify(titleCalls[0].options)).toBe('{"temperature":0.3,"num_ctx":8192}')
    } finally {
      once.mockRestore()
    }
  })
```

Add to `describe('/compact')`, after the `exchanges` helper:
```ts
  it('summarizes through the chat model’s provider, sending the body it always sent', async () => {
    chat = reply('an answer')
    const r = start('a question')
    await doneEvent(r.conversation.id)
    await waitFor(() => !service.isReplying())
    const calls: Array<Record<string, unknown>> = []
    const restore = summarizer(['Short.'], calls)
    const once = vi.spyOn(resolve('llama3.2').provider, 'chatOnce')
    try {
      await service.compact(r.conversation.id, { focus: '', model: 'llama3.2' })
      expect(once).toHaveBeenCalledWith(
        expect.objectContaining({
          messages: [expect.objectContaining({ role: 'system' }), expect.objectContaining({ role: 'user' })],
          think: null,
          contextWindow: 8192,
          temperature: 0.3
        }),
        { timeoutMs: 300_000 }
      )
      expect(Object.keys(calls[0])).toEqual(['model', 'messages', 'options', 'stream'])
      expect(JSON.stringify(calls[0].options)).toBe('{"temperature":0.3,"num_ctx":8192}')
    } finally {
      once.mockRestore()
      restore()
    }
  })
```

Append at the end of the file:
```ts
describe('replay', () => {
  it('re-sends a recorded body through its model’s provider, as recorded, and counts it', async () => {
    const sendWire = vi.spyOn(resolve('llama3.2').provider, 'sendWire')
    const base = ollama.handler
    const replays: Array<Record<string, unknown>> = []
    ollama.handler = (req, res) => {
      const first = (req.json.messages as Array<{ content: string }> | undefined)?.[0]
      if (req.url === '/api/chat' && first?.content === 'replay me') {
        replays.push(req.json)
        return void res
          .writeHead(200)
          .end(JSON.stringify({ message: { role: 'assistant', content: 'Replayed.' }, done: true, prompt_eval_count: 4, eval_count: 2, eval_duration: 2_000_000 }))
      }
      return base(req, res)
    }
    try {
      const c = createConversation({ projectId: null, model: 'llama3.2', think: null, skills: [], toolSources: [] })
      const detail = await replayRequest(c.id, {
        model: 'llama3.2',
        messages: [{ role: 'user', content: 'replay me', images: ['<image 3 KB>'] }],
        stream: true
      })
      expect(sendWire).toHaveBeenCalledOnce()
      // As recorded, less the image placeholder, and not streamed.
      expect(JSON.stringify(replays[0])).toBe('{"model":"llama3.2","messages":[{"role":"user","content":"replay me"}],"stream":false}')
      expect(detail).toMatchObject({
        kind: 'replay',
        endpoint: `${ollama.url}/api/chat`,
        status: 'ok',
        promptTokens: 4,
        completionTokens: 2,
        response: { content: 'Replayed.' },
        timing: { evalMs: 2 }
      })
      expect(all<{ kind: string }>('SELECT kind FROM usage_events WHERE conversation_id = ?', c.id)).toEqual([{ kind: 'replay' }])
    } finally {
      ollama.handler = base
      sendWire.mockRestore()
    }
  })
})
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run tests/service.test.ts -t "provider, sending the body|replay"`
Expected: FAIL. The title test fails with "timed out waiting" because its spy is never called, the compact test with
"expected "spy" to be called with arguments", and the replay test with "expected "spy" to be called once, but got 0
times".

- [ ] **Step 3: Implement**

`src/main/chat/service.ts` imports:
- line 4 becomes `import { effectiveContext } from '@shared/context'`;
- the `@shared/types` import gains `ThinkProfile`;
- remove `import { type ChatBody, chatOnce, endpointFor } from '../providers/ollama/wire'` and Task 1.6's
  `import { resultFromOllama } from '../providers/ollama/adapter'`;
- the types import becomes `import type { ChatRequest, Provider } from '../providers/types'`.

Above `compact()`'s doc comment (the `/**` at line 654, over `export async function compact(` at line 660), add:
```ts
/** A title or a summary isn't worth reasoning over: the least thinking the model allows. */
const leastThinking = (profile: ThinkProfile): ThinkSetting | null =>
  profile.kind === 'levels' ? 'low' : profile.kind === 'toggle' ? 'off' : null

```
In `compact()`, lines 671–689 (from the `modelInfo` call through `const budget = …`) become:
```ts
    const { provider, model: serverName } = resolve(opts.model)
    const info = await modelInfo(opts.model)
    const profile = resolveThinkProfile(opts.model, info.capabilities, info.overrides.think)
    const settings = getSettings()
    const contextWindow = effectiveContext(info, settings.localNumCtx)
    const focus = opts.focus.trim()
    const system = focus ? `${COMPACT_PROMPT}\n\nAbove all, keep what the user asked for: ${focus}` : COMPACT_PROMPT
    const request = (transcript: string): ChatRequest => ({
      model: serverName,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: transcript }
      ],
      think: leastThinking(profile),
      profile,
      // The chat's own window: a different num_ctx would make Ollama reload a local model for the summary.
      contextWindow,
      temperature: 0.3
    })
    // A model with a tiny window still gets a piece worth summarizing rather than one message cut to nothing.
    const budget = Math.max(2000, promptBudget(contextWindow) - estimateTokens(system) - COMPACT_REPLY_TOKENS)
```
and line 708 becomes:
```ts
      summary = await summarizeOnce(conversationId, opts.model, provider, request(transcript), transcript, piece.length)
```

`summarizeOnce` (lines 725–778, with its doc comment) becomes:
```ts
/** One summary request: traced, billed, its answer cleaned of thinking; an empty answer is an error. */
async function summarizeOnce(
  conversationId: string,
  modelName: string,
  provider: Provider,
  request: ChatRequest,
  transcript: string,
  count: number
): Promise<string> {
  const wire = provider.wire(request, false)
  const trace = startTrace({
    kind: 'compact',
    conversationId,
    messageId: null,
    model: modelName,
    endpoint: wire.endpoint,
    request: wire.body,
    summary: 'Compacting…'
  })
  try {
    const res = await provider.chatOnce(request, { timeoutMs: 5 * 60_000 })
    trace.firstByte()
    const summary = res.content.replace(/<think>[\s\S]*?<\/think>/g, '').trim()
    const promptTokens = res.usage.prompt ?? estimateTokens(transcript)
    const completionTokens = res.usage.completion ?? estimateTokens(summary)
    const costUsd = requestCost(modelName, promptTokens, completionTokens)
    // Spent tokens are kept even for a chat deleted meanwhile (with no chat to bill them to), and the chat's usage
    // chip moves after each piece, so a later failure leaves it right.
    const chat = getConversation(conversationId)
    insertUsageEvent({
      conversationId: chat ? conversationId : null,
      messageId: null,
      model: modelName,
      kind: 'compact',
      promptTokens,
      completionTokens,
      costUsd,
      estimated: res.usage.completion === undefined
    })
    if (chat) emit({ type: 'usage', conversationId, usage: conversationUsage(conversationId) })
    if (!summary) throw new Error('The model gave no summary; nothing was compacted.')
    trace.finish({
      status: 'ok',
      response: { content: summary, final: res.raw },
      promptTokens,
      completionTokens,
      costUsd,
      summary: `Compacted ${count} messages`
    })
    return summary
  } catch (err) {
    trace.finish({ status: 'error', response: { error: errorMessage(err) }, summary: `Error: ${errorMessage(err)}` })
    throw err
  }
}
```

In `generateTitle`, lines 791–840 (from `const modelName = …` through the `titleTrace.finish({ … })` call) become:
```ts
    const modelName = getSettings().titleModel || chatModel
    const { provider, model: serverName } = resolve(modelName)
    const info = await modelInfo(modelName)
    const profile = resolveThinkProfile(modelName, info.capabilities, info.overrides.think)
    const request: ChatRequest = {
      model: serverName,
      messages: [
        { role: 'system', content: TITLE_PROMPT },
        { role: 'user', content: transcript }
      ],
      think: leastThinking(profile),
      profile,
      // Same window as the chat: a different num_ctx makes Ollama reload a local model just for the title.
      contextWindow: effectiveContext(info, getSettings().localNumCtx),
      temperature: 0.3
    }
    const wire = provider.wire(request, false)
    titleTrace = startTrace({
      kind: 'title',
      conversationId,
      messageId: null,
      model: modelName,
      endpoint: wire.endpoint,
      request: wire.body,
      summary: 'Generating title…'
    })
    // Bounded: a title is never worth a request that hangs forever (it may still need a cold model load).
    const res = await provider.chatOnce(request, { timeoutMs: 5 * 60_000 })
    titleTrace.firstByte()
    title = cleanTitle(res.content)
    const promptTokens = res.usage.prompt ?? estimateTokens(transcript)
    const completionTokens = res.usage.completion ?? estimateTokens(res.content)
    const costUsd = requestCost(modelName, promptTokens, completionTokens)
    insertUsageEvent({
      conversationId,
      messageId: null,
      model: modelName,
      kind: 'title',
      promptTokens,
      completionTokens,
      costUsd,
      estimated: res.usage.completion === undefined
    })
    emit({ type: 'usage', conversationId, usage: conversationUsage(conversationId) })
    titleTrace.finish({
      status: 'ok',
      response: { content: res.content, thinking: res.thinking || undefined, final: res.raw },
      promptTokens,
      completionTokens,
      costUsd,
      summary: `Title: ${title || '(empty)'}`,
      timing: res.timing
    })
```

`src/main/debug/replay.ts` becomes:
```ts
import { stripImagePlaceholders } from '@shared/debug'
import type { TraceDetail } from '@shared/types'
import { insertUsageEvent } from '../db/usage'
import { resolve } from '../providers/registry'
import { requestCost } from '../usage/pricing'
import { errorMessage } from '../util'
import { startTrace } from './traces'

type Recorded = { model: string; messages: unknown[] }

/**
 * Re-send a (possibly edited) recorded request, non-streaming, to its model's server, in that server's own shape.
 * Nothing is added to the chat; the call is recorded as a 'replay' trace and counted as usage.
 */
export async function replayRequest(conversationId: string | null, raw: unknown): Promise<TraceDetail> {
  const recorded = raw as Partial<Recorded> | null
  if (!recorded || typeof recorded !== 'object' || typeof recorded.model !== 'string' || !Array.isArray(recorded.messages))
    throw new Error('A replay needs a JSON object with a "model" string and a "messages" array.')
  const { body } = stripImagePlaceholders(recorded as Recorded)
  const request = { ...body, stream: false }
  const { provider } = resolve(request.model)
  const trace = startTrace({
    kind: 'replay',
    conversationId,
    messageId: null,
    model: request.model,
    endpoint: provider.wireEndpoint(),
    request,
    summary: 'Replay…'
  })
  try {
    const res = await provider.sendWire(request, { timeoutMs: 10 * 60_000 })
    trace.firstByte()
    const promptTokens = res.usage.prompt ?? 0
    const completionTokens = res.usage.completion ?? 0
    const costUsd = requestCost(request.model, promptTokens, completionTokens)
    insertUsageEvent({
      conversationId,
      messageId: null,
      model: request.model,
      kind: 'replay',
      promptTokens,
      completionTokens,
      costUsd,
      estimated: false
    })
    return trace.finish({
      status: 'ok',
      response: {
        content: res.content,
        thinking: res.thinking || undefined,
        toolCalls: res.toolCalls.length ? res.toolCalls : undefined,
        final: res.raw
      },
      promptTokens,
      completionTokens,
      costUsd,
      summary: `Replay: ${res.content.trim() || (res.toolCalls.length ? 'tool call' : '(empty)')}`,
      timing: res.timing
    })
  } catch (err) {
    const error = errorMessage(err)
    trace.finish({ status: 'error', response: { error }, summary: `Replay failed: ${error}` })
    throw err
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/service.test.ts`, then
`npx prettier --write src/main tests/service.test.ts`, then
`npm run typecheck && npm run lint && npm run format:check && npm test`, then
`git grep -n "providers/ollama/" -- src/main/chat src/main/debug`.
Expected: PASS. The `git grep` prints nothing and exits 1.

- [ ] **Step 5: Commit**

```bash
git add src/main/chat/service.ts src/main/debug/replay.ts tests/service.test.ts
git commit -m "Titles, /compact and replay go through the model's provider

Each builds a neutral request (the least thinking the model allows, temperature 0.3, the chat's window) and reads a
neutral result; replay sends the recorded body to its model's server as it is. Nothing in chat/ or debug/ reaches
the Ollama adapter any more.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 1.8: Clean-up, spec notes, PR

**Files:**
- Create: `tests/seam.test.ts`
- Modify: `src/shared/context.ts:14-20` (`contextOptions` goes: nothing calls it since Task 1.7)
- Modify: `docs/superpowers/specs/2026-09-27-model-endpoints-design.md:3-8,118-119,503-505` (already on the branch from
  `claude/model-endpoints-plan`; three edits in place say what was approved and what PR 1 built)
- Test: `tests/seam.test.ts`

**Interfaces:**
- Consumes: everything above.
- Produces: the guard every later PR keeps green. Nothing under `src/main/{chat,debug,code,runner,mcp,skills}` imports `providers/ollama/`, and the loop's files hold no Ollama wire name.

- [ ] **Step 1: Write the guard test**

`tests/seam.test.ts`:
```ts
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

// Every model call goes through providers/registry.ts. The reply loop, sub-agents, titles, /compact and replay never
// reach an adapter themselves, so a second kind of server needs no change to them.
const CALLERS = ['src/main/chat', 'src/main/debug', 'src/main/code', 'src/main/runner', 'src/main/mcp', 'src/main/skills']
const LOOP = ['chat/rounds.ts', 'chat/delegate.ts', 'chat/assemble.ts', 'chat/service.ts', 'debug/replay.ts', 'debug/traces.ts'].map(
  (f) => `src/main/${f}`
)

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? sources(join(dir, e.name)) : e.name.endsWith('.ts') ? [join(dir, e.name)] : []
  )
}

describe('the provider seam', () => {
  it('keeps the reply loop and its callers off the Ollama adapter', () => {
    // Any import of an adapter file: `from '…'`, a bare `import '…'` or a dynamic import().
    const reaching = CALLERS.flatMap(sources).filter((file) => /'(\.\.\/)+providers\/ollama\//.test(readFileSync(file, 'utf8')))
    expect(reaching).toEqual([])
  })

  it('leaves no Ollama wire name in the loop', () => {
    const wire = /\b(ChatBody|ChatChunk|OllamaMessage|OllamaToolCall|tool_calls|tool_name|eval_count|prompt_eval_count|eval_duration)\b/
    expect(LOOP.filter((file) => wire.test(readFileSync(file, 'utf8')))).toEqual([])
  })
})
```

- [ ] **Step 2: Run it, and see it bite**

Run: `npx vitest run tests/seam.test.ts`
Expected: PASS. It guards what Tasks 1.2–1.7 did. To see it catch a leak, add
`import '../providers/ollama/wire'` to the top of `src/main/chat/rounds.ts` and run it again. Expected: FAIL, listing
`src/main/chat/rounds.ts`. Then remove the line.

- [ ] **Step 3: Remove `contextOptions`**

Delete lines 14–20 of `src/shared/context.ts` (the `contextOptions` doc comment and function). Its rule, that every
request to a local model carries the same `num_ctx`, titles included, now lives in `toOllamaBody` and its comment.
`effectiveContext` stays: `service.ts`, `delegate.ts` and the renderer's meter use it until PR 2 replaces it with
`ModelInfo.contextWindow`.

- [ ] **Step 4: Check nothing is left behind**

Run:
```bash
git ls-files src/main/ollama
git grep -nE "(\.|main)/ollama/(client|models)'|OllamaTool([^C]|$)|evalNs|contextOptions|getModelInfo" -- src tests
```
Expected:
- the first prints only `src/main/ollama/web.ts`;
- the second prints only lines that define or use `getModelInfo`: in `src/main/providers/ollama/models.ts`, in
  `src/main/providers/ollama/adapter.ts`, and in `tests/service.test.ts` (the `runRounds` setup). Anything else is a
  leftover: fix it.

- [ ] **Step 5: Show Ollama gets the same bytes as before the seam**

Run:
```bash
rm -f /tmp/ollmost-seam-after.txt
OLLMOST_MOCK_DUMP=/tmp/ollmost-seam-after.txt npx vitest run tests/service.test.ts
norm() {
  sed -E -e 's/The current date is [A-Z][a-z]{2} [A-Z][a-z]{2} [0-9]{2} [0-9]{4}/The current date is DATE/g' \
    -e 's/(ollmost-[a-z-]+-)[A-Za-z0-9]{6}/\1XXXXXX/g' \
    -e 's/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/UUID/g' "$1" | LC_ALL=C sort
}
comm -23 <(norm /tmp/ollmost-seam-before.txt) <(norm /tmp/ollmost-seam-after.txt)
comm -13 <(norm /tmp/ollmost-seam-before.txt) <(norm /tmp/ollmost-seam-after.txt) | cut -c1-160
```
Expected:
- The first `comm` prints nothing: every request the old tests made is still made, byte for byte. That includes #175's
  tests of sub-agents running at the same time: their children and the parent's follow-up (its results in call order)
  must match too. The sort makes the order children reach the mock in, which varies from run to run, irrelevant. The
  normalising only hides the date, temp-folder names and ids, which change from run to run. If a line does print, find
  its partner in the second listing and compare the two by eye. Run-to-run text inside a tool result (a duration, say)
  is fine. Any other difference (a key, key order, an id, `think`, `options`, results out of call order) is a
  regression: fix it before going on.
- The second `comm` lists only requests from the tests Tasks 1.6 and 1.7 added: the timing reply and its title, the
  title and compact tests, and the replay.

- [ ] **Step 6: Note in the spec what was approved and what PR 1 built**

The spec is already on this branch: `claude/model-endpoints-plan` committed it (with its review, the mockups and this
plan), and Task 1.1 branched from there. Nothing is copied or moved. In
`docs/superpowers/specs/2026-09-27-model-endpoints-design.md`, make three edits in place. The line numbers are the
committed spec's; make the edits from the bottom up (Edit 3, then 2, then 1) so they hold.

**Edit 1.** Replace the opening paragraph (lines 3–8, "Design written 2026-09-27 … nothing in the repo changes.") with:
```markdown
Design written 2026-09-27 with the user, section by section, on the state of `main` at d0fb62b (after #122 and
#123), and approved the same day. The round loop is described as it is since #125 and #131 (`claude/sub-agents-2`):
`src/main/chat/rounds.ts` (`runRounds`) and `src/main/chat/delegate.ts`. #175 has since run a round's sub-agents at
the same time, up to a limit set in Settings; the seam keeps that. The codebase review behind it is
`docs/superpowers/specs/2026-09-27-model-endpoints-review.md`, the mockups are in
`docs/superpowers/specs/2026-09-27-model-endpoints-mockups/`, and the plan is
`docs/superpowers/plans/2026-09-27-model-endpoints.md`. All of them came into the repo with the first PR (the
provider seam).
```

**Edit 2.** In the `Provider` block, replace the `wire` and `sendWire` lines (118–119) with:
```ts
  wire(req: ChatRequest, stream: boolean): { endpoint: string; body: unknown }   // exactly what is sent (traces, curl)
  wireEndpoint(): string                                                         // where wire bodies go (replay)
  sendWire(body: unknown, opts: { signal?: AbortSignal; timeoutMs: number }): Promise<ChatResult> // replay of an edited body
```

**Edit 3.** In "PRs", replace PR 1's description (lines 503–505) with:
```markdown
1. **The seam.** `providers/types.ts`, `registry.ts` and `secrets.ts`. Ollama moves under `providers/ollama/`. Every
   caller switches to neutral types. **No behaviour change**: every body Ollama receives is byte-identical. Existing
   tests change only their imports, or where they build or read a type that changed (assembled messages, the round
   loop's input). This spec, its review, the mockups and the plan come into the repo with it.
```
Markdown isn't formatted by prettier here (`.prettierignore` has `*.md`). Check the three edits landed where they
should: `git diff -- docs/superpowers/specs/2026-09-27-model-endpoints-design.md` shows exactly three hunks.

- [ ] **Step 7: Run everything**

Run: `npx prettier --write src tests`, then `npm run typecheck && npm run lint && npm run format:check && npm test`.
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add tests/seam.test.ts src/shared/context.ts docs/superpowers/specs/2026-09-27-model-endpoints-design.md
git commit -m "Guard the provider seam, drop contextOptions, and note in the spec what PR 1 built

A test keeps the reply loop and its callers off the Ollama adapter. contextOptions had no caller left: toOllamaBody
decides num_ctx now. The spec notes what PR 1 built: wire() takes stream, and wireEndpoint() names replay's target.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 9: Push and open the PR**

```bash
git push -u origin claude/model-endpoints-seam
gh pr create --base main --head claude/model-endpoints-seam \
  --title "Model endpoints 1/5: the provider seam (no behaviour change)" \
  --body "$(cat <<'EOF'
First of five PRs that let Ollmost talk to OpenAI-compatible servers (LM Studio, llama.cpp, vLLM) as well as Ollama. Spec: `docs/superpowers/specs/2026-09-27-model-endpoints-design.md`.

This one changes no behaviour. Ollama moves behind a `Provider` interface, and every caller speaks neutral types.

It also brings in the design docs: the spec, its codebase review (`docs/superpowers/specs/2026-09-27-model-endpoints-review.md`), the UI mockups (`docs/superpowers/specs/2026-09-27-model-endpoints-mockups/`) and the plan for all five PRs (`docs/superpowers/plans/2026-09-27-model-endpoints.md`).

- `src/main/providers/types.ts`: `ChatRequest`, `ChatMessage`, `ChatEvent`, `ChatResult`, `ToolCall` (today's shape plus an id), `ToolDef` (was `OllamaTool`), and `Provider`.
- `src/main/providers/secrets.ts`: `setSecret`/`getSecret` with safeStorage. The ollama.com key keeps its `apiKey` row. Endpoint keys, and #101's credentials, will use the same helper.
- `src/main/providers/ollama/`:
  - `wire.ts` (was `src/main/ollama/client.ts`);
  - `models.ts` (moved);
  - `adapter.ts`: `toOllamaBody`, `ollamaEvents`, `resultFromOllama` and `OllamaProvider`.
- `src/main/providers/registry.ts`: `resolve()`, `modelInfo()` and `listAllModels()`, with Ollama as the only provider.
- `assemble.ts` emits neutral messages. Earlier turns' tool calls get stable 9-character ids (`c` + the turn and the call's place in base 36, e.g. `c00010000`; Mistral's chat templates on vLLM accept no other shape), and `imageForModel` returns the image's type.
- `runRounds` streams neutral events from its provider. `delegate.ts`, titles, `/compact` and replay go through the registry. Traces take the server's timing in ms.

## Why it's safe
- Every request body the mock Ollama receives in `tests/service.test.ts` was dumped before the first change and compared after the last: they're byte-identical, #175's tests of sub-agents running at the same time included. `tests/ollamaAdapter.test.ts` pins the same thing case by case: a tool round, an image turn, history with past calls, titles and cloud models.
- A call Ollama sent goes back exactly as Ollama sent it. An id Ollmost makes up never reaches Ollama.
- #175's parallel sub-agents run as before: the loop keeps its batches (`batchesOf`, `runTogether`, Settings' limit, "not run" for a call still waiting at Stop), and a batch's results go back in call order, each now naming its call; #175's tests pass unchanged.
- `wire.ts` is `client.ts` moved as `main` had it, the plain-English out-of-memory error (4b69183) included: `tests/client.test.ts` passes with only its import changed.
- The only differences are in the debugger:
  - a trace's `chunks` counts events;
  - a trace's tool calls show their id;
  - the `OLLMOST_DEBUG=1` log line includes `"stream":true`.

## Tests
- New test files: `secrets`, `ollamaAdapter`, `registry`, `imageForModel` and `seam`.
- New service tests: a provider's neutral events, the echo of Ollama's calls, the server's timing, and title, `/compact` and replay through the provider.
- Changed: `assemble.test.ts` and the `runRounds` setup build and read the neutral shapes.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```
Expected: the PR's URL. Don't merge: the user merges when they say so.

- [ ] **Step 10: The user's check**

Run: `OLLMOST_INSTALL_DIR=~/Applications npm run install:mac`
Then ask the user to open `~/Applications/Ollmost.app` and check that nothing changed:
1. A new chat with a local model streams its reply and gets a title.
2. A web search round works (the ollama.com key is set), and so does a follow-up that refers back to it.
3. An image sent to a vision model is described.
4. `/compact` summarizes, and the next reply carries on from the summary.
5. A sub-agent task (a `delegate` call) runs and its card fills in. Two tasks delegated in one turn run at the same
   time (Settings → Tools → Sub-agents, "Sub-agents at once": 3 by default), and the reply reads both results.
6. In the debugger (⇧⌘D), a local model's chat trace shows its request, its final chunk and the "Ollama: model load …" timing rows, and Replay on it answers.
7. The model picker and Settings → Models list the same models as before.

Report what they find. Merging waits for the user.

---

## Contract additions (PR 2)

PR 2 uses these names on top of the plan's Shared contracts and PR 1's additions. Later parts use them as written here.

```ts
// ---- src/shared/modelKey.ts ----
export const ENDPOINT_ID: RegExp                          // /^[a-z0-9-]+$/
export function keyPrefix(key: string): string | null     // the part before the first '/' when it's shaped like an id
// slugEndpointId never returns 'all' (the picker's "every endpoint" filter value): "All" becomes 'all-2'.

// ---- src/shared/endpoints.ts (new; pure, shared by main and renderer) ----
export const OLLAMA_CLOUD_URL = 'https://ollama.com'
export const DEFAULT_OLLAMA_URL = 'http://127.0.0.1:11434'
export const DEFAULT_NUM_CTX = 32_768                     // an Ollama endpoint's num_ctx when unset (today's localNumCtx)
export const DEFAULT_CONTEXT = 8_192                      // an OpenAI endpoint's defaultContext when unset
export const FLAVOR_LABELS: Record<EndpointFlavor, string>
export function isOllamaCloudUrl(url: string): boolean    // hostname is ollama.com
export function isLoopbackHost(hostname: string): boolean // localhost, 127.0.0.1, [::1]
export function whereOf(baseUrl: string): 'this-mac' | 'network'   // providers/where.ts re-exports it (see decision 3)
export function displayAddress(baseUrl: string): string   // "192.168.1.20:8000": host, port, and a path other than /v1
export function probeSummary(p: EndpointProbe): string    // "Found LM Studio 0.4 · 5 models · 4 with tools · …"
export function removalText(name: string, impact: { chats: number; hasKey: boolean; overrides: number }): { title: string; body: string[] }

// ---- src/shared/modelLabel.ts ----
export function shortModelName(name: string): string      // "gpt-oss:120b-cloud" → "gpt-oss:120b"; ":latest" dropped
export function labelForKey(key: string | null | undefined, endpoints: readonly Endpoint[]): string   // for a stored key

// ---- src/shared/pickerGroups.ts ----
export interface EndpointChip { id: string; label: string; offline: boolean; error?: string }   // endpointChips' items

// ---- src/shared/availability.ts ----
export type ModelAvailability = ReturnType<typeof modelAvailability>
export function unavailableText(reason: ModelAvailability, key: string, endpoints: readonly Endpoint[]): string

// ---- src/main/settings.ts ----
export type StoredEndpoint = Omit<Endpoint, 'hasKey'>
export const DEFAULT_OLLAMA: StoredEndpoint               // id 'ollama', 127.0.0.1:11434, catalog on, num_ctx 32768
export function migrateSettings(raw: Record<string, unknown>): { settings: Record<string, unknown>; migrated: boolean }
export function setEndpoints(list: Array<StoredEndpoint | Endpoint>): void   // the only writer of settings.endpoints
// Tasks 2.2–2.5 only: ollamaConnection(): { mode; host; showCloudCatalog; numCtx } bridges the removed `connection`.
// Kept from #175: export const DEFAULT_SUB_AGENTS_AT_ONCE = 3, and DEFAULTS.delegate.parallel set to it.

// ---- src/main/db ----
export const MODEL_KEYS_MIGRATION: number                 // migrations.ts: the model-key entry's index
export function endpointsBackupPath(dir: string, at: Date): string   // index.ts
export function countEndpointOverrides(endpointId: string): number    // kv.ts: rows with overrides != '{}'

// ---- src/main/providers/ollama/wire.ts ----
export interface OllamaTarget { base: string; name: string; headers: Record<string, string>; cloud: boolean; keyed: boolean }
// Every request function takes the target first: chatStream(t, body, signal, timeouts), chatOnce(t, body, opts),
// listTags(t), showModel(t, model), endpointFor(t, path). listCloudCatalog() reads ollama.com's catalog with no key.
// streamTimeoutsFor(where: ModelWhere) (was location). connectionMode() is deleted (Task 2.4); the wire reads no settings.

// ---- src/main/providers/ollama/models.ts ----
export function ollamaWhere(endpoint: Pick<Endpoint, 'baseUrl'>, name: string): ModelWhere
export async function listOllamaModels(endpoint: Endpoint, t: OllamaTarget, refresh: boolean): Promise<ModelInfo[]>
export async function getModelInfo(endpoint: Endpoint, t: OllamaTarget, name: string, refresh?: boolean): Promise<ModelInfo>
// setModelOverrides moves to the models.setOverrides IPC handler.

// ---- src/main/providers/ollama/adapter.ts ----
export function ollamaTarget(endpoint: Pick<Endpoint, 'id' | 'name' | 'baseUrl'>): OllamaTarget
export function ollamaOptions(req: Pick<ChatRequest, 'temperature' | 'contextWindow'>, clientContext: boolean): Record<string, number> | undefined
export function toOllamaBody(req: ChatRequest, clientContext: boolean): ChatBody   // PR 1's, with the num_ctx rule made explicit
export function ollamaTimeouts(endpoint: Pick<Endpoint, 'baseUrl'>, model: string): StreamTimeouts
export class OllamaProvider implements Provider { constructor(endpoint: Endpoint) }   // id = endpoint.id

// ---- src/main/providers/probe.ts ----
export function sameServer(a: string, b: string): boolean // one server however typed; localhost = 127.0.0.1 = [::1]

// ---- src/main/providers/endpoints.ts (new: the endpoints IPC's logic) ----
export function assertAddressFree(baseUrl: string, exceptId?: string): void   // throws "<name> already uses this address."
export async function probeNewEndpoint(input: { baseUrl: string; apiKey?: string }): Promise<EndpointProbe>
export function addEndpoint(input: { name: string; baseUrl: string; kind: EndpointKind; flavor: EndpointFlavor; apiKey?: string }): Endpoint
export function updateEndpoint(id: string, patch: EndpointPatch): Endpoint   // PR 3: async, re-probes an OpenAI endpoint's new address
export function endpointRemovalImpact(id: string): { chats: number; hasKey: boolean; overrides: number }
export function removeEndpoint(id: string): void
export function setEndpointKey(id: string, key: string | null): Endpoint
// PR 2's addEndpoint refuses kind 'openai' ("…arrives in the next update"); PR 3 lifts that, keeping an OpenAI
// endpoint's API base (the probe's baseUrl) rather than the root.

// ---- src/main/chat/service.ts ----
export function titleModelFor(chatModel: string): string  // settings.titleModel, or the chat's when it can't be resolved

// ---- renderer ----
// stores/app.ts: modelErrors: ModelListResult['errors'] (replaces modelsError), modelsReady: boolean,
//   endpointsChanged(): Promise<void>, selectEndpoints(s): Endpoint[], contextWindowFor(model) (no settings argument).
// views/settingsParts.tsx gains BlurField (moved); views/settings/ApiKeyField.tsx holds ApiKeyField (moved).
// ModelPicker props: { value: string | null (a key); onChange(key); unavailable?: boolean }.

// ---- unchanged on purpose ----
// RoundsInput.modelName stays; since PR 2 it carries the model key (what usage rows and traces store).
// models.redetect (IPC) and Re-detect in Settings are PR 3's; PR 2 doesn't add them.
```

## Decisions this part makes

1. **A key whose prefix names no endpoint is a removed endpoint's.** `splitModelKey` falls back to `ollama` for an
   unknown prefix, so on its own it would send `lm-studio/qwen3` to Ollama after LM Studio was removed. `registry.resolve`
   and `modelAvailability` first check `keyPrefix(key)`: a prefix shaped like an id (`[a-z0-9-]+`) that names no
   endpoint means the endpoint is gone (`EndpointGoneError`). A bare name from before keys either has no `/`
   (`llama3.2`) or a dotted first part (`hf.co/…`), so it still reaches Ollama whole. The cost: a bare namespaced name
   (`user/model`) left over unmigrated reads as "endpoint removed". After the migration there are none.
2. **The backup runs when `0 < user_version ≤ MODEL_KEYS_MIGRATION`.** An entry runs while `user_version` is at or
   below its index, and a fresh database (version 0) has nothing to back up.
3. **`whereOf` lives in `src/shared/endpoints.ts`** and `providers/where.ts` re-exports it. `groupModels` needs it for an
   offline endpoint's section, which has no models to read `where` from, and shared code can't import main.
4. **`normalizeBaseUrl` returns the server's root**, dropping a trailing `/v1` and slashes, so all three Review Focus #5
   spellings normalise to one string. It's what addresses are compared by (`sameServer`, the duplicate check).
   `probeEndpoint` returns the `baseUrl` to store: the root for Ollama, and for OpenAI-compatible servers the API base
   the probe confirmed (`<root>/v1` in PR 2). PR 2 only adds and edits Ollama endpoints, so it stores roots; PR 3's
   `addEndpoint` and `updateEndpoint` store an OpenAI endpoint's API base (an edited address is probed again).
5. **Removing `connection` needs a bridge.** Every reader of `connection`, `localNumCtx` and `showCloudCatalog` can't
   switch in Task 2.2 without dragging the whole registry in. `ollamaConnection()` reads the `ollama` endpoint in the old
   shape for Tasks 2.2–2.4, and Task 2.5 deletes it.
6. **Thinking profiles and the system prompt use the raw name.** `resolveThinkProfile`'s family rules match
   `/^gpt-oss/`, and the prompt says "You are the model "<name>"". Main passes `info.name`, never the key. A service
   test pins it.
7. **A local Ollama that's down now lists nothing.** Today it still lists the cloud catalog, whose `:cloud` names need
   the app to run. Now `listModels` throws, and the endpoint shows as offline.
8. **`modelLabel` can't mark cloud models**, because its `Pick` has no `where`. The palette adds " (cloud)" itself.
9. **Replay stays on the `ollama` endpoint in PR 2.** A replay body carries a raw name, so it's resolved as
   `toModelKey('ollama', body.model)`, which is where replays go today. PR 4 routes a replay by its trace's key.
10. **A second Ollama endpoint starts with the cloud catalog off**, so ollama.com's catalog isn't listed twice.

---

## PR 2 — Endpoints and identity

Branch: `claude/model-endpoints-identity`, from `main` after PR 1 (`claude/model-endpoints-seam`) merges.

After this PR, every model is known by a key, `endpointId/model`. Existing chats, usage rows, traces and model settings
are migrated onto the endpoint `ollama`, and the database is backed up first. Several Ollama endpoints can be configured
at once, and the picker lists them all, with endpoint chips. Settings → Models becomes master–detail, and the Add
endpoint dialog adds Ollama servers. A chat whose model can't be reached says so and won't send. OpenAI-compatible
servers come in PR 3; this PR's probe recognises one but won't add it.

**Before starting**, re-read every file each task names, on the branch as PR 1 left it. PR 1's section of this plan
names the shapes this part builds on: `toOllamaBody(req)`, `ollamaEvents`, `resultFromOllama`,
`ollamaTimeouts(model)`, `OllamaProvider` (no constructor arguments), `getModelInfo(name, refresh)`,
`Provider.wireEndpoint()`, and `RoundsInput.model` (kept so PR 2 can price by it). Where a step says "PR 1's …", the
code on the branch wins over this plan's line numbers, never over its behaviour.

Test commands are `npx vitest run <file>`. Every task ends with
`npm run typecheck && npm run lint && npm run format:check && npm test` green; run `npx prettier --write` on the files
the task touched first, since the code here isn't guaranteed to be wrapped exactly at 140 columns.

### Task 2.1: `modelKey.ts`: keys, splitting, endpoint ids

**Files:**
- Create: `src/shared/modelKey.ts`
- Test: `tests/modelKey.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `ModelKey`, `MIGRATED_ENDPOINT_ID`, `ENDPOINT_ID`, `toModelKey(endpointId, model): ModelKey`,
  `splitModelKey(key, knownIds): { endpointId; model }`, `keyPrefix(key): string | null`,
  `slugEndpointId(name, taken): string`.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest'
import { ENDPOINT_ID, keyPrefix, MIGRATED_ENDPOINT_ID, slugEndpointId, splitModelKey, toModelKey } from '../src/shared/modelKey'

const HF = 'hf.co/bartowski/Qwen3-8B-GGUF:Q4_K_M'

describe('model keys', () => {
  it('put the endpoint id in front of the name the server knows', () => {
    expect(toModelKey('lm-studio', 'qwen/qwen3-8b')).toBe('lm-studio/qwen/qwen3-8b')
    expect(MIGRATED_ENDPOINT_ID).toBe('ollama')
  })

  it('split on the first slash when the prefix is a known endpoint', () => {
    expect(splitModelKey('lm-studio/qwen/qwen3-8b', ['ollama', 'lm-studio'])).toEqual({ endpointId: 'lm-studio', model: 'qwen/qwen3-8b' })
    expect(splitModelKey('ollama/gpt-oss:120b-cloud', ['ollama'])).toEqual({ endpointId: 'ollama', model: 'gpt-oss:120b-cloud' })
  })

  it('keep an Ollama name with slashes whole (Review Focus #1)', () => {
    const key = toModelKey(MIGRATED_ENDPOINT_ID, HF)
    expect(key).toBe(`ollama/${HF}`)
    expect(splitModelKey(key, ['ollama', 'lm-studio'])).toEqual({ endpointId: 'ollama', model: HF })
  })

  it('read a bare name from before keys as Ollama’s, whole', () => {
    expect(splitModelKey('llama3.2', ['ollama'])).toEqual({ endpointId: 'ollama', model: 'llama3.2' })
    expect(splitModelKey(HF, ['ollama'])).toEqual({ endpointId: 'ollama', model: HF })
    // A prefix that names no endpoint isn't split: that's for the registry to judge (see keyPrefix).
    expect(splitModelKey('gone/qwen3', ['ollama'])).toEqual({ endpointId: 'ollama', model: 'gone/qwen3' })
  })

  it('tell a prefix shaped like an endpoint id from a bare name', () => {
    expect(keyPrefix('lm-studio/qwen/qwen3-8b')).toBe('lm-studio')
    expect(keyPrefix(`ollama/${HF}`)).toBe('ollama')
    expect(keyPrefix(HF)).toBeNull()
    expect(keyPrefix('llama3.2')).toBeNull()
    expect(keyPrefix('/x')).toBeNull()
  })
})

describe('endpoint ids', () => {
  it('are made from the name', () => {
    expect(slugEndpointId('LM Studio', [])).toBe('lm-studio')
    expect(slugEndpointId('llama.cpp', [])).toBe('llama-cpp')
    expect(slugEndpointId('  GPU box #2 ', [])).toBe('gpu-box-2')
    expect(slugEndpointId('???', [])).toBe('endpoint')
    expect(ENDPOINT_ID.test(slugEndpointId('Ünïcode Ñame', []))).toBe(true)
  })

  it('take the next free number on a clash, and never "all" (the picker’s filter)', () => {
    expect(slugEndpointId('Ollama', ['ollama'])).toBe('ollama-2')
    expect(slugEndpointId('Ollama', ['ollama', 'ollama-2'])).toBe('ollama-3')
    expect(slugEndpointId('All', [])).toBe('all-2')
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/modelKey.test.ts`
Expected: FAIL. The suite can't load `../src/shared/modelKey` ("Does the file exist?").

- [ ] **Step 3: Implement**

```ts
// Model identity across endpoints: a key "<endpoint id>/<the model's name at its server>". Only splitModelKey (here)
// and registry.resolve (main) take one apart; a raw name never leaves an adapter.

/** "ollama/gpt-oss:120b-cloud", "lm-studio/qwen/qwen3-8b". Branded so a bare name can't pass for one by accident. */
export type ModelKey = string & { readonly __brand: 'ModelKey' }

/** The endpoint every model from before endpoints is on: the settings and database migrations both use it. */
export const MIGRATED_ENDPOINT_ID = 'ollama'

/** What an endpoint id may be. No '.', so "hf.co/…" never reads as one; no '/', the key's separator. */
export const ENDPOINT_ID = /^[a-z0-9-]+$/

// The picker's endpoint filter uses 'all' for every endpoint, so no endpoint may have that id.
const RESERVED_IDS = ['all']

export const toModelKey = (endpointId: string, model: string): ModelKey => `${endpointId}/${model}` as ModelKey

/**
 * A key's endpoint and model. The part before the first '/' is the endpoint when it's one of `knownIds`; anything
 * else is a bare name from before keys, which is Ollama's, whole: "hf.co/bartowski/Qwen3-8B-GGUF:Q4_K_M" keeps its slashes.
 */
export function splitModelKey(key: string, knownIds: readonly string[]): { endpointId: string; model: string } {
  const slash = key.indexOf('/')
  if (slash > 0 && knownIds.includes(key.slice(0, slash))) return { endpointId: key.slice(0, slash), model: key.slice(slash + 1) }
  return { endpointId: MIGRATED_ENDPOINT_ID, model: key }
}

/**
 * The part before a key's first '/' when it's shaped like an endpoint id, else null. A key whose prefix has that shape
 * but names no endpoint was on one that's been removed. A bare name has none: "llama3.2", or "hf.co/…" (a dot).
 */
export function keyPrefix(key: string): string | null {
  const slash = key.indexOf('/')
  const prefix = slash > 0 ? key.slice(0, slash) : ''
  return ENDPOINT_ID.test(prefix) ? prefix : null
}

/** A new endpoint's id, from its name: "LM Studio" → "lm-studio", "llama.cpp" → "llama-cpp". A clash gets -2, -3… */
export function slugEndpointId(name: string, taken: readonly string[]): string {
  const base =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'endpoint'
  const used = (id: string) => taken.includes(id) || RESERVED_IDS.includes(id)
  if (!used(base)) return base
  let n = 2
  while (used(`${base}-${n}`)) n++
  return `${base}-${n}`
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/modelKey.test.ts` then `npm run typecheck && npm run lint && npm run format:check && npm test`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/shared/modelKey.ts tests/modelKey.test.ts
git commit -m "Model keys: endpointId/model, split on the first slash, bare names read as Ollama's

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 2.2: Endpoint settings and the settings migration

**Files:**
- Create: `src/shared/endpoints.ts`
- Modify: `src/shared/types.ts` (endpoint types after `ModelListResult`, ~line 301; `Settings`, ~574–625)
- Modify: `src/main/settings.ts` (whole file; #175's `DEFAULT_SUB_AGENTS_AT_ONCE` and `delegate.parallel` default are kept)
- Modify: `src/main/providers/ollama/wire.ts` (`target()`, `friendly()`, `request()`'s catch, `connectionMode()`)
- Modify: `src/main/providers/ollama/models.ts` (the `showCloudCatalog` read)
- Modify: `src/main/chat/service.ts`, `src/main/chat/delegate.ts` (every `localNumCtx` read)
- Modify: `src/main/usage/account.ts:16-29` (`fetchPlan`)
- Modify: `src/renderer/src/views/SettingsView.tsx` (UsageTab ~416, FeaturesTab ~843, ModelsTab ~700–775)
- Modify: `src/renderer/src/stores/app.ts:195-199`
- Test: `tests/settings.test.ts` (rewritten: #175 created it with one test, which is kept); the setups of
  `tests/service.test.ts:67` and PR 1's `tests/client.test.ts`, `tests/ollamaAdapter.test.ts` and `tests/registry.test.ts`

**Interfaces:**
- Consumes: `MIGRATED_ENDPOINT_ID`, `toModelKey` (2.1); PR 1's `secrets.ts` (`OLLAMA_ACCOUNT_SECRET`,
  `endpointSecretName`, `setSecret`, `getSecret`); #175's `DEFAULT_SUB_AGENTS_AT_ONCE` (kept in `settings.ts`, read by
  `delegate.ts`'s `subAgentsAtOnce()`).
- Produces: `Endpoint`, `EndpointKind`, `EndpointFlavor`, `EndpointProbe`, `ModelWhere`, `ModelBilling`
  (`src/shared/types.ts`); `Settings.endpoints`, `Settings.ollamaAccount`; everything in `src/shared/endpoints.ts`
  except `probeSummary` and `removalText` (Task 2.8); `StoredEndpoint`, `DEFAULT_OLLAMA`, `migrateSettings`,
  `setEndpoints`, and the temporary `ollamaConnection()` in `src/main/settings.ts`.

- [ ] **Step 1: Write the failing test**

`tests/settings.test.ts` exists since #175, with one test: a settings row saved before `delegate.parallel` existed
reads 3 from the defaults. Replace the file with the following. That test is kept as the first `describe`, now loading
through `load()` like the others (a row without `endpoints` is migrated as well, which changes nothing it checks):

```ts
import { describe, expect, it, vi } from 'vitest'
import type { DeepPartial } from '@shared/ipc'
import type { Settings } from '@shared/types'
import { displayAddress, isOllamaCloudUrl, whereOf } from '../src/shared/endpoints'

// The keychain is faked, as in migrate.test.ts: Electron isn't running under vitest.
vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (s: string) => Buffer.from(`enc:${s}`),
    decryptString: (b: Buffer) => b.toString().replace(/^enc:/, '')
  },
  shell: {},
  app: { getPath: () => '' }
}))

/** Fresh modules on a fresh database whose stored settings row is `raw` (none when undefined). */
async function load(raw?: unknown) {
  vi.resetModules()
  const db = await import('../src/main/db/index')
  db.openDatabase(':memory:')
  const kv = await import('../src/main/db/kv')
  if (raw !== undefined) kv.writeSetting('app', raw)
  return { kv, settings: await import('../src/main/settings'), secrets: await import('../src/main/providers/secrets') }
}

const OLLAMA = { id: 'ollama', name: 'Ollama', kind: 'ollama', flavor: 'ollama', enabled: true, hasKey: false }

describe('settings saved by an earlier version', () => {
  it('read what they lack from the defaults: sub-agents run 3 at once', async () => {
    // Saved before sub-agents could run at once, and read for the first time since.
    const { settings } = await load({ userName: 'Ed', delegate: { enabled: false, maxRounds: 10 } })
    expect(settings.getSettings().delegate).toEqual({ enabled: false, maxRounds: 10, parallel: 3 })
    expect(settings.getSettings().userName).toBe('Ed')
  })
})

describe('the settings migration', () => {
  it('starts a fresh install with one Ollama endpoint on this Mac', async () => {
    const { settings } = await load()
    const s = settings.getSettings()
    expect(s.endpoints).toEqual([{ ...OLLAMA, baseUrl: 'http://127.0.0.1:11434', showCloudCatalog: true, numCtx: 32768 }])
    expect(s.ollamaAccount).toEqual({ hasKey: false })
    for (const gone of ['connection', 'localNumCtx', 'showCloudCatalog']) expect(s).not.toHaveProperty(gone)
  })

  it('turns a local connection into the ollama endpoint and keys the default and title models', async () => {
    const { kv, settings } = await load({
      userName: 'Ed',
      connection: { mode: 'local', host: 'http://10.0.0.5:11434/' },
      showCloudCatalog: false,
      localNumCtx: 65536,
      defaultModel: 'qwen3:8b',
      titleModel: 'hf.co/bartowski/Qwen3-8B-GGUF:Q4_K_M'
    })
    const s = settings.getSettings()
    expect(s.endpoints).toEqual([{ ...OLLAMA, baseUrl: 'http://10.0.0.5:11434', showCloudCatalog: false, numCtx: 65536 }])
    expect(s).toMatchObject({ userName: 'Ed', defaultModel: 'ollama/qwen3:8b', titleModel: 'ollama/hf.co/bartowski/Qwen3-8B-GGUF:Q4_K_M' })
    // Written back at once, like the database's migration: the old fields are gone from the row.
    const row = kv.readSetting<Record<string, unknown>>('app', {})
    expect([row.connection, row.showCloudCatalog, row.localNumCtx]).toEqual([undefined, undefined, undefined])
    expect(row.endpoints).toHaveLength(1)
  })

  it('turns a direct connection into an "Ollama cloud" endpoint on ollama.com', async () => {
    const { settings } = await load({ connection: { mode: 'direct', host: 'http://127.0.0.1:11434' }, defaultModel: null })
    const s = settings.getSettings()
    expect(s.endpoints).toEqual([{ ...OLLAMA, name: 'Ollama cloud', baseUrl: 'https://ollama.com' }])
    expect(s.defaultModel).toBeNull()
    expect(settings.ollamaConnection()).toMatchObject({ mode: 'direct', host: 'https://ollama.com' })
  })

  it('leaves a row that already has endpoints alone', async () => {
    const lm = { id: 'lm-studio', name: 'LM Studio', kind: 'openai', flavor: 'lmstudio', baseUrl: 'http://localhost:1234/v1', enabled: true }
    const { settings } = await load({ endpoints: [lm], defaultModel: 'lm-studio/qwen/qwen3-8b' })
    expect(settings.getSettings()).toMatchObject({ endpoints: [{ ...lm, hasKey: false }], defaultModel: 'lm-studio/qwen/qwen3-8b' })
  })
})

describe('endpoints in settings', () => {
  it('are never changed by a settings update', async () => {
    const { settings } = await load()
    const before = settings.getSettings().endpoints
    const patch = { endpoints: [], ollamaAccount: { hasKey: true }, userName: 'Ed' } as DeepPartial<Settings>
    expect(settings.updateSettings(patch)).toMatchObject({ endpoints: before, ollamaAccount: { hasKey: false }, userName: 'Ed' })
  })

  it('say whether each has a key, apart from the ollama.com account’s', async () => {
    const { settings, secrets } = await load()
    settings.setApiKey('account-key')
    expect(settings.getSettings()).toMatchObject({ ollamaAccount: { hasKey: true }, endpoints: [{ id: 'ollama', hasKey: false }] })
    secrets.setSecret(secrets.endpointSecretName('ollama'), 'endpoint-key')
    expect(settings.getSettings().endpoints[0].hasKey).toBe(true)
  })

  it('are replaced as a list by setEndpoints, which never stores hasKey', async () => {
    const { kv, settings } = await load()
    settings.setEndpoints([{ ...settings.DEFAULT_OLLAMA, name: 'Home', hasKey: true }])
    expect(settings.getSettings().endpoints[0]).toMatchObject({ name: 'Home', hasKey: false })
    expect(kv.readSetting<{ endpoints: object[] }>('app', { endpoints: [] }).endpoints[0]).not.toHaveProperty('hasKey')
  })
})

describe('addresses', () => {
  it('know ollama.com itself from anything else', () => {
    expect(isOllamaCloudUrl('https://ollama.com')).toBe(true)
    expect(isOllamaCloudUrl('https://ollama.com/')).toBe(true)
    expect(isOllamaCloudUrl('http://127.0.0.1:11434')).toBe(false)
    expect(isOllamaCloudUrl('https://ollama.com.example.net')).toBe(false)
    expect(isOllamaCloudUrl('not a url')).toBe(false)
  })

  it('say where a server runs: this Mac for a loopback address, the network otherwise', () => {
    for (const url of ['http://localhost:1234', 'http://127.0.0.1:11434', 'http://[::1]:8080']) expect(whereOf(url)).toBe('this-mac')
    for (const url of ['http://192.168.1.20:8000/v1', 'http://gpu.local:11434']) expect(whereOf(url)).toBe('network')
  })

  it('show as host, port and any path but /v1', () => {
    expect(displayAddress('http://localhost:1234/v1')).toBe('localhost:1234')
    expect(displayAddress('http://192.168.1.20:8000')).toBe('192.168.1.20:8000')
    expect(displayAddress('https://gpu.example.com/api/openai/v1')).toBe('gpu.example.com/api/openai')
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/settings.test.ts`
Expected: FAIL. The suite can't load `../src/shared/endpoints` ("Does the file exist?").

- [ ] **Step 3: Implement `src/shared/endpoints.ts`**

```ts
// What an endpoint is, as data both processes need: the defaults, and what an address says about a server.
import type { EndpointFlavor, ModelWhere } from './types'

export const OLLAMA_CLOUD_URL = 'https://ollama.com'
export const DEFAULT_OLLAMA_URL = 'http://127.0.0.1:11434'
/** Ollama's num_ctx for an endpoint that hasn't set one: what local models got before endpoints. */
export const DEFAULT_NUM_CTX = 32_768
/** The window assumed for an OpenAI-compatible model when nothing reports one. */
export const DEFAULT_CONTEXT = 8_192

export const FLAVOR_LABELS: Record<EndpointFlavor, string> = {
  ollama: 'Ollama',
  lmstudio: 'LM Studio',
  llamacpp: 'llama.cpp',
  vllm: 'vLLM',
  generic: 'OpenAI-compatible'
}

function hostnameOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase()
  } catch {
    return null
  }
}

/** ollama.com itself (Ollama's cloud API), as opposed to an Ollama app somewhere. */
export const isOllamaCloudUrl = (url: string): boolean => hostnameOf(url) === 'ollama.com'

/** A hostname for this Mac. URL keeps an IPv6 address's brackets. */
export const isLoopbackHost = (hostname: string): boolean => ['localhost', '127.0.0.1', '[::1]'].includes(hostname)

/** Where a server runs, by its address: this Mac for a loopback address, another machine for anything else. */
export function whereOf(baseUrl: string): Exclude<ModelWhere, 'cloud'> {
  const host = hostnameOf(baseUrl)
  return host !== null && isLoopbackHost(host) ? 'this-mac' : 'network'
}

/** An address as headings and errors show it: host, port, and a path other than a trailing /v1. */
export function displayAddress(baseUrl: string): string {
  try {
    const url = new URL(baseUrl)
    return `${url.host}${url.pathname.replace(/\/+$/, '').replace(/\/v1$/, '')}`
  } catch {
    return baseUrl
  }
}
```

- [ ] **Step 4: Add the endpoint types and change `Settings` in `src/shared/types.ts`**

After `ModelListResult` (~line 301), add:

```ts
// ---- Endpoints ------------------------------------------------------------

export type EndpointKind = 'ollama' | 'openai'
export type EndpointFlavor = 'ollama' | 'lmstudio' | 'llamacpp' | 'vllm' | 'generic'

/** A model server Ollmost talks to. Its key is in the keychain; `hasKey` only says there is one. */
export interface Endpoint {
  /** [a-z0-9-], made from the name when added. It never changes: model keys start with it. */
  id: string
  name: string
  kind: EndpointKind
  flavor: EndpointFlavor
  /** Ollama: the server's root. OpenAI: the base URL as the server's docs give it (usually …/v1). */
  baseUrl: string
  enabled: boolean
  hasKey: boolean
  /** Ollama: list ollama.com's whole cloud catalog through this server, not only pulled models. */
  showCloudCatalog?: boolean
  /** Ollama: the num_ctx Ollmost sends for the models this server runs (capped at each model's own length). */
  numCtx?: number
  /** OpenAI: the window assumed when nothing reports one. */
  defaultContext?: number
  /** OpenAI: false once the server has rejected `stream_options`. */
  streamOptions?: boolean
}

/** What checking an address found, before it's added. */
export interface EndpointProbe {
  kind: EndpointKind
  flavor: EndpointFlavor
  /** The address to store: Ollama's root, or the OpenAI base the probe confirmed. */
  baseUrl: string
  version: string | null
  models: number
  withTools: number
  withVision: number
  canThink: number
  reportsCapabilities: boolean
  reportsContext: boolean
}

/** Where a model runs: Ollama's cloud, this Mac (a loopback address), or another machine. */
export type ModelWhere = 'cloud' | 'this-mac' | 'network'
/** Whether Ollmost can price a model's requests. Only Ollama's cloud models are priced. */
export type ModelBilling = 'priced' | 'local' | 'untracked'
```

In `Settings`, replace `connection`, `defaultModel`, `titleModel`, `showCloudCatalog` and `localNumCtx` with:

```ts
  /** Where models come from. Changed only through the endpoints calls, never through a settings update. */
  endpoints: Endpoint[]
  /** The ollama.com API key: web tools for every model, quota, and an Ollama endpoint on ollama.com. */
  ollamaAccount: { hasKey: boolean }
  /** Model keys (endpointId/model). */
  defaultModel: string | null
  titleModel: string | null
```

Everything else in `Settings` stays as it is, #175's `delegate: { enabled: boolean; maxRounds: number; parallel: number }`
(and its doc comment) included.

- [ ] **Step 5: Rewrite `src/main/settings.ts`**

```ts
import type { DeepPartial } from '@shared/ipc'
import { DEFAULT_NUM_CTX, DEFAULT_OLLAMA_URL, isOllamaCloudUrl, OLLAMA_CLOUD_URL } from '@shared/endpoints'
import { MIGRATED_ENDPOINT_ID, toModelKey } from '@shared/modelKey'
import { DEFAULT_THEME_ID } from '@shared/themes'
import type { Endpoint, Settings } from '@shared/types'
import { readSetting, writeSetting } from './db/kv'
import { endpointSecretName, getSecret, OLLAMA_ACCOUNT_SECRET, setSecret } from './providers/secrets'

/** An endpoint as stored: whether it has a key is read from the keychain rows each time, never saved. */
export type StoredEndpoint = Omit<Endpoint, 'hasKey'>
type StoredSettings = Omit<Settings, 'endpoints' | 'ollamaAccount'> & { endpoints: StoredEndpoint[] }

/** How many sub-agents one reply may run at the same time, unless the user sets it (or their settings file has none). */
export const DEFAULT_SUB_AGENTS_AT_ONCE = 3

/** The endpoint a fresh install starts with. Its id is the one both migrations give every older model. */
export const DEFAULT_OLLAMA: StoredEndpoint = {
  id: MIGRATED_ENDPOINT_ID,
  name: 'Ollama',
  kind: 'ollama',
  flavor: 'ollama',
  baseUrl: DEFAULT_OLLAMA_URL,
  enabled: true,
  showCloudCatalog: true,
  numCtx: DEFAULT_NUM_CTX
}

const DEFAULTS: StoredSettings = {
  userName: '',
  preferences: '',
  endpoints: [DEFAULT_OLLAMA],
  defaultModel: null,
  titleModel: null,
  appearance: { themeId: DEFAULT_THEME_ID, mode: 'system', fontSize: 16, chatWidth: 768, responseFont: 'reading' },
  artifacts: { enabled: true, allowCdn: true },
  skills: { sources: { ollama: true, claude: true }, disabled: [], enabledImports: [], autoLoad: true },
  web: { enabled: true },
  runner: { mode: 'ask', defaultOn: false, pypi: false, timeoutSec: 120 },
  code: { edits: 'ask', commands: 'ask', timeoutSec: 300, maxRounds: 60, defaultNetwork: 'none' },
  delegate: { enabled: true, maxRounds: 20, parallel: DEFAULT_SUB_AGENTS_AT_ONCE },
  debug: { record: true },
  links: { previews: false },
  usage: { showInHeader: true, headerWindow: 'auto', anchors: {}, monthlyDay: null, poolUsd: null }
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function deepMerge<T>(base: T, patch: unknown): T {
  if (!isPlainObject(base) || !isPlainObject(patch)) return (patch === undefined ? base : patch) as T
  const out: Record<string, unknown> = { ...base }
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue
    out[k] = k in base ? deepMerge((base as Record<string, unknown>)[k], v) : v
  }
  return out as T
}

type Legacy = { connection?: { mode?: string; host?: string }; showCloudCatalog?: boolean; localNumCtx?: number }

/**
 * Settings from before endpoints had one Ollama `connection`. It becomes the endpoint `ollama`, which the database
 * migration also puts every stored model on, and the default and title models become keys on it. A row that has
 * `endpoints` is left alone, so this runs once.
 */
export function migrateSettings(raw: Record<string, unknown>): { settings: Record<string, unknown>; migrated: boolean } {
  if (Array.isArray(raw.endpoints)) return { settings: raw, migrated: false }
  const { connection, showCloudCatalog, localNumCtx, ...rest } = raw as Legacy & Record<string, unknown>
  const endpoint: StoredEndpoint =
    connection?.mode === 'direct'
      ? { id: MIGRATED_ENDPOINT_ID, name: 'Ollama cloud', kind: 'ollama', flavor: 'ollama', baseUrl: OLLAMA_CLOUD_URL, enabled: true }
      : {
          ...DEFAULT_OLLAMA,
          baseUrl: (connection?.host || DEFAULT_OLLAMA_URL).replace(/\/+$/, ''),
          showCloudCatalog: showCloudCatalog ?? true,
          numCtx: localNumCtx ?? DEFAULT_NUM_CTX
        }
  const key = (model: unknown) => (typeof model === 'string' && model ? toModelKey(MIGRATED_ENDPOINT_ID, model) : null)
  return { settings: { ...rest, endpoints: [endpoint], defaultModel: key(rest.defaultModel), titleModel: key(rest.titleModel) }, migrated: true }
}

let cache: StoredSettings | null = null

function stored(): StoredSettings {
  if (cache) return cache
  const raw = readSetting<unknown>('app', {})
  const { settings, migrated } = migrateSettings(isPlainObject(raw) ? raw : {})
  cache = deepMerge(DEFAULTS, settings)
  // Written at once: the migration is one-way, like the database's.
  if (migrated) writeSetting('app', cache)
  return cache
}

export function getSettings(): Settings {
  const { endpoints, ...s } = stored()
  return {
    ...s,
    endpoints: endpoints.map((e) => ({ ...e, hasKey: getSecret(endpointSecretName(e.id)) !== null })),
    ollamaAccount: { hasKey: getApiKey() !== null }
  }
}

/**
 * Everything but the endpoints and the account. Endpoints have their own calls (providers/endpoints.ts): the
 * deep-merge would take a partial list as the whole of it. The account's key is a keychain secret.
 */
export function updateSettings(patch: DeepPartial<Settings>): Settings {
  const { endpoints: _endpoints, ollamaAccount: _account, ...rest } = patch
  cache = deepMerge(stored(), rest)
  writeSetting('app', cache)
  return getSettings()
}

/** Replace the endpoint list as given; providers/endpoints.ts checks it first. A `hasKey` passed in is dropped. */
export function setEndpoints(list: Array<StoredEndpoint | Endpoint>): void {
  const endpoints = list.map((e) => {
    const { hasKey: _hasKey, ...rest } = e as Endpoint
    return rest
  })
  cache = { ...stored(), endpoints }
  writeSetting('app', cache)
}

// The ollama.com API key never leaves the main process; see providers/secrets.ts.
export function setApiKey(key: string | null): void {
  setSecret(OLLAMA_ACCOUNT_SECRET, key)
}

export function getApiKey(): string | null {
  return getSecret(OLLAMA_ACCOUNT_SECRET)
}

/**
 * Until Task 2.5 of the endpoints plan: the `ollama` endpoint in the shape the Ollama client, the plan lookup and the
 * context window read from the old `connection`. Deleted once they read endpoints.
 */
export function ollamaConnection(): { mode: 'local' | 'direct'; host: string; showCloudCatalog: boolean; numCtx: number } {
  const e = stored().endpoints.find((x) => x.id === MIGRATED_ENDPOINT_ID) ?? DEFAULT_OLLAMA
  return {
    mode: isOllamaCloudUrl(e.baseUrl) ? 'direct' : 'local',
    host: e.baseUrl,
    showCloudCatalog: e.showCloudCatalog ?? true,
    numCtx: e.numCtx ?? DEFAULT_NUM_CTX
  }
}
```

`setApiKey`/`getApiKey` are PR 1's (Task 1.1), unchanged: they wrap `setSecret`/`getSecret`, which trims the key,
deletes the row for an empty one and throws when OS encryption is unavailable. `DEFAULT_SUB_AGENTS_AT_ONCE` and the
`delegate` default are #175's, exactly as `main` has them: `delegate.ts` imports the constant for `subAgentsAtOnce()`,
and the deep-merge gives a row saved before the setting existed `parallel: 3` (the first test above, and
`tests/service.test.ts`'s "defaults sub-agents to on, capped at 20 rounds, 3 at once").

- [ ] **Step 6: Point the main-process readers at the bridge**

Run `grep -rn "connection\b\|\.connection\.\|localNumCtx\|showCloudCatalog" src/main`. Change each hit:

- `src/main/providers/ollama/wire.ts`: import `ollamaConnection` (and PR 1's key getter) from `'../../settings'`, then:

  ```ts
  function target(): { base: string; headers: Record<string, string> } {
    const c = ollamaConnection()
    if (c.mode === 'direct') {
      const key = getApiKey()
      return { base: OLLAMA_CLOUD, headers: key ? { Authorization: `Bearer ${key}` } : {} }
    }
    return { base: c.host.replace(/\/+$/, ''), headers: {} }
  }
  ```

  and in `friendly()`, in `request()`'s catch and in `connectionMode()`, replace `getSettings().connection.mode` with
  `ollamaConnection().mode`.
- `src/main/providers/ollama/models.ts`: `getSettings().showCloudCatalog` → `ollamaConnection().showCloudCatalog`.
- `src/main/chat/service.ts` and `src/main/chat/delegate.ts`: every `settings.localNumCtx` /
  `getSettings().localNumCtx` → `ollamaConnection().numCtx` (import it from `'../settings'`; in `delegate.ts` it joins
  `DEFAULT_SUB_AGENTS_AT_ONCE` and `getSettings` in that import).
- `src/main/usage/account.ts`, `fetchPlan()`:

  ```ts
  async function fetchPlan(): Promise<string | null> {
    if (plan) return plan
    const c = ollamaConnection()
    if (c.mode !== 'local') return null
    try {
      const res = await fetch(`${c.host.replace(/\/+$/, '')}/api/me`, { method: 'POST', signal: AbortSignal.timeout(5000) })
      if (!res.ok) return null
      plan = ((await res.json()) as { plan?: string }).plan ?? null
      return plan
    } catch {
      return null
    }
  }
  ```

  and change its settings import to `import { getApiKey, getSettings, ollamaConnection, updateSettings } from '../settings'`.

- [ ] **Step 7: Update the renderer**

- `src/renderer/src/stores/app.ts`, `contextWindowFor`:

  ```ts
  /** The window a chat with this model actually gets (local models are capped at the endpoint's num_ctx). */
  export function contextWindowFor(model: ModelInfo | undefined, settings: Settings | null): number | null {
    if (!model) return null
    const numCtx = settings?.endpoints.find((e) => e.id === MIGRATED_ENDPOINT_ID)?.numCtx ?? DEFAULT_NUM_CTX
    return settings ? effectiveContext(model, numCtx) : model.contextLength
  }
  ```

  with `import { DEFAULT_NUM_CTX } from '@shared/endpoints'` and `import { MIGRATED_ENDPOINT_ID } from '@shared/modelKey'`.
  Task 2.4 replaces the body.
- `src/renderer/src/views/SettingsView.tsx`:
  - UsageTab and FeaturesTab: `settings.connection.hasApiKey` → `settings.ollamaAccount.hasKey`.
  - ModelsTab: delete the "Connection" `Section` (the `Segmented`, the address field, the direct-mode `ApiKeyField`
    and the cloud catalog `Row`), `saveConnection`, `conn`, and the "Context window for local models" `Row`. Task 2.8
    brings all of them back on each endpoint's page. Remove the imports that become unused (`Segmented`, `Cloud`,
    `HardDrive` if nothing else uses them; `npm run lint` lists them).

- [ ] **Step 8: Update the test setups that set the connection**

- `tests/service.test.ts`: import `setEndpoints` alongside `updateSettings`, and replace line 67's call with:

  ```ts
  // The one Ollama endpoint, pointed at the mock.
  setEndpoints([
    { id: 'ollama', name: 'Ollama', kind: 'ollama', flavor: 'ollama', baseUrl: ollama.url, enabled: true, showCloudCatalog: true, numCtx: 32768 }
  ])
  updateSettings({ skills: { autoLoad: false }, web: { enabled: true } })
  ```

- `tests/client.test.ts` and `tests/ollamaAdapter.test.ts` (PR 1's) both mock `'../src/main/settings'` with a
  `getSettings` returning `connection`. Add to each mock (the adapter test's `conn` has a `mode`; the client test's is
  always `'local'`):

  ```ts
  ollamaConnection: () => ({ mode: conn.mode, host: conn.host, showCloudCatalog: false, numCtx: 32768 }),
  ```

  In `tests/client.test.ts` write `mode: 'local' as const` in place of `conn.mode`. Task 2.4 removes both mocks.
- `tests/registry.test.ts` (PR 1's, Task 1.4) sets the address with `updateSettings({ connection: … })`. Its settings
  import becomes `const { DEFAULT_OLLAMA, setEndpoints } = await import('../src/main/settings')`, and each such call is
  replaced through:

  ```ts
  const at = (host: string) => setEndpoints([{ ...DEFAULT_OLLAMA, baseUrl: host, showCloudCatalog: false }])
  ```

  `beforeAll`'s call becomes `at(ollama.url)`; the unreachable-app test's becomes `at('http://127.0.0.1:1')` and its
  `finally` becomes `at(ollama.url)`. (PR 1's registry holds one provider, and the wire reads `ollamaConnection()` per
  request, so nothing needs resetting.) Task 2.4 rewrites this file.

`e2e/run.mjs` still sets `connection` through `settings.update`; that no longer moves the endpoint. Task 2.6 fixes it,
once there's a call that can, and also makes its Kiln stand-in undo Task 2.3's migration. CI doesn't run e2e, but PR 2
ends with `npm run e2e` green (Task 2.9).

- [ ] **Step 9: Run tests to verify they pass**

Run: `npx vitest run tests/settings.test.ts` then `npm run typecheck && npm run lint && npm run format:check && npm test`
Expected: PASS

- [ ] **Step 10: Commit**

```bash
git add src/shared/endpoints.ts src/shared/types.ts src/main/settings.ts src/main/providers/ollama src/main/chat/service.ts \
  src/main/chat/delegate.ts src/main/usage/account.ts src/renderer/src/stores/app.ts src/renderer/src/views/SettingsView.tsx tests
git commit -m "Settings: endpoints replace the Ollama connection, migrated once onto the endpoint 'ollama'

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 2.3: The database migration and backup

**Files:**
- Modify: `src/main/db/migrations.ts` (a `MODEL_KEYS` entry appended; `MODEL_KEYS_MIGRATION` exported)
- Modify: `src/main/db/index.ts:1-26` (`openDatabase`, `migrate`, the backup)
- Modify: `src/main/index.ts:188` (a failed open stops the app with a dialog)
- Test: `tests/endpointsMigration.test.ts` (new)

**Interfaces:**
- Consumes: `splitModelKey` (2.1, in the test).
- Produces: the `model_profiles.detected` and `usage_events.billing` columns; `MODEL_KEYS_MIGRATION`;
  `endpointsBackupPath(dir, at)`. After this task every stored model name is a key on `ollama`.

- [ ] **Step 1: Write the failing test**

`tests/endpointsMigration.test.ts`:

```ts
import { existsSync, mkdtempSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { splitModelKey } from '@shared/modelKey'
import { all, endpointsBackupPath, openDatabase } from '../src/main/db/index'
import { MIGRATIONS, MODEL_KEYS_MIGRATION } from '../src/main/db/migrations'

const HF = 'hf.co/bartowski/Qwen3-8B-GGUF:Q4_K_M'
const folder = () => mkdtempSync(join(tmpdir(), 'ollmost-endpoints-'))

/** A database as the Ollmost before endpoints left it, with a row of every kind that names a model. */
function oldDatabase(dir: string, name = 'ollmost.db'): string {
  const file = join(dir, name)
  const d = new DatabaseSync(file)
  for (const sql of MIGRATIONS.slice(0, MODEL_KEYS_MIGRATION)) d.exec(sql)
  d.exec(`PRAGMA user_version = ${MODEL_KEYS_MIGRATION}`)
  d.exec(`
    INSERT INTO conversations (id, model, created_at, updated_at) VALUES ('c1', 'llama3.2', 1, 1), ('c2', '${HF}', 1, 1), ('c3', NULL, 1, 1);
    INSERT INTO messages (id, conversation_id, role, model, created_at) VALUES ('m1', 'c1', 'assistant', 'qwen3:8b', 1), ('m2', 'c1', 'user', NULL, 2);
    INSERT INTO usage_events (id, model, kind, cost_usd, created_at) VALUES
      ('u1', 'gpt-oss:120b-cloud', 'chat', 0.002, 1), ('u2', 'llama3.2', 'chat', 0, 1), ('u3', 'glm-5.3:cloud', 'title', NULL, 1),
      ('u4', 'kimi-k3', 'chat', 0.5, 1), ('u5', 'qwen3-coder:480b-cloud', 'chat', 0, 1);
    INSERT INTO traces (id, kind, model, status, started_at, data) VALUES
      ('t1', 'chat', 'llama3.2', 'ok', 1, '{"request":{"model":"llama3.2"}}'), ('t2', 'tool', NULL, 'ok', 1, '{}');
    INSERT INTO model_profiles (model, info, overrides) VALUES ('${HF}', '{"capabilities":["completion"]}', '{"artifacts":false}');
  `)
  d.close()
  return file
}

describe('the model-key migration', () => {
  it('puts every stored model on the ollama endpoint, hf.co names whole (Review Focus #1)', () => {
    openDatabase(oldDatabase(folder()))
    expect(all('SELECT id, model FROM conversations ORDER BY id')).toEqual([
      { id: 'c1', model: 'ollama/llama3.2' },
      { id: 'c2', model: `ollama/${HF}` },
      { id: 'c3', model: null }
    ])
    expect(all('SELECT id, model FROM messages ORDER BY id')).toEqual([
      { id: 'm1', model: 'ollama/qwen3:8b' },
      { id: 'm2', model: null }
    ])
    expect(all('SELECT id, model FROM traces ORDER BY id')).toEqual([
      { id: 't1', model: 'ollama/llama3.2' },
      { id: 't2', model: null }
    ])
    // A trace's request is what was sent, so it keeps the raw name.
    expect(all<{ data: string }>("SELECT data FROM traces WHERE id = 't1'")[0].data).toContain('"model":"llama3.2"')
    expect(all('SELECT model, overrides, detected FROM model_profiles')).toEqual([
      { model: `ollama/${HF}`, overrides: '{"artifacts":false}', detected: '{}' }
    ])
    const c2 = all<{ model: string }>("SELECT model FROM conversations WHERE id = 'c2'")[0]
    expect(splitModelKey(c2.model, ['ollama'])).toEqual({ endpointId: 'ollama', model: HF })
    expect(all('PRAGMA user_version')).toEqual([{ user_version: MIGRATIONS.length }])
  })

  it('marks a usage row priced when it cost something, had no known price, or was a cloud model', () => {
    openDatabase(oldDatabase(folder()))
    expect(all('SELECT id, model, billing FROM usage_events ORDER BY id')).toEqual([
      { id: 'u1', model: 'ollama/gpt-oss:120b-cloud', billing: 'priced' },
      { id: 'u2', model: 'ollama/llama3.2', billing: 'local' },
      { id: 'u3', model: 'ollama/glm-5.3:cloud', billing: 'priced' },
      { id: 'u4', model: 'ollama/kimi-k3', billing: 'priced' },
      { id: 'u5', model: 'ollama/qwen3-coder:480b-cloud', billing: 'priced' }
    ])
  })

  it('backs the database up first, as the older Ollmost left it, once a day', () => {
    const dir = folder()
    const file = oldDatabase(dir)
    openDatabase(file)
    const backup = endpointsBackupPath(join(dir, 'backups'), new Date())
    expect(existsSync(backup)).toBe(true)
    const copy = new DatabaseSync(backup)
    expect(copy.prepare('PRAGMA user_version').get()).toEqual({ user_version: MODEL_KEYS_MIGRATION })
    expect(copy.prepare("SELECT model FROM conversations WHERE id = 'c2'").get()).toEqual({ model: HF })
    copy.close()
    // Opening the migrated database again doesn't touch it, and nor does another old one the same day.
    const made = statSync(backup).mtimeMs
    openDatabase(file)
    openDatabase(oldDatabase(dir, 'other.db'))
    expect(statSync(backup).mtimeMs).toBe(made)
  })

  it('makes no backup of a new database', () => {
    const dir = folder()
    openDatabase(join(dir, 'ollmost.db'))
    expect(existsSync(join(dir, 'backups'))).toBe(false)
  })

  it('names the backup by the local day', () => {
    expect(endpointsBackupPath('/b', new Date(2026, 8, 7, 23, 30))).toBe('/b/ollmost-before-endpoints-2026-09-07.db')
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/endpointsMigration.test.ts`
Expected: FAIL. `MODEL_KEYS_MIGRATION` is undefined, so `PRAGMA user_version = undefined` fails with
`near "undefined": syntax error`, and `endpointsBackupPath is not a function`.

- [ ] **Step 3: Append the migration entry**

In `src/main/db/migrations.ts`, add above `export const MIGRATIONS`:

```ts
/**
 * Model names become keys, "<endpoint id>/<name>" (model endpoints). Every name so far is on the Ollama endpoint the
 * settings migration makes, `ollama` (settings.ts, migrateSettings). It can't be undone by an older Ollmost, so
 * db/index.ts backs the database up before it runs.
 */
const MODEL_KEYS = /* sql */ `
  UPDATE conversations  SET model = 'ollama/' || model WHERE model IS NOT NULL;
  UPDATE messages       SET model = 'ollama/' || model WHERE model IS NOT NULL;
  UPDATE usage_events   SET model = 'ollama/' || model;
  UPDATE traces         SET model = 'ollama/' || model WHERE model IS NOT NULL;
  UPDATE model_profiles SET model = 'ollama/' || model;
  -- What Ollmost learned about a model (a server that refused tools, a context size from an error), kept apart from
  -- the user's overrides so the daily info refresh never wipes it.
  ALTER TABLE model_profiles ADD COLUMN detected TEXT NOT NULL DEFAULT '{}';
  -- Whether a row could be priced. Ollama cloud rows were; the rest ran locally, which a zero cost used to stand for.
  ALTER TABLE usage_events ADD COLUMN billing TEXT NOT NULL DEFAULT 'local';
  UPDATE usage_events SET billing = 'priced'
    WHERE cost_usd IS NULL OR cost_usd > 0 OR model LIKE '%-cloud' OR model LIKE '%:cloud';
  `
```

Append `MODEL_KEYS` as the array's last element (after the `project_files.folder` entry, with a comma after that
entry's closing backtick), and add after the array:

```ts
/** The model-key entry's place: the database is backed up before it runs. */
export const MODEL_KEYS_MIGRATION = MIGRATIONS.indexOf(MODEL_KEYS)
```

- [ ] **Step 4: Back up before it runs**

`src/main/db/index.ts`, lines 1–26 become:

```ts
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { MIGRATIONS, MODEL_KEYS_MIGRATION } from './migrations'

let db: DatabaseSync | null = null

export function openDatabase(file: string): DatabaseSync {
  db = new DatabaseSync(file)
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 3000;')
  migrate(db, file === ':memory:' ? null : join(dirname(file), 'backups'))
  return db
}

export function getDb(): DatabaseSync {
  if (!db) throw new Error('Database not opened')
  return db
}

/** Where the copy made before the model-key migration goes: <userData>/backups, one a day at most. */
export function endpointsBackupPath(dir: string, at: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return join(dir, `ollmost-before-endpoints-${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}.db`)
}

function migrate(d: DatabaseSync, backups: string | null): void {
  const current = (d.prepare('PRAGMA user_version').get() as { user_version: number }).user_version
  // The model-key entry is one-way (an older Ollmost can't read keys), so the database is copied as it is first. A new
  // one has nothing to copy. VACUUM INTO can't run inside a transaction, so it goes before any of them.
  if (backups && current > 0 && current <= MODEL_KEYS_MIGRATION) backUp(d, endpointsBackupPath(backups, new Date()))
  for (let v = current; v < MIGRATIONS.length; v++) {
    transaction(() => {
      d.exec(MIGRATIONS[v])
      d.exec(`PRAGMA user_version = ${v + 1}`)
    }, d)
  }
}

function backUp(d: DatabaseSync, file: string): void {
  if (existsSync(file)) return
  try {
    mkdirSync(dirname(file), { recursive: true })
    d.prepare('VACUUM INTO ?').run(file)
  } catch (err) {
    // A half-written copy would pass for a backup tomorrow.
    rmSync(file, { force: true })
    throw new Error(`Ollmost couldn't back up its database before updating it, so it left it as it was: ${(err as Error).message}`)
  }
}
```

- [ ] **Step 5: Stop the app when the database can't be opened**

`src/main/index.ts:188`, `openDatabase(paths.db)` becomes:

```ts
  try {
    openDatabase(paths.db)
  } catch (err) {
    // Nothing may run on a database that failed to open or update, such as a backup that couldn't be written.
    dialog.showErrorBox("Ollmost couldn't open its database", `${errorMessage(err)}\n\nYour data is in ${paths.data}.`)
    return app.exit(1)
  }
```

(`dialog`, `app` and `errorMessage` are already imported there; the rename-failure path above uses them.)

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx vitest run tests/endpointsMigration.test.ts` then `npm run typecheck && npm run lint && npm run format:check && npm test`
Expected: PASS. `tests/db.test.ts` and `tests/service.test.ts` open `:memory:` databases, which run the new entry on
empty tables and make no backup.

- [ ] **Step 7: Commit**

```bash
git add src/main/db/migrations.ts src/main/db/index.ts src/main/index.ts tests/endpointsMigration.test.ts
git commit -m "Migrate stored model names to keys on 'ollama', backing the database up first

The entry is one-way, so the database is copied with VACUUM INTO to backups/ollmost-before-endpoints-<day>.db
before it runs. usage_events gains billing, backfilled from the cost; model_profiles gains detected.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 2.4: Registry over several endpoints; the `ModelInfo` split; `model_profiles` by key

**Files:**
- Create: `src/main/providers/where.ts`, `src/main/providers/context.ts`
- Modify: `src/shared/types.ts` (`ModelOverrides`, `ModelInfo`, `ModelListResult`, ~264–301)
- Modify: `src/main/providers/types.ts` (`Provider` gains `endpoint`)
- Modify: `src/main/db/kv.ts:22-58` (profiles by key, `detected`, `deleteEndpointProfiles`)
- Modify: `src/main/providers/ollama/wire.ts` (every request takes an `OllamaTarget`; `connectionMode` goes)
- Modify: `src/main/usage/pricing.ts:68-70` (`isBilled` reads the bridge until Task 2.5)
- Modify: `src/main/providers/ollama/models.ts` (whole file)
- Modify: `src/main/providers/ollama/adapter.ts` (`ollamaTarget`, `ollamaOptions`, `ollamaTimeouts`, the class)
- Modify: `src/main/providers/registry.ts` (whole file)
- Modify: `src/main/ipc.ts` (`models` handlers; `debug.target`)
- Modify: `src/main/chat/service.ts`, `src/main/chat/delegate.ts` (context window from `ModelInfo`)
- Delete: `src/shared/context.ts`
- Modify: `src/renderer/src/stores/app.ts`, `src/renderer/src/components/ModelPicker.tsx`, `src/renderer/src/components/UsageBar.tsx:321`,
  `src/renderer/src/views/ProjectView.tsx:50`, `src/renderer/src/views/SettingsView.tsx` (ModelRow, ModelsTab), `src/shared/paletteChoices.ts:25-26`
- Test: `tests/registry.test.ts` (PR 1's, rewritten: its four cases live on below in per-endpoint form);
  `tests/client.test.ts`, `tests/ollamaAdapter.test.ts` (PR 1's), `tests/assemble.test.ts:168-187` (`describe('effectiveContext')`), `tests/paletteChoices.test.ts:11-14`

**Interfaces:**
- Consumes: `toModelKey`, `splitModelKey`, `keyPrefix` (2.1); `Endpoint`, `ModelWhere`, `ModelBilling`, `whereOf`,
  `isOllamaCloudUrl`, `DEFAULT_NUM_CTX`, `DEFAULT_CONTEXT`, `setEndpoints` (2.2); the `detected` column (2.3); PR 1's
  `toOllamaBody`, `ollamaEvents`, `resultFromOllama`, `ollamaTimeouts`, `OllamaProvider`, `getSecret`,
  `endpointSecretName`, `OLLAMA_ACCOUNT_SECRET`.
- Produces: `ModelInfo` with `key`, `endpoint`, `where`, `billing`, `contextControl`, `contextWindow`, `detected` (no
  `location`); `ModelDetected`; `ModelOverrides.vision/tools/contextLength`;
  `ModelListResult = { models; errors: Array<{ endpointId; message }> }`; `billingOf`, `whereOf` (re-export) from
  `providers/where.ts`; `contextWindowFor(m, endpoint)`; `readModelProfile(key)` with `detected`, `writeModelDetected`,
  `deleteEndpointProfiles`; `OllamaTarget`, `listCloudCatalog`, `streamTimeoutsFor(where)`; `ollamaWhere`,
  `listOllamaModels`, `getModelInfo(endpoint, t, name, refresh)`; `ollamaTarget`, `ollamaOptions`,
  `toOllamaBody(req, clientContext)`, `ollamaTimeouts(endpoint, model)`, `new OllamaProvider(endpoint)`;
  `resolve(key) → { provider, endpoint, model }`, `EndpointGoneError`, `modelInfo`, `listAllModels`, `invalidateProviders`.

- [ ] **Step 1: Write the failing test**

Replace `tests/registry.test.ts` with:

```ts
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Endpoint } from '@shared/types'
import { type MockOllama, startMockOllama } from './ollamaMock'

vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (s: string) => Buffer.from(`enc:${s}`),
    decryptString: (b: Buffer) => b.toString().replace(/^enc:/, '')
  },
  shell: {},
  app: { getPath: () => '' }
}))

const { openDatabase } = await import('../src/main/db/index')
const { deleteEndpointProfiles, readModelProfile, writeModelOverrides } = await import('../src/main/db/kv')
const { setApiKey, setEndpoints } = await import('../src/main/settings')
const { endpointSecretName, setSecret } = await import('../src/main/providers/secrets')
const registry = await import('../src/main/providers/registry')
const { ollamaTarget } = await import('../src/main/providers/ollama/adapter')
const { contextWindowFor } = await import('../src/main/providers/context')
const { billingOf } = await import('../src/main/providers/where')

const HF = 'hf.co/bartowski/Qwen3-8B-GGUF:Q4_K_M'

/** An Ollama that lists `names`: an 8K window each, 128K for a cloud name. */
function serve(mock: MockOllama, names: string[]): void {
  mock.handler = (req, res) => {
    if (req.url === '/api/tags') return void res.writeHead(200).end(JSON.stringify({ models: names.map((name) => ({ name })) }))
    if (req.url === '/api/show') {
      const cloud = /(:|-)cloud$/.test(String(req.json.model))
      return void res
        .writeHead(200)
        .end(JSON.stringify({ capabilities: ['completion', 'tools'], model_info: { 'x.context_length': cloud ? 131072 : 8192 } }))
    }
    res.writeHead(404).end()
  }
}

/** An address nothing listens on: a port that was just given back. */
async function refusedUrl(): Promise<string> {
  const server = createServer()
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  await new Promise<void>((resolve) => server.close(() => resolve()))
  return `http://127.0.0.1:${port}`
}

const ollama = (id: string, name: string, baseUrl: string, over: Partial<Endpoint> = {}) => ({
  id,
  name,
  kind: 'ollama' as const,
  flavor: 'ollama' as const,
  baseUrl,
  enabled: true,
  showCloudCatalog: false,
  numCtx: 32768,
  ...over
})

let a: MockOllama
let b: MockOllama
let down: string
beforeAll(async () => {
  openDatabase(':memory:')
  a = await startMockOllama()
  b = await startMockOllama()
  down = await refusedUrl()
})
afterAll(async () => {
  await a.close()
  await b.close()
})
beforeEach(() => {
  serve(a, ['llama3.2', 'qwen3:8b', 'gpt-oss:120b-cloud'])
  serve(b, ['qwen3:8b'])
  setEndpoints([
    ollama('ollama', 'Ollama', a.url),
    ollama('gpu', 'GPU box', b.url),
    ollama('down', 'Down box', down),
    ollama('off', 'Off box', b.url, { enabled: false })
  ])
  registry.invalidateProviders()
})

describe('listing every endpoint', () => {
  it('lists the endpoints that answer and says which one didn’t (Review Focus #2)', async () => {
    const { models, errors } = await registry.listAllModels(true)
    // The same name on two endpoints is two models; a turned-off endpoint isn't asked.
    expect(models.map((m) => m.key)).toEqual(['ollama/gpt-oss:120b-cloud', 'ollama/llama3.2', 'ollama/qwen3:8b', 'gpu/qwen3:8b'])
    expect(errors).toEqual([{ endpointId: 'down', message: expect.stringMatching(/^Can't reach Down box at http:\/\/127\.0\.0\.1:\d+/) }])
  })

  it('says where each model runs, how it’s billed, and the window it gets', async () => {
    const { models } = await registry.listAllModels(true)
    const byKey = Object.fromEntries(models.map((m) => [m.key, m]))
    expect(byKey['ollama/llama3.2']).toMatchObject({
      name: 'llama3.2',
      endpoint: { id: 'ollama', name: 'Ollama', kind: 'ollama', flavor: 'ollama' },
      where: 'this-mac',
      billing: 'local',
      contextControl: 'client',
      contextLength: 8192,
      contextWindow: 8192,
      detected: {},
      price: null
    })
    expect(byKey['ollama/llama3.2']).not.toHaveProperty('location')
    expect(byKey['ollama/gpt-oss:120b-cloud']).toMatchObject({
      where: 'cloud',
      billing: 'priced',
      contextControl: 'server',
      contextWindow: 131072,
      price: { input: 0.15, output: 0.6 }
    })
  })

  it('caches model info by key, so a name on two endpoints never shares a row', async () => {
    await registry.listAllModels(true)
    expect(readModelProfile('ollama/qwen3:8b').info).not.toBeNull()
    expect(readModelProfile('gpu/qwen3:8b').info).not.toBeNull()
    expect(readModelProfile('qwen3:8b').info).toBeNull()
    writeModelOverrides('gpu-2/qwen3:8b', { artifacts: false })
    expect(deleteEndpointProfiles('gpu')).toBe(1)
    expect(readModelProfile('gpu/qwen3:8b').info).toBeNull()
    expect(readModelProfile('gpu-2/qwen3:8b').overrides).toEqual({ artifacts: false })
    expect(readModelProfile('ollama/qwen3:8b').info).not.toBeNull()
  })
})

describe('resolving a key', () => {
  it('splits on the first slash and keeps an hf.co name whole (Review Focus #1)', () => {
    const r = registry.resolve(`ollama/${HF}`)
    expect([r.provider.id, r.endpoint.id, r.model]).toEqual(['ollama', 'ollama', HF])
    expect(registry.resolve('gpu/qwen3:8b')).toMatchObject({ endpoint: { id: 'gpu' }, model: 'qwen3:8b' })
  })

  it('reads a bare name from before keys as Ollama’s, whole', () => {
    expect(registry.resolve('llama3.2')).toMatchObject({ endpoint: { id: 'ollama' }, model: 'llama3.2' })
    expect(registry.resolve(HF)).toMatchObject({ endpoint: { id: 'ollama' }, model: HF })
  })

  it('refuses a removed endpoint and a turned-off one', () => {
    expect(() => registry.resolve('lm-studio/qwen/qwen3-8b')).toThrow(registry.EndpointGoneError)
    expect(() => registry.resolve('off/qwen3:8b')).toThrow(/Off box is turned off/)
    setEndpoints([ollama('gpu', 'GPU box', b.url)])
    registry.invalidateProviders()
    // With `ollama` removed, a bare name has nowhere to go.
    expect(() => registry.resolve('llama3.2')).toThrow(registry.EndpointGoneError)
  })

  it('asks the key’s own endpoint about its model', async () => {
    const info = await registry.modelInfo('gpu/qwen3:8b', true)
    expect(info).toMatchObject({ key: 'gpu/qwen3:8b', endpoint: { name: 'GPU box' }, installed: true })
    expect(b.requests.at(-1)).toEqual({ model: 'qwen3:8b' })
  })
})

describe('which key goes where', () => {
  it('sends ollama.com the account key and every other server only its own', () => {
    setApiKey('account-key')
    setSecret(endpointSecretName('gpu'), 'gpu-key')
    try {
      expect(ollamaTarget({ id: 'cloud', name: 'Ollama cloud', baseUrl: 'https://ollama.com' })).toMatchObject({
        cloud: true,
        headers: { Authorization: 'Bearer account-key' }
      })
      expect(ollamaTarget({ id: 'gpu', name: 'GPU box', baseUrl: `${b.url}/` })).toEqual({
        base: b.url,
        name: 'GPU box',
        cloud: false,
        keyed: true,
        headers: { Authorization: 'Bearer gpu-key' }
      })
      expect(ollamaTarget({ id: 'ollama', name: 'Ollama', baseUrl: a.url }).headers).toEqual({})
    } finally {
      setApiKey(null)
      setSecret(endpointSecretName('gpu'), null)
    }
  })
})

describe('billing and context windows', () => {
  it('bills Ollama’s cloud models and nothing else', () => {
    expect(billingOf('cloud')).toBe('priced')
    expect(billingOf('this-mac')).toBe('local')
    expect(billingOf('network')).toBe('untracked')
  })

  it('caps a window Ollmost sets at the endpoint’s num_ctx', () => {
    const m = (contextLength: number | null) => ({ contextControl: 'client' as const, contextLength, overrides: {}, detected: {} })
    expect(contextWindowFor(m(131_072), { kind: 'ollama', numCtx: 32_768 })).toBe(32_768)
    expect(contextWindowFor(m(8_192), { kind: 'ollama', numCtx: 32_768 })).toBe(8_192)
    expect(contextWindowFor(m(null), { kind: 'ollama', numCtx: 32_768 })).toBe(32_768)
    expect(contextWindowFor(m(null), { kind: 'ollama' })).toBe(32_768)
  })

  it('takes a window the server sets by precedence: override, detected, reported, the endpoint’s default', () => {
    const m = (over: object) => ({ contextControl: 'server' as const, contextLength: 262_144, overrides: {}, detected: {}, ...over })
    expect(contextWindowFor(m({}), { kind: 'ollama' })).toBe(262_144)
    expect(contextWindowFor(m({ contextLength: null }), { kind: 'ollama' })).toBeNull()
    expect(contextWindowFor(m({ contextLength: null }), { kind: 'openai', defaultContext: 16_384 })).toBe(16_384)
    expect(contextWindowFor(m({ contextLength: null }), { kind: 'openai' })).toBe(8_192)
    expect(contextWindowFor(m({ detected: { contextLength: 40_960 } }), { kind: 'openai' })).toBe(40_960)
    expect(contextWindowFor(m({ detected: { contextLength: 40_960 }, overrides: { contextLength: 32_768 } }), { kind: 'openai' })).toBe(32_768)
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/registry.test.ts`
Expected: FAIL. The suite can't load `../src/main/providers/context` ("Does the file exist?").

- [ ] **Step 3: Split `ModelInfo` in `src/shared/types.ts`**

Add `import type { ModelKey } from './modelKey'` at the top of the file. Replace `ModelOverrides`, `ModelInfo` and
`ModelListResult` with:

```ts
export interface ModelOverrides {
  think?: ThinkProfile['kind']
  artifacts?: boolean
  autoSkills?: boolean
  /** Set in Settings → Models (PR 3's columns); unset means Auto. */
  vision?: boolean
  tools?: boolean
  contextLength?: number
}

/** What Ollmost learned from a server's errors, kept apart from the user's overrides. "Re-detect" clears it. */
export interface ModelDetected {
  tools?: false
  contextLength?: number
  reason?: string
}
```

```ts
export interface ModelInfo {
  /** "<endpoint id>/<name>": what chats, settings and every lookup use. */
  key: ModelKey
  /** The model's id at its server: what requests send. */
  name: string
  endpoint: { id: string; name: string; kind: EndpointKind; flavor: EndpointFlavor }
  where: ModelWhere
  billing: ModelBilling
  /** 'client': Ollmost sends the window (Ollama's num_ctx). 'server': the server fixed it when it loaded the model. */
  contextControl: 'client' | 'server'
  /** The window this model's requests get. History trimming, the meter and num_ctx all use this one number. */
  contextWindow: number | null
  installed: boolean
  capabilities: string[]
  contextLength: number | null
  family: string | null
  parameterSize: string | null
  overrides: ModelOverrides
  detected: ModelDetected
  /** Published price for a priced model, when known. */
  price: ModelPrice | null
}

export interface ModelListResult {
  models: ModelInfo[]
  /** Endpoints that couldn't list their models this time, and why. The others still list. */
  errors: Array<{ endpointId: string; message: string }>
}
```

Move the Endpoints block Task 2.2 added above `ModelOverrides`, so the types read in order.

- [ ] **Step 4: `where.ts` and `context.ts`**

`src/main/providers/where.ts`:

```ts
import type { ModelBilling, ModelWhere } from '@shared/types'

// whereOf is shared (the renderer needs it for an offline endpoint's section); main imports it from here.
export { whereOf } from '@shared/endpoints'

/** Whether Ollmost can price a model's requests. Only Ollama's cloud models have published rates. */
export function billingOf(where: ModelWhere): ModelBilling {
  return where === 'cloud' ? 'priced' : where === 'this-mac' ? 'local' : 'untracked'
}
```

`src/main/providers/context.ts`:

```ts
import { DEFAULT_CONTEXT, DEFAULT_NUM_CTX } from '@shared/endpoints'
import type { Endpoint, ModelDetected, ModelInfo, ModelOverrides } from '@shared/types'

/**
 * The window a model's requests get. 'client': Ollmost sets it (Ollama's num_ctx), capped at the endpoint's setting.
 * 'server': the server fixed it when it loaded the model, so the best guess wins: the user's override, then what
 * Ollmost detected, then what the server reported, then the endpoint's default (OpenAI-compatible servers only).
 */
export function contextWindowFor(
  m: { contextControl: ModelInfo['contextControl']; contextLength: number | null; overrides: ModelOverrides; detected: ModelDetected },
  endpoint: Pick<Endpoint, 'kind' | 'numCtx' | 'defaultContext'>
): number | null {
  if (m.contextControl === 'client') {
    const numCtx = endpoint.numCtx ?? DEFAULT_NUM_CTX
    return Math.min(m.contextLength ?? numCtx, numCtx)
  }
  const fallback = endpoint.kind === 'openai' ? (endpoint.defaultContext ?? DEFAULT_CONTEXT) : null
  return m.overrides.contextLength ?? m.detected.contextLength ?? m.contextLength ?? fallback
}
```

- [ ] **Step 5: `model_profiles` by key, in `src/main/db/kv.ts`**

Replace lines 22–58 (from `export interface CachedModelInfo` through `writeModelOverrides`) with:

```ts
export interface CachedModelInfo {
  capabilities: string[]
  contextLength: number | null
  family: string | null
  parameterSize: string | null
}

// Profiles are keyed by model key (endpointId/model), so the same name on two endpoints never shares a row.

export function readModelProfile(key: string): {
  info: CachedModelInfo | null
  fetchedAt: number
  overrides: ModelOverrides
  detected: ModelDetected
} {
  const row = get<{ info: string | null; fetched_at: number | null; overrides: string; detected: string }>(
    'SELECT info, fetched_at, overrides, detected FROM model_profiles WHERE model = ?',
    key
  )
  return {
    info: parseJson<CachedModelInfo | null>(row?.info, null),
    fetchedAt: row?.fetched_at ?? 0,
    overrides: parseJson<ModelOverrides>(row?.overrides, {}),
    detected: parseJson<ModelDetected>(row?.detected, {})
  }
}

export function writeModelInfo(key: string, info: CachedModelInfo): void {
  run(
    `INSERT INTO model_profiles (model, info, fetched_at) VALUES (?, ?, ?)
     ON CONFLICT(model) DO UPDATE SET info = excluded.info, fetched_at = excluded.fetched_at`,
    key,
    JSON.stringify(info),
    Date.now()
  )
}

export function writeModelOverrides(key: string, overrides: ModelOverrides): void {
  run(
    `INSERT INTO model_profiles (model, overrides) VALUES (?, ?)
     ON CONFLICT(model) DO UPDATE SET overrides = excluded.overrides`,
    key,
    JSON.stringify(overrides)
  )
}

export function writeModelDetected(key: string, detected: ModelDetected): void {
  run(
    `INSERT INTO model_profiles (model, detected) VALUES (?, ?)
     ON CONFLICT(model) DO UPDATE SET detected = excluded.detected`,
    key,
    JSON.stringify(detected)
  )
}

/** Forget an endpoint's models: what was learned and what the user set. Ids are [a-z0-9-], so 'gpu/%' never matches 'gpu-2/…'. */
export function deleteEndpointProfiles(endpointId: string): number {
  return Number(getDb().prepare('DELETE FROM model_profiles WHERE model LIKE ?').run(`${endpointId}/%`).changes)
}
```

The imports become `import type { ModelDetected, ModelOverrides, ThemeDef } from '@shared/types'` and
`import { all, get, getDb, run } from './index'`.

- [ ] **Step 6: Give every wire request a target**

In `src/main/providers/ollama/wire.ts`:

1. The imports and `OLLAMA_CLOUD` become:

   ```ts
   import { OLLAMA_CLOUD_URL } from '@shared/endpoints'
   import type { ModelWhere } from '@shared/types'
   import type { ToolDef } from '../types'

   export const OLLAMA_CLOUD = OLLAMA_CLOUD_URL

   /** One Ollama server, as a request sees it. adapter.ts's ollamaTarget() makes one from an endpoint. */
   export interface OllamaTarget {
     /** The server's root, without a trailing slash. */
     base: string
     /** The endpoint's name, for errors ("Can't reach GPU box at …"). */
     name: string
     /** The one key this server may be sent, as a header; empty when there's none. */
     headers: Record<string, string>
     /** The server is ollama.com itself. */
     cloud: boolean
     /** A key of the endpoint's own is sent (an Ollama behind a proxy that checks one). */
     keyed: boolean
   }

   // ollama.com's public catalog. No key goes with it: an endpoint's key must never reach ollama.com.
   const CATALOG: OllamaTarget = { base: OLLAMA_CLOUD, name: 'ollama.com', headers: {}, cloud: true, keyed: false }
   ```

2. Delete `target()`. `NOT_ENOUGH_MEMORY_RE` and `notEnoughMemory()` (4b69183) stay as they are, just above
   `friendly()`. `friendly()` and `request()` become:

   ```ts
   function friendly(t: OllamaTarget, status: number, body: string, model?: string): OllamaError {
     let detail = body
     try {
       detail = (JSON.parse(body) as { error?: string }).error ?? body
     } catch {
       /* not JSON */
     }
     if (status === 401 || status === 403)
       return new OllamaError(
         t.cloud
           ? 'Ollama cloud rejected the API key. Check it in Settings → Models → ollama.com account.'
           : t.keyed
             ? `${t.name} rejected the API key. Check it in Settings → Models → ${t.name}.`
             : 'Ollama cloud needs you to sign in. Run `ollama signin` in a terminal, then retry.',
         status
       )
     if (status === 429) return new OllamaError('Ollama cloud usage limit reached. Try again later, or switch to a local model.', status)
     if (status === 404 && /not found/i.test(detail))
       return new OllamaError(model ? `Model “${model}” was not found by ${t.name}.` : detail, status)
     // 4b69183: Ollama's "model requires more system memory" in plain English, naming the model.
     return new OllamaError(notEnoughMemory(detail, model) ?? (detail || `${t.name} returned HTTP ${status}`), status)
   }

   // Short calls (model lists, /api/show) should never hang the UI on a wedged daemon.
   const METADATA_TIMEOUT_MS = 30_000

   async function request(t: OllamaTarget, path: string, init: RequestInit & { model?: string } = {}): Promise<Response> {
     let res: Response
     try {
       res = await fetch(`${t.base}${path}`, {
         ...init,
         signal: init.signal ?? AbortSignal.timeout(METADATA_TIMEOUT_MS),
         headers: { 'Content-Type': 'application/json', ...t.headers, ...(init.headers as Record<string, string>) }
       })
     } catch (err) {
       if ((err as Error).name === 'AbortError') throw err
       if ((err as Error).name === 'TimeoutError') throw new OllamaError(`${t.name} took too long to respond. Try again in a moment.`)
       throw new OllamaError(
         t.cloud ? `Can't reach ${OLLAMA_CLOUD}. Check your internet connection.` : `Can't reach ${t.name} at ${t.base}. Is the Ollama app running?`
       )
     }
     if (!res.ok) throw friendly(t, res.status, await res.text().catch(() => ''), init.model)
     return res
   }
   ```

3. `streamTimeoutsFor` becomes:

   ```ts
   /**
    * The long tool-call allowance is for models that run on a machine: a cloud model finishes a tool call's arguments in
    * seconds, so a long silence there is always a dead connection.
    */
   export function streamTimeoutsFor(where: ModelWhere): StreamTimeouts {
     return where === 'cloud' ? { ...STREAM_TIMEOUTS, toolIdleMs: STREAM_TIMEOUTS.idleMs } : STREAM_TIMEOUTS
   }
   ```

4. In `chatStream`, the signature becomes
   `export async function* chatStream(t: OllamaTarget, body: ChatBody, signal: AbortSignal, timeouts: StreamTimeouts = STREAM_TIMEOUTS): AsyncGenerator<ChatChunk>`,
   the request becomes `request(t, '/api/chat', { … })`, and its four messages name the endpoint:
   `` `${t.name} didn't start replying within …` ``, `` `${t.name} returned an empty response` ``,
   `` `${t.name} stopped responding in the middle of the reply …` `` and
   `` `The connection to ${t.name} dropped before the reply finished.` ``. The two in-stream `chunk.error` throws keep
   `notEnoughMemory(chunk.error, body.model) ?? chunk.error` exactly as they are: `tests/client.test.ts`'s two
   not-enough-memory tests must still pass.

5. The rest become:

   ```ts
   export async function chatOnce(t: OllamaTarget, body: ChatBody, opts: { signal?: AbortSignal; timeoutMs: number }): Promise<ChatChunk> {
     const timeout = AbortSignal.timeout(opts.timeoutMs)
     const res = await request(t, '/api/chat', {
       method: 'POST',
       body: JSON.stringify({ ...body, stream: false }),
       signal: opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout,
       model: body.model
     })
     return (await res.json()) as ChatChunk
   }

   export async function listTags(t: OllamaTarget): Promise<TagModel[]> {
     const res = await request(t, '/api/tags')
     return ((await res.json()) as { models?: TagModel[] }).models ?? []
   }

   /** ollama.com's cloud catalog, read with no key. */
   export const listCloudCatalog = (): Promise<TagModel[]> => listTags(CATALOG)

   export async function showModel(t: OllamaTarget, model: string): Promise<ShowResponse> {
     const res = await request(t, '/api/show', { method: 'POST', body: JSON.stringify({ model }), model })
     return (await res.json()) as ShowResponse
   }

   /** Full URL for an Ollama API path on this target (never includes credentials). */
   export function endpointFor(t: OllamaTarget, path: string): string {
     return `${t.base}${path}`
   }
   ```

6. Delete `connectionMode()`. The wire no longer imports settings at all, which keeps Electron out of
   `tests/client.test.ts` (the `electron` package throws on import without its binary, as on CI).

PR 1 moved `chatOnce` unchanged (it adds `stream: false` itself); the code above is it with the `t` parameter added.

`src/main/usage/pricing.ts` was `connectionMode()`'s last reader. Until Task 2.5 rewrites `requestCost`, `isBilled`
reads the bridge directly:

```ts
export function isBilled(model: string): boolean {
  return ollamaConnection().mode === 'direct' || isCloudName(model)
}
```

with `import { isCloudName } from '../providers/ollama/wire'` and `import { ollamaConnection } from '../settings'`.

- [ ] **Step 7: Rewrite `src/main/providers/ollama/models.ts`**

```ts
import { isOllamaCloudUrl } from '@shared/endpoints'
import { toModelKey } from '@shared/modelKey'
import type { Endpoint, ModelInfo, ModelWhere } from '@shared/types'
import { type CachedModelInfo, readModelProfile, writeModelInfo } from '../../db/kv'
import { modelPrice } from '../../usage/pricing'
import { contextWindowFor } from '../context'
import { billingOf, whereOf } from '../where'
import { isCloudName, listCloudCatalog, listTags, type OllamaTarget, showModel } from './wire'

const INFO_TTL = 24 * 60 * 60 * 1000
const CATALOG_TTL = 60 * 60 * 1000

// ollama.com's catalog is the same for every endpoint, so one cache serves them all.
let catalogCache: { at: number; names: string[] } | null = null

/**
 * Through the local daemon, a cloud catalog model "glm-5.3" is addressed as "glm-5.3:cloud"
 * and "gpt-oss:120b" as "gpt-oss:120b-cloud" — no pull needed.
 */
export function toDaemonCloudName(catalogName: string): string {
  return catalogName.includes(':') ? `${catalogName}-cloud` : `${catalogName}:cloud`
}

export { isCloudName }

async function cloudCatalog(refresh: boolean): Promise<string[]> {
  if (!refresh && catalogCache && Date.now() - catalogCache.at < CATALOG_TTL) return catalogCache.names
  const names = (await listCloudCatalog()).map((m) => m.name)
  catalogCache = { at: Date.now(), names }
  return names
}

function contextLengthOf(info: Record<string, unknown> | undefined): number | null {
  if (!info) return null
  for (const [k, v] of Object.entries(info)) if (k.endsWith('.context_length') && typeof v === 'number') return v
  return null
}

const UNKNOWN: CachedModelInfo = { capabilities: ['completion'], contextLength: null, family: null, parameterSize: null }

async function fetchInfo(t: OllamaTarget, key: string, name: string, refresh: boolean): Promise<CachedModelInfo> {
  const cached = readModelProfile(key)
  if (!refresh && cached.info && Date.now() - cached.fetchedAt < INFO_TTL) return cached.info
  try {
    const show = await showModel(t, name)
    const info: CachedModelInfo = {
      capabilities: show.capabilities ?? ['completion'],
      contextLength: contextLengthOf(show.model_info),
      family: show.details?.family || null,
      parameterSize: show.details?.parameter_size || null
    }
    writeModelInfo(key, info)
    return info
  } catch (err) {
    if (cached.info) return cached.info
    throw err
  }
}

/** Where an Ollama model runs: everything on ollama.com, and the app's cloud names, in Ollama's cloud; the rest where the server is. */
export function ollamaWhere(endpoint: Pick<Endpoint, 'baseUrl'>, name: string): ModelWhere {
  return isOllamaCloudUrl(endpoint.baseUrl) || isCloudName(name) ? 'cloud' : whereOf(endpoint.baseUrl)
}

function toModelInfo(endpoint: Endpoint, name: string, info: CachedModelInfo, installed: boolean): ModelInfo {
  const key = toModelKey(endpoint.id, name)
  const { overrides, detected } = readModelProfile(key)
  const where = ollamaWhere(endpoint, name)
  const billing = billingOf(where)
  // Ollmost sets num_ctx for the models an Ollama app runs; ollama.com sizes its cloud models itself.
  const contextControl: ModelInfo['contextControl'] = where === 'cloud' ? 'server' : 'client'
  return {
    key,
    name,
    endpoint: { id: endpoint.id, name: endpoint.name, kind: endpoint.kind, flavor: endpoint.flavor },
    where,
    billing,
    contextControl,
    contextWindow: contextWindowFor({ contextControl, contextLength: info.contextLength, overrides, detected }, endpoint),
    installed,
    capabilities: info.capabilities,
    contextLength: info.contextLength,
    family: info.family,
    parameterSize: info.parameterSize,
    overrides,
    detected,
    price: billing === 'priced' ? modelPrice(name) : null
  }
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length)
  let i = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++
      out[idx] = await fn(items[idx])
    }
  })
  await Promise.all(workers)
  return out
}

/**
 * Every chat model an Ollama endpoint offers. Throws when the server can't be reached, so the picker shows it offline:
 * the catalog's cloud names need the Ollama app running too.
 */
export async function listOllamaModels(endpoint: Endpoint, t: OllamaTarget, refresh: boolean): Promise<ModelInfo[]> {
  const names = new Map<string, boolean>() // name -> installed
  if (t.cloud) for (const n of await cloudCatalog(refresh)) names.set(n, true)
  else {
    for (const m of await listTags(t)) names.set(m.name, true)
    if (endpoint.showCloudCatalog) {
      try {
        for (const n of await cloudCatalog(refresh)) {
          const daemonName = toDaemonCloudName(n)
          if (!names.has(daemonName)) names.set(daemonName, false)
        }
      } catch {
        // The catalog is a convenience; installed models still work offline.
      }
    }
  }
  const models = await mapLimit([...names.entries()], 6, async ([name, installed]) => {
    try {
      return toModelInfo(endpoint, name, await fetchInfo(t, toModelKey(endpoint.id, name), name, refresh), installed)
    } catch {
      return installed ? toModelInfo(endpoint, name, UNKNOWN, true) : null
    }
  })
  return (
    models
      .filter((m): m is ModelInfo => !!m)
      // Embedding-only models can't chat.
      .filter((m) => m.capabilities.includes('completion'))
      .sort((x, y) => (x.where === y.where ? x.name.localeCompare(y.name) : x.where === 'cloud' ? -1 : 1))
  )
}

export async function getModelInfo(endpoint: Endpoint, t: OllamaTarget, name: string, refresh = false): Promise<ModelInfo> {
  try {
    return toModelInfo(endpoint, name, await fetchInfo(t, toModelKey(endpoint.id, name), name, refresh), true)
  } catch {
    return toModelInfo(endpoint, name, UNKNOWN, false)
  }
}
```

- [ ] **Step 8: The provider per endpoint, in `src/main/providers/ollama/adapter.ts`**

Keep PR 1's `sentByOllama`, `identify`, `toOllamaMessage`, `ollamaEvents` and `resultFromOllama`. Change the rest:

1. The imports become (PR 1's `connectionMode`, `isCloudName` and `OllamaError` go; its `postChat`/`streamChat`
   aliases stay, so the class's methods never shadow them):

   ```ts
   import { isOllamaCloudUrl } from '@shared/endpoints'
   import { toOllamaThink } from '@shared/thinking'
   import type { Endpoint, ModelInfo, ModelWhere } from '@shared/types'
   import { endpointSecretName, getSecret, OLLAMA_ACCOUNT_SECRET } from '../secrets'
   import type { ChatEvent, ChatImage, ChatMessage, ChatRequest, ChatResult, ChatTiming, IdentifiedToolCall, Provider, ToolCall, WireRequest } from '../types'
   import { getModelInfo, listOllamaModels, ollamaWhere } from './models'
   import {
     type ChatBody,
     type ChatChunk,
     chatOnce as postChat,
     chatStream as streamChat,
     endpointFor,
     type OllamaMessage,
     type OllamaTarget,
     type OllamaToolCall,
     type StreamTimeouts,
     streamTimeoutsFor
   } from './wire'
   ```

2. Delete `runsInCloud` and PR 1's `ollamaTimeouts(model)`, and add:

   ```ts
   /** How a request reaches an endpoint: its root, its name for errors, and the one key it may be sent. */
   export function ollamaTarget(endpoint: Pick<Endpoint, 'id' | 'name' | 'baseUrl'>): OllamaTarget {
     const base = endpoint.baseUrl.replace(/\/+$/, '')
     const cloud = isOllamaCloudUrl(base)
     // ollama.com takes the ollama.com account key; any other server is only ever sent its own.
     const key = getSecret(cloud ? OLLAMA_ACCOUNT_SECRET : endpointSecretName(endpoint.id))
     return { base, name: endpoint.name, cloud, keyed: !cloud && key !== null, headers: key ? { Authorization: `Bearer ${key}` } : {} }
   }

   /**
    * A request's options: the temperature when asked, and num_ctx only where Ollmost sets the window. Every request to
    * a local model carries the same num_ctx, titles included: a different one makes Ollama reload the model.
    */
   export function ollamaOptions(req: Pick<ChatRequest, 'temperature' | 'contextWindow'>, clientContext: boolean): Record<string, number> | undefined {
     const options: Record<string, number> = {}
     if (req.temperature !== undefined) options.temperature = req.temperature
     if (clientContext && req.contextWindow !== null) options.num_ctx = req.contextWindow
     return Object.keys(options).length ? options : undefined
   }

   /** How long a stream may go quiet: see streamTimeoutsFor. */
   export const ollamaTimeouts = (endpoint: Pick<Endpoint, 'baseUrl'>, model: string): StreamTimeouts =>
     streamTimeoutsFor(ollamaWhere(endpoint, model))
   ```

   `ollamaOptions` puts `temperature` before `num_ctx`, as the title's `{ temperature: 0.3, ...contextOptions(…) }` did,
   so bodies keep their bytes.

3. `toOllamaBody` becomes:

   ```ts
   /**
    * The /api/chat body for a request. `clientContext`: Ollmost sets this model's window (a model the Ollama app runs),
    * so the request's window goes as num_ctx. Cloud models manage their own context.
    */
   export function toOllamaBody(req: ChatRequest, clientContext: boolean): ChatBody {
     return {
       model: req.model,
       messages: req.messages.map(toOllamaMessage),
       think: toOllamaThink(req.profile, req.think),
       tools: req.tools,
       options: ollamaOptions(req, clientContext)
     }
   }
   ```

4. The class becomes:

   ```ts
   /** One Ollama endpoint: the Ollama app, another machine's, or ollama.com itself. */
   export class OllamaProvider implements Provider {
     constructor(readonly endpoint: Endpoint) {}

     get id(): string {
       return this.endpoint.id
     }

     // Read per request, so a key saved since applies at once.
     private target(): OllamaTarget {
       return ollamaTarget(this.endpoint)
     }

     private where(model: string): ModelWhere {
       return ollamaWhere(this.endpoint, model)
     }

     private body(req: ChatRequest): ChatBody {
       return toOllamaBody(req, this.where(req.model) !== 'cloud')
     }

     listModels(refresh: boolean): Promise<ModelInfo[]> {
       return listOllamaModels(this.endpoint, this.target(), refresh)
     }

     modelInfo(model: string, refresh = false): Promise<ModelInfo> {
       return getModelInfo(this.endpoint, this.target(), model, refresh)
     }

     async *chatStream(req: ChatRequest, signal: AbortSignal): AsyncGenerator<ChatEvent> {
       yield* ollamaEvents(streamChat(this.target(), this.body(req), signal, ollamaTimeouts(this.endpoint, req.model)))
     }

     async chatOnce(req: ChatRequest, opts: { signal?: AbortSignal; timeoutMs: number }): Promise<ChatResult> {
       return resultFromOllama(await postChat(this.target(), this.body(req), opts))
     }

     wire(req: ChatRequest, stream: boolean): WireRequest {
       return { endpoint: this.wireEndpoint(), body: { ...this.body(req), stream } }
     }

     wireEndpoint(): string {
       return endpointFor(this.target(), '/api/chat')
     }

     async sendWire(body: unknown, opts: { signal?: AbortSignal; timeoutMs: number }): Promise<ChatResult> {
       return resultFromOllama(await postChat(this.target(), body as ChatBody, opts))
     }
   }
   ```

   `listModels` no longer turns an `{ models, error }` into a throw: `listOllamaModels` throws itself when the server
   can't be reached, and an empty list is just empty.

- [ ] **Step 9: `Provider` knows its endpoint**

In `src/main/providers/types.ts`, import `Endpoint` alongside `ModelInfo` from `'@shared/types'`, and in `Provider`
replace `readonly id: string` with:

```ts
  /** The endpoint's id. */
  readonly id: string
  readonly endpoint: Endpoint
```

- [ ] **Step 10: Rewrite `src/main/providers/registry.ts`**

```ts
import { keyPrefix, splitModelKey } from '@shared/modelKey'
import type { Endpoint, ModelInfo, ModelListResult } from '@shared/types'
import { getSettings } from '../settings'
import { errorMessage } from '../util'
import { OllamaProvider } from './ollama/adapter'
import type { Provider } from './types'

/** A key names an endpoint that's been removed: its chats keep their history and need another model picked. */
export class EndpointGoneError extends Error {
  constructor(readonly endpointId: string) {
    super(`This chat's model was on an endpoint that's been removed (${endpointId}). Pick another model.`)
    this.name = 'EndpointGoneError'
  }
}

// One provider per enabled endpoint, made on first use and again after any endpoint change.
let providers: Map<string, Provider> | null = null

function build(): Map<string, Provider> {
  const map = new Map<string, Provider>()
  for (const endpoint of getSettings().endpoints)
    if (endpoint.enabled && endpoint.kind === 'ollama') map.set(endpoint.id, new OllamaProvider(endpoint))
  return map
}

const live = (): Map<string, Provider> => (providers ??= build())

/** An endpoint was added, changed, removed or given a key: providers are made again from the settings. */
export function invalidateProviders(): void {
  providers = null
}

/**
 * Which endpoint a key's model is on, and its name there. The only place in main that takes a key apart: every model
 * call (a reply's rounds, a sub-agent, titles, /compact, replay) comes through here.
 */
export function resolve(key: string): { provider: Provider; endpoint: Endpoint; model: string } {
  const endpoints = getSettings().endpoints
  const ids = endpoints.map((e) => e.id)
  // A prefix shaped like an endpoint id that names none: that endpoint was removed. A bare name from before keys has
  // no such prefix, and is Ollama's.
  const prefix = keyPrefix(key)
  if (prefix !== null && !ids.includes(prefix)) throw new EndpointGoneError(prefix)
  const { endpointId, model } = splitModelKey(key, ids)
  const endpoint = endpoints.find((e) => e.id === endpointId)
  if (!endpoint) throw new EndpointGoneError(endpointId)
  const provider = live().get(endpoint.id)
  if (!provider) throw new Error(`${endpoint.name} is turned off. Turn it on in Settings → Models, or pick another model.`)
  return { provider, endpoint, model }
}

export function modelInfo(key: string, refresh = false): Promise<ModelInfo> {
  const { provider, model } = resolve(key)
  return provider.modelInfo(model, refresh)
}

/** Every enabled endpoint's models, asked in parallel. One that fails adds to `errors`; the others still list. */
export async function listAllModels(refresh = false): Promise<ModelListResult> {
  const list = [...live().values()]
  const settled = await Promise.allSettled(list.map((p) => p.listModels(refresh)))
  const result: ModelListResult = { models: [], errors: [] }
  settled.forEach((r, i) => {
    if (r.status === 'fulfilled') result.models.push(...r.value)
    else result.errors.push({ endpointId: list[i].endpoint.id, message: errorMessage(r.reason) })
  })
  return result
}
```

- [ ] **Step 11: The IPC handlers**

In `src/main/ipc.ts`, the `models` group becomes (import `listAllModels`, `modelInfo`, `resolve` from
`'./providers/registry'`, `writeModelOverrides` from `'./db/kv'` and `toModelKey` from `'@shared/modelKey'`, dropping
PR 1's model imports):

```ts
  models: {
    list: (refresh) => listAllModels(refresh),
    info: (key) => modelInfo(key),
    setOverrides: async (key, overrides) => {
      // Saved under the canonical key, which is what every read uses (a bare name from before keys is Ollama's).
      const { endpoint, model } = resolve(key)
      const canonical = toModelKey(endpoint.id, model)
      writeModelOverrides(canonical, overrides)
      return modelInfo(canonical)
    }
  },
```

and `debug.target` becomes (import `isOllamaCloudUrl` from `'@shared/endpoints'`; drop the wire import):

```ts
    target: async () => {
      // "Copy as curl" for Ollama: the first Ollama endpoint's chat URL, and the ollama.com key when one is on ollama.com.
      const endpoints = getSettings().endpoints.filter((e) => e.enabled && e.kind === 'ollama')
      const first = endpoints[0]
      return {
        chatEndpoint: first ? `${first.baseUrl.replace(/\/+$/, '')}/api/chat` : '',
        needsKey: endpoints.some((e) => isOllamaCloudUrl(e.baseUrl))
      }
    },
```

In `src/shared/ipc.ts`, rename the `models.info` and `models.setOverrides` parameter `name` to `key`.

- [ ] **Step 12: Callers read the window from `ModelInfo`**

Run `grep -rn "effectiveContext\|contextOptions\|@shared/context\|ollamaConnection().numCtx" src tests`. For each hit:

- `src/main/chat/service.ts` and `src/main/chat/delegate.ts`: `effectiveContext(X, ollamaConnection().numCtx)` becomes
  `X.contextWindow` (`X` is `model` or `info`). Drop the `@shared/context` import, and `ollamaConnection` from the
  settings import if nothing else uses it there.
- `src/main/providers/ollama/adapter.ts`: `toOllamaBody` now calls `ollamaOptions` (Step 8), so its `@shared/context`
  import goes.
- Delete `src/shared/context.ts`: `git rm src/shared/context.ts`.
- `tests/assemble.test.ts`: delete the `effectiveContext` import and the first two tests of
  `describe('effectiveContext', …)` (their cases are in `tests/registry.test.ts` now). Rename the describe to
  `'trimming to the window'`, and in its remaining test replace the `window` line with

  ```ts
  const window = contextWindowFor({ contextControl: 'client', contextLength: 131_072, overrides: {}, detected: {} }, { kind: 'ollama', numCtx: 32_768 })
  ```

  importing `contextWindowFor` from `'../src/main/providers/context'`.

- [ ] **Step 13: The renderer reads `where` and `contextWindow`**

- `src/renderer/src/stores/app.ts`: drop the `effectiveContext`, `DEFAULT_NUM_CTX` and `MIGRATED_ENDPOINT_ID` imports;
  `contextWindowFor` becomes

  ```ts
  /** The window a chat with this model actually gets, as main worked it out. */
  export function contextWindowFor(model: ModelInfo | undefined): number | null {
    return model?.contextWindow ?? null
  }
  ```

  and `loadModels`'s first line in `try` becomes

  ```ts
      const { models, errors } = await api.models.list(refresh)
      set({ models, modelsError: errors[0]?.message ?? null })
  ```

  (Task 2.7 keeps every endpoint's error).
- `src/renderer/src/components/UsageBar.tsx:321` and `src/renderer/src/views/ProjectView.tsx:50`:
  `contextWindowFor(model, settings)` → `contextWindowFor(model)`. In `ProjectView`, `settings` was only read there, so
  it leaves the `useApp()` destructuring (line 23).
- `src/renderer/src/components/ModelPicker.tsx`: `m.location === 'cloud'` → `m.where === 'cloud'`,
  `m.location === 'local'` → `m.where !== 'cloud'`, `current?.location === 'cloud'` → `current?.where === 'cloud'`.
- `src/renderer/src/views/SettingsView.tsx`: in `ModelRow`, `model.location === 'cloud'` → `model.where === 'cloud'`
  and `api.models.setOverrides(model.name, …)` → `api.models.setOverrides(model.key, …)`; in `ModelsTab`,
  `m.location === 'cloud'` → `m.where === 'cloud'`, both `x.name === updated.name` → `x.key === updated.key`,
  `key={m.name}` → `key={m.key}` on `ModelRow`, and in `modelSelect` the option's `key={m.name} value={m.name}` →
  `key={m.key} value={m.key}` (the default and title models are keys since Task 2.2).
- `src/shared/paletteChoices.ts:26`: `m.location === 'cloud'` → `m.where === 'cloud'`.
- `tests/paletteChoices.test.ts:11-14`: the fixtures become

  ```ts
  const models = [
    { name: 'gpt-oss:120b-cloud', where: 'cloud' },
    { name: 'gemma4:e4b', where: 'this-mac' }
  ] as ModelInfo[]
  ```

- [ ] **Step 14: Update the wire and adapter tests**

- `tests/client.test.ts`: delete the `conn` hoist and the `vi.mock('../src/main/settings', …)` block; the wire no
  longer reads settings. Add a target and pass it first everywhere:

  ```ts
  const { chatOnce, chatStream, OllamaError, STREAM_TIMEOUTS, streamTimeoutsFor } = await import('../src/main/providers/ollama/wire')
  import type { OllamaTarget } from '../src/main/providers/ollama/wire'

  const t: OllamaTarget = { base: '', name: 'Ollama', headers: {}, cloud: false, keyed: false }
  let ollama: MockOllama
  beforeAll(async () => {
    ollama = await startMockOllama()
    t.base = ollama.url
  })
  ```

  (the type import goes with the file's other imports at the top). Every `chatStream(request, …)` becomes
  `chatStream(t, request, …)` and every `chatOnce(body, …)` becomes `chatOnce(t, body, …)`. The last describe becomes:

  ```ts
  describe('streamTimeoutsFor', () => {
    it('gives only models on a machine the long quiet allowance for tool calls', () => {
      expect(streamTimeoutsFor('this-mac').toolIdleMs).toBe(STREAM_TIMEOUTS.toolIdleMs)
      expect(streamTimeoutsFor('network').toolIdleMs).toBe(STREAM_TIMEOUTS.toolIdleMs)
      expect(streamTimeoutsFor('cloud').toolIdleMs).toBe(STREAM_TIMEOUTS.idleMs)
      expect(STREAM_TIMEOUTS.toolIdleMs).toBeGreaterThan(STREAM_TIMEOUTS.idleMs)
    })
  })

  describe('targets', () => {
    it('sends the target’s key and names it when it can’t be reached', async () => {
      let auth: string | undefined
      ollama.handler = (req, res) => {
        auth = req.headers.authorization
        return streamChunks(res, [line({ done: true })]).then(() => res.end())
      }
      await collectFrom({ ...t, headers: { Authorization: 'Bearer k' }, keyed: true })
      expect(auth).toBe('Bearer k')
      const gone = { ...t, base: 'http://127.0.0.1:9', name: 'GPU box' }
      await expect(chatOnce(gone, body, { timeoutMs: 2_000 })).rejects.toThrow("Can't reach GPU box at http://127.0.0.1:9.")
    })
  })
  ```

  with `collect` generalised so the test can pass a target:

  ```ts
  type Body = Parameters<typeof chatStream>[1]

  async function collectFrom(target: OllamaTarget, signal = new AbortController().signal, timeouts = fast, request: Body = body) {
    const chunks = []
    for await (const c of chatStream(target, request, signal, timeouts)) chunks.push(c)
    return chunks
  }
  const collect = (signal?: AbortSignal, timeouts = fast, request: Body = body) => collectFrom(t, signal, timeouts, request)
  ```

  (Port 9, discard, refuses connections on a Mac and on CI's Linux.)
- `tests/ollamaAdapter.test.ts` (PR 1's). The adapter reads no settings now, only the endpoint it's given and the
  keychain rows (which would need a database). Replace the `conn` hoist and the settings mock with:

  ```ts
  // The adapter reads the keychain for an endpoint's key; these endpoints have none.
  vi.mock('../src/main/providers/secrets', () => ({
    OLLAMA_ACCOUNT_SECRET: 'apiKey',
    endpointSecretName: (id: string) => `endpointKey:${id}`,
    getSecret: () => null
  }))
  ```

  and give the file one endpoint, pointed at the mock once it listens:

  ```ts
  const endpoint: Endpoint = { id: 'ollama', name: 'Ollama', kind: 'ollama', flavor: 'ollama', baseUrl: '', enabled: true, hasKey: false }
  ```

  (`beforeAll` sets `endpoint.baseUrl = ollama.url` in place of `conn.host = …`; the `beforeEach` resetting
  `conn.mode` goes; `Endpoint` is imported from `'@shared/types'`). Then:
  - `new OllamaProvider()` → `new OllamaProvider(endpoint)`;
  - every `toOllamaBody(x)` → `toOllamaBody(x, true)`, except in "leaves the window to cloud models", where the three
    calls pass `false` and the `conn.mode = 'direct'` line goes (an ollama.com endpoint is what `false` stands for);
  - in the timeouts test, `ollamaTimeouts('llama3.2')` → `ollamaTimeouts(endpoint, 'llama3.2')`,
    `ollamaTimeouts('gpt-oss:120b-cloud')` → `ollamaTimeouts(endpoint, 'gpt-oss:120b-cloud')`, and the direct-mode pair
    becomes `expect(ollamaTimeouts({ baseUrl: 'https://ollama.com' }, 'gpt-oss:120b').toolIdleMs).toBe(STREAM_TIMEOUTS.idleMs)`;
  - add `ollamaOptions` to the adapter import and one test:

    ```ts
    it('sends num_ctx only where Ollmost sets the window, after the temperature', () => {
      expect(ollamaOptions({ temperature: 0.3, contextWindow: 8192 }, true)).toEqual({ temperature: 0.3, num_ctx: 8192 })
      expect(bytes(ollamaOptions({ temperature: 0.3, contextWindow: 8192 }, true))).toBe('{"temperature":0.3,"num_ctx":8192}')
      expect(ollamaOptions({ temperature: 0.3, contextWindow: 8192 }, false)).toEqual({ temperature: 0.3 })
      expect(ollamaOptions({ contextWindow: null }, true)).toBeUndefined()
    })
    ```
- `tests/service.test.ts`: PR 1 left it importing `getModelInfo` from `'../src/main/providers/ollama/models'` (Task 1.2;
  the `runRounds` block's `setup()` calls it). Import `modelInfo` from `'../src/main/providers/registry'` instead (beside
  PR 1's `resolve`) and call `modelInfo('llama3.2')` where it called `getModelInfo`. Add
  `invalidateProviders` to that import and call it right after `setEndpoints([...])` in `beforeAll`. The fake
  `Provider` in "runs on any provider's neutral events" (PR 1, Task 1.6) needs the new field, after `id: 'fake',`:

  ```ts
          endpoint: { id: 'fake', name: 'Fake', kind: 'openai', flavor: 'generic', baseUrl: 'fake://', enabled: true, hasKey: false },
  ```

- [ ] **Step 15: Run tests to verify they pass**

Run: `npx vitest run tests/registry.test.ts tests/client.test.ts tests/ollamaAdapter.test.ts tests/assemble.test.ts tests/paletteChoices.test.ts`
then `npm run typecheck && npm run lint && npm run format:check && npm test`
Expected: PASS. `tests/service.test.ts` passes unchanged otherwise: a bare `llama3.2` still resolves to the mock.

- [ ] **Step 16: Commit**

```bash
git add -A src tests
git commit -m "One provider per endpoint; ModelInfo says where a model runs, how it's billed and its window

The registry lists every enabled endpoint in parallel and reports each failure on its own. ModelInfo.location
splits into where, billing, contextControl and contextWindow, computed in main. Model profiles are keyed by model
key, and each Ollama request is told its target, so an endpoint key is only ever sent to its own endpoint.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 2.5: Main-process callers use keys; usage rows carry `billing`

**Files:**
- Modify: `src/shared/types.ts` (`MessageStats.billing`, ~158–177)
- Modify: `src/main/usage/pricing.ts:64-75` (`requestCost`; `isBilled` goes)
- Modify: `src/main/db/usage.ts:6-30` (`insertUsageEvent` writes `billing`)
- Modify: `src/main/chat/rounds.ts` (`recordRound`)
- Modify: `src/main/chat/service.ts` (`generate`, `compact`/`summarizeOnce`, `generateTitle`)
- Modify: `src/main/chat/delegate.ts` (`runChild`)
- Modify: `src/main/debug/replay.ts`
- Modify: `src/main/usage/account.ts` (`fetchPlan`)
- Modify: `src/main/settings.ts` (the bridge goes)
- Test: `tests/service.test.ts` (keys throughout; three new tests), `tests/registry.test.ts` (`requestCost`), `tests/db.test.ts` (every `insertUsageEvent`)

**Interfaces:**
- Consumes: `resolve`, `modelInfo` (2.4); `ModelInfo.billing`, `.price`, `.name`, `.key` (2.4); `toModelKey`,
  `MIGRATED_ENDPOINT_ID` (2.1); `isOllamaCloudUrl` (2.2); PR 1's `RoundsInput.model`.
- Produces: `requestCost(info: Pick<ModelInfo, 'billing' | 'price'>, promptTokens, completionTokens): number | null`;
  `insertUsageEvent({ …, model: <key>, billing })`; `MessageStats.billing`. From here on a chat's model, a usage row's,
  a trace's and a message's are all keys, and only raw names reach a server, a thinking profile or a prompt.
  `ollamaConnection()` is gone.

- [ ] **Step 1: Write the failing tests**

In `tests/service.test.ts`, move every model the tests pick to its key:

```bash
sed -i '' -E "s/model: 'llama3\.2'/model: 'ollama\/llama3.2'/g; s/modelName: 'llama3\.2'/modelName: 'ollama\/llama3.2'/g; s/model: 'tiny-window'/model: 'ollama\/tiny-window'/g; s/modelInfo\('llama3\.2'\)/modelInfo('ollama\/llama3.2')/g" tests/service.test.ts
```

Then put back `'llama3.2'` wherever it's the name a server is sent rather than a model someone picked. Run
`grep -n "ollama/llama3.2" tests/service.test.ts` and restore these:

- the first reply-loop assertion (~line 152), on the body the mock received:

  ```ts
      expect(chatCalls[0]).toMatchObject({ model: 'llama3.2', options: { num_ctx: 8192 } })
  ```

- `parentReply`'s prompt (~line 2260, in `describe('sub-agents')`), which is what the prompt says the model is called
  (its `model:` three lines above stays `'ollama/llama3.2'`: that's the reply's key):

  ```ts
      prompt: { userName: '', model: 'llama3.2', contextLength: 8192, web: 'on', skillIndex: [] }
  ```

- in the `runRounds` block (PR 1, Task 1.6), the `ChatRequest` in `setup()` (`const body: RoundsInput['body'] = { model: … }`)
  and any expectation on a trace's `request: { model: …, stream: true }`: a `ChatRequest` carries the server's name.
- PR 1's "titles through the chat model’s provider" test (Task 1.7): its `expect(once).toHaveBeenCalledWith(expect.objectContaining({ model: 'llama3.2', … }), …)`
  is the `ChatRequest` the provider gets, so it keeps the server's name.
- PR 1's `describe('replay')` test (Task 1.7): the recorded body passed to `replayRequest` (`{ model: 'llama3.2', messages: …, stream: true }`)
  is a wire body, so it keeps the server's name (its `createConversation({ …, model: … })` one line above is a pick and
  stays a key).

Everything else the sed changed is a pick: `send`/`start`/`sendBody`, `regenerate`, `edit`, `compact`,
`createConversation`, `insertMessage`, `modelName`, `modelInfo(…)`. `req.json.model === 'tiny-window'` (~line 1084) is
what the mock receives, so the sed leaves it. Two `insertUsageEvent` calls (~lines 2002 and 2012, in "counts a
sub-agent’s rows in the chat’s totals…") gain `billing: 'priced',` after `costUsd: null,`. #175's tests need nothing
here: they pick no model of their own (they `start()` a chat, or reuse `setup()` and `parentReply`), and
`subAgentsAtOnce({ enabled: true, maxRounds: 20, parallel })` and `withAtOnce`'s `updateSettings({ delegate: … })` name
no model.

Add after the `'reply loop'` describe:

```ts
describe('model keys', () => {
  const HF = 'hf.co/bartowski/Qwen3-8B-GGUF:Q4_K_M'
  const sendNew = (model: string, think: ThinkSetting | null = null) =>
    service.send({ conversationId: null, projectId: null, content: 'hello', attachmentIds: [], model, think, skills: [], toolSources: [] })

  it('record a reply under its key and billing, and send Ollama only the name it knows', async () => {
    chat = reply('Hi')
    const r = start()
    const done = await doneEvent(r.conversation.id)
    expect(chatCalls[0].model).toBe('llama3.2')
    expect(done.message).toMatchObject({ model: 'ollama/llama3.2', stats: { billing: 'local' } })
    expect(
      all<{ model: string; billing: string }>("SELECT model, billing FROM usage_events WHERE conversation_id = ? AND kind = 'chat'", r.conversation.id)
    ).toEqual([{ model: 'ollama/llama3.2', billing: 'local' }])
    expect(listTraces(r.conversation.id).find((t) => t.kind === 'chat')?.model).toBe('ollama/llama3.2')
  })

  it('send an hf.co model its whole name (Review Focus #1)', async () => {
    chat = reply('Hi')
    const r = sendNew(`ollama/${HF}`)
    await doneEvent(r.conversation.id)
    expect(r.conversation.model).toBe(`ollama/${HF}`)
    expect(chatCalls[0].model).toBe(HF)
  })

  it('read a model’s thinking profile and prompt by its own name, not its key', async () => {
    const base = ollama.handler
    ollama.handler = (req, res) =>
      req.url === '/api/show' && req.json.model === 'gpt-oss:20b'
        ? void res.writeHead(200).end(JSON.stringify({ capabilities: ['completion', 'tools', 'thinking'], model_info: {} }))
        : base(req, res)
    try {
      chat = reply('Hi')
      const r = sendNew('ollama/gpt-oss:20b', 'high')
      await doneEvent(r.conversation.id)
      // gpt-oss takes effort levels. Read by its key, it would have been an on/off model and sent think: true.
      expect(chatCalls[0].think).toBe('high')
      expect((chatCalls[0].messages as Array<{ content: string }>)[0].content).toContain('You are the model "gpt-oss:20b"')
    } finally {
      ollama.handler = base
    }
  })
})
```

(import `ThinkSetting` with the other `@shared/types` types at the top.)

In `tests/registry.test.ts`, import `requestCost` from `'../src/main/usage/pricing'` and add:

```ts
describe('requestCost', () => {
  it('prices only priced requests, and a priced one with no known price as unknown', () => {
    const price = { input: 1, cachedInput: null, output: 2 }
    expect(requestCost({ billing: 'priced', price }, 1_000_000, 1_000_000)).toBe(3)
    expect(requestCost({ billing: 'priced', price: null }, 10, 10)).toBeNull()
    expect(requestCost({ billing: 'local', price }, 10, 10)).toBe(0)
    expect(requestCost({ billing: 'untracked', price: null }, 10, 10)).toBe(0)
  })
})
```

In `tests/db.test.ts`, every `insertUsageEvent` gains `billing`, since it's now required: the usage summary test's
`event` (line 203) gains `billing: 'priced' as const,`, and the three calls in `describe('a chat’s last context tokens
(the meter) after history changes')` (lines 227–294, added by #180; each has `costUsd: 0`) gain `billing: 'local',`
after `costUsd: 0,`.

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run tests/service.test.ts tests/registry.test.ts`
Expected: FAIL in "record a reply under its key and billing" (`stats.billing` is undefined), in "read a model's
thinking profile" (`think` is `true`), and in `requestCost` (the old signature takes a name). "send an hf.co model its
whole name" already passes: `resolve` landed in Task 2.4, and this pins it at the service.

- [ ] **Step 3: `requestCost` by billing, and `billing` on usage rows**

`src/main/usage/pricing.ts`: drop `isBilled` and its `isCloudName` and `ollamaConnection` imports; `requestCost` becomes

```ts
/** USD for one request: only Ollama's cloud models have published rates. A priced model with no known price is null. */
export function requestCost(info: Pick<ModelInfo, 'billing' | 'price'>, promptTokens: number, completionTokens: number): number | null {
  return info.billing === 'priced' ? costOf(info.price, promptTokens, completionTokens) : 0
}
```

(import `ModelInfo` with the other types from `'@shared/types'`).

`src/main/db/usage.ts`: `insertUsageEvent`'s parameter gains `/** Decided when the row is written, from the model's billing. */ billing: ModelBilling`
(after `costUsd`), and its SQL becomes:

```ts
  run(
    `INSERT INTO usage_events (id, conversation_id, message_id, model, kind, prompt_tokens, completion_tokens, cost_usd, billing, estimated, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    uid(),
    e.conversationId,
    e.messageId,
    e.model,
    e.kind,
    Math.round(e.promptTokens),
    Math.round(e.completionTokens),
    e.costUsd,
    e.billing,
    e.estimated ? 1 : 0,
    now()
  )
```

`src/shared/types.ts`, in `MessageStats` after `costUsd`:

```ts
  /** How the reply's model was billed when it ran: only a 'priced' reply has a cost to show. */
  billing?: ModelBilling
```

- [ ] **Step 4: Price each round by its model**

`src/main/chat/rounds.ts`, in `recordRound`:

```ts
    const costUsd = requestCost(input.model, promptTokens, completionTokens)
    insertUsageEvent({
      conversationId,
      messageId: input.messageId,
      model: modelName,
      kind: input.usageKind,
      promptTokens,
      completionTokens,
      costUsd,
      billing: input.model.billing,
      estimated
    })
```

`RoundsInput.modelName`'s comment becomes `/** The model's key: what usage rows and traces record. */`.

- [ ] **Step 5: Raw names for thinking and prompts; billing on the reply, the title and `/compact`**

In `src/main/chat/service.ts`:

- `generate()`: right after `const model = await modelInfo(modelName)`, add `stats.billing = model.billing`. Then:
  - `resolveThinkProfile(modelName, model.capabilities, model.overrides.think)` → `resolveThinkProfile(model.name, model.capabilities, model.overrides.think)`;
  - `` `${modelName} can't use tools, so this chat's tools weren't used.` `` → `` `${model.name} can't use tools, so this chat's tools weren't used.` ``;
  - in `toolContext.reply.prompt`, `model: modelName` → `model: model.name` (`reply.model` stays `modelName`: a
    sub-agent resolves it);
  - in the `assemble({ … })` call, `model: modelName` → `model: model.name`.
- `compact()`: `resolveThinkProfile(opts.model, …)` → `resolveThinkProfile(info.name, …)`, and `compact` passes its
  `info` to `summarizeOnce` as a new last argument (`summarizeOnce(…, info: ModelInfo)`). In `summarizeOnce`,
  `requestCost(modelName, …)` → `requestCost(info, …)` and its `insertUsageEvent` gains `billing: info.billing`.
- `generateTitle()`: `resolveThinkProfile(modelName, …)` → `resolveThinkProfile(info.name, …)`,
  `requestCost(modelName, …)` → `requestCost(info, …)`, and its `insertUsageEvent` gains `billing: info.billing`.

Import `ModelInfo` with the other `@shared/types` types.

`src/main/chat/delegate.ts`, `runChild`: `resolveThinkProfile(reply.model, …)` → `resolveThinkProfile(model.name, …)`.

- [ ] **Step 6: Replay stays on the Ollama endpoint**

`src/main/debug/replay.ts`. A replay body names the model as the server knows it, and replays go to the `ollama`
endpoint, as they did before endpoints (PR 4 routes a replay by its trace's key). Where PR 1 resolves the body's model,
put:

```ts
  const key = toModelKey(MIGRATED_ENDPOINT_ID, request.model)
  const { provider, model } = resolve(key)
  const info = await provider.modelInfo(model)
```

(imports: `MIGRATED_ENDPOINT_ID, toModelKey` from `'@shared/modelKey'`; `resolve` from `'../providers/registry'`).
Then `startTrace({ …, model: request.model, … })` → `model: key`, `requestCost(request.model, …)` → `requestCost(info, …)`,
and `insertUsageEvent({ …, model: request.model, … })` → `model: key` with `billing: info.billing` added.

- [ ] **Step 7: The plan lookup reads endpoints; the bridge goes**

`src/main/usage/account.ts`, `fetchPlan()`:

```ts
/** The signed-in Ollama app knows the plan name (POST /api/me), even without an API key. */
async function fetchPlan(): Promise<string | null> {
  if (plan) return plan
  // The first Ollama app among the endpoints: ollama.com itself has no /api/me.
  const app = getSettings().endpoints.find((e) => e.enabled && e.kind === 'ollama' && !isOllamaCloudUrl(e.baseUrl))
  if (!app) return null
  try {
    const res = await fetch(`${app.baseUrl.replace(/\/+$/, '')}/api/me`, { method: 'POST', signal: AbortSignal.timeout(5000) })
    if (!res.ok) return null
    plan = ((await res.json()) as { plan?: string }).plan ?? null
    return plan
  } catch {
    return null
  }
}
```

with `import { isOllamaCloudUrl } from '@shared/endpoints'` and `ollamaConnection` dropped from the settings import.

`src/main/settings.ts`: delete `ollamaConnection()` and, if nothing else uses it, the `isOllamaCloudUrl` import.
`tests/settings.test.ts`: the direct-mode test's `ollamaConnection` line goes.

Run: `grep -rn "ollamaConnection\|connectionMode\|isBilled" src tests`
Expected: no output.

`code.create` needs nothing: it stores the model it's given, which the renderer sends as a key (Task 2.7).

- [ ] **Step 8: Run tests to verify they pass**

Run: `npx vitest run tests/service.test.ts tests/registry.test.ts tests/db.test.ts tests/settings.test.ts`
then `npm run typecheck && npm run lint && npm run format:check && npm test`
Expected: PASS

- [ ] **Step 9: Commit**

```bash
git add -A src tests
git commit -m "Every model call goes by key; usage rows record the key and how the model was billed

Thinking profiles, the prompt's model name and the request carry the name the server knows; chats, messages, usage
and traces carry the key. requestCost prices by billing, so only Ollama cloud rows have a cost. The temporary
connection bridge is gone.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 2.6: Endpoints IPC: list, probe (Ollama), add, update, remove, keys

**Files:**
- Create: `src/main/providers/probe.ts`
- Create: `src/main/providers/endpoints.ts`
- Modify: `src/main/db/kv.ts` (`countEndpointOverrides`)
- Modify: `src/shared/ipc.ts` (`OllmostApi.endpoints`; `INVOKE_CHANNELS.endpoints`, ~line 291)
- Modify: `src/main/ipc.ts` (the `endpoints` handlers)
- Modify: `e2e/run.mjs` (five `settings.update({ connection … })` calls; the Kiln stand-in, ~2023–2026; line ~2116)
- Test: `tests/probe.test.ts`, `tests/endpoints.test.ts` (new)

The preload builds its bridge from `INVOKE_CHANNELS`, so `src/preload/index.ts` needs no change.

**Interfaces:**
- Consumes: `slugEndpointId` (2.1); `setEndpoints`, `StoredEndpoint`, `DEFAULT_OLLAMA`, `isOllamaCloudUrl`,
  `isLoopbackHost`, `displayAddress`, `DEFAULT_NUM_CTX` (2.2); `invalidateProviders`, `deleteEndpointProfiles`,
  `listCloudCatalog` (2.4); PR 1's `setSecret`, `endpointSecretName`.
- Produces: `normalizeBaseUrl(input)`, `sameServer(a, b)`, `probeEndpoint(baseUrl, apiKey?)` (`providers/probe.ts`);
  `assertAddressFree`, `probeNewEndpoint`, `addEndpoint`, `updateEndpoint`, `endpointRemovalImpact`, `removeEndpoint`,
  `setEndpointKey` (`providers/endpoints.ts`); `countEndpointOverrides`; the IPC group
  `endpoints.list/probe/add/update/removalImpact/remove/setKey` exactly as in the Shared contracts.

- [ ] **Step 1: Write the failing tests**

`tests/probe.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { normalizeBaseUrl, probeEndpoint, sameServer } from '../src/main/providers/probe'
import { type MockOllama, startMockOllama } from './ollamaMock'

describe('normalizeBaseUrl (Review Focus #5)', () => {
  it('reads a loosely typed address as the server’s root', () => {
    for (const typed of ['localhost:1234', 'http://localhost:1234/', 'http://localhost:1234/v1/', ' HTTP://LocalHost:1234/v1 '])
      expect(normalizeBaseUrl(typed)).toBe('http://localhost:1234')
    expect(normalizeBaseUrl('https://ollama.com/')).toBe('https://ollama.com')
    expect(normalizeBaseUrl('[::1]:11434')).toBe('http://[::1]:11434')
    expect(normalizeBaseUrl('http://gpu.lan:8000/api/openai/v1')).toBe('http://gpu.lan:8000/api/openai')
  })

  it('refuses what isn’t an address', () => {
    expect(() => normalizeBaseUrl('  ')).toThrow('Type the server’s address')
    expect(() => normalizeBaseUrl('not an address')).toThrow('isn’t an address')
    expect(() => normalizeBaseUrl('ftp://files.lan')).toThrow('http or https')
  })

  it('knows this Mac by any of its names', () => {
    expect(sameServer('http://localhost:11434', 'http://127.0.0.1:11434/')).toBe(true)
    expect(sameServer('localhost:11434/v1', 'http://[::1]:11434')).toBe(true)
    expect(sameServer('http://localhost:11434', 'http://localhost:1234')).toBe(false)
    expect(sameServer('http://192.168.1.20:11434', 'http://localhost:11434')).toBe(false)
  })
})

describe('probeEndpoint', () => {
  let server: MockOllama
  let auth: string | undefined
  beforeAll(async () => {
    server = await startMockOllama()
  })
  afterAll(() => server.close())

  it('finds Ollama and counts its models, however the address was typed', async () => {
    server.handler = (req, res) => {
      auth = req.headers.authorization
      if (req.url === '/api/version') return void res.writeHead(200).end(JSON.stringify({ version: '0.12.3' }))
      if (req.url === '/api/tags') return void res.writeHead(200).end(JSON.stringify({ models: [{ name: 'a' }, { name: 'b' }] }))
      res.writeHead(404).end()
    }
    const found = await probeEndpoint(`${server.url}/v1/`, ' sk-1 ')
    expect(found).toEqual({
      kind: 'ollama',
      flavor: 'ollama',
      baseUrl: server.url,
      version: '0.12.3',
      models: 2,
      withTools: 0,
      withVision: 0,
      canThink: 0,
      reportsCapabilities: true,
      reportsContext: true
    })
    expect(auth).toBe('Bearer sk-1')
  })

  it('tells an OpenAI-compatible server from Ollama, even one that answers every path', async () => {
    // LM Studio answers an unknown path with an error object, not a 404.
    server.handler = (req, res) => {
      if (req.url === '/v1/models') return void res.writeHead(200).end(JSON.stringify({ data: [{ id: 'qwen/qwen3-8b' }] }))
      res.writeHead(200).end(JSON.stringify({ error: `Unexpected endpoint or method. (GET ${req.url})` }))
    }
    expect(await probeEndpoint(server.url)).toMatchObject({ kind: 'openai', flavor: 'generic', baseUrl: `${server.url}/v1`, models: 1, reportsCapabilities: false })
  })

  it('says when nothing answers, or the server wants a key', async () => {
    await expect(probeEndpoint('http://127.0.0.1:9')).rejects.toThrow('Nothing answered at 127.0.0.1:9. Is the server started?')
    server.handler = (_req, res) => void res.writeHead(401).end()
    await expect(probeEndpoint(server.url)).rejects.toThrow('wants an API key, or rejected this one')
  })
})
```

`tests/endpoints.test.ts`:

```ts
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (s: string) => Buffer.from(`enc:${s}`),
    decryptString: (b: Buffer) => b.toString().replace(/^enc:/, '')
  },
  shell: {},
  app: { getPath: () => '' }
}))

const { get, openDatabase } = await import('../src/main/db/index')
const { createConversation } = await import('../src/main/db/conversations')
const { readModelProfile, writeModelOverrides } = await import('../src/main/db/kv')
const { DEFAULT_OLLAMA, getSettings, setEndpoints, updateSettings } = await import('../src/main/settings')
const { endpointSecretName, getSecret, OLLAMA_ACCOUNT_SECRET, setSecret } = await import('../src/main/providers/secrets')
const endpoints = await import('../src/main/providers/endpoints')

const gpu = (over: { apiKey?: string } = {}) =>
  endpoints.addEndpoint({ name: 'GPU box', baseUrl: '192.168.1.20:11434/', kind: 'ollama', flavor: 'ollama', ...over })
const chatOn = (model: string) => createConversation({ projectId: null, model, think: null, skills: [], toolSources: [] })

beforeAll(() => openDatabase(':memory:'))
beforeEach(() => {
  setEndpoints([DEFAULT_OLLAMA])
  setSecret(endpointSecretName('gpu-box'), null)
  updateSettings({ defaultModel: null, titleModel: null })
})

describe('adding an endpoint', () => {
  it('normalises the address, makes an id from the name, and keeps its key for it alone', () => {
    expect(gpu({ apiKey: ' gpu-key ' })).toEqual({
      id: 'gpu-box',
      name: 'GPU box',
      kind: 'ollama',
      flavor: 'ollama',
      baseUrl: 'http://192.168.1.20:11434',
      enabled: true,
      hasKey: true,
      showCloudCatalog: false,
      numCtx: 32768
    })
    expect(getSecret(endpointSecretName('gpu-box'))).toBe('gpu-key')
    expect(getSecret(OLLAMA_ACCOUNT_SECRET)).toBeNull()
    expect(getSettings().endpoints.map((e) => e.id)).toEqual(['ollama', 'gpu-box'])
  })

  it('refuses an address that’s taken, however it’s typed (Review Focus #5)', async () => {
    for (const typed of ['localhost:11434', 'http://localhost:11434/', 'http://127.0.0.1:11434/v1/'])
      expect(() => endpoints.addEndpoint({ name: 'Again', baseUrl: typed, kind: 'ollama', flavor: 'ollama' })).toThrow(
        'Ollama already uses this address.'
      )
    await expect(endpoints.probeNewEndpoint({ baseUrl: 'localhost:11434' })).rejects.toThrow('Ollama already uses this address.')
  })

  it('gives a name that’s taken the next free id', () => {
    expect(endpoints.addEndpoint({ name: 'Ollama', baseUrl: 'http://10.0.0.2:11434', kind: 'ollama', flavor: 'ollama' }).id).toBe('ollama-2')
  })

  it('refuses a nameless endpoint, and an OpenAI-compatible one until its adapter exists', () => {
    expect(() => endpoints.addEndpoint({ name: '  ', baseUrl: 'http://10.0.0.3:11434', kind: 'ollama', flavor: 'ollama' })).toThrow(
      'Give the endpoint a name.'
    )
    expect(() => endpoints.addEndpoint({ name: 'LM Studio', baseUrl: 'http://localhost:1234/v1', kind: 'openai', flavor: 'lmstudio' })).toThrow(
      /next update/
    )
  })
})

describe('changing an endpoint', () => {
  it('keeps its id when its name, address and settings change', () => {
    gpu()
    expect(endpoints.updateEndpoint('gpu-box', { name: 'Studio', baseUrl: 'http://192.168.1.21:11434/', numCtx: 65536, showCloudCatalog: true, enabled: false })).toMatchObject({
      id: 'gpu-box',
      name: 'Studio',
      baseUrl: 'http://192.168.1.21:11434',
      numCtx: 65536,
      showCloudCatalog: true,
      enabled: false
    })
  })

  it('refuses a taken address, a blank name and a nonsense window', () => {
    gpu()
    expect(() => endpoints.updateEndpoint('gpu-box', { baseUrl: 'localhost:11434' })).toThrow('Ollama already uses this address.')
    expect(() => endpoints.updateEndpoint('gpu-box', { name: '' })).toThrow('Give the endpoint a name.')
    expect(() => endpoints.updateEndpoint('gpu-box', { numCtx: -1 })).toThrow('whole number of tokens')
    expect(() => endpoints.updateEndpoint('nope', { name: 'x' })).toThrow('That endpoint no longer exists.')
  })

  it('sets and clears its key, but never one for ollama.com', () => {
    gpu()
    expect(endpoints.setEndpointKey('gpu-box', 'k').hasKey).toBe(true)
    expect(endpoints.setEndpointKey('gpu-box', null).hasKey).toBe(false)
    setEndpoints([{ ...DEFAULT_OLLAMA, name: 'Ollama cloud', baseUrl: 'https://ollama.com' }])
    expect(() => endpoints.setEndpointKey('ollama', 'k')).toThrow('ollama.com account key')
  })
})

describe('removing an endpoint', () => {
  it('says what goes, then deletes its key and model settings and keeps its chats', () => {
    gpu({ apiKey: 'gpu-key' })
    chatOn('gpu-box/qwen3:8b')
    chatOn('gpu-box/qwen3:8b')
    chatOn('ollama/llama3.2')
    writeModelOverrides('gpu-box/qwen3:8b', { artifacts: false })
    updateSettings({ defaultModel: 'gpu-box/qwen3:8b', titleModel: 'ollama/llama3.2' })
    expect(endpoints.endpointRemovalImpact('gpu-box')).toEqual({ chats: 2, hasKey: true, overrides: 1 })

    endpoints.removeEndpoint('gpu-box')
    expect(getSettings().endpoints.map((e) => e.id)).toEqual(['ollama'])
    expect(getSecret(endpointSecretName('gpu-box'))).toBeNull()
    expect(readModelProfile('gpu-box/qwen3:8b').overrides).toEqual({})
    expect(getSettings()).toMatchObject({ defaultModel: null, titleModel: 'ollama/llama3.2' })
    // The chats stay, still naming the model: they need another one picked.
    expect(get<{ n: number }>("SELECT COUNT(*) AS n FROM conversations WHERE model = 'gpu-box/qwen3:8b'")?.n).toBe(2)
  })
})
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run tests/probe.test.ts tests/endpoints.test.ts`
Expected: FAIL. Neither `../src/main/providers/probe` nor `../src/main/providers/endpoints` exists ("Does the file exist?").

- [ ] **Step 3: `src/main/providers/probe.ts`**

```ts
import { displayAddress, isLoopbackHost, isOllamaCloudUrl, OLLAMA_CLOUD_URL } from '@shared/endpoints'
import type { EndpointProbe } from '@shared/types'
import { listCloudCatalog } from './ollama/wire'

const PROBE_MS = 5_000

/**
 * An address as typed ("localhost:1234", "http://localhost:1234/v1/") as the server's root: scheme, host and port, and
 * any path but a trailing /v1. Typed three ways, one server is one string.
 */
export function normalizeBaseUrl(input: string): string {
  const raw = input.trim()
  if (!raw) throw new Error('Type the server’s address, such as http://localhost:11434.')
  let url: URL
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `http://${raw}`)
  } catch {
    throw new Error(`“${raw}” isn’t an address Ollmost can use. Try one like http://localhost:11434.`)
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('Ollmost talks to model servers over http or https.')
  return `${url.protocol}//${url.host}${url.pathname.replace(/\/+$/, '').replace(/\/v1$/i, '')}`
}

/** Whether two addresses are one server: localhost, 127.0.0.1 and [::1] are all this Mac. */
export function sameServer(a: string, b: string): boolean {
  try {
    const [x, y] = [new URL(normalizeBaseUrl(a)), new URL(normalizeBaseUrl(b))]
    const host = (u: URL) => (isLoopbackHost(u.hostname) ? 'this-mac' : u.hostname)
    return x.protocol === y.protocol && x.port === y.port && host(x) === host(y) && x.pathname === y.pathname
  } catch {
    return false
  }
}

const ollamaFound = (baseUrl: string, version: string | null, models: number): EndpointProbe => ({
  kind: 'ollama',
  flavor: 'ollama',
  baseUrl,
  version,
  models,
  // Ollama reports each model's capabilities and context (/api/show) when it's listed; the probe needn't count them.
  withTools: 0,
  withVision: 0,
  canThink: 0,
  reportsCapabilities: true,
  reportsContext: true
})

async function json(res: Response): Promise<Record<string, unknown>> {
  const body: unknown = await res.json().catch(() => null)
  return typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {}
}

/**
 * What answers at an address. Ollama says so at /api/version; an OpenAI-compatible server lists its models at
 * /v1/models (PR 3 tells LM Studio, llama.cpp and vLLM apart). The key, if given, is sent only there.
 */
export async function probeEndpoint(baseUrl: string, apiKey?: string): Promise<EndpointProbe> {
  const root = normalizeBaseUrl(baseUrl)
  const where = displayAddress(root)
  // ollama.com is the cloud API, not an Ollama app: it has no /api/version, and its catalog needs no key.
  if (isOllamaCloudUrl(root)) return ollamaFound(OLLAMA_CLOUD_URL, null, (await listCloudCatalog()).length)
  const headers: Record<string, string> = apiKey?.trim() ? { Authorization: `Bearer ${apiKey.trim()}` } : {}
  const get = (path: string) => fetch(`${root}${path}`, { headers, signal: AbortSignal.timeout(PROBE_MS) })
  let version: Response
  try {
    version = await get('/api/version')
  } catch (err) {
    throw new Error(
      (err as Error).name === 'TimeoutError' ? `${where} didn’t answer within 5 seconds.` : `Nothing answered at ${where}. Is the server started?`
    )
  }
  if (version.status === 401 || version.status === 403) throw new Error(`The server at ${where} wants an API key, or rejected this one.`)
  // LM Studio answers any path with an error object, so only a version string says Ollama.
  const v = version.ok ? (await json(version)).version : undefined
  if (typeof v === 'string') {
    const tags = await get('/api/tags')
      .then(json)
      .catch(() => ({}) as Record<string, unknown>)
    return ollamaFound(root, v, Array.isArray(tags.models) ? tags.models.length : 0)
  }
  const models = await get('/v1/models').catch(() => null)
  if (models?.ok) {
    const data = (await json(models)).data
    return {
      kind: 'openai',
      flavor: 'generic',
      baseUrl: `${root}/v1`,
      version: null,
      models: Array.isArray(data) ? data.length : 0,
      withTools: 0,
      withVision: 0,
      canThink: 0,
      reportsCapabilities: false,
      reportsContext: false
    }
  }
  throw new Error(`The server at ${where} doesn’t look like Ollama or an OpenAI-compatible server.`)
}
```

- [ ] **Step 4: `countEndpointOverrides` in `src/main/db/kv.ts`**

After `deleteEndpointProfiles`:

```ts
/** How many of an endpoint's models have settings the user chose, for the question before it's removed. */
export function countEndpointOverrides(endpointId: string): number {
  return get<{ n: number }>("SELECT COUNT(*) AS n FROM model_profiles WHERE model LIKE ? AND overrides != '{}'", `${endpointId}/%`)?.n ?? 0
}
```

- [ ] **Step 5: `src/main/providers/endpoints.ts`**

```ts
import { DEFAULT_NUM_CTX, isOllamaCloudUrl } from '@shared/endpoints'
import { slugEndpointId } from '@shared/modelKey'
import type { Endpoint, EndpointFlavor, EndpointKind, EndpointProbe } from '@shared/types'
import { get } from '../db/index'
import { countEndpointOverrides, deleteEndpointProfiles } from '../db/kv'
import { getSettings, setEndpoints, type StoredEndpoint, updateSettings } from '../settings'
import { normalizeBaseUrl, probeEndpoint, sameServer } from './probe'
import { invalidateProviders } from './registry'
import { endpointSecretName, setSecret } from './secrets'

// Endpoints change only here, never through a settings update. Everything the renderer sends is checked: it may
// send anything.

type EndpointPatch = Partial<Pick<Endpoint, 'name' | 'baseUrl' | 'enabled' | 'flavor' | 'showCloudCatalog' | 'numCtx' | 'defaultContext'>>

const FLAVORS: readonly EndpointFlavor[] = ['ollama', 'lmstudio', 'llamacpp', 'vllm', 'generic']

const stored = (): StoredEndpoint[] =>
  getSettings().endpoints.map((e) => {
    const { hasKey: _hasKey, ...rest } = e
    return rest
  })

function find(id: string): Endpoint {
  const endpoint = getSettings().endpoints.find((e) => e.id === id)
  if (!endpoint) throw new Error('That endpoint no longer exists.')
  return endpoint
}

function save(list: StoredEndpoint[], id: string): Endpoint {
  setEndpoints(list)
  invalidateProviders()
  return find(id)
}

function cleanName(name: unknown): string {
  const trimmed = typeof name === 'string' ? name.trim() : ''
  if (!trimmed) throw new Error('Give the endpoint a name.')
  return trimmed.slice(0, 60)
}

function tokens(value: unknown, what: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 512 || value > 4_194_304)
    throw new Error(`${what} must be a whole number of tokens.`)
  return value
}

/** Refuse an address another endpoint has. localhost, 127.0.0.1 and [::1] are one server. */
export function assertAddressFree(baseUrl: string, exceptId?: string): void {
  const taken = getSettings().endpoints.find((e) => e.id !== exceptId && sameServer(e.baseUrl, baseUrl))
  if (taken) throw new Error(`${taken.name} already uses this address.`)
}

/** Check an address before it's added: refused at once if it's taken, then asked what it is. */
export async function probeNewEndpoint(input: { baseUrl: string; apiKey?: string }): Promise<EndpointProbe> {
  assertAddressFree(normalizeBaseUrl(String(input.baseUrl)))
  return probeEndpoint(String(input.baseUrl), typeof input.apiKey === 'string' ? input.apiKey : undefined)
}

export function addEndpoint(input: { name: string; baseUrl: string; kind: EndpointKind; flavor: EndpointFlavor; apiKey?: string }): Endpoint {
  if (input.kind !== 'ollama') throw new Error('Ollmost can’t talk to OpenAI-compatible servers yet. That arrives in the next update.')
  const name = cleanName(input.name)
  const baseUrl = normalizeBaseUrl(String(input.baseUrl))
  assertAddressFree(baseUrl)
  const list = stored()
  const id = slugEndpointId(name, list.map((e) => e.id))
  // A second Ollama starts without the cloud catalog, so ollama.com's models aren't listed twice.
  const endpoint: StoredEndpoint = { id, name, kind: 'ollama', flavor: 'ollama', baseUrl, enabled: true, showCloudCatalog: false, numCtx: DEFAULT_NUM_CTX }
  // ollama.com takes the account key; an endpoint key is never kept for it.
  const key = typeof input.apiKey === 'string' ? input.apiKey.trim() : ''
  if (key && !isOllamaCloudUrl(baseUrl)) setSecret(endpointSecretName(id), key)
  return save([...list, endpoint], id)
}

/** Change an endpoint. Its id never changes, so a server that moves keeps its chats. */
export function updateEndpoint(id: string, patch: EndpointPatch): Endpoint {
  const list = stored()
  const i = list.findIndex((e) => e.id === id)
  if (i < 0) throw new Error('That endpoint no longer exists.')
  const next: StoredEndpoint = { ...list[i] }
  if (patch.name !== undefined) next.name = cleanName(patch.name)
  if (patch.baseUrl !== undefined) {
    next.baseUrl = normalizeBaseUrl(String(patch.baseUrl))
    assertAddressFree(next.baseUrl, id)
  }
  if (patch.enabled !== undefined) next.enabled = patch.enabled === true
  if (patch.flavor !== undefined && next.kind === 'openai' && FLAVORS.includes(patch.flavor)) next.flavor = patch.flavor
  if (patch.showCloudCatalog !== undefined && next.kind === 'ollama') next.showCloudCatalog = patch.showCloudCatalog === true
  if (patch.numCtx !== undefined && next.kind === 'ollama') next.numCtx = tokens(patch.numCtx, 'The context window')
  if (patch.defaultContext !== undefined && next.kind === 'openai') next.defaultContext = tokens(patch.defaultContext, 'The context size')
  list[i] = next
  return save(list, id)
}

/** What removing an endpoint loses, for the question asked first. */
export function endpointRemovalImpact(id: string): { chats: number; hasKey: boolean; overrides: number } {
  const endpoint = find(id)
  const chats = get<{ n: number }>('SELECT COUNT(*) AS n FROM conversations WHERE model LIKE ?', `${id}/%`)?.n ?? 0
  return { chats, hasKey: endpoint.hasKey, overrides: countEndpointOverrides(id) }
}

/** Remove an endpoint with its key and its models' settings. Its chats keep their history and need a new model. */
export function removeEndpoint(id: string): void {
  find(id)
  setSecret(endpointSecretName(id), null)
  deleteEndpointProfiles(id)
  setEndpoints(stored().filter((e) => e.id !== id))
  // A default that named one of its models would name a model that can't be reached.
  const s = getSettings()
  const on = (key: string | null) => key?.startsWith(`${id}/`) === true
  if (on(s.defaultModel) || on(s.titleModel))
    updateSettings({ ...(on(s.defaultModel) && { defaultModel: null }), ...(on(s.titleModel) && { titleModel: null }) })
  invalidateProviders()
}

export function setEndpointKey(id: string, key: string | null): Endpoint {
  const endpoint = find(id)
  if (isOllamaCloudUrl(endpoint.baseUrl))
    throw new Error('This endpoint uses your ollama.com account key. Set it under ollama.com account in Settings → Models.')
  setSecret(endpointSecretName(id), typeof key === 'string' ? key.trim() || null : null)
  invalidateProviders()
  return find(id)
}
```

- [ ] **Step 6: The IPC group**

`src/shared/ipc.ts`: add `Endpoint`, `EndpointFlavor`, `EndpointKind` and `EndpointProbe` to the type import, and to
`OllmostApi` after `models`:

```ts
  /** Model servers. Never changed through settings.update: its deep-merge can't hold a list. */
  endpoints: {
    list(): Promise<Endpoint[]>
    /** What answers at an address (refused at once when another endpoint has it). */
    probe(input: { baseUrl: string; apiKey?: string }): Promise<EndpointProbe>
    add(input: { name: string; baseUrl: string; kind: EndpointKind; flavor: EndpointFlavor; apiKey?: string }): Promise<Endpoint>
    update(
      id: string,
      patch: Partial<Pick<Endpoint, 'name' | 'baseUrl' | 'enabled' | 'flavor' | 'showCloudCatalog' | 'numCtx' | 'defaultContext'>>
    ): Promise<Endpoint>
    /** What removing it would lose: the chats on its models, its key, its models' settings. */
    removalImpact(id: string): Promise<{ chats: number; hasKey: boolean; overrides: number }>
    remove(id: string): Promise<void>
    /** Its own key; null removes it. ollama.com's is the account key (settings.setApiKey). */
    setKey(id: string, key: string | null): Promise<Endpoint>
  }
```

and to `INVOKE_CHANNELS` after `models`:

```ts
  endpoints: ['list', 'probe', 'add', 'update', 'removalImpact', 'remove', 'setKey'],
```

`src/main/ipc.ts`: import the seven functions from `'./providers/endpoints'`, and add after `models`:

```ts
  endpoints: {
    list: async () => getSettings().endpoints,
    probe: (input) => probeNewEndpoint(input),
    add: async (input) => addEndpoint(input),
    update: async (id, patch) => updateEndpoint(id, patch),
    removalImpact: async (id) => endpointRemovalImpact(id),
    remove: async (id) => removeEndpoint(id),
    setKey: async (id, key) => setEndpointKey(id, key)
  },
```

- [ ] **Step 7: Point the e2e script at the endpoint**

`e2e/run.mjs` sets the Ollama address with `settings.update({ connection: … })`, which no longer moves anything.

```bash
sed -i '' -E \
  -e "s/settings\.update\(\{ connection: \{ mode: 'local', host \}, showCloudCatalog: false \}\)/endpoints.update('ollama', { baseUrl: host, showCloudCatalog: false })/g" \
  -e "s/settings\.update\(\{ connection: \{ mode: 'local', host: h \}, showCloudCatalog: false \}\)/endpoints.update('ollama', { baseUrl: h, showCloudCatalog: false })/g" \
  -e "s/settings\.connection\.hasApiKey/settings.ollamaAccount.hasKey/g" \
  e2e/run.mjs
grep -n "connection" e2e/run.mjs
```

Expected: `grep` prints no `connection: {` and no `.connection.` (the word may still appear in comments). PR 5 folds
these fakes into one factory; this keeps `npm run e2e` working until then.

- [ ] **Step 8: Make the e2e's Kiln stand-in undo the model-key migration**

Section 14 of `e2e/run.mjs` ("Coming from Kiln") makes a database with this app, then turns it back into Kiln's: it
undoes every migration Kiln never had and sets `user_version` to Kiln's 8, so Ollmost's first launch runs them all
again. Task 2.3 appended one more entry, and the stand-in must undo it too: otherwise its own check fails
(`version === KILN_DB_VERSION + 8`), and running the entry again would prefix every model name twice (`ollama/ollama/…`).

In the Kiln section (lines 2023–2026 on `main` @ `24f4623`), replace:

```js
    const KILN_DB_VERSION = 8
    const version = db.prepare('PRAGMA user_version').get().user_version
    check('the Kiln stand-in undoes every migration since Kiln', version === KILN_DB_VERSION + 8, `database version ${version}`)
    db.exec('ALTER TABLE project_files DROP COLUMN folder')
```

with:

```js
    const KILN_DB_VERSION = 8
    const version = db.prepare('PRAGMA user_version').get().user_version
    check('the Kiln stand-in undoes every migration since Kiln', version === KILN_DB_VERSION + 9, `database version ${version}`)
    // The model-key migration (model endpoints): its two columns go, and model names lose the 'ollama/' it put in front,
    // or running it again would prefix them twice.
    db.exec('ALTER TABLE model_profiles DROP COLUMN detected; ALTER TABLE usage_events DROP COLUMN billing')
    for (const table of ['conversations', 'messages', 'usage_events', 'traces', 'model_profiles'])
      db.exec(`UPDATE ${table} SET model = substr(model, 8) WHERE model LIKE 'ollama/%'`)
    db.exec('ALTER TABLE project_files DROP COLUMN folder')
```

`+ 9` counts the entries `main` has after Kiln's 8 (eight more) and Task 2.3's. If another migration entry lands on
`main` before this PR, count it too and undo it here.

Run: `grep -n "KILN_DB_VERSION + \|DROP COLUMN detected\|substr(model, 8)" e2e/run.mjs`
Expected: the `+ 9` check, the `DROP COLUMN detected` line and the `substr(model, 8)` line. Task 2.9 runs the e2e.

- [ ] **Step 9: Run tests to verify they pass**

Run: `npx vitest run tests/probe.test.ts tests/endpoints.test.ts` then `npm run typecheck && npm run lint && npm run format:check && npm test`
Expected: PASS

- [ ] **Step 10: Commit**

```bash
git add src/main/providers/probe.ts src/main/providers/endpoints.ts src/main/db/kv.ts src/shared/ipc.ts src/main/ipc.ts e2e/run.mjs \
  tests/probe.test.ts tests/endpoints.test.ts
git commit -m "Endpoints have their own calls: probe, add, update, remove, keys

An address is normalised to the server's root, so one server typed three ways is refused as the second. Removing an
endpoint says first what goes, then deletes its key and model settings; its chats stay. The probe finds Ollama and
recognises an OpenAI-compatible server, which can't be added until the next update. The e2e script points its fakes
at the ollama endpoint, and its Kiln stand-in undoes the model-key migration.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 2.7: Renderer: keys everywhere, `modelLabel`, `groupModels`, and the picker (option B)

**Files:**
- Create: `src/shared/modelLabel.ts`, `src/shared/pickerGroups.ts`
- Modify: `src/renderer/src/stores/app.ts` (models by key; `modelErrors`, `modelsReady`, `endpointsChanged`, `selectEndpoints`)
- Modify: `src/renderer/src/components/ModelPicker.tsx` (whole file)
- Modify: `src/renderer/src/lib/format.ts:3-6` (`displayModelName` goes)
- Modify: `src/shared/paletteChoices.ts:24-47`
- Modify (labels): `src/renderer/src/components/Messages.tsx:545-547,746`, `src/renderer/src/components/UsageBar.tsx:256,350`,
  `src/renderer/src/components/Composer.tsx:589`, `src/renderer/src/views/CodeView.tsx:100`, `src/renderer/src/views/ProjectView.tsx:197`,
  `src/renderer/src/views/SettingsView.tsx:530,562,657,700-720,790`, `src/renderer/src/debug/TraceView.tsx:105`,
  `src/renderer/src/debug/DebugApp.tsx:216`, `src/renderer/src/views/HomeView.tsx:12,31`, `src/renderer/src/debug/Anatomy.tsx:41`
- Test: `tests/modelLabel.test.ts`, `tests/pickerGroups.test.ts` (new); `tests/paletteChoices.test.ts`

**Interfaces:**
- Consumes: `ModelInfo` (2.4); `Endpoint`, `whereOf`, `isOllamaCloudUrl`, `displayAddress` (2.2); `splitModelKey`,
  `MIGRATED_ENDPOINT_ID`, `toModelKey` (2.1); `api.models.list` returning `{ models, errors }` (2.4).
- Produces: `modelLabel(m)`, `shortModelName(name)`, `labelForKey(key, endpoints)`; `groupModels(models, errors, opts)`,
  `PickerGroup`, `endpointChips(endpoints, errors)`, `EndpointChip`; in the store `modelErrors`, `modelsReady`,
  `endpointsChanged()`, `selectEndpoints`, and `draftModel`/`setDraftModel`/`findModel`/`thinkProfileFor` by key;
  `ModelPicker({ value, onChange, unavailable })`.

- [ ] **Step 1: Write the failing tests**

`tests/modelLabel.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { labelForKey, modelLabel, shortModelName } from '../src/shared/modelLabel'
import type { Endpoint } from '../src/shared/types'

const ollama = { id: 'ollama', name: 'Ollama', kind: 'ollama', flavor: 'ollama' } as const
const lmStudio: Endpoint = { id: 'lm-studio', name: 'LM Studio', kind: 'openai', flavor: 'lmstudio', baseUrl: 'http://localhost:1234/v1', enabled: true, hasKey: false }

describe('model labels', () => {
  it('shorten an Ollama name as the picker always has', () => {
    expect(shortModelName('gpt-oss:120b-cloud')).toBe('gpt-oss:120b')
    expect(shortModelName('glm-5.3:cloud')).toBe('glm-5.3')
    expect(shortModelName('llama3.2:latest')).toBe('llama3.2')
    expect(modelLabel({ name: 'gpt-oss:120b-cloud', endpoint: ollama })).toBe('gpt-oss:120b')
  })

  it('name the endpoint when it isn’t Ollama', () => {
    expect(modelLabel({ name: 'qwen/qwen3-8b', endpoint: lmStudio })).toBe('qwen/qwen3-8b · LM Studio')
  })

  it('label a stored key the same way, hf.co names whole', () => {
    expect(labelForKey('ollama/gpt-oss:120b-cloud', [])).toBe('gpt-oss:120b')
    expect(labelForKey('ollama/hf.co/bartowski/Qwen3-8B-GGUF:Q4_K_M', [])).toBe('hf.co/bartowski/Qwen3-8B-GGUF:Q4_K_M')
    expect(labelForKey('lm-studio/qwen/qwen3-8b', [lmStudio])).toBe('qwen/qwen3-8b · LM Studio')
    // An endpoint Ollmost doesn't know (removed, or not loaded yet): the key as it is.
    expect(labelForKey('gone/qwen3', [])).toBe('gone/qwen3')
    expect(labelForKey(null, [])).toBe('Choose a model')
  })
})
```

`tests/pickerGroups.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { whereOf } from '../src/shared/endpoints'
import { toModelKey } from '../src/shared/modelKey'
import { endpointChips, groupModels } from '../src/shared/pickerGroups'
import type { Endpoint, ModelInfo, ModelListResult, ModelWhere } from '../src/shared/types'

const ep = (id: string, name: string, kind: Endpoint['kind'], baseUrl: string, over: Partial<Endpoint> = {}): Endpoint => ({
  id,
  name,
  kind,
  flavor: kind === 'ollama' ? 'ollama' : 'lmstudio',
  baseUrl,
  enabled: true,
  hasKey: false,
  ...over
})
const model = (e: Endpoint, name: string, where: ModelWhere = whereOf(e.baseUrl)): ModelInfo => ({
  key: toModelKey(e.id, name),
  name,
  endpoint: { id: e.id, name: e.name, kind: e.kind, flavor: e.flavor },
  where,
  billing: where === 'cloud' ? 'priced' : 'local',
  contextControl: 'server',
  contextWindow: null,
  installed: true,
  capabilities: ['completion'],
  contextLength: null,
  family: null,
  parameterSize: null,
  overrides: {},
  detected: {},
  price: null
})

// The mockup's endpoints: Ollama (cloud and this Mac), LM Studio, a vLLM box on the network, llama.cpp offline.
const ollama = ep('ollama', 'Ollama', 'ollama', 'http://127.0.0.1:11434')
const lm = ep('lm-studio', 'LM Studio', 'openai', 'http://localhost:1234/v1')
const box = ep('gpu-box', 'GPU box', 'openai', 'http://192.168.1.20:8000/v1', { flavor: 'vllm' })
const cpp = ep('llama-cpp', 'llama.cpp', 'openai', 'http://localhost:8080/v1', { flavor: 'llamacpp' })
const off = ep('off', 'Off', 'ollama', 'http://10.0.0.9:11434', { enabled: false })
const endpoints = [ollama, lm, box, cpp, off]
const models = [
  model(ollama, 'gpt-oss:120b-cloud', 'cloud'),
  model(ollama, 'kimi-k3:cloud', 'cloud'),
  model(ollama, 'qwen3:8b'),
  model(lm, 'qwen/qwen3-8b'),
  model(lm, 'google/gemma-3-12b'),
  model(box, 'Qwen/Qwen3-32B')
]
const errors: ModelListResult['errors'] = [{ endpointId: 'llama-cpp', message: "Can't reach llama.cpp at localhost:8080." }]
const view = (opts: Partial<Parameters<typeof groupModels>[2]>) =>
  groupModels(models, errors, { query: '', filter: 'all', currentKey: null, endpoints, ...opts }).map((g) => ({
    id: g.id,
    label: g.label,
    where: g.where,
    items: g.items.map((m) => m.name),
    ...(g.error && { error: g.error })
  }))

describe('the picker’s sections', () => {
  it('put the current model’s endpoint first; Ollama keeps its cloud and local sections', () => {
    expect(view({ currentKey: 'lm-studio/qwen/qwen3-8b' })).toEqual([
      { id: 'lm-studio', label: 'LM Studio', where: 'this-mac', items: ['qwen/qwen3-8b', 'google/gemma-3-12b'] },
      { id: 'ollama:cloud', label: 'Ollama cloud', where: 'cloud', items: ['gpt-oss:120b-cloud', 'kimi-k3:cloud'] },
      { id: 'ollama:local', label: 'Ollama', where: 'this-mac', items: ['qwen3:8b'] },
      { id: 'gpu-box', label: 'GPU box', where: 'network', items: ['Qwen/Qwen3-32B'] }
    ])
  })

  it('leave an offline endpoint to its chip, but show why when it’s chosen or it has the chat’s model (Review Focus #2)', () => {
    expect(view({}).map((g) => g.id)).not.toContain('llama-cpp')
    const why = { id: 'llama-cpp', label: 'llama.cpp', where: 'this-mac', items: [], error: "Can't reach llama.cpp at localhost:8080." }
    expect(view({ filter: 'llama-cpp' })).toEqual([why])
    expect(view({ currentKey: 'llama-cpp/qwen3-8b-q4' })[0]).toEqual(why)
  })

  it('filter by chip and by search, dropping sections left empty', () => {
    expect(view({ filter: 'ollama' }).map((g) => g.id)).toEqual(['ollama:cloud', 'ollama:local'])
    expect(view({ query: 'QWEN3' }).map((g) => [g.id, g.items])).toEqual([
      ['ollama:local', ['qwen3:8b']],
      ['lm-studio', ['qwen/qwen3-8b']],
      ['gpu-box', ['Qwen/Qwen3-32B']]
    ])
  })

  it('call an ollama.com endpoint’s section by its own name', () => {
    const cloud = ep('ollama', 'Ollama cloud', 'ollama', 'https://ollama.com')
    const groups = groupModels([model(cloud, 'gpt-oss:120b', 'cloud')], [], { query: '', filter: 'all', currentKey: null, endpoints: [cloud] })
    expect(groups.map((g) => g.label)).toEqual(['Ollama cloud'])
  })
})

describe('the endpoint chips', () => {
  it('offer All and each enabled endpoint, an offline one marked with its error', () => {
    expect(endpointChips(endpoints, errors)).toEqual([
      { id: 'all', label: 'All', offline: false },
      { id: 'ollama', label: 'Ollama', offline: false },
      { id: 'lm-studio', label: 'LM Studio', offline: false },
      { id: 'gpu-box', label: 'GPU box', offline: false },
      { id: 'llama-cpp', label: 'llama.cpp', offline: true, error: "Can't reach llama.cpp at localhost:8080." }
    ])
  })
})
```

In `tests/paletteChoices.test.ts`, the settings and model fixtures become:

```ts
const settings = { appearance, defaultModel: null, endpoints: [], usage: { showInHeader: true } } as unknown as Settings
const ollama = { id: 'ollama', name: 'Ollama', kind: 'ollama', flavor: 'ollama' } as const
const models = [
  { key: 'ollama/gpt-oss:120b-cloud', name: 'gpt-oss:120b-cloud', endpoint: ollama, where: 'cloud' },
  { key: 'ollama/gemma4:e4b', name: 'gemma4:e4b', endpoint: ollama, where: 'this-mac' }
] as ModelInfo[]
```

and the saved-model case uses a key: `defaultModel: 'old-model:7b'` → `defaultModel: 'ollama/old-model:7b'`, and its
expectations become

```ts
    expect(byId['default-model'].choices.find((x) => x.value === 'ollama/old-model:7b')).toMatchObject({
      label: 'old-model:7b',
      patch: { defaultModel: 'ollama/old-model:7b' }
    })
    expect(byId['default-model'].current).toBe('ollama/old-model:7b')
```

(the labels test, `['Last used', 'gpt-oss:120b (cloud)', 'gemma4:e4b']`, stays as it is).

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run tests/modelLabel.test.ts tests/pickerGroups.test.ts tests/paletteChoices.test.ts`
Expected: FAIL. `../src/shared/modelLabel` and `../src/shared/pickerGroups` don't exist ("Does the file exist?"), and
the palette offers `gemma4:e4b` as a value, not `ollama/gemma4:e4b`.

- [ ] **Step 3: `src/shared/modelLabel.ts`**

```ts
// How a model is named wherever Ollmost shows one: the picker, the palette, message footers, usage rows.
import { MIGRATED_ENDPOINT_ID, splitModelKey } from './modelKey'
import type { Endpoint, ModelInfo } from './types'

/** "gpt-oss:120b-cloud" → "gpt-oss:120b", "llama3.2:latest" → "llama3.2": an Ollama name as the picker shows it. */
export const shortModelName = (name: string): string => name.replace(/(:|-)cloud$/, '').replace(/:latest$/, '')

/** A model's name, and its endpoint's when that isn't Ollama: "qwen/qwen3-8b · LM Studio". */
export function modelLabel(m: Pick<ModelInfo, 'name' | 'endpoint'>): string {
  return m.endpoint.kind === 'ollama' ? shortModelName(m.name) : `${m.name} · ${m.endpoint.name}`
}

/** The same label for a stored key (a message's, a usage row's), from the endpoints alone. */
export function labelForKey(key: string | null | undefined, endpoints: readonly Endpoint[]): string {
  if (!key) return 'Choose a model'
  // `ollama` is always known, so an Ollama key reads right before the endpoints load (the debugger has none).
  const ids = [...new Set([MIGRATED_ENDPOINT_ID, ...endpoints.map((e) => e.id)])]
  const { endpointId, model } = splitModelKey(key, ids)
  const e = endpoints.find((x) => x.id === endpointId)
  return modelLabel({
    name: model,
    endpoint: e ? { id: e.id, name: e.name, kind: e.kind, flavor: e.flavor } : { id: endpointId, name: endpointId, kind: 'ollama', flavor: 'ollama' }
  })
}
```

- [ ] **Step 4: `src/shared/pickerGroups.ts`**

```ts
// The model picker's sections and endpoint chips, as data (option B of the approved mockup).
import { isOllamaCloudUrl, whereOf } from './endpoints'
import { modelLabel } from './modelLabel'
import { splitModelKey } from './modelKey'
import type { Endpoint, ModelInfo, ModelListResult, ModelWhere } from './types'

export interface PickerGroup {
  id: string
  endpointId: string
  label: string
  where: ModelWhere
  items: ModelInfo[]
  /** Why the endpoint listed nothing, with Retry beside it. */
  error?: string
}

export interface EndpointChip {
  id: string
  label: string
  offline: boolean
  error?: string
}

/**
 * A section per endpoint, the current model's endpoint first; Ollama keeps its "cloud" and local sections. An endpoint
 * that couldn't list shows why only when it's asked about: its own chip, or the chat's model is on it.
 */
export function groupModels(
  models: readonly ModelInfo[],
  errors: ModelListResult['errors'],
  opts: { query: string; filter: string; currentKey: string | null; endpoints: readonly Endpoint[] }
): PickerGroup[] {
  const q = opts.query.trim().toLowerCase()
  const current = opts.currentKey ? splitModelKey(opts.currentKey, opts.endpoints.map((e) => e.id)).endpointId : null
  const shown = opts.endpoints.filter((e) => e.enabled && (opts.filter === 'all' || opts.filter === e.id))
  const ordered = [...shown.filter((e) => e.id === current), ...shown.filter((e) => e.id !== current)]
  const matches = (m: ModelInfo) => !q || m.name.toLowerCase().includes(q) || modelLabel(m).toLowerCase().includes(q)
  const groups: PickerGroup[] = []
  for (const e of ordered) {
    const items = models.filter((m) => m.endpoint.id === e.id && matches(m))
    const error = errors.find((x) => x.endpointId === e.id)?.message
    if (error) {
      if (opts.filter === e.id || e.id === current) groups.push({ id: e.id, endpointId: e.id, label: e.name, where: whereOf(e.baseUrl), items: [], error })
      continue
    }
    if (e.kind === 'ollama') {
      const cloud = items.filter((m) => m.where === 'cloud')
      const local = items.filter((m) => m.where !== 'cloud')
      const cloudLabel = isOllamaCloudUrl(e.baseUrl) ? e.name : `${e.name} cloud`
      if (cloud.length) groups.push({ id: `${e.id}:cloud`, endpointId: e.id, label: cloudLabel, where: 'cloud', items: cloud })
      if (local.length) groups.push({ id: `${e.id}:local`, endpointId: e.id, label: e.name, where: whereOf(e.baseUrl), items: local })
    } else if (items.length) groups.push({ id: e.id, endpointId: e.id, label: e.name, where: whereOf(e.baseUrl), items })
  }
  return groups
}

/** All, then each enabled endpoint; one that couldn't list is offline, with its error. */
export function endpointChips(endpoints: readonly Endpoint[], errors: ModelListResult['errors']): EndpointChip[] {
  return [
    { id: 'all', label: 'All', offline: false },
    ...endpoints
      .filter((e) => e.enabled)
      .map((e) => {
        const error = errors.find((x) => x.endpointId === e.id)?.message
        return error ? { id: e.id, label: e.name, offline: true, error } : { id: e.id, label: e.name, offline: false }
      })
  ]
}
```

- [ ] **Step 5: The palette's default-model choices by key**

`src/shared/paletteChoices.ts`: the local `modelLabel` (lines 24–26) is replaced by imports and one line:

```ts
import { labelForKey, modelLabel } from './modelLabel'
```

```ts
/** As the picker names it, with cloud models marked (the palette lists every endpoint's models together). */
const choiceLabel = (m: ModelInfo) => `${modelLabel(m)}${m.where === 'cloud' ? ' (cloud)' : ''}`
```

and `modelChoices` becomes:

```ts
  const modelChoices: Choice[] = [
    { value: '', label: 'Last used', patch: { defaultModel: null } },
    ...(saved && !models.some((m) => m.key === saved)
      ? [{ value: saved, label: labelForKey(saved, settings.endpoints ?? []), patch: { defaultModel: saved } }]
      : []),
    ...models.map((m) => ({ value: m.key, label: choiceLabel(m), patch: { defaultModel: m.key } }))
  ]
```

(`settings.endpoints ?? []`: the palette previews settings the tests build partially.)

- [ ] **Step 6: The app store by key**

In `src/renderer/src/stores/app.ts`:

- imports: `Endpoint` and `ModelListResult` join the `@shared/types` import.
- in `AppState`, replace `modelsError: string | null` and the draft block with:

  ```ts
    /** Endpoints that couldn't list their models this time, and why. */
    modelErrors: ModelListResult['errors']
    modelsLoading: boolean
    /** The first listing has finished: before it, a chat's model can't be told from a missing one. */
    modelsReady: boolean
    loadModels: (refresh?: boolean) => Promise<void>
    /** An endpoint was added, changed or removed: the endpoint list (in settings) and the models again. */
    endpointsChanged: () => Promise<void>

    /** Model (a key) + thinking choice for chats that don't exist yet. */
    draftModel: string | null
    draftThink: ThinkSetting | null
    setDraftModel: (key: string) => void
    setDraftThink: (think: ThinkSetting | null) => void
  ```

- the models slice becomes:

  ```ts
    models: [],
    modelErrors: [],
    modelsLoading: false,
    modelsReady: false,
    loadModels: async (refresh = false) => {
      set({ modelsLoading: true })
      try {
        const { models, errors } = await api.models.list(refresh)
        set({ models, modelErrors: errors })
        const { draftModel, settings } = get()
        if (!draftModel || !models.some((m) => m.key === draftModel)) {
          const preferred = settings?.defaultModel && models.find((m) => m.key === settings.defaultModel)
          const pick = preferred || models.find((m) => m.installed) || models[0]
          if (pick) get().setDraftModel(pick.key)
        }
      } catch (err) {
        set({ modelErrors: [{ endpointId: '', message: (err as Error).message }] })
      } finally {
        set({ modelsLoading: false, modelsReady: true })
      }
    },
    endpointsChanged: async () => {
      await get().loadSettings()
      await get().loadModels(true)
    },

    draftModel: null,
    draftThink: null,
    setDraftModel: (key) => {
      const profile = thinkProfileFor(get().models, key)
      set({ draftModel: key, draftThink: defaultThinkSetting(profile) })
    },
  ```

- the lookups become:

  ```ts
  export function findModel(models: ModelInfo[], key: string | null): ModelInfo | undefined {
    return key ? models.find((m) => m.key === key) : undefined
  }

  export function thinkProfileFor(models: ModelInfo[], key: string | null): ThinkProfile {
    const model = findModel(models, key)
    // Family rules match the name the server knows ("gpt-oss…"), never the key.
    return model ? resolveThinkProfile(model.name, model.capabilities, model.overrides.think) : { kind: 'none' }
  }

  const NO_ENDPOINTS: Endpoint[] = []
  /** The configured endpoints, for `useApp(selectEndpoints)`: one empty list until settings load, so nothing re-renders for it. */
  export const selectEndpoints = (s: AppState): Endpoint[] => s.settings?.endpoints ?? NO_ENDPOINTS
  ```

  (`contextWindowFor(model)` is already Task 2.4's.)

- [ ] **Step 7: Rewrite `src/renderer/src/components/ModelPicker.tsx`**

```tsx
import { Brain, Check, ChevronDown, Cloud, Eye, HardDrive, Network, RefreshCw, Search, TriangleAlert, Wrench } from 'lucide-react'
import { useMemo, useState } from 'react'
import { displayAddress } from '@shared/endpoints'
import { labelForKey, modelLabel, shortModelName } from '@shared/modelLabel'
import { endpointChips, groupModels, type PickerGroup } from '@shared/pickerGroups'
import type { Endpoint, ModelInfo } from '@shared/types'
import { cn, formatContext, formatParams } from '@/lib/format'
import { selectEndpoints, useApp } from '@/stores/app'
import { PopoverContent, PopoverRoot, PopoverTrigger, Spinner, Tooltip } from './ui'

function CapabilityIcons({ model }: { model: ModelInfo }) {
  const caps = [
    { key: 'vision', icon: Eye, label: 'Sees images' },
    { key: 'thinking', icon: Brain, label: 'Can think' },
    { key: 'tools', icon: Wrench, label: 'Uses tools (skills, web search)' }
  ].filter((c) => model.capabilities.includes(c.key))
  return (
    <span className="flex items-center gap-1 text-subtle">
      {caps.map(({ key, icon: Icon, label }) => (
        <Tooltip key={key} content={label}>
          <Icon className="size-3.5" />
        </Tooltip>
      ))}
    </span>
  )
}

/** A section's heading: the endpoint, and where it runs ("On this Mac", or its address on the network). */
function GroupHeading({ group, endpoint }: { group: PickerGroup; endpoint: Endpoint | undefined }) {
  const Icon = group.where === 'cloud' ? Cloud : group.where === 'this-mac' ? HardDrive : Network
  const where = group.where === 'this-mac' ? 'On this Mac' : group.where === 'network' && endpoint ? displayAddress(endpoint.baseUrl) : null
  return (
    <div className="flex items-center gap-1.5 px-2 pb-1 pt-1.5 text-xs font-medium text-subtle">
      <Icon className="size-3.5" /> {group.label}
      {where && <span className="font-normal">· {where}</span>}
    </div>
  )
}

function ModelRow({ model, selected, onPick }: { model: ModelInfo; selected: boolean; onPick: () => void }) {
  return (
    <button onClick={onPick} className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-hover">
      <span className="flex size-4 items-center justify-center">{selected && <Check className="size-4 text-accent" />}</span>
      <span className="min-w-0 flex-1">
        {/* The section names the endpoint, so a row is the model's own name. */}
        <span className="block truncate text-sm">{model.endpoint.kind === 'ollama' ? shortModelName(model.name) : model.name}</span>
        <span className="block text-xs text-subtle">
          {[
            formatParams(model.parameterSize),
            formatContext(model.contextLength) && `${formatContext(model.contextLength)} context`,
            model.price && `$${model.price.input} / $${model.price.output} per M`
          ]
            .filter(Boolean)
            .join(' · ') || (model.installed ? 'Installed' : 'Available')}
        </span>
      </span>
      <CapabilityIcons model={model} />
    </button>
  )
}

/**
 * The composer's model menu: a search box, endpoint chips (All, then each endpoint; an offline one dashed with ⚠),
 * and a section per endpoint with the current model's first. `value` and `onChange` are model keys.
 */
export function ModelPicker({ value, onChange, unavailable }: { value: string | null; onChange: (key: string) => void; unavailable?: boolean }) {
  const models = useApp((s) => s.models)
  const modelErrors = useApp((s) => s.modelErrors)
  const modelsLoading = useApp((s) => s.modelsLoading)
  const loadModels = useApp((s) => s.loadModels)
  const navigate = useApp((s) => s.navigate)
  const endpoints = useApp(selectEndpoints)
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState('all')

  const chips = useMemo(() => endpointChips(endpoints, modelErrors), [endpoints, modelErrors])
  // A chip whose endpoint has gone (removed, turned off) falls back to All.
  const active = chips.some((c) => c.id === filter) ? filter : 'all'
  const groups = useMemo(
    () => groupModels(models, modelErrors, { query, filter: active, currentKey: value, endpoints }),
    [models, modelErrors, query, active, value, endpoints]
  )
  const current = models.find((m) => m.key === value)
  // One endpoint that answers needs no filter. Several, or one that's offline, get the chips.
  const showChips = chips.length > 2 || chips.some((c) => c.offline)
  const pick = (key: string) => {
    onChange(key)
    setOpen(false)
    setQuery('')
  }

  return (
    <PopoverRoot open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          className="flex h-8 max-w-[260px] items-center gap-1 rounded-lg px-2 text-[13px] text-muted hover:bg-hover hover:text-fg"
          aria-label="Choose model"
        >
          <span className="truncate">{current ? modelLabel(current) : labelForKey(value, endpoints)}</span>
          {unavailable && <span className="shrink-0 text-danger">· unavailable</span>}
          {current?.where === 'cloud' && <Cloud className="size-3.5 shrink-0 text-subtle" />}
          <ChevronDown className="size-3.5 shrink-0" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" side="top" className="w-[340px]" onOpenAutoFocus={(e) => e.preventDefault()}>
        <div className="flex items-center gap-2 border-b border-line px-3">
          <Search className="size-4 text-subtle" />
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search models"
            className="h-10 flex-1 bg-transparent text-sm outline-none placeholder:text-subtle"
          />
        </div>
        {showChips && (
          <div role="group" aria-label="Endpoints" className="flex flex-wrap gap-1.5 px-2.5 pb-1 pt-2">
            {chips.map((c) => (
              <button
                key={c.id}
                aria-pressed={active === c.id}
                title={c.error}
                onClick={() => setFilter(c.id)}
                className={cn(
                  'flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-xs',
                  active === c.id
                    ? 'border-fg bg-fg text-canvas'
                    : c.offline
                      ? 'border-dashed border-danger text-danger'
                      : 'border-line text-muted hover:text-fg'
                )}
              >
                {c.label}
                {c.offline && <TriangleAlert className="size-3" />}
              </button>
            ))}
          </div>
        )}
        <div className="max-h-[360px] overflow-y-auto p-1">
          {groups.map((g) => (
            <div key={g.id} className="py-1">
              <GroupHeading group={g} endpoint={endpoints.find((e) => e.id === g.endpointId)} />
              {g.error && (
                <div className="mx-2 mb-1.5 flex items-start justify-between gap-2 rounded-md bg-hover px-2 py-1.5 text-xs text-danger">
                  <span>{g.error}</span>
                  <button className="shrink-0 underline" onClick={() => void loadModels(true)}>
                    Retry
                  </button>
                </div>
              )}
              {g.items.map((m) => (
                <ModelRow key={m.key} model={m} selected={m.key === value} onPick={() => pick(m.key)} />
              ))}
            </div>
          ))}
          {!groups.length && (
            <div className="px-3 py-4 text-sm text-subtle">
              {models.length ? 'No models match.' : modelErrors.length ? 'No endpoint could list its models.' : 'No models yet.'}
            </div>
          )}
        </div>
        <div className="flex items-center justify-between border-t border-line px-2 py-1.5">
          <button
            onClick={() => loadModels(true)}
            className="flex items-center gap-1.5 rounded-md px-2 py-1 text-xs text-muted hover:bg-hover hover:text-fg"
          >
            {modelsLoading ? <Spinner className="size-3.5" /> : <RefreshCw className="size-3.5" />} Refresh
          </button>
          <button
            onClick={() => {
              setOpen(false)
              navigate({ name: 'settings', tab: 'models' })
            }}
            className="rounded-md px-2 py-1 text-xs text-muted hover:bg-hover hover:text-fg"
          >
            Model settings
          </button>
        </div>
      </PopoverContent>
    </PopoverRoot>
  )
}
```

- [ ] **Step 8: Every other label reads the key**

Delete `displayModelName` from `src/renderer/src/lib/format.ts`. Then, where a component shows a key, it takes the
endpoints with `const endpoints = useApp(selectEndpoints)` (import `selectEndpoints` from `'@/stores/app'` and
`labelForKey`/`shortModelName`/`modelLabel` from `'@shared/modelLabel'`):

| File | Was | Becomes |
|---|---|---|
| `components/Messages.tsx:543-547` | `statsLine(message)` with `displayModelName(message.model)` twice | `statsLine(message, endpoints)` with `labelForKey(message.model, endpoints)`; the signature gains `endpoints: readonly Endpoint[]` |
| `components/Messages.tsx:745-746` (in `AssistantMessage`) | `statsLine(message)`, `displayModelName(message.model)` | `statsLine(message, endpoints)`, `labelForKey(message.model, endpoints)` |
| `components/UsageBar.tsx:256` | `displayModelName(m.name)` (ollama.com's own activity rows) | `shortModelName(m.name)` |
| `components/UsageBar.tsx:350` (in `ChatCost`) | `displayModelName(m.model)` | `labelForKey(m.model, endpoints)` |
| `components/Composer.tsx:589` | `` `${model.name.replace(/(:|-)cloud$/, '')} can't see images.` `` | `` `${modelLabel(model)} can't see images.` `` |
| `views/CodeView.tsx:100` (in `CodeView`) | `displayModelName(c.model)` | `labelForKey(c.model, endpoints)` |
| `views/ProjectView.tsx:197` | `displayModelName(draftModel)` | `labelForKey(draftModel, endpoints)` |
| `views/SettingsView.tsx:530` | `displayModelName(m.name)` (ollama.com activity) | `shortModelName(m.name)` |
| `views/SettingsView.tsx:562` | `displayModelName(m.model)` (Ollmost's own usage rows) | `labelForKey(m.model, settings.endpoints)` |
| `views/SettingsView.tsx:657` (`ModelRow`) | `displayModelName(model.name)` | `modelLabel(model)` |
| `views/SettingsView.tsx:718-721` (`modelSelect`) | `{displayModelName(m.name)}{m.where === 'cloud' ? ' (cloud)' : ''}` | `{modelLabel(m)}{m.where === 'cloud' ? ' (cloud)' : ''}` |
| `debug/TraceView.tsx:105` (in `TraceView`) | `displayModelName(trace.model)` | `labelForKey(trace.model, endpoints)` |
| `debug/DebugApp.tsx:216` (in `DebugApp`) | `displayModelName(t.model)` | `labelForKey(t.model, endpoints)` |

The debugger window loads settings too (`DebugApp` calls `loadSettings`), so `selectEndpoints` works there.

Then the model list's errors:

- `views/SettingsView.tsx` `ModelsTab`: `modelsError` → `modelErrors`, and line ~790 becomes
  `{modelErrors.length > 0 && <span className="text-xs text-danger">{modelErrors.map((e) => e.message).join(' ')}</span>}`
  (Task 2.8 replaces this tab).
- `views/HomeView.tsx`: `modelsError` → `modelErrors` in the destructuring, and line 31 becomes

  ```tsx
                  <div className="mt-1 text-muted">
                    {modelErrors.length ? modelErrors.map((e) => <div key={e.endpointId}>{e.message}</div>) : 'Make sure the Ollama app is running.'}
                  </div>
  ```

- `debug/Anatomy.tsx:41`: a key's endpoint may be gone, so the lookup can fail:
  `void api.models.info(model).then((m) => setModelContext(m.contextLength)).catch(() => setModelContext(null))`.

Run: `grep -rn "displayModelName\|modelsError\b" src`
Expected: no output.

- [ ] **Step 9: Run tests to verify they pass**

Run: `npx vitest run tests/modelLabel.test.ts tests/pickerGroups.test.ts tests/paletteChoices.test.ts`
then `npm run typecheck && npm run lint && npm run format:check && npm test`
Expected: PASS

- [ ] **Step 10: Check it by hand**

Run `npm run dev`. With Ollama running:
- Open the model picker in a new chat. The list shows "Ollama cloud" (if the catalog is on) and "Ollama · On this Mac"
  sections, with no chips (one endpoint). Pick a model, send "hi": the reply streams, and the footer names the model
  without `ollama/`.
- Quit Ollama and click Refresh in the picker. A dashed "Ollama ⚠" chip appears; hovering shows "Can't reach Ollama at …".
  The current model's section shows that error with Retry. Start Ollama and click Retry: the models come back and the
  chip goes.
- Open ⌘K, "Default model": the choices are the same names, with "(cloud)" on cloud models.

- [ ] **Step 11: Commit**

```bash
git add -A src tests
git commit -m "The renderer knows models by key; the picker gets endpoint chips and a section per endpoint

One modelLabel names a model everywhere: its short name, and its endpoint's when that isn't Ollama. An endpoint
that couldn't list is a dashed chip with its error and Retry, and the others still list.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 2.8: Settings → Models master–detail and the Add endpoint dialog (Ollama)

**Files:**
- Modify: `src/shared/endpoints.ts` (`probeSummary`, `removalText`)
- Modify: `src/renderer/src/views/settingsParts.tsx` (`BlurField` moves here)
- Create: `src/renderer/src/views/settings/ApiKeyField.tsx` (moved from `SettingsView.tsx:296-355`)
- Create: `src/renderer/src/views/settings/EndpointsPane.tsx`
- Create: `src/renderer/src/views/settings/AddEndpointDialog.tsx`
- Modify: `src/renderer/src/views/SettingsView.tsx` (`ModelsTab`, `ModelRow`, `THINK_OPTIONS`, `ApiKeyField`, `BlurField` go; the Models tab renders `EndpointsPane`)
- Modify: `src/renderer/src/stores/confirm.ts:17-18` (its comment)
- Test: `tests/endpointText.test.ts` (new)

**Interfaces:**
- Consumes: `api.endpoints.*` (2.6); `selectEndpoints`, `endpointsChanged`, `modelErrors`, `modelsLoading` (2.7);
  `modelLabel`, `shortModelName`, `labelForKey` (2.7); `FLAVOR_LABELS`, `displayAddress`, `isOllamaCloudUrl`,
  `DEFAULT_NUM_CTX`, `DEFAULT_CONTEXT` (2.2); `useConfirm` (`stores/confirm.ts`).
- Produces: `probeSummary(p)`, `removalText(name, impact)`; `EndpointsPane({ settings })`,
  `AddEndpointDialog({ open, onOpenChange, onAdded })`, `ApiKeyField({ hasKey, onSaved? })`,
  `BlurField` (exported from `settingsParts.tsx`). PR 3 adds the Tools | Vision | Context columns and Re-detect to
  `EndpointsPane`, and removes the dialog's Ollama-only gate.

- [ ] **Step 1: Write the failing test**

`tests/endpointText.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { probeSummary, removalText } from '../src/shared/endpoints'
import type { EndpointProbe } from '../src/shared/types'

const probe = (over: Partial<EndpointProbe>): EndpointProbe => ({
  kind: 'openai',
  flavor: 'lmstudio',
  baseUrl: 'http://localhost:1234/v1',
  version: null,
  models: 0,
  withTools: 0,
  withVision: 0,
  canThink: 0,
  reportsCapabilities: true,
  reportsContext: true,
  ...over
})

describe('what the Add endpoint dialog found', () => {
  it('names the server and counts what it reported', () => {
    expect(probeSummary(probe({ version: '0.4', models: 5, withTools: 4, withVision: 1, canThink: 2 }))).toBe(
      'Found LM Studio 0.4 · 5 models · 4 with tools · 1 with vision · 2 can think'
    )
    expect(probeSummary(probe({ kind: 'ollama', flavor: 'ollama', version: '0.12.3', models: 1 }))).toBe('Found Ollama 0.12.3 · 1 model')
  })

  it('says when a server reports no capabilities, and what applies instead', () => {
    expect(probeSummary(probe({ flavor: 'generic', models: 12, reportsCapabilities: false }))).toBe(
      'Found an OpenAI-compatible server · 12 models · capabilities not reported — defaults apply (tools on, vision off)'
    )
  })
})

describe('the question before an endpoint is removed', () => {
  it('says what goes, as the spec words it', () => {
    expect(removalText('LM Studio', { chats: 12, hasKey: true, overrides: 3 })).toEqual({
      title: 'Remove LM Studio?',
      body: ['12 chats use its models; they keep their history but need a new model picked.', 'Its API key and model settings are deleted.']
    })
  })

  it('names only what there is', () => {
    expect(removalText('GPU box', { chats: 1, hasKey: false, overrides: 2 }).body).toEqual([
      '1 chat uses its models; it keeps its history but needs a new model picked.',
      'Its model settings are deleted.'
    ])
    expect(removalText('GPU box', { chats: 0, hasKey: true, overrides: 0 }).body).toEqual(['No chats use its models.', 'Its API key is deleted.'])
    expect(removalText('GPU box', { chats: 0, hasKey: false, overrides: 0 }).body).toEqual(['No chats use its models.'])
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/endpointText.test.ts`
Expected: FAIL with `probeSummary is not a function` (and `removalText is not a function`).

- [ ] **Step 3: The two texts, in `src/shared/endpoints.ts`**

Add `EndpointProbe` to the type import, and append:

```ts
const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`

/** What checking an address found, in one line: "Found LM Studio 0.4 · 5 models · 4 with tools · 1 with vision · 2 can think". */
export function probeSummary(p: EndpointProbe): string {
  const server = p.kind === 'ollama' ? 'Ollama' : p.flavor === 'generic' ? 'an OpenAI-compatible server' : FLAVOR_LABELS[p.flavor]
  const parts = [`Found ${server}${p.version ? ` ${p.version}` : ''}`, count(p.models, 'model', 'models')]
  // Ollama reports each model's capabilities when it's listed, so its probe doesn't count them.
  if (p.kind === 'openai')
    parts.push(
      ...(p.reportsCapabilities
        ? [`${p.withTools} with tools`, `${p.withVision} with vision`, `${p.canThink} can think`]
        : ['capabilities not reported — defaults apply (tools on, vision off)'])
    )
  return parts.join(' · ')
}

/** The question before an endpoint is removed: what goes (the confirm-before-loss rule). */
export function removalText(name: string, impact: { chats: number; hasKey: boolean; overrides: number }): { title: string; body: string[] } {
  const chats =
    impact.chats === 0
      ? 'No chats use its models.'
      : impact.chats === 1
        ? '1 chat uses its models; it keeps its history but needs a new model picked.'
        : `${impact.chats} chats use its models; they keep their history but need a new model picked.`
  const gone =
    impact.hasKey && impact.overrides
      ? 'Its API key and model settings are deleted.'
      : impact.hasKey
        ? 'Its API key is deleted.'
        : impact.overrides
          ? 'Its model settings are deleted.'
          : null
  return { title: `Remove ${name}?`, body: gone ? [chats, gone] : [chats] }
}
```

- [ ] **Step 4: Move `BlurField` and `ApiKeyField` out of `SettingsView.tsx`**

Cut `BlurField` with its comment (lines 27–54) into `src/renderer/src/views/settingsParts.tsx`, exported, adding
`import { useEffect, useState } from 'react'` and `import { TextArea, TextField } from '@/components/ui'` there.

Cut `ApiKeyField` (lines 296–355) into `src/renderer/src/views/settings/ApiKeyField.tsx`, exported, with its imports:

```tsx
import { useState } from 'react'
import { Button, Field, TextField } from '@/components/ui'
import { api } from '@/lib/api'
import { reportError, useApp } from '@/stores/app'
import { useUsage } from '@/stores/usage'
```

In `SettingsView.tsx`, import `BlurField` from `'./settingsParts'` and `ApiKeyField` from `'./settings/ApiKeyField'`.

- [ ] **Step 5: `src/renderer/src/views/settings/AddEndpointDialog.tsx`**

```tsx
import { useState } from 'react'
import { displayAddress, FLAVOR_LABELS, probeSummary } from '@shared/endpoints'
import type { Endpoint, EndpointProbe } from '@shared/types'
import { Button, Field, Modal, TextField } from '@/components/ui'
import { api } from '@/lib/api'
import { selectEndpoints, useApp } from '@/stores/app'

const PRESETS = [
  { label: 'Ollama', port: 11434 },
  { label: 'LM Studio', port: 1234 },
  { label: 'llama.cpp', port: 8080 },
  { label: 'vLLM', port: 8000 }
] as const

// Electron prefixes errors thrown in ipcMain handlers; the dialog shows only the message.
const messageOf = (err: unknown) => (err instanceof Error ? err.message : String(err)).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')

/** A name for what was found: the server's kind, and its address when another endpoint has that name. */
function suggestName(found: EndpointProbe, endpoints: readonly Endpoint[]): string {
  const base = FLAVOR_LABELS[found.flavor]
  return endpoints.some((e) => e.name === base) ? `${base} (${displayAddress(found.baseUrl)})` : base
}

/** Add an endpoint: an address (and a key, if the server wants one) is checked first; then it's named and added. */
export function AddEndpointDialog({
  open,
  onOpenChange,
  onAdded
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onAdded: (endpoint: Endpoint) => void | Promise<void>
}) {
  const endpoints = useApp(selectEndpoints)
  const [address, setAddress] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [found, setFound] = useState<EndpointProbe | null>(null)
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Only Ollama can be added until OpenAI-compatible servers have an adapter.
  const supported = found?.kind === 'ollama'

  const close = (next: boolean) => {
    if (!next) {
      setAddress('')
      setApiKey('')
      setFound(null)
      setName('')
      setError(null)
    }
    onOpenChange(next)
  }

  const check = async () => {
    setBusy(true)
    setError(null)
    try {
      const probe = await api.endpoints.probe({ baseUrl: address, apiKey: apiKey.trim() || undefined })
      setFound(probe)
      setName(suggestName(probe, endpoints))
    } catch (err) {
      setError(messageOf(err))
    } finally {
      setBusy(false)
    }
  }

  const add = async () => {
    if (!found) return
    setBusy(true)
    setError(null)
    try {
      const endpoint = await api.endpoints.add({
        name: name.trim(),
        baseUrl: found.baseUrl,
        kind: found.kind,
        flavor: found.flavor,
        apiKey: apiKey.trim() || undefined
      })
      close(false)
      await onAdded(endpoint)
    } catch (err) {
      setError(messageOf(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      open={open}
      onOpenChange={close}
      title="Add an endpoint"
      description={found ? undefined : 'Ollama, LM Studio, llama.cpp or vLLM, on this Mac or another machine.'}
      footer={
        found ? (
          <>
            <Button
              variant="ghost"
              onClick={() => {
                setFound(null)
                setError(null)
              }}
            >
              Back
            </Button>
            <Button variant="primary" disabled={!supported || !name.trim()} loading={busy} onClick={() => void add()}>
              Add
            </Button>
          </>
        ) : (
          <>
            <Button variant="ghost" onClick={() => close(false)}>
              Cancel
            </Button>
            <Button variant="primary" disabled={!address.trim()} loading={busy} onClick={() => void check()}>
              Check
            </Button>
          </>
        )
      }
    >
      {found ? (
        <div className="space-y-4">
          <div className="rounded-ollmost border border-line bg-canvas p-3 text-sm">
            <div className="font-medium text-success">{probeSummary(found)}</div>
            <div className="mt-0.5 text-muted">at {displayAddress(found.baseUrl)}</div>
            {!supported && <div className="mt-2 text-muted">This server speaks the OpenAI API; support arrives in the next update.</div>}
          </div>
          {supported && (
            <Field label="Name">
              <TextField
                autoFocus
                value={name}
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && name.trim() && void add()}
              />
            </Field>
          )}
        </div>
      ) : (
        <div className="space-y-4">
          <div className="flex flex-wrap gap-1.5">
            {PRESETS.map((p) => (
              <button
                key={p.port}
                type="button"
                onClick={() => setAddress(`http://localhost:${p.port}`)}
                className="rounded-full bg-hover px-2.5 py-0.5 text-xs text-muted hover:text-fg"
              >
                {p.label} :{p.port}
              </button>
            ))}
          </div>
          <Field label="Address">
            <TextField
              autoFocus
              value={address}
              onChange={(e) => setAddress(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && address.trim() && void check()}
              placeholder="http://localhost:11434"
            />
          </Field>
          <Field label="API key" hint="Only if the server asks for one. It's stored encrypted and only ever sent to this server.">
            <TextField type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder="Optional" />
          </Field>
        </div>
      )}
      {error && <p className="mt-3 text-sm text-danger">{error}</p>}
    </Modal>
  )
}
```

- [ ] **Step 6: `src/renderer/src/views/settings/EndpointsPane.tsx`**

```tsx
import { Plus, RefreshCw, Trash2 } from 'lucide-react'
import { useState } from 'react'
import { DEFAULT_CONTEXT, DEFAULT_NUM_CTX, displayAddress, FLAVOR_LABELS, isOllamaCloudUrl, removalText } from '@shared/endpoints'
import { labelForKey, shortModelName } from '@shared/modelLabel'
import { resolveThinkProfile } from '@shared/thinking'
import type { Endpoint, ModelInfo, ModelListResult, ModelOverrides, Settings } from '@shared/types'
import { Badge, Button, Field, Switch, TextField } from '@/components/ui'
import { api } from '@/lib/api'
import { cn, formatContext } from '@/lib/format'
import { reportError, useApp } from '@/stores/app'
import { useConfirm } from '@/stores/confirm'
import { BlurField, Row, Section } from '../settingsParts'
import { AddEndpointDialog } from './AddEndpointDialog'
import { ApiKeyField } from './ApiKeyField'

// Settings → Models, master–detail (option B of the approved mockup): the endpoints on the left with "+ Add
// endpoint", "ollama.com account" and "Defaults"; the chosen one's settings and models on the right.

type Page = { kind: 'endpoint'; id: string } | { kind: 'account' } | { kind: 'defaults' }
type Status = 'ok' | 'offline' | 'off'

const DOT: Record<Status, string> = { ok: 'bg-success', offline: 'bg-danger', off: 'bg-subtle' }
const STATUS: Record<Status, string> = { ok: 'connected', offline: 'offline', off: 'turned off' }
const CONTEXT_SIZES = [8192, 16384, 32768, 65536, 131072]

const statusOf = (e: Endpoint, errors: ModelListResult['errors']): Status =>
  !e.enabled ? 'off' : errors.some((x) => x.endpointId === e.id) ? 'offline' : 'ok'

const THINK_OPTIONS: Array<{ value: ModelOverrides['think'] | 'auto'; label: string }> = [
  { value: 'auto', label: 'Automatic' },
  { value: 'toggle', label: 'On / off' },
  { value: 'levels', label: 'Effort levels' },
  { value: 'always', label: 'Always on' },
  { value: 'none', label: 'Hidden' }
]

/** A window-size menu. A saved size off the list keeps an option of its own. */
function ContextSelect({ value, onChange }: { value: number; onChange: (n: number) => void }) {
  const sizes = [...new Set([...CONTEXT_SIZES, value])].sort((a, b) => a - b)
  return (
    <select
      value={value}
      onChange={(e) => onChange(Number(e.target.value))}
      className="h-9 rounded-ollmost border border-line bg-canvas px-2 text-sm outline-none"
    >
      {sizes.map((n) => (
        <option key={n} value={n}>
          {formatContext(n)}
        </option>
      ))}
    </select>
  )
}

function ModelRow({ model }: { model: ModelInfo }) {
  const auto = resolveThinkProfile(model.name, model.capabilities)
  const set = async (patch: ModelOverrides) => {
    try {
      const updated = await api.models.setOverrides(model.key, { ...model.overrides, ...patch })
      useApp.setState((s) => ({ models: s.models.map((x) => (x.key === updated.key ? { ...updated, installed: x.installed } : x)) }))
    } catch (err) {
      reportError(err)
    }
  }
  return (
    <tr className="border-t border-line align-middle">
      <td className="py-2.5 pr-3">
        <div className="text-[13px] font-medium">{model.endpoint.kind === 'ollama' ? shortModelName(model.name) : model.name}</div>
        <div className="mt-0.5 flex gap-1">
          {model.capabilities
            .filter((c) => c !== 'completion')
            .map((c) => (
              <Badge key={c}>{c}</Badge>
            ))}
          {model.contextLength && <Badge>{formatContext(model.contextLength)}</Badge>}
        </div>
      </td>
      <td className="py-2.5 pr-3">
        {model.capabilities.includes('thinking') ? (
          <select
            value={model.overrides.think ?? 'auto'}
            onChange={(e) => void set({ think: e.target.value === 'auto' ? undefined : (e.target.value as ModelOverrides['think']) })}
            className="h-8 rounded-md border border-line bg-canvas px-1.5 text-xs outline-none"
          >
            {THINK_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.value === 'auto' ? `Automatic (${THINK_OPTIONS.find((x) => x.value === auto.kind)?.label ?? auto.kind})` : o.label}
              </option>
            ))}
          </select>
        ) : (
          <span className="text-xs text-subtle">n/a</span>
        )}
      </td>
      <td className="py-2.5 pr-3 text-center">
        <Switch label="Artifacts" checked={model.overrides.artifacts !== false} onChange={(v) => void set({ artifacts: v })} />
      </td>
      <td className="py-2.5 text-center">
        {model.capabilities.includes('tools') ? (
          <Switch label="Auto skills" checked={model.overrides.autoSkills !== false} onChange={(v) => void set({ autoSkills: v })} />
        ) : (
          <span className="text-xs text-subtle">n/a</span>
        )}
      </td>
    </tr>
  )
}

/** An endpoint's own key: kept encrypted, sent only to it. */
function EndpointKeyField({ endpoint }: { endpoint: Endpoint }) {
  const [key, setKey] = useState('')
  const endpointsChanged = useApp((s) => s.endpointsChanged)
  const save = async (value: string | null) => {
    try {
      await api.endpoints.setKey(endpoint.id, value)
      setKey('')
      await endpointsChanged()
    } catch (err) {
      reportError(err)
    }
  }
  return (
    <Field
      label="API key"
      hint={
        endpoint.hasKey
          ? `A key is saved, encrypted with your macOS keychain. It's only ever sent to ${endpoint.name}.`
          : "Only if the server asks for one. It's stored encrypted and only ever sent to this server."
      }
    >
      <div className="flex gap-2">
        <TextField type="password" value={key} onChange={(e) => setKey(e.target.value)} placeholder={endpoint.hasKey ? '••••••••••••' : 'None'} />
        <Button disabled={!key.trim()} onClick={() => void save(key.trim())}>
          Save
        </Button>
        {endpoint.hasKey && (
          <Button variant="ghost" onClick={() => void save(null)}>
            Remove
          </Button>
        )}
      </div>
    </Field>
  )
}

function EndpointPage({ endpoint, onAccount }: { endpoint: Endpoint; onAccount: () => void }) {
  const models = useApp((s) => s.models)
  const modelErrors = useApp((s) => s.modelErrors)
  const modelsLoading = useApp((s) => s.modelsLoading)
  const loadModels = useApp((s) => s.loadModels)
  const endpointsChanged = useApp((s) => s.endpointsChanged)
  const cloud = isOllamaCloudUrl(endpoint.baseUrl)
  const error = modelErrors.find((x) => x.endpointId === endpoint.id)?.message
  const mine = models.filter((m) => m.endpoint.id === endpoint.id)

  const update = async (patch: Parameters<typeof api.endpoints.update>[1]) => {
    try {
      await api.endpoints.update(endpoint.id, patch)
      await endpointsChanged()
    } catch (err) {
      reportError(err)
    }
  }
  const remove = async () => {
    try {
      const { title, body } = removalText(endpoint.name, await api.endpoints.removalImpact(endpoint.id))
      if (!(await useConfirm.getState().ask({ title, body, confirmLabel: 'Remove' }))) return
      await api.endpoints.remove(endpoint.id)
      await endpointsChanged()
    } catch (err) {
      reportError(err)
    }
  }

  return (
    <>
      <Section
        title={endpoint.name}
        description={`${FLAVOR_LABELS[endpoint.flavor]} at ${displayAddress(endpoint.baseUrl)} · ${STATUS[statusOf(endpoint, modelErrors)]}`}
      >
        <Field label="Name">
          <BlurField value={endpoint.name} onSave={(name) => void update({ name })} />
        </Field>
        <Field label="Address">
          <BlurField value={endpoint.baseUrl} onSave={(baseUrl) => void update({ baseUrl })} placeholder="http://127.0.0.1:11434" />
        </Field>
        {cloud ? (
          <Row label="API key" hint="ollama.com takes your ollama.com account key.">
            <Button size="sm" variant="ghost" onClick={onAccount}>
              ollama.com account
            </Button>
          </Row>
        ) : (
          <EndpointKeyField endpoint={endpoint} />
        )}
        {endpoint.kind === 'ollama' && !cloud && (
          <>
            <Row label="Context window" hint="Ollama's num_ctx for the models this server runs. Bigger remembers more but uses more memory.">
              <ContextSelect value={endpoint.numCtx ?? DEFAULT_NUM_CTX} onChange={(numCtx) => void update({ numCtx })} />
            </Row>
            <Row label="Show the Ollama cloud catalog" hint="List every cloud model, not only ones you've pulled.">
              <Switch checked={endpoint.showCloudCatalog ?? false} onChange={(showCloudCatalog) => void update({ showCloudCatalog })} />
            </Row>
          </>
        )}
        {endpoint.kind === 'openai' && (
          <Row label="Context when not reported" hint="The window assumed for a model whose server doesn't say.">
            <ContextSelect value={endpoint.defaultContext ?? DEFAULT_CONTEXT} onChange={(defaultContext) => void update({ defaultContext })} />
          </Row>
        )}
        <Row label="Enabled" hint="A turned-off endpoint's models leave the model picker; its chats keep their history.">
          <Switch checked={endpoint.enabled} onChange={(enabled) => void update({ enabled })} />
        </Row>
        <div>
          <Button size="sm" onClick={() => void remove()}>
            <Trash2 className="size-3.5 text-danger" /> Remove…
          </Button>
        </div>
      </Section>

      <Section
        title={`Models on ${endpoint.name}`}
        description="Thinking controls adapt to each model. Turn off artifacts or automatic skills for models that handle them poorly."
      >
        <div className="flex items-center gap-2">
          <Button size="sm" onClick={() => void loadModels(true)} loading={modelsLoading}>
            {!modelsLoading && <RefreshCw className="size-3.5" />} Refresh models
          </Button>
          {error && <span className="text-xs text-danger">{error}</span>}
        </div>
        {mine.length > 0 ? (
          <table className="w-full text-left">
            <thead>
              <tr className="text-xs text-subtle">
                <th className="pb-2 font-medium">Model</th>
                <th className="pb-2 font-medium">Thinking</th>
                <th className="pb-2 text-center font-medium">Artifacts</th>
                <th className="pb-2 text-center font-medium">Auto skills</th>
              </tr>
            </thead>
            <tbody>
              {mine.map((m) => (
                <ModelRow key={m.key} model={m} />
              ))}
            </tbody>
          </table>
        ) : (
          !error && (
            <p className="text-sm text-subtle">{endpoint.enabled ? 'This endpoint lists no models.' : 'Turn the endpoint on to list its models.'}</p>
          )
        )}
      </Section>
    </>
  )
}

function AccountPage({ settings }: { settings: Settings }) {
  const loadModels = useApp((s) => s.loadModels)
  return (
    <Section
      title="ollama.com account"
      description="Web search and page reading (for any model), your Ollama quota, and Ollama cloud models. Searches go through ollama.com even when the model runs on this Mac."
    >
      <ApiKeyField hasKey={settings.ollamaAccount.hasKey} onSaved={() => void loadModels(true)} />
    </Section>
  )
}

/** A default-model menu: each endpoint's models under its name, and a saved model that isn't listed marked as such. */
function ModelSelect({
  value,
  onChange,
  emptyLabel,
  endpoints
}: {
  value: string | null
  onChange: (key: string | null) => void
  emptyLabel: string
  endpoints: Endpoint[]
}) {
  const models = useApp((s) => s.models)
  return (
    <select
      value={value ?? ''}
      onChange={(e) => onChange(e.target.value || null)}
      className="h-9 w-64 rounded-ollmost border border-line bg-canvas px-2 text-sm outline-none"
    >
      <option value="">{emptyLabel}</option>
      {value && !models.some((m) => m.key === value) && <option value={value}>{labelForKey(value, endpoints)} (unavailable)</option>}
      {endpoints.map((e) => {
        const items = models.filter((m) => m.endpoint.id === e.id)
        return (
          items.length > 0 && (
            <optgroup key={e.id} label={e.name}>
              {items.map((m) => (
                <option key={m.key} value={m.key}>
                  {m.endpoint.kind === 'ollama' ? shortModelName(m.name) : m.name}
                  {m.where === 'cloud' ? ' (cloud)' : ''}
                </option>
              ))}
            </optgroup>
          )
        )
      })}
    </select>
  )
}

function DefaultsPage({ settings }: { settings: Settings }) {
  const updateSettings = useApp((s) => s.updateSettings)
  return (
    <Section title="Defaults">
      <Row label="Default model" hint="Used for new chats.">
        <ModelSelect
          value={settings.defaultModel}
          onChange={(defaultModel) => void updateSettings({ defaultModel })}
          emptyLabel="Last used"
          endpoints={settings.endpoints}
        />
      </Row>
      <Row label="Title model" hint="Names new chats. A small, fast model works well.">
        <ModelSelect
          value={settings.titleModel}
          onChange={(titleModel) => void updateSettings({ titleModel })}
          emptyLabel="Same as the chat"
          endpoints={settings.endpoints}
        />
      </Row>
    </Section>
  )
}

export function EndpointsPane({ settings }: { settings: Settings }) {
  const modelErrors = useApp((s) => s.modelErrors)
  const endpointsChanged = useApp((s) => s.endpointsChanged)
  const [page, setPage] = useState<Page>(() => (settings.endpoints[0] ? { kind: 'endpoint', id: settings.endpoints[0].id } : { kind: 'defaults' }))
  const [adding, setAdding] = useState(false)
  // A removed endpoint's page falls back to the first one left.
  const shown = page.kind === 'endpoint' ? (settings.endpoints.find((e) => e.id === page.id) ?? settings.endpoints[0]) : undefined
  const item = (active: boolean) =>
    cn(
      'flex h-8 w-full items-center gap-2 rounded-lg px-2 text-left text-[13px]',
      active ? 'bg-hover font-medium text-fg' : 'text-muted hover:bg-hover hover:text-fg'
    )

  return (
    <div className="flex gap-6">
      <nav aria-label="Endpoints" className="w-40 shrink-0 space-y-0.5 border-r border-line pr-3">
        {settings.endpoints.map((e) => (
          <button key={e.id} className={item(shown?.id === e.id)} onClick={() => setPage({ kind: 'endpoint', id: e.id })}>
            <span className={cn('size-2 shrink-0 rounded-full', DOT[statusOf(e, modelErrors)])} />
            <span className="truncate">{e.name}</span>
          </button>
        ))}
        <button className={item(false)} onClick={() => setAdding(true)}>
          <Plus className="size-3.5" /> Add endpoint
        </button>
        <div className="my-2 border-t border-line" />
        <button className={item(page.kind === 'account')} onClick={() => setPage({ kind: 'account' })}>
          ollama.com account
        </button>
        <button className={item(page.kind === 'defaults')} onClick={() => setPage({ kind: 'defaults' })}>
          Defaults
        </button>
      </nav>
      <div className="min-w-0 flex-1">
        {page.kind === 'endpoint' &&
          (shown ? (
            <EndpointPage key={shown.id} endpoint={shown} onAccount={() => setPage({ kind: 'account' })} />
          ) : (
            <p className="text-sm text-subtle">No endpoints yet. Add one to use its models.</p>
          ))}
        {page.kind === 'account' && <AccountPage settings={settings} />}
        {page.kind === 'defaults' && <DefaultsPage settings={settings} />}
      </div>
      <AddEndpointDialog
        open={adding}
        onOpenChange={setAdding}
        onAdded={async (e) => {
          await endpointsChanged()
          setPage({ kind: 'endpoint', id: e.id })
        }}
      />
    </div>
  )
}
```

- [ ] **Step 7: The Models tab renders the pane**

In `src/renderer/src/views/SettingsView.tsx`:

- delete `THINK_OPTIONS`, `ModelRow` and `ModelsTab`;
- `{tab === 'models' && <ModelsTab settings={settings} />}` → `{tab === 'models' && <EndpointsPane settings={settings} />}`,
  importing `EndpointsPane` from `'./settings/EndpointsPane'`;
- the master–detail needs the room: the content wrapper's `max-w-4xl` becomes
  `` className={cn('mx-auto flex w-full gap-10 px-8 pb-16 pt-4', tab === 'models' ? 'max-w-5xl' : 'max-w-4xl')} ``;
- drop the imports lint reports unused (`resolveThinkProfile`, `ModelInfo`, `ModelOverrides`, `Badge`, `modelLabel`,
  `formatContext` if nothing else uses them).

In `src/renderer/src/stores/confirm.ts`, the comment on `useConfirm` becomes:

```ts
/** A single pending confirmation, rendered by the one `ConfirmDialog` mounted near the app root. Used only where an
 *  action loses something: the history an Edit or a Retry would drop (see historyLoss), or what removing an endpoint
 *  deletes (see removalText). Keep it that narrow. */
```

- [ ] **Step 8: Run tests to verify they pass**

Run: `npx vitest run tests/endpointText.test.ts` then `npm run typecheck && npm run lint && npm run format:check && npm test`
Expected: PASS

- [ ] **Step 9: Check it by hand**

Run `npm run dev` and open Settings → Models.
- The left column lists "Ollama" with a green dot, then "+ Add endpoint", a rule, "ollama.com account" and "Defaults".
  The right shows Ollama's name, address, API key, context window, cloud catalog, Enabled and "Remove…", and below them
  "Models on Ollama" with the Thinking, Artifacts and Auto skills columns.
- Change the context window to 64K, then pick a local model in a new chat and send: the debugger's request shows
  `"num_ctx":65536`.
- "+ Add endpoint": click "Ollama :11434", then Check. It says "Ollama already uses this address." Type the address of
  another machine running Ollama (or `http://localhost:1234` with LM Studio running). Ollama: "Found Ollama 0.x · N
  models", a Name field, and Add adds it with its own dot and page. LM Studio: the found box says support arrives in
  the next update, and Add stays disabled.
- On the added endpoint's page, "Remove…": the dialog reads "Remove <name>? No chats use its models." (plus the key or
  model settings line if there are any). Remove, and the page falls back to Ollama.
- Turn Ollama's Enabled off: its dot turns grey and its models leave the picker. Turn it on again.
- "ollama.com account" shows the key field and the explanation. "Defaults" shows the two menus with each endpoint's
  models under its name.

- [ ] **Step 10: Commit**

```bash
git add -A src tests
git commit -m "Settings → Models is master–detail: endpoints on the left, one's settings and models on the right

Each endpoint has its address, key, context window and cloud catalog; removing one says first what goes. The
ollama.com account and the defaults have pages of their own. The Add endpoint dialog checks an address before
naming it, and adds Ollama servers.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 2.9: Unavailable models in the composer; the title-model fallback; PR

**Files:**
- Create: `src/shared/availability.ts`
- Modify: `src/renderer/src/components/Composer.tsx` (~31, 130, 148–168, 561, 586–592)
- Modify: `src/main/chat/service.ts` (`titleModelFor`; `generateTitle`)
- Test: `tests/availability.test.ts` (new); `tests/service.test.ts` (the title model)

**Interfaces:**
- Consumes: `keyPrefix`, `splitModelKey` (2.1); `labelForKey` (2.7); `modelsReady`, `modelErrors`, `selectEndpoints`,
  `loadModels` (2.7); `ModelPicker`'s `unavailable` prop (2.7); `resolve` (2.4).
- Produces: `modelAvailability(key, models, endpoints, errors)`, `ModelAvailability`,
  `unavailableText(reason, key, endpoints)`; `titleModelFor(chatModel)`.

- [ ] **Step 1: Write the failing tests**

`tests/availability.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { modelAvailability, unavailableText } from '../src/shared/availability'
import { toModelKey } from '../src/shared/modelKey'
import type { Endpoint, ModelInfo, ModelListResult } from '../src/shared/types'

const ep = (id: string, name: string, over: Partial<Endpoint> = {}): Endpoint => ({
  id,
  name,
  kind: 'ollama',
  flavor: 'ollama',
  baseUrl: 'http://127.0.0.1:11434',
  enabled: true,
  hasKey: false,
  ...over
})
const listed = (e: Endpoint, name: string) =>
  ({ key: toModelKey(e.id, name), name, endpoint: { id: e.id, name: e.name, kind: e.kind, flavor: e.flavor } }) as ModelInfo

const ollama = ep('ollama', 'Ollama')
const lm = ep('lm-studio', 'LM Studio', { kind: 'openai', flavor: 'lmstudio', baseUrl: 'http://localhost:1234/v1' })
const off = ep('gpu-box', 'GPU box', { enabled: false, baseUrl: 'http://192.168.1.20:11434' })
const endpoints = [ollama, lm, off]
const models = [listed(ollama, 'llama3.2'), listed(ollama, 'hf.co/bartowski/Qwen3-8B-GGUF:Q4_K_M')]
const errors: ModelListResult['errors'] = [{ endpointId: 'lm-studio', message: "Can't reach LM Studio at localhost:1234." }]
const check = (key: string | null) => modelAvailability(key, models, endpoints, errors)

describe('whether a chat’s model can be used', () => {
  it('is ok for a listed model, hf.co names and bare names from before keys included', () => {
    expect(check('ollama/llama3.2')).toBe('ok')
    expect(check('ollama/hf.co/bartowski/Qwen3-8B-GGUF:Q4_K_M')).toBe('ok')
    expect(check('llama3.2')).toBe('ok')
  })

  it('says why not: removed, turned off, offline, or no longer listed (Review Focus #2)', () => {
    expect(check('vllm/Qwen/Qwen3-32B')).toBe('endpoint-removed')
    expect(check('gpu-box/qwen3:8b')).toBe('endpoint-disabled')
    expect(check('lm-studio/qwen/qwen3-8b')).toBe('endpoint-offline')
    expect(check('ollama/mistral:7b')).toBe('model-missing')
    expect(check(null)).toBe('none')
  })

  it('words each reason for the composer, naming the model and its endpoint', () => {
    expect(unavailableText('endpoint-offline', 'lm-studio/qwen/qwen3-8b', endpoints)).toBe(
      "qwen/qwen3-8b · LM Studio is unavailable: Ollmost can't reach LM Studio."
    )
    expect(unavailableText('endpoint-disabled', 'gpu-box/qwen3:8b', endpoints)).toBe(
      'qwen3:8b is unavailable: GPU box is turned off in Settings → Models. Turn it on, or pick another model.'
    )
    expect(unavailableText('endpoint-removed', 'vllm/Qwen/Qwen3-32B', endpoints)).toBe(
      'vllm/Qwen/Qwen3-32B is unavailable: its endpoint was removed. Pick another model to keep chatting.'
    )
    expect(unavailableText('model-missing', 'ollama/mistral:7b', endpoints)).toBe(
      'mistral:7b is unavailable: Ollama doesn’t list it any more. Pick another model.'
    )
  })
})
```

In `tests/service.test.ts`, add `afterEach` to the vitest import if it isn't there, and `invalidateProviders` is already
imported (Task 2.4). Add:

```ts
describe('the title model', () => {
  afterEach(() => {
    updateSettings({ titleModel: null })
    setEndpoints(getSettings().endpoints.filter((e) => e.id !== 'off'))
    invalidateProviders()
  })

  it('titles with the model set in Settings', async () => {
    updateSettings({ titleModel: 'ollama/tiny-title' })
    chat = reply('Hi')
    start()
    await waitFor(() => titleCalls.length > 0)
    expect(titleCalls[0].model).toBe('tiny-title')
  })

  it('falls back to the chat’s model when the title model’s endpoint is gone or turned off', async () => {
    setEndpoints([
      ...getSettings().endpoints,
      { id: 'off', name: 'Off box', kind: 'ollama', flavor: 'ollama', baseUrl: 'http://10.0.0.9:11434', enabled: false }
    ])
    invalidateProviders()
    for (const titleModel of ['lm-studio/qwen/qwen3-8b', 'off/tiny-title']) {
      updateSettings({ titleModel })
      titleCalls = []
      chat = reply('Hi')
      start()
      await waitFor(() => titleCalls.length > 0)
      expect(titleCalls[0].model).toBe('llama3.2')
    }
  })
})
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run tests/availability.test.ts tests/service.test.ts`
Expected: FAIL. `../src/shared/availability` doesn't exist ("Does the file exist?"), and "falls back to the chat's
model" times out ("timed out waiting"): the gone title model's request is never made, so the chat gets a title cut
from its first message. "titles with the model set in Settings" already passes; it pins the ordinary case.

- [ ] **Step 3: `src/shared/availability.ts`**

```ts
// Whether a chat's model can be used right now, and if not, why: the composer says so and won't send until another
// model is picked.
import { labelForKey } from './modelLabel'
import { keyPrefix, splitModelKey } from './modelKey'
import type { Endpoint, ModelInfo, ModelListResult } from './types'

export function modelAvailability(
  key: string | null,
  models: readonly ModelInfo[],
  endpoints: readonly Endpoint[],
  errors: ModelListResult['errors']
): 'ok' | 'none' | 'endpoint-removed' | 'endpoint-disabled' | 'endpoint-offline' | 'model-missing' {
  if (!key) return 'none'
  const ids = endpoints.map((e) => e.id)
  // A prefix shaped like an endpoint id that names none: that endpoint was removed (see registry.resolve).
  const prefix = keyPrefix(key)
  if (prefix !== null && !ids.includes(prefix)) return 'endpoint-removed'
  const { endpointId, model } = splitModelKey(key, ids)
  const endpoint = endpoints.find((e) => e.id === endpointId)
  if (!endpoint) return 'endpoint-removed'
  if (!endpoint.enabled) return 'endpoint-disabled'
  // By endpoint and name, so a bare name from before keys still finds its Ollama model.
  if (models.some((m) => m.endpoint.id === endpointId && m.name === model)) return 'ok'
  if (errors.some((e) => e.endpointId === endpointId)) return 'endpoint-offline'
  return 'model-missing'
}

export type ModelAvailability = ReturnType<typeof modelAvailability>

/** What the composer says under an unavailable model: its name, and what to do. */
export function unavailableText(reason: ModelAvailability, key: string, endpoints: readonly Endpoint[]): string {
  const label = labelForKey(key, endpoints)
  const endpoint = endpoints.find((e) => e.id === splitModelKey(key, endpoints.map((x) => x.id)).endpointId)?.name ?? 'its endpoint'
  switch (reason) {
    case 'endpoint-removed':
      return `${label} is unavailable: its endpoint was removed. Pick another model to keep chatting.`
    case 'endpoint-disabled':
      return `${label} is unavailable: ${endpoint} is turned off in Settings → Models. Turn it on, or pick another model.`
    case 'endpoint-offline':
      return `${label} is unavailable: Ollmost can't reach ${endpoint}.`
    case 'model-missing':
      return `${label} is unavailable: ${endpoint} doesn’t list it any more. Pick another model.`
    default:
      return ''
  }
}
```

- [ ] **Step 4: The composer says so and won't send**

In `src/renderer/src/components/Composer.tsx`:

- imports: `import { modelAvailability, unavailableText } from '@shared/availability'` and
  `import { findModel, reportError, selectEndpoints, thinkProfileFor, useApp } from '@/stores/app'`.
- in `Composer`, the store line (~130) becomes
  `const { models, modelErrors, modelsReady, loadModels, skills: allSkills, navigate, mcpServers, mcpStatus, settings: appSettings } = useApp()`,
  followed by `const endpoints = useApp(selectEndpoints)`.
- `canSend` (~168) becomes:

  ```ts
    // Until the first listing ends, a chat's model can't be told from a missing one, so nothing is blocked yet.
    const availability = modelsReady ? modelAvailability(settings.model, models, endpoints, modelErrors) : 'ok'
    const unavailable = availability !== 'ok' && availability !== 'none'
    const canSend = !!settings.model && !unavailable && !uploading && !submitting && (text.trim().length > 0 || pending.length > 0)
  ```

- the picker (~561) becomes `<ModelPicker value={settings.model} onChange={settings.setModel} unavailable={unavailable} />`.
- after the `visionMissing` paragraph (~592), add:

  ```tsx
        {unavailable && settings.model && (
          <p className="mt-2 flex items-center gap-1.5 px-2 text-xs text-muted">
            <TriangleAlert className="size-3.5 shrink-0 text-danger" />
            <span>{unavailableText(availability, settings.model, endpoints)}</span>
            {availability === 'endpoint-offline' && (
              <button className="text-accent hover:underline" onClick={() => void loadModels(true)}>
                Retry
              </button>
            )}
          </p>
        )}
  ```

- [ ] **Step 5: The title model falls back to the chat's**

In `src/main/chat/service.ts`, add above `generateTitle`:

```ts
/** The model that titles a chat: the one set in Settings, unless its endpoint is gone or turned off; then the chat's own. */
export function titleModelFor(chatModel: string): string {
  const titleModel = getSettings().titleModel
  if (!titleModel) return chatModel
  try {
    resolve(titleModel)
    return titleModel
  } catch {
    return chatModel
  }
}
```

and in `generateTitle`, `const modelName = getSettings().titleModel || chatModel` becomes
`const modelName = titleModelFor(chatModel)`.

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx vitest run tests/availability.test.ts tests/service.test.ts` then `npm run typecheck && npm run lint && npm run format:check && npm test`
Expected: PASS

- [ ] **Step 7: Check it by hand**

Run `npm run dev`.
- Add a second Ollama endpoint (another machine, or `ollama serve` on another port with `OLLAMA_HOST=127.0.0.1:11435`),
  start a chat on one of its models, then turn it off in Settings → Models. Back in the chat, the picker reads
  "<model> · unavailable", the line under the composer says it's turned off, and Send is disabled. Pick another model:
  the line goes and Send works, in the same chat.
- Turn it on again and stop that server: the line says Ollmost can't reach it, with Retry. Start it and click Retry: the
  line goes.
- Remove the endpoint (the dialog says "1 chat uses its models; …"). The chat says its endpoint was removed.
- Settings → Models → Defaults: set the title model to one of that endpoint's models before removing it; after removing,
  the menu is back on "Same as the chat". Set a title model, turn its endpoint off, start a new chat: it's still titled
  (by the chat's model).

- [ ] **Step 8: Commit**

```bash
git add -A src tests
git commit -m "A chat whose model can't be reached says why and won't send; titles fall back to the chat's model

Removed, turned-off and offline endpoints and missing models each get a line under the composer (with Retry when
offline), and the picker marks the model unavailable until another is picked.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 9: Check the whole PR, then open it**

Run: `npm run typecheck && npm run lint && npm run format:check && npm test`
Expected: PASS

Run: `git grep -nE "(m|model|current)\.location|location: '(cloud|local)'|connectionMode|ollamaConnection|displayModelName|effectiveContext|localNumCtx" -- src tests`
Expected: no output.

Run: `npm run build && npm run e2e` (the Ollama app running, and `ollama signin` done, as the e2e always needs)
Expected: every check passes, as on `main`, including `PASS  the Kiln stand-in undoes every migration since Kiln` and
`PASS  the API key and the server's values are asked for again`. From this PR on the e2e stays green; PR 5 only folds
its fakes into one factory and adds the endpoints section.

```bash
git push -u origin claude/model-endpoints-identity
gh pr create --title "Model endpoints: keys, several Ollama endpoints, endpoint chips and Settings → Models" --body "$(cat <<'EOF'
## Summary

PR 2 of the model endpoints plan (spec: `docs/superpowers/specs/2026-09-27-model-endpoints-design.md`).

- **Model identity is a key**, `endpointId/model`. Existing chats, messages, usage rows, traces and model settings are
  migrated onto the endpoint `ollama` in one appended migration. The database is copied first to
  `backups/ollmost-before-endpoints-<day>.db`, since an older Ollmost can't read keys. Settings turn `connection` into
  that endpoint and key the default and title models.
- **Several endpoints at once.** One provider per enabled endpoint, listed in parallel. One that's down is reported on
  its own, and the others still list. Each endpoint gets only its own key; ollama.com gets the account key.
- **`ModelInfo.location` is split** into `where` (cloud / this Mac / network), `billing` (priced / local / untracked),
  `contextControl` and `contextWindow`. Usage rows record the key and `billing`, and only Ollama cloud rows are priced.
- **Picker (option B):** endpoint chips under the search box, an offline endpoint as a dashed ⚠ chip with its error and
  Retry, a section per endpoint with the current one first.
- **Settings → Models (option B):** master–detail, with the endpoints, "+ Add endpoint", "ollama.com account" and
  "Defaults". Removing an endpoint says first what goes. The Add endpoint dialog checks an address and adds Ollama
  servers; it recognises an OpenAI-compatible server but can't add one until PR 3.
- A chat whose model is removed, turned off, offline or missing says so and won't send until another model is picked.
  A title model that can't be resolved falls back to the chat's model.

## Review focus

- `hf.co/bartowski/Qwen3-8B-GGUF:Q4_K_M` survives the migration and reaches Ollama whole (`tests/modelKey.test.ts`,
  `tests/endpointsMigration.test.ts`, `tests/service.test.ts`).
- An endpoint that refuses connections doesn't empty the picker (`tests/registry.test.ts`, `tests/pickerGroups.test.ts`,
  `tests/availability.test.ts`).
- `localhost:1234`, `http://localhost:1234/` and `http://localhost:1234/v1/` are one address, and a second endpoint on
  it is refused (`tests/probe.test.ts`, `tests/endpoints.test.ts`).

## Test plan

- [x] `npm run typecheck && npm run lint && npm run format:check && npm test`
- [x] `npm run build && npm run e2e`: every check passes (the fakes point at the `ollama` endpoint through the endpoints
      IPC, and the Kiln stand-in undoes the model-key migration)
- [ ] `OLLMOST_INSTALL_DIR=~/Applications npm run install:mac`, then open an existing chat, check the backup in the
      data folder, add and remove an endpoint, and turn one off with a chat on it

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

Expected: the PR URL. Merge only when the user says so.

- [ ] **Step 10: The user's install check**

Tell the user the PR is open and ask them to run:

```bash
OLLMOST_INSTALL_DIR=~/Applications npm run install:mac
```

Then, in the installed app: the existing chats open on their models; `~/Library/Application Support/Ollmost/backups/`
holds `ollmost-before-endpoints-<today>.db`; Settings → Models shows Ollama with its old address, context window and
cloud catalog setting; and the checks from Tasks 2.7–2.9 hold.


---

## PR 3 — The OpenAI-compatible adapter

Branch: `claude/model-endpoints-openai`, from `main` after PR 2 (`claude/model-endpoints-identity`) merges.

After this PR, LM Studio, llama.cpp's `llama-server`, vLLM and any other OpenAI-compatible server can be added in
Settings → Models, their models appear in the picker, and a chat on one streams replies, shows reasoning, runs tool
rounds and saves exactly what an Ollama chat saves. It is the first release where LM Studio works.

## Contract additions (PR 3)

PR 3 uses these names on top of the Shared contracts and PR 1's and PR 2's additions. PR 4 and PR 5 use them as written.

```ts
// ---- src/main/providers/stream.ts ----
export interface StallTimer { arm(ms: number, message: string): void; stalled(): string | null; clear(): void }
// StreamTimeouts and STREAM_TIMEOUTS move here from providers/ollama/wire.ts, which re-exports both unchanged.

// ---- src/main/providers/openai/sse.ts ----
// sseData's return value (the contract said AsyncGenerator<string>): true when the stream ended at `data: [DONE]`,
// false when it just ended.
export function sseData(body: ReadableStream<Uint8Array>): AsyncGenerator<string, boolean>

// ---- src/main/providers/openai/toolCalls.ts ----
// createToolCallAccumulator().finish(): a call the server sent without an id gets 't' + n.toString(36).padStart(8, '0'),
// n its place among that stream's calls (t00000000…): 9 letters and digits, the only id shape Mistral's chat templates
// on vLLM accept. An id the server sent is kept as it is.

// ---- src/main/providers/openai/thinkSplitter.ts ----
export const THINK_NEAR_START = 64      // how far into a reply a `</think>` still closes a block the template opened
export interface ThinkSplit { content: string; thinking: string }

// ---- src/main/providers/openai/body.ts ----
export const EMPTY_TOOL_CALL_CONTENT: '' | null   // an assistant message's content beside tool_calls ('' unless FINDINGS Q5)

// ---- src/main/providers/openai/errors.ts ----
export class OpenAIError extends Error { constructor(message: string, readonly status?: number) }
export function unreachableError(endpoint: Pick<Endpoint, 'name' | 'baseUrl' | 'flavor'>): OpenAIError

// ---- src/main/providers/openai/discovery.ts ----
// DiscoveredModel (the contract's interface) is defined and exported here.
export function rootOf(baseUrl: string): string                  // baseUrl without a trailing /v1
export function getJson(endpoint: Pick<Endpoint, 'name' | 'baseUrl' | 'flavor'>, url: string, apiKey: string | null, timeoutMs?: number): Promise<unknown>

// ---- src/main/providers/openai/adapter.ts ----
// class OpenAIProvider implements Provider: constructor(endpoint: Endpoint, opts?: { timeouts?: StreamTimeouts });
// it implements PR 1's wireEndpoint() and PR 2's readonly endpoint.

// ---- src/main/providers/registry.ts ----
export function createProvider(endpoint: Endpoint): Provider      // OpenAIProvider for kind 'openai', else OllamaProvider
export function redetectModel(key: string): Promise<ModelInfo>    // behind the models.redetect IPC

// ---- src/main/providers/probe.ts (PR 2's file) ----
export function apiBaseUrl(input: string): string   // the address as typed, cleaned, its path whole: an OpenAI endpoint's API base

// ---- src/main/providers/endpoints.ts (PR 2's file) ----
// addEndpoint stores the kind and flavour it's given: an OpenAI-compatible endpoint by its API base (apiBaseUrl of the
// address the probe confirmed), never the root normalizeBaseUrl gives. updateEndpoint becomes async (Contract changes 4).

// ---- src/main/settings.ts ----
export function setEndpointStreamOptions(id: string, supported: boolean): void   // through PR 2's setEndpoints

// ---- src/main/db/kv.ts ----
// CachedModelInfo gains: thinkPreset?: ThinkProfile['kind'] | null   (OpenAI-compatible models only)

// ---- src/shared/types.ts ----
// ModelInfo gains (both optional, so PR 2's literals still compile):
//   thinkPreset?: ThinkProfile['kind'] | null                         the profile the server reported (LM Studio)
//   auto?: { capabilities: string[]; contextWindow: number | null }    what applies without the user's overrides

// ---- src/shared/thinking.ts ----
export function resolveThinkProfile(model: string, capabilities: string[], override?: ThinkProfile['kind'], preset?: ThinkProfile['kind']): ThinkProfile

// ---- src/shared/endpoints.ts (PR 2's file) ----
// probeSummary(p) is PR 2's, unchanged: it already words a server that reports no capabilities as the spec does.
export function probeContextNote(p: Pick<EndpointProbe, 'reportsContext'>): string
export function suggestEndpointName(p: Pick<EndpointProbe, 'flavor'>, taken: readonly string[]): string

// ---- src/shared/ipc.ts ----
// models.redetect(key: string): Promise<ModelInfo>   (PR 2 leaves it to PR 3; channel 'redetect' added)

// ---- src/main/chat/rounds.ts ----
// RoundsResult.genMs: Σ per round of done.timing.genMs, else first token → done (the contract's fallback; PR 1 deferred it)

// ---- renderer ----
// views/settings/EndpointsPane.tsx: ModelRow({ model }) gains Tools | Vision | Context and a Re-detect link. PR 2's
// endpoint page already has an OpenAI endpoint's own fields ("Context when not reported", its API key), so PR 3 adds none.
// views/settings/AddEndpointDialog.tsx: adds every flavour; its name starts as suggestEndpointName(...).

// ---- tests/ollamaMock.ts ----
// Task 3.1: sse(obj), sseDone, sseDelta(delta, finishReason?, extra?), streamSse(res, chunks, pauseMs?), FIXTURES,
//   fixtureText(path), fixtureJson(path), byteChunks(text, size), capturedChunks(path)
// Task 3.10: type Dialect = 'ollama' | 'openai', interface Turn, turnChunks(dialect, turn, opts?), writeTurn(res, dialect, turn, opts?),
//   completionJson(content)
```

## Contract changes (PR 3)

1. **`createStallTimer(abort: () => void)` drops the `timeouts` parameter.** None of the timer's methods reads it: each
   wire arms it with the milliseconds it chose (`firstByteMs`, then `idleMs` or `toolIdleMs`). Only PR 3 uses the
   timer.
2. **`friendlyOpenAIError` takes `Pick<Endpoint, 'name' | 'baseUrl' | 'flavor'>`,** not a whole `Endpoint`: discovery
   and the probe call it before an endpoint exists. Every `Endpoint` still fits, so no caller changes.
3. **The tok/s fallback now covers every server,** Ollama's cloud models included, as the spec says ("tok/s uses
   `done.timing.genMs`, or else the time from the first token to `done`"). PR 1 deferred it to this PR. Cloud replies
   start showing a tok/s figure measured on this Mac; nothing else about them changes. The PR body and the README's
   known limits say so (Task 3.10).
4. **`updateEndpoint(id, patch)` returns `Promise<Endpoint>`** (PR 2's was synchronous). An OpenAI-compatible server's
   API base isn't always its root plus `/v1`, so an edited address is probed again and what the probe confirmed is
   stored, as when the endpoint was added. Its only caller is the `endpoints.update` IPC handler, already `async`; PR 2's
   two `updateEndpoint` tests `await` it (Task 3.6).

## Assumed from PR 1 and PR 2

These come from PR 1's and PR 2's sections of this plan, and match them as written.

- **PR 1:** `Provider.wireEndpoint()`; a `content` event may carry `''` ("a chunk arrived with nothing in it"); `done.raw`
  is the server's closing record without the reply's text; the capture spike writes `capture/out/lmstudio/<case>.sse`
  (and `.json`) with a `<case>.meta.json` beside each, and `capture/FINDINGS.md` answers questions 1–6. Ids Ollmost
  makes up are 9 letters and digits (`t00000000` for a call without one, `c00010000` for an earlier turn's call).
  `runRounds` keeps #175's batches (`parallel`, `batchesOf`, `runTogether`): a batch's results go back in call order,
  each `{ role: 'tool', content, toolName, toolCallId }`.
- **PR 2:** `src/shared/endpoints.ts` (`DEFAULT_CONTEXT`, `FLAVOR_LABELS`, `displayAddress`, `whereOf`,
  `probeSummary`); `src/main/settings.ts` (`StoredEndpoint`, `setEndpoints`); `src/main/providers/endpoints.ts`
  (`addEndpoint`, which refuses `kind: 'openai'` with a message ending "…arrives in the next update" and otherwise
  builds an Ollama endpoint with its address normalised to the root; `updateEndpoint`, synchronous, which also
  normalises an edited address to the root; `probeNewEndpoint`, `assertAddressFree`, and the private `FLAVORS`,
  `stored()`, `find()`, `save()`, `cleanName()`); `src/main/providers/context.ts` (`contextWindowFor`, already with the
  full server-side precedence); `src/main/providers/where.ts` (`whereOf`, `billingOf`); the registry's `build()`, which
  makes `new OllamaProvider(endpoint)` for each enabled Ollama endpoint; `providers/ollama/models.ts`'s `toModelInfo`;
  `readModelProfile(key)` with `detected`, `writeModelDetected`; `providers/probe.ts`'s `normalizeBaseUrl` (returns the
  root, `/v1` dropped: what addresses are compared by) and `probeEndpoint` (returns the address to store: Ollama's root,
  or `<root>/v1` for an OpenAI-compatible server); PR 2's tests `tests/probe.test.ts`, `tests/endpoints.test.ts` and
  `tests/endpointText.test.ts`.
- **PR 2's renderer (Tasks 2.7–2.8):** the store's `endpointsChanged()` action and `selectEndpoints` selector.
  `src/renderer/src/views/settings/EndpointsPane.tsx` holds the endpoint page and its models table, whose row component
  is `ModelRow({ model })` (it saves overrides itself and puts the model read back into the store by key). The page
  renders its Ollama-only fields under `endpoint.kind === 'ollama'`, and already has an OpenAI endpoint's
  "Context when not reported" row (`endpoint.kind === 'openai'`) and, for every endpoint not on ollama.com, its own API
  key field (`EndpointKeyField`). `src/renderer/src/views/settings/AddEndpointDialog.tsx` probes with
  `api.endpoints.probe`, keeps the result in `found`, shows `probeSummary(found)` in step 2, names it with its own
  `suggestName()`, and refuses a probe whose `kind` isn't `'ollama'` through `const supported = found?.kind === 'ollama'`.

## Before Task 3.1

- [ ] **Step 1: Branch**

```bash
git switch main && git pull --ff-only
git switch -c claude/model-endpoints-openai
```

- [ ] **Step 2: Re-read what this PR builds on**

Read, on the branch as PR 2 left it: `src/main/providers/{types,registry,probe,endpoints,context,where,secrets}.ts`,
`src/main/providers/ollama/{wire,models,adapter}.ts`, `src/main/chat/rounds.ts`, `src/shared/endpoints.ts`,
`src/shared/thinking.ts`, `src/main/db/kv.ts`, `src/main/settings.ts`, `src/renderer/src/views/settings/*.tsx`,
`tests/ollamaMock.ts`, `tests/client.test.ts`, `tests/service.test.ts`, and
`docs/superpowers/plans/2026-09-27-model-endpoints-capture/FINDINGS.md`. Code on the branch wins over this plan's line numbers,
never over its behaviour.

Test commands are `npx vitest run <file>`. Every task ends with
`npm run typecheck && npm run lint && npm run format:check && npm test` green. Before that check, run
`npx prettier --write` on the files the task touched: the plan's code is right, but not always laid out the way Prettier
prints it.

---

### Task 3.1: SSE mock helpers and fixtures from the spike

**Files:**
- Modify: `tests/ollamaMock.ts` (imports at the top; helpers appended)
- Modify: `.prettierignore` (fixtures are kept byte for byte)
- Create (copied from the spike): `tests/fixtures/sse/lmstudio-{plain,plain-no-usage,tool-single,tool-parallel}.sse` and their `.meta.json`; `tests/fixtures/sse/lmstudio-think-default.sse` (+ `.meta.json`) when captured; `tests/fixtures/discovery/lmstudio-models-cold.json`, `lmstudio-models-loaded.json`, `lmstudio-v1-models.json`; `tests/fixtures/once/lmstudio-{plain,tool-single,error-unknown-model}.json` and `lmstudio-error-unknown-model.meta.json`
- Create (from docs): `tests/fixtures/sse/{llamacpp-reasoning,llamacpp-tools,vllm-reasoning,vllm-tools}.sse`, `tests/fixtures/discovery/{llamacpp-props,llamacpp-models,vllm-models,generic-models}.json`
- Test: `tests/sseFixtures.test.ts`

**Interfaces:**
- Consumes: `startMockOllama`, `line`, `streamChunks` (today's `tests/ollamaMock.ts`); the spike's
  `capture/out/lmstudio/*` (Task 0.1).
- Produces: `sse(obj: unknown): string`, `sseDone: string`,
  `sseDelta(delta: Record<string, unknown>, finishReason?: string | null, extra?: Record<string, unknown>): string`,
  `streamSse(res: ServerResponse, chunks: Array<string | Uint8Array>, pauseMs?: number): Promise<void>`,
  `FIXTURES: string`, `fixtureText(path: string): string`, `fixtureJson<T>(path: string): T`,
  `byteChunks(text: string, size: number): Uint8Array[]`, `capturedChunks(path: string): Uint8Array[]`; the fixture files.

- [ ] **Step 1: Write the failing test**

`tests/sseFixtures.test.ts`:
```ts
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { byteChunks, capturedChunks, FIXTURES, fixtureJson, fixtureText, sse, sseDelta, sseDone } from './ollamaMock'

const sseFiles = readdirSync(join(FIXTURES, 'sse')).filter((f) => f.endsWith('.sse'))
const payloads = (file: string) =>
  fixtureText(`sse/${file}`)
    .split('\n')
    .map((l) => l.replace(/\r$/, ''))
    .filter((l) => l.startsWith('data:'))
    .map((l) => l.slice('data:'.length).trim())

describe('SSE mock helpers', () => {
  it('frames one event per call, and ends a stream with [DONE]', () => {
    expect(sse({ a: 1 })).toBe('data: {"a":1}\n\n')
    expect(sseDone).toBe('data: [DONE]\n\n')
    expect(JSON.parse(sseDelta({ content: 'hi' }).slice('data: '.length))).toMatchObject({
      object: 'chat.completion.chunk',
      choices: [{ index: 0, delta: { content: 'hi' }, finish_reason: null }]
    })
    expect(JSON.parse(sseDelta({}, 'stop').slice('data: '.length)).choices[0].finish_reason).toBe('stop')
  })

  it('splits text into byte pieces, a character across two if need be', () => {
    const pieces = byteChunks('é!', 1)
    expect(pieces.map((p) => p.length)).toEqual([1, 1, 1])
    expect(Buffer.concat(pieces).toString('utf8')).toBe('é!')
  })
})

describe('fixtures', () => {
  it('has the LM Studio captures and the fixtures written from docs', () => {
    expect(sseFiles).toEqual(
      expect.arrayContaining([
        'lmstudio-plain.sse',
        'lmstudio-plain-no-usage.sse',
        'lmstudio-tool-single.sse',
        'lmstudio-tool-parallel.sse',
        'llamacpp-reasoning.sse',
        'llamacpp-tools.sse',
        'vllm-reasoning.sse',
        'vllm-tools.sse'
      ])
    )
    for (const f of ['lmstudio-models-cold.json', 'lmstudio-models-loaded.json', 'lmstudio-v1-models.json'])
      expect(existsSync(join(FIXTURES, 'discovery', f))).toBe(true)
  })

  it.each(sseFiles)('%s is a finished stream of JSON chunks', (file) => {
    const data = payloads(file)
    expect(data.at(-1)).toBe('[DONE]')
    const chunks = data.slice(0, -1).map((d) => JSON.parse(d) as { choices?: Array<{ finish_reason?: string | null }> })
    expect(chunks.some((c) => c.choices?.[0]?.finish_reason)).toBe(true)
  })

  it('replays a capture in the pieces it arrived in', () => {
    const whole = Buffer.from(fixtureText('sse/lmstudio-plain.sse'))
    const pieces = capturedChunks('sse/lmstudio-plain.sse')
    expect(pieces.length).toBeGreaterThan(1)
    expect(Buffer.concat(pieces).equals(whole)).toBe(true)
  })

  it('marks every fixture written from docs as unverified', () => {
    const fromDocs = [
      ...sseFiles.filter((f) => !f.startsWith('lmstudio-')).map((f) => `sse/${f}`),
      'discovery/llamacpp-props.json',
      'discovery/llamacpp-models.json',
      'discovery/vllm-models.json',
      'discovery/generic-models.json'
    ]
    for (const f of fromDocs) expect(readFileSync(join(FIXTURES, f), 'utf8').startsWith('# unverified: written from docs\n')).toBe(true)
  })

  it('reads JSON fixtures past their marker line', () => {
    expect(fixtureJson<{ data: unknown[] }>('discovery/vllm-models.json').data).toHaveLength(1)
    expect(Array.isArray(fixtureJson<{ models: unknown[] }>('discovery/lmstudio-models-cold.json').models)).toBe(true)
  })

  it('holds no credentials', () => {
    for (const f of sseFiles) expect(fixtureText(`sse/${f}`)).not.toMatch(/authorization|bearer /i)
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/sseFixtures.test.ts`
Expected: FAIL with "ENOENT: no such file or directory" (for `tests/fixtures/sse`), or "sse is not a function".

- [ ] **Step 3: Add the SSE helpers to `tests/ollamaMock.ts`**

Replace the two `node:` imports at the top with:
```ts
import { existsSync, readFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { resolve } from 'node:path'
```
(keep any other import PR 1 or PR 2 added), and append:
```ts
// ---- OpenAI-compatible servers: server-sent events (PR 3) ----

/** One server-sent event carrying `obj` as its data. */
export const sse = (obj: unknown): string => `data: ${JSON.stringify(obj)}\n\n`

/** OpenAI's end-of-stream marker. */
export const sseDone = 'data: [DONE]\n\n'

/** A chat.completion.chunk event with one choice, as OpenAI-compatible servers stream them. */
export const sseDelta = (delta: Record<string, unknown>, finishReason: string | null = null, extra: Record<string, unknown> = {}): string =>
  sse({ id: 'chatcmpl-mock', object: 'chat.completion.chunk', created: 0, model: 'mock', choices: [{ index: 0, delta, finish_reason: finishReason }], ...extra })

/** Write SSE text, or raw bytes (to split a character mid-sequence), optionally pausing between pieces. */
export async function streamSse(res: ServerResponse, chunks: Array<string | Uint8Array>, pauseMs = 0): Promise<void> {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
  for (const c of chunks) {
    res.write(c)
    if (pauseMs) await new Promise((r) => setTimeout(r, pauseMs))
  }
}

// Vitest runs from the repo root (vitest.config.ts resolves '@shared' the same way).
export const FIXTURES = resolve('tests/fixtures')

/** A fixture's text, without the `#` marker lines that fixtures written from docs start with. */
export function fixtureText(path: string): string {
  return readFileSync(resolve(FIXTURES, path), 'utf8').replace(/^(#[^\n]*\n)+/, '')
}

export const fixtureJson = <T = unknown>(path: string): T => JSON.parse(fixtureText(path)) as T

/** `text` as UTF-8 bytes in pieces of `size`, so framing, and multi-byte characters, split anywhere. */
export function byteChunks(text: string, size: number): Uint8Array[] {
  const bytes = Buffer.from(text)
  const out: Uint8Array[] = []
  for (let i = 0; i < bytes.length; i += size) out.push(bytes.subarray(i, i + size))
  return out
}

/** A captured stream in the network pieces it arrived in (its .meta.json records their sizes). */
export function capturedChunks(path: string): Uint8Array[] {
  const bytes = Buffer.from(fixtureText(path))
  const metaPath = resolve(FIXTURES, path.replace(/\.[a-z]+$/, '.meta.json'))
  if (!existsSync(metaPath)) return [bytes]
  const { chunks } = JSON.parse(readFileSync(metaPath, 'utf8')) as { chunks: Array<{ bytes: number }> }
  const out: Uint8Array[] = []
  let at = 0
  for (const { bytes: n } of chunks) {
    out.push(bytes.subarray(at, at + n))
    at += n
  }
  return at < bytes.length ? [...out, bytes.subarray(at)] : out
}
```

- [ ] **Step 4: Keep the fixtures out of Prettier**

Append to `.prettierignore`:
```
tests/fixtures/sse/
tests/fixtures/discovery/
tests/fixtures/once/
```

- [ ] **Step 5: Copy the LM Studio captures**

```bash
CAP=docs/superpowers/plans/2026-09-27-model-endpoints-capture/out/lmstudio
mkdir -p tests/fixtures/sse tests/fixtures/discovery tests/fixtures/once
for c in plain plain-no-usage tool-single tool-parallel think-default; do
  [ -f "$CAP/$c.sse" ] && cp "$CAP/$c.sse" "tests/fixtures/sse/lmstudio-$c.sse" && cp "$CAP/$c.meta.json" "tests/fixtures/sse/lmstudio-$c.meta.json"
done
cp "$CAP/models-api-v1-before.json" tests/fixtures/discovery/lmstudio-models-cold.json
cp "$CAP/models-api-v1-after-load.json" tests/fixtures/discovery/lmstudio-models-loaded.json
cp "$CAP/models-v1.json" tests/fixtures/discovery/lmstudio-v1-models.json
cp "$CAP/plain-once.json" tests/fixtures/once/lmstudio-plain.json
cp "$CAP/tool-single-once.json" tests/fixtures/once/lmstudio-tool-single.json
cp "$CAP/error-unknown-model.json" tests/fixtures/once/lmstudio-error-unknown-model.json
cp "$CAP/error-unknown-model.meta.json" tests/fixtures/once/lmstudio-error-unknown-model.meta.json
ls tests/fixtures/sse tests/fixtures/discovery tests/fixtures/once
grep -ril 'authorization\|bearer ' tests/fixtures || echo 'no credentials'
```
Expected: the files listed, then `no credentials`. `think-default` is copied only if the spike had a thinking model;
the tests that read it run only when it's there. The `.meta.json` files carry the request the spike sent (no
headers), so nothing secret is copied.

- [ ] **Step 6: Write the llama.cpp and vLLM fixtures from their docs**

`tests/fixtures/sse/llamacpp-reasoning.sse` (llama.cpp puts `usage` and `timings` on its finishing chunk):
```text
# unverified: written from docs
data: {"choices":[{"finish_reason":null,"index":0,"delta":{"role":"assistant","content":null}}],"created":1790500000,"id":"chatcmpl-lcpp1","model":"Qwen3-8B-Q4_K_M.gguf","system_fingerprint":"b6600-abc1234","object":"chat.completion.chunk"}

data: {"choices":[{"finish_reason":null,"index":0,"delta":{"reasoning_content":"The user says hi."}}],"created":1790500000,"id":"chatcmpl-lcpp1","model":"Qwen3-8B-Q4_K_M.gguf","system_fingerprint":"b6600-abc1234","object":"chat.completion.chunk"}

data: {"choices":[{"finish_reason":null,"index":0,"delta":{"reasoning_content":" Greet them back — briefly."}}],"created":1790500000,"id":"chatcmpl-lcpp1","model":"Qwen3-8B-Q4_K_M.gguf","system_fingerprint":"b6600-abc1234","object":"chat.completion.chunk"}

data: {"choices":[{"finish_reason":null,"index":0,"delta":{"content":"Hello"}}],"created":1790500000,"id":"chatcmpl-lcpp1","model":"Qwen3-8B-Q4_K_M.gguf","system_fingerprint":"b6600-abc1234","object":"chat.completion.chunk"}

data: {"choices":[{"finish_reason":null,"index":0,"delta":{"content":"! Café or tea?"}}],"created":1790500000,"id":"chatcmpl-lcpp1","model":"Qwen3-8B-Q4_K_M.gguf","system_fingerprint":"b6600-abc1234","object":"chat.completion.chunk"}

data: {"choices":[{"finish_reason":"stop","index":0,"delta":{}}],"created":1790500000,"id":"chatcmpl-lcpp1","model":"Qwen3-8B-Q4_K_M.gguf","system_fingerprint":"b6600-abc1234","object":"chat.completion.chunk","usage":{"completion_tokens":17,"prompt_tokens":11,"total_tokens":28},"timings":{"prompt_n":11,"prompt_ms":35.2,"prompt_per_token_ms":3.2,"prompt_per_second":312.5,"predicted_n":17,"predicted_ms":254.1,"predicted_per_token_ms":14.95,"predicted_per_second":66.9}}

data: [DONE]

```

`tests/fixtures/sse/llamacpp-tools.sse` (no `usage`: token counts come from `timings`):
```text
# unverified: written from docs
data: {"choices":[{"finish_reason":null,"index":0,"delta":{"role":"assistant","content":null,"tool_calls":[{"index":0,"id":"Xk3pQ9dLr2VbN7sT0aYw4eHu","type":"function","function":{"name":"get_weather","arguments":""}}]}}],"created":1790500000,"id":"chatcmpl-lcpp2","model":"Qwen3-8B-Q4_K_M.gguf","object":"chat.completion.chunk"}

data: {"choices":[{"finish_reason":null,"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\"city\":"}}]}}],"created":1790500000,"id":"chatcmpl-lcpp2","model":"Qwen3-8B-Q4_K_M.gguf","object":"chat.completion.chunk"}

data: {"choices":[{"finish_reason":null,"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":" \"Zürich\"}"}}]}}],"created":1790500000,"id":"chatcmpl-lcpp2","model":"Qwen3-8B-Q4_K_M.gguf","object":"chat.completion.chunk"}

data: {"choices":[{"finish_reason":"tool_calls","index":0,"delta":{}}],"created":1790500000,"id":"chatcmpl-lcpp2","model":"Qwen3-8B-Q4_K_M.gguf","object":"chat.completion.chunk","timings":{"prompt_n":180,"prompt_ms":402.7,"predicted_n":21,"predicted_ms":318.4}}

data: [DONE]

```

`tests/fixtures/sse/vllm-reasoning.sse` (vLLM's newer `reasoning` field; usage in a last chunk with no choices):
```text
# unverified: written from docs
data: {"id":"chatcmpl-vllm1","object":"chat.completion.chunk","created":1790500000,"model":"Qwen/Qwen3-8B","choices":[{"index":0,"delta":{"role":"assistant","content":""},"logprobs":null,"finish_reason":null}]}

data: {"id":"chatcmpl-vllm1","object":"chat.completion.chunk","created":1790500000,"model":"Qwen/Qwen3-8B","choices":[{"index":0,"delta":{"reasoning":"Capital of France."},"logprobs":null,"finish_reason":null}]}

data: {"id":"chatcmpl-vllm1","object":"chat.completion.chunk","created":1790500000,"model":"Qwen/Qwen3-8B","choices":[{"index":0,"delta":{"reasoning":" Easy."},"logprobs":null,"finish_reason":null}]}

data: {"id":"chatcmpl-vllm1","object":"chat.completion.chunk","created":1790500000,"model":"Qwen/Qwen3-8B","choices":[{"index":0,"delta":{"content":"Paris."},"logprobs":null,"finish_reason":null}]}

data: {"id":"chatcmpl-vllm1","object":"chat.completion.chunk","created":1790500000,"model":"Qwen/Qwen3-8B","choices":[{"index":0,"delta":{"content":""},"logprobs":null,"finish_reason":"stop","stop_reason":null}]}

data: {"id":"chatcmpl-vllm1","object":"chat.completion.chunk","created":1790500000,"model":"Qwen/Qwen3-8B","choices":[],"usage":{"prompt_tokens":12,"total_tokens":24,"completion_tokens":12}}

data: [DONE]

```

`tests/fixtures/sse/vllm-tools.sse` (two calls, one after the other by `index`):
```text
# unverified: written from docs
data: {"id":"chatcmpl-vllm2","object":"chat.completion.chunk","created":1790500000,"model":"Qwen/Qwen3-8B","choices":[{"index":0,"delta":{"role":"assistant","content":""},"logprobs":null,"finish_reason":null}]}

data: {"id":"chatcmpl-vllm2","object":"chat.completion.chunk","created":1790500000,"model":"Qwen/Qwen3-8B","choices":[{"index":0,"delta":{"tool_calls":[{"id":"chatcmpl-tool-5b1c","type":"function","index":0,"function":{"name":"get_weather"}}]},"logprobs":null,"finish_reason":null}]}

data: {"id":"chatcmpl-vllm2","object":"chat.completion.chunk","created":1790500000,"model":"Qwen/Qwen3-8B","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\"city\": \"Paris\"}"}}]},"logprobs":null,"finish_reason":null}]}

data: {"id":"chatcmpl-vllm2","object":"chat.completion.chunk","created":1790500000,"model":"Qwen/Qwen3-8B","choices":[{"index":0,"delta":{"tool_calls":[{"id":"chatcmpl-tool-9e7a","type":"function","index":1,"function":{"name":"get_time"}}]},"logprobs":null,"finish_reason":null}]}

data: {"id":"chatcmpl-vllm2","object":"chat.completion.chunk","created":1790500000,"model":"Qwen/Qwen3-8B","choices":[{"index":0,"delta":{"tool_calls":[{"index":1,"function":{"arguments":"{\"zone\": "}}]},"logprobs":null,"finish_reason":null}]}

data: {"id":"chatcmpl-vllm2","object":"chat.completion.chunk","created":1790500000,"model":"Qwen/Qwen3-8B","choices":[{"index":0,"delta":{"tool_calls":[{"index":1,"function":{"arguments":"\"Europe/Paris\"}"}}]},"logprobs":null,"finish_reason":null}]}

data: {"id":"chatcmpl-vllm2","object":"chat.completion.chunk","created":1790500000,"model":"Qwen/Qwen3-8B","choices":[{"index":0,"delta":{},"logprobs":null,"finish_reason":"tool_calls","stop_reason":null}]}

data: {"id":"chatcmpl-vllm2","object":"chat.completion.chunk","created":1790500000,"model":"Qwen/Qwen3-8B","choices":[],"usage":{"prompt_tokens":240,"total_tokens":281,"completion_tokens":41}}

data: [DONE]

```

`tests/fixtures/discovery/llamacpp-props.json` (the `chat_template_caps` keys are `common/jinja/caps.cpp`'s `to_map()`):
```text
# unverified: written from docs
{
  "default_generation_settings": { "n_ctx": 32768, "params": { "temperature": 0.8 } },
  "total_slots": 1,
  "model_path": "/models/Qwen3-8B-Q4_K_M.gguf",
  "chat_template": "{%- if tools %}…{%- endif %}",
  "chat_template_caps": {
    "supports_string_content": true,
    "supports_typed_content": false,
    "supports_tools": true,
    "supports_tool_calls": true,
    "supports_parallel_tool_calls": true,
    "supports_system_role": true,
    "supports_preserve_reasoning": false,
    "supports_reasoning_effort": false,
    "supports_object_arguments": false
  },
  "modalities": { "vision": false },
  "build_info": "b6600-abc1234",
  "is_sleeping": false
}
```

`tests/fixtures/discovery/llamacpp-models.json`:
```text
# unverified: written from docs
{
  "object": "list",
  "data": [
    {
      "id": "Qwen3-8B-Q4_K_M.gguf",
      "object": "model",
      "created": 1790500000,
      "owned_by": "llamacpp",
      "meta": { "vocab_type": 2, "n_vocab": 151936, "n_ctx_train": 40960, "n_embd": 4096, "n_params": 8190735360, "size": 5027783488 }
    }
  ]
}
```

`tests/fixtures/discovery/vllm-models.json`:
```text
# unverified: written from docs
{
  "object": "list",
  "data": [
    {
      "id": "Qwen/Qwen3-8B",
      "object": "model",
      "created": 1790500000,
      "owned_by": "vllm",
      "root": "Qwen/Qwen3-8B",
      "parent": null,
      "max_model_len": 32768,
      "permission": [{ "id": "modelperm-1", "object": "model_permission", "allow_sampling": true, "allow_view": true }]
    }
  ]
}
```

`tests/fixtures/discovery/generic-models.json` (a server that lists embedding and reranking models beside chat ones):
```text
# unverified: written from docs
{
  "object": "list",
  "data": [
    { "id": "mistral-small-3.2-24b", "object": "model", "created": 1790500000, "owned_by": "local" },
    { "id": "qwen3-coder-30b-a3b", "object": "model", "created": 1790500000, "owned_by": "local" },
    { "id": "nomic-embed-text-v1.5", "object": "model", "created": 1790500000, "owned_by": "local" },
    { "id": "text-embedding-3-small", "object": "model", "created": 1790500000, "owned_by": "local" },
    { "id": "bge-reranker-v2-m3", "object": "model", "created": 1790500000, "owned_by": "local" }
  ]
}
```

Each file ends with a newline; the `.sse` files end with the blank line after `data: [DONE]`.

- [ ] **Step 7: Run tests to verify they pass**

Run: `npx vitest run tests/sseFixtures.test.ts` then `npm run typecheck && npm run lint && npm run format:check && npm test`
Expected: PASS. If a `lmstudio-*.sse` fails "is a finished stream", open it: the spike recorded something other than a
200 stream (see its `.meta.json` `status`), and `FINDINGS.md` should say why. Re-capture that case rather than editing
the file.

- [ ] **Step 8: Commit**

```bash
git add tests/ollamaMock.ts tests/sseFixtures.test.ts tests/fixtures .prettierignore
git commit -m "SSE helpers for the mock server, LM Studio captures, and llama.cpp and vLLM fixtures

The LM Studio streams, model lists and replies are the capture spike's, byte for byte, with the network pieces they
arrived in. llama.cpp and vLLM are written from their docs and marked unverified until someone captures them.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 3.2: `createStallTimer` shared; `sseData`

**Files:**
- Create: `src/main/providers/stream.ts`
- Modify: `src/main/providers/ollama/wire.ts` (the `StreamTimeouts`/`STREAM_TIMEOUTS` block, and `chatStream`'s stall timer)
- Create: `src/main/providers/openai/sse.ts`
- Test: `tests/stream.test.ts`, `tests/sse.test.ts`; `tests/client.test.ts` must pass unchanged

**Interfaces:**
- Consumes: `StreamTimeouts`, `STREAM_TIMEOUTS` and `chatStream(t, body, signal, timeouts)` in `providers/ollama/wire.ts` (PR 1 moved them, PR 2 gave `chatStream` its target).
- Produces: `createStallTimer(abort: () => void): StallTimer` (see Contract changes), `StallTimer`, `StreamTimeouts` and `STREAM_TIMEOUTS` from `providers/stream.ts`; `sseData(body: ReadableStream<Uint8Array>): AsyncGenerator<string, boolean>`.

- [ ] **Step 1: Write the failing tests**

`tests/stream.test.ts`:
```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createStallTimer, STREAM_TIMEOUTS } from '../src/main/providers/stream'

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('createStallTimer', () => {
  it('aborts with its message once the stream has been quiet too long', () => {
    const abort = vi.fn()
    const stall = createStallTimer(abort)
    stall.arm(1_000, 'quiet')
    vi.advanceTimersByTime(999)
    expect(abort).not.toHaveBeenCalled()
    expect(stall.stalled()).toBeNull()
    vi.advanceTimersByTime(1)
    expect(abort).toHaveBeenCalledOnce()
    expect(stall.stalled()).toBe('quiet')
  })

  it('starts again on every chunk, with the latest message', () => {
    const abort = vi.fn()
    const stall = createStallTimer(abort)
    stall.arm(1_000, 'no first byte')
    vi.advanceTimersByTime(900)
    stall.arm(500, 'went quiet')
    vi.advanceTimersByTime(499)
    expect(abort).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(stall.stalled()).toBe('went quiet')
  })

  it('never fires once cleared', () => {
    const abort = vi.fn()
    const stall = createStallTimer(abort)
    stall.arm(100, 'quiet')
    stall.clear()
    vi.advanceTimersByTime(1_000)
    expect(abort).not.toHaveBeenCalled()
    expect(stall.stalled()).toBeNull()
  })

  it('keeps the long quiet allowance for tool calls', () => {
    expect(STREAM_TIMEOUTS.toolIdleMs).toBeGreaterThan(STREAM_TIMEOUTS.idleMs)
  })
})
```

`tests/sse.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { sseData } from '../src/main/providers/openai/sse'

function body(parts: Array<string | Uint8Array>): ReadableStream<Uint8Array> {
  const enc = new TextEncoder()
  return new ReadableStream({
    start(c) {
      for (const p of parts) c.enqueue(typeof p === 'string' ? enc.encode(p) : p)
      c.close()
    }
  })
}

async function drain(stream: ReadableStream<Uint8Array>): Promise<{ data: string[]; sawDone: boolean }> {
  const payloads = sseData(stream)
  const data: string[] = []
  for (;;) {
    const r = await payloads.next()
    if (r.done) return { data, sawDone: r.value }
    data.push(r.value)
  }
}

describe('sseData', () => {
  it('yields each data payload and returns true at [DONE]', async () => {
    expect(await drain(body(['data: {"a":1}\n\ndata: {"b":2}\n\ndata: [DONE]\n\n']))).toEqual({ data: ['{"a":1}', '{"b":2}'], sawDone: true })
  })

  it('reassembles an event split anywhere, even inside a character', async () => {
    const bytes = new TextEncoder().encode('data: {"t":"café — ok"}\n\ndata: [DONE]\n\n')
    for (let cut = 1; cut < bytes.length; cut++)
      expect(await drain(body([bytes.subarray(0, cut), bytes.subarray(cut)]))).toEqual({ data: ['{"t":"café — ok"}'], sawDone: true })
  })

  it('reads a stream that arrives one byte at a time', async () => {
    const bytes = new TextEncoder().encode('data: {"a":"é"}\n\ndata: {"b":2}\n\ndata: [DONE]\n\n')
    const parts = Array.from(bytes, (b) => Uint8Array.of(b))
    expect(await drain(body(parts))).toEqual({ data: ['{"a":"é"}', '{"b":2}'], sawDone: true })
  })

  it('skips comments and other fields, and takes data with or without its space', async () => {
    const text = ': keep-alive\n\nevent: message\ndata:{"a":1}\nid: 7\nretry: 100\n\n: OPENROUTER PROCESSING\n\ndata: {"b":2}\n\ndata: [DONE]\n\n'
    expect(await drain(body([text]))).toEqual({ data: ['{"a":1}', '{"b":2}'], sawDone: true })
  })

  it('reads CRLF line endings', async () => {
    expect(await drain(body(['data: {"a":1}\r\n\r\ndata: [DONE]\r\n\r\n']))).toEqual({ data: ['{"a":1}'], sawDone: true })
  })

  it('joins an event spread over several data lines with newlines', async () => {
    expect((await drain(body(['data: {"a":\ndata: 1}\n\n']))).data).toEqual(['{"a":\n1}'])
  })

  it('delivers a last event that ends without its blank line, or without any newline', async () => {
    expect(await drain(body(['data: {"a":1}\n\ndata: {"b":2}\n']))).toEqual({ data: ['{"a":1}', '{"b":2}'], sawDone: false })
    expect(await drain(body(['data: {"a":1}\n\ndata: {"b":2}']))).toEqual({ data: ['{"a":1}', '{"b":2}'], sawDone: false })
  })

  it('returns false when the stream ends without [DONE]', async () => {
    expect(await drain(body(['data: {"a":1}\n\n']))).toEqual({ data: ['{"a":1}'], sawDone: false })
    expect(await drain(body([]))).toEqual({ data: [], sawDone: false })
  })

  it('recognises a [DONE] with no newline after it', async () => {
    expect(await drain(body(['data: {"a":1}\n\ndata: [DONE]']))).toEqual({ data: ['{"a":1}'], sawDone: true })
  })

  it('stops at [DONE] and ignores anything after it', async () => {
    expect(await drain(body(['data: [DONE]\n\ndata: {"late":1}\n\n']))).toEqual({ data: [], sawDone: true })
  })
})
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run tests/stream.test.ts tests/sse.test.ts`
Expected: FAIL with `Failed to resolve import "../src/main/providers/stream"` (and the same for `openai/sse`).

- [ ] **Step 3: Implement `src/main/providers/stream.ts`**

```ts
// What both wires share for a streamed reply: how long it may go quiet, and the timer that gives up on it.

export interface StreamTimeouts {
  /** Until the first byte of the reply: covers loading a cold local model and reading a long prompt. */
  firstByteMs: number
  /** Between chunks once the reply has started. */
  idleMs: number
  /**
   * Between chunks when the request offers tools. Ollama holds back a tool call until its arguments are
   * complete, so a slow local model writing a long argument can go quiet for many minutes while healthy.
   */
  toolIdleMs: number
}

// Generous on purpose: these catch a dead connection, not a slow model.
export const STREAM_TIMEOUTS: StreamTimeouts = { firstByteMs: 10 * 60_000, idleMs: 3 * 60_000, toolIdleMs: 30 * 60_000 }

export interface StallTimer {
  /** (Re)start the countdown: after `ms` of silence `abort` runs, and `stalled()` then returns `message`. */
  arm(ms: number, message: string): void
  /** Why the stream was given up on, or null while it hasn't been. */
  stalled(): string | null
  clear(): void
}

/**
 * Armed for the first byte and again on every chunk. When it fires it aborts the request; the reader then throws
 * `stalled()`'s message instead of the abort, so only the user's Stop surfaces as an AbortError.
 */
export function createStallTimer(abort: () => void): StallTimer {
  let stalled: string | null = null
  let timer: ReturnType<typeof setTimeout> | undefined
  return {
    arm(ms, message) {
      clearTimeout(timer)
      timer = setTimeout(() => {
        stalled = message
        abort()
      }, ms)
    },
    stalled: () => stalled,
    clear: () => clearTimeout(timer)
  }
}
```

- [ ] **Step 4: Implement `src/main/providers/openai/sse.ts`**

```ts
/**
 * The data payloads of a server-sent event stream, in order. Comment lines (`:`) and other fields (`event:`, `id:`,
 * `retry:`) are skipped, and a payload spread over several `data:` lines is joined with newlines, as the SSE spec
 * says. Returns true at `data: [DONE]` (OpenAI's end marker), false when the stream just ends; a last event with no
 * blank line after it is still delivered.
 */
export async function* sseData(body: ReadableStream<Uint8Array>): AsyncGenerator<string, boolean> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let data: string[] = []

  // One line of the stream; returns the event's payload when the line ends it.
  const take = (line: string): string | null => {
    if (line === '') {
      if (!data.length) return null
      const payload = data.join('\n')
      data = []
      return payload
    }
    if (line.startsWith(':')) return null
    const colon = line.indexOf(':')
    if ((colon < 0 ? line : line.slice(0, colon)) !== 'data') return null
    const value = colon < 0 ? '' : line.slice(colon + 1)
    data.push(value.startsWith(' ') ? value.slice(1) : value)
    return null
  }

  try {
    for (;;) {
      const { value, done } = await reader.read()
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true })
      let nl: number
      // Lines end in \n or \r\n; no OpenAI-compatible server sends a lone \r.
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const payload = take(buffer.slice(0, nl).replace(/\r$/, ''))
        buffer = buffer.slice(nl + 1)
        if (payload === null) continue
        if (payload.trim() === '[DONE]') return true
        yield payload
      }
      if (done) break
    }
    if (buffer) take(buffer.replace(/\r$/, ''))
    const last = take('')
    if (last !== null && last.trim() === '[DONE]') return true
    if (last !== null) yield last
    return false
  } finally {
    // A consumer that stops early mustn't leave the body being read into nothing.
    reader.cancel().catch(() => undefined)
  }
}
```

- [ ] **Step 5: Run the new tests to verify they pass**

Run: `npx vitest run tests/stream.test.ts tests/sse.test.ts`
Expected: PASS

- [ ] **Step 6: Share the timer with the Ollama wire (no behaviour change)**

In `src/main/providers/ollama/wire.ts`:

1. Delete the `export interface StreamTimeouts { … }` block and the `// Generous on purpose…` comment with
   `export const STREAM_TIMEOUTS = …` below it, and add near the other imports:
   ```ts
   import { createStallTimer, STREAM_TIMEOUTS, type StreamTimeouts } from '../stream'

   // Kept here too, where the Ollama side and its tests have always found them.
   export { STREAM_TIMEOUTS, type StreamTimeouts }
   ```
   `streamTimeoutsFor` stays in `wire.ts` as it is.
2. In `chatStream`, replace
   ```ts
     let stalled: string | null = null
     let timer: ReturnType<typeof setTimeout> | undefined
     const arm = (ms: number, message: string) => {
       clearTimeout(timer)
       timer = setTimeout(() => {
         stalled = message
         inner.abort()
       }, ms)
     }
   ```
   with
   ```ts
     const stall = createStallTimer(() => inner.abort())
   ```
3. Change the two calls `arm(` to `stall.arm(` (the first-byte arm and the idle arm inside the read loop). Their
   messages stay exactly as they are.
4. In the `catch`, replace `if (stalled && !signal.aborted) throw new OllamaError(stalled)` with:
   ```ts
       const stalled = stall.stalled()
       if (stalled && !signal.aborted) throw new OllamaError(stalled)
   ```
5. In the `finally`, replace `clearTimeout(timer)` with `stall.clear()`.

- [ ] **Step 7: Run tests to verify nothing changed**

Run: `npx vitest run tests/client.test.ts tests/ollamaAdapter.test.ts tests/stream.test.ts tests/sse.test.ts` then
`npm run typecheck && npm run lint && npm run format:check && npm test`
Expected: PASS, with `tests/client.test.ts` untouched (`git diff --stat tests/client.test.ts` prints nothing).

- [ ] **Step 8: Commit**

```bash
git add src/main/providers/stream.ts src/main/providers/openai/sse.ts src/main/providers/ollama/wire.ts tests/stream.test.ts tests/sse.test.ts
git commit -m "One stall timer for both wires, and an SSE reader for OpenAI-compatible servers

The Ollama wire keeps its timeouts and messages; only where the timer lives changes. sseData yields each event's
data, skips comments and other fields, and says whether the stream ended at [DONE].

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 3.3: `thinkSplitter`

**Files:**
- Create: `src/main/providers/openai/thinkSplitter.ts`
- Test: `tests/thinkSplitter.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `createThinkSplitter(): { push(text: string): ThinkSplit; flush(): ThinkSplit }`, `ThinkSplit`,
  `THINK_NEAR_START`.

The rules, from the spec:
- Only a **leading** `<think>…</think>` block counts (leading whitespace allowed). A reply that later talks about the
  tags keeps them.
- Inside the block, up to 7 characters (`</think` is 7) are held back so a closing tag split across chunks still
  matches.
- A reply that **starts mid-thinking** (the chat template opened `<think>` in the prompt): a `</think>` within the first
  `THINK_NEAR_START` characters, with no `<think>` before it, marks everything before it as thinking. To see that, a
  reply that doesn't start with `<think>` is held back until it's `THINK_NEAR_START + 7` characters long (or ends), so
  plain replies show after at most 71 characters.
- The whitespace right after `<think>` and right after `</think>` belongs to neither part.

- [ ] **Step 1: Write the failing test**

`tests/thinkSplitter.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { createThinkSplitter, THINK_NEAR_START } from '../src/main/providers/openai/thinkSplitter'

/** Feed the pieces in turn, then flush; the totals of each part. */
function run(...pieces: string[]): { content: string; thinking: string } {
  const s = createThinkSplitter()
  const out = { content: '', thinking: '' }
  for (const p of [...pieces.map((x) => s.push(x)), s.flush()]) {
    out.content += p.content
    out.thinking += p.thinking
  }
  return out
}

const HOLD = THINK_NEAR_START + '</think>'.length - 1

describe('thinkSplitter', () => {
  it('passes a plain reply through', () => {
    expect(run('Hello ', 'there')).toEqual({ content: 'Hello there', thinking: '' })
  })

  it('splits a leading block from the reply', () => {
    expect(run('<think>\nPlan it.\n</think>\n\nAnswer.')).toEqual({ thinking: 'Plan it.\n', content: 'Answer.' })
  })

  it('allows whitespace before the leading block', () => {
    expect(run('\n  <think>x</think>y')).toEqual({ thinking: 'x', content: 'y' })
  })

  it('matches tags split across chunks', () => {
    expect(run('<th', 'ink>Let me', ' see</thi', 'nk>Ans', 'wer')).toEqual({ thinking: 'Let me see', content: 'Answer' })
  })

  it('holds back at most the start of a closing tag while thinking', () => {
    const s = createThinkSplitter()
    expect(s.push('<think>abcdefghij</thi')).toEqual({ thinking: 'abcdefghij', content: '' })
    expect(s.push('s is not a tag')).toEqual({ thinking: '</this is not a tag', content: '' })
  })

  it('treats a reply that starts mid-thinking as thinking up to its </think>', () => {
    expect(run('Okay, they said hi.\n</th', 'ink>\n\nHello!')).toEqual({ thinking: 'Okay, they said hi.\n', content: 'Hello!' })
  })

  it('leaves a </think> further in than the start in the reply', () => {
    const text = `${'x'.repeat(THINK_NEAR_START)}</think>rest`
    expect(run(text)).toEqual({ content: text, thinking: '' })
  })

  it('leaves a reply that mentions <think> intact', () => {
    const text = 'The <think> tag wraps reasoning, and </think> ends it.'
    expect(run(text)).toEqual({ content: text, thinking: '' })
  })

  it('counts only the leading block', () => {
    expect(run('<think>a</think>b<think>c</think>d')).toEqual({ thinking: 'a', content: 'b<think>c</think>d' })
  })

  it('keeps an unfinished block as thinking when the reply ends inside it', () => {
    expect(run('<think>still going</thi')).toEqual({ thinking: 'still going</thi', content: '' })
  })

  it('gives an empty block no thinking', () => {
    expect(run('<think>\n\n</think>\n\nHi')).toEqual({ thinking: '', content: 'Hi' })
  })

  it('gives a reply that is only the start of a tag back as the reply', () => {
    expect(run('<thi')).toEqual({ content: '<thi', thinking: '' })
  })

  it('releases a plain reply once it is too long to be closing a block', () => {
    const s = createThinkSplitter()
    expect(s.push('x'.repeat(HOLD - 1))).toEqual({ content: '', thinking: '' })
    expect(s.push('y')).toEqual({ content: `${'x'.repeat(HOLD - 1)}y`, thinking: '' })
    expect(s.push('z')).toEqual({ content: 'z', thinking: '' })
  })

  it('splits the same wherever the chunks break', () => {
    const replies = [
      '<think>\nPlan it.\n</think>\n\nAnswer.',
      'Okay, they said hi.\n</think>\n\nHello!',
      'The <think> tag wraps reasoning, and </think> ends it.',
      `${'plain '.repeat(20)}</think> later`,
      '  <think>é — ü</think> Café'
    ]
    for (const text of replies) {
      const whole = run(text)
      for (let cut = 1; cut < text.length; cut++) expect(run(text.slice(0, cut), text.slice(cut))).toEqual(whole)
      expect(run(...text.split(''))).toEqual(whole)
    }
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/thinkSplitter.test.ts`
Expected: FAIL with `Failed to resolve import "../src/main/providers/openai/thinkSplitter"`.

- [ ] **Step 3: Implement `src/main/providers/openai/thinkSplitter.ts`**

```ts
const OPEN = '<think>'
const CLOSE = '</think>'

/**
 * How far into a reply a `</think>` still closes a block the chat template opened in the prompt (the reply starts
 * mid-thinking). A reply that doesn't start with `<think>` is held back only until it's this long plus a tag, so plain
 * replies still start promptly.
 */
export const THINK_NEAR_START = 64

export interface ThinkSplit {
  content: string
  thinking: string
}

/** How many characters at the end of `text` could be the first part of `tag`, split across chunks. */
function partialTail(text: string, tag: string): number {
  for (let k = Math.min(tag.length - 1, text.length); k > 0; k--) if (text.endsWith(tag.slice(0, k))) return k
  return 0
}

/**
 * Splits `<think>…</think>` reasoning out of streamed content, for servers that leave it in the text. Only a leading
 * block counts, so a reply that talks about the tags keeps them.
 */
export function createThinkSplitter(): { push(text: string): ThinkSplit; flush(): ThinkSplit } {
  let mode: 'start' | 'thinking' | 'content' = 'start'
  let held = ''
  // Right after a tag, the whitespace before the next text belongs to neither part.
  let trimNext = false

  const emit = (out: ThinkSplit, part: keyof ThinkSplit, text: string) => {
    if (trimNext) {
      text = text.replace(/^\s+/, '')
      if (text) trimNext = false
    }
    out[part] += text
  }

  const close = (out: ThinkSplit, at: number) => {
    emit(out, 'thinking', held.slice(0, at))
    held = held.slice(at + CLOSE.length)
    mode = 'content'
    trimNext = true
  }

  const run = (final: boolean): ThinkSplit => {
    const out: ThinkSplit = { content: '', thinking: '' }
    for (;;) {
      if (mode === 'content') {
        emit(out, 'content', held)
        held = ''
        return out
      }
      if (mode === 'thinking') {
        const at = held.indexOf(CLOSE)
        if (at >= 0) {
          close(out, at)
          continue
        }
        const keep = final ? 0 : partialTail(held, CLOSE)
        emit(out, 'thinking', held.slice(0, held.length - keep))
        held = held.slice(held.length - keep)
        return out
      }
      // At the start: a thinking block, a reply that began mid-thinking, or a plain reply?
      const lead = held.trimStart()
      if (lead.startsWith(OPEN)) {
        held = lead.slice(OPEN.length)
        mode = 'thinking'
        trimNext = true
        continue
      }
      const at = held.indexOf(CLOSE)
      if (at >= 0 && at < THINK_NEAR_START && !held.slice(0, at).includes(OPEN)) {
        close(out, at)
        continue
      }
      // Still possibly `<think>`, or short enough that a `</think>` near the start could yet arrive.
      const undecided = OPEN.startsWith(lead) || held.length < THINK_NEAR_START + CLOSE.length - 1
      if (undecided && !final) return out
      mode = 'content'
    }
  }

  return {
    push(text) {
      held += text
      return run(false)
    },
    flush: () => run(true)
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/thinkSplitter.test.ts` then `npm run typecheck && npm run lint && npm run format:check && npm test`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/main/providers/openai/thinkSplitter.ts tests/thinkSplitter.test.ts
git commit -m "Split a leading <think> block out of streamed replies

For servers that leave reasoning in the text. Only a leading block counts; a split tag is held back until it can
match; a reply that starts mid-thinking (the template opened the block) is thinking up to an early </think>.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 3.4: Tool-call delta accumulator

**Files:**
- Create: `src/main/providers/openai/toolCalls.ts`
- Test: `tests/toolCalls.test.ts`

**Interfaces:**
- Consumes: `IdentifiedToolCall` (`providers/types.ts`, PR 1).
- Produces: `createToolCallAccumulator(): { add(deltas: unknown[]): void; finish(): IdentifiedToolCall[] }`. `add` takes
  one chunk's `choices[0].delta.tool_calls` as it came; `finish` returns the calls in `index` order, each with an id
  (the server's, else `'t' + n.toString(36).padStart(8, '0')`, n its place among the stream's finished calls: 9 letters
  and digits, the only shape Mistral's chat templates on vLLM accept) and arguments parsed from JSON, or the raw text
  when it isn't valid JSON (`argsOf` in `chat/tools.ts` already accepts a string).

- [ ] **Step 1: Write the failing test**

`tests/toolCalls.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { createToolCallAccumulator } from '../src/main/providers/openai/toolCalls'

const start = (index: number, id: string | undefined, name: string) => ({ index, ...(id && { id }), type: 'function', function: { name, arguments: '' } })
const frag = (index: number, args: string) => ({ index, function: { arguments: args } })

describe('createToolCallAccumulator', () => {
  it('builds a call from its fragments: id and name first, then the arguments piece by piece', () => {
    const acc = createToolCallAccumulator()
    acc.add([start(0, 'call_abc', 'get_weather')])
    acc.add([frag(0, '{"ci')])
    acc.add([frag(0, 'ty": "Pa')])
    acc.add([frag(0, 'ris"}')])
    expect(acc.finish()).toEqual([{ id: 'call_abc', function: { name: 'get_weather', arguments: { city: 'Paris' } } }])
  })

  // Review Focus #3.
  it('keeps two calls apart when their fragments interleave by index, escapes split across chunks included', () => {
    const acc = createToolCallAccumulator()
    acc.add([start(0, 'call_a', 'write_file')])
    acc.add([start(1, 'call_b', 'web_search')])
    acc.add([frag(0, '{"path": "a.txt", "text": "say \\')])
    acc.add([frag(1, '{"query": "caf\\u00')])
    acc.add([frag(0, '"hi\\" to Ren'), frag(1, 'e9 crème"}')])
    acc.add([frag(0, 'ée"}')])
    expect(acc.finish()).toEqual([
      { id: 'call_a', function: { name: 'write_file', arguments: { path: 'a.txt', text: 'say "hi" to Renée' } } },
      { id: 'call_b', function: { name: 'web_search', arguments: { query: 'café crème' } } }
    ])
  })

  it('takes a whole call sent in one delta', () => {
    const acc = createToolCallAccumulator()
    acc.add([{ index: 0, id: 'c1', type: 'function', function: { name: 'web_fetch', arguments: '{"url":"https://k.io"}' } }])
    expect(acc.finish()).toEqual([{ id: 'c1', function: { name: 'web_fetch', arguments: { url: 'https://k.io' } } }])
  })

  it('passes arguments that aren’t valid JSON through as text', () => {
    const acc = createToolCallAccumulator()
    acc.add([start(0, 'c1', 'run_code'), frag(0, '{"code": "print(1)"')])
    expect(acc.finish()).toEqual([{ id: 'c1', function: { name: 'run_code', arguments: '{"code": "print(1)"' } }])
  })

  it('makes up a 9-character id for a call that came without one, and keeps one the server sent', () => {
    const acc = createToolCallAccumulator()
    acc.add([start(0, undefined, 'a'), start(1, 'srv-id', 'b'), start(2, undefined, 'c')])
    // 't' and the call's place in base 36: Mistral's chat templates on vLLM refuse any id that isn't 9 letters and digits.
    expect(acc.finish().map((c) => c.id)).toEqual(['t00000000', 'srv-id', 't00000002'])
  })

  it('reads empty arguments as no arguments', () => {
    const acc = createToolCallAccumulator()
    acc.add([start(0, 'c1', 'list_files')])
    expect(acc.finish()[0].function.arguments).toEqual({})
  })

  it('separates whole calls sent without an index', () => {
    const acc = createToolCallAccumulator()
    acc.add([{ id: 'a', function: { name: 'x', arguments: '{}' } }])
    acc.add([{ id: 'b', function: { name: 'y', arguments: '{"n":1}' } }])
    expect(acc.finish()).toEqual([
      { id: 'a', function: { name: 'x', arguments: {} } },
      { id: 'b', function: { name: 'y', arguments: { n: 1 } } }
    ])
  })

  it('doesn’t double a name a server repeats with every fragment', () => {
    const acc = createToolCallAccumulator()
    acc.add([{ index: 0, id: 'c1', function: { name: 'get_weather', arguments: '{"city":' } }])
    acc.add([{ index: 0, function: { name: 'get_weather', arguments: '"Oslo"}' } }])
    expect(acc.finish()).toEqual([{ id: 'c1', function: { name: 'get_weather', arguments: { city: 'Oslo' } } }])
  })

  it('takes arguments a server sends as an object', () => {
    const acc = createToolCallAccumulator()
    acc.add([{ index: 0, id: 'c1', function: { name: 'f', arguments: { a: 1 } } }])
    expect(acc.finish()[0].function.arguments).toEqual({ a: 1 })
  })

  it('drops a fragment that never got a name, and ignores what isn’t a fragment', () => {
    const acc = createToolCallAccumulator()
    acc.add([null, 'x', frag(3, '{"a":1}'), start(0, 'c1', 'f')])
    expect(acc.finish()).toEqual([{ id: 'c1', function: { name: 'f', arguments: {} } }])
  })

  it('gives nothing when no call came', () => {
    expect(createToolCallAccumulator().finish()).toEqual([])
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/toolCalls.test.ts`
Expected: FAIL with `Failed to resolve import "../src/main/providers/openai/toolCalls"`.

- [ ] **Step 3: Implement `src/main/providers/openai/toolCalls.ts`**

```ts
import type { IdentifiedToolCall } from '../types'

interface Slot {
  id: string
  name: string
  args: string
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/** Arguments as the loop takes them: parsed JSON, else the raw text (argsOf copes with a string). */
function parseArgs(text: string): Record<string, unknown> | string {
  if (!text.trim()) return {}
  try {
    const value: unknown = JSON.parse(text)
    return isRecord(value) ? value : text
  } catch {
    return text
  }
}

/**
 * Collects streamed tool-call fragments by `index`: the first carries the id and the name, later ones append to the
 * arguments. The calls come out whole, since the loop only ever runs complete calls. Arguments are joined as raw text
 * and parsed once at the end, so an escape or a character split across fragments can't break them.
 */
export function createToolCallAccumulator(): { add(deltas: unknown[]): void; finish(): IdentifiedToolCall[] } {
  const slots = new Map<number, Slot>()
  let last = -1
  return {
    add(deltas) {
      for (const d of deltas) {
        if (!isRecord(d)) continue
        const id = typeof d.id === 'string' ? d.id : ''
        let index: number
        if (typeof d.index === 'number') index = d.index
        // A server that sends each call whole may leave out `index`: the first call, or a new id, starts a new one.
        else if (last < 0 || (id && slots.get(last)?.id && slots.get(last)?.id !== id)) index = slots.size ? Math.max(...slots.keys()) + 1 : 0
        else index = last
        last = index
        const slot = slots.get(index) ?? { id: '', name: '', args: '' }
        slots.set(index, slot)
        if (id && !slot.id) slot.id = id
        const fn = isRecord(d.function) ? d.function : {}
        // Most servers send the name once; some repeat it with every fragment.
        if (typeof fn.name === 'string' && fn.name && fn.name !== slot.name) slot.name += fn.name
        if (typeof fn.arguments === 'string') slot.args += fn.arguments
        else if (isRecord(fn.arguments)) slot.args = JSON.stringify(fn.arguments)
      }
    },
    finish() {
      return (
        [...slots.entries()]
          .sort(([a], [b]) => a - b)
          .map(([, slot]) => slot)
          // A call with no name can't run: the loop would report a tool called "".
          .filter((slot) => slot.name)
          // An id of Ollmost's own is 9 letters and digits ('t' and the call's place in base 36): Mistral's chat templates
          // on vLLM refuse any other shape. An id the server sent goes back as it came.
          .map((slot, n) => ({ id: slot.id || `t${n.toString(36).padStart(8, '0')}`, function: { name: slot.name, arguments: parseArgs(slot.args) } }))
      )
    }
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/toolCalls.test.ts` then `npm run typecheck && npm run lint && npm run format:check && npm test`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/main/providers/openai/toolCalls.ts tests/toolCalls.test.ts
git commit -m "Assemble streamed tool calls by index and hand them over whole

Arguments are joined as raw text and parsed once, so escapes split across chunks survive; a call with no id gets a
9-character one (t00000000: Mistral's templates on vLLM accept no other shape), and arguments that aren't JSON pass
through as text.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 3.5: `toOpenAIBody` and `openAIThink`

**Files:**
- Create: `src/main/providers/openai/body.ts`
- Test: `tests/openaiBody.test.ts`

**Interfaces:**
- Consumes: `ChatRequest`, `ChatMessage`, `ChatImage`, `ToolCall` (`providers/types.ts`); `normalizeThinkSetting`
  (`@shared/thinking`); `ThinkProfile`, `ThinkSetting` (`@shared/types`).
- Produces: `toOpenAIBody(req: ChatRequest, opts: { stream: boolean; streamOptions: boolean }): Record<string, unknown>`,
  `openAIThink(profile: ThinkProfile, setting: ThinkSetting | null): Record<string, unknown>`, `EMPTY_TOOL_CALL_CONTENT`.

The mapping, from the spec:

| Ollmost | Sent as |
|---|---|
| user images | `content: [{type:'text',text}, {type:'image_url', image_url:{url:'data:<mime>;base64,…'}}]` (the text part left out when there's no text) |
| assistant tool calls | `tool_calls: [{id, type:'function', function:{name, arguments: JSON.stringify(args)}}]`, `content: ''` when there's no text |
| tool result | `{role:'tool', tool_call_id, content}` |
| earlier reasoning | not sent |
| tools | as they are; no `tool_choice` |
| think: toggle | `chat_template_kwargs: { enable_thinking: on }` |
| think: levels | `reasoning_effort: 'low' \| 'medium' \| 'high'` (`off` sends `low`: `reasoning_effort` has no off) |
| think: none / always | nothing |
| context | nothing (fixed where the model was loaded) |
| temperature | top-level `temperature` |
| usage | `stream: true, stream_options: { include_usage: true }` unless the endpoint rejected it |

- [ ] **Step 1: Write the failing test**

`tests/openaiBody.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { openAIThink, toOpenAIBody } from '../src/main/providers/openai/body'
import type { ChatRequest } from '../src/main/providers/types'

const base: ChatRequest = {
  model: 'qwen/qwen3-8b',
  messages: [
    { role: 'system', content: 'Be brief.' },
    { role: 'user', content: 'hi' }
  ],
  think: null,
  profile: { kind: 'none' },
  contextWindow: 32_768
}
const body = (over: Partial<ChatRequest> = {}, opts = { stream: true, streamOptions: true }) => toOpenAIBody({ ...base, ...over }, opts)

describe('toOpenAIBody', () => {
  it('sends the model, the messages, and asks for usage; never a context size', () => {
    expect(body()).toEqual({
      model: 'qwen/qwen3-8b',
      messages: [
        { role: 'system', content: 'Be brief.' },
        { role: 'user', content: 'hi' }
      ],
      stream: true,
      stream_options: { include_usage: true }
    })
  })

  it('leaves stream_options out once the endpoint rejected it, and when not streaming', () => {
    expect(body({}, { stream: true, streamOptions: false })).not.toHaveProperty('stream_options')
    expect(body({}, { stream: false, streamOptions: true })).toMatchObject({ stream: false })
    expect(body({}, { stream: false, streamOptions: true })).not.toHaveProperty('stream_options')
  })

  it('sends images as image_url data URLs after the text', () => {
    const b = body({
      messages: [
        {
          role: 'user',
          content: 'what is this?',
          images: [
            { data: 'iVBORw0K', mime: 'image/png' },
            { data: '/9j/4AAQ', mime: 'image/jpeg' }
          ]
        }
      ]
    })
    expect(b.messages).toEqual([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'what is this?' },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,iVBORw0K' } },
          { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,/9j/4AAQ' } }
        ]
      }
    ])
  })

  it('sends an image with no text as the image alone', () => {
    const b = body({ messages: [{ role: 'user', content: '', images: [{ data: 'AAAA', mime: 'image/png' }] }] })
    expect(b.messages).toEqual([{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }] }])
  })

  it('echoes tool calls with their ids and JSON-text arguments, and results by tool_call_id', () => {
    const b = body({
      messages: [
        { role: 'user', content: 'weather?' },
        {
          role: 'assistant',
          content: '',
          thinking: 'Look it up.',
          toolCalls: [
            { id: 'c00000000', function: { name: 'get_weather', arguments: { city: 'Paris' } } },
            { id: 'c00000001', function: { name: 'raw', arguments: '{"x":1' } }
          ]
        },
        { role: 'tool', content: 'Sunny', toolCallId: 'c00000000', toolName: 'get_weather' },
        { role: 'tool', content: 'bad arguments', toolCallId: 'c00000001', toolName: 'raw' }
      ]
    })
    expect(b.messages).toEqual([
      { role: 'user', content: 'weather?' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [
          { id: 'c00000000', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Paris"}' } },
          { id: 'c00000001', type: 'function', function: { name: 'raw', arguments: '{"x":1' } }
        ]
      },
      { role: 'tool', tool_call_id: 'c00000000', content: 'Sunny' },
      { role: 'tool', tool_call_id: 'c00000001', content: 'bad arguments' }
    ])
  })

  it('never sends earlier reasoning back', () => {
    const b = body({ messages: [{ role: 'assistant', content: 'Hello', thinking: 'They said hi.' }] })
    expect(b.messages).toEqual([{ role: 'assistant', content: 'Hello' }])
    expect(JSON.stringify(b)).not.toContain('They said hi.')
  })

  it('sends tools as they are, with no tool_choice', () => {
    const tools = [{ type: 'function' as const, function: { name: 'web_search', description: 'Search', parameters: { type: 'object' } } }]
    const b = body({ tools })
    expect(b.tools).toBe(tools)
    expect(b).not.toHaveProperty('tool_choice')
    expect(body({ tools: [] })).not.toHaveProperty('tools')
  })

  it('puts temperature at the top level', () => {
    expect(body({ temperature: 0.3 })).toMatchObject({ temperature: 0.3 })
    expect(body()).not.toHaveProperty('options')
  })

  it('carries the think setting in the server’s words', () => {
    expect(body({ profile: { kind: 'toggle' }, think: 'on' })).toMatchObject({ chat_template_kwargs: { enable_thinking: true } })
    expect(body({ profile: { kind: 'levels', canDisable: false }, think: 'high' })).toMatchObject({ reasoning_effort: 'high' })
  })
})

describe('openAIThink', () => {
  it('toggles thinking through the chat template', () => {
    expect(openAIThink({ kind: 'toggle' }, 'on')).toEqual({ chat_template_kwargs: { enable_thinking: true } })
    expect(openAIThink({ kind: 'toggle' }, 'off')).toEqual({ chat_template_kwargs: { enable_thinking: false } })
    expect(openAIThink({ kind: 'toggle' }, null)).toEqual({ chat_template_kwargs: { enable_thinking: false } })
    expect(openAIThink({ kind: 'toggle' }, 'high')).toEqual({ chat_template_kwargs: { enable_thinking: true } })
  })

  it('sets effort levels as reasoning_effort, with low as the least', () => {
    expect(openAIThink({ kind: 'levels', canDisable: false }, 'high')).toEqual({ reasoning_effort: 'high' })
    expect(openAIThink({ kind: 'levels', canDisable: false }, null)).toEqual({ reasoning_effort: 'medium' })
    expect(openAIThink({ kind: 'levels', canDisable: false }, 'on')).toEqual({ reasoning_effort: 'medium' })
    expect(openAIThink({ kind: 'levels', canDisable: true }, 'off')).toEqual({ reasoning_effort: 'low' })
  })

  it('sends nothing for display-only or always-on thinking', () => {
    expect(openAIThink({ kind: 'none' }, 'on')).toEqual({})
    expect(openAIThink({ kind: 'always' }, 'on')).toEqual({})
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/openaiBody.test.ts`
Expected: FAIL with `Failed to resolve import "../src/main/providers/openai/body"`.

- [ ] **Step 3: Implement `src/main/providers/openai/body.ts`**

```ts
import { normalizeThinkSetting } from '@shared/thinking'
import type { ThinkProfile, ThinkSetting } from '@shared/types'
import type { ChatImage, ChatMessage, ChatRequest, ToolCall } from '../types'

/**
 * The content of an assistant message that only calls tools. OpenAI allows '' or null; the capture spike
 * (capture/FINDINGS.md, question 5) says which LM Studio accepts.
 */
export const EMPTY_TOOL_CALL_CONTENT: '' | null = ''

/** The think setting as an OpenAI-compatible server takes it; nothing where the profile only shows reasoning. */
export function openAIThink(profile: ThinkProfile, setting: ThinkSetting | null): Record<string, unknown> {
  const s = normalizeThinkSetting(profile, setting)
  switch (profile.kind) {
    case 'toggle':
      return { chat_template_kwargs: { enable_thinking: s === 'on' } }
    case 'levels':
      // reasoning_effort has no "off": low is the least a server will think.
      return { reasoning_effort: s === 'off' || s === null ? 'low' : s }
    default:
      return {}
  }
}

const imagePart = (img: ChatImage) => ({ type: 'image_url', image_url: { url: `data:${img.mime};base64,${img.data}` } })

const argumentsText = (args: ToolCall['function']['arguments']): string => (typeof args === 'string' ? args : JSON.stringify(args))

function toOpenAIMessage(m: ChatMessage): Record<string, unknown> {
  switch (m.role) {
    case 'user':
      if (!m.images?.length) return { role: 'user', content: m.content }
      return { role: 'user', content: [...(m.content ? [{ type: 'text', text: m.content }] : []), ...m.images.map(imagePart)] }
    case 'assistant':
      // Earlier reasoning isn't sent back: chat templates drop it or reject it.
      if (!m.toolCalls?.length) return { role: 'assistant', content: m.content }
      return {
        role: 'assistant',
        content: m.content || EMPTY_TOOL_CALL_CONTENT,
        // assemble() and the adapters always set ids; the fallback only keeps the body valid, in the 9-character shape
        // every id Ollmost makes up has (Mistral's chat templates on vLLM refuse any other).
        tool_calls: m.toolCalls.map((c, n) => ({
          id: c.id ?? `t${n.toString(36).padStart(8, '0')}`,
          type: 'function',
          function: { name: c.function.name, arguments: argumentsText(c.function.arguments) }
        }))
      }
    case 'tool':
      return { role: 'tool', tool_call_id: m.toolCallId ?? '', content: m.content }
    default:
      return { role: 'system', content: m.content }
  }
}

/** The body of POST {baseUrl}/chat/completions for a request (the spec's mapping table). */
export function toOpenAIBody(req: ChatRequest, opts: { stream: boolean; streamOptions: boolean }): Record<string, unknown> {
  return {
    model: req.model,
    messages: req.messages.map(toOpenAIMessage),
    ...(req.tools?.length ? { tools: req.tools } : {}),
    ...openAIThink(req.profile, req.think),
    ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
    stream: opts.stream,
    // Usage comes in a last chunk only when asked for. An endpoint that rejects the option is retried without it.
    ...(opts.stream && opts.streamOptions ? { stream_options: { include_usage: true } } : {})
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/openaiBody.test.ts`
Expected: PASS

- [ ] **Step 5: Apply `capture/FINDINGS.md` (questions 1 and 5)**

Open `docs/superpowers/plans/2026-09-27-model-endpoints-capture/FINDINGS.md`. Question 5 decides `content` beside `tool_calls`;
question 1 decides the think mapping for LM Studio. Apply the row that matches; the others change nothing here.

| FINDINGS says | Change |
|---|---|
| Q5: `history-empty-content` is 200 | Nothing. |
| Q5: `''` rejected (4xx), `null` accepted | In `body.ts`: `export const EMPTY_TOOL_CALL_CONTENT: '' \| null = null`. In `tests/openaiBody.test.ts`, the echo test expects `content: null`. |
| Q5: both rejected | In `toOpenAIMessage`'s tool-call branch, replace the `content:` line with `...(m.content ? { content: m.content } : {}),` and delete `EMPTY_TOOL_CALL_CONTENT` (and its entry in the contract additions); the echo test expects no `content` key: `expect(b.messages[1]).not.toHaveProperty('content')`. |
| Q1: `reasoning_effort` and/or `chat_template_kwargs.enable_thinking` change LM Studio's reasoning | Nothing here (Task 3.7 has its own rows). |
| Q1: only `reasoning.effort` (the object) changes it | Make `openAIThink` flavour-aware, as below. |
| Q1: nothing changes it | Nothing here; Task 3.7 makes LM Studio models display-only. |

Only for "only `reasoning.effort` changes it": in `body.ts`, import `EndpointFlavor` beside `ThinkProfile` and change
`openAIThink`'s signature and `levels` case to:
```ts
export function openAIThink(profile: ThinkProfile, setting: ThinkSetting | null, flavor?: EndpointFlavor): Record<string, unknown> {
  const s = normalizeThinkSetting(profile, setting)
  switch (profile.kind) {
    case 'toggle':
      return { chat_template_kwargs: { enable_thinking: s === 'on' } }
    case 'levels': {
      const effort = s === 'off' || s === null ? 'low' : s
      // LM Studio reads effort from a `reasoning` object (capture/FINDINGS.md, question 1).
      return flavor === 'lmstudio' ? { reasoning: { effort } } : { reasoning_effort: effort }
    }
    default:
      return {}
  }
}
```
`toOpenAIBody`'s `opts` gains `flavor?: EndpointFlavor` and spreads `openAIThink(req.profile, req.think, opts.flavor)`;
Task 3.6's `OpenAIProvider.body()` passes `flavor: this.endpoint.flavor`. Add to `tests/openaiBody.test.ts`:
```ts
  it('sends LM Studio its effort inside a reasoning object', () => {
    expect(openAIThink({ kind: 'levels', canDisable: false }, 'high', 'lmstudio')).toEqual({ reasoning: { effort: 'high' } })
    expect(openAIThink({ kind: 'levels', canDisable: false }, 'high', 'vllm')).toEqual({ reasoning_effort: 'high' })
  })
```
Run: `npx vitest run tests/openaiBody.test.ts`
Expected: PASS

- [ ] **Step 6: Run the full check**

Run: `npm run typecheck && npm run lint && npm run format:check && npm test`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src/main/providers/openai/body.ts tests/openaiBody.test.ts
git commit -m "Build OpenAI chat-completions bodies from neutral requests

Images become image_url data URLs, tool calls carry their ids and JSON-text arguments, results go back by
tool_call_id, earlier reasoning stays home, and the think setting becomes chat_template_kwargs or reasoning_effort.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 3.6: `OpenAIProvider`: stream, once, sendWire, errors, `stream_options` retry

**Files:**
- Create: `src/main/providers/openai/errors.ts`
- Create: `src/main/providers/openai/discovery.ts` (the generic `/models` read; Task 3.7 adds each flavour's)
- Create: `src/main/providers/openai/adapter.ts`
- Modify: `src/main/settings.ts` (add `setEndpointStreamOptions` after PR 2's `setEndpoints`)
- Modify: `src/main/db/kv.ts` (`CachedModelInfo` gains `thinkPreset`)
- Modify: `src/main/providers/registry.ts` (`build()`; add `createProvider`)
- Modify: `src/main/providers/endpoints.ts` (`addEndpoint` takes `kind: 'openai'` and keeps its API base; `updateEndpoint` re-probes an OpenAI endpoint's edited address)
- Modify: `src/main/providers/probe.ts` (`apiBaseUrl`)
- Test: `tests/openaiErrors.test.ts`, `tests/openaiAdapter.test.ts`, `tests/openaiRegistry.test.ts`; `tests/endpoints.test.ts` (PR 2's: `updateEndpoint` is awaited, the OpenAI refusal goes)

`listModels` and `modelInfo` land here, over the generic `/models` read, because the class must be complete before the
registry can make one. Task 3.7 teaches `discoverModels` each flavour; nothing in this task changes then.

**Interfaces:**
- Consumes: `sseData` (3.2), `createStallTimer`, `STREAM_TIMEOUTS`, `StreamTimeouts` (3.2), `createThinkSplitter` (3.3),
  `createToolCallAccumulator` (3.4), `toOpenAIBody` (3.5); `Provider`, `ChatRequest`, `ChatEvent`, `ChatResult`,
  `ChatTiming`, `RequestUsage`, `WireRequest` (PR 1); `getSecret`, `endpointSecretName` (PR 1); `toModelKey`
  (`@shared/modelKey`); `readModelProfile`, `writeModelInfo`, `writeModelDetected`, `CachedModelInfo` (`db/kv.ts`);
  `whereOf`, `billingOf` (`providers/where.ts`); `contextWindowFor` (`providers/context.ts`); `displayAddress`
  (`@shared/endpoints`); `formatContext` (`@shared/format`); `setEndpoints` (`settings.ts`); PR 2's registry `build()`
  and `addEndpoint`.
- Produces: `class OpenAIProvider implements Provider` (`constructor(endpoint: Endpoint, opts?: { timeouts?: StreamTimeouts })`);
  `friendlyOpenAIError(endpoint: Pick<Endpoint, 'name' | 'baseUrl' | 'flavor'>, status: number, body: string, model?: string): { error: Error; detected?: ModelDetected }`
  (the contract's `Endpoint` narrowed to what it reads, so every `Endpoint` still fits); `OpenAIError`;
  `unreachableError`; `discoverModels(endpoint, apiKey)`, `DiscoveredModel`, `rootOf`, `getJson`;
  `setEndpointStreamOptions(id, supported)`; `createProvider(endpoint)`.

What the adapter does, from the spec:
- **Request:** `POST {baseUrl}/chat/completions` with `Authorization: Bearer <endpoint key>` when the endpoint has one.
- **Stream:** `delta.content` → `content`; `delta.reasoning ?? delta.reasoning_content` → `thinking`; the think
  splitter runs on content only until the server has sent a reasoning field; tool calls go out whole after the stream
  ends (so on `finish_reason` or `[DONE]`); `done` carries `finish_reason`, `usage.prompt_tokens`/`completion_tokens`
  (llama.cpp's `timings.prompt_n`/`predicted_n` when there's no usage) and llama.cpp's `timings.prompt_ms`/`predicted_ms`.
  A payload that shows nothing yields an empty `content` (PR 1's "the server is there" signal).
- **Endings:** neither `finish_reason` nor `[DONE]` → "The connection to <name> dropped before the reply finished.";
  `data: {"error":…}` throws its message; the user's Stop stays an `AbortError` (Review Focus #4). Whatever the think
  splitter still holds goes out before the error, so a stopped or broken reply keeps all its text.
- **Timeouts:** the endpoint is `this-mac` or `network`, never `cloud`, so it keeps the local allowances
  (`STREAM_TIMEOUTS`): first byte 10 minutes, idle 3, idle with tools 30.
- **`stream_options`:** a 400 or 422 that names it is retried once without it, and `streamOptions: false` is saved on
  the endpoint.
- **Errors:** the spec's table, and `detected` learned from the tool-flag and context-overflow errors.

- [ ] **Step 1: Write the failing error tests**

`tests/openaiErrors.test.ts`:
```ts
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { Endpoint } from '@shared/types'
import { friendlyOpenAIError, OpenAIError, unreachableError } from '../src/main/providers/openai/errors'
import { FIXTURES, fixtureText } from './ollamaMock'

const lm: Endpoint = { id: 'lm-studio', name: 'LM Studio', kind: 'openai', flavor: 'lmstudio', baseUrl: 'http://localhost:1234/v1', enabled: true, hasKey: false }
const gpu: Endpoint = { ...lm, id: 'gpu-box', name: 'GPU box', flavor: 'vllm', baseUrl: 'http://192.168.1.20:8000/v1' }
const box: Endpoint = { ...lm, id: 'box', name: 'Box', flavor: 'llamacpp', baseUrl: 'http://localhost:8080/v1' }

describe('unreachableError', () => {
  it('names the endpoint and its address, with how to start that server', () => {
    expect(unreachableError(lm).message).toBe("Can't reach LM Studio at localhost:1234. Is its server started? Start it in LM Studio’s Developer tab.")
    expect(unreachableError(gpu).message).toBe("Can't reach GPU box at 192.168.1.20:8000. Is its server started? Start it with `vllm serve`.")
    expect(unreachableError(box).message).toBe("Can't reach Box at localhost:8080. Is its server started? Start it with `llama-server`.")
    expect(unreachableError({ ...lm, name: 'Lab', flavor: 'generic' }).message).toBe("Can't reach Lab at localhost:1234. Is its server started?")
  })
})

describe('friendlyOpenAIError', () => {
  it('points a rejected key at the endpoint’s settings', () => {
    for (const status of [401, 403])
      expect(friendlyOpenAIError(lm, status, '{"error":"Unauthorized"}').error.message).toBe(
        'LM Studio rejected the API key. Check it in Settings → Models → LM Studio.'
      )
  })

  it('says which model a server lacks', () => {
    const body = JSON.stringify({ object: 'error', message: 'The model `qwen` does not exist.', type: 'NotFoundError', param: null, code: 404 })
    expect(friendlyOpenAIError(gpu, 404, body, 'qwen').error.message).toBe("GPU box doesn't have a model called qwen.")
  })

  it('passes another 404 through with the endpoint’s name', () => {
    expect(friendlyOpenAIError(lm, 404, 'Not Found', 'qwen').error.message).toBe('LM Studio: Not Found')
  })

  it('turns tools off when vLLM needs --enable-auto-tool-choice', () => {
    const body = JSON.stringify({
      object: 'error',
      message: '"auto" tool choice requires --enable-auto-tool-choice and --tool-call-parser to be set',
      type: 'BadRequestError',
      code: 400
    })
    const { error, detected } = friendlyOpenAIError(gpu, 400, body, 'Qwen/Qwen3-8B')
    expect(error.message).toBe(
      "GPU box can't use tools with this model until it's started with `--enable-auto-tool-choice --tool-call-parser …`. Retry to answer without tools; Settings → Models → GPU box turns them back on."
    )
    expect(detected).toEqual({ tools: false, reason: 'server lacks --enable-auto-tool-choice' })
  })

  it('turns tools off when llama.cpp needs --jinja', () => {
    const body = JSON.stringify({ error: { code: 500, message: 'tools param requires --jinja flag', type: 'server_error' } })
    const { error, detected } = friendlyOpenAIError(box, 500, body, 'qwen3')
    expect(error.message).toContain("Box can't use tools with this model until it's started with `--jinja`.")
    expect(detected).toEqual({ tools: false, reason: 'server lacks --jinja' })
  })

  it('learns the context size from vLLM’s overflow error', () => {
    const body = JSON.stringify({
      object: 'error',
      message:
        "This model's maximum context length is 32768 tokens. However, you requested 40000 tokens (39000 in the messages, 1000 in the completion). Please reduce the length of the messages or completion.",
      type: 'BadRequestError',
      code: 400
    })
    const { error, detected } = friendlyOpenAIError(gpu, 400, body, 'Qwen/Qwen3-8B')
    expect(error.message).toBe(
      'This chat no longer fits Qwen/Qwen3-8B on GPU box (a 33K context). Ollmost now plans for that size: retry, use /compact, or start a new chat.'
    )
    expect(detected).toEqual({ contextLength: 32768, reason: 'GPU box reported a 33K context' })
  })

  it('learns it from llama.cpp’s exceed_context_size_error', () => {
    const body = JSON.stringify({
      error: { code: 400, message: 'the request exceeds the available context size, try increasing it', type: 'exceed_context_size_error', n_prompt_tokens: 5000, n_ctx: 4096 }
    })
    expect(friendlyOpenAIError(box, 400, body, 'qwen3').detected).toEqual({ contextLength: 4096, reason: 'Box reported a 4K context' })
  })

  it('reads every error shape servers send, and names the endpoint', () => {
    expect(friendlyOpenAIError(lm, 500, 'boom').error.message).toBe('LM Studio: boom')
    expect(friendlyOpenAIError(lm, 500, '{"error":"x"}').error.message).toBe('LM Studio: x')
    expect(friendlyOpenAIError(lm, 500, '{"detail":"y"}').error.message).toBe('LM Studio: y')
    expect(friendlyOpenAIError(lm, 502, '').error.message).toBe('LM Studio: HTTP 502')
    expect(friendlyOpenAIError(lm, 429, '').error.message).toBe('LM Studio is busy or rate-limited. Try again in a moment.')
  })

  it('is an OpenAIError carrying the status', () => {
    const { error } = friendlyOpenAIError(lm, 418, 'teapot')
    expect(error).toBeInstanceOf(OpenAIError)
    expect((error as OpenAIError).status).toBe(418)
  })

  it.runIf(existsSync(join(FIXTURES, 'once/lmstudio-error-unknown-model.json')))('reads LM Studio’s own unknown-model reply', () => {
    const { status } = JSON.parse(readFileSync(join(FIXTURES, 'once/lmstudio-error-unknown-model.meta.json'), 'utf8')) as { status: number }
    const body = fixtureText('once/lmstudio-error-unknown-model.json')
    expect(friendlyOpenAIError(lm, status, body, 'ollmost-no-such-model').error.message).toBe("LM Studio doesn't have a model called ollmost-no-such-model.")
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/openaiErrors.test.ts`
Expected: FAIL with `Failed to resolve import "../src/main/providers/openai/errors"`.

- [ ] **Step 3: Implement `src/main/providers/openai/errors.ts`**

```ts
import { displayAddress } from '@shared/endpoints'
import { formatContext } from '@shared/format'
import type { Endpoint, EndpointFlavor, ModelDetected } from '@shared/types'

export class OpenAIError extends Error {
  constructor(
    message: string,
    readonly status?: number
  ) {
    super(message)
  }
}

// What to do about a server that isn't answering, by the kind of server it is.
const START_HINTS: Record<EndpointFlavor, string> = {
  ollama: '',
  lmstudio: ' Start it in LM Studio’s Developer tab.',
  llamacpp: ' Start it with `llama-server`.',
  vllm: ' Start it with `vllm serve`.',
  generic: ''
}

export function unreachableError(endpoint: Pick<Endpoint, 'name' | 'baseUrl' | 'flavor'>): OpenAIError {
  return new OpenAIError(`Can't reach ${endpoint.name} at ${displayAddress(endpoint.baseUrl)}. Is its server started?${START_HINTS[endpoint.flavor]}`)
}

// Servers that need a start-up flag before they take tools say so in their error.
const TOOL_FLAGS = [
  { match: /enable-auto-tool-choice|tool-call-parser/i, flag: '`--enable-auto-tool-choice --tool-call-parser …`', reason: 'server lacks --enable-auto-tool-choice' },
  { match: /--jinja/i, flag: '`--jinja`', reason: 'server lacks --jinja' }
]

// How servers say a model isn't there: vLLM "does not exist", others "not found".
const MISSING_MODEL = /not found|does not exist|no such|invalid model|unknown model/i

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/** The message in any of the error shapes servers send, and the error object itself when there is one. */
function readError(body: string): { detail: string; error: Record<string, unknown> } {
  let json: unknown
  try {
    json = JSON.parse(body)
  } catch {
    return { detail: body.trim(), error: {} }
  }
  const obj = isRecord(json) ? json : {}
  if (typeof obj.error === 'string') return { detail: obj.error, error: {} }
  if (isRecord(obj.error)) return { detail: typeof obj.error.message === 'string' ? obj.error.message : body.trim(), error: obj.error }
  const detail = typeof obj.message === 'string' ? obj.message : typeof obj.detail === 'string' ? obj.detail : body.trim()
  return { detail, error: obj }
}

// vLLM: "maximum context length is 32768 tokens"; llama.cpp: an exceed_context_size_error with n_ctx.
function contextLimitOf(detail: string, error: Record<string, unknown>): number | null {
  const m = /maximum context length is (\d+)/i.exec(detail)
  if (m) return Number(m[1])
  return error.type === 'exceed_context_size_error' && typeof error.n_ctx === 'number' ? error.n_ctx : null
}

/**
 * An HTTP error from an OpenAI-compatible server in words that name the endpoint, and what it teaches about the model
 * (tools refused until a server flag is set; the real context size), for model_profiles' `detected`.
 */
export function friendlyOpenAIError(
  endpoint: Pick<Endpoint, 'name' | 'baseUrl' | 'flavor'>,
  status: number,
  body: string,
  model?: string
): { error: Error; detected?: ModelDetected } {
  const { name } = endpoint
  const { detail, error } = readError(body)
  const fail = (message: string, detected?: ModelDetected) => {
    const e = new OpenAIError(message, status)
    return detected ? { error: e, detected } : { error: e }
  }
  if (status === 401 || status === 403) return fail(`${name} rejected the API key. Check it in Settings → Models → ${name}.`)
  if (status === 429) return fail(`${name} is busy or rate-limited. Try again in a moment.`)
  const tools = TOOL_FLAGS.find((t) => t.match.test(detail))
  if (tools)
    return fail(
      `${name} can't use tools with this model until it's started with ${tools.flag}. Retry to answer without tools; Settings → Models → ${name} turns them back on.`,
      { tools: false, reason: tools.reason }
    )
  const window = contextLimitOf(detail, error)
  if (window)
    return fail(
      `This chat no longer fits ${model ?? 'the model'} on ${name} (a ${formatContext(window)} context). Ollmost now plans for that size: retry, use /compact, or start a new chat.`,
      { contextLength: window, reason: `${name} reported a ${formatContext(window)} context` }
    )
  if (model && /model/i.test(detail) && (status === 404 || MISSING_MODEL.test(detail))) return fail(`${name} doesn't have a model called ${model}.`)
  return fail(`${name}: ${detail || `HTTP ${status}`}`)
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `npx vitest run tests/openaiErrors.test.ts`
Expected: PASS. If only the LM Studio capture case fails, `FINDINGS.md`'s `error-unknown-model` shows LM Studio's
wording: add its phrase to `MISSING_MODEL` (lower case, `|`-separated) and run again.

- [ ] **Step 5: Write the failing adapter tests**

`tests/openaiAdapter.test.ts`:
```ts
import { existsSync } from 'node:fs'
import type { ServerResponse } from 'node:http'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Endpoint } from '@shared/types'
import type { ChatEvent, ChatRequest } from '../src/main/providers/types'
import {
  byteChunks,
  capturedChunks,
  FIXTURES,
  fixtureText,
  type MockOllama,
  sse,
  sseDelta,
  sseDone,
  startMockOllama,
  streamSse
} from './ollamaMock'

// The adapter's own dependencies are faked: model_profiles (a Map), the endpoint store and the endpoint key. The server
// is a local mock speaking OpenAI's SSE.
const fake = vi.hoisted(() => {
  type Row = { info: unknown; fetchedAt: number; overrides: Record<string, unknown>; detected: Record<string, unknown> }
  const rows = new Map<string, Row>()
  const row = (key: string): Row => rows.get(key) ?? { info: null, fetchedAt: 0, overrides: {}, detected: {} }
  return { rows, row, key: null as string | null, streamOptions: [] as Array<[string, boolean]> }
})
vi.mock('../src/main/db/kv', () => ({
  readModelProfile: (key: string) => fake.row(key),
  writeModelInfo: (key: string, info: unknown) => void fake.rows.set(key, { ...fake.row(key), info, fetchedAt: Date.now() }),
  writeModelDetected: (key: string, detected: Record<string, unknown>) => void fake.rows.set(key, { ...fake.row(key), detected }),
  writeModelOverrides: (key: string, overrides: Record<string, unknown>) => void fake.rows.set(key, { ...fake.row(key), overrides })
}))
vi.mock('../src/main/settings', () => ({ setEndpointStreamOptions: (id: string, v: boolean) => void fake.streamOptions.push([id, v]) }))
vi.mock('../src/main/providers/secrets', () => ({ endpointSecretName: (id: string) => `endpointKey:${id}`, getSecret: () => fake.key }))

const { OpenAIProvider } = await import('../src/main/providers/openai/adapter')

let server: MockOllama
beforeAll(async () => {
  server = await startMockOllama()
})
afterAll(() => server.close())
beforeEach(() => {
  fake.rows.clear()
  fake.key = null
  fake.streamOptions.length = 0
  server.requests.length = 0
})

const fast = { firstByteMs: 2_000, idleMs: 2_000, toolIdleMs: 2_000 }
const endpoint = (over: Partial<Endpoint> = {}): Endpoint => ({
  id: 'lm',
  name: 'LM Studio',
  kind: 'openai',
  flavor: 'lmstudio',
  baseUrl: `${server.url}/v1`,
  enabled: true,
  hasKey: false,
  ...over
})
const provider = (over: Partial<Endpoint> = {}, timeouts = fast) => new OpenAIProvider(endpoint(over), { timeouts })
const req = (over: Partial<ChatRequest> = {}): ChatRequest => ({
  model: 'qwen/qwen3-8b',
  messages: [{ role: 'user', content: 'hi' }],
  think: null,
  profile: { kind: 'none' },
  contextWindow: null,
  ...over
})
const TOOLS = [{ type: 'function' as const, function: { name: 'get_weather', description: 'Weather', parameters: { type: 'object' } } }]

async function collect(p = provider(), request = req(), signal = new AbortController().signal): Promise<ChatEvent[]> {
  const out: ChatEvent[] = []
  for await (const e of p.chatStream(request, signal)) out.push(e)
  return out
}
const text = (events: ChatEvent[], type: 'content' | 'thinking') => events.flatMap((e) => (e.type === type ? [e.text] : [])).join('')
const calls = (events: ChatEvent[]) => events.flatMap((e) => (e.type === 'toolCall' ? [e.call] : []))

/** Serve these pieces as one SSE reply, and collect what the adapter makes of them. */
function replay(chunks: Array<string | Uint8Array>, p = provider()): Promise<ChatEvent[]> {
  server.handler = (_req, res) => streamSse(res, chunks).then(() => res.end())
  return collect(p)
}
const ok = (content = 'ok') => [sseDelta({ content }, 'stop'), sseDone]

describe('chatStream', () => {
  it('streams content, reasoning, and one done with usage and timing', async () => {
    const events = await replay([
      sseDelta({ role: 'assistant', content: '' }),
      sseDelta({ reasoning_content: 'Think' }),
      sseDelta({ reasoning_content: 'ing.' }),
      sseDelta({ content: 'Hel' }),
      sseDelta({ content: 'lo' }),
      sseDelta({}, 'length'),
      sse({ id: 'x', object: 'chat.completion.chunk', choices: [], usage: { prompt_tokens: 9, completion_tokens: 4 }, timings: { prompt_ms: 12.5, predicted_ms: 80 } }),
      sseDone
    ])
    expect(text(events, 'thinking')).toBe('Thinking.')
    expect(text(events, 'content')).toBe('Hello')
    expect(events.filter((e) => e.type === 'done')).toHaveLength(1)
    expect(events.at(-1)).toEqual({ type: 'done', usage: { prompt: 9, completion: 4 }, finishReason: 'length', timing: { promptMs: 12.5, genMs: 80 }, raw: expect.anything() })
  })

  it('says the server is there with an empty content for a chunk that shows nothing', async () => {
    const events = await replay([sseDelta({ role: 'assistant', content: '' }), ...ok('Hi')])
    expect(events[0]).toEqual({ type: 'content', text: '' })
  })

  it('posts an OpenAI chat-completions body, asking for usage, with the endpoint’s key', async () => {
    fake.key = 'sk-local'
    let auth: string | undefined
    let url: string | undefined
    server.handler = (r, res) => {
      auth = r.headers.authorization
      url = r.url
      return streamSse(res, ok()).then(() => res.end())
    }
    await collect()
    expect(url).toBe('/v1/chat/completions')
    expect(auth).toBe('Bearer sk-local')
    expect(server.requests.at(-1)).toEqual({ model: 'qwen/qwen3-8b', messages: [{ role: 'user', content: 'hi' }], stream: true, stream_options: { include_usage: true } })
  })

  it('sends no Authorization header without a key', async () => {
    let auth: string | undefined = 'unset'
    server.handler = (r, res) => {
      auth = r.headers.authorization
      return streamSse(res, ok()).then(() => res.end())
    }
    await collect()
    expect(auth).toBeUndefined()
  })

  it('sends exactly what wire() says', async () => {
    const p = provider()
    const request = req({ tools: TOOLS, temperature: 0.2, profile: { kind: 'toggle' }, think: 'on' })
    await replay(ok(), p)
    await collect(p, request)
    expect(server.requests.at(-1)).toEqual(p.wire(request, true).body)
    expect(p.wire(request, true).endpoint).toBe(`${server.url}/v1/chat/completions`)
    expect(p.wireEndpoint()).toBe(`${server.url}/v1/chat/completions`)
  })

  it('reads a reply split anywhere the same as whole', async () => {
    const all = fixtureText('sse/llamacpp-reasoning.sse')
    const whole = await replay([all])
    expect(await replay(byteChunks(all, 7))).toEqual(whole)
    expect(await replay(byteChunks(all, 1))).toEqual(whole)
  })

  it('splits a leading <think> block out of content when no reasoning field comes', async () => {
    const events = await replay([sseDelta({ content: '<thi' }), sseDelta({ content: 'nk>plan</think>\n\nAnswer' }), sseDelta({}, 'stop'), sseDone])
    expect(text(events, 'thinking')).toBe('plan')
    expect(text(events, 'content')).toBe('Answer')
  })

  it('leaves <think> in content once the server has sent reasoning apart', async () => {
    const events = await replay([sseDelta({ reasoning: 'r' }), sseDelta({ content: 'Use <think> tags' }), sseDelta({}, 'stop'), sseDone])
    expect(text(events, 'thinking')).toBe('r')
    expect(text(events, 'content')).toBe('Use <think> tags')
  })

  it('reads llama.cpp: reasoning_content, usage and timings', async () => {
    const events = await replay(byteChunks(fixtureText('sse/llamacpp-reasoning.sse'), 11))
    expect(text(events, 'thinking')).toBe('The user says hi. Greet them back — briefly.')
    expect(text(events, 'content')).toBe('Hello! Café or tea?')
    expect(events.at(-1)).toMatchObject({ type: 'done', usage: { prompt: 11, completion: 17 }, finishReason: 'stop', timing: { promptMs: 35.2, genMs: 254.1 } })
  })

  it('reads llama.cpp’s tool call, with token counts from its timings', async () => {
    const events = await replay(byteChunks(fixtureText('sse/llamacpp-tools.sse'), 13))
    expect(calls(events)).toEqual([{ id: 'Xk3pQ9dLr2VbN7sT0aYw4eHu', function: { name: 'get_weather', arguments: { city: 'Zürich' } } }])
    expect(events.at(-1)).toMatchObject({ type: 'done', usage: { prompt: 180, completion: 21 }, finishReason: 'tool_calls', timing: { promptMs: 402.7, genMs: 318.4 } })
  })

  it('reads vLLM: reasoning in `reasoning`, usage in a last chunk', async () => {
    const events = await replay([fixtureText('sse/vllm-reasoning.sse')])
    expect(text(events, 'thinking')).toBe('Capital of France. Easy.')
    expect(text(events, 'content')).toBe('Paris.')
    expect(events.at(-1)).toEqual({ type: 'done', usage: { prompt: 12, completion: 12 }, finishReason: 'stop', raw: expect.anything() })
  })

  it('hands over two calls whole, after the text and before done', async () => {
    const events = await replay(byteChunks(fixtureText('sse/vllm-tools.sse'), 17))
    expect(calls(events)).toEqual([
      { id: 'chatcmpl-tool-5b1c', function: { name: 'get_weather', arguments: { city: 'Paris' } } },
      { id: 'chatcmpl-tool-9e7a', function: { name: 'get_time', arguments: { zone: 'Europe/Paris' } } }
    ])
    const types = events.map((e) => e.type)
    expect(types.slice(-3)).toEqual(['toolCall', 'toolCall', 'done'])
    expect(events.at(-1)).toMatchObject({ finishReason: 'tool_calls', usage: { prompt: 240, completion: 41 } })
  })

  it('treats a stream that ends with neither finish_reason nor [DONE] as a dropped connection', async () => {
    await expect(replay([sseDelta({ content: 'partial' })])).rejects.toThrow('The connection to LM Studio dropped before the reply finished.')
  })

  it('hands over the text it was holding back when the reply breaks off', async () => {
    server.handler = (_r, res) => streamSse(res, [sseDelta({ content: 'Half an ans' })]).then(() => res.end())
    const seen: ChatEvent[] = []
    const read = async () => {
      for await (const e of provider().chatStream(req(), new AbortController().signal)) seen.push(e)
    }
    await expect(read()).rejects.toThrow(/dropped before the reply finished/)
    expect(text(seen, 'content')).toBe('Half an ans')
  })

  it('accepts a finish_reason with no [DONE], and a [DONE] with no finish_reason', async () => {
    expect(text(await replay([sseDelta({ content: 'Hi' }), sseDelta({}, 'stop')]), 'content')).toBe('Hi')
    expect(text(await replay([sseDelta({ content: 'Hi' }), sseDone]), 'content')).toBe('Hi')
  })

  it('surfaces an error sent mid-stream', async () => {
    await expect(replay([sseDelta({ content: 'a' }), sse({ error: { message: 'model crashed', code: 500 } })])).rejects.toThrow('LM Studio: model crashed')
  })

  it('turns an unreadable payload into a friendly error', async () => {
    await expect(replay(['data: {"choices": [\n\n'])).rejects.toThrow(/LM Studio sent a response Ollmost couldn't read/)
  })

  it('gives up when the first byte never arrives', async () => {
    server.handler = () => undefined
    await expect(collect(provider({}, { firstByteMs: 150, idleMs: 5_000, toolIdleMs: 5_000 }))).rejects.toThrow(/LM Studio didn't start replying/)
  })

  it('gives up when the stream stalls mid-reply', async () => {
    server.handler = (_r, res) => streamSse(res, [sseDelta({ content: 'a' })])
    await expect(collect(provider({}, { firstByteMs: 5_000, idleMs: 150, toolIdleMs: 5_000 }))).rejects.toThrow(/LM Studio stopped responding/)
  })

  it('waits longer for a quiet stream when tools are offered', async () => {
    server.handler = async (_r, res) => {
      await streamSse(res, [sseDelta({ role: 'assistant', content: '' })])
      await new Promise((r) => setTimeout(r, 300))
      res.end(sseDelta({ tool_calls: [{ index: 0, id: 'c1', type: 'function', function: { name: 'get_weather', arguments: '{}' } }] }, 'tool_calls') + sseDone)
    }
    const p = provider({}, { firstByteMs: 5_000, idleMs: 150, toolIdleMs: 5_000 })
    expect(calls(await collect(p, req({ tools: TOOLS })))).toHaveLength(1)
  })

  // Review Focus #4.
  it('stops with an AbortError, not "connection dropped", when the user stops mid-stream', async () => {
    server.handler = (_r, res) => streamSse(res, [sseDelta({ reasoning_content: 'thinking…' })])
    const controller = new AbortController()
    const run = collect(provider({}, { firstByteMs: 5_000, idleMs: 5_000, toolIdleMs: 5_000 }), req(), controller.signal)
    setTimeout(() => controller.abort(), 50)
    const err = await run.catch((e: Error) => e)
    expect(err.name).toBe('AbortError')
    expect(err.message).not.toMatch(/dropped/)
  })

  it('closes the connection when the caller stops reading early', async () => {
    let closed = false
    server.handler = (_r, res) => {
      res.on('close', () => (closed = true))
      return streamSse(res, [sseDelta({ reasoning_content: 'a' })])
    }
    for await (const _event of provider({}, { firstByteMs: 5_000, idleMs: 5_000, toolIdleMs: 5_000 }).chatStream(req(), new AbortController().signal)) break
    await vi.waitFor(() => expect(closed).toBe(true), { timeout: 2_000 })
  })

  it('retries once without stream_options when the server rejects it, and remembers that', async () => {
    server.handler = (r, res) =>
      r.json.stream_options
        ? void res.writeHead(400).end(JSON.stringify({ error: { message: 'Unrecognized request argument supplied: stream_options', type: 'invalid_request_error' } }))
        : streamSse(res, ok()).then(() => res.end())
    const p = provider()
    expect(text(await collect(p), 'content')).toBe('ok')
    expect(server.requests.map((b) => 'stream_options' in b)).toEqual([true, false])
    expect(fake.streamOptions).toEqual([['lm', false]])
    expect(p.wire(req(), true).body).not.toHaveProperty('stream_options')
    await collect(p)
    expect(server.requests).toHaveLength(3)
  })

  it('leaves stream_options out for an endpoint that rejected it before', async () => {
    await replay(ok(), provider({ streamOptions: false }))
    expect(server.requests.at(-1)).not.toHaveProperty('stream_options')
  })

  it('doesn’t retry a 400 about something else', async () => {
    server.handler = (_r, res) => void res.writeHead(400).end(JSON.stringify({ error: { message: 'messages must not be empty' } }))
    await expect(collect()).rejects.toThrow('LM Studio: messages must not be empty')
    expect(server.requests).toHaveLength(1)
    expect(fake.streamOptions).toEqual([])
  })

  it('names the endpoint and its address when it can’t be reached', async () => {
    await expect(collect(provider({ baseUrl: 'http://127.0.0.1:9/v1' }))).rejects.toThrow(
      "Can't reach LM Studio at 127.0.0.1:9. Is its server started? Start it in LM Studio’s Developer tab."
    )
  })

  it('learns that tools are off when the server needs a flag for them', async () => {
    server.handler = (_r, res) =>
      void res
        .writeHead(400)
        .end(JSON.stringify({ object: 'error', message: '"auto" tool choice requires --enable-auto-tool-choice and --tool-call-parser to be set', code: 400 }))
    const p = provider({ id: 'gpu', name: 'GPU box', flavor: 'vllm' })
    await expect(collect(p, req({ model: 'Qwen/Qwen3-8B', tools: TOOLS }))).rejects.toThrow(/GPU box can't use tools with this model/)
    expect(fake.row('gpu/Qwen/Qwen3-8B').detected).toEqual({ tools: false, reason: 'server lacks --enable-auto-tool-choice' })
  })

  it('learns the context size from an overflow error, keeping what it knew', async () => {
    fake.rows.set('gpu/Qwen/Qwen3-8B', { info: null, fetchedAt: 0, overrides: {}, detected: { tools: false, reason: 'server lacks --enable-auto-tool-choice' } })
    server.handler = (_r, res) =>
      void res.writeHead(400).end(JSON.stringify({ object: 'error', message: "This model's maximum context length is 16384 tokens. However, you requested 20000 tokens.", code: 400 }))
    await expect(collect(provider({ id: 'gpu', name: 'GPU box', flavor: 'vllm' }), req({ model: 'Qwen/Qwen3-8B' }))).rejects.toThrow(/no longer fits/)
    expect(fake.row('gpu/Qwen/Qwen3-8B').detected).toEqual({ tools: false, contextLength: 16384, reason: 'GPU box reported a 16K context' })
  })
})

describe('the LM Studio captures', () => {
  const has = (path: string) => existsSync(join(FIXTURES, path))
  // What the capture itself says about usage (capture/FINDINGS.md, question 3).
  const reportedUsage = (path: string) =>
    fixtureText(path)
      .split('\n')
      .filter((l) => l.startsWith('data: {'))
      .map((l) => JSON.parse(l.slice(6)) as { usage?: { prompt_tokens: number; completion_tokens: number } | null })
      .find((c) => c.usage)?.usage

  it('streams its plain reply the same in the pieces it arrived in and in any others', async () => {
    const events = await replay(capturedChunks('sse/lmstudio-plain.sse'))
    expect(await replay(byteChunks(fixtureText('sse/lmstudio-plain.sse'), 5))).toEqual(events)
    expect(text(events, 'content').trim()).not.toBe('')
    expect(events.filter((e) => e.type === 'done')).toHaveLength(1)
    expect(events.at(-1)).toMatchObject({ type: 'done', finishReason: 'stop' })
    const usage = reportedUsage('sse/lmstudio-plain.sse')
    if (usage) expect(events.at(-1)).toMatchObject({ usage: { prompt: usage.prompt_tokens, completion: usage.completion_tokens } })
  })

  it('reads the reply streamed without stream_options', async () => {
    const events = await replay(capturedChunks('sse/lmstudio-plain-no-usage.sse'))
    expect(text(events, 'content').trim()).not.toBe('')
    expect(events.at(-1)).toMatchObject({ type: 'done' })
  })

  it('hands over its tool call whole', async () => {
    const got = calls(await replay(capturedChunks('sse/lmstudio-tool-single.sse')))
    expect(got.length).toBeGreaterThanOrEqual(1)
    expect(got[0].id).not.toBe('')
    expect(got[0].function.name).toBe('get_weather')
    expect(JSON.stringify(got[0].function.arguments)).toMatch(/paris/i)
  })

  it('keeps parallel calls apart', async () => {
    const got = calls(await replay(capturedChunks('sse/lmstudio-tool-parallel.sse')))
    expect(got.length).toBeGreaterThanOrEqual(1)
    for (const c of got) expect(c.function.name).toBe('get_weather')
    expect(new Set(got.map((c) => c.id)).size).toBe(got.length)
  })

  it.runIf(has('sse/lmstudio-think-default.sse'))('shows a thinking model’s reasoning', async () => {
    expect(text(await replay(capturedChunks('sse/lmstudio-think-default.sse')), 'thinking').trim()).not.toBe('')
  })
})

describe('chatOnce and sendWire', () => {
  const completion = (message: Record<string, unknown>, extra: Record<string, unknown> = {}) => (_r: unknown, res: ServerResponse) =>
    void res
      .writeHead(200, { 'content-type': 'application/json' })
      .end(JSON.stringify({ id: 'x', object: 'chat.completion', choices: [{ index: 0, message: { role: 'assistant', ...message }, finish_reason: 'stop' }], ...extra }))

  it('returns the whole reply, sent without stream_options', async () => {
    server.handler = completion(
      { content: 'A title', reasoning_content: 'hmm', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'f', arguments: '{"a":1}' } }] },
      { usage: { prompt_tokens: 20, completion_tokens: 2 } }
    )
    const r = await provider().chatOnce(req({ temperature: 0.3 }), { timeoutMs: 2_000 })
    expect(r).toMatchObject({ content: 'A title', thinking: 'hmm', toolCalls: [{ id: 'c1', function: { name: 'f', arguments: { a: 1 } } }], usage: { prompt: 20, completion: 2 }, finishReason: 'stop' })
    expect(JSON.stringify(r.raw)).not.toContain('A title')
    expect(server.requests.at(-1)).toMatchObject({ stream: false, temperature: 0.3 })
    expect(server.requests.at(-1)).not.toHaveProperty('stream_options')
  })

  it('splits <think> out of a reply read whole', async () => {
    server.handler = completion({ content: '<think>short</think>\n\nDone' })
    expect(await provider().chatOnce(req(), { timeoutMs: 2_000 })).toMatchObject({ content: 'Done', thinking: 'short' })
  })

  it('times out instead of hanging', async () => {
    server.handler = () => undefined
    await expect(provider().chatOnce(req(), { timeoutMs: 150 })).rejects.toThrow('LM Studio took too long to respond. Try again in a moment.')
  })

  it('replays an edited body as it is, not streamed', async () => {
    const p = provider()
    const wire = p.wire(req(), true)
    server.handler = completion({ content: 'again' })
    const r = await p.sendWire({ ...(wire.body as Record<string, unknown>), messages: [{ role: 'user', content: 'edited' }] }, { timeoutMs: 2_000 })
    expect(r.content).toBe('again')
    expect(server.requests.at(-1)).toEqual({ model: 'qwen/qwen3-8b', messages: [{ role: 'user', content: 'edited' }], stream: false })
  })

  it.runIf(existsSync(join(FIXTURES, 'once/lmstudio-tool-single.json')))('reads LM Studio’s own replies read whole', async () => {
    server.handler = (_r, res) => void res.writeHead(200, { 'content-type': 'application/json' }).end(fixtureText('once/lmstudio-plain.json'))
    expect((await provider().chatOnce(req(), { timeoutMs: 2_000 })).content.trim()).not.toBe('')
    server.handler = (_r, res) => void res.writeHead(200, { 'content-type': 'application/json' }).end(fixtureText('once/lmstudio-tool-single.json'))
    expect((await provider().chatOnce(req({ tools: TOOLS }), { timeoutMs: 2_000 })).toolCalls[0]?.function.name).toBe('get_weather')
  })
})

describe('models', () => {
  const list = (hits: { n: number }) => (r: { url?: string }, res: ServerResponse) => {
    if (r.url !== '/v1/models') return void res.writeHead(404).end()
    hits.n++
    res.writeHead(200, { 'content-type': 'application/json' }).end(fixtureText('discovery/generic-models.json'))
  }
  const generic = () => provider({ id: 'gen', name: 'Box', flavor: 'generic' })

  it('lists the chat models with their keys, where they run and the endpoint’s default context', async () => {
    server.handler = list({ n: 0 })
    const models = await generic().listModels(false)
    expect(models.map((m) => m.key)).toEqual(['gen/mistral-small-3.2-24b', 'gen/qwen3-coder-30b-a3b'])
    expect(models[0]).toMatchObject({
      name: 'mistral-small-3.2-24b',
      endpoint: { id: 'gen', name: 'Box', kind: 'openai', flavor: 'generic' },
      where: 'this-mac',
      billing: 'local',
      contextControl: 'server',
      contextWindow: 8192,
      installed: true,
      capabilities: ['completion', 'tools'],
      contextLength: null,
      price: null,
      detected: {}
    })
  })

  it('keeps a model’s info for a day, and reads it again on refresh', async () => {
    const hits = { n: 0 }
    server.handler = list(hits)
    const p = generic()
    await p.modelInfo('qwen3-coder-30b-a3b')
    await p.modelInfo('qwen3-coder-30b-a3b')
    expect(hits.n).toBe(1)
    await p.modelInfo('qwen3-coder-30b-a3b', true)
    expect(hits.n).toBe(2)
  })

  it('describes a model the server no longer lists as not installed', async () => {
    server.handler = list({ n: 0 })
    expect(await generic().modelInfo('gone-model')).toMatchObject({ key: 'gen/gone-model', installed: false, capabilities: ['completion', 'tools'] })
  })

  it('says why it can’t list when the server is down, and still describes a model it knew', async () => {
    const down = provider({ id: 'gen', name: 'Box', flavor: 'generic', baseUrl: 'http://127.0.0.1:9/v1' })
    await expect(down.listModels(false)).rejects.toThrow("Can't reach Box at 127.0.0.1:9. Is its server started?")
    fake.rows.set('gen/old', { info: { capabilities: ['completion', 'vision'], contextLength: 4096, family: null, parameterSize: null }, fetchedAt: 0, overrides: {}, detected: {} })
    expect(await down.modelInfo('old')).toMatchObject({ installed: true, capabilities: ['completion', 'vision'], contextWindow: 4096 })
  })
})
```

- [ ] **Step 6: Run it to verify it fails**

Run: `npx vitest run tests/openaiAdapter.test.ts`
Expected: FAIL with `Failed to resolve import "../src/main/providers/openai/adapter"`.

- [ ] **Step 7: Remember a rejected `stream_options` on the endpoint**

In `src/main/settings.ts`, after PR 2's `setEndpoints`:
```ts
/** A server rejected `stream_options`: stop sending it to this endpoint, across restarts too. */
export function setEndpointStreamOptions(id: string, supported: boolean): void {
  setEndpoints(stored().endpoints.map((e) => (e.id === id ? { ...e, streamOptions: supported } : e)))
}
```

- [ ] **Step 8: Let the cache hold a think preset**

In `src/main/db/kv.ts`, `CachedModelInfo` gains a field (add `ThinkProfile` to the `@shared/types` import):
```ts
export interface CachedModelInfo {
  capabilities: string[]
  contextLength: number | null
  family: string | null
  parameterSize: string | null
  /** OpenAI-compatible servers: the thinking profile the server reported (LM Studio). */
  thinkPreset?: ThinkProfile['kind'] | null
}
```

- [ ] **Step 9: Implement `src/main/providers/openai/discovery.ts` (the generic read)**

```ts
import type { Endpoint, ThinkProfile } from '@shared/types'
import { friendlyOpenAIError, OpenAIError, unreachableError } from './errors'

/** What discovery learns about one model. Where a server reports nothing, the defaults are filled in: tools on, vision off. */
export interface DiscoveredModel {
  name: string
  capabilities: string[]
  contextLength: number | null
  parameterSize: string | null
  thinkPreset: ThinkProfile['kind'] | null
  reportsCapabilities: boolean
}

type Where = Pick<Endpoint, 'name' | 'baseUrl' | 'flavor'>

// Short calls should never hang the UI on a wedged server.
const DISCOVERY_TIMEOUT_MS = 30_000

// Tools on, vision off: what a model gets when its server says nothing about it.
const DEFAULT_CAPABILITIES = ['completion', 'tools']

// Embedding and reranking models can't chat; servers that list them beside chat models give only their names.
const NOT_CHAT = /(^|[-_/])(embed|embedding|rerank)/i

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/** The address without its trailing /v1: where LM Studio's and llama.cpp's own APIs live. */
export const rootOf = (baseUrl: string): string => baseUrl.replace(/\/+$/, '').replace(/\/v1$/, '')

const unreadable = (endpoint: Where) => new OpenAIError(`${endpoint.name} sent a model list Ollmost couldn't read.`)

/** GET a JSON document from the endpoint with its key; a failure comes back in words that name the endpoint. */
export async function getJson(endpoint: Where, url: string, apiKey: string | null, timeoutMs = DISCOVERY_TIMEOUT_MS): Promise<unknown> {
  let res: Response
  try {
    res = await fetch(url, { headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {}, signal: AbortSignal.timeout(timeoutMs) })
  } catch (err) {
    if ((err as Error).name === 'TimeoutError') throw new OpenAIError(`${endpoint.name} took too long to list its models. Try again in a moment.`)
    throw unreachableError(endpoint)
  }
  const text = await res.text().catch(() => '')
  if (!res.ok) throw friendlyOpenAIError(endpoint, res.status, text).error
  try {
    return JSON.parse(text) as unknown
  } catch {
    throw unreadable(endpoint)
  }
}

/** The entries of an OpenAI `/models` list that have an id. */
function dataOf(endpoint: Where, json: unknown): Array<Record<string, unknown> & { id: string }> {
  if (!isRecord(json) || !Array.isArray(json.data)) throw unreadable(endpoint)
  return json.data.filter((m): m is Record<string, unknown> & { id: string } => isRecord(m) && typeof m.id === 'string')
}

function genericModels(endpoint: Where, json: unknown): DiscoveredModel[] {
  return dataOf(endpoint, json)
    .filter((m) => !NOT_CHAT.test(m.id))
    .map((m) => ({ name: m.id, capabilities: [...DEFAULT_CAPABILITIES], contextLength: null, parameterSize: null, thinkPreset: null, reportsCapabilities: false }))
}

/** The chat models an endpoint offers, with what its server reports about each. Throws a friendly error when it can't. */
export async function discoverModels(endpoint: Endpoint, apiKey: string | null): Promise<DiscoveredModel[]> {
  const base = endpoint.baseUrl.replace(/\/+$/, '')
  return genericModels(endpoint, await getJson(endpoint, `${base}/models`, apiKey))
}
```

- [ ] **Step 10: Implement `src/main/providers/openai/adapter.ts`**

```ts
import { toModelKey } from '@shared/modelKey'
import type { Endpoint, ModelDetected, ModelInfo } from '@shared/types'
import { type CachedModelInfo, readModelProfile, writeModelDetected, writeModelInfo } from '../../db/kv'
import { setEndpointStreamOptions } from '../../settings'
import { contextWindowFor } from '../context'
import { endpointSecretName, getSecret } from '../secrets'
import { createStallTimer, STREAM_TIMEOUTS, type StreamTimeouts } from '../stream'
import type { ChatEvent, ChatRequest, ChatResult, ChatTiming, Provider, RequestUsage, WireRequest } from '../types'
import { billingOf, whereOf } from '../where'
import { toOpenAIBody } from './body'
import { type DiscoveredModel, discoverModels } from './discovery'
import { friendlyOpenAIError, OpenAIError, unreachableError } from './errors'
import { sseData } from './sse'
import { createThinkSplitter, type ThinkSplit } from './thinkSplitter'
import { createToolCallAccumulator } from './toolCalls'

// A model's info is read again after a day, as the Ollama adapter does.
const INFO_TTL = 24 * 60 * 60 * 1000

// A model its server never described: the defaults for a server that reports nothing.
const UNKNOWN: CachedModelInfo = { capabilities: ['completion', 'tools'], contextLength: null, family: null, parameterSize: null, thinkPreset: null }

interface Delta {
  content?: string | null
  reasoning?: string | null
  reasoning_content?: string | null
  tool_calls?: unknown
}
interface Usage {
  prompt_tokens?: number
  completion_tokens?: number
}
/** llama.cpp's own counts and durations (ms). */
interface Timings {
  prompt_n?: number
  prompt_ms?: number
  predicted_n?: number
  predicted_ms?: number
}
interface StreamChunk {
  choices?: Array<{ delta?: Delta; finish_reason?: string | null }>
  usage?: Usage | null
  timings?: Timings
  error?: unknown
}
interface Completion {
  choices?: Array<{ message?: Delta; finish_reason?: string | null }>
  usage?: Usage | null
  timings?: Timings
  error?: unknown
}

// llama.cpp's timings count the tokens it processed: the fallback for a server that sends no usage.
const usageOf = (u: Usage | null | undefined, t: Timings | undefined): RequestUsage => ({
  prompt: u?.prompt_tokens ?? t?.prompt_n,
  completion: u?.completion_tokens ?? t?.predicted_n
})

const timingOf = (t: Timings | undefined): ChatTiming | undefined =>
  t && (t.prompt_ms !== undefined || t.predicted_ms !== undefined) ? { promptMs: t.prompt_ms, genMs: t.predicted_ms } : undefined

/** Thinking before content: within one piece of a reply, the reasoning came first. */
const splitEvents = ({ thinking, content }: ThinkSplit): ChatEvent[] => [
  ...(thinking ? [{ type: 'thinking' as const, text: thinking }] : []),
  ...(content ? [{ type: 'content' as const, text: content }] : [])
]

const infoOf = (d: DiscoveredModel): CachedModelInfo => ({
  capabilities: d.capabilities,
  contextLength: d.contextLength,
  family: null,
  parameterSize: d.parameterSize,
  thinkPreset: d.thinkPreset
})

const minutes = (ms: number): number => Math.round(ms / 60_000)

// A server that doesn't know stream_options names it (OpenAI answers 400; FastAPI-based servers 422).
const rejectsStreamOptions = (status: number, text: string): boolean => (status === 400 || status === 422) && /stream_options/i.test(text)

/** A reply read whole: reasoning from its field, else split out of the text. */
function resultFrom(json: Completion): ChatResult {
  const choice = json.choices?.[0]
  const message = choice?.message ?? {}
  const text = typeof message.content === 'string' ? message.content : ''
  const reasoning = message.reasoning || message.reasoning_content || ''
  let split: ThinkSplit = { content: text, thinking: reasoning }
  if (!reasoning) {
    const splitter = createThinkSplitter()
    const a = splitter.push(text)
    const b = splitter.flush()
    split = { content: a.content + b.content, thinking: a.thinking + b.thinking }
  }
  const calls = createToolCallAccumulator()
  if (Array.isArray(message.tool_calls)) calls.add(message.tool_calls.map((c, index) => ({ index, ...(c as Record<string, unknown>) })))
  return {
    ...split,
    toolCalls: calls.finish(),
    usage: usageOf(json.usage, json.timings),
    finishReason: choice?.finish_reason ?? undefined,
    timing: timingOf(json.timings),
    // The closing record without the reply's text, as the debugger shows it.
    raw: { ...json, choices: json.choices?.map(({ message: _message, ...rest }) => rest) }
  }
}

/** An OpenAI-compatible server: LM Studio, llama.cpp's llama-server, vLLM, or anything else with /v1/chat/completions. */
export class OpenAIProvider implements Provider {
  readonly id: string
  private readonly timeouts: StreamTimeouts
  // False once the server has rejected stream_options; saved on the endpoint too.
  private streamOptions: boolean

  /**
   * An OpenAI-compatible endpoint is on this Mac or the network, never 'cloud', and both keep the local allowances:
   * some servers hold a tool call back the way Ollama does. Tests pass shorter ones.
   */
  constructor(
    readonly endpoint: Endpoint,
    opts: { timeouts?: StreamTimeouts } = {}
  ) {
    this.id = endpoint.id
    this.timeouts = opts.timeouts ?? STREAM_TIMEOUTS
    this.streamOptions = endpoint.streamOptions !== false
  }

  // ---- models ----

  async listModels(_refresh: boolean): Promise<ModelInfo[]> {
    // One request lists every model with what it can do, so the list is always read fresh; model_profiles keeps each
    // model's info for modelInfo(), which runs before every reply.
    const found = await discoverModels(this.endpoint, this.apiKey())
    return found.map((d) => {
      const info = infoOf(d)
      writeModelInfo(this.keyOf(d.name), info)
      return this.toModelInfo(d.name, info, true)
    })
  }

  async modelInfo(model: string, refresh = false): Promise<ModelInfo> {
    const profile = readModelProfile(this.keyOf(model))
    const cached = profile.info
    if (!refresh && cached && Date.now() - profile.fetchedAt < INFO_TTL) return this.toModelInfo(model, cached, true)
    let listed: DiscoveredModel[] | null = null
    try {
      listed = await discoverModels(this.endpoint, this.apiKey())
    } catch {
      // Unreachable: what was known still describes the model.
    }
    const found = listed?.find((d) => d.name === model)
    if (found) {
      const info = infoOf(found)
      writeModelInfo(this.keyOf(model), info)
      return this.toModelInfo(model, info, true)
    }
    // Listed without it: it's gone from the server. Not reachable: it's as it was.
    return this.toModelInfo(model, cached ?? UNKNOWN, listed === null && cached !== null)
  }

  // ---- chat ----

  wireEndpoint(): string {
    return `${this.endpoint.baseUrl.replace(/\/+$/, '')}/chat/completions`
  }

  wire(req: ChatRequest, stream: boolean): WireRequest {
    return { endpoint: this.wireEndpoint(), body: this.body(req, stream) }
  }

  async *chatStream(req: ChatRequest, signal: AbortSignal): AsyncGenerator<ChatEvent> {
    const { name } = this.endpoint
    const t = this.timeouts
    const inner = new AbortController()
    const forward = () => inner.abort(signal.reason)
    if (signal.aborted) forward()
    else signal.addEventListener('abort', forward, { once: true })
    const stall = createStallTimer(() => inner.abort())
    stall.arm(t.firstByteMs, `${name} didn't start replying within ${minutes(t.firstByteMs)} minutes. Check that it's running, then retry.`)
    const splitter = createThinkSplitter()
    // Once the server sends reasoning in its own field, content is only reply and the splitter steps aside.
    let separated = false
    try {
      const res = await this.post(this.body(req, true), req.model, inner.signal)
      if (!res.body) throw new OpenAIError(`${name} returned an empty response.`)
      const idleMs = req.tools?.length ? t.toolIdleMs : t.idleMs
      const idle = `${name} stopped responding in the middle of the reply (nothing for ${minutes(idleMs)} minutes).`
      const calls = createToolCallAccumulator()
      let finishReason: string | undefined
      let usage: Usage | null | undefined
      let timings: Timings | undefined
      let sawDone = false
      const payloads = sseData(res.body)
      for (;;) {
        const next = await payloads.next()
        if (next.done) {
          sawDone = next.value
          break
        }
        stall.arm(idleMs, idle)
        const chunk = this.parse<StreamChunk>(next.value)
        if (chunk.error) throw this.errorIn(chunk.error, req.model)
        if (chunk.usage) usage = chunk.usage
        if (chunk.timings) timings = chunk.timings
        const choice = chunk.choices?.[0]
        const delta = choice?.delta
        const events: ChatEvent[] = []
        const reasoning = delta?.reasoning || delta?.reasoning_content
        if (reasoning) {
          if (!separated) {
            separated = true
            // Anything the splitter held back was the start of the reply.
            events.push(...splitEvents(splitter.flush()))
          }
          events.push({ type: 'thinking', text: reasoning })
        }
        if (delta?.content) events.push(...splitEvents(separated ? { thinking: '', content: delta.content } : splitter.push(delta.content)))
        const toolDeltas = delta?.tool_calls
        if (Array.isArray(toolDeltas)) calls.add(toolDeltas)
        if (choice?.finish_reason) finishReason = choice.finish_reason
        // A chunk with nothing to show still says the server is there: the loop times the first byte by it.
        if (!events.length) events.push({ type: 'content', text: '' })
        yield* events
      }
      if (!sawDone && !finishReason) throw new OpenAIError(`The connection to ${name} dropped before the reply finished.`)
      if (!separated) yield* splitEvents(splitter.flush())
      // Calls go out whole, once the stream has said it's finished (finish_reason, then [DONE] or the end).
      for (const call of calls.finish()) yield { type: 'toolCall', call }
      yield {
        type: 'done',
        usage: usageOf(usage, timings),
        finishReason,
        timing: timingOf(timings),
        raw: { finish_reason: finishReason ?? null, usage: usage ?? null, timings: timings ?? null }
      }
    } catch (err) {
      // What the splitter still holds is the start of the reply: a stopped or broken reply keeps it, as it would on Ollama.
      if (!separated) yield* splitEvents(splitter.flush())
      const stalled = stall.stalled()
      if (stalled && !signal.aborted) throw new OpenAIError(stalled)
      throw err
    } finally {
      stall.clear()
      signal.removeEventListener('abort', forward)
      // A consumer that stops early mustn't leave the server generating into an unread socket.
      inner.abort()
    }
  }

  chatOnce(req: ChatRequest, opts: { signal?: AbortSignal; timeoutMs: number }): Promise<ChatResult> {
    return this.once(this.body(req, false), req.model, opts)
  }

  /** Replay a body as it is (perhaps edited in the debugger), read whole: stream_options only goes with a stream. */
  sendWire(body: unknown, opts: { signal?: AbortSignal; timeoutMs: number }): Promise<ChatResult> {
    const { stream_options: _streamOptions, ...rest } = body as Record<string, unknown>
    return this.once({ ...rest, stream: false }, typeof rest.model === 'string' ? rest.model : undefined, opts)
  }

  // ---- internals ----

  private body(req: ChatRequest, stream: boolean): Record<string, unknown> {
    return toOpenAIBody(req, { stream, streamOptions: stream && this.streamOptions })
  }

  private apiKey(): string | null {
    return getSecret(endpointSecretName(this.endpoint.id))
  }

  private keyOf(model: string) {
    return toModelKey(this.endpoint.id, model)
  }

  private async send(body: unknown, signal: AbortSignal): Promise<Response> {
    const key = this.apiKey()
    try {
      return await fetch(this.wireEndpoint(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(key ? { Authorization: `Bearer ${key}` } : {}) },
        body: JSON.stringify(body),
        signal
      })
    } catch (err) {
      const name = (err as Error).name
      // Stop, a stall and chatOnce's timeout are told apart by the callers.
      if (name === 'AbortError' || name === 'TimeoutError') throw err
      throw unreachableError(this.endpoint)
    }
  }

  /** POST a body. A server that rejects stream_options gets it again without, once, and the endpoint remembers. */
  private async post(body: Record<string, unknown>, model: string | undefined, signal: AbortSignal): Promise<Response> {
    let res = await this.send(body, signal)
    if (!res.ok && 'stream_options' in body) {
      const text = await res.text().catch(() => '')
      if (!rejectsStreamOptions(res.status, text)) throw this.fail(res.status, text, model)
      this.streamOptions = false
      setEndpointStreamOptions(this.endpoint.id, false)
      const { stream_options: _dropped, ...rest } = body
      res = await this.send(rest, signal)
    }
    if (!res.ok) throw this.fail(res.status, await res.text().catch(() => ''), model)
    return res
  }

  private fail(status: number, text: string, model?: string): Error {
    const { error, detected } = friendlyOpenAIError(this.endpoint, status, text, model)
    if (detected && model) this.learn(model, detected)
    return error
  }

  /** Keep what an error taught about a model (tools refused, its real window) until the user re-detects it. */
  private learn(model: string, detected: ModelDetected): void {
    const key = this.keyOf(model)
    writeModelDetected(key, { ...readModelProfile(key).detected, ...detected })
  }

  /** An error sent inside a 200: `data: {"error": …}` mid-stream, or a JSON body. */
  private errorIn(error: unknown, model: string | undefined): Error {
    const code = typeof error === 'object' && error !== null && typeof (error as { code?: unknown }).code === 'number' ? (error as { code: number }).code : 500
    return this.fail(code, JSON.stringify({ error }), model)
  }

  private parse<T>(text: string): T {
    try {
      return JSON.parse(text) as T
    } catch {
      throw new OpenAIError(`${this.endpoint.name} sent a response Ollmost couldn't read: ${text.slice(0, 120)}`)
    }
  }

  private async once(body: Record<string, unknown>, model: string | undefined, opts: { signal?: AbortSignal; timeoutMs: number }): Promise<ChatResult> {
    const timeout = AbortSignal.timeout(opts.timeoutMs)
    try {
      const res = await this.post(body, model, opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout)
      const json = this.parse<Completion>(await res.text())
      if (json.error) throw this.errorIn(json.error, model)
      return resultFrom(json)
    } catch (err) {
      if ((err as Error).name === 'TimeoutError') throw new OpenAIError(`${this.endpoint.name} took too long to respond. Try again in a moment.`)
      throw err
    }
  }

  private toModelInfo(name: string, info: CachedModelInfo, installed: boolean): ModelInfo {
    const key = this.keyOf(name)
    const { overrides, detected } = readModelProfile(key)
    const where = whereOf(this.endpoint.baseUrl)
    const { id, name: endpointName, kind, flavor } = this.endpoint
    // The server fixed the window when it loaded the model: Ollmost never sends one.
    const contextControl = 'server' as const
    return {
      key,
      name,
      endpoint: { id, name: endpointName, kind, flavor },
      where,
      billing: billingOf(where),
      contextControl,
      contextWindow: contextWindowFor({ contextControl, contextLength: info.contextLength, overrides, detected }, this.endpoint),
      installed,
      capabilities: info.capabilities,
      contextLength: info.contextLength,
      family: info.family,
      parameterSize: info.parameterSize,
      overrides,
      detected,
      price: null
    }
  }
}
```

- [ ] **Step 11: Run the adapter tests to verify they pass**

Run: `npx vitest run tests/openaiAdapter.test.ts`
Expected: PASS

- [ ] **Step 12: Write the failing registry test**

`tests/openaiRegistry.test.ts`:
```ts
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { type MockOllama, startMockOllama } from './ollamaMock'

// The registry and the endpoint store for real, on an in-memory database; only Electron is faked.
vi.mock('electron', () => ({
  app: { getPath: () => '' },
  BrowserWindow: { getAllWindows: () => [] },
  safeStorage: { isEncryptionAvailable: () => true, encryptString: (s: string) => Buffer.from(s), decryptString: (b: Buffer) => b.toString() },
  shell: {},
  nativeImage: {}
}))

const server: MockOllama = await startMockOllama()
const { openDatabase } = await import('../src/main/db/index')
const { getSettings, setEndpointStreamOptions } = await import('../src/main/settings')
const { addEndpoint, updateEndpoint } = await import('../src/main/providers/endpoints')
const registry = await import('../src/main/providers/registry')
const { OpenAIProvider } = await import('../src/main/providers/openai/adapter')

beforeAll(() => openDatabase(':memory:'))
afterAll(() => server.close())

const request = { model: 'x', messages: [{ role: 'user' as const, content: 'hi' }], think: null, profile: { kind: 'none' as const }, contextWindow: null }

describe('an OpenAI-compatible endpoint', () => {
  let id = ''
  beforeAll(() => {
    id = addEndpoint({ name: 'LM Studio', baseUrl: `${server.url}/v1`, kind: 'openai', flavor: 'lmstudio' }).id
  })

  it('can be added, and its keys resolve to an OpenAIProvider for it', () => {
    expect(id).toBe('lm-studio')
    const { provider, endpoint, model } = registry.resolve('lm-studio/qwen/qwen3-8b')
    expect(provider).toBeInstanceOf(OpenAIProvider)
    expect(endpoint).toMatchObject({ id: 'lm-studio', kind: 'openai', flavor: 'lmstudio' })
    expect(model).toBe('qwen/qwen3-8b')
  })

  it('keeps a rejected stream_options off, across new providers', () => {
    setEndpointStreamOptions(id, false)
    expect(getSettings().endpoints.find((e) => e.id === id)?.streamOptions).toBe(false)
    registry.invalidateProviders()
    expect(registry.resolve('lm-studio/x').provider.wire(request, true).body).not.toHaveProperty('stream_options')
  })

  it('keeps an OpenAI-compatible server by its API base, and probes an edited address before storing it', async () => {
    expect(getSettings().endpoints.find((e) => e.id === id)).toMatchObject({ kind: 'openai', flavor: 'lmstudio', baseUrl: `${server.url}/v1` })
    const moved = await startMockOllama()
    moved.handler = (r, res) =>
      r.url === '/v1/models' ? void res.writeHead(200).end(JSON.stringify({ data: [{ id: 'm' }] })) : void res.writeHead(404).end()
    try {
      const box = addEndpoint({ name: 'Box', baseUrl: 'http://127.0.0.1:9/v1/', kind: 'openai', flavor: 'vllm' })
      expect(box).toMatchObject({ kind: 'openai', flavor: 'vllm', baseUrl: 'http://127.0.0.1:9/v1' })
      // Typed without /v1: the probe finds the API under it, and that's what is kept, with the kind of server found there.
      expect(await updateEndpoint(box.id, { baseUrl: moved.url })).toMatchObject({ id: box.id, baseUrl: `${moved.url}/v1`, flavor: 'generic' })
    } finally {
      await moved.close()
    }
  })
})
```

- [ ] **Step 13: Run it to verify it fails**

Run: `npx vitest run tests/openaiRegistry.test.ts`
Expected: FAIL: `addEndpoint` throws the message ending "…arrives in the next update".

- [ ] **Step 14: Let endpoints of kind `openai` in, stored by their API base**

PR 2's `addEndpoint` refuses `kind: 'openai'`, and past that guard it only builds an Ollama endpoint, with its address
normalised to the root. Its `updateEndpoint` normalises an edited address to the root too. An OpenAI-compatible
endpoint must keep its API base (what its probe returned, usually `<root>/v1`): its requests go to
`{baseUrl}/chat/completions`. Addresses are still compared by their root (`sameServer`, `assertAddressFree`).

In `src/main/providers/probe.ts`, add below `normalizeBaseUrl`:
```ts
/**
 * An address as typed, cleaned up (a scheme added, trailing slashes dropped) but with its path whole:
 * "localhost:1234/v1/" → "http://localhost:1234/v1". An OpenAI-compatible endpoint stores this, its API base;
 * addresses are still compared by normalizeBaseUrl's root.
 */
export function apiBaseUrl(input: string): string {
  const root = normalizeBaseUrl(input)
  const raw = input.trim()
  const path = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `http://${raw}`).pathname.replace(/\/+$/, '')
  return /\/v1$/i.test(path) ? `${root}/v1` : root
}
```

In `src/main/providers/endpoints.ts`:
- the imports gain `FLAVOR_LABELS` (from `'@shared/endpoints'`), `getSecret` (from `'./secrets'`) and `apiBaseUrl`
  (from `'./probe'`);
- `addEndpoint` becomes:
  ```ts
  export function addEndpoint(input: { name: string; baseUrl: string; kind: EndpointKind; flavor: EndpointFlavor; apiKey?: string }): Endpoint {
    const name = cleanName(input.name)
    const openai = input.kind === 'openai'
    // Ollama is kept by its root. An OpenAI-compatible server by its API base, as its probe confirmed it (usually …/v1,
    // not always): its requests go to {baseUrl}/chat/completions.
    const baseUrl = openai ? apiBaseUrl(String(input.baseUrl)) : normalizeBaseUrl(String(input.baseUrl))
    assertAddressFree(baseUrl)
    const list = stored()
    const id = slugEndpointId(name, list.map((e) => e.id))
    const flavor: EndpointFlavor = FLAVORS.includes(input.flavor) && input.flavor !== 'ollama' ? input.flavor : 'generic'
    const endpoint: StoredEndpoint = openai
      ? { id, name, kind: 'openai', flavor, baseUrl, enabled: true }
      : // A second Ollama starts without the cloud catalog, so ollama.com's models aren't listed twice.
        { id, name, kind: 'ollama', flavor: 'ollama', baseUrl, enabled: true, showCloudCatalog: false, numCtx: DEFAULT_NUM_CTX }
    // ollama.com takes the account key; an endpoint key is never kept for it.
    const key = typeof input.apiKey === 'string' ? input.apiKey.trim() : ''
    if (key && !isOllamaCloudUrl(baseUrl)) setSecret(endpointSecretName(id), key)
    return save([...list, endpoint], id)
  }
  ```
- `updateEndpoint` becomes async (Contract changes 4). Its doc comment and its first lines, through the `baseUrl`
  branch, become:
  ```ts
  /**
   * Change an endpoint. Its id never changes, so a server that moves keeps its chats. An OpenAI-compatible endpoint's
   * new address is probed first and what the probe confirmed is stored, as when it was added: its API base isn't
   * always the root plus /v1, and the server found there may be another flavour.
   */
  export async function updateEndpoint(id: string, patch: EndpointPatch): Promise<Endpoint> {
    const list = stored()
    const i = list.findIndex((e) => e.id === id)
    if (i < 0) throw new Error('That endpoint no longer exists.')
    const next: StoredEndpoint = { ...list[i] }
    if (patch.name !== undefined) next.name = cleanName(patch.name)
    if (patch.baseUrl !== undefined) {
      const typed = String(patch.baseUrl)
      assertAddressFree(normalizeBaseUrl(typed), id)
      if (next.kind === 'openai') {
        const found = await probeEndpoint(typed, getSecret(endpointSecretName(id)) ?? undefined)
        if (found.kind !== 'openai')
          throw new Error(`${FLAVOR_LABELS[found.flavor]} answers at that address, not an OpenAI-compatible server. Add it as an endpoint of its own.`)
        next.baseUrl = found.baseUrl
        next.flavor = found.flavor
      } else next.baseUrl = normalizeBaseUrl(typed)
    }
  ```
  The rest of the function (enabled, flavor, the per-kind settings, `save`) stays as PR 2 wrote it. The
  `endpoints.update` IPC handler is already `async (id, patch) => updateEndpoint(id, patch)`, so it needs no change.
- In `tests/endpoints.test.ts` (PR 2's):
  - "refuses a nameless endpoint, and an OpenAI-compatible one until its adapter exists" becomes "refuses a nameless
    endpoint": delete its `expect(() => endpoints.addEndpoint({ name: 'LM Studio', … kind: 'openai', … })).toThrow(/next update/)`.
  - In `describe('changing an endpoint')`, the first two tests become `async`, and each `updateEndpoint` call is awaited:
    `await expect(endpoints.updateEndpoint('gpu-box', { … })).resolves.toMatchObject({ … })` in "keeps its id when its
    name, address and settings change", and `await expect(endpoints.updateEndpoint(…)).rejects.toThrow(…)` for each of
    the four refusals in "refuses a taken address, a blank name and a nonsense window". The messages stay as they are.

In `src/main/providers/registry.ts`: add `import { OpenAIProvider } from './openai/adapter'` and
`import type { Endpoint } from '@shared/types'` (if not already imported), then add above `build()`:
```ts
/** The adapter for an endpoint's kind of server. */
export function createProvider(endpoint: Endpoint): Provider {
  return endpoint.kind === 'openai' ? new OpenAIProvider(endpoint) : new OllamaProvider(endpoint)
}
```
and in `build()` replace
`if (endpoint.enabled && endpoint.kind === 'ollama') map.set(endpoint.id, new OllamaProvider(endpoint))` with
`if (endpoint.enabled) map.set(endpoint.id, createProvider(endpoint))`.

- [ ] **Step 15: Run tests to verify they pass**

Run: `npx vitest run tests/openaiErrors.test.ts tests/openaiAdapter.test.ts tests/openaiRegistry.test.ts tests/registry.test.ts tests/endpoints.test.ts tests/probe.test.ts` then
`npm run typecheck && npm run lint && npm run format:check && npm test`
Expected: PASS

- [ ] **Step 16: Apply `capture/FINDINGS.md` (questions 2, 3 and 4)**

No code changes for any answer; the capture tests above are the check:
- Q2 (deltas or whole): the accumulator takes both; `lmstudio-tool-single`/`-parallel` pass either way.
- Q3 (`include_usage` honoured?): if yes, "streams its plain reply" checks the counts; if LM Studio ignores the
  option, rounds estimate usage as they do for a stopped reply; if it rejects it, the retry handles it.
- Q4 (`reasoning` or `reasoning_content`): both are read.

If a capture test fails, the capture shows something the spec didn't expect: add a case for it to
`tests/openaiAdapter.test.ts` built from the failing file's lines, fix the adapter, and write the surprise into
`FINDINGS.md`'s "Surprises".

- [ ] **Step 17: Commit**

```bash
git add src/main/providers/openai src/main/providers/registry.ts src/main/providers/endpoints.ts src/main/providers/probe.ts \
  src/main/settings.ts src/main/db/kv.ts tests/openaiErrors.test.ts tests/openaiAdapter.test.ts tests/openaiRegistry.test.ts tests/endpoints.test.ts
git commit -m "OpenAIProvider: chat with any OpenAI-compatible server

Streams SSE into neutral events: reasoning from its field or split out of the text, tool calls whole, usage and
llama.cpp's timings on done. Stop stays a stop; a stream with no ending is a dropped connection; stream_options is
dropped for good once a server rejects it. Errors name the endpoint and its address, and a tool-flag or overflow
error teaches the model's profile what the server can take. Endpoints of kind openai can now be added, and keep
their API base; an edited address is probed again before it's stored.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 3.7: Discovery per flavour and `probeEndpoint` for every flavour

**Files:**
- Modify: `src/main/providers/openai/discovery.ts` (`discoverModels` learns each flavour)
- Modify: `src/main/providers/probe.ts` (`probeEndpoint` tries every kind of server; PR 2's Ollama check becomes `probeOllama`)
- Create: `tests/fixtures/discovery/lmstudio-docs.json`
- Test: `tests/discovery.test.ts`, `tests/probeFlavours.test.ts`

**Interfaces:**
- Consumes: `getJson`, `rootOf`, `DiscoveredModel` (3.6); `apiBaseUrl` (3.6), `normalizeBaseUrl` and PR 2's Ollama probe (`probe.ts`);
  `isOllamaCloudUrl`, `displayAddress`, `FLAVOR_LABELS` (`@shared/endpoints`).
- Produces: `discoverModels(endpoint, apiKey)` for `lmstudio`, `llamacpp`, `vllm` and `generic`;
  `probeEndpoint(baseUrl: string, apiKey?: string): Promise<EndpointProbe>` for every flavour.

What each flavour reads (the spec's table):

| Flavour | Source | Read |
|---|---|---|
| lmstudio | `GET {root}/api/v1/models` | `type == 'llm'` only; `capabilities.trained_for_tool_use` → tools; `capabilities.vision`; `capabilities.reasoning.allowed_options` → think preset (low/medium/high → levels; on+off → toggle; otherwise always) and `thinking`; `loaded_instances[0].config.context_length ?? max_context_length`; `params_string` |
| llamacpp | `GET {base}/models` + `GET {root}/props` | `n_ctx` (under `default_generation_settings`, or at the top in older builds); `modalities.vision`; tools from `chat_template_caps.supports_tool_calls` (`common/jinja/caps.cpp`), on when absent; `meta.n_params` → parameter size |
| vllm | `GET {base}/models` | `max_model_len`; tools on, vision off (not reported) |
| generic | `GET {base}/models` | ids only; embedding and reranking names hidden |

Probing, in order: `{root}/api/version` → Ollama; `{root}/api/v1/models` → LM Studio 0.4+; `{root}/props` → llama.cpp;
`{base}/models` with `max_model_len` → vLLM; `{base}/models` answering → generic. LM Studio before 0.4 has no
`/api/v1/models` and is found as generic.

- [ ] **Step 1: Write the LM Studio docs fixture**

`tests/fixtures/discovery/lmstudio-docs.json` (the shape of LM Studio's REST docs, one model of each kind):
```text
# unverified: written from docs
{
  "models": [
    {
      "type": "llm", "publisher": "qwen", "key": "qwen/qwen3-8b", "display_name": "Qwen3 8B", "architecture": "qwen3", "params_string": "8B",
      "loaded_instances": [{ "id": "qwen/qwen3-8b", "config": { "context_length": 16384, "eval_batch_size": 512 } }],
      "max_context_length": 40960, "format": "gguf",
      "capabilities": { "vision": false, "trained_for_tool_use": true, "reasoning": { "allowed_options": ["off", "on"], "default": "on" } }
    },
    {
      "type": "llm", "publisher": "google", "key": "google/gemma-3-12b", "display_name": "Gemma 3 12B", "architecture": "gemma3", "params_string": "12B",
      "loaded_instances": [], "max_context_length": 131072, "format": "gguf",
      "capabilities": { "vision": true, "trained_for_tool_use": false }
    },
    {
      "type": "llm", "publisher": "openai", "key": "openai/gpt-oss-20b", "display_name": "gpt-oss 20B", "architecture": "gpt-oss", "params_string": "20B",
      "loaded_instances": [], "max_context_length": 131072, "format": "gguf",
      "capabilities": { "vision": false, "trained_for_tool_use": true, "reasoning": { "allowed_options": ["low", "medium", "high"], "default": "medium" } }
    },
    {
      "type": "embedding", "publisher": "nomic-ai", "key": "text-embedding-nomic-embed-text-v1.5", "display_name": "Nomic Embed Text v1.5",
      "loaded_instances": [], "max_context_length": 2048, "capabilities": {}
    }
  ]
}
```

- [ ] **Step 2: Write the failing discovery test**

`tests/discovery.test.ts`:
```ts
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import type { Endpoint } from '@shared/types'
import { discoverModels } from '../src/main/providers/openai/discovery'
import { fixtureJson, fixtureText, type MockOllama, startMockOllama } from './ollamaMock'

// Each test says what the server answers where; anything else is a 404.
let server: MockOllama
let routes: Record<string, unknown> = {}
let auth: string | undefined
beforeAll(async () => {
  server = await startMockOllama()
  server.handler = (r, res) => {
    auth = r.headers.authorization
    const body = routes[(r.url ?? '').split('?')[0]]
    if (body === undefined) return void res.writeHead(404).end('Not Found')
    if (typeof body === 'number') return void res.writeHead(body).end('{"error":"Unauthorized"}')
    res.writeHead(200, { 'content-type': 'application/json' }).end(typeof body === 'string' ? body : JSON.stringify(body))
  }
})
afterAll(() => server.close())
beforeEach(() => {
  routes = {}
  auth = undefined
})

const ep = (flavor: Endpoint['flavor'], over: Partial<Endpoint> = {}): Endpoint => ({
  id: 's',
  name: 'Server',
  kind: 'openai',
  flavor,
  baseUrl: `${server.url}/v1`,
  enabled: true,
  hasKey: false,
  ...over
})

describe('discoverModels', () => {
  it('reads LM Studio’s own list: chat models only, what they can do, the loaded window, a think preset', async () => {
    routes['/api/v1/models'] = fixtureText('discovery/lmstudio-docs.json')
    expect(await discoverModels(ep('lmstudio'), null)).toEqual([
      { name: 'qwen/qwen3-8b', capabilities: ['completion', 'tools', 'thinking'], contextLength: 16384, parameterSize: '8B', thinkPreset: 'toggle', reportsCapabilities: true },
      { name: 'google/gemma-3-12b', capabilities: ['completion', 'vision'], contextLength: 131072, parameterSize: '12B', thinkPreset: null, reportsCapabilities: true },
      { name: 'openai/gpt-oss-20b', capabilities: ['completion', 'tools', 'thinking'], contextLength: 131072, parameterSize: '20B', thinkPreset: 'levels', reportsCapabilities: true }
    ])
  })

  it('reads the LM Studio lists the spike captured, before and after a model loaded', async () => {
    for (const file of ['discovery/lmstudio-models-cold.json', 'discovery/lmstudio-models-loaded.json']) {
      routes['/api/v1/models'] = fixtureText(file)
      const list = fixtureJson<{ models: Array<{ type: string; key: string; loaded_instances?: Array<{ config?: { context_length?: number } }>; max_context_length?: number }> }>(file).models
      const llms = list.filter((m) => m.type === 'llm')
      const found = await discoverModels(ep('lmstudio'), null)
      expect(found.map((m) => m.name)).toEqual(llms.map((m) => m.key))
      for (const [i, m] of llms.entries()) expect(found[i].contextLength).toBe(m.loaded_instances?.[0]?.config?.context_length ?? m.max_context_length ?? null)
    }
  })

  it('reads llama.cpp: its window, vision and tools from /props, the size from /models', async () => {
    routes['/v1/models'] = fixtureText('discovery/llamacpp-models.json')
    routes['/props'] = fixtureText('discovery/llamacpp-props.json')
    expect(await discoverModels(ep('llamacpp'), null)).toEqual([
      { name: 'Qwen3-8B-Q4_K_M.gguf', capabilities: ['completion', 'tools'], contextLength: 32768, parameterSize: '8.2B', thinkPreset: null, reportsCapabilities: true }
    ])
  })

  it('reads an older llama.cpp’s /props, and one whose template can’t call tools', async () => {
    routes['/v1/models'] = { data: [{ id: 'llava.gguf' }] }
    routes['/props'] = { n_ctx: 4096, modalities: { vision: true }, chat_template_caps: { supports_tools: false, supports_tool_calls: false } }
    expect(await discoverModels(ep('llamacpp'), null)).toMatchObject([{ name: 'llava.gguf', capabilities: ['completion', 'vision'], contextLength: 4096 }])
  })

  it('gives llama.cpp the defaults when /props says nothing about tools, or isn’t there', async () => {
    routes['/v1/models'] = { data: [{ id: 'm.gguf' }] }
    routes['/props'] = { default_generation_settings: { n_ctx: 8192 } }
    expect(await discoverModels(ep('llamacpp'), null)).toMatchObject([{ capabilities: ['completion', 'tools'], contextLength: 8192, reportsCapabilities: true }])
    delete routes['/props']
    expect(await discoverModels(ep('llamacpp'), null)).toMatchObject([{ capabilities: ['completion', 'tools'], contextLength: null, reportsCapabilities: false }])
  })

  it('reads vLLM’s max_model_len and gives it the defaults', async () => {
    routes['/v1/models'] = fixtureText('discovery/vllm-models.json')
    expect(await discoverModels(ep('vllm'), null)).toEqual([
      { name: 'Qwen/Qwen3-8B', capabilities: ['completion', 'tools'], contextLength: 32768, parameterSize: null, thinkPreset: null, reportsCapabilities: false }
    ])
  })

  it('hides embedding and reranking models on a generic server', async () => {
    routes['/v1/models'] = fixtureText('discovery/generic-models.json')
    expect((await discoverModels(ep('generic'), null)).map((m) => m.name)).toEqual(['mistral-small-3.2-24b', 'qwen3-coder-30b-a3b'])
  })

  it('sends the endpoint’s key, and says so when it’s rejected', async () => {
    routes['/v1/models'] = { data: [{ id: 'm' }] }
    await discoverModels(ep('generic'), 'sk-1')
    expect(auth).toBe('Bearer sk-1')
    routes['/v1/models'] = 401
    await expect(discoverModels(ep('generic', { name: 'Lab' }), 'bad')).rejects.toThrow('Lab rejected the API key. Check it in Settings → Models → Lab.')
  })

  it('names the endpoint when it can’t be reached, or sends something that isn’t a list', async () => {
    await expect(discoverModels(ep('vllm', { name: 'GPU box', baseUrl: 'http://127.0.0.1:9/v1' }), null)).rejects.toThrow(
      "Can't reach GPU box at 127.0.0.1:9. Is its server started? Start it with `vllm serve`."
    )
    routes['/v1/models'] = { models: [] }
    await expect(discoverModels(ep('generic'), null)).rejects.toThrow("Server sent a model list Ollmost couldn't read.")
  })
})
```

- [ ] **Step 3: Run it to verify it fails**

Run: `npx vitest run tests/discovery.test.ts`
Expected: FAIL: the LM Studio and llama.cpp cases get the generic read (a 404 from `/v1/models` for LM Studio: "Server: Not Found").

- [ ] **Step 4: Teach `discoverModels` each flavour**

In `src/main/providers/openai/discovery.ts`, replace `discoverModels` with the following, and add the helpers above it:
```ts
const num = (v: unknown): number | null => (typeof v === 'number' && v > 0 ? v : null)

/** "8.2B" from llama.cpp's parameter count. */
const paramsOf = (n: number | null): string | null => (n ? `${(n / 1e9).toFixed(1)}B` : null)

/** LM Studio's reasoning options as a thinking profile: levels, an on/off toggle, or always on. */
function thinkPresetOf(reasoning: unknown): ThinkProfile['kind'] | null {
  if (!isRecord(reasoning)) return null
  const options: unknown[] = Array.isArray(reasoning.allowed_options) ? reasoning.allowed_options : []
  if (options.some((o) => o === 'low' || o === 'medium' || o === 'high')) return 'levels'
  if (options.includes('on') && options.includes('off')) return 'toggle'
  // It reasons, and LM Studio offers no way to turn that off.
  return 'always'
}

function lmStudioModels(endpoint: Where, json: unknown): DiscoveredModel[] {
  if (!isRecord(json) || !Array.isArray(json.models)) throw unreadable(endpoint)
  return json.models
    .filter((m): m is Record<string, unknown> & { key: string } => isRecord(m) && m.type === 'llm' && typeof m.key === 'string')
    .map((m) => {
      const caps = isRecord(m.capabilities) ? m.capabilities : {}
      const preset = thinkPresetOf(caps.reasoning)
      const instance: unknown = Array.isArray(m.loaded_instances) ? m.loaded_instances[0] : undefined
      const config = isRecord(instance) && isRecord(instance.config) ? instance.config : {}
      return {
        name: m.key,
        capabilities: ['completion', ...(caps.trained_for_tool_use === true ? ['tools'] : []), ...(caps.vision === true ? ['vision'] : []), ...(preset ? ['thinking'] : [])],
        // The window it's loaded with, else the most it takes (LM Studio loads a model on first use).
        contextLength: num(config.context_length) ?? num(m.max_context_length),
        parameterSize: typeof m.params_string === 'string' ? m.params_string : null,
        thinkPreset: preset,
        reportsCapabilities: true
      }
    })
}

function llamaCppModels(endpoint: Where, list: unknown, props: unknown): DiscoveredModel[] {
  const p = isRecord(props) ? props : null
  const settings = p && isRecord(p.default_generation_settings) ? p.default_generation_settings : {}
  // The window the server opened: newer builds put n_ctx under default_generation_settings, older ones at the top.
  // meta.n_ctx_train is only the most the model was trained for.
  const nCtx = num(settings.n_ctx) ?? num(p?.n_ctx)
  const caps = p && isRecord(p.chat_template_caps) ? p.chat_template_caps : {}
  // The key is common/jinja/caps.cpp's; a build that doesn't report it gets the default. Tools also need --jinja,
  // which the server's error names.
  const tools = typeof caps.supports_tool_calls === 'boolean' ? caps.supports_tool_calls : true
  const vision = p !== null && isRecord(p.modalities) && p.modalities.vision === true
  return dataOf(endpoint, list).map((m) => ({
    name: m.id,
    capabilities: ['completion', ...(tools ? ['tools'] : []), ...(vision ? ['vision'] : [])],
    contextLength: nCtx,
    parameterSize: paramsOf(num(isRecord(m.meta) ? m.meta.n_params : undefined)),
    thinkPreset: null,
    reportsCapabilities: p !== null
  }))
}

function vllmModels(endpoint: Where, list: unknown): DiscoveredModel[] {
  return dataOf(endpoint, list).map((m) => ({
    name: m.id,
    capabilities: [...DEFAULT_CAPABILITIES],
    contextLength: num(m.max_model_len),
    parameterSize: null,
    thinkPreset: null,
    reportsCapabilities: false
  }))
}

/** The chat models an endpoint offers, with what its server reports about each. Throws a friendly error when it can't. */
export async function discoverModels(endpoint: Endpoint, apiKey: string | null): Promise<DiscoveredModel[]> {
  const base = endpoint.baseUrl.replace(/\/+$/, '')
  const root = rootOf(base)
  switch (endpoint.flavor) {
    case 'lmstudio':
      return lmStudioModels(endpoint, await getJson(endpoint, `${root}/api/v1/models`, apiKey))
    case 'llamacpp': {
      // /props says what the loaded model can do; without it the defaults apply.
      const [list, props] = await Promise.all([getJson(endpoint, `${base}/models`, apiKey), getJson(endpoint, `${root}/props`, apiKey).catch(() => null)])
      return llamaCppModels(endpoint, list, props)
    }
    case 'vllm':
      return vllmModels(endpoint, await getJson(endpoint, `${base}/models`, apiKey))
    default:
      return genericModels(endpoint, await getJson(endpoint, `${base}/models`, apiKey))
  }
}
```

- [ ] **Step 5: Run it to verify it passes**

Run: `npx vitest run tests/discovery.test.ts tests/openaiAdapter.test.ts`
Expected: PASS

- [ ] **Step 6: Write the failing probe test**

`tests/probeFlavours.test.ts`:
```ts
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { fixtureText, type MockOllama, startMockOllama } from './ollamaMock'

// PR 2's Ollama probe may reach the settings and the keychain, so Electron is faked and a database is open.
vi.mock('electron', () => ({
  app: { getPath: () => '' },
  BrowserWindow: { getAllWindows: () => [] },
  safeStorage: { isEncryptionAvailable: () => true, encryptString: (s: string) => Buffer.from(s), decryptString: (b: Buffer) => b.toString() },
  shell: {},
  nativeImage: {}
}))

const server: MockOllama = await startMockOllama()
const { openDatabase } = await import('../src/main/db/index')
const { probeEndpoint } = await import('../src/main/providers/probe')

let routes: Record<string, unknown> = {}
let auths: Array<string | undefined> = []
beforeAll(() => {
  openDatabase(':memory:')
  server.handler = (r, res) => {
    auths.push(r.headers.authorization)
    const body = routes[(r.url ?? '').split('?')[0]]
    if (body === undefined) return void res.writeHead(404).end('Not Found')
    if (typeof body === 'number') return void res.writeHead(body).end('{"error":"Unauthorized"}')
    res.writeHead(200, { 'content-type': 'application/json' }).end(typeof body === 'string' ? body : JSON.stringify(body))
  }
})
afterAll(() => server.close())
beforeEach(() => {
  routes = {}
  auths = []
})

describe('probeEndpoint', () => {
  it('finds Ollama first, by /api/version', async () => {
    routes = {
      '/api/version': { version: '0.12.3' },
      '/api/tags': { models: [{ name: 'llama3.2' }] },
      '/api/show': { capabilities: ['completion', 'tools'], model_info: { 'llama.context_length': 8192 } },
      '/v1/models': { data: [{ id: 'llama3.2' }] }
    }
    expect(await probeEndpoint(server.url)).toMatchObject({ kind: 'ollama', flavor: 'ollama' })
  })

  it('finds LM Studio 0.4+ by its own model list, and counts what it reports', async () => {
    routes = { '/api/v1/models': fixtureText('discovery/lmstudio-docs.json'), '/v1/models': { data: [{ id: 'qwen/qwen3-8b' }] } }
    const expected = {
      kind: 'openai',
      flavor: 'lmstudio',
      baseUrl: `${server.url}/v1`,
      version: null,
      models: 3,
      withTools: 2,
      withVision: 1,
      canThink: 2,
      reportsCapabilities: true,
      reportsContext: true
    }
    expect(await probeEndpoint(server.url)).toEqual(expected)
    expect(await probeEndpoint(`${server.url}/v1/`)).toEqual(expected)
    expect(await probeEndpoint(server.url.replace('http://', ''))).toEqual(expected)
  })

  it('finds llama.cpp by /props, with its build as the version', async () => {
    routes = { '/props': fixtureText('discovery/llamacpp-props.json'), '/v1/models': fixtureText('discovery/llamacpp-models.json') }
    expect(await probeEndpoint(server.url)).toEqual({
      kind: 'openai',
      flavor: 'llamacpp',
      baseUrl: `${server.url}/v1`,
      version: 'b6600-abc1234',
      models: 1,
      withTools: 1,
      withVision: 0,
      canThink: 0,
      reportsCapabilities: true,
      reportsContext: true
    })
  })

  it('finds vLLM by max_model_len, with its /version', async () => {
    routes = { '/v1/models': fixtureText('discovery/vllm-models.json'), '/version': { version: '0.11.0' } }
    expect(await probeEndpoint(server.url)).toEqual({
      kind: 'openai',
      flavor: 'vllm',
      baseUrl: `${server.url}/v1`,
      version: '0.11.0',
      models: 1,
      withTools: 1,
      withVision: 0,
      canThink: 0,
      reportsCapabilities: false,
      reportsContext: true
    })
  })

  it('takes any other server that lists models as generic', async () => {
    routes = { '/v1/models': fixtureText('discovery/generic-models.json') }
    expect(await probeEndpoint(server.url)).toEqual({
      kind: 'openai',
      flavor: 'generic',
      baseUrl: `${server.url}/v1`,
      version: null,
      models: 2,
      withTools: 2,
      withVision: 0,
      canThink: 0,
      reportsCapabilities: false,
      reportsContext: false
    })
  })

  it('finds LM Studio before 0.4 as generic', async () => {
    routes = { '/v1/models': fixtureText('discovery/lmstudio-v1-models.json') }
    const p = await probeEndpoint(server.url)
    expect(p).toMatchObject({ kind: 'openai', flavor: 'generic', baseUrl: `${server.url}/v1` })
    expect(p.models).toBeGreaterThan(0)
  })

  it('says when nothing there is a model server', async () => {
    await expect(probeEndpoint(server.url)).rejects.toThrow(/^Couldn't find a model server at 127\.0\.0\.1:\d+\. Check the address, and that the server is running\.$/)
  })

  it('says when nothing answers at all', async () => {
    await expect(probeEndpoint('http://127.0.0.1:9')).rejects.toThrow("Can't reach 127.0.0.1:9. Is the server started?")
  })

  it('keeps an API base typed with a path of its own when /models answers there, else looks under /v1', async () => {
    routes = { '/v1beta/openai/models': fixtureText('discovery/generic-models.json') }
    expect(await probeEndpoint(`${server.url}/v1beta/openai/`)).toMatchObject({
      kind: 'openai',
      flavor: 'generic',
      baseUrl: `${server.url}/v1beta/openai`,
      models: 2
    })
    routes = { '/api/openai/v1/models': fixtureText('discovery/generic-models.json') }
    expect(await probeEndpoint(`${server.url}/api/openai`)).toMatchObject({ flavor: 'generic', baseUrl: `${server.url}/api/openai/v1` })
  })

  it('asks for a key, sends the one it’s given, and says when it’s wrong', async () => {
    routes = { '/api/v1/models': 401 }
    await expect(probeEndpoint(server.url)).rejects.toThrow(`The server at ${server.url.replace('http://', '')} needs an API key.`)
    await expect(probeEndpoint(server.url, 'sk-x')).rejects.toThrow(`The server at ${server.url.replace('http://', '')} rejected the API key.`)
    expect(auths.at(-1)).toBe('Bearer sk-x')
  })
})
```

- [ ] **Step 7: Run it to verify it fails**

Run: `npx vitest run tests/probeFlavours.test.ts`
Expected: FAIL: the LM Studio, llama.cpp, vLLM and generic cases don't match PR 2's probe (which recognises an
OpenAI-compatible server but doesn't read it).

- [ ] **Step 8: Probe every flavour**

In `src/main/providers/probe.ts`:

1. Rename PR 2's `probeEndpoint` to `async function probeOllama(baseUrl: string, apiKey?: string): Promise<EndpointProbe>`
   (not exported) and cut it down to its Ollama path: what it does once `/api/version` has answered (or for ollama.com),
   counting the models, unchanged. Delete its branch that recognised an OpenAI-compatible server.
2. Add these imports (keep PR 2's):
   ```ts
   import { displayAddress, FLAVOR_LABELS, isOllamaCloudUrl } from '@shared/endpoints'
   import type { Endpoint, EndpointFlavor, EndpointProbe } from '@shared/types'
   import { discoverModels } from './openai/discovery'
   ```
3. Add below `normalizeBaseUrl`:
   ```ts
   // Each step of a probe is a quick question to a server that should answer at once.
   const PROBE_TIMEOUT_MS = 5_000

   const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

   /**
    * One probe step: the JSON at `url`, or null when that path isn't there (any other answer, or not JSON). Nothing
    * answering, or a demand for a key, ends the probe: no later step would do better.
    */
   async function probeJson(url: string, apiKey: string | undefined, address: string): Promise<unknown> {
     let res: Response
     try {
       res = await fetch(url, { headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {}, signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) })
     } catch {
       throw new Error(`Can't reach ${address}. Is the server started?`)
     }
     if (res.status === 401 || res.status === 403)
       throw new Error(apiKey ? `The server at ${address} rejected the API key.` : `The server at ${address} needs an API key.`)
     if (!res.ok) return null
     try {
       return (await res.json()) as unknown
     } catch {
       return null
     }
   }

   /** Read an OpenAI-compatible server's models, and count what the Add endpoint dialog reports. */
   async function probeOpenAI(flavor: Exclude<EndpointFlavor, 'ollama'>, baseUrl: string, apiKey: string | undefined, version: string | null): Promise<EndpointProbe> {
     const endpoint: Endpoint = { id: 'probe', name: FLAVOR_LABELS[flavor], kind: 'openai', flavor, baseUrl, enabled: true, hasKey: !!apiKey }
     const models = await discoverModels(endpoint, apiKey ?? null)
     const count = (capability: string) => models.filter((m) => m.capabilities.includes(capability)).length
     return {
       kind: 'openai',
       flavor,
       baseUrl,
       version,
       models: models.length,
       withTools: count('tools'),
       withVision: count('vision'),
       canThink: models.filter((m) => m.thinkPreset !== null).length,
       reportsCapabilities: models.some((m) => m.reportsCapabilities),
       reportsContext: models.some((m) => m.contextLength !== null)
     }
   }

   /**
    * What kind of server is at an address, tried in the spec's order (each check is particular to one server; the last
    * only needs /models to answer). Returns the address to store: Ollama's root, or the OpenAI API base that answered.
    */
   export async function probeEndpoint(baseUrl: string, apiKey?: string): Promise<EndpointProbe> {
     const root = normalizeBaseUrl(baseUrl)
     const key = apiKey?.trim() || undefined
     const address = displayAddress(root)
     if (isOllamaCloudUrl(root)) return probeOllama(root, key)
     const version = await probeJson(`${root}/api/version`, key, address)
     if (isRecord(version) && typeof version.version === 'string') return probeOllama(root, key)
     const lmStudio = await probeJson(`${root}/api/v1/models`, key, address)
     if (isRecord(lmStudio) && Array.isArray(lmStudio.models)) return probeOpenAI('lmstudio', `${root}/v1`, key, null)
     const props = await probeJson(`${root}/props`, key, address)
     if (isRecord(props) && ('default_generation_settings' in props || 'chat_template_caps' in props || 'n_ctx' in props))
       return probeOpenAI('llamacpp', `${root}/v1`, key, typeof props.build_info === 'string' ? props.build_info : null)
     // Almost every server's API base is {root}/v1, and one that serves /models at its root is taken as it is. An address
     // typed with a path of its own (https://example.com/v1beta/openai) is asked there first and kept if it answers;
     // else {root}/v1.
     const typed = apiBaseUrl(baseUrl)
     const bases = new URL(root).pathname === '/' ? [`${root}/v1`, root] : [typed, `${root}/v1`]
     for (const base of new Set(bases)) {
       const list = await probeJson(`${base}/models`, key, address)
       if (!isRecord(list) || !Array.isArray(list.data)) continue
       if (list.data.some((m) => isRecord(m) && typeof m.max_model_len === 'number')) {
         const v = await probeJson(`${root}/version`, key, address)
         return probeOpenAI('vllm', base, key, isRecord(v) && typeof v.version === 'string' ? v.version : null)
       }
       return probeOpenAI('generic', base, key, null)
     }
     throw new Error(`Couldn't find a model server at ${address}. Check the address, and that the server is running.`)
   }
   ```
   PR 2's `normalizeBaseUrl` drops a trailing `/v1`, so `root` is the server's root however the address was typed
   (Review Focus #5), and the stored base is the same `<root>/v1` for all three spellings. An address with a path of its
   own keeps it: `https://example.com/api/openai/v1` has the root `…/api/openai` and the base `…/api/openai/v1`;
   `https://example.com/v1beta/openai` is asked for `…/v1beta/openai/models` first and kept as typed when that answers.
   `apiBaseUrl` is Task 3.6's.

- [ ] **Step 9: Run tests to verify they pass**

First bring PR 2's `tests/probe.test.ts` to the new probe's words. In "says when nothing answers, or the server wants a
key", the two expectations become:
```ts
    await expect(probeEndpoint('http://127.0.0.1:9')).rejects.toThrow("Can't reach 127.0.0.1:9. Is the server started?")
    server.handler = (_req, res) => void res.writeHead(401).end()
    await expect(probeEndpoint(server.url)).rejects.toThrow('needs an API key')
```
Its other cases pass as they are ("tells an OpenAI-compatible server from Ollama" still finds a generic server at
`<root>/v1` with one model and no reported capabilities).

Run: `npx vitest run tests/probeFlavours.test.ts tests/discovery.test.ts tests/probe.test.ts tests/endpoints.test.ts` then
`npm run typecheck && npm run lint && npm run format:check && npm test`
Expected: PASS.

- [ ] **Step 10: Apply `capture/FINDINGS.md` (questions 1 and 6)**

| FINDINGS says | Change in `discovery.ts` (and its tests) |
|---|---|
| Q1: `reasoning_effort`, `reasoning.effort` or `chat_template_kwargs` changes LM Studio's reasoning, and `think-kwargs-off` turns it off | Nothing. |
| Q1: something sets effort, but `think-kwargs-off` still reasons | In `thinkPresetOf`, the on/off line becomes `if (options.includes('on') && options.includes('off')) return 'always' // LM Studio's API can't turn it off (FINDINGS Q1)`. In `tests/discovery.test.ts`, `qwen/qwen3-8b`'s `thinkPreset` becomes `'always'`. |
| Q1: nothing changes LM Studio's reasoning | In `lmStudioModels`, `const preset = thinkPresetOf(caps.reasoning)` becomes `const preset: ThinkProfile['kind'] \| null = null // LM Studio's API takes no thinking control (FINDINGS Q1): reasoning is shown, not controlled`. In the tests: the qwen and gpt-oss entries lose `'thinking'` and get `thinkPreset: null`; the probe's `canThink` becomes 0. |
| Q6: `models-api-v1-after-load.json` shows the loaded context, and a model loaded just in time used the size it reports | Nothing. |
| Q6: a model loaded just in time runs at a smaller window than `max_context_length` | In `lmStudioModels`, `contextLength` becomes `num(config.context_length)` (null until loaded, so the endpoint's "Context when not reported" applies). In `adapter.ts` `modelInfo`, the cache check becomes `if (!refresh && cached && Date.now() - profile.fetchedAt < INFO_TTL && !(this.endpoint.flavor === 'lmstudio' && cached.contextLength === null))`, so an unloaded model is read again once it has loaded. In `tests/discovery.test.ts`, gemma and gpt-oss get `contextLength: null`, the capture test expects `m.loaded_instances?.[0]?.config?.context_length ?? null`, and the LM Studio probe's `reportsContext` stays true (qwen is loaded). |

Run: `npx vitest run tests/discovery.test.ts tests/probeFlavours.test.ts tests/openaiAdapter.test.ts`
Expected: PASS

- [ ] **Step 11: Commit**

```bash
git add src/main/providers/openai/discovery.ts src/main/providers/probe.ts tests/discovery.test.ts tests/probeFlavours.test.ts \
  tests/fixtures/discovery/lmstudio-docs.json tests/probe.test.ts
git commit -m "Discover each server's models, and tell every kind of server apart when adding one

LM Studio's own list gives tools, vision, a thinking preset and the loaded window; llama.cpp's /props its window,
vision and template tool support; vLLM its max_model_len; anything else its ids, without embedding models. The
probe tries Ollama, LM Studio, llama.cpp, vLLM, then any server that lists models, and counts what it found.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 3.8: Capability and context overrides, precedence, Re-detect, the settings columns

**Files:**
- Create: `src/main/providers/capabilities.ts`
- Modify: `src/shared/types.ts` (`ModelInfo` gains `thinkPreset?` and `auto?`)
- Modify: `src/shared/thinking.ts` (`resolveThinkProfile` takes a preset)
- Modify: every `resolveThinkProfile(` caller: `src/main/chat/service.ts`, `src/main/chat/delegate.ts`, `src/renderer/src/stores/app.ts`
- Modify: `src/main/providers/openai/adapter.ts` (`toModelInfo`), `src/main/providers/ollama/models.ts` (`toModelInfo`)
- Modify: `src/main/providers/registry.ts` (`redetectModel`), `src/shared/ipc.ts`, `src/main/ipc.ts` (`models.redetect`)
- Modify: `src/renderer/src/views/settings/EndpointsPane.tsx` (`ModelRow` and the table header)
- Test: `tests/capabilities.test.ts`, `tests/thinking.test.ts`, `tests/openaiAdapter.test.ts`, `tests/openaiRegistry.test.ts`

**Interfaces:**
- Consumes: `ModelOverrides` (`vision?`, `tools?`, `contextLength?`, PR 2), `ModelDetected`, `contextWindowFor` (PR 2, with
  the server-side precedence already: override → detected → reported → `defaultContext`), `writeModelDetected`,
  `resolve`, `modelInfo` (registry).
- Produces: `effectiveCapabilities(reported: string[], overrides: ModelOverrides, detected: ModelDetected): string[]`;
  `ModelInfo.thinkPreset?`, `ModelInfo.auto?`; `resolveThinkProfile(model, capabilities, override?, preset?)`;
  `redetectModel(key)`; IPC `models.redetect(key)`; `ModelRow` with Thinking | Tools | Vision | Context | Artifacts |
  Auto skills.

Precedence for tools and vision: the user's override, then what an error taught (`detected.tools`, only ever `false`),
then what the server reported, where "reported" already holds the defaults discovery filled in for a server that says
nothing (tools on, vision off). The think profile: the user's override, then the server's preset (LM Studio), then
Ollama's family rules; an OpenAI-compatible model with neither is display-only (`none`: reasoning shown, no control),
and a profile the user picks makes the control appear by adding `thinking` to its capabilities.

- [ ] **Step 1: Write the failing tests**

`tests/capabilities.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import type { ModelDetected, ModelOverrides } from '@shared/types'
import { effectiveCapabilities } from '../src/main/providers/capabilities'
import { contextWindowFor } from '../src/main/providers/context'

describe('effectiveCapabilities', () => {
  it('uses what the server reported when nothing else is known', () => {
    expect(effectiveCapabilities(['completion', 'tools'], {}, {})).toEqual(['completion', 'tools'])
  })

  it('lets what an error taught turn tools off', () => {
    expect(effectiveCapabilities(['completion', 'tools', 'vision'], {}, { tools: false, reason: 'server lacks --jinja' })).toEqual(['completion', 'vision'])
  })

  it('puts the user’s choice above what was learned and what was reported', () => {
    expect(effectiveCapabilities(['completion'], { tools: true, vision: true }, { tools: false })).toEqual(['completion', 'tools', 'vision'])
    expect(effectiveCapabilities(['completion', 'tools', 'vision'], { tools: false, vision: false }, {})).toEqual(['completion'])
  })

  it('keeps every other capability, in its order', () => {
    expect(effectiveCapabilities(['completion', 'vision', 'tools', 'thinking'], {}, {})).toEqual(['completion', 'vision', 'tools', 'thinking'])
    expect(effectiveCapabilities(['completion', 'thinking'], { vision: true }, {})).toEqual(['completion', 'thinking', 'vision'])
  })
})

describe('contextWindowFor on a server that fixes the window', () => {
  const m = (over: { contextLength?: number | null; overrides?: ModelOverrides; detected?: ModelDetected } = {}) => ({
    contextControl: 'server' as const,
    contextLength: 32_768,
    overrides: {},
    detected: {},
    ...over
  })

  it('takes the user’s size, then the learned one, then the reported one, then the endpoint’s default', () => {
    const lm = { kind: 'openai' as const, defaultContext: 16_384 }
    expect(contextWindowFor(m({ overrides: { contextLength: 65_536 }, detected: { contextLength: 8_192 } }), lm)).toBe(65_536)
    expect(contextWindowFor(m({ detected: { contextLength: 8_192 } }), lm)).toBe(8_192)
    expect(contextWindowFor(m(), lm)).toBe(32_768)
    expect(contextWindowFor(m({ contextLength: null }), lm)).toBe(16_384)
    expect(contextWindowFor(m({ contextLength: null }), { kind: 'openai' })).toBe(8_192)
  })

  it('leaves the window Ollmost sends to Ollama at num_ctx', () => {
    const local = { contextControl: 'client' as const, contextLength: 131_072, overrides: { contextLength: 8_192 }, detected: {} }
    expect(contextWindowFor(local, { kind: 'ollama', numCtx: 32_768 })).toBe(32_768)
  })
})
```
(`contextWindowFor` is PR 2's; its cases pin the precedence this task relies on and pass as soon as the file loads.)

Add to `tests/thinking.test.ts`, inside `describe('think profiles', …)`:
```ts
  it('uses a server’s preset when the user set none, and the user’s choice over it', () => {
    expect(resolveThinkProfile('qwen/qwen3-8b', T, undefined, 'toggle')).toEqual({ kind: 'toggle' })
    expect(resolveThinkProfile('openai/gpt-oss-20b', T, undefined, 'levels')).toEqual({ kind: 'levels', canDisable: true })
    expect(resolveThinkProfile('glm-4.6', T, undefined, 'always')).toEqual({ kind: 'always' })
    expect(resolveThinkProfile('qwen/qwen3-8b', T, 'none', 'toggle')).toEqual({ kind: 'none' })
    expect(resolveThinkProfile('qwen/qwen3-8b', ['completion'], undefined, 'toggle')).toEqual({ kind: 'none' })
    // No preset: Ollama's family rules, as before.
    expect(resolveThinkProfile('gpt-oss:20b', T, undefined, undefined)).toEqual({ kind: 'levels', canDisable: false })
  })
```

Add to `tests/openaiAdapter.test.ts`, inside `describe('models', …)`:
```ts
  it('applies the user’s overrides and what errors taught, and says what Auto would be', async () => {
    server.handler = list({ n: 0 })
    fake.rows.set('gen/mistral-small-3.2-24b', {
      info: null,
      fetchedAt: 0,
      overrides: { vision: true, tools: false, contextLength: 32_768, think: 'toggle' },
      detected: {}
    })
    fake.rows.set('gen/qwen3-coder-30b-a3b', { info: null, fetchedAt: 0, overrides: {}, detected: { tools: false, contextLength: 16_384, reason: 'Box reported a 16K context' } })
    const [mistral, coder] = await generic().listModels(false)
    expect(mistral).toMatchObject({
      capabilities: ['completion', 'vision', 'thinking'],
      contextWindow: 32_768,
      thinkPreset: null,
      auto: { capabilities: ['completion', 'tools'], contextWindow: 8_192 }
    })
    expect(coder).toMatchObject({ capabilities: ['completion'], contextWindow: 16_384, auto: { capabilities: ['completion'], contextWindow: 16_384 } })
  })

  it('carries LM Studio’s thinking preset into the model', async () => {
    server.handler = (r, res) =>
      r.url === '/api/v1/models' ? void res.writeHead(200).end(fixtureText('discovery/lmstudio-docs.json')) : void res.writeHead(404).end()
    const models = await provider().listModels(false)
    expect(models.map((m) => [m.name, m.thinkPreset])).toEqual([
      ['qwen/qwen3-8b', 'toggle'],
      ['google/gemma-3-12b', null],
      ['openai/gpt-oss-20b', 'levels']
    ])
  })
```

Add to `tests/openaiRegistry.test.ts`: the imports
```ts
const { setEndpoints } = await import('../src/main/settings')
const { writeModelDetected, writeModelOverrides } = await import('../src/main/db/kv')
```
and, inside `describe('an OpenAI-compatible endpoint', …)`:
```ts
  it('re-detect forgets what errors taught, and reads the model again', async () => {
    server.handler = (r, res) =>
      r.url === '/api/v1/models'
        ? void res.writeHead(200).end(JSON.stringify({ models: [{ type: 'llm', key: 'qwen/qwen3-8b', max_context_length: 32768, capabilities: { trained_for_tool_use: true } }] }))
        : void res.writeHead(404).end()
    const key = 'lm-studio/qwen/qwen3-8b'
    writeModelDetected(key, { tools: false, reason: 'server lacks --jinja' })
    expect((await registry.modelInfo(key)).capabilities).not.toContain('tools')
    const info = await registry.redetectModel(key)
    expect(info.detected).toEqual({})
    expect(info.capabilities).toContain('tools')
  })

  it('lets the user turn an Ollama model’s tools off and its vision on', async () => {
    const ollama = await startMockOllama()
    ollama.handler = (r, res) =>
      r.url === '/api/show'
        ? void res.writeHead(200).end(JSON.stringify({ capabilities: ['completion', 'tools'], model_info: { 'llama.context_length': 8192 } }))
        : void res.writeHead(200).end(JSON.stringify({ models: [{ name: 'llama3.2' }] }))
    setEndpoints(getSettings().endpoints.map((e) => (e.id === 'ollama' ? { ...e, baseUrl: ollama.url, showCloudCatalog: false } : e)))
    registry.invalidateProviders()
    writeModelOverrides('ollama/llama3.2', { tools: false, vision: true })
    try {
      expect(await registry.modelInfo('ollama/llama3.2')).toMatchObject({ capabilities: ['completion', 'vision'], auto: { capabilities: ['completion', 'tools'] } })
    } finally {
      await ollama.close()
    }
  })
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run tests/capabilities.test.ts tests/thinking.test.ts tests/openaiAdapter.test.ts tests/openaiRegistry.test.ts`
Expected: FAIL: `Failed to resolve import "../src/main/providers/capabilities"`; the preset case (`openai/gpt-oss-20b`
with preset `levels` gets `{ kind: 'toggle' }`, since the preset is ignored); the overrides case (no `auto`, tools not
turned off); "registry.redetectModel is not a function".

- [ ] **Step 3: Implement `src/main/providers/capabilities.ts`**

```ts
import type { ModelDetected, ModelOverrides } from '@shared/types'

/**
 * A model's tools and vision once everything Ollmost knows is applied: the user's override, else what an error taught
 * (a server that refused tools), else what the server reported, which for a server that says nothing already holds
 * the defaults (tools on, vision off). Every other capability passes through, in order.
 */
export function effectiveCapabilities(reported: string[], overrides: ModelOverrides, detected: ModelDetected): string[] {
  const on = {
    tools: overrides.tools ?? detected.tools ?? reported.includes('tools'),
    vision: overrides.vision ?? reported.includes('vision')
  }
  const kept = reported.filter((c) => (c === 'tools' || c === 'vision' ? on[c] : true))
  const added = (['tools', 'vision'] as const).filter((c) => on[c] && !reported.includes(c))
  return [...kept, ...added]
}
```

- [ ] **Step 4: `ModelInfo` says what Auto would be, and the server's think preset**

In `src/shared/types.ts`, inside `interface ModelInfo`, after `detected`:
```ts
  /** OpenAI-compatible servers: the thinking profile the server reported (LM Studio), used when the user sets none. */
  thinkPreset?: ThinkProfile['kind'] | null
  /** What applies without the user's overrides: Settings shows it as "Auto (…)". */
  auto?: { capabilities: string[]; contextWindow: number | null }
```

- [ ] **Step 5: `resolveThinkProfile` takes the preset**

In `src/shared/thinking.ts`, replace `resolveThinkProfile` with:
```ts
export function resolveThinkProfile(model: string, capabilities: string[], override?: ThinkProfile['kind'], preset?: ThinkProfile['kind']): ThinkProfile {
  if (!capabilities.includes('thinking')) return { kind: 'none' }
  // The user's choice, else what the server said it offers (LM Studio), else Ollama's family rules.
  const kind = override ?? preset
  if (kind === 'none' || kind === 'toggle') return { kind }
  if (kind === 'always') return { kind: 'always' }
  if (kind === 'levels') return { kind: 'levels', canDisable: true }
  const rule = FAMILY_RULES.find((r) => r.match.test(model))
  return rule ? rule.profile : { kind: 'toggle' }
}
```

Then pass the preset everywhere a profile is resolved:

Run: `grep -rn "resolveThinkProfile(" src --include=*.ts --include=*.tsx`
Each call that passes `<m>.overrides.think` as its third argument gets `, <m>.thinkPreset ?? undefined` as its fourth,
with the same `<m>` (for example in `src/main/chat/delegate.ts`:
`resolveThinkProfile(model.name, model.capabilities, model.overrides.think, model.thinkPreset ?? undefined)`; in
`src/renderer/src/stores/app.ts`'s `thinkProfileFor`:
`resolveThinkProfile(model.name, model.capabilities, model.overrides.think, model.thinkPreset ?? undefined)`). The
Settings row's "Auto" call is replaced in Step 9.

- [ ] **Step 6: Both adapters apply the overrides**

In `src/main/providers/openai/adapter.ts`, add `import { effectiveCapabilities } from '../capabilities'` and replace
`toModelInfo` with:
```ts
  private toModelInfo(name: string, info: CachedModelInfo, installed: boolean): ModelInfo {
    const key = this.keyOf(name)
    const { overrides, detected } = readModelProfile(key)
    const where = whereOf(this.endpoint.baseUrl)
    const { id, name: endpointName, kind, flavor } = this.endpoint
    // The server fixed the window when it loaded the model: Ollmost never sends one.
    const contextControl = 'server' as const
    const capabilities = effectiveCapabilities(info.capabilities, overrides, detected)
    // A thinking profile the user picked brings the control, even where the server reports no thinking.
    if (overrides.think && overrides.think !== 'none' && !capabilities.includes('thinking')) capabilities.push('thinking')
    const sizes = { contextControl, contextLength: info.contextLength, detected }
    return {
      key,
      name,
      endpoint: { id, name: endpointName, kind, flavor },
      where,
      billing: billingOf(where),
      contextControl,
      contextWindow: contextWindowFor({ ...sizes, overrides }, this.endpoint),
      installed,
      capabilities,
      contextLength: info.contextLength,
      family: info.family,
      parameterSize: info.parameterSize,
      overrides,
      detected,
      price: null,
      thinkPreset: info.thinkPreset ?? null,
      auto: { capabilities: effectiveCapabilities(info.capabilities, {}, detected), contextWindow: contextWindowFor({ ...sizes, overrides: {} }, this.endpoint) }
    }
  }
```

In `src/main/providers/ollama/models.ts`, add `import { effectiveCapabilities } from '../capabilities'`, and in PR 2's
`toModelInfo` replace the line `capabilities: info.capabilities,` with:
```ts
    capabilities: effectiveCapabilities(info.capabilities, overrides, detected),
    auto: {
      capabilities: effectiveCapabilities(info.capabilities, {}, detected),
      contextWindow: contextWindowFor({ contextControl, contextLength: info.contextLength, overrides: {}, detected }, endpoint)
    },
```
(Ollama models get no `thinkPreset`: their profile comes from `/api/show`'s `thinking` and the family rules, as before.
With no overrides set, `effectiveCapabilities` returns `/api/show`'s list unchanged, so nothing an Ollama chat sends
changes.)

- [ ] **Step 7: Re-detect, in the registry and over IPC**

In `src/main/providers/registry.ts`, add `import { writeModelDetected } from '../db/kv'` and
`import { toModelKey } from '@shared/modelKey'` (with PR 2's other `@shared/modelKey` names), and after `modelInfo`:
```ts
/** Forget what errors taught Ollmost about a model (tools refused, its window), then read it again from its server. */
export function redetectModel(key: string): Promise<ModelInfo> {
  const { endpoint, model } = resolve(key)
  // The canonical key, as every read uses: a bare name from before keys is Ollama's.
  writeModelDetected(toModelKey(endpoint.id, model), {})
  return modelInfo(key, true)
}
```
In `src/shared/ipc.ts`, `models` gains
```ts
    /** Forget what errors taught Ollmost about this model (tools refused, a context size), and read it again. */
    redetect(key: string): Promise<ModelInfo>
```
and `INVOKE_CHANNELS.models` becomes `['list', 'info', 'setOverrides', 'redetect']`. In `src/main/ipc.ts`, the `models`
group gains `redetect: (key) => redetectModel(key),` with `redetectModel` added to its `./providers/registry` import.

- [ ] **Step 8: Run tests to verify they pass**

Run: `npx vitest run tests/capabilities.test.ts tests/thinking.test.ts tests/openaiAdapter.test.ts tests/openaiRegistry.test.ts tests/service.test.ts`
Expected: PASS

- [ ] **Step 9: The Settings models table gains Tools, Vision and Context**

In `src/renderer/src/views/settings/EndpointsPane.tsx`, replace PR 2's `ModelRow` (and the `THINK_OPTIONS` it uses)
with the code below, and the table's header row with:
```tsx
            <tr className="text-xs text-subtle">
              <th className="pb-2 font-medium">Model</th>
              <th className="pb-2 font-medium">Thinking</th>
              <th className="pb-2 font-medium">Tools</th>
              <th className="pb-2 font-medium">Vision</th>
              <th className="pb-2 font-medium">Context</th>
              <th className="pb-2 text-center font-medium">Artifacts</th>
              <th className="pb-2 text-center font-medium">Auto skills</th>
            </tr>
```
Wrap the `<table>` in `<div className="overflow-x-auto">…</div>` so seven columns fit the detail pane. The rows stay
`<ModelRow key={m.key} model={m} />`, as PR 2 renders them. The component (it needs `Badge`, `Switch` from
`@/components/ui`, `api` from `@/lib/api`, `formatContext` from `@/lib/format`, `reportError` and `useApp` from
`@/stores/app`, `shortModelName` from `@shared/modelLabel`, `resolveThinkProfile` from `@shared/thinking`, and the
`ModelInfo`, `ModelOverrides`, `ThinkProfile` types; PR 2's file imports most of them already):
```tsx
const THINK_LABELS: Record<ThinkProfile['kind'], string> = { toggle: 'On / off', levels: 'Effort levels', always: 'Always on', none: 'Hidden' }
const THINK_KINDS: ReadonlyArray<ThinkProfile['kind']> = ['toggle', 'levels', 'always', 'none']
// The windows a server can be told a model has, for a model it reports none for (or reports wrongly). PR 2's
// CONTEXT_SIZES, beside it, stay the endpoint page's num_ctx and "Context when not reported" choices.
const MODEL_CONTEXT_SIZES = [4_096, 8_192, 16_384, 32_768, 65_536, 131_072, 262_144]
const SELECT = 'h-8 rounded-md border border-line bg-canvas px-1.5 text-xs outline-none'

function OnOff({ label, value, auto, onChange }: { label: string; value: boolean | undefined; auto: boolean; onChange: (v: boolean | undefined) => void }) {
  return (
    <select
      aria-label={label}
      value={value === undefined ? 'auto' : value ? 'on' : 'off'}
      onChange={(e) => onChange(e.target.value === 'auto' ? undefined : e.target.value === 'on')}
      className={SELECT}
    >
      <option value="auto">Auto ({auto ? 'on' : 'off'})</option>
      <option value="on">On</option>
      <option value="off">Off</option>
    </select>
  )
}

/** What Ollmost learned from an error, and the way to forget it. */
function Learned({ reason, onRedetect }: { reason?: string; onRedetect: () => void }) {
  return (
    <div className="mt-0.5 max-w-44 text-[11px] leading-tight text-subtle">
      {reason ?? 'learned from an error'} ·{' '}
      <button className="text-accent hover:underline" onClick={onRedetect}>
        Re-detect
      </button>
    </div>
  )
}

function ModelRow({ model }: { model: ModelInfo }) {
  const openai = model.endpoint.kind === 'openai'
  const auto = model.auto ?? { capabilities: model.capabilities, contextWindow: model.contextWindow }
  const autoThink = resolveThinkProfile(model.name, auto.capabilities, undefined, model.thinkPreset ?? undefined)
  // On an OpenAI-compatible server "none" still shows reasoning the server sends; it just offers no control.
  const thinkLabel = (kind: ThinkProfile['kind']) => (kind === 'none' && openai ? 'Show only' : THINK_LABELS[kind])
  // The model read back goes into the store by key, as PR 2's row does; the list's `installed` stays as it was listed.
  const replace = (updated: ModelInfo) =>
    useApp.setState((s) => ({ models: s.models.map((x) => (x.key === updated.key ? { ...updated, installed: x.installed } : x)) }))
  const set = async (patch: ModelOverrides) => {
    try {
      replace(await api.models.setOverrides(model.key, { ...model.overrides, ...patch }))
    } catch (err) {
      reportError(err)
    }
  }
  const redetect = async () => {
    try {
      replace(await api.models.redetect(model.key))
    } catch (err) {
      reportError(err)
    }
  }
  return (
    <tr className="border-t border-line align-top">
      <td className="py-2.5 pr-3">
        <div className="text-[13px] font-medium">{model.endpoint.kind === 'ollama' ? shortModelName(model.name) : model.name}</div>
        <div className="mt-0.5 flex flex-wrap gap-1">
          {model.capabilities
            .filter((c) => c !== 'completion')
            .map((c) => (
              <Badge key={c}>{c}</Badge>
            ))}
          {model.contextWindow ? <Badge>{formatContext(model.contextWindow)}</Badge> : null}
        </div>
      </td>
      <td className="py-2.5 pr-3">
        {model.capabilities.includes('thinking') || openai ? (
          <select
            aria-label="Thinking"
            value={model.overrides.think ?? 'auto'}
            onChange={(e) => void set({ think: e.target.value === 'auto' ? undefined : (e.target.value as ThinkProfile['kind']) })}
            className={SELECT}
          >
            <option value="auto">Auto ({thinkLabel(autoThink.kind)})</option>
            {THINK_KINDS.map((k) => (
              <option key={k} value={k}>
                {thinkLabel(k)}
              </option>
            ))}
          </select>
        ) : (
          <span className="text-xs text-subtle">n/a</span>
        )}
      </td>
      <td className="py-2.5 pr-3">
        <OnOff label="Tools" value={model.overrides.tools} auto={auto.capabilities.includes('tools')} onChange={(tools) => void set({ tools })} />
        {model.detected.tools === false && model.overrides.tools === undefined && (
          <Learned reason={model.detected.reason} onRedetect={() => void redetect()} />
        )}
      </td>
      <td className="py-2.5 pr-3">
        <OnOff label="Vision" value={model.overrides.vision} auto={auto.capabilities.includes('vision')} onChange={(vision) => void set({ vision })} />
      </td>
      <td className="py-2.5 pr-3">
        {model.contextControl === 'server' ? (
          <>
            <select
              aria-label="Context"
              value={model.overrides.contextLength ?? 'auto'}
              onChange={(e) => void set({ contextLength: e.target.value === 'auto' ? undefined : Number(e.target.value) })}
              className={SELECT}
            >
              <option value="auto">Auto ({formatContext(auto.contextWindow) || 'unknown'})</option>
              {MODEL_CONTEXT_SIZES.map((n) => (
                <option key={n} value={n}>
                  {formatContext(n)}
                </option>
              ))}
            </select>
            {model.detected.contextLength !== undefined && model.overrides.contextLength === undefined && (
              <Learned reason={model.detected.reason} onRedetect={() => void redetect()} />
            )}
          </>
        ) : (
          // Ollama's own models: the endpoint's num_ctx sets the window.
          <span className="text-xs text-subtle" title="Set by this endpoint’s context window">
            {formatContext(model.contextWindow)}
          </span>
        )}
      </td>
      <td className="py-2.5 pr-3 text-center">
        <Switch label="Artifacts" checked={model.overrides.artifacts !== false} onChange={(v) => void set({ artifacts: v })} />
      </td>
      <td className="py-2.5 text-center">
        {model.capabilities.includes('tools') ? (
          <Switch label="Auto skills" checked={model.overrides.autoSkills !== false} onChange={(v) => void set({ autoSkills: v })} />
        ) : (
          <span className="text-xs text-subtle">n/a</span>
        )}
      </td>
    </tr>
  )
}
```
`models.redetect` returns the model read again, so the same `replace` serves Re-detect. PR 2's `THINK_OPTIONS` goes
with the old row; its `ContextSelect` and `CONTEXT_SIZES` stay, for the endpoint page's num_ctx and "Context when not
reported" menus.

- [ ] **Step 10: Run the full check**

Run: `npm run typecheck && npm run lint && npm run format:check && npm test`
Expected: PASS

- [ ] **Step 11: Commit**

```bash
git add src/main/providers/capabilities.ts src/shared/types.ts src/shared/thinking.ts src/shared/ipc.ts src/main/ipc.ts \
  src/main/providers/registry.ts src/main/providers/openai/adapter.ts src/main/providers/ollama/models.ts src/main/chat \
  src/renderer/src tests/capabilities.test.ts tests/thinking.test.ts tests/openaiAdapter.test.ts tests/openaiRegistry.test.ts
git commit -m "Per-model Tools, Vision and Context overrides, over what servers report and errors teach

The user's choice wins, then what an error taught (tools refused, a real context size), then what the server
reported, then the defaults. LM Studio's reasoning options preset the thinking control; elsewhere reasoning is shown
and the control is opt-in. Settings shows each as Auto (value), says what was learned, and can forget it.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 3.9: Add endpoint for every flavour

**Files:**
- Modify: `src/shared/endpoints.ts` (add `probeContextNote`, `suggestEndpointName`; PR 2's `probeSummary` stays as it is)
- Modify: `src/renderer/src/views/settings/AddEndpointDialog.tsx`
- Test: `tests/probeText.test.ts`

**Interfaces:**
- Consumes: `EndpointProbe`, `FLAVOR_LABELS`, `DEFAULT_CONTEXT`, `probeSummary` (PR 2); `api.endpoints.probe/add`
  (PR 2's IPC); PR 2's store selector `selectEndpoints`; `formatContext` (`@shared/format`).
- Produces: `probeContextNote(p): string`, `suggestEndpointName(p, taken): string`; a dialog that adds every flavour.

PR 2's `probeSummary` already words every case as the spec does ("Found LM Studio 0.4 · 5 models · 4 with tools · …";
"… capabilities not reported — defaults apply (tools on, vision off)"; Ollama's with its model count only, since its
probe doesn't count capabilities), so it stays. PR 2's endpoint page already has an OpenAI-compatible endpoint's own
settings: the "Context when not reported" row (under `endpoint.kind === 'openai'`) and, like every endpoint not on
ollama.com, its own API key field (`EndpointKeyField`). This task adds nothing there; Step 6 checks it.

- [ ] **Step 1: Write the failing test**

`tests/probeText.test.ts`:
```ts
import { describe, expect, it } from 'vitest'
import { probeContextNote, probeSummary, suggestEndpointName } from '@shared/endpoints'
import type { EndpointProbe } from '@shared/types'

const probe = (over: Partial<EndpointProbe>): EndpointProbe => ({
  kind: 'openai',
  flavor: 'lmstudio',
  baseUrl: 'http://localhost:1234/v1',
  version: null,
  models: 5,
  withTools: 4,
  withVision: 1,
  canThink: 2,
  reportsCapabilities: true,
  reportsContext: true,
  ...over
})

describe('probeSummary (PR 2’s), for every flavour the dialog now adds', () => {
  it('says what it found and what the models can do', () => {
    expect(probeSummary(probe({}))).toBe('Found LM Studio · 5 models · 4 with tools · 1 with vision · 2 can think')
    expect(probeSummary(probe({ flavor: 'llamacpp', version: 'b6600-abc1234', models: 1, withTools: 1, withVision: 0, canThink: 0 }))).toBe(
      'Found llama.cpp b6600-abc1234 · 1 model · 1 with tools · 0 with vision · 0 can think'
    )
    // Ollama reports each model's capabilities when it's listed; its probe only counts the models.
    expect(probeSummary(probe({ kind: 'ollama', flavor: 'ollama', version: '0.12.3', models: 14 }))).toBe('Found Ollama 0.12.3 · 14 models')
  })

  it('says when a server reports no capabilities, and what applies instead', () => {
    expect(probeSummary(probe({ flavor: 'generic', models: 12, reportsCapabilities: false }))).toBe(
      'Found an OpenAI-compatible server · 12 models · capabilities not reported — defaults apply (tools on, vision off)'
    )
    expect(probeSummary(probe({ flavor: 'vllm', version: '0.11.0', models: 1, reportsCapabilities: false }))).toBe(
      'Found vLLM 0.11.0 · 1 model · capabilities not reported — defaults apply (tools on, vision off)'
    )
  })
})

describe('probeContextNote', () => {
  it('says whether context sizes come from the server or the endpoint’s setting', () => {
    expect(probeContextNote({ reportsContext: true })).toBe('Context sizes reported by the server')
    expect(probeContextNote({ reportsContext: false })).toBe('Context sizes not reported — models get 8K unless you change “Context when not reported”')
  })
})

describe('suggestEndpointName', () => {
  it('names a new endpoint after its server, numbered when the name is taken', () => {
    expect(suggestEndpointName({ flavor: 'lmstudio' }, [])).toBe('LM Studio')
    expect(suggestEndpointName({ flavor: 'lmstudio' }, ['LM Studio'])).toBe('LM Studio 2')
    expect(suggestEndpointName({ flavor: 'lmstudio' }, ['LM Studio', 'LM Studio 2'])).toBe('LM Studio 3')
    expect(suggestEndpointName({ flavor: 'generic' }, ['Ollama'])).toBe('OpenAI-compatible')
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/probeText.test.ts`
Expected: FAIL: `probeContextNote` and `suggestEndpointName` are not exported ("is not a function"). The `probeSummary`
cases already pass: they pin PR 2's wording for the flavours this PR opens up.

- [ ] **Step 3: The probe's words**

In `src/shared/endpoints.ts` (add `import { formatContext } from './format'`), append after PR 2's `probeSummary`:
```ts
/** Where the dialog says its models' context sizes will come from. */
export function probeContextNote(p: Pick<EndpointProbe, 'reportsContext'>): string {
  return p.reportsContext
    ? 'Context sizes reported by the server'
    : `Context sizes not reported — models get ${formatContext(DEFAULT_CONTEXT)} unless you change “Context when not reported”`
}

/** A name for a new endpoint: its server's, numbered when another endpoint has it. */
export function suggestEndpointName(p: Pick<EndpointProbe, 'flavor'>, taken: readonly string[]): string {
  const base = FLAVOR_LABELS[p.flavor]
  if (!taken.includes(base)) return base
  let n = 2
  while (taken.includes(`${base} ${n}`)) n++
  return `${base} ${n}`
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `npx vitest run tests/probeText.test.ts tests/endpointText.test.ts`
Expected: PASS (`tests/endpointText.test.ts` is PR 2's test of `probeSummary` and `removalText`, unchanged).

- [ ] **Step 5: The Add endpoint dialog takes every server**

In `src/renderer/src/views/settings/AddEndpointDialog.tsx` (PR 2's):

1. PR 2's preset row already offers all four servers (Ollama `:11434`, LM Studio `:1234`, llama.cpp `:8080`, vLLM
   `:8000`), and step 1 already has the optional key field (vLLM's `--api-key`, LM Studio's API tokens), which goes to
   `api.endpoints.probe({ baseUrl, apiKey })` and `api.endpoints.add({ …, apiKey })`. Both stay.
2. Delete PR 2's refusal of a server that isn't Ollama: the `const supported = found?.kind === 'ollama'` line and its
   comment, the `!supported || ` in the Add button's `disabled`, the
   `{!supported && <div …>This server speaks the OpenAI API; support arrives in the next update.</div>}` line, and the
   `{supported && ( … )}` around step 2's Name field (the field itself stays, for every server). Add already sends
   `kind: found.kind, flavor: found.flavor, baseUrl: found.baseUrl`: the probe's API base, which `addEndpoint` keeps
   (Task 3.6).
3. Step 2's summary box gains the context note, after its address line:
   ```tsx
            <div className="mt-0.5 text-muted">{probeContextNote(found)}</div>
   ```
4. Delete PR 2's `suggestName()`; in `check`, the name starts as
   `setName(suggestEndpointName(probe, endpoints.map((e) => e.name)))` (`endpoints` is the dialog's
   `useApp(selectEndpoints)`, already there).

The imports from `@shared/endpoints` become `displayAddress, probeContextNote, probeSummary, suggestEndpointName`
(`FLAVOR_LABELS` goes with `suggestName`; `Endpoint` stays for `onAdded`).

- [ ] **Step 6: Check the endpoint page's OpenAI fields**

Run: `grep -n "Context when not reported\|EndpointKeyField endpoint" src/renderer/src/views/settings/EndpointsPane.tsx`
Expected: the `endpoint.kind === 'openai'` row "Context when not reported" (PR 2's `ContextSelect`, saving
`defaultContext` through `api.endpoints.update`) and `<EndpointKeyField endpoint={endpoint} />` for every endpoint not
on ollama.com. Nothing to add: an OpenAI-compatible endpoint's page already has its context default and its own key.
Its Address field saves through `api.endpoints.update`, which probes an OpenAI endpoint's new address first (Task 3.6).

- [ ] **Step 7: Run the full check**

Run: `npm run typecheck && npm run lint && npm run format:check && npm test`
Expected: PASS

- [ ] **Step 8: Look at it**

Run: `npm run dev`. In Settings → Models → + Add endpoint, click "LM Studio :1234" (with LM Studio's server running),
then Check.
Expected: step 2 reads "Found LM Studio · N models · … with tools · … with vision · … can think", "at localhost:1234"
and "Context sizes reported by the server"; the name is "LM Studio"; Add puts it in the left column, and its page shows
the address `http://localhost:1234/v1`, "Context when not reported" and the key field above the models table, whose
Tools, Vision and Context cells read "Auto (…)". Change the address to `localhost:1234` and press Tab: it's probed and
stays `http://localhost:1234/v1`. Close the dev app.

- [ ] **Step 9: Commit**

```bash
git add src/shared/endpoints.ts src/renderer/src/views/settings/AddEndpointDialog.tsx tests/probeText.test.ts
git commit -m "Add LM Studio, llama.cpp, vLLM and other OpenAI-compatible servers from Settings

The dialog adds whatever its probe found; step 2 says what that was and whether capabilities and context sizes are
reported, and names it after its server. The endpoint page already has an OpenAI endpoint's context default and key.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 3.10: One reply loop, both dialects (service tests parametrised); PR

**Files:**
- Modify: `tests/ollamaMock.ts` (a scripted reply in either dialect)
- Modify: `tests/service.test.ts` (a second mock server as a second endpoint; the parametrised section at the end)
- Modify: `src/main/chat/rounds.ts` (tok/s from the first token when a server reports no generation time)
- Modify: `README.md` ("Known limits": one line on that tok/s)
- Modify: `docs/superpowers/specs/2026-09-27-model-endpoints-design.md` (the spike's answers)
- Test: `tests/service.test.ts`

**Interfaces:**
- Consumes: `service.send(input, opts)`, `service.stop(id, { quiet })`, `getMessage`, `all` (today's service test);
  `setEndpoints` and the `ollama` endpoint PR 2's `beforeAll` sets up; `addEndpoint` (PR 2, opened to OpenAI in 3.6);
  `toModelKey`; `sseDelta`, `sse`, `sseDone`, `streamSse`, `line`, `streamChunks` (`tests/ollamaMock.ts`).
- Produces: `type Dialect = 'ollama' | 'openai'`, `interface Turn`,
  `turnChunks(dialect: Dialect, turn: Turn, opts?: { includeUsage?: boolean }): string[]`,
  `writeTurn(res: ServerResponse, dialect: Dialect, turn: Turn, opts?: { includeUsage?: boolean; pauseMs?: number }): Promise<void>`,
  `completionJson(content: string): string`; `RoundsResult.genMs` with the first-token fallback.

The scripts are the spec's list: a plain reply, a tool round, Stop mid-stream, a dropped stream saved with its partial
text, the round limit, and result shortening. One more covers #175's batches: two sub-agents delegated in one round,
which run at the same time and whose results must go back in call order, each under its own call's id (an OpenAI
server pairs a result with its call by `tool_call_id` alone). Each runs once over each dialect with the same
expectations, and then both runs are compared: the saved reply (text, thinking and its segments, stats, whether it
failed), its tool events and its usage rows must be identical. The clock-bound stats (`durationMs`,
`tokensPerSecond`, `thinkingMs`, each segment's `ms`) are left out of the comparison, and usage rows are compared by
the model's name without its endpoint. #175's own sub-agent tests stay as they are, over Ollama.

- [ ] **Step 1: Write the failing tests**

In `tests/service.test.ts`:

1. The `./ollamaMock` import gains `completionJson`, `type Dialect`, `type Turn` and `writeTurn`; add
   `import { toModelKey } from '@shared/modelKey'`.
2. Right after `const ollama: MockOllama = await startMockOllama()` add:
   ```ts
   // An OpenAI-compatible server, added below as a second endpoint: the reply loop must save the same over either.
   const openaiServer: MockOllama = await startMockOllama()
   ```
   and beside the other dynamic imports: `const { addEndpoint } = await import('../src/main/providers/endpoints')`.
3. At the end of the file:
```ts
// ---- One reply loop, both dialects ----
// The same scripted conversation runs against the Ollama mock (NDJSON) and the OpenAI-compatible mock (SSE). Both must
// save the same reply, tool events and usage rows.

afterAll(() => openaiServer.close())
const DIALECTS: Dialect[] = ['ollama', 'openai']
let openaiId = ''
const keyFor = (d: Dialect) => toModelKey(d === 'ollama' ? 'ollama' : openaiId, 'llama3.2')
const asksUsage = (b: Record<string, unknown>) => !!(b.stream_options as { include_usage?: boolean } | undefined)?.include_usage

interface Script {
  prompt: string
  turn: (body: Record<string, unknown>, n: number) => Turn
  web?: (path: string, res: ServerResponse) => unknown
  opts?: { maxToolRounds?: number }
  /** Press Stop (quietly, as deleting the chat does) once the first text arrives. */
  stop?: boolean
  /** A pause between the server's chunks. */
  pauseMs?: number
}

let pageNo = 0
const SCRIPTS: Record<string, Script> = {
  'plain reply': { prompt: 'hello', turn: () => ({ thinking: 'Greet them.', content: 'Hi there', usage: { prompt: 10, completion: 3 } }) },
  'tool round': {
    prompt: 'look it up',
    turn: (_b, n) =>
      n === 1
        ? { content: 'Let me check.', toolCalls: [{ name: 'web_search', args: { query: 'ollmost' } }] }
        : { content: 'Found it.', usage: { prompt: 10, completion: 3 } },
    web: (_p, res) => res.writeHead(200).end(JSON.stringify({ results: [{ title: 'Ollmosts', url: 'https://k.io', content: 'hot' }] }))
  },
  // Longer than the think splitter holds back, so the OpenAI mock's text shows (and Stop can be pressed) at once too.
  'stop mid-stream': { prompt: 'hello', turn: () => ({ content: 'partial reply '.repeat(6), cut: 'hang' }), stop: true },
  'dropped stream': { prompt: 'hello', turn: () => ({ content: 'Half an ans', cut: 'drop' }) },
  'round limit': {
    prompt: 'dig deep',
    turn: (b, n) => (b.tools ? { toolCalls: [{ name: 'web_search', args: { query: `q${n}` } }] } : { content: 'Stopped early' }),
    web: (_p, res) => res.writeHead(200).end(JSON.stringify({ results: [] })),
    opts: { maxToolRounds: 3 }
  },
  // The mock model has an 8,192-token window on both endpoints: 12K-character pages overflow it by the third request.
  'result shortening': {
    prompt: 'compare these two pages',
    turn: (_b, n) =>
      n <= 2
        ? { toolCalls: [{ name: 'web_fetch', args: { url: `https://p${n}.io` } }], usage: { prompt: 100, completion: 5 } }
        : { content: 'Compared.', usage: { prompt: 100, completion: 3 } },
    web: (_p, res) => res.writeHead(200).end(JSON.stringify({ title: `Page ${++pageNo}`, content: `${'x'.repeat(12_000)} MARK-${pageNo}`, links: [] }))
  },
  // #175: two sub-agents delegated in one round run at the same time (Settings allows 3 by default). A child is told
  // apart by its system prompt. Both children report the same counts, so their usage rows match whichever lands first.
  'two sub-agents at once': {
    prompt: 'research both',
    turn: (b) => {
      const messages = b.messages as Array<{ role: string; content: unknown }>
      if (String(messages[0].content).includes('<sub_agent>')) {
        const task = String(messages.find((m) => m.role === 'user')!.content)
        return { content: task.includes('first') ? 'A' : 'B', usage: { prompt: 10, completion: 1 } }
      }
      return messages.some((m) => m.role === 'tool')
        ? { content: 'Both done.', usage: { prompt: 10, completion: 3 } }
        : {
            toolCalls: [
              { name: 'delegate', args: { task: 'the first' } },
              { name: 'delegate', args: { task: 'the second' } }
            ],
            usage: { prompt: 10, completion: 5 }
          }
    }
  }
}

/** What a reply saved, without what depends on the clock, and its usage rows without the endpoint in the model's key. */
function savedReply(messageId: string) {
  const m = getMessage(messageId)!
  const { durationMs: _d, tokensPerSecond: _t, thinkingMs: _k, ...stats } = m.stats ?? {}
  const rows = all<{ model: string; kind: string; prompt_tokens: number; completion_tokens: number; cost_usd: number | null; estimated: number; billing: string }>(
    `SELECT model, kind, prompt_tokens, completion_tokens, cost_usd, estimated, billing FROM usage_events
     WHERE message_id = ? AND kind != 'title' ORDER BY created_at`,
    messageId
  )
  return {
    content: m.content,
    thinking: m.thinking,
    thinkingSegments: m.thinkingSegments?.map(({ ms: _ms, ...s }) => s) ?? null,
    failed: m.error !== null,
    stats,
    toolEvents: m.toolEvents,
    usage: rows.map((r) => ({ ...r, model: r.model.slice(r.model.indexOf('/') + 1) }))
  }
}

async function runScript(dialect: Dialect, script: Script) {
  setApiKey('test-key')
  pageNo = 0
  events.length = 0
  chatCalls = []
  web = script.web ?? ((_p, res) => res.writeHead(404).end())
  chat = (b, res, n) => writeTurn(res, dialect, script.turn(b, n), { includeUsage: asksUsage(b), pauseMs: script.pauseMs })
  const r = service.send(
    { conversationId: null, projectId: null, content: script.prompt, attachmentIds: [], model: keyFor(dialect), think: null, skills: [], toolSources: [] },
    script.opts
  )
  if (script.stop) {
    await waitFor(() => events.some((e) => e.type === 'delta' && e.conversationId === r.conversation.id))
    await service.stop(r.conversation.id, { quiet: true })
  } else await doneEvent(r.conversation.id)
  return { calls: chatCalls, saved: savedReply(r.assistantMessageId), error: getMessage(r.assistantMessageId)?.error ?? null, messageId: r.assistantMessageId }
}

describe('one reply loop, both dialects', () => {
  beforeAll(() => {
    openaiId = addEndpoint({ name: 'OpenAI mock', baseUrl: `${openaiServer.url}/v1`, kind: 'openai', flavor: 'generic' }).id
    openaiServer.handler = (req, res) => {
      if (req.url === '/v1/models') return res.writeHead(200).end(JSON.stringify({ object: 'list', data: [{ id: 'llama3.2', object: 'model' }] }))
      // Titles are read whole, apart from the scripted chat, as on the Ollama mock.
      if (req.url === '/v1/chat/completions' && req.json.stream !== true) {
        titleCalls.push(req.json)
        return res.writeHead(200).end(completionJson('A title'))
      }
      if (req.url === '/v1/chat/completions') {
        chatCalls.push(req.json)
        return chat(req.json, res, chatCalls.length)
      }
      return res.writeHead(404).end()
    }
  })

  describe.each(DIALECTS)('over %s', (dialect) => {
    it('streams a reply with its thinking, and saves it with the server’s counts', async () => {
      const { saved } = await runScript(dialect, SCRIPTS['plain reply'])
      expect(saved).toMatchObject({ content: 'Hi there', thinking: 'Greet them.', failed: false })
      expect(saved.stats).toMatchObject({ promptTokens: 10, completionTokens: 3, doneReason: 'stop' })
      expect(saved.usage).toEqual([{ model: 'llama3.2', kind: 'chat', prompt_tokens: 10, completion_tokens: 3, cost_usd: 0, estimated: 0, billing: 'local' }])
    })

    it('runs a tool round, handing the result back in its own dialect', async () => {
      const { saved, calls } = await runScript(dialect, SCRIPTS['tool round'])
      expect(saved.content).toBe('Let me check.\n\nFound it.')
      expect(saved.toolEvents).toEqual([expect.objectContaining({ tool: 'web_search', ok: true, at: 'Let me check.'.length })])
      const second = calls[1].messages as Array<Record<string, unknown>>
      const echo = second.find((m) => m.role === 'assistant' && Array.isArray(m.tool_calls))!
      const result = second.find((m) => m.role === 'tool')!
      expect(result.content).toContain('https://k.io')
      if (dialect === 'openai') {
        expect(echo.tool_calls).toEqual([{ id: 'call_mock_0', type: 'function', function: { name: 'web_search', arguments: '{"query":"ollmost"}' } }])
        expect(result.tool_call_id).toBe('call_mock_0')
      } else {
        // An Ollama body never carries a tool-call id (PR 1's rule).
        expect(echo.tool_calls).toEqual([{ function: { name: 'web_search', arguments: { query: 'ollmost' } } }])
        expect(result.tool_name).toBe('web_search')
      }
    })

    // Review Focus #4, at the service level.
    it('saves the partial reply on Stop, with estimated usage and no error', async () => {
      const { saved, error } = await runScript(dialect, SCRIPTS['stop mid-stream'])
      expect(saved).toMatchObject({ content: 'partial reply '.repeat(6), failed: false })
      expect(error).toBeNull()
      expect(saved.stats.estimated).toBe(true)
      expect(saved.usage).toEqual([expect.objectContaining({ estimated: 1, completion_tokens: 21 })])
    })

    it('saves a dropped stream with its text and says the connection dropped', async () => {
      const { saved, error } = await runScript(dialect, SCRIPTS['dropped stream'])
      expect(saved).toMatchObject({ content: 'Half an ans', failed: true })
      expect(error).toMatch(/dropped before the reply finished/)
    })

    it('ends a tool-happy model at the round limit with a tool-free last request', async () => {
      const { saved, calls } = await runScript(dialect, SCRIPTS['round limit'])
      expect(calls).toHaveLength(3)
      expect(calls.at(-1)!.tools).toBeUndefined()
      expect(saved.content).toBe('Stopped early')
      expect(saved.stats.toolRoundLimit).toBe(3)
    })

    it('shortens this turn’s older results when the next request would overflow', async () => {
      const { saved, calls } = await runScript(dialect, SCRIPTS['result shortening'])
      const results = (calls[2].messages as Array<{ role: string; content: string }>).filter((m) => m.role === 'tool')
      expect(results[0].content).toMatch(/^\[Ollmost shortened this earlier web_fetch result/)
      expect(results[1].content).toContain('MARK-2')
      expect(saved.stats.shortenedToolResults).toBe(1)
    })

    // #175's batches over either dialect: the results keep call order, and each names the call it answers.
    it('runs two sub-agents at once and hands each result back under its own call, in call order', async () => {
      const { saved, calls } = await runScript(dialect, SCRIPTS['two sub-agents at once'])
      expect(saved).toMatchObject({ content: 'Both done.', failed: false })
      expect(saved.toolEvents.map((e) => [e.tool, e.child?.result])).toEqual([
        ['delegate', 'A'],
        ['delegate', 'B']
      ])
      // The children finish before the parent asks again, so its last request is the one with both results.
      const results = (calls.at(-1)!.messages as Array<Record<string, unknown>>).filter((m) => m.role === 'tool')
      expect(results.map((m) => m.content)).toEqual(['A', 'B'])
      if (dialect === 'openai') {
        expect(results.map((m) => m.tool_call_id)).toEqual(['call_mock_0', 'call_mock_1'])
      } else {
        // An Ollama body names the tool and never carries an id (PR 1's rule).
        expect(results.map((m) => m.tool_name)).toEqual(['delegate', 'delegate'])
      }
    })

    it('times tok/s from the first token when the server reports no generation time', async () => {
      const { messageId } = await runScript(dialect, { ...SCRIPTS['plain reply'], pauseMs: 30 })
      expect(getMessage(messageId)!.stats!.tokensPerSecond).toBeGreaterThan(0)
    })
  })

  it.each(Object.keys(SCRIPTS))('%s: both dialects save the same reply, tool events and usage', async (name) => {
    const ollamaRun = await runScript('ollama', SCRIPTS[name])
    const openaiRun = await runScript('openai', SCRIPTS[name])
    expect(openaiRun.saved).toEqual(ollamaRun.saved)
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/service.test.ts`
Expected: FAIL with "writeTurn is not a function" (and `completionJson`) for every test in the new section; the rest
of the file passes, #175's sub-agent tests included.

- [ ] **Step 3: A scripted reply in either dialect, in `tests/ollamaMock.ts`**

Append:
```ts
// ---- One scripted reply, in either dialect (PR 3) ----

export type Dialect = 'ollama' | 'openai'

/** One request's reply, the same whichever server writes it. */
export interface Turn {
  thinking?: string
  content?: string
  toolCalls?: Array<{ name: string; args: Record<string, unknown> }>
  /** Counts the server reports; left out, Ollmost estimates them. */
  usage?: { prompt: number; completion: number }
  /** done_reason / finish_reason, 'stop' unless given (Ollama says 'stop' for tool rounds too). */
  finish?: string
  /** 'hang': stop writing and keep the socket open, as a model still writing; 'drop': close it with no ending. */
  cut?: 'hang' | 'drop'
}

/**
 * A turn as each server writes it: NDJSON lines for Ollama; for OpenAI, SSE deltas with each call's arguments in two
 * fragments, and a usage chunk only when the request asked for one.
 */
export function turnChunks(dialect: Dialect, turn: Turn, opts: { includeUsage?: boolean } = {}): string[] {
  const finish = turn.finish ?? 'stop'
  if (dialect === 'ollama') {
    const message = (m: Record<string, unknown>) => line({ message: { role: 'assistant', content: '', ...m }, done: false })
    return [
      ...(turn.thinking ? [message({ thinking: turn.thinking })] : []),
      ...(turn.content ? [message({ content: turn.content })] : []),
      ...(turn.toolCalls?.length ? [message({ tool_calls: turn.toolCalls.map((c) => ({ function: { name: c.name, arguments: c.args } })) })] : []),
      ...(turn.cut
        ? []
        : [line({ done: true, done_reason: finish, ...(turn.usage && { prompt_eval_count: turn.usage.prompt, eval_count: turn.usage.completion }) })])
    ]
  }
  const calls = (turn.toolCalls ?? []).flatMap((c, index) => {
    const args = JSON.stringify(c.args)
    const half = Math.ceil(args.length / 2)
    return [
      sseDelta({ tool_calls: [{ index, id: `call_mock_${index}`, type: 'function', function: { name: c.name, arguments: '' } }] }),
      sseDelta({ tool_calls: [{ index, function: { arguments: args.slice(0, half) } }] }),
      sseDelta({ tool_calls: [{ index, function: { arguments: args.slice(half) } }] })
    ]
  })
  const usage = turn.usage && opts.includeUsage
    ? [sse({ id: 'chatcmpl-mock', object: 'chat.completion.chunk', created: 0, model: 'mock', choices: [], usage: { prompt_tokens: turn.usage.prompt, completion_tokens: turn.usage.completion, total_tokens: turn.usage.prompt + turn.usage.completion } })]
    : []
  return [
    sseDelta({ role: 'assistant', content: '' }),
    ...(turn.thinking ? [sseDelta({ reasoning_content: turn.thinking })] : []),
    ...(turn.content ? [sseDelta({ content: turn.content })] : []),
    ...calls,
    ...(turn.cut ? [] : [sseDelta({}, finish), ...usage, sseDone])
  ]
}

/** Write a turn as its server would, ending the response unless the turn hangs. */
export async function writeTurn(res: ServerResponse, dialect: Dialect, turn: Turn, opts: { includeUsage?: boolean; pauseMs?: number } = {}): Promise<void> {
  const chunks = turnChunks(dialect, turn, opts)
  await (dialect === 'ollama' ? streamChunks(res, chunks, opts.pauseMs) : streamSse(res, chunks, opts.pauseMs))
  if (turn.cut !== 'hang') res.end()
}

/** A chat completion read whole (titles, /compact). */
export const completionJson = (content: string): string =>
  JSON.stringify({
    id: 'chatcmpl-mock',
    object: 'chat.completion',
    created: 0,
    model: 'mock',
    choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 20, completion_tokens: 2, total_tokens: 22 }
  })
```

- [ ] **Step 4: Run it to see what's left**

Run: `npx vitest run tests/service.test.ts`
Expected: every new test passes except "times tok/s from the first token…" on both dialects (`tokensPerSecond` is
undefined: neither mock reports a generation time, and PR 1 left the fallback to this PR).

If a comparison test fails instead, its diff shows where the dialects part: a saved field that differs is a bug in
the adapter (or in what the SSE mock writes for that turn), never a reason to leave the field out of `savedReply`.

- [ ] **Step 5: Time tok/s from the first token when a server doesn't report it**

In `src/main/chat/rounds.ts`, in the round (PR 1's code):
1. Beside `let chunks = 0`, add `let firstTokenAt: number | null = null`.
2. Inside `if ((ev.type === 'thinking' || ev.type === 'content') && ev.text) {`, before `roundTrace.firstToken()`, add
   `firstTokenAt ??= Date.now()`.
3. Replace `genMs += done?.timing?.genMs ?? 0` with:
   ```ts
      // A server that reports no generation time (LM Studio, vLLM, Ollama's cloud models) is timed from its first token.
      genMs += done?.timing?.genMs ?? (done && firstTokenAt !== null ? Date.now() - firstTokenAt : 0)
   ```
   A round with no `done` (stopped or failed) still adds nothing, as before. The `RoundsResult.genMs` doc comment
   becomes `/** Generation time in ms: each round's reported genMs, else its first token → done. */`.
4. In `service.ts`, the comment above `stats.tokensPerSecond` (PR 1's "The server's own generation time, where it
   reports one…") becomes `// The server's own generation time, else the time from its first token to the end (see runRounds).`

This is the one change Ollama users see: cloud models (which report no `eval_duration`) show a tok/s figure for the
first time. Append to the README's "Known limits (deliberately deferred)":
```md
- **tok/s is measured on this Mac when a server doesn't report it.** Ollama's cloud models, LM Studio and vLLM send no generation time, so their replies' tok/s runs from the first token to the end, network time included.
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx vitest run tests/service.test.ts` then `npm run typecheck && npm run lint && npm run format:check && npm test`
Expected: PASS, the whole file: the Ollama-only tests above the new section are unchanged, #175's `runRounds` test of
calls that run together and its `describe('sub-agents')` tests of delegations at once among them.

- [ ] **Step 7: Commit**

```bash
git add tests/ollamaMock.ts tests/service.test.ts src/main/chat/rounds.ts src/main/chat/service.ts README.md
git commit -m "One reply loop, both dialects: the service tests run over Ollama and an OpenAI-compatible server

Plain replies, tool rounds, Stop, dropped streams, round limits, result shortening and two sub-agents at once run
against the NDJSON mock and an SSE mock added as a second endpoint, and must save the same reply, tool events and
usage rows; over SSE each sub-agent's result goes back under its own call's id, in call order. tok/s is now
timed from the first token when a server reports no generation time, as the spec says: Ollama's cloud models show it
now too (a line in the README's known limits).

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 8: Record the spike's answers in the spec**

In `docs/superpowers/specs/2026-09-27-model-endpoints-design.md`, under "Verify in the capture spike", add
after the six questions a list headed `Answers (capture, <date>, LM Studio <version>):`, one line per question, each
the answer from `capture/FINDINGS.md` and what PR 3 did about it (for example "3. Yes: a last chunk with `choices: []`
carries `usage`. No change needed."). Then:
```bash
git add docs/superpowers/specs/2026-09-27-model-endpoints-design.md
git commit -m "Spec: what the capture spike found about LM Studio, and what PR 3 did with it

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 9: Full check before the PR**

Run: `npm run typecheck && npm run lint && npm run format:check && npm test`
Expected: PASS
Run: `git grep -n "arrives in the next update" -- src tests`
Expected: no output.

- [ ] **Step 10: Push and open the PR**

```bash
git push -u origin claude/model-endpoints-openai
gh pr create --base main --head claude/model-endpoints-openai \
  --title "OpenAI-compatible endpoints: LM Studio, llama.cpp, vLLM and others" \
  --body "$(cat <<'EOF'
The first release where LM Studio works. PR 3 of the model-endpoints plan (spec: docs/superpowers/specs/2026-09-27-model-endpoints-design.md).

## What changes
- **A second adapter**, `providers/openai/`: POSTs `/chat/completions`, reads SSE (`sseData`), splits a leading `<think>` block out of servers that leave reasoning in the text, assembles tool-call deltas by `index` and hands calls over whole, and reports usage, `finish_reason` and llama.cpp's timings. Stop stays a stop; a stream with no ending is "connection dropped".
- **`stream_options`** is dropped for good (saved on the endpoint) once a server rejects it.
- **Errors name the endpoint and its address.** A vLLM or llama.cpp error asking for `--enable-auto-tool-choice` / `--jinja` turns tools off for that model, and a context-overflow error teaches its real window; both show in Settings with a Re-detect.
- **Discovery per server**: LM Studio 0.4's own model list (tools, vision, a thinking preset, the loaded window), llama.cpp's `/props`, vLLM's `max_model_len`, and ids only elsewhere (embedding models hidden). The Add endpoint probe tells all of them apart and says what it found.
- **Addresses**: an OpenAI-compatible endpoint keeps the API base its probe found (usually `…/v1`; a base typed with a path of its own, such as `…/v1beta/openai`, is kept when `/models` answers there), and editing its address probes it again. Addresses are still compared by their root, so one server typed three ways is one endpoint.
- **Settings → Models**: Tools, Vision and Context per model as Auto (value), with Re-detect; the Add endpoint dialog adds every flavour.
- **Tool-call ids** a server leaves out are made up as 9 letters and digits (`t00000000`), the only shape Mistral's chat templates on vLLM accept.
- **tok/s** is timed from the first token when a server reports no generation time (LM Studio, vLLM, and Ollama's cloud models, which now show it too).

## Capture spike
<one line per question from capture/FINDINGS.md, and the row of each "Apply capture/FINDINGS.md" step that was applied>

## Tests
- SSE framing, the stall timer, the think splitter, tool-call assembly (Review Focus #3: interleaved calls with escapes split across chunks), body mapping, errors, discovery and probing per flavour.
- The adapter against the LM Studio captures (in the network pieces they arrived in, and in others), and llama.cpp/vLLM fixtures written from their docs (marked unverified).
- `tests/service.test.ts`: plain reply, tool round, Stop (Review Focus #4), dropped stream, round limit, result shortening and two sub-agents at once (#175: each result under its own call's id, in call order), each over both dialects, saving identical messages, tool events and usage rows.

## Not in this PR
Billing labels ("local", "cost not tracked"), quota gating, traces' dialect and replay routing, debugger wording and the README are PR 4; the e2e factory and endpoints flow are PR 5.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```
Fill in the "Capture spike" section from `FINDINGS.md` before running it.

- [ ] **Step 11: Wait for CI**

Run: `gh pr checks --watch`
Expected: every check passes. Merge only when the user says so.

- [ ] **Step 12: Install for the user's check**

Run: `OLLMOST_INSTALL_DIR=~/Applications npm run install:mac`
Expected: the build installs to `~/Applications/Ollmost.app`, the copy the user runs.

- [ ] **Step 13: Manual check against the user's LM Studio**

With LM Studio's server started (Developer tab, port 1234) and a tools-and-thinking model downloaded (e.g.
`qwen/qwen3-8b`), in the installed app:
1. Settings → Models → + Add endpoint → "LM Studio :1234" → Check. Expected: "Found LM Studio · N models · …" and
   "Context sizes reported by the server". Add.
2. The endpoint's page lists its models with Tools/Vision/Context as Auto (…); `qwen/qwen3-8b` shows Thinking
   "Auto (On / off)".
3. New chat → picker → the LM Studio chip → `qwen/qwen3-8b` → "hi". Expected: the reply streams; its reasoning shows in
   the thinking block (turn thinking on in the composer if it's off).
4. With the ollama.com key saved: "search the web for today's Ollama release". Expected: a web_search card, then an
   answer that uses it.
5. Ask for a long answer and press Stop partway. Expected: the partial reply stays, with no error.
6. Stop LM Studio's server and reopen the picker. Expected: the LM Studio chip is a dashed ⚠ with its error ("Can't
   reach LM Studio at localhost:1234. Is its server started? Start it in LM Studio’s Developer tab."), and every other
   endpoint's models are still listed. Start the server again and click Retry.
7. Switch the same chat to an Ollama model and send again. Expected: the reply comes from Ollama; the earlier LM Studio
   turns (tool call included) replay without an error.

Tell the user what was checked and anything that looked off, and wait for their go-ahead before merging.

---

## Contract additions (PR 4–5)

Names these tasks add beyond the Shared contracts. Later tasks and PRs use them exactly.

```ts
// ---- src/shared/types.ts (Task 4.1) ----
/** One model's usage: its key, its name at its endpoint, the endpoint as it is now, and how its requests were billed. */
export interface UsageByModel extends TokenTotals {
  model: string                          // the model key
  name: string                           // the name at its endpoint
  endpoint: ModelInfo['endpoint']        // { id, name, kind, flavor }; a removed endpoint reads 'Removed endpoint'
  billing: ModelBilling
  requests: number
}
// ChatUsage.byModel and UsageSummary.byModel become UsageByModel[]; UsageSummary.byDay[].costUsd becomes number | null.

// ---- src/main/db/usage.ts (Task 4.1): signature changes ----
conversationUsage(conversationId: string, endpoints: readonly Endpoint[]): ChatUsage
usageSummary(endpoints: readonly Endpoint[], days: number, sinceMs?: number, untilMs?: number | null): UsageSummary

// ---- src/shared/billing.ts (Task 4.1), beside the contract's billingLabel and chatCostLabel ----
legacyBilling(costUsd: number | null | undefined): ModelBilling            // stats saved before billing: 0 → 'local', else 'priced'
describeUsageModel(key: string, endpoints: readonly Endpoint[]): Pick<UsageByModel, 'name' | 'endpoint'>
traceCostTotal(traces: ReadonlyArray<Pick<TraceSummary, 'kind' | 'promptTokens' | 'costUsd'>>): number | null

// ---- src/shared/usage.ts (Task 4.2) ----
export type QuotaMode = 'show' | 'add-key' | 'hidden'
hasOllamaEndpoint(endpoints: ReadonlyArray<Pick<Endpoint, 'kind' | 'enabled'>>): boolean   // any enabled Ollama endpoint
quotaMode(s: Pick<Settings, 'endpoints' | 'ollamaAccount'>): QuotaMode

// ---- src/main/usage/account.ts (Task 4.2) ----
planEndpoint(endpoints: readonly Endpoint[]): Endpoint | null   // first enabled Ollama endpoint with whereOf(baseUrl) === 'this-mac'

// ---- src/shared/types.ts (Task 4.3) ----
export type TraceDialect = EndpointKind                          // 'ollama' | 'openai'
export type TraceAuth = 'ollama.com' | 'endpoint' | null
// TraceDetail gains: dialect: TraceDialect; auth: TraceAuth; endpointId: string | null; endpointName: string | null

// ---- src/shared/debug.ts (Task 4.3) ----
export interface TraceTarget { dialect: TraceDialect; auth: TraceAuth; endpointId: string; endpointName: string }
traceTarget(endpoint: Pick<Endpoint, 'id' | 'name' | 'kind' | 'baseUrl' | 'hasKey'>): TraceTarget   // spread into startTrace
storedTraceTarget(data): Pick<TraceDetail, 'dialect' | 'auth' | 'endpointId' | 'endpointName'>     // missing → Ollama
export interface TraceMessage { role: string; text: string; thinking: string; images: string[]; toolCalls: unknown[] | null; toolName: string | null }
traceMessages(body: { messages?: unknown[] }, dialect: TraceDialect): TraceMessage[]
curlKeyVar(t: Pick<TraceDetail, 'auth' | 'endpointId'>): string | null     // 'OLLAMA_API_KEY' | 'LM_STUDIO_API_KEY' | null
// changed: promptAnatomy(body, dialect: TraceDialect = 'ollama'); toCurl(endpoint, body, keyVar: string | null)

// ---- traces and replay (Task 4.3) ----
startTrace({ ..., dialect?, auth?, endpointId?: string, endpointName?: string })   // endpointId/endpointName beyond the contract
replayRequest(conversationId: string | null, model: string | null, raw: unknown, endpointName?: string | null): Promise<TraceDetail>
// IPC: debug.replay(conversationId, model, body, endpointName?) ; debug.target() is removed

// ---- src/shared/palette.ts (Task 4.4) ----
export type SettingsTabId = 'general' | 'appearance' | 'models' | 'usage' | 'features' | 'tools' | 'data'
export const SETTINGS_TABS: ReadonlyArray<{ id: SettingsTabId; label: string; keywords: string[] }>
settingsTabCommands(): Array<Rankable & { tab: SettingsTabId }>
// renderer: stores/app.ts `SettingsTab` becomes an alias of SettingsTabId

// ---- e2e/run.mjs (PR 5) ----
fakeServer({ dialect, models, capabilities?, reply, once?, title?, route?, requests? }): Promise<{ port, url, close() }>
useOllamaAt(win, url)          // points the migrated 'ollama' endpoint at a fake, cloud catalog off, and reloads
expectedQuota(win)             // 'show' | 'add-key' | 'hidden', by quotaMode's rule
pickModel(win, name, endpoint?) // gains an optional endpoint chip to click first
```

**Assumed from PR 1–3 beyond the Shared contracts** (checked against `pr0-1.md`, `pr2.md` and `pr3.md`: the names match):
- `Provider.endpoint: Endpoint` (PR 2, Task 2.4) and `Provider.wireEndpoint()` (PR 1): where a provider's `wire()` bodies go, which a replay's trace records.
- The renderer store keeps the list's errors as `modelErrors: ModelListResult['errors']` (PR 2 Task 2.7; today `modelsError: string | null`).
- `TraceTiming` keeps its field names `loadMs` / `promptEvalMs` / `evalMs` (PR 1 fills them from `ChatTiming`).
- On a fresh data folder the settings migration creates the endpoint `ollama` (`http://127.0.0.1:11434`).
- UI selectors: the picker trigger keeps `aria-label="Choose model"` and the search box `placeholder="Search models"`; each endpoint chip is a button named by the endpoint's name; the Add endpoint dialog is a `role="dialog"` with fields labelled "Address" and "Name", buttons "Check" and "Add", and a step-2 summary starting "Found"; a reply's footer still shows its model in a `span.cursor-default` whose tooltip is the stats line. PR 2's picker and dialog (Tasks 2.7–2.8) and PR 3's dialog changes (Task 3.9) build them this way; should one move, PR 5 changes its selectors to match, not the UI.

---

## PR 4 — Usage, traces and polish

Branch: `claude/model-endpoints-polish`, from `main` after PR 3 has merged.

Before starting, re-read every file each task names. Line numbers below are against `main` @ 24f4623 (#179, #180 and #175 merged); PR 1–3 move many of them. Code moved since wins over line numbers, never over behaviour.

```bash
git checkout main && git pull && git checkout -b claude/model-endpoints-polish
```

### Task 4.1: Billing labels and totals

**Files:**
- Create: `src/shared/billing.ts`
- Create: `tests/billing.test.ts`
- Modify: `src/shared/types.ts:341-362` (`TokenTotals`, `ChatUsage`, `UsageSummary`; add `UsageByModel`)
- Modify: `src/main/db/usage.ts:32-101` (everything after `insertUsageEvent`)
- Modify: `src/main/chat/service.ts:408,478,541,762,830` and `src/main/ipc.ts:272,366` (call sites)
- Modify: `src/renderer/src/components/Messages.tsx:27,543-557`
- Modify: `src/renderer/src/components/UsageBar.tsx:3,307-382`
- Modify: `src/renderer/src/views/SettingsView.tsx:545-578`
- Modify: `src/renderer/src/debug/DebugApp.tsx:88-96,159-162`
- Test: `tests/billing.test.ts`, `tests/usage.test.ts`; update `tests/db.test.ts:217-219,242,271,299`, `tests/service.test.ts:780,2022,2113`

**Interfaces:**
- Consumes: `ModelBilling`, `Endpoint`, `EndpointKind`, `EndpointFlavor`, `ModelInfo['endpoint']`, `MessageStats.billing` (PR 2); `splitModelKey(key, knownIds)`, `toModelKey(endpointId, model)` (`src/shared/modelKey.ts`, PR 2); `modelLabel(m: Pick<ModelInfo, 'name' | 'endpoint'>)` (PR 2); `insertUsageEvent({ …, billing })` (PR 2); `formatCost(usd)` (`src/shared/usage.ts`).
- Produces: `billingLabel`, `chatCostLabel` (contract); `legacyBilling`, `describeUsageModel`, `traceCostTotal`; `UsageByModel`; `conversationUsage(conversationId, endpoints)`, `usageSummary(endpoints, days, sinceMs?, untilMs?)`.

- [ ] **Step 1: Write the failing tests**

Create `tests/billing.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { billingLabel, chatCostLabel, describeUsageModel, legacyBilling, traceCostTotal } from '@shared/billing'
import type { Endpoint, EndpointFlavor, EndpointKind, ModelBilling, TraceKind } from '@shared/types'

const ep = (id: string, name: string, kind: EndpointKind, flavor: EndpointFlavor, baseUrl: string): Endpoint => ({
  id,
  name,
  kind,
  flavor,
  baseUrl,
  enabled: true,
  hasKey: false
})
const endpoints = [
  ep('ollama', 'Ollama', 'ollama', 'ollama', 'http://127.0.0.1:11434'),
  ep('lm-studio', 'LM Studio', 'openai', 'lmstudio', 'http://localhost:1234/v1')
]

describe('a reply’s cost label', () => {
  it('shows dollars for a priced reply, and nothing while its price is unknown', () => {
    expect(billingLabel('priced', 0.0031)).toBe('$0.0031')
    expect(billingLabel('priced', 0)).toBe('$0')
    expect(billingLabel('priced', null)).toBeNull()
  })

  it('says local or cost not tracked instead of $0', () => {
    expect(billingLabel('local', 0)).toBe('local')
    expect(billingLabel('untracked', 0)).toBe('cost not tracked')
  })

  it('reads a reply saved before billing was recorded the way the database backfill does: $0 was local', () => {
    expect(legacyBilling(0)).toBe('local')
    expect(legacyBilling(0.2)).toBe('priced')
    expect(legacyBilling(null)).toBe('priced')
    expect(legacyBilling(undefined)).toBe('priced')
  })
})

describe('a chat’s cost chip', () => {
  const row = (billing: ModelBilling, costUsd: number | null) => ({ billing, costUsd })

  it('is local when every request ran on this Mac, and not tracked when every one went elsewhere', () => {
    expect(chatCostLabel([row('local', 0), row('local', 0)])).toBe('local')
    expect(chatCostLabel([row('untracked', 0)])).toBe('not tracked')
  })

  it('sums the priced requests when there are any', () => {
    expect(chatCostLabel([row('priced', 0.25), row('priced', 0.5), row('local', 0), row('untracked', 0)])).toBe('$0.750')
  })

  it('is cost unknown when a priced request has no price', () => {
    expect(chatCostLabel([row('priced', 0.25), row('priced', null), row('local', 0)])).toBe('cost unknown')
  })

  it('is not tracked, not $0, when nothing was priced and some went elsewhere', () => {
    expect(chatCostLabel([row('local', 0), row('untracked', 0)])).toBe('not tracked')
  })
})

describe('a usage row’s model and endpoint', () => {
  it('splits the key on its endpoint, keeping an Ollama name that has slashes whole', () => {
    expect(describeUsageModel('ollama/hf.co/bartowski/Qwen3-8B-GGUF:Q4_K_M', endpoints)).toEqual({
      name: 'hf.co/bartowski/Qwen3-8B-GGUF:Q4_K_M',
      endpoint: { id: 'ollama', name: 'Ollama', kind: 'ollama', flavor: 'ollama' }
    })
    expect(describeUsageModel('lm-studio/qwen/qwen3-8b', endpoints)).toEqual({
      name: 'qwen/qwen3-8b',
      endpoint: { id: 'lm-studio', name: 'LM Studio', kind: 'openai', flavor: 'lmstudio' }
    })
  })

  it('reads a leftover bare name as Ollama’s, and a key whose endpoint is gone as a removed endpoint’s', () => {
    expect(describeUsageModel('gpt-oss:20b', endpoints).endpoint.name).toBe('Ollama')
    expect(describeUsageModel('old-box/llama3:8b', endpoints)).toEqual({
      name: 'old-box/llama3:8b',
      endpoint: { id: '', name: 'Removed endpoint', kind: 'openai', flavor: 'generic' }
    })
  })
})

describe('the debugger’s cost total', () => {
  const t = (kind: TraceKind, promptTokens: number | null, costUsd: number | null) => ({ kind, promptTokens, costUsd })

  it('adds billed requests, skipping tool calls and requests that failed before any tokens', () => {
    expect(traceCostTotal([t('chat', 100, 0.25), t('tool', null, null), t('chat', null, null), t('title', 50, 0)])).toBe(0.25)
  })

  it('is unknown when a billed request has no cost: only a priced one without a price has none', () => {
    expect(traceCostTotal([t('chat', 100, 0.25), t('replay', 80, null)])).toBeNull()
  })
})
```

In `tests/usage.test.ts`, change the first line to `import { beforeAll, describe, expect, it } from 'vitest'`, add these imports below the existing ones, and append the `describe`:

```ts
import { toModelKey } from '@shared/modelKey'
import type { Endpoint, ModelBilling } from '@shared/types'
import { createConversation } from '../src/main/db/conversations'
import { getDb, openDatabase } from '../src/main/db/index'
import { conversationUsage, insertUsageEvent, usageSummary } from '../src/main/db/usage'

describe('usage totals across endpoints', () => {
  beforeAll(() => openDatabase(':memory:'))

  const endpoints: Endpoint[] = [
    { id: 'ollama', name: 'Ollama', kind: 'ollama', flavor: 'ollama', baseUrl: 'http://127.0.0.1:11434', enabled: true, hasKey: false },
    { id: 'lm-studio', name: 'LM Studio', kind: 'openai', flavor: 'lmstudio', baseUrl: 'http://localhost:1234/v1', enabled: true, hasKey: false },
    { id: 'lab', name: 'Lab vLLM', kind: 'openai', flavor: 'vllm', baseUrl: 'http://10.0.0.5:8000/v1', enabled: true, hasKey: false }
  ]
  const row = (conversationId: string | null, model: string, billing: ModelBilling, costUsd: number | null, completionTokens = 100) =>
    insertUsageEvent({ conversationId, messageId: null, model, kind: 'chat', billing, promptTokens: 1000, completionTokens, costUsd, estimated: false })
  const chat = () =>
    createConversation({ projectId: null, model: toModelKey('ollama', 'gpt-oss:120b-cloud'), think: null, skills: [], toolSources: [] })

  it('prices a chat from its priced rows, names each model’s endpoint, and knows the total while every priced row has a price', () => {
    const c = chat()
    row(c.id, 'ollama/gpt-oss:120b-cloud', 'priced', 0.25)
    row(c.id, 'ollama/gpt-oss:120b-cloud', 'priced', 0.5)
    row(c.id, 'lm-studio/qwen/qwen3-8b', 'local', 0, 150)
    row(c.id, 'lab/Qwen/Qwen3-32B', 'untracked', 0, 50)
    const u = conversationUsage(c.id, endpoints)
    expect(u.costUsd).toBe(0.75)
    expect(u.byModel.map((m) => [m.name, m.endpoint.name, m.billing, m.costUsd])).toEqual([
      ['gpt-oss:120b-cloud', 'Ollama', 'priced', 0.75],
      ['qwen/qwen3-8b', 'LM Studio', 'local', 0],
      ['Qwen/Qwen3-32B', 'Lab vLLM', 'untracked', 0]
    ])
    row(c.id, 'ollama/gpt-oss:120b-cloud', 'priced', null)
    expect(conversationUsage(c.id, endpoints).costUsd).toBeNull()
  })

  it('never lets a local or untracked row make a total unknown', () => {
    const c = chat()
    row(c.id, 'lm-studio/qwen/qwen3-8b', 'local', null)
    row(c.id, 'lab/Qwen/Qwen3-32B', 'untracked', null)
    expect(conversationUsage(c.id, endpoints).costUsd).toBe(0)
  })

  it('follows the same rule per day, over a period', () => {
    const at = Date.parse('2030-01-02T12:00:00Z')
    const date = () => getDb().prepare('UPDATE usage_events SET created_at = ? WHERE conversation_id IS NULL').run(at)
    row(null, 'lab/Qwen/Qwen3-32B', 'untracked', 0)
    row(null, 'ollama/glm-5.3:cloud', 'priced', 0.1)
    date()
    let s = usageSummary(endpoints, 1, at - 60_000, at + 60_000)
    expect(s.total.costUsd).toBe(0.1)
    expect(s.byDay).toEqual([{ day: '2030-01-02', costUsd: 0.1, tokens: 2200 }])
    row(null, 'ollama/glm-5.3:cloud', 'priced', null)
    date()
    s = usageSummary(endpoints, 1, at - 60_000, at + 60_000)
    expect(s.total.costUsd).toBeNull()
    expect(s.byDay[0].costUsd).toBeNull()
  })
})
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run tests/billing.test.ts tests/usage.test.ts`
Expected: FAIL. `tests/billing.test.ts` with "Failed to load url … src/shared/billing … Does the file exist?"; `tests/usage.test.ts` with a diff on `byModel` (rows have no `name`/`endpoint`) and "expected null to be +0" in the local/untracked test (today any NULL cost counts as unpriced).

- [ ] **Step 3: Add `UsageByModel` and the new row types to `src/shared/types.ts`**

Replace `TokenTotals`, `ChatUsage` and `UsageSummary` (lines 341-362) with:

```ts
export interface TokenTotals {
  promptTokens: number
  completionTokens: number
  /** Null when a priced (Ollama cloud) request had no known price. Local and untracked requests count as 0. */
  costUsd: number | null
  /** At least one request had no token counts (e.g. stopped mid-stream) and was estimated. */
  estimated: boolean
}

/** One model's usage: its key, its name at its endpoint, the endpoint as it is now, and how its requests were billed. */
export interface UsageByModel extends TokenTotals {
  model: string
  name: string
  /** A removed endpoint's rows read `{ id: '', name: 'Removed endpoint' }`. */
  endpoint: ModelInfo['endpoint']
  billing: ModelBilling
  requests: number
}

export interface ChatUsage extends TokenTotals {
  byModel: UsageByModel[]
  /** Tokens the most recent request sent + received, for a context-window meter. */
  lastContextTokens: number | null
}

export interface UsageSummary {
  days: number
  total: TokenTotals & { requests: number }
  byModel: UsageByModel[]
  /** A day's cost is null when one of its priced requests had no price. */
  byDay: Array<{ day: string; costUsd: number | null; tokens: number }>
}
```

- [ ] **Step 4: Create `src/shared/billing.ts`**

```ts
// Cost labels. Only Ollama cloud models are priced; a model on this Mac is 'local', and anything else 'cost not tracked'.
import { splitModelKey } from './modelKey'
import type { Endpoint, ModelBilling, TraceSummary, UsageByModel } from './types'
import { formatCost } from './usage'

/** One reply's or one row's cost: dollars when priced (nothing while the price is unknown), else what it is instead. */
export function billingLabel(b: ModelBilling, costUsd: number | null): string | null {
  if (b === 'local') return 'local'
  if (b === 'untracked') return 'cost not tracked'
  return costUsd === null ? null : formatCost(costUsd)
}

/**
 * A chat's cost for its chip: 'local' when every request ran on this Mac; 'not tracked' when nothing was priced and
 * some went elsewhere ($0 would claim a cost Ollmost can't know); else the priced requests' sum, or 'cost unknown'
 * when one of them has no price.
 */
export function chatCostLabel(rows: Array<{ billing: ModelBilling; costUsd: number | null }>): string {
  const priced = rows.filter((r) => r.billing === 'priced')
  if (!priced.length) return rows.some((r) => r.billing === 'untracked') ? 'not tracked' : 'local'
  if (priced.some((r) => r.costUsd === null)) return 'cost unknown'
  return formatCost(priced.reduce((n, r) => n + (r.costUsd ?? 0), 0))
}

/** A reply saved before billing was recorded: $0 meant local then, as the database backfill reads it. */
export function legacyBilling(costUsd: number | null | undefined): ModelBilling {
  return costUsd === 0 ? 'local' : 'priced'
}

/**
 * A usage row's model name and endpoint, for display. splitModelKey reads an unknown prefix as a leftover Ollama name;
 * in history, a key with a slash under no configured endpoint is a removed endpoint's, so it keeps its whole key.
 */
export function describeUsageModel(key: string, endpoints: readonly Endpoint[]): Pick<UsageByModel, 'name' | 'endpoint'> {
  const { endpointId, model } = splitModelKey(key, endpoints.map((e) => e.id))
  const e = endpoints.find((x) => x.id === endpointId)
  if (e && (key.startsWith(`${e.id}/`) || !key.includes('/')))
    return { name: model, endpoint: { id: e.id, name: e.name, kind: e.kind, flavor: e.flavor } }
  return { name: key, endpoint: { id: '', name: 'Removed endpoint', kind: 'openai', flavor: 'generic' } }
}

/**
 * The debugger's cost total. A billed request always has token counts, and local and untracked ones cost 0, so a
 * billed request with no cost is a priced one whose price is unknown: that makes the total unknown.
 */
export function traceCostTotal(traces: ReadonlyArray<Pick<TraceSummary, 'kind' | 'promptTokens' | 'costUsd'>>): number | null {
  let total = 0
  for (const t of traces) {
    if (t.kind === 'tool' || t.promptTokens == null) continue
    if (t.costUsd == null) return null
    total += t.costUsd
  }
  return total
}
```

- [ ] **Step 5: Rewrite the totals in `src/main/db/usage.ts`**

Keep `insertUsageEvent` exactly as PR 2 left it (it writes `billing`). Replace everything after it (lines 32-101 on `main`) with the code below. `conversationUsage`'s `last` query is `main`'s (#180) as it is: a compaction and a deleted message still hide the rows before them from the meter.

```ts
interface TotalsRow {
  prompt: number | null
  completion: number | null
  cost: number | null
  unpriced: number | null
  estimated: number | null
  requests: number
}

// Local and untracked rows cost 0; only a priced row without a price leaves a total unknown.
const TOTALS_SQL = `COALESCE(SUM(prompt_tokens), 0) AS prompt, COALESCE(SUM(completion_tokens), 0) AS completion,
  SUM(cost_usd) AS cost, SUM(billing = 'priced' AND cost_usd IS NULL) AS unpriced, MAX(estimated) AS estimated,
  COUNT(*) AS requests`

function totals(r: TotalsRow | undefined): TokenTotals & { requests: number } {
  return {
    promptTokens: r?.prompt ?? 0,
    completionTokens: r?.completion ?? 0,
    // One unpriced cloud request makes the total unknowable rather than silently low.
    costUsd: r?.unpriced ? null : (r?.cost ?? 0),
    estimated: !!r?.estimated,
    requests: r?.requests ?? 0
  }
}

type ModelRow = TotalsRow & { model: string; billing: ModelBilling }

/** Per-model rows with each model's name and endpoint; a model billed two ways (its endpoint moved) gets a row for each. */
function byModel(rows: ModelRow[], endpoints: readonly Endpoint[]): UsageByModel[] {
  return rows.map((r) => ({ model: r.model, billing: r.billing, ...describeUsageModel(r.model, endpoints), ...totals(r) }))
}

export function conversationUsage(conversationId: string, endpoints: readonly Endpoint[]): ChatUsage {
  const total = totals(get<TotalsRow>(`SELECT ${TOTALS_SQL} FROM usage_events WHERE conversation_id = ?`, conversationId))
  const models = byModel(
    all<ModelRow>(
      `SELECT model, billing, ${TOTALS_SQL} FROM usage_events WHERE conversation_id = ?
       GROUP BY model, billing ORDER BY SUM(completion_tokens) DESC`,
      conversationId
    ),
    endpoints
  )
  // A compacted chat's older rows no longer reflect what the next request sends, and a row whose message
  // was later deleted (an Edit or Retry) never went out either; skip both so the meter reads null, not a
  // stale number, until a real request lands.
  const compactedAt = getConversation(conversationId)?.compaction?.at ?? 0
  // ORDER BY ... LIMIT 1 over the filtered rows, so when an Edit or Retry deletes the latest reply, this falls
  // back to the latest surviving request's real total — an older real number, not an estimate of the next one.
  const last = get<{ tokens: number }>(
    `SELECT prompt_tokens + completion_tokens AS tokens FROM usage_events
     WHERE conversation_id = ? AND kind = 'chat' AND created_at > ?
       AND (message_id IS NULL OR EXISTS (SELECT 1 FROM messages WHERE messages.id = usage_events.message_id))
     ORDER BY created_at DESC LIMIT 1`,
    conversationId,
    compactedAt
  )
  const { requests: _requests, ...rest } = total
  return { ...rest, byModel: models, lastContextTokens: last?.tokens ?? null }
}

/**
 * Totals over the last `days`, or between `sinceMs` and `untilMs` when given (the account's own period, to sit
 * beside its spend; a reported period may have ended before now).
 */
export function usageSummary(endpoints: readonly Endpoint[], days: number, sinceMs?: number, untilMs?: number | null): UsageSummary {
  const since = sinceMs ?? Date.now() - days * 86_400_000
  const until = untilMs ?? Number.MAX_SAFE_INTEGER
  const total = totals(get<TotalsRow>(`SELECT ${TOTALS_SQL} FROM usage_events WHERE created_at >= ? AND created_at < ?`, since, until))
  const models = byModel(
    all<ModelRow>(
      `SELECT model, billing, ${TOTALS_SQL} FROM usage_events WHERE created_at >= ? AND created_at < ?
       GROUP BY model, billing ORDER BY SUM(cost_usd) DESC, SUM(completion_tokens) DESC`,
      since,
      until
    ),
    endpoints
  )
  const byDay = all<{ day: string; cost: number | null; unpriced: number | null; tokens: number }>(
    `SELECT date(created_at / 1000, 'unixepoch', 'localtime') AS day, SUM(cost_usd) AS cost,
       SUM(billing = 'priced' AND cost_usd IS NULL) AS unpriced, SUM(prompt_tokens + completion_tokens) AS tokens
     FROM usage_events WHERE created_at >= ? AND created_at < ? GROUP BY day ORDER BY day`,
    since,
    until
  ).map((r) => ({ day: r.day, costUsd: r.unpriced ? null : (r.cost ?? 0), tokens: r.tokens }))
  return { days, total, byModel: models, byDay }
}
```

The file's imports become:

```ts
import { describeUsageModel } from '@shared/billing'
import type { ChatUsage, Endpoint, ModelBilling, TokenTotals, UsageByModel, UsageSummary } from '@shared/types'
import { now, uid } from '../util'
import { getConversation } from './conversations'
import { all, get, run } from './index'
```

- [ ] **Step 6: Pass the endpoints at every call site**

```bash
sed -i '' -E 's/conversationUsage\(([A-Za-z.]+)\)/conversationUsage(\1, getSettings().endpoints)/g' \
  src/main/chat/service.ts src/main/ipc.ts tests/service.test.ts
```

Then in `src/main/ipc.ts` (usage group, today line 366):

```ts
    summary: async (days, since, until) => usageSummary(getSettings().endpoints, days, since, until),
```

And in `tests/db.test.ts:217-219`, the summary test's model is under no endpoint, which is fine for its totals:

```ts
    expect(mine(usageSummary([], 30))).toMatchObject({ requests: 3, promptTokens: 700, costUsd: 7 })
    expect(mine(usageSummary([], 30, since))).toMatchObject({ requests: 2, promptTokens: 600, costUsd: 6 })
    expect(mine(usageSummary([], 30, since, until))).toMatchObject({ requests: 1, promptTokens: 200, costUsd: 2 })
```

The meter tests #180 added to `tests/db.test.ts` (lines 242, 271 and 299) read only `lastContextTokens`, so they need
no endpoints:

```bash
sed -i '' -E 's/conversationUsage\(c\.id\)/conversationUsage(c.id, [])/g' tests/db.test.ts
```

Run `npm run typecheck`; it lists any call site PR 1–3 added (delegate.ts, rounds.ts) — give each `getSettings().endpoints` the same way.

- [ ] **Step 7: Run the tests to verify they pass**

Run: `npx vitest run tests/billing.test.ts tests/usage.test.ts tests/db.test.ts tests/service.test.ts`
Expected: PASS

- [ ] **Step 8: Replace the `cost === 0 means local` uses in the renderer**

`src/renderer/src/components/Messages.tsx` — replace `import { formatCost } from '@shared/usage'` (line 27) with `import { billingLabel, legacyBilling } from '@shared/billing'`, add `MessageStats` to the `@shared/types` import, add above `statsLine`:

```ts
/** The reply's cost as its stats say it: dollars (≈ when estimated), 'local', 'cost not tracked', or nothing. */
function replyCost(s: MessageStats): string | null {
  const label = billingLabel(s.billing ?? legacyBilling(s.costUsd), s.costUsd ?? null)
  return label?.startsWith('$') && s.estimated ? `≈${label}` : label
}
```

and in `statsLine` replace the line
`s.costUsd === 0 ? 'local' : s.costUsd != null ? \`${s.estimated ? '≈' : ''}${formatCost(s.costUsd)}\` : null,`
with `replyCost(s),`.

`src/renderer/src/components/UsageBar.tsx` — drop `formatCost` from the `@shared/usage` import (line 3) and add:

```ts
import { billingLabel, chatCostLabel } from '@shared/billing'
import { modelLabel } from '@shared/modelLabel'
```

In `ChatCost`, replace

```ts
  const allLocal = usage.byModel.every((m) => m.costUsd === 0)
  const cost = allLocal ? 'local' : usage.costUsd === null ? 'cost unknown' : `${usage.estimated ? '≈' : ''}${formatCost(usage.costUsd)}`
```

with

```ts
  const label = chatCostLabel(usage.byModel)
  const cost = usage.estimated && label.startsWith('$') ? `≈${label}` : label
```

replace the `<tbody>` rows with

```tsx
            <tbody>
              {usage.byModel.map((m) => (
                <tr key={`${m.model}|${m.billing}`}>
                  <td className="max-w-[140px] py-0.5">
                    <span className="block truncate">{modelLabel(m)}</span>
                    {/* modelLabel already names a non-Ollama endpoint. */}
                    {m.endpoint.kind === 'ollama' && <span className="block truncate text-[11px] text-subtle">{m.endpoint.name}</span>}
                  </td>
                  <td className="py-0.5 text-right">{formatTokens(m.promptTokens)}</td>
                  <td className="py-0.5 text-right">{formatTokens(m.completionTokens)}</td>
                  <td className="whitespace-nowrap py-0.5 text-right">{billingLabel(m.billing, m.costUsd) ?? '—'}</td>
                </tr>
              ))}
            </tbody>
```

(the rows' `modelLabel(m)` replaces PR 2's `labelForKey(m.model, endpoints)`: drop `ChatCost`'s `const endpoints = useApp(selectEndpoints)` and the `labelForKey` import if nothing else in the file uses them; lint lists them), and the footnote `<p>` at the end of the popover with

```tsx
          <p className="text-xs text-subtle">
            Includes retries and title generation. Priced with Ollama's published rates (Ollama cloud models only). Every prompt
            token counts at the full input rate, so real charges can be lower with cached input or off-peak pricing.
            {usage.estimated && ' Stopped replies are estimated.'}
          </p>
```

`src/renderer/src/views/SettingsView.tsx` — add `import { billingLabel } from '@shared/billing'` and `import { modelLabel } from '@shared/modelLabel'` (PR 2's Task 2.8 dropped the latter with the old Models tab). In the "Spend in Ollmost" section (today lines 545-578), set the description to

```tsx
        description="From token counts Ollmost recorded, every prompt token at the full rate, so an upper bound: Ollama charges cached prompt tokens far less. Other apps using your Ollama account aren't included. Local and untracked endpoints aren't counted."
```

and replace the `summary.byModel.map` rows (PR 2's `labelForKey(m.model, settings.endpoints)`; drop the `labelForKey` import if nothing else uses it) with

```tsx
              {summary.byModel.map((m) => (
                <tr key={`${m.model}|${m.billing}`} className="border-t border-line">
                  <td className="py-1.5">
                    {modelLabel(m)}
                    {/* modelLabel already names a non-Ollama endpoint. */}
                    {m.endpoint.kind === 'ollama' && <span className="text-subtle"> · {m.endpoint.name}</span>}
                  </td>
                  <td className="py-1.5 text-right">{m.requests}</td>
                  <td className="py-1.5 text-right">{formatTokens(m.promptTokens)}</td>
                  <td className="py-1.5 text-right">{formatTokens(m.completionTokens)}</td>
                  <td className="py-1.5 text-right">{m.billing === 'priced' ? formatDollars(m.costUsd) : billingLabel(m.billing, m.costUsd)}</td>
                </tr>
              ))}
```

`src/renderer/src/debug/DebugApp.tsx` — add `import { traceCostTotal } from '@shared/billing'`; in `totals` replace the `cost:` line with

```ts
      // Unknown only when a priced request had no price, as in Settings → Usage & cost.
      cost: traceCostTotal(done)
```

and in the header replace `{formatCost(totals.cost)}` with `{totals.cost === null ? 'cost unknown' : formatCost(totals.cost)}`.

- [ ] **Step 9: Typecheck, lint, test, then check it by hand**

Run: `npx prettier --write src tests && npm run typecheck && npm run lint && npm test`
Expected: PASS

Manual check (`npm run dev`):
1. Send a message on a local Ollama model (e.g. `gemma4:e4b`). The title-bar chip reads `N tokens · local`. Hover the model name under the reply: the stats end in `· local`.
2. Open the chip: the row shows the model, "Ollama" under it, and "local"; the footnote reads "Priced with Ollama's published rates (Ollama cloud models only)."
3. Send on a cloud model in the same chat: the chip shows a `$` sum; the popover has two rows.
4. Settings → Usage & cost → "Spend in Ollmost": rows carry the endpoint name; the note ends "Local and untracked endpoints aren't counted."
5. Open the debugger: the header total is a `$` figure, not "cost unknown".

- [ ] **Step 10: Commit**

```bash
git add src/shared/billing.ts src/shared/types.ts src/main/db/usage.ts src/main/chat/service.ts src/main/ipc.ts \
  src/renderer/src/components/Messages.tsx src/renderer/src/components/UsageBar.tsx src/renderer/src/views/SettingsView.tsx \
  src/renderer/src/debug/DebugApp.tsx tests/billing.test.ts tests/usage.test.ts tests/db.test.ts tests/service.test.ts
git commit -m "Cost labels from billing: \$x, local or cost not tracked, and totals unknown only for an unpriced cloud request

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 4.2: Gating for quota, `/api/me` and pricing

**Files:**
- Modify: `src/shared/usage.ts` (append a "Quota chip" section)
- Modify: `src/main/usage/account.ts:13-28`
- Modify: `src/main/index.ts:35,210-211`
- Modify: `src/renderer/src/stores/usage.ts:28-47`
- Modify: `src/renderer/src/components/UsageBar.tsx:132-154`
- Modify: `src/renderer/src/components/TopBar.tsx:8-11`
- Create: `tests/account.test.ts`
- Test: `tests/usage.test.ts`, `tests/account.test.ts`

`src/renderer/src/App.tsx:37` keeps `const stopUsage = startUsagePolling()`: the function now waits for the settings itself.

**Interfaces:**
- Consumes: `Settings.endpoints`, `Settings.ollamaAccount.hasKey` (PR 2); `whereOf(baseUrl)` (`src/main/providers/where.ts`, PR 2).
- Produces: `QuotaMode`, `quotaMode(s)`, `hasOllamaEndpoint(endpoints)` (`src/shared/usage.ts`); `planEndpoint(endpoints)` (`src/main/usage/account.ts`).

"An Ollama endpoint exists" means an **enabled** one throughout: a switched-off endpoint has no models to price and no daemon to ask.

- [ ] **Step 1: Write the failing tests**

Append to `tests/usage.test.ts` (add `hasOllamaEndpoint, quotaMode` to the `@shared/usage` import):

```ts
describe('the quota chip', () => {
  const ollama = { kind: 'ollama', enabled: true } as Endpoint
  const lmStudio = { kind: 'openai', enabled: true } as Endpoint
  const off = { ...ollama, enabled: false }

  it('shows usage whenever the ollama.com key is saved, even with no Ollama endpoint', () => {
    expect(quotaMode({ endpoints: [lmStudio], ollamaAccount: { hasKey: true } })).toBe('show')
  })

  it('offers to add a key when an Ollama endpoint is set up without one', () => {
    expect(quotaMode({ endpoints: [lmStudio, ollama], ollamaAccount: { hasKey: false } })).toBe('add-key')
  })

  it('is hidden, so nothing is polled, with neither; a switched-off Ollama endpoint counts as none', () => {
    expect(quotaMode({ endpoints: [lmStudio, off], ollamaAccount: { hasKey: false } })).toBe('hidden')
    expect(hasOllamaEndpoint([])).toBe(false)
  })
})
```

Create `tests/account.test.ts`:

```ts
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { Endpoint } from '@shared/types'
import { openDatabase } from '../src/main/db/index'
import { getAccountUsage, planEndpoint } from '../src/main/usage/account'

vi.mock('electron', () => ({ app: { getPath: () => '' }, safeStorage: { isEncryptionAvailable: () => false } }))
const state = vi.hoisted(() => ({ endpoints: [] as Endpoint[] }))
vi.mock('../src/main/settings', () => ({
  getSettings: () => ({ endpoints: state.endpoints, ollamaAccount: { hasKey: false }, usage: { anchors: {}, monthlyDay: null, poolUsd: null } }),
  getApiKey: () => null,
  updateSettings: () => undefined
}))

// A daemon without /api/me (an older Ollama, or anything else on the port): every ask is a 404.
let meHits = 0
const daemon = createServer((req, res) => {
  if (req.url === '/api/me') meHits++
  res.writeHead(404).end()
})
const at = () => `http://127.0.0.1:${(daemon.address() as AddressInfo).port}`
const endpoint = (over: Partial<Endpoint>): Endpoint => ({
  id: 'ollama',
  name: 'Ollama',
  kind: 'ollama',
  flavor: 'ollama',
  baseUrl: at(),
  enabled: true,
  hasKey: false,
  ...over
})

beforeAll(async () => {
  openDatabase(':memory:')
  await new Promise<void>((resolve) => daemon.listen(0, '127.0.0.1', resolve))
})
afterAll(() => daemon.close())

describe('the account’s plan (/api/me)', () => {
  it('asks the first enabled Ollama endpoint on this Mac, and no other', () => {
    const local = endpoint({ id: 'local', baseUrl: 'http://localhost:11434' })
    expect(
      planEndpoint([
        endpoint({ id: 'lm-studio', kind: 'openai', flavor: 'lmstudio', baseUrl: 'http://localhost:1234/v1' }),
        endpoint({ id: 'cloud', baseUrl: 'https://ollama.com' }),
        endpoint({ id: 'off', enabled: false, baseUrl: 'http://127.0.0.1:11434' }),
        endpoint({ id: 'lan', baseUrl: 'http://192.168.1.20:11434' }),
        local
      ])
    ).toBe(local)
    expect(planEndpoint([endpoint({ id: 'cloud', baseUrl: 'https://ollama.com' })])).toBeNull()
  })

  it('skips /api/me when there is no Ollama endpoint on this Mac', async () => {
    state.endpoints = [endpoint({ id: 'lm-studio', kind: 'openai', flavor: 'lmstudio', baseUrl: `${at()}/v1` })]
    expect((await getAccountUsage(true)).plan).toBeNull()
    expect(meHits).toBe(0)
  })

  it('remembers a failure for the session instead of asking on every load', async () => {
    state.endpoints = [endpoint({})]
    await getAccountUsage(true)
    await getAccountUsage(true)
    await getAccountUsage(true)
    expect(meHits).toBe(1)
  })
})
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run tests/usage.test.ts tests/account.test.ts`
Expected: FAIL with "quotaMode is not a function" and "planEndpoint is not a function".

- [ ] **Step 3: Add the quota decision to `src/shared/usage.ts`**

Add `Endpoint, Settings` to the file's `./types` import and append:

```ts
// ---- Quota chip --------------------------------------------------------------

export type QuotaMode = 'show' | 'add-key' | 'hidden'

/** Whether any enabled endpoint is an Ollama server (on this Mac, the network or ollama.com). */
export function hasOllamaEndpoint(endpoints: ReadonlyArray<Pick<Endpoint, 'kind' | 'enabled'>>): boolean {
  return endpoints.some((e) => e.kind === 'ollama' && e.enabled)
}

/**
 * What the title bar's quota chip does: with the ollama.com key saved it shows usage (polled); with no key but an
 * Ollama endpoint it offers to add one; with neither there's nothing to show, and nothing is fetched.
 */
export function quotaMode(s: Pick<Settings, 'endpoints' | 'ollamaAccount'>): QuotaMode {
  if (s.ollamaAccount.hasKey) return 'show'
  return hasOllamaEndpoint(s.endpoints) ? 'add-key' : 'hidden'
}
```

- [ ] **Step 4: Route `/api/me` in `src/main/usage/account.ts`**

Add `import type { Endpoint } from '@shared/types'` (beside `AccountUsage`) and `import { whereOf } from '../providers/where'`. Replace `let plan …` and `fetchPlan` (today lines 13-28) with:

```ts
let plan: string | null = null
/** The address /api/me last failed at: not asked again this session (a server without it would fail on every load). */
let planFailedAt: string | null = null

/** Where to ask for the plan: the first enabled Ollama endpoint on this Mac (the signed-in app), if any. */
export function planEndpoint(endpoints: readonly Endpoint[]): Endpoint | null {
  return endpoints.find((e) => e.kind === 'ollama' && e.enabled && whereOf(e.baseUrl) === 'this-mac') ?? null
}

/** The signed-in daemon knows the plan name (POST /api/me), even without an API key. */
async function fetchPlan(): Promise<string | null> {
  if (plan) return plan
  const target = planEndpoint(getSettings().endpoints)
  if (!target) return null
  const base = target.baseUrl.replace(/\/+$/, '')
  if (planFailedAt === base) return null
  try {
    const res = await fetch(`${base}/api/me`, { method: 'POST', signal: AbortSignal.timeout(5000) })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    // A signed-out daemon answers without a plan: asked again next time, since signing in needs no restart.
    plan = ((await res.json()) as { plan?: string }).plan ?? null
    return plan
  } catch {
    planFailedAt = base
    return null
  }
}
```

The memo is per address, so an endpoint moved to a new port is asked once more.

- [ ] **Step 5: Fetch prices only with an Ollama endpoint (`src/main/index.ts`)**

Add `import { hasOllamaEndpoint } from '@shared/usage'` and `import { getSettings } from './settings'`, and replace lines 210-211:

```ts
  // Keep per-token prices current (at most daily) when there's an Ollama endpoint to price; the bundled snapshot covers
  // offline starts. Settings → Usage & cost can still refresh them by hand.
  if (hasOllamaEndpoint(getSettings().endpoints)) void refreshPrices()
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run tests/usage.test.ts tests/account.test.ts`
Expected: PASS

- [ ] **Step 7: Poll by mode (`src/renderer/src/stores/usage.ts`)**

Change the imports to

```ts
import { create } from 'zustand'
import type { AccountUsage, Settings } from '@shared/types'
import { type QuotaMode, quotaMode } from '@shared/usage'
import { api } from '@/lib/api'
import { useApp } from './app'
```

and replace everything from `const POLL_MS` to the end with:

```ts
const POLL_MS = 2 * 60_000

/** Poll while visible, and re-check shortly after each reply finishes. Returns a function that stops it. */
function poll(): () => void {
  let afterReply: ReturnType<typeof setTimeout> | null = null
  void useUsage.getState().load()
  const timer = setInterval(() => {
    if (document.visibilityState === 'visible') void useUsage.getState().load(true)
  }, POLL_MS)
  const offChat = api.events.onChat((e) => {
    if (e.type !== 'done') return
    if (afterReply) clearTimeout(afterReply)
    // Ollama's counters lag a little behind the request, so wait a few seconds.
    afterReply = setTimeout(() => void useUsage.getState().load(true), 4000)
  })
  return () => {
    clearInterval(timer)
    offChat()
    if (afterReply) clearTimeout(afterReply)
  }
}

/**
 * Keep the quota chip's numbers as live as the settings call for (quotaMode): with the ollama.com key, poll; with only
 * an Ollama endpoint, read once (the plan, and the "add a key" prompt); with neither, fetch nothing. It follows settings
 * changes, so saving a key starts polling and switching off the last Ollama endpoint stops it.
 */
export function startUsagePolling(): () => void {
  let mode: QuotaMode | null = null
  let stop: (() => void) | null = null
  const apply = (settings: Settings | null) => {
    const next = settings ? quotaMode(settings) : null
    if (next === mode) return
    mode = next
    stop?.()
    stop = null
    if (next === 'show') stop = poll()
    else if (next === 'add-key') void useUsage.getState().load()
    else useUsage.setState({ account: null })
  }
  apply(useApp.getState().settings)
  const unsubscribe = useApp.subscribe((s) => apply(s.settings))
  return () => {
    unsubscribe()
    stop?.()
  }
}
```

- [ ] **Step 8: Hide the chip when there's nothing to show**

`src/renderer/src/components/UsageBar.tsx` — add `quotaMode` to the `@shared/usage` import, and in `AccountQuota` replace

```ts
  if (!settings || !withPreview(settings, previewSettings).usage.showInHeader) return null
```

with

```ts
  if (!settings || quotaMode(settings) === 'hidden' || !withPreview(settings, previewSettings).usage.showInHeader) return null
```

`src/renderer/src/components/TopBar.tsx` — replace the doc comment's second sentence:

```ts
/**
 * Draggable title bar. When the sidebar is hidden it clears the traffic lights and shows its toggle.
 * The right side carries the Ollama quota chip when there's an ollama.com key or an Ollama endpoint (quotaMode);
 * views can add their own items before it.
 */
```

- [ ] **Step 9: Typecheck, lint, test, then check it by hand**

Run: `npx prettier --write src tests && npm run typecheck && npm run lint && npm test`
Expected: PASS

Manual check (`npm run dev`, with no ollama.com key saved):
1. With the migrated Ollama endpoint on: the title bar shows the key-icon "Quota" chip; its popover offers "Add an API key".
2. Settings → Models → Ollama → switch it off (keep an LM Studio endpoint on): the chip disappears. DevTools → Network shows no `/api/usage` or `/api/me` requests after that.
3. Save an ollama.com key (Settings → Usage & cost): the chip comes back with usage, even with the Ollama endpoint still off.
4. Quit, switch off every Ollama endpoint, relaunch, and wait a minute: Settings → Usage & cost → Prices keeps its earlier "updated" date (no startup fetch of ollama.com/pricing). Its "Refresh from ollama.com" button still works.

- [ ] **Step 10: Commit**

```bash
git add src/shared/usage.ts src/main/usage/account.ts src/main/index.ts src/renderer/src/stores/usage.ts \
  src/renderer/src/components/UsageBar.tsx src/renderer/src/components/TopBar.tsx tests/usage.test.ts tests/account.test.ts
git commit -m "Quota chip, /api/me and the price fetch only when there's an ollama.com key or an Ollama endpoint

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 4.3: Traces: dialect and auth, replay routing, image redaction, anatomy, curl, labels

**Files:**
- Modify: `src/shared/types.ts:364-414` (`TraceDialect`, `TraceAuth`, `TraceDetail`)
- Modify: `src/shared/debug.ts` (whole file)
- Modify: `src/main/debug/traces.ts:1-7,51,146-172,201-206`
- Modify: `src/main/debug/replay.ts` (whole file)
- Modify: `src/main/chat/rounds.ts:188,198-207,483-491`; `src/main/chat/service.ts:733-741,804-812`
- Modify: `src/shared/ipc.ts:267-270,300`; `src/main/ipc.ts:542-543` (PR 2 Task 2.4 rewrote `debug.target` since)
- Modify: `src/renderer/src/debug/TraceView.tsx`, `src/renderer/src/debug/Anatomy.tsx`, `src/renderer/src/debug/Replay.tsx`
- Test: `tests/debug.test.ts`; `tests/service.test.ts` (PR 1's replay test passes the trace's key)

**Interfaces:**
- Consumes: `resolve(key): { provider, endpoint, model }`, `EndpointGoneError` (`endpointId`), `modelInfo(key)` (`src/main/providers/registry.ts`, PR 2); `Provider.sendWire(body, { timeoutMs })`, `Provider.wire(req, stream)`, `Provider.wireEndpoint()`, `WireRequest`, `ChatResult` (PR 1); `Trace.finish({ …, timing?: ChatTiming })` (PR 1); `requestCost(info, p, c)` (PR 2); `toModelKey` (PR 2); `EndpointKind`, `Endpoint` (PR 2).
- Produces: `TraceDialect`, `TraceAuth`, `TraceDetail.{dialect, auth, endpointId, endpointName}`; `traceTarget`, `storedTraceTarget`, `traceMessages`, `TraceMessage`, `curlKeyVar`; `promptAnatomy(body, dialect)`, `toCurl(endpoint, body, keyVar)`; `startTrace` meta `dialect/auth/endpointId/endpointName`; `replayRequest(conversationId, model, raw, endpointName?)`; IPC `debug.replay(conversationId, model, body, endpointName?)`; `debug.target` removed.

- [ ] **Step 1: Write the failing tests**

Replace `tests/debug.test.ts` with:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  curlKeyVar,
  promptAnatomy,
  redactImages,
  storedTraceTarget,
  stripImagePlaceholders,
  toCurl,
  traceMessages,
  traceTarget
} from '@shared/debug'
import type { Endpoint } from '@shared/types'
import { replayRequest } from '../src/main/debug/replay'

// replay.ts with the registry, traces, usage rows and prices stood in for: what it sends where, and what it records.
const hits = vi.hoisted(() => ({
  sent: [] as Array<{ endpoint: string; body: unknown }>,
  usage: [] as Array<Record<string, unknown>>,
  traces: [] as Array<Record<string, unknown>>
}))
vi.mock('../src/main/providers/registry', () => {
  class EndpointGoneError extends Error {
    constructor(readonly endpointId: string) {
      super(`No endpoint "${endpointId}"`)
    }
  }
  const endpoints: Record<string, Endpoint> = {
    ollama: { id: 'ollama', name: 'Ollama', kind: 'ollama', flavor: 'ollama', baseUrl: 'http://127.0.0.1:11434', enabled: true, hasKey: false },
    'lm-studio': { id: 'lm-studio', name: 'LM Studio', kind: 'openai', flavor: 'lmstudio', baseUrl: 'http://localhost:1234/v1', enabled: true, hasKey: false }
  }
  return {
    EndpointGoneError,
    resolve: (key: string) => {
      const id = key.slice(0, key.indexOf('/'))
      const endpoint = endpoints[id]
      if (!endpoint) throw new EndpointGoneError(id)
      const sendWire = async (body: unknown) => {
        hits.sent.push({ endpoint: id, body })
        return { content: 'Replayed.', thinking: '', toolCalls: [], usage: { prompt: 10, completion: 2 }, raw: { done: true } }
      }
      // Where each adapter posts its wire bodies (PR 1's wireEndpoint()).
      const wireEndpoint = () => `${endpoint.baseUrl}${endpoint.kind === 'openai' ? '/chat/completions' : '/api/chat'}`
      return { endpoint, model: key.slice(id.length + 1), provider: { id, endpoint, sendWire, wireEndpoint } }
    },
    modelInfo: async (key: string) => ({ billing: key.startsWith('lm-studio/') ? 'local' : 'priced', price: null })
  }
})
vi.mock('../src/main/debug/traces', () => ({
  startTrace: (meta: Record<string, unknown>) => {
    hits.traces.push(meta)
    return { firstByte: () => undefined, finish: (result: Record<string, unknown>) => ({ ...meta, ...result }) }
  }
}))
vi.mock('../src/main/db/usage', () => ({ insertUsageEvent: (e: Record<string, unknown>) => void hits.usage.push(e) }))
vi.mock('../src/main/usage/pricing', () => ({ requestCost: (info: { billing: string }) => (info.billing === 'priced' ? null : 0) }))

const body = {
  model: 'gpt-oss:120b-cloud',
  messages: [
    {
      role: 'system',
      content: 'You are helpful.\n\n<artifacts>' + 'a'.repeat(400) + '</artifacts>\n\n<skills>' + 'b'.repeat(80) + '</skills>'
    },
    { role: 'user', content: 'x'.repeat(40) },
    { role: 'assistant', content: 'y'.repeat(80) },
    { role: 'user', content: 'what is this?', images: ['A'.repeat(4096)] }
  ],
  tools: [{ type: 'function', function: { name: 'web_search' } }]
}

// The same request as an OpenAI-compatible server gets it.
const openaiBody = {
  model: 'qwen/qwen3-8b',
  messages: [
    body.messages[0],
    body.messages[1],
    body.messages[2],
    {
      role: 'user',
      content: [
        { type: 'text', text: 'what is this?' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,' + 'A'.repeat(4096) } }
      ]
    }
  ],
  tools: body.tools,
  stream: true,
  stream_options: { include_usage: true }
}
const parts = (m: { content: unknown }) => m.content as Array<Record<string, unknown>>

describe('debug helpers', () => {
  it('replaces image bytes with a size placeholder and can strip them for replay', () => {
    const red = redactImages(body)
    expect(red.messages[3].images).toEqual(['<image 3 KB>'])
    expect(body.messages[3].images![0]).toHaveLength(4096) // original untouched
    const { body: clean, removed } = stripImagePlaceholders(red)
    expect(removed).toBe(1)
    expect(clean.messages[3]).not.toHaveProperty('images')
  })

  it('does the same for an OpenAI image part’s data URL', () => {
    const red = redactImages(openaiBody)
    expect(parts(red.messages[3])[1]).toEqual({ type: 'image_url', image_url: { url: '<image 3 KB>' } })
    expect((parts(openaiBody.messages[3])[1].image_url as { url: string }).url).toHaveLength(4096 + 22) // original untouched
    const { body: clean, removed } = stripImagePlaceholders(red)
    expect(removed).toBe(1)
    expect(clean.messages[3].content).toEqual([{ type: 'text', text: 'what is this?' }])
  })

  it('breaks a request into system sections, history, latest turn, tools and images', () => {
    const { segments, total } = promptAnatomy(body)
    const labels = segments.map((s) => s.label)
    expect(labels).toEqual([
      'Base instructions',
      'Artifact instructions',
      'Skill index',
      'Earlier user messages',
      'Earlier assistant messages',
      'Latest message',
      'Tool definitions (1)',
      'Images (1)'
    ])
    expect(segments.find((s) => s.label === 'Images (1)')?.tokens).toBe(1600)
    expect(total).toBe(segments.reduce((n, s) => n + s.tokens, 0))
  })

  it('reads an OpenAI request’s anatomy the same as the Ollama one', () => {
    expect(promptAnatomy(redactImages(openaiBody), 'openai')).toEqual(promptAnatomy(redactImages(body)))
  })

  it('names each OpenAI tool result after the call it answers', () => {
    const [call, result] = traceMessages(
      {
        messages: [
          {
            role: 'assistant',
            content: null,
            tool_calls: [{ id: 'c00000000', type: 'function', function: { name: 'web_search', arguments: '{"query":"x"}' } }]
          },
          { role: 'tool', tool_call_id: 'c00000000', content: 'result' }
        ]
      },
      'openai'
    )
    expect(call).toMatchObject({ role: 'assistant', text: '', toolName: null })
    expect(call.toolCalls).toHaveLength(1)
    expect(result).toMatchObject({ role: 'tool', text: 'result', toolName: 'web_search' })
  })

  it('builds a non-streaming curl command without embedding a key', () => {
    const curl = toCurl('https://ollama.com/api/chat', redactImages(body), 'OLLAMA_API_KEY')
    expect(curl).toContain('Bearer $OLLAMA_API_KEY')
    expect(curl).toContain('"stream": false')
    expect(curl).toContain("1 image(s) weren't recorded")
    expect(toCurl('http://127.0.0.1:11434/api/chat', { model: 'm', messages: [] }, null)).not.toContain('Authorization')
    const openai = toCurl('http://localhost:1234/v1/chat/completions', redactImages(openaiBody), 'LM_STUDIO_API_KEY')
    expect(openai).toContain('Bearer $LM_STUDIO_API_KEY')
    expect(openai).toContain('"stream": false')
    expect(openai).not.toContain('stream_options')
    expect(openai).toContain("1 image(s) weren't recorded")
  })

  it('reads the key from an environment variable named after the endpoint', () => {
    expect(curlKeyVar({ auth: 'ollama.com', endpointId: 'ollama' })).toBe('OLLAMA_API_KEY')
    expect(curlKeyVar({ auth: 'endpoint', endpointId: 'lm-studio' })).toBe('LM_STUDIO_API_KEY')
    // A shell variable can't start with a digit.
    expect(curlKeyVar({ auth: 'endpoint', endpointId: '8080-box' })).toBe('_8080_BOX_API_KEY')
    expect(curlKeyVar({ auth: null, endpointId: 'lm-studio' })).toBeNull()
  })
})

describe('where a trace’s request went', () => {
  const e = (over: Partial<Endpoint>): Endpoint => ({
    id: 'ollama',
    name: 'Ollama',
    kind: 'ollama',
    flavor: 'ollama',
    baseUrl: 'http://127.0.0.1:11434',
    enabled: true,
    hasKey: false,
    ...over
  })

  it('records which key a request carried, never the key', () => {
    expect(traceTarget(e({}))).toEqual({ dialect: 'ollama', auth: null, endpointId: 'ollama', endpointName: 'Ollama' })
    expect(traceTarget(e({ id: 'cloud', name: 'Ollama cloud', baseUrl: 'https://ollama.com' })).auth).toBe('ollama.com')
    expect(
      traceTarget(e({ id: 'lab', name: 'Lab vLLM', kind: 'openai', flavor: 'vllm', baseUrl: 'http://10.0.0.5:8000/v1', hasKey: true }))
    ).toEqual({ dialect: 'openai', auth: 'endpoint', endpointId: 'lab', endpointName: 'Lab vLLM' })
  })

  it('reads a trace recorded before endpoints as Ollama, with the account key only for ollama.com', () => {
    expect(storedTraceTarget({ endpoint: 'http://127.0.0.1:11434/api/chat' })).toEqual({
      dialect: 'ollama',
      auth: null,
      endpointId: null,
      endpointName: null
    })
    expect(storedTraceTarget({ endpoint: 'https://ollama.com/api/chat' }).auth).toBe('ollama.com')
    const stored = { dialect: 'openai' as const, auth: null, endpointId: 'lm-studio', endpointName: 'LM Studio' }
    expect(storedTraceTarget({ endpoint: 'http://localhost:1234/v1/chat/completions', ...stored })).toEqual(stored)
  })
})

describe('replaying a recorded request', () => {
  beforeEach(() => {
    hits.sent.length = 0
    hits.usage.length = 0
    hits.traces.length = 0
  })
  const messages = [{ role: 'user', content: 'hi' }]

  it('goes to the trace’s own endpoint, once and not as a stream', async () => {
    await replayRequest(null, 'lm-studio/qwen3-8b', { model: 'qwen3-8b', messages, stream: true, stream_options: { include_usage: true } })
    expect(hits.sent).toEqual([{ endpoint: 'lm-studio', body: { model: 'qwen3-8b', messages, stream: false } }])
    expect(hits.traces[0]).toMatchObject({
      kind: 'replay',
      model: 'lm-studio/qwen3-8b',
      endpoint: 'http://localhost:1234/v1/chat/completions',
      dialect: 'openai',
      auth: null,
      endpointId: 'lm-studio',
      endpointName: 'LM Studio'
    })
    expect(hits.usage[0]).toMatchObject({ kind: 'replay', model: 'lm-studio/qwen3-8b', billing: 'local', costUsd: 0 })
  })

  it('asks the same endpoint for an edited model name, and records it under that name', async () => {
    await replayRequest(null, 'lm-studio/qwen3-8b', { model: 'gemma-3-4b', messages })
    expect(hits.sent[0].endpoint).toBe('lm-studio')
    expect(hits.usage[0]).toMatchObject({ model: 'lm-studio/gemma-3-4b', billing: 'local' })
  })

  it('says so, by name, when the trace’s endpoint has been removed', async () => {
    await expect(replayRequest(null, 'old-box/llama3', { model: 'llama3', messages }, 'Old box')).rejects.toThrow(
      "This trace's endpoint (Old box) no longer exists."
    )
    await expect(replayRequest(null, 'old-box/llama3', { model: 'llama3', messages })).rejects.toThrow(
      "This trace's endpoint (old-box) no longer exists."
    )
    expect(hits.sent).toEqual([])
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/debug.test.ts`
Expected: FAIL with "curlKeyVar is not a function" (and the replay tests with "A replay needs a JSON object with a "model" string and a "messages" array.", since today's second argument is the body).

- [ ] **Step 3: Add the trace types (`src/shared/types.ts`)**

Above `TraceSummary`, add:

```ts
/** A trace request's wire format: the endpoint kind it went to. */
export type TraceDialect = EndpointKind
/** Which key a request carried (never the key itself): the ollama.com account's, its endpoint's own, or none. */
export type TraceAuth = 'ollama.com' | 'endpoint' | null
```

and in `TraceDetail`, after `endpoint: string`, add:

```ts
  /** The wire format of `request`; a trace recorded before endpoints existed reads as 'ollama'. */
  dialect: TraceDialect
  auth: TraceAuth
  /** The endpoint the request went to, as it was named then; null for tool calls and older traces. */
  endpointId: string | null
  endpointName: string | null
```

Also change the `TraceTiming` comments "Time until Ollama's first response byte" → "Time until the server's first response byte" and "Ollama's own durations (from the final chunk)" → "The server's own durations, when it reports them".

- [ ] **Step 4: Rewrite `src/shared/debug.ts`**

```ts
// Pure helpers for the debugger window: redaction, prompt anatomy and curl export, for both wire formats.
import type { Endpoint, TraceAuth, TraceDetail, TraceDialect } from './types'

const IMAGE_PLACEHOLDER = /^<image [\d.]+ KB>$/
const ON_OLLAMA_COM = /^https:\/\/ollama\.com(\/|$)/

/** A size placeholder for base64 image data this many characters long. */
const placeholder = (base64Chars: number) => `<image ${((base64Chars * 3) / 4 / 1024).toFixed(0)} KB>`

/** Deep-copy a request body, replacing base64 images (Ollama's `images`, OpenAI's `image_url` data URLs) with a size placeholder. */
export function redactImages<T>(body: T): T {
  return JSON.parse(
    JSON.stringify(body, (key, value) => {
      if (key === 'images' && Array.isArray(value)) return value.map((img) => (typeof img === 'string' ? placeholder(img.length) : img))
      if (key === 'image_url' && typeof value?.url === 'string' && value.url.startsWith('data:'))
        return { ...value, url: placeholder(value.url.length - value.url.indexOf(',') - 1) }
      return value
    })
  ) as T
}

const isPlaceholderPart = (part: unknown): boolean => {
  const p = part as { type?: unknown; image_url?: { url?: unknown } } | null
  return p?.type === 'image_url' && typeof p.image_url?.url === 'string' && IMAGE_PLACEHOLDER.test(p.image_url.url)
}

/** Drop redacted image placeholders so a recorded request can be replayed. */
export function stripImagePlaceholders<T>(body: T): { body: T; removed: number } {
  let removed = 0
  const clean = JSON.parse(
    JSON.stringify(body, (key, value) => {
      if (key === 'images' && Array.isArray(value)) {
        const kept = value.filter((img) => !(typeof img === 'string' && IMAGE_PLACEHOLDER.test(img)))
        removed += value.length - kept.length
        return kept.length ? kept : undefined
      }
      if (key === 'content' && Array.isArray(value)) {
        const kept = value.filter((part) => !isPlaceholderPart(part))
        removed += value.length - kept.length
        return kept
      }
      return value
    })
  ) as T
  return { body: clean, removed }
}

export interface TraceTarget {
  dialect: TraceDialect
  auth: TraceAuth
  endpointId: string
  endpointName: string
}

/** What a trace records about where its request went: the wire format, which key it carried (never the key), the endpoint. */
export function traceTarget(endpoint: Pick<Endpoint, 'id' | 'name' | 'kind' | 'baseUrl' | 'hasKey'>): TraceTarget {
  const onOllamaCom = endpoint.kind === 'ollama' && ON_OLLAMA_COM.test(endpoint.baseUrl)
  return {
    dialect: endpoint.kind,
    auth: onOllamaCom ? 'ollama.com' : endpoint.hasKey ? 'endpoint' : null,
    endpointId: endpoint.id,
    endpointName: endpoint.name
  }
}

/** A stored trace's target. Traces recorded before endpoints have none and read as Ollama's. */
export function storedTraceTarget(data: {
  endpoint?: string
  dialect?: TraceDialect
  auth?: TraceAuth
  endpointId?: string | null
  endpointName?: string | null
}): Pick<TraceDetail, 'dialect' | 'auth' | 'endpointId' | 'endpointName'> {
  return {
    dialect: data.dialect ?? 'ollama',
    // Before endpoints, only a request to ollama.com carried a key: the account's.
    auth: data.auth !== undefined ? data.auth : ON_OLLAMA_COM.test(data.endpoint ?? '') ? 'ollama.com' : null,
    endpointId: data.endpointId ?? null,
    endpointName: data.endpointName ?? null
  }
}

/** One message of a recorded request, read the same way whichever wire format it used. */
export interface TraceMessage {
  role: string
  text: string
  thinking: string
  /** Image placeholders (or, unredacted, the data). */
  images: string[]
  toolCalls: unknown[] | null
  /** For a tool result: the tool it answers. */
  toolName: string | null
}

export function traceMessages(body: { messages?: unknown[] }, dialect: TraceDialect): TraceMessage[] {
  // OpenAI tool results carry the call's id; the name comes from the assistant message that made the call.
  const callNames = new Map<string, string>()
  return (body.messages ?? []).map((raw) => {
    const m = (raw ?? {}) as Record<string, unknown>
    const toolCalls = Array.isArray(m.tool_calls) && m.tool_calls.length ? (m.tool_calls as unknown[]) : null
    const role = String(m.role ?? 'other')
    if (dialect === 'openai') {
      for (const c of toolCalls ?? []) {
        const call = c as { id?: unknown; function?: { name?: unknown } }
        if (typeof call.id === 'string' && typeof call.function?.name === 'string') callNames.set(call.id, call.function.name)
      }
      const parts = Array.isArray(m.content) ? (m.content as Array<Record<string, unknown>>) : null
      return {
        role,
        text: parts
          ? parts
              .filter((p) => p?.type === 'text')
              .map((p) => String(p.text ?? ''))
              .join('\n')
          : typeof m.content === 'string'
            ? m.content
            : '',
        thinking: '',
        images: parts ? parts.filter((p) => p?.type === 'image_url').map((p) => String((p.image_url as { url?: unknown })?.url ?? '')) : [],
        toolCalls,
        toolName: typeof m.tool_call_id === 'string' ? (callNames.get(m.tool_call_id) ?? m.tool_call_id) : null
      }
    }
    return {
      role,
      text: typeof m.content === 'string' ? m.content : '',
      thinking: typeof m.thinking === 'string' ? m.thinking : '',
      images: Array.isArray(m.images) ? m.images.map(String) : [],
      toolCalls,
      toolName: typeof m.tool_name === 'string' ? m.tool_name : null
    }
  })
}

const estimate = (text: string) => Math.ceil(text.length / 4)
const IMAGE_TOKENS = 1600

export interface AnatomySegment {
  label: string
  group: 'system' | 'history' | 'latest' | 'tools' | 'images'
  tokens: number
}

const SECTION_LABELS: Record<string, string> = {
  user_preferences: 'Your preferences',
  project: 'Project instructions',
  project_knowledge: 'Project knowledge',
  artifacts: 'Artifact instructions',
  web: 'Web tool guidance',
  skills: 'Skill index',
  loaded_skills: 'Loaded skills',
  selected_skills: 'Selected skills'
}

interface BodyLike {
  messages?: unknown[]
  tools?: unknown[]
}

/**
 * Where a request's tokens go, estimated at ~4 characters per token (the same heuristic Ollmost uses
 * for trimming history). Compare the total with the server's prompt token count for the real number.
 */
export function promptAnatomy(body: BodyLike, dialect: TraceDialect = 'ollama'): { segments: AnatomySegment[]; total: number } {
  const segments: AnatomySegment[] = []
  const messages = traceMessages(body, dialect)
  const system = messages.find((m) => m.role === 'system')?.text ?? ''
  let rest = system
  for (const m of system.matchAll(/<([a-z_]+)(?:\s[^>]*)?>[\s\S]*?<\/\1>/g)) {
    segments.push({ label: SECTION_LABELS[m[1]] ?? `<${m[1]}>`, group: 'system', tokens: estimate(m[0]) })
    rest = rest.replace(m[0], '')
  }
  if (rest.trim()) segments.unshift({ label: 'Base instructions', group: 'system', tokens: estimate(rest) })

  const convo = messages.filter((m) => m.role !== 'system')
  const lastUser = convo.map((m) => m.role).lastIndexOf('user')
  const byRole = new Map<string, number>()
  let latest = 0
  let latestHasTools = false
  let images = 0
  convo.forEach((m, i) => {
    const t = estimate(m.text + m.thinking + (m.toolCalls ? JSON.stringify(m.toolCalls) : ''))
    images += m.images.length
    if (i >= lastUser && lastUser >= 0) {
      latest += t
      if (m.role === 'tool') latestHasTools = true
    } else byRole.set(m.role, (byRole.get(m.role) ?? 0) + t)
  })
  for (const [role, tokens] of byRole)
    segments.push({ label: role === 'tool' ? 'Earlier tool results' : `Earlier ${role} messages`, group: 'history', tokens })
  if (lastUser >= 0)
    segments.push({ label: latestHasTools ? 'Latest message + tool results' : 'Latest message', group: 'latest', tokens: latest })
  if (body.tools?.length)
    segments.push({ label: `Tool definitions (${body.tools.length})`, group: 'tools', tokens: estimate(JSON.stringify(body.tools)) })
  if (images) segments.push({ label: `Images (${images})`, group: 'images', tokens: images * IMAGE_TOKENS })

  const kept = segments.filter((s) => s.tokens > 0)
  return { segments: kept, total: kept.reduce((n, s) => n + s.tokens, 0) }
}

/**
 * The environment variable Copy as curl reads a key from: $OLLAMA_API_KEY for ollama.com, $<ENDPOINT_ID>_API_KEY for
 * an endpoint's own key (upper case, '-' as '_', and a leading '_' when the id starts with a digit, which a shell
 * variable can't).
 */
export function curlKeyVar(t: Pick<TraceDetail, 'auth' | 'endpointId'>): string | null {
  if (t.auth === 'ollama.com') return 'OLLAMA_API_KEY'
  if (t.auth !== 'endpoint') return null
  const id = (t.endpointId ?? 'endpoint').toUpperCase().replace(/-/g, '_')
  return `${/^\d/.test(id) ? '_' : ''}${id}_API_KEY`
}

/** A curl command that reproduces the request (non-streaming). The API key is never embedded. */
export function toCurl(endpoint: string, body: unknown, keyVar: string | null): string {
  const { body: clean, removed } = stripImagePlaceholders(body)
  // One request, not a stream: stream_options is only allowed with a stream.
  const { stream_options: _options, ...rest } = (clean ?? {}) as Record<string, unknown>
  const payload = JSON.stringify({ ...rest, stream: false }, null, 2)
  const auth = keyVar ? ` \\\n  -H "Authorization: Bearer $${keyVar}"` : ''
  const note = removed ? `# ${removed} image(s) weren't recorded and are left out.\n` : ''
  return `${note}curl ${endpoint} \\\n  -H 'Content-Type: application/json'${auth} \\\n  -d @- <<'JSON'\n${payload}\nJSON`
}
```

- [ ] **Step 5: Store the target on each trace (`src/main/debug/traces.ts`)**

Change the imports to

```ts
import { redactImages, storedTraceTarget } from '@shared/debug'
import type { TraceAuth, TraceDetail, TraceDialect, TraceKind, TraceStatus, TraceSummary, TraceTiming } from '@shared/types'
```

Change `Data` (line 51) to

```ts
type Data = Pick<TraceDetail, 'endpoint' | 'request' | 'response' | 'timing' | 'dialect' | 'auth' | 'endpointId' | 'endpointName'>
```

In `startTrace`, add to the `meta` parameter type (after `summary: string`):

```ts
  /** Where a model request went (spread traceTarget(endpoint) here); the key itself is never stored. */
  dialect?: TraceDialect
  auth?: TraceAuth
  endpointId?: string
  endpointName?: string
```

and build `data` as

```ts
  const data: Data = {
    endpoint: meta.endpoint,
    // A tool call has no target: it reads as Ollama's, with the account key only for ollama.com (the web tools).
    ...storedTraceTarget(meta),
    request: redactImages(meta.request),
    response: {},
    timing: { ttfbMs: null, firstTokenMs: null, totalMs: null, loadMs: null, promptEvalMs: null, evalMs: null }
  }
```

Replace `getTrace` with

```ts
export function getTrace(id: string): TraceDetail | null {
  const row = get<Row>('SELECT * FROM traces WHERE id = ?', id)
  if (!row) return null
  const data = parseJson<Partial<Data>>(row.data, {})
  return {
    ...toSummary(row),
    endpoint: data.endpoint ?? '',
    request: data.request ?? null,
    response: data.response ?? {},
    timing: data.timing ?? ({} as TraceTiming),
    // Traces recorded before endpoints have no dialect or auth, and read as Ollama's.
    ...storedTraceTarget(data)
  }
}
```

- [ ] **Step 6: Rewrite `src/main/debug/replay.ts`**

```ts
import { stripImagePlaceholders, traceTarget } from '@shared/debug'
import { toModelKey } from '@shared/modelKey'
import type { ModelInfo, TraceDetail } from '@shared/types'
import { insertUsageEvent } from '../db/usage'
import { EndpointGoneError, modelInfo, resolve } from '../providers/registry'
import { requestCost } from '../usage/pricing'
import { errorMessage } from '../util'
import { startTrace } from './traces'

interface ReplayBody extends Record<string, unknown> {
  model: string
  messages: unknown[]
}

/** The response's stats without the reply itself, which the trace shows on its own. */
function statsOf(raw: unknown): unknown {
  if (!raw || typeof raw !== 'object') return raw
  const { message: _message, choices, ...rest } = raw as Record<string, unknown>
  const finish = Array.isArray(choices) ? (choices[0] as { finish_reason?: unknown } | undefined)?.finish_reason : undefined
  return finish === undefined ? rest : { ...rest, finish_reason: finish }
}

/** Billing for the replayed model, else the trace's own (an edited name may not exist); untracked when neither reads. */
async function billingFor(keys: string[]): Promise<Pick<ModelInfo, 'billing' | 'price'>> {
  for (const key of new Set(keys)) {
    try {
      return await modelInfo(key)
    } catch {
      // Try the next.
    }
  }
  return { billing: 'untracked', price: null }
}

/**
 * Re-send a (possibly edited) recorded request, non-streaming, to the endpoint the trace went to. `model` is the trace's
 * model key, which names that endpoint; the body's own `model` (maybe edited) is what the endpoint is asked for.
 * `endpointName` is the endpoint's name when the trace was recorded, for the message if it has since been removed.
 * Nothing is added to the chat; the call is recorded as a 'replay' trace and counted as usage.
 */
export async function replayRequest(
  conversationId: string | null,
  model: string | null,
  raw: unknown,
  endpointName?: string | null
): Promise<TraceDetail> {
  if (!raw || typeof raw !== 'object' || typeof (raw as ReplayBody).model !== 'string' || !Array.isArray((raw as ReplayBody).messages))
    throw new Error('A replay needs a JSON object with a "model" string and a "messages" array.')
  // One request, not a stream: a streamed round's body carries stream, and stream_options, which only a stream allows.
  const { stream: _stream, stream_options: _options, ...edited } = stripImagePlaceholders(raw as ReplayBody).body
  const request = { ...edited, stream: false }
  let target: ReturnType<typeof resolve>
  try {
    // A trace with no model key resolves by its body's name, the way any leftover name does.
    target = resolve(model ?? request.model)
  } catch (err) {
    if (err instanceof EndpointGoneError) throw new Error(`This trace's endpoint (${endpointName || err.endpointId}) no longer exists.`)
    throw err
  }
  const { provider, endpoint } = target
  const key = toModelKey(endpoint.id, request.model)
  const trace = startTrace({
    kind: 'replay',
    conversationId,
    messageId: null,
    model: key,
    // Where the provider posts its bodies, as a round's trace records it.
    endpoint: provider.wireEndpoint(),
    request,
    summary: 'Replay…',
    ...traceTarget(endpoint)
  })
  try {
    const res = await provider.sendWire(request, { timeoutMs: 10 * 60_000 })
    trace.firstByte()
    const promptTokens = res.usage.prompt ?? 0
    const completionTokens = res.usage.completion ?? 0
    const info = await billingFor([key, model ?? key])
    const costUsd = requestCost(info, promptTokens, completionTokens)
    insertUsageEvent({
      conversationId,
      messageId: null,
      model: key,
      kind: 'replay',
      billing: info.billing,
      promptTokens,
      completionTokens,
      costUsd,
      estimated: false
    })
    return trace.finish({
      status: 'ok',
      response: {
        content: res.content,
        thinking: res.thinking || undefined,
        toolCalls: res.toolCalls.length ? res.toolCalls : undefined,
        final: statsOf(res.raw)
      },
      promptTokens,
      completionTokens,
      costUsd,
      summary: `Replay: ${res.content.trim() || (res.toolCalls.length ? 'tool call' : '(empty)')}`,
      timing: res.timing
    })
  } catch (err) {
    const error = errorMessage(err)
    trace.finish({ status: 'error', response: { error }, summary: `Replay failed: ${error}` })
    throw err
  }
}
```

- [ ] **Step 7: Record the target on every model request, and log wire bodies with images elided**

In `src/main/chat/rounds.ts`, add `import { redactImages, traceTarget } from '@shared/debug'` and `type WireRequest` to the `../providers/types` import. PR 1 (Task 1.6) already computes the round's wire request once, right before the log and the trace:

```ts
      const wire = provider.wire(body, true)
      debugLog(wire.body)
```

The second line becomes `debugLog(wire)`. Add as the last property of the round's `startTrace({ … })` object (after PR 1's `summary: 'Streaming…'`):

```ts
        ...traceTarget(provider.endpoint)
```

Replace PR 1's `debugLog(body: unknown)` (with its doc comment; lines 483-491 on `main` @ 24f4623, before PR 1) with:

```ts
/** With OLLMOST_DEBUG=1, append each request as sent (images elided) to <userData>/debug.log. */
function debugLog(wire: WireRequest): void {
  if (!process.env.OLLMOST_DEBUG) return
  appendFileSync(join(paths.data, 'debug.log'), `${new Date().toISOString()} ${wire.endpoint} ${JSON.stringify(redactImages(wire.body))}\n`)
}
```

In `src/main/chat/service.ts`, add `import { traceTarget } from '@shared/debug'`, and add `...traceTarget(provider.endpoint)` as the last property of the `startTrace({ … })` objects in `summarizeOnce` (kind `'compact'`; `provider` is its parameter since PR 1) and `generateTitle` (kind `'title'`; `provider` is what its `resolve(modelName)` returned).

Tool traces (`kind: 'tool'`) get no target.

- [ ] **Step 8: Route the replay IPC and drop `debug.target`**

`src/shared/ipc.ts` — replace the `replay` and `target` entries of `debug` (lines 267-270) with:

```ts
    /**
     * Re-send an edited request (non-streaming) to the endpoint the trace went to: `model` is the trace's model key, and
     * `endpointName` the endpoint's name when recorded (for the message when it's gone). Recorded as a 'replay' trace;
     * nothing is added to the chat.
     */
    replay(conversationId: ID | null, model: string | null, body: unknown, endpointName?: string | null): Promise<TraceDetail>
```

and remove `'target'` from `INVOKE_CHANNELS.debug` (line 300).

`src/main/ipc.ts` — replace the `replay` and `target` handlers (lines 542-543) with:

```ts
    replay: (conversationId, model, body, endpointName) => replayRequest(conversationId, model, body, endpointName),
```

Remove any import that only `target` used (lint reports it).

`tests/service.test.ts` — PR 1's `describe('replay')` test (Task 1.7) calls `replayRequest(c.id, { … })`; it now passes
the trace's model key second, as the debugger does:

```ts
      const detail = await replayRequest(c.id, 'ollama/llama3.2', {
        model: 'llama3.2',
        messages: [{ role: 'user', content: 'replay me', images: ['<image 3 KB>'] }],
        stream: true
      })
```

Its expectations stay: the body reaches the mock as recorded, less the image placeholder and not streamed, and the
trace's `endpoint` is `${ollama.url}/api/chat` (the provider's `wireEndpoint()`).

- [ ] **Step 9: Run the tests to verify they pass**

Run: `npx vitest run tests/debug.test.ts tests/service.test.ts`
Expected: PASS

- [ ] **Step 10: The debugger's views**

`src/renderer/src/debug/Replay.tsx`:

```ts
function editable(request: unknown): string {
  // A replay is one request, not a stream: the stream fields would only be dropped again.
  const { stream: _stream, stream_options: _options, ...rest } = (request ?? {}) as Record<string, unknown>
  return JSON.stringify(rest, null, 2)
}
```

in `run`: `setResult(await api.debug.replay(conversationId, trace.model, JSON.parse(text), trace.endpointName))`, and the hint:

```tsx
            `Sent without streaming to ${trace.endpointName ?? 'the endpoint it was recorded from'}. It costs tokens like any request and is recorded as a replay; images that weren’t recorded are left out.`
```

`src/renderer/src/debug/TraceView.tsx`:
1. Imports: `import { curlKeyVar, promptAnatomy, toCurl } from '@shared/debug'`; remove `import { api } from '@/lib/api'` (only `target` used it).
2. Replace the local `ChatRequest` interface with:

```ts
interface ChatRequest {
  model?: string
  messages?: unknown[]
  tools?: Array<{ function?: { name?: string; description?: string; parameters?: unknown } }>
  // Ollama
  think?: unknown
  options?: { num_ctx?: number } & Record<string, unknown>
  // OpenAI-compatible
  reasoning_effort?: unknown
  chat_template_kwargs?: unknown
  temperature?: unknown
}
```

3. Replace `const ollamaMs = …` (and its comment) with, after `perSecond`:

```ts
/** The server's own durations, only those it reported: cloud models and most OpenAI-compatible servers send none. */
function serverTiming(trace: TraceDetail): Array<[string, ReactNode]> {
  const t = trace.timing
  const rows: Array<[string, ReactNode]> = []
  if (t.loadMs != null) rows.push(['Server: model load', ms(t.loadMs)])
  if (t.promptEvalMs != null)
    rows.push(['Server: prompt processing', `${ms(t.promptEvalMs)} · ${perSecond(trace.promptTokens, t.promptEvalMs)}`])
  if (t.evalMs != null) rows.push(['Server: generation', `${ms(t.evalMs)} · ${perSecond(trace.completionTokens, t.evalMs)}`])
  return rows.length ? rows : [['Server timing', 'not reported by this server']]
}
```

4. In `TraceView`, delete the `target` state and the `useEffect` that calls `api.debug.target()`. Replace the `anatomy` line with

```ts
  const anatomy = useMemo(() => (isModelCall ? promptAnatomy(request, trace.dialect) : null), [isModelCall, request, trace.dialect])
```

and replace the `curl` and `final` lines with

```ts
  const curl = isModelCall ? toCurl(trace.endpoint, trace.request, curlKeyVar(trace)) : ''
  const final = (trace.response.final ?? {}) as Record<string, unknown>
  // What the request asked of the model, in its own dialect's fields.
  const settingsRows: Array<[string, ReactNode]> =
    trace.dialect === 'openai'
      ? [
          ['Reasoning', JSON.stringify(request.reasoning_effort ?? request.chat_template_kwargs ?? null)],
          ['temperature', JSON.stringify(request.temperature ?? null)]
        ]
      : [
          ['think', JSON.stringify(request.think ?? null)],
          ['options', JSON.stringify(request.options ?? null)]
        ]
```

5. Header: after the model `<span>`, add `{trace.endpointName && <span className="text-xs text-subtle">{trace.endpointName}</span>}`.
6. "Request" grid rows: `['Model', request.model ?? '—'], ...settingsRows, ['Messages', …], ['Tools offered', …]` (the two `think`/`options` rows go).
7. "Timing" grid rows: `['Time to first byte', …], ['Time to first token', …], ['Total', …], ...serverTiming(trace)` (the three "Ollama: …" rows go).
8. "Tokens & cost": replace `['done_reason', String(final.done_reason ?? '—')]` with `['Finish reason', String(final.done_reason ?? final.finish_reason ?? '—')]`.
9. `<Anatomy request={request} dialect={trace.dialect} anatomy={anatomy} actualTokens={trace.promptTokens} model={trace.model} />`
10. Response tab: section title `"Final chunk (stats)"` → `"Response stats"`.

`src/renderer/src/debug/Anatomy.tsx`:
1. Imports: `import { useEffect, useMemo, useState } from 'react'`, `import { type AnatomySegment, type TraceMessage, traceMessages } from '@shared/debug'`, `import type { TraceDialect } from '@shared/types'`.
2. `interface Req { options?: { num_ctx?: number } & Record<string, unknown>; messages?: unknown[] }`.
3. Props gain `dialect: TraceDialect` (destructured beside `request`).
4. Replace the context lookup:

```ts
  // Ollama's local requests carry the num_ctx they used; anything else uses the window the model gets now.
  const numCtx = request.options?.num_ctx ?? null
  const [modelContext, setModelContext] = useState<number | null>(null)
  useEffect(() => {
    if (model && numCtx === null)
      void api.models.info(model).then(
        (m) => setModelContext(m.contextWindow ?? m.contextLength),
        () => setModelContext(null)
      )
  }, [model, numCtx])
  const messages = useMemo(() => traceMessages(request, dialect), [request, dialect])
```

5. `` ` · ${actualTokens.toLocaleString()} counted by Ollama` `` → `` ` · ${actualTokens.toLocaleString()} counted by the server` ``.
6. Messages section: `Messages ({messages.length})` and `{messages.map((m, i) => <MessageRow key={i} index={i} message={m} />)}`.
7. `MessageRow({ index, message: m }: { index: number; message: TraceMessage })`, reading `m.text` for `text`, `m.thinking`, `m.toolName` (label suffix), `m.toolCalls`, `m.images`:

```tsx
function MessageRow({ index, message: m }: { index: number; message: TraceMessage }) {
  const [open, setOpen] = useState(index === 0 ? false : !!m.text && m.text.length < 400)
  const tokens = Math.ceil((m.text.length + m.thinking.length) / 4)
  return (
    <div className="rounded-ollmost border border-line">
      <button onClick={() => setOpen((o) => !o)} className="flex w-full items-center gap-2 px-3 py-2 text-left text-[13px]">
        <ChevronRight className={cn('size-3.5 shrink-0 text-subtle transition-transform', open && 'rotate-90')} />
        <span className={cn('rounded px-1.5 py-px font-mono text-[11px]', ROLE_STYLE[m.role] ?? 'bg-hover')}>
          {m.role}
          {m.toolName ? `:${m.toolName}` : ''}
        </span>
        <span className="min-w-0 flex-1 truncate text-muted">
          {m.text.replace(/\s+/g, ' ').slice(0, 160) || (m.toolCalls ? '(tool call)' : '(empty)')}
        </span>
        {m.images.length ? <span className="shrink-0 text-xs text-subtle">{m.images.length} image(s)</span> : null}
        <span className="shrink-0 font-mono text-[11px] tabular-nums text-subtle">≈{formatTokens(tokens)}</span>
      </button>
      {open && (
        <div className="space-y-2 border-t border-line px-3 py-2">
          {m.thinking && <pre className="selectable whitespace-pre-wrap font-mono text-[12px] text-subtle">{m.thinking}</pre>}
          {m.text && (
            <pre className="selectable max-h-[520px] overflow-auto whitespace-pre-wrap font-mono text-[12px] leading-relaxed">{m.text}</pre>
          )}
          {m.toolCalls && <JsonBlock value={m.toolCalls} />}
          {m.images.length ? <div className="text-xs text-subtle">{m.images.join(', ')}</div> : null}
        </div>
      )}
    </div>
  )
}
```

- [ ] **Step 11: Typecheck, lint, test, then check it by hand**

Run: `npx prettier --write src tests && npm run typecheck && npm run lint && npm test`
Expected: PASS

Manual check (`npm run dev`, with an LM Studio endpoint added and a model loaded):
1. Send a message with an image to a vision model on LM Studio; open the debugger. The header shows the model and "LM Studio". Overview → "Reasoning" and "temperature" rows; Timing shows "Server timing: not reported by this server" (or the three "Server: …" rows on llama.cpp).
2. Prompt anatomy: same sections as for an Ollama request; "Images (1)"; the image message lists `<image N KB>`.
3. Request tab: the `image_url` shows `<image N KB>`, never base64. "Copy as curl" gives `POST …/v1/chat/completions` with `"stream": false`, no `stream_options`, and a `$LM_STUDIO_API_KEY` header only if the endpoint has a key.
4. Replay → Send: the result comes back from LM Studio; a new "replay" trace lists under the same model.
5. Remove the endpoint in Settings (the dialog says what goes), then Replay that trace again: "This trace's endpoint (LM Studio) no longer exists."
6. An older trace from before this PR (an Ollama chat) still opens, with "think"/"options" rows and working curl.

- [ ] **Step 12: Commit**

```bash
git add src/shared/types.ts src/shared/debug.ts src/main/debug/traces.ts src/main/debug/replay.ts src/main/chat/rounds.ts \
  src/main/chat/service.ts src/shared/ipc.ts src/main/ipc.ts src/renderer/src/debug/TraceView.tsx src/renderer/src/debug/Anatomy.tsx \
  src/renderer/src/debug/Replay.tsx tests/debug.test.ts tests/service.test.ts
git commit -m "Traces record their dialect and endpoint: replay goes back to it, and the debugger reads OpenAI requests too

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 4.4: Wording, palette, README; PR

**Files:**
- Modify: `src/shared/palette.ts` (append)
- Modify: `src/renderer/src/lib/paletteCommands.ts:5,43-51,83-89`; `src/renderer/src/stores/app.ts:19`
- Modify: `src/renderer/src/views/HomeView.tsx:12,26-42`
- Modify: `src/renderer/src/lib/codeActions.ts:12`
- Modify: `src/renderer/src/views/SettingsView.tsx:839-857` (the web toggle's hint)
- Modify: `README.md:5,15,38,52-64,125-143,193-224`
- Test: `tests/palette.test.ts`

`src/main/chat/prompts.ts:16` stays as it is: it points at "Settings → Usage & cost", where the key field still is, and doesn't name the connection.

**Interfaces:**
- Consumes: `rankCommands`, `Rankable` (`src/shared/palette.ts`); `modelErrors: ModelListResult['errors']` in the renderer store (PR 2); `Settings.ollamaAccount.hasKey` (PR 2).
- Produces: `SettingsTabId`, `SETTINGS_TABS`, `settingsTabCommands()`.

- [ ] **Step 1: Write the failing test**

Append to `tests/palette.test.ts` (import `settingsTabCommands` beside `matchScore, rankCommands`):

```ts
describe('settings tabs in the palette', () => {
  it('sends connections, endpoints and model servers to the Models tab', () => {
    for (const query of ['connection', 'endpoint', 'lm studio', 'vllm', 'llama.cpp', 'ollama'])
      expect(rankCommands(query, settingsTabCommands(), [])[0]?.tab, query).toBe('models')
  })

  it('keeps your name and preferences on General', () => {
    expect(rankCommands('name', settingsTabCommands(), [])[0]?.tab).toBe('general')
  })
})
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/palette.test.ts`
Expected: FAIL with "settingsTabCommands is not a function"

- [ ] **Step 3: Move the tab keywords into `src/shared/palette.ts`**

Append:

```ts
export type SettingsTabId = 'general' | 'appearance' | 'models' | 'usage' | 'features' | 'tools' | 'data'

/** The Settings tabs as the palette offers them, and the words each answers to: a server's name finds Models. */
export const SETTINGS_TABS: ReadonlyArray<{ id: SettingsTabId; label: string; keywords: string[] }> = [
  { id: 'general', label: 'General', keywords: ['name', 'preferences'] },
  { id: 'appearance', label: 'Appearance', keywords: ['theme', 'font', 'dark', 'light', 'width'] },
  {
    id: 'models',
    label: 'Models',
    keywords: ['default model', 'context', 'catalog', 'connection', 'endpoint', 'ollama', 'lm studio', 'vllm', 'llama.cpp']
  },
  { id: 'usage', label: 'Usage & cost', keywords: ['quota', 'spend', 'tokens', 'api key'] },
  { id: 'features', label: 'Features', keywords: ['artifacts', 'web', 'links', 'skills'] },
  { id: 'tools', label: 'Tools', keywords: ['mcp', 'code runner', 'code sessions', 'sandbox'] },
  { id: 'data', label: 'Data', keywords: ['export', 'folder', 'debug'] }
]

/** The palette's "Settings › …" commands, one per tab. */
export function settingsTabCommands(): Array<Rankable & { tab: SettingsTabId }> {
  return SETTINGS_TABS.map((t) => ({
    id: `settings-${t.id}`,
    title: `Settings › ${t.label}`,
    keywords: ['settings', 'preferences', ...t.keywords],
    tab: t.id
  }))
}
```

`src/renderer/src/stores/app.ts:19` — replace the union with `export type SettingsTab = SettingsTabId` and add `import type { SettingsTabId } from '@shared/palette'`.

`src/renderer/src/lib/paletteCommands.ts` — delete the local `SETTINGS_TABS` (lines 43-51), import `settingsTabCommands` from `@shared/palette` (beside `Rankable`), drop `type SettingsTab` from the `@/stores/app` import, and replace the `...SETTINGS_TABS.map(…)` entry with:

```ts
    ...settingsTabCommands().map(({ tab, ...c }): PaletteCommand => ({ ...c, group: 'Go to', run: go({ name: 'settings', tab }) }))
```

- [ ] **Step 4: Run it to verify it passes**

Run: `npx vitest run tests/palette.test.ts`
Expected: PASS

- [ ] **Step 5: Home, the code-session error, and the web toggle**

`src/renderer/src/views/HomeView.tsx` — it already takes `modelErrors` from `useApp()` (PR 2, Task 2.7). Replace the text column of the no-models card (the `<div className="flex-1">…</div>`, lines 29-32 on `main`; PR 2 changed its error line) with:

```tsx
              <div className="flex-1">
                <div className="font-medium">
                  {modelErrors.length ? "Couldn't load models from any endpoint" : "Ollmost can't find any models."}
                </div>
                {modelErrors.length ? (
                  // Each message already names its endpoint and address.
                  <ul className="mt-1 space-y-0.5 text-muted">
                    {modelErrors.map((e) => (
                      <li key={e.endpointId} className="selectable">
                        {e.message}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <div className="mt-1 text-muted">None of your endpoints has a model yet. Add one, or add another endpoint in Settings → Models.</div>
                )}
              </div>
```

The Retry and Settings buttons beside it stay (Settings opens the Models tab).

`src/renderer/src/lib/codeActions.ts:12`:

```ts
    if (!draftModel) throw new Error('No model to start a session with. Check that a model server is running.')
```

`src/renderer/src/views/SettingsView.tsx` — the web toggle's `hint` (lines 841-855):

```tsx
          hint={
            <>
              Goes through ollama.com, for every model, including local ones.{' '}
              {settings.ollamaAccount.hasKey ? (
                'Uses your saved ollama.com API key.'
              ) : (
                <>
                  Needs an ollama.com API key.{' '}
                  <button
                    className="text-accent hover:underline"
                    onClick={() => useApp.getState().navigate({ name: 'settings', tab: 'usage' })}
                  >
                    Add one in Usage & cost
                  </button>
                </>
              )}
            </>
          }
```

- [ ] **Step 6: README**

Line 5, replace "running on your Ollama models (cloud and local)." with "running on your Ollama models (cloud and local) and on OpenAI-compatible servers such as LM Studio, llama.cpp and vLLM."

Line 15, replace "You'll also need the [Ollama app](https://ollama.com) running; for cloud models, run `ollama signin` once." with "You'll also need a model server: the [Ollama app](https://ollama.com) (for its cloud models, run `ollama signin` once), or an OpenAI-compatible server such as [LM Studio](https://lmstudio.ai). See [Model endpoints](#model-endpoints)."

Line 38:

```md
Requirements: macOS, Node 22+, and the [Ollama app](https://ollama.com), or an OpenAI-compatible server (see [Model endpoints](#model-endpoints)). For Ollama cloud models, run `ollama signin` once.
```

Insert before `## How it works`:

```md
## Model endpoints

Ollmost talks to Ollama natively, and to any server that speaks the OpenAI chat-completions API. The ones it's tested with run on your Mac: [LM Studio](https://lmstudio.ai) (start its server in the Developer tab), llama.cpp's `llama-server`, and vLLM. You can set up several at once in Settings → Models. Every model from every endpoint is in one picker (the chips under its search box filter by endpoint), and each chat remembers which endpoint its model is on, so you can switch a chat from one to another.

- **Adding one.** Settings → Models → + Add endpoint. Type the address (presets: Ollama `:11434`, LM Studio `:1234`, llama.cpp `:8080`, vLLM `:8000`), a key if the server needs one, then Check. Ollmost works out what kind of server it is and what its models can do, and says so before you Add it.
- **What works with every endpoint.** Web search and page reading (they go through ollama.com with your ollama.com key, for every model, including local ones), MCP servers, the code runner, skills, code sessions and sub-agents, with any model that can call tools.
- **Capabilities.** Where a server doesn't report what a model can do, Ollmost assumes tools on, vision off, and the endpoint's "context when not reported" (8,192 tokens unless you change it). Each model's Thinking, Tools, Vision and Context can be overridden in its endpoint's table in Settings → Models. If a server turns tools down, Ollmost switches them off for that model and says which server flag they need.
- **Thinking.** Reasoning is shown whenever a server sends it. The thinking control is filled in where the server reports its options (LM Studio); elsewhere it only shows reasoning until you pick a profile for the model.
- **Cost.** Only Ollama cloud models are priced. A model on this Mac says `local`; anything else says `cost not tracked`.
- **Keys.** An endpoint's own key is only ever sent to that endpoint, and your ollama.com key only to ollama.com.
- **Removing one** asks first and says what goes: its chats keep their history and need a new model picked; its key and model settings are deleted.
- **Going back to an older Ollmost.** Chats now store their model as `endpoint/model`, which an older version can't read. The upgrade backed your database up first, to `backups/ollmost-before-endpoints-<date>.db` in the data folder: to go back, quit Ollmost and put that file back as `ollmost.db`.
```

(PR 2 and PR 3 leave the README's backup unmentioned, so this is its only mention; PR 3 added one line to "Known limits", about tok/s.)

In "How it works", replace the "**Models.**" bullet's first sentence with "**Models.** Each endpoint lists its own models (see [Model endpoints](#model-endpoints)). For Ollama, the daemon's `/api/tags` is merged with the ollama.com catalog." In the debugger bullets: "Ollama's final stats" → "the server's final stats", and "(keys appear as `$OLLAMA_API_KEY`)" → "(keys appear as environment variables: `$OLLAMA_API_KEY` for ollama.com, `$LM_STUDIO_API_KEY` for an endpoint with the id `lm-studio`)". In "Usage & cost": "**Your Ollama quota:**" → "**Your Ollama quota** (when your ollama.com key is saved, or as a prompt to add one when you have an Ollama endpoint):"; and "Costs use Ollama's published per-token prices." → "Costs use Ollama's published per-token prices, for Ollama cloud models only; a model on this Mac says `local`, and one elsewhere `cost not tracked`." In "Tests": "log every request Ollmost sends to Ollama" → "log every request Ollmost sends to a model server".

Append to "Known limits":

```md
- **Cost tracking covers Ollama cloud models only.** Other endpoints show `local` (on this Mac) or `cost not tracked`; there's no price editor, and costs a provider reports aren't read.
- **The thinking control is opt-in on OpenAI-compatible servers.** Ollmost shows whatever reasoning the server streams, but only sends a thinking setting once you pick a profile for the model in Settings → Models (LM Studio's reported options are filled in for you).
- **vLLM needs flags for tools.** Start it with `--enable-auto-tool-choice --tool-call-parser <the parser for your model>`; without them it turns tool requests down, and Ollmost switches tools off for that model.
- **llama.cpp needs `--jinja` for tools.** Without it `llama-server` can't use tools, and Ollmost switches them off for that model.
- **Remote and paid OpenAI-compatible APIs aren't officially supported.** You can add one and it will work, but its replies say "cost not tracked", and only a Bearer key is supported.
```

- [ ] **Step 7: Typecheck, lint, test, then check it by hand**

Run: `npx prettier --write src tests && npm run typecheck && npm run lint && npm run format:check && npm test`
Expected: PASS

Manual check (`npm run dev`):
1. Quit LM Studio and Ollama, then Retry on Home: "Couldn't load models from any endpoint", one line per endpoint naming it and its address; Settings opens Models.
2. ⌘K, type "lm studio", "vllm", "llama.cpp", "endpoint", "connection": the first result is "Settings › Models".
3. Settings → Features → Web search: the hint starts "Goes through ollama.com, for every model, including local ones."
4. With no models anywhere, New code session… shows "No model to start a session with. Check that a model server is running."

- [ ] **Step 8: Commit**

```bash
git add src/shared/palette.ts src/renderer/src/lib/paletteCommands.ts src/renderer/src/stores/app.ts src/renderer/src/views/HomeView.tsx \
  src/renderer/src/lib/codeActions.ts src/renderer/src/views/SettingsView.tsx README.md tests/palette.test.ts
git commit -m "Wording for several endpoints: Home's per-endpoint errors, palette keywords, the web toggle, and the README

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 9: Open PR 4**

```bash
git push -u origin claude/model-endpoints-polish
gh pr create --title "Model endpoints 4/5: usage, traces and polish" --body "$(cat <<'EOF'
Part 4 of 5 of model endpoints (spec: docs/superpowers/specs/2026-09-27-model-endpoints-design.md).

## What changes
- **Cost labels from billing.** A reply says `$0.0031`, `local` or `cost not tracked`; the chat chip says `local`, `not tracked` or the priced sum. Totals are unknown only when a priced (Ollama cloud) request has no price, in the chip, Settings → Usage & cost (per day too) and the debugger. Usage rows show each model's endpoint.
- **Quota gating.** The quota chip shows with the ollama.com key; with no key but an Ollama endpoint it offers to add one; with neither it's hidden and nothing is polled. `/api/me` goes only to an enabled Ollama endpoint on this Mac, and a failure isn't retried that session. ollama.com/pricing is fetched at startup only with an Ollama endpoint.
- **Traces.** Each trace records its dialect, which key it carried (never the key) and its endpoint. Replay goes back to that endpoint (or says it no longer exists). Image data URLs in OpenAI requests are hidden, prompt anatomy reads both formats, Copy as curl uses `$OLLAMA_API_KEY` or `$<ENDPOINT_ID>_API_KEY`, and timing rows read "Server: …" or "not reported by this server". `debug.target` is gone.
- **Wording.** Home lists each endpoint's error; palette keywords for endpoints go to Models; the web toggle says it goes through ollama.com for every model; README gains "Model endpoints" and new known limits.

## Decisions to check
- A chat that used only local and untracked models reads `not tracked`, not `$0`.
- "An Ollama endpoint" means an enabled one, for the chip and the price fetch.
- Endpoint ids that start with a digit get a leading `_` in the curl variable (`$_8080_BOX_API_KEY`), since a shell variable can't start with a digit.

## Test plan
- [ ] `npm run typecheck && npm run lint && npm run format:check && npm test`
- [ ] `OLLMOST_INSTALL_DIR=~/Applications npm run install:mac`, then the manual checks in Tasks 4.1–4.4 of the plan

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 10: The user's install check**

```bash
OLLMOST_INSTALL_DIR=~/Applications npm run install:mac
```

Then, in the installed app: a local chat reads `local`; an LM Studio chat reads `local` and its trace replays to LM Studio; with the Ollama endpoint switched off and no key, the quota chip is gone. Merge only when the user says so.

---

## PR 5 — e2e

Branch: `claude/model-endpoints-e2e`, from `main` after PR 4 has merged.

`e2e/run.mjs` has passed since PR 2, which pointed its five fake-Ollama servers at the migrated `ollama` endpoint through `window.ollmost.endpoints.update` (Task 2.6) and made its Kiln stand-in undo the model-key migration. Task 5.1 folds those five servers into one factory that speaks either dialect, and makes the quota checks follow the app's own rule; Task 5.2 adds the endpoints section. Line numbers are against `main` @ d8064b4 with PR 2's Task 2.6 applied (it changed lines in place, and added five in the Kiln section, after every line 5.1 names); PR 1, 3 and 4 don't touch this file. Code moved since wins over line numbers.

```bash
git checkout main && git pull && git checkout -b claude/model-endpoints-e2e
```

### Task 5.1: One `fakeServer({ dialect })` factory in `e2e/run.mjs`

**Files:**
- Modify: `e2e/run.mjs:1-2` (header), `:96-101` (`pickModel`), after `:120` (new helpers), `:370-428` (sections 7–8), `:583-660,692,711-718,950` (tools), `:969-1007,1038-1045` (MCP), `:1335-1389,1406-1412` (runner), `:1640-1676,1682-1688` (code sessions), `:1956-1970` (Kiln's fake)

**Interfaces:**
- Consumes: `window.ollmost.endpoints.update(id, patch)`, `window.ollmost.endpoints.list()`, `window.ollmost.settings.get()` → `{ endpoints, ollamaAccount: { hasKey } }` (PR 2); the migrated endpoint id `ollama`; the e2e wiring PR 2's Task 2.6 left (`endpoints.update('ollama', …)` evaluates, `settings.ollamaAccount.hasKey`, the Kiln stand-in's `+ 9`).
- Produces: `fakeServer`, `useOllamaAt`, `expectedQuota`, `pickModel(win, name, endpoint?)`.

- [ ] **Step 1: Add the factory and helpers**

Replace the header comment (lines 1-2) with:

```js
// End-to-end run: drives the built app with Playwright against real Ollama models, and against stand-in model servers
// (Ollama's API and an OpenAI-compatible one) for the deterministic sections.
// Usage: npm run build && npm run e2e   (needs the Ollama app running and `ollama signin` for cloud models;
// OLLMOST_E2E_OPENAI_URL=http://localhost:1234/v1 adds a live check against an OpenAI-compatible server such as LM Studio)
```

Replace `pickModel` (lines 96-101) with:

```js
async function pickModel(win, name, endpoint) {
  await win.click('button[aria-label="Choose model"]')
  const picker = win.locator('[data-radix-popper-content-wrapper]')
  // An endpoint's chip (under the search box) narrows the list to its models.
  if (endpoint) await picker.getByRole('button', { name: endpoint, exact: true }).first().click()
  await win.fill('input[placeholder="Search models"]', name)
  await win.waitForTimeout(300)
  await picker.locator('button').filter({ hasText: name }).first().click()
}
```

After `newChat` (it ends at line 120), add:

```js
/**
 * A stand-in model server. 'ollama' speaks Ollama's API (/api/version, /api/tags, /api/show, NDJSON /api/chat); 'openai'
 * speaks the OpenAI-compatible one under /v1 (/v1/models, SSE /v1/chat/completions) as a generic server that reports no
 * capabilities. `reply(body)` scripts each streamed reply from the request as sent and returns an assistant message in
 * Ollama's shape ({ content, tool_calls: [{ function: { name, arguments } }] }), encoded here for the dialect; OpenAI
 * tool calls get the ids call_e2e_<n> and arrive in two pieces. Non-streaming requests (titles, debugger replays) get
 * `once(body)`'s message, else `title`. `route(req, res)` answers other paths first (pages, beacons) and returns true
 * when it did. `requests`, when given, collects { path, body } for every request.
 */
async function fakeServer({ dialect, models, capabilities = ['completion', 'tools'], reply, once, title = 'Mock title', route, requests }) {
  const server = createServer(async (req, res) => {
    if (route && (await route(req, res))) return
    let raw = ''
    for await (const chunk of req) raw += chunk
    const body = raw ? JSON.parse(raw) : {}
    requests?.push({ path: req.url, body })
    const json = (obj) => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(obj))
    if (dialect === 'ollama') {
      if (req.url === '/api/version') return json({ version: '0.12.0' })
      if (req.url === '/api/tags') return json({ models: models.map((name) => ({ name })) })
      if (req.url === '/api/show') return json({ capabilities, model_info: { 'mock.context_length': 32768 }, details: {} })
      if (req.url !== '/api/chat') return res.writeHead(404).end()
      if (!body.stream) {
        const message = (await once?.(body)) ?? { content: title }
        return json({ message: { role: 'assistant', ...message }, done: true, done_reason: 'stop', prompt_eval_count: 100, eval_count: 12 })
      }
      const message = await reply(body)
      res.writeHead(200, { 'content-type': 'application/x-ndjson' })
      res.write(JSON.stringify({ message: { role: 'assistant', ...message }, done: false }) + '\n')
      return res.end(
        JSON.stringify({ done: true, done_reason: 'stop', prompt_eval_count: 100, eval_count: 12, eval_duration: 1e8 }) + '\n'
      )
    }
    if (req.url === '/v1/models') return json({ object: 'list', data: models.map((id) => ({ id, object: 'model', owned_by: 'e2e' })) })
    if (req.url !== '/v1/chat/completions') return res.writeHead(404).end()
    const message = body.stream ? await reply(body) : ((await once?.(body)) ?? { content: title })
    const calls = (message.tool_calls ?? []).map((c, i) => ({
      id: `call_e2e_${i}`,
      type: 'function',
      function: { name: c.function.name, arguments: JSON.stringify(c.function.arguments) }
    }))
    const finish = calls.length ? 'tool_calls' : 'stop'
    const usage = { prompt_tokens: 100, completion_tokens: 12, total_tokens: 112 }
    if (!body.stream) {
      const out = { role: 'assistant', content: message.content ?? '', ...(calls.length ? { tool_calls: calls } : {}) }
      return json({ id: 'chatcmpl-e2e', object: 'chat.completion', choices: [{ index: 0, message: out, finish_reason: finish }], usage })
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    const send = (data) => res.write(`data: ${JSON.stringify(data)}\n\n`)
    const chunk = (delta, finishReason = null) => ({
      id: 'chatcmpl-e2e',
      object: 'chat.completion.chunk',
      choices: [{ index: 0, delta, finish_reason: finishReason }]
    })
    send(chunk({ role: 'assistant', content: '' }))
    if (message.content) send(chunk({ content: message.content }))
    // Each call in two pieces, as servers stream them: the id and name, then the arguments.
    calls.forEach((c, index) => {
      send(chunk({ tool_calls: [{ index, id: c.id, type: 'function', function: { name: c.function.name, arguments: '' } }] }))
      send(chunk({ tool_calls: [{ index, function: { arguments: c.function.arguments } }] }))
    })
    send(chunk({}, finish))
    if (body.stream_options?.include_usage) send({ id: 'chatcmpl-e2e', object: 'chat.completion.chunk', choices: [], usage })
    res.end('data: [DONE]\n\n')
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const { port } = server.address()
  const root = `http://127.0.0.1:${port}`
  return { port, url: dialect === 'openai' ? `${root}/v1` : root, close: () => server.close() }
}

/** Point the migrated Ollama endpoint at a stand-in (cloud catalog off, so only its models list), then reload. */
async function useOllamaAt(win, url) {
  await win.evaluate((baseUrl) => window.ollmost.endpoints.update('ollama', { baseUrl, showCloudCatalog: false }), url)
  await win.reload()
  await win.waitForSelector('textarea')
  await win.waitForTimeout(1500)
}

/** What the quota chip should do, by the app's own rule (quotaMode in src/shared/usage.ts). */
async function expectedQuota(win) {
  const s = await win.evaluate(() => window.ollmost.settings.get())
  if (s.ollamaAccount.hasKey) return 'show'
  return s.endpoints.some((e) => e.kind === 'ollama' && e.enabled) ? 'add-key' : 'hidden'
}
```

- [ ] **Step 2: Make the cost and quota checks conditional (sections 7–8)**

Line 374, the chip may now read `not tracked` too:

```js
  check('title bar shows chat tokens and cost', /tokens · (≈?\$[\d.]+|local|not tracked)/.test(costChip), costChip)
```

Replace section 8 (lines 376-428, from its comment through the `usage-settings.png` screenshot) with:

```js
  // 8. Account quota: with an Ollama endpoint and no key it asks for one; with the key it shows usage and dates a reset
  // from a drop. With neither there's no chip at all.
  const quota = await expectedQuota(win)
  if (quota === 'hidden') {
    check('no quota chip without an Ollama endpoint or an ollama.com key', (await win.locator('button[aria-label^="Ollama usage"]').count()) === 0)
  } else {
    const before = await win.locator('button[aria-label^="Ollama usage"]').innerText()
    check('quota chip asks for an API key first', quota === 'add-key' && /Quota/.test(before), before)
    // … lines 379-428 of today's file, unchanged (from `await win` / `.getByRole('button', { name: /Set your name|Settings/ })`
    // through `await win.screenshot({ path: join(SHOTS, 'usage-settings.png') })`), indented one level …
  }
```

The block between the two checks and the closing brace is today's lines 379-428 moved inside the `else`, unchanged apart from indentation (Prettier re-indents it in Step 7).

- [ ] **Step 3: The tools section's fake (today lines 583-660, 692, 711-718, 950)**

Replace `const fakeOllama = createServer(async (req, res) => {` through its closing `})` (lines 583-660) with:

```js
const fakeOllama = await fakeServer({
  dialect: 'ollama',
  models: ['mock-tools:latest'],
  // A debugger replay of a tool round (non-streaming, with tools) gets its tool call back; titles get the default.
  once: (body) => {
    if (!body.tools?.length) return null
    mockChats.push({ toolNames: body.tools.map((t) => t.function.name), toolResults: [], system: body.messages[0].content, replay: true })
    return { content: '', tool_calls: [{ function: { name: 'web_search', arguments: { query: 'replayed' } } }] }
  },
  reply: (body) => {
    // … today's lines 605-656 unchanged, from `const toolNames = (body.tools ?? []).map((t) => t.function.name)` through
    // the closing `}` of the last `else { message = { role: 'assistant', content: "I can't browse the web …" } }` …
    return message
  }
})
```

Delete line 692 (`await new Promise((r) => fakeOllama.listen(0, '127.0.0.1', r))`). Replace lines 711-718 (the `waitForSelector`, the `endpoints.update('ollama', …)` evaluate PR 2 wrote, the reload, and the two waits) with:

```js
  await win.waitForSelector('textarea', { timeout: 20000 })
  await useOllamaAt(win, fakeOllama.url)
```

`fakeOllama.close()` at line 950 stays.

- [ ] **Step 4: The MCP, runner and code-session fakes**

MCP — replace `const mcpOllama = createServer(async (req, res) => {` through its `})` (lines 969-1006) and the `listen` line 1007 with:

```js
  const mcpOllama = await fakeServer({
    dialect: 'ollama',
    models: ['mock-tools:latest'],
    reply: async (body) => {
      // … today's lines 978-1002 unchanged, from `const toolNames = …` through the end of the `const message = asksForLink ? …`
      // expression (`: { role: 'assistant', content: \`Tool said: ${turnResults.at(-1)}\` }`) …
      return message
    }
  })
```

and replace lines 1039-1045 (PR 2's `endpoints.update('ollama', …)` evaluate, the reload and the two waits) with `await useOllamaAt(win, mcpOllama.url)` (the `waitForSelector('textarea', { timeout: 20000 })` before them, line 1038, stays).

Runner — replace `const runnerOllama = createServer(async (req, res) => {` through its `})` (lines 1335-1388) and the `listen` line 1389 with:

```js
  const runnerOllama = await fakeServer({
    dialect: 'ollama',
    models: ['mock-tools:latest'],
    // A scripted SVG a run writes calls home here if anything runs it (#67).
    route: (req, res) => {
      if (!req.url.startsWith('/svg-')) return false
      svgHits.push(req.url)
      res.writeHead(200).end()
      return true
    },
    reply: (body) => {
      // … today's lines 1349-1384 unchanged, from `const toolNames = …` through
      // `} else message = { role: 'assistant', content: 'Plain answer.' }`, except that
      // `evilSvg(runnerOllama.address().port)` becomes `evilSvg(runnerOllama.port)` …
      return message
    }
  })
```

and replace lines 1406-1412 (the evaluate, the reload and the two waits) with `await useOllamaAt(win, runnerOllama.url)`.

Code sessions — replace lines 1640-1676 (`const sessionOllama = createServer(…)` through its `listen` line) with the
code below. Its `once` keeps the `/compact` summary #180 added to this fake (Markdown, after a pause, so section 6c can
type while it runs):

```js
    const sessionOllama = await fakeServer({
      dialect: 'ollama',
      models: ['mock-tools:latest'],
      // A /compact summary takes a moment, so the next message can be typed while it runs, and comes in Markdown, as
      // models often write it whatever the prompt asks. Anything else read whole (a title) gets the default.
      once: (body) =>
        String(body.messages[0]?.content).startsWith('You compact')
          ? new Promise((resolve) =>
              setTimeout(() => resolve({ content: '**Goal:** greet in French.\n\n- Read README.md.\n- Changed Hello to Bonjour.' }), 2000)
            )
          : null,
      reply: (body) => {
        const toolNames = (body.tools ?? []).map((t) => t.function.name)
        const lastUser = body.messages.findLastIndex((m) => m.role === 'user')
        const results = body.messages
          .slice(lastUser)
          .filter((m) => m.role === 'tool')
          .map((m) => m.content)
        sessionChats.push({ toolNames, system: body.messages[0].content, results })
        const call = (name, args) => ({ content: '', tool_calls: [{ function: { name, arguments: args } }] })
        // Only a session offers edit_file, so its presence is what tells this fake apart from the other mock chats.
        return !toolNames.includes('edit_file')
          ? { content: 'Plain answer.' }
          : results.length === 0
            ? call('read_file', { path: 'README.md' })
            : results.length === 1
              ? call('edit_file', { path: 'README.md', old_string: 'Hello', new_string: 'Bonjour' })
              : results.length === 2
                ? call('run_command', { command: 'echo done' })
                : { content: 'Changed the greeting and checked it.' }
      }
    })
```

and replace lines 1682-1688 (the evaluate, the reload and the two waits) with `await useOllamaAt(win, sessionOllama.url)`.

- [ ] **Step 5: The Kiln section's fake**

Replace the fake (lines 1956-1970, from `const mock = createServer(async (req, res) => {` through
`` const host = `http://127.0.0.1:${mock.address().port}` ``) with:

```js
  const mock = await fakeServer({
    dialect: 'ollama',
    models: ['mock-vision:latest'],
    capabilities: ['completion', 'vision'],
    title: 'Heron picture',
    reply: () => ({ content: 'A dot.' })
  })
  const host = mock.url
```

The rest of the section stays as PR 2 left it: the seed already points the `ollama` endpoint at `host` through
`endpoints.update` (Task 2.6), the stand-in already undoes the model-key migration (`KILN_DB_VERSION + 9`, Task 2.6), and
the last check already reads `settings.ollamaAccount.hasKey`.

- [ ] **Step 6: Check nothing still uses the old wiring**

Run: `grep -n "connection\|createServer(async\|\.listen(0\|hasApiKey" e2e/run.mjs`
Expected: only `usageServer`, `fakePages`, `fakeWeb`, `leakPages` and the factory's own `createServer` / `server.listen(0` lines; no `connection` or `hasApiKey`.

- [ ] **Step 7: Format, lint, and run the e2e**

Run: `npx prettier --write e2e/run.mjs && npm run lint && npm run format:check && npm run build && npm run e2e`
Expected: the same checks as before this PR, all PASS, including:

```
PASS  quota chip asks for an API key first
PASS  quota chip shows weekly usage
PASS  without a key, web tools are not offered
PASS  debugger lists every request in the turn, in order
PASS  replay re-sends the request without streaming
PASS  a delegated task is answered from the sub-agent’s result
PASS  the code runner is available (sandbox and Python found)
PASS  opening a folder starts a session named after it, with its branch and no network access
PASS  the Kiln stand-in undoes every migration since Kiln
PASS  the API key and the server's values are asked for again
…
N/N checks passed. Screenshots in e2e/shots/, data in /var/folders/…
```

- [ ] **Step 8: Commit**

```bash
git add e2e/run.mjs
git commit -m "e2e: one fakeServer factory for every stand-in, wired through the endpoints IPC, and quota checks by the app's own rule

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

### Task 5.2: e2e: the endpoints flow, and an optional live section; PR

**Files:**
- Modify: `e2e/run.mjs` (a new section 15, inserted just before `// 14. Coming from Kiln`)
- Modify: `README.md` (the e2e list and the Tests commands)

**Interfaces:**
- Consumes: `fakeServer`, `useOllamaAt`, `pickModel`, `send`, `check` (Task 5.1 and today's file); `window.ollmost.endpoints.{list, update, probe, add}`, `window.ollmost.models.list(refresh)` (PR 2); the Add endpoint dialog and picker chips (PR 2/3; see the assumptions at the top); generic discovery hiding embedding models (PR 3); `load_skill` (auto-approved, `src/main/chat/skillTools.ts`).
- Produces: section 15 and 15b; screenshots `endpoint-add.png`, `endpoint-picker.png`, `endpoint-switch.png`, `endpoint-live.png`.

The tool round is a skill load: `load_skill` needs no approval, no network, no sandbox and no key (web tools need the ollama.com key; the code runner needs its sandbox, Python and an approval click), and the fake can check the whole OpenAI round trip on it: the call's id and JSON-string arguments echoed back, and the result carrying that id.

- [ ] **Step 1: Add section 15**

Insert before `// 14. Coming from Kiln (#60)`:

```js
// 15. Model endpoints: an OpenAI-compatible server added in Settings (Check, then Add), picked with its chip, a tool
// round on it, the "local" label, and the same chat switched to a model on the Ollama endpoint.
{
  const openaiRequests = []
  const openai = await fakeServer({
    dialect: 'openai',
    // Generic discovery hides embedding models by name.
    models: ['mock-openai-tools', 'text-embedding-mock'],
    requests: openaiRequests,
    // One round: load the skill; then answer with what it said.
    reply: (body) => {
      const lastUser = body.messages.findLastIndex((m) => m.role === 'user')
      const results = body.messages.slice(lastUser).filter((m) => m.role === 'tool')
      if (!(body.tools ?? []).some((t) => t.function.name === 'load_skill')) return { content: 'No tools here.' }
      return results.length === 0
        ? { content: '', tool_calls: [{ function: { name: 'load_skill', arguments: { name: 'endpoint-helper' } } }] }
        : { content: `Skill says: ${/E2E-ENDPOINT-MARKER/.test(results[0].content) ? 'E2E-ENDPOINT-MARKER' : 'nothing'}` }
    }
  })
  const ollamaRequests = []
  const ollama = await fakeServer({
    dialect: 'ollama',
    models: ['mock-ollama:latest'],
    requests: ollamaRequests,
    reply: () => ({ content: 'Ollama answered: E2E-OLLAMA-OK' })
  })
  const data = mkdtempSync(join(tmpdir(), 'ollmost-e2e-endpoints-'))
  mkdirSync(join(data, 'skills', 'endpoint-helper'), { recursive: true })
  writeFileSync(
    join(data, 'skills', 'endpoint-helper', 'SKILL.md'),
    '---\nname: endpoint-helper\ndescription: Use for any question about endpoints.\n---\n\nThe answer is E2E-ENDPOINT-MARKER.\n'
  )
  const app = await electron.launch({ args: [ROOT], env: { ...process.env, OLLMOST_USER_DATA: data } })
  const win = await app.firstWindow()
  try {
    await win.waitForSelector('textarea', { timeout: 20000 })
    await useOllamaAt(win, ollama.url)

    // Settings → Models → + Add endpoint: the address, Check, what was found, a name, Add.
    await win
      .getByRole('button', { name: /Set your name|Settings/ })
      .last()
      .click()
    await win.getByRole('button', { name: 'Models', exact: true }).click()
    await win.getByRole('button', { name: /Add endpoint/ }).click()
    const dialog = win.getByRole('dialog')
    await dialog.getByLabel('Address', { exact: true }).fill(openai.url)
    await dialog.getByRole('button', { name: 'Check' }).click()
    const found = dialog.getByText(/^Found/)
    await found.waitFor({ timeout: 10000 })
    const summary = await found.innerText()
    check('Check finds an OpenAI-compatible server and says defaults apply', /defaults apply/.test(summary), summary)
    await win.screenshot({ path: join(SHOTS, 'endpoint-add.png') })
    await dialog.getByLabel('Name', { exact: true }).fill('E2E Server')
    await dialog.getByRole('button', { name: 'Add', exact: true }).click()
    await dialog.waitFor({ state: 'detached', timeout: 10000 })
    const added = (await win.evaluate(() => window.ollmost.endpoints.list())).find((e) => e.name === 'E2E Server')
    check(
      'the endpoint is saved with an id made from its name, as OpenAI-compatible, at the address checked',
      added?.id === 'e2e-server' && added?.kind === 'openai' && added?.baseUrl === openai.url,
      JSON.stringify(added)
    )

    // The picker: a chip for the endpoint narrows the list to its models.
    await newChat(win)
    await win.click('button[aria-label="Choose model"]')
    const picker = win.locator('[data-radix-popper-content-wrapper]')
    await picker.getByRole('button', { name: 'E2E Server', exact: true }).first().click()
    const listed = await picker.innerText()
    check(
      "the endpoint's chip lists its chat models only",
      /mock-openai-tools/.test(listed) && !/mock-ollama/.test(listed) && !/text-embedding-mock/.test(listed),
      listed.replace(/\s+/g, ' ').slice(0, 120)
    )
    await win.screenshot({ path: join(SHOTS, 'endpoint-picker.png') })
    await picker.locator('button').filter({ hasText: 'mock-openai-tools' }).first().click()
    const trigger = await win.locator('button[aria-label="Choose model"]').innerText()
    check('the picker names a non-Ollama model with its endpoint', /mock-openai-tools · E2E Server/.test(trigger), trigger)

    // A tool round on the OpenAI-compatible endpoint.
    const reply = await send(win, 'What does the endpoint helper skill say?')
    check('a model on the OpenAI-compatible endpoint loads a skill and answers from it', /Skill says: E2E-ENDPOINT-MARKER/.test(reply), reply.slice(0, 80))
    const [first, second] = openaiRequests.filter((r) => r.path === '/v1/chat/completions' && r.body.stream)
    const echo = second?.body.messages.find((m) => m.role === 'assistant' && m.tool_calls)
    const result = second?.body.messages.find((m) => m.role === 'tool')
    check(
      "the round goes back in OpenAI's shape: the call with its id and JSON arguments, the result with that id",
      !!first?.body.tools?.some((t) => t.function.name === 'load_skill') &&
        echo?.tool_calls[0].id === 'call_e2e_0' &&
        typeof echo?.tool_calls[0].function.arguments === 'string' &&
        result?.tool_call_id === 'call_e2e_0',
      JSON.stringify(echo?.tool_calls ?? null).slice(0, 120)
    )
    check('the stream asks for usage', first?.body.stream_options?.include_usage === true)
    check('the skill load shows in the reply', (await win.locator('text=Using skill').count()) > 0)

    // The "local" label: a server on this Mac costs nothing Ollmost tracks.
    await win.waitForSelector('button[aria-label="Chat usage"]', { timeout: 10000 })
    const chip = await win.locator('button[aria-label="Chat usage"]').innerText()
    check("the chat's cost reads local", /tokens · local/.test(chip), chip)
    await win.locator('span.cursor-default').filter({ hasText: 'mock-openai-tools' }).last().hover()
    await win.waitForTimeout(700)
    const stats = (await win.locator('[role="tooltip"]').first().textContent()) ?? ''
    check("the reply's stats say local", /· local\b/.test(stats), stats)
    await win.mouse.move(0, 0)

    // The same chat, switched to a model on the Ollama endpoint.
    await pickModel(win, 'mock-ollama', 'Ollama')
    const ollamaReply = await send(win, 'And what does the Ollama model say?')
    check('the same chat continues on the Ollama endpoint', /E2E-OLLAMA-OK/.test(ollamaReply), ollamaReply.slice(0, 60))
    const carried = ollamaRequests.find((r) => r.path === '/api/chat' && r.body.stream)
    check(
      "the history goes to Ollama in its own shape, with the other endpoint's answer and no tool-call ids",
      !!carried?.body.messages.some((m) => m.role === 'assistant' && /E2E-ENDPOINT-MARKER/.test(m.content)) &&
        !JSON.stringify(carried?.body ?? {}).includes('tool_call_id'),
      `${carried?.body.messages.length ?? 0} messages`
    )
    await win.screenshot({ path: join(SHOTS, 'endpoint-switch.png') })

    // The quota chip: offered with an Ollama endpoint and no key; gone once there's neither.
    check(
      'with an Ollama endpoint and no key, the quota chip asks for one',
      (await expectedQuota(win)) === 'add-key' && /Quota/.test(await win.locator('button[aria-label^="Ollama usage"]').innerText())
    )
    await win.evaluate(() => window.ollmost.endpoints.update('ollama', { enabled: false }))
    await win.reload()
    await win.waitForSelector('textarea')
    await win.waitForTimeout(1500)
    check(
      'with no Ollama endpoint and no key, there is no quota chip',
      (await expectedQuota(win)) === 'hidden' && (await win.locator('button[aria-label^="Ollama usage"]').count()) === 0
    )
  } catch (err) {
    check('model endpoints run completed without errors', false, err.message.split('\n')[0])
    await win.screenshot({ path: join(SHOTS, 'endpoints-failure.png') }).catch(() => {})
  } finally {
    await app.close()
    openai.close()
    ollama.close()
  }

  // 15b. Live: a model on a real OpenAI-compatible server (LM Studio: http://localhost:1234/v1), when one is given.
  // OLLMOST_E2E_OPENAI_MODEL picks the model; otherwise the first that can use tools.
  if (process.env.OLLMOST_E2E_OPENAI_URL) {
    const baseUrl = process.env.OLLMOST_E2E_OPENAI_URL
    const liveApp = await electron.launch({
      args: [ROOT],
      env: { ...process.env, OLLMOST_USER_DATA: mkdtempSync(join(tmpdir(), 'ollmost-e2e-endpoints-live-')) }
    })
    const liveWin = await liveApp.firstWindow()
    try {
      await liveWin.waitForSelector('textarea', { timeout: 20000 })
      const live = await liveWin.evaluate(async (url) => {
        const probe = await window.ollmost.endpoints.probe({ baseUrl: url })
        return window.ollmost.endpoints.add({ name: 'Live server', baseUrl: probe.baseUrl, kind: probe.kind, flavor: probe.flavor })
      }, baseUrl)
      const { models } = await liveWin.evaluate(() => window.ollmost.models.list(true))
      const wanted = process.env.OLLMOST_E2E_OPENAI_MODEL
      const model = models.find((m) => m.endpoint.id === live.id && (wanted ? m.name === wanted : m.capabilities.includes('tools')))
      check('the live server lists a model to use', !!model, `${live.flavor}: ${models.filter((m) => m.endpoint.id === live.id).length} models`)
      if (model) {
        await liveWin.reload()
        await liveWin.waitForSelector('textarea')
        await liveWin.waitForTimeout(1500)
        await pickModel(liveWin, model.name, 'Live server')
        const pong = await send(liveWin, 'Reply with the single word: pong')
        check(`${model.name} on ${live.flavor} answers`, /pong/i.test(pong), pong.slice(0, 60))
        const onThisMac = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/.test(live.baseUrl)
        const liveChip = await liveWin.locator('button[aria-label="Chat usage"]').innerText()
        check(
          `its cost reads ${onThisMac ? 'local' : 'not tracked'}`,
          new RegExp(`tokens · ${onThisMac ? 'local' : 'not tracked'}`).test(liveChip),
          liveChip
        )
        await liveWin.screenshot({ path: join(SHOTS, 'endpoint-live.png') })
      }
    } catch (err) {
      check('live endpoint run completed without errors', false, err.message.split('\n')[0])
      await liveWin.screenshot({ path: join(SHOTS, 'endpoint-live-failure.png') }).catch(() => {})
    } finally {
      await liveApp.close()
    }
  } else {
    console.log('SKIP  model endpoints: live check (set OLLMOST_E2E_OPENAI_URL to run it, e.g. http://localhost:1234/v1)')
  }
}
```

- [ ] **Step 2: README**

In "Tests", after the `npm run build && npm run e2e` line of the command block, add:

```sh
OLLMOST_E2E_OPENAI_URL=http://localhost:1234/v1 npm run e2e   # also a live check against LM Studio (or any OpenAI-compatible server)
```

In the list under "The e2e run checks:", before "coming from Kiln", add:

```md
- model endpoints: adding an OpenAI-compatible server in Settings (Check, then Add), its chip in the picker, a tool round in OpenAI's shape, the `local` label, switching a chat to the Ollama endpoint, and the quota chip going when there's no Ollama endpoint or key
```

- [ ] **Step 3: Format, lint, and run the e2e**

Run: `npx prettier --write e2e/run.mjs && npm run lint && npm run format:check && npm run build && npm run e2e`
Expected: every earlier check still PASS, plus:

```
PASS  Check finds an OpenAI-compatible server and says defaults apply  (Found … defaults apply (tools on, vision off))
PASS  the endpoint is saved with an id made from its name, as OpenAI-compatible, at the address checked
PASS  the endpoint's chip lists its chat models only
PASS  the picker names a non-Ollama model with its endpoint  (mock-openai-tools · E2E Server)
PASS  a model on the OpenAI-compatible endpoint loads a skill and answers from it  (Skill says: E2E-ENDPOINT-MARKER)
PASS  the round goes back in OpenAI's shape: the call with its id and JSON arguments, the result with that id
PASS  the stream asks for usage
PASS  the skill load shows in the reply
PASS  the chat's cost reads local
PASS  the reply's stats say local
PASS  the same chat continues on the Ollama endpoint
PASS  the history goes to Ollama in its own shape, with the other endpoint's answer and no tool-call ids
PASS  with an Ollama endpoint and no key, the quota chip asks for one
PASS  with no Ollama endpoint and no key, there is no quota chip
SKIP  model endpoints: live check (set OLLMOST_E2E_OPENAI_URL to run it, e.g. http://localhost:1234/v1)
…
N/N checks passed.
```

and `e2e/shots/` holds `endpoint-add.png`, `endpoint-picker.png` and `endpoint-switch.png`. Open them: the dialog's step 2, the picker filtered to "E2E Server", and the chat with both replies.

- [ ] **Step 4: Run the live section against LM Studio**

With LM Studio's server started (Developer tab) and a tools-capable model downloaded:

Run: `OLLMOST_E2E_OPENAI_URL=http://localhost:1234/v1 npm run e2e`
Expected, in place of the SKIP line:

```
PASS  the live server lists a model to use  (lmstudio: N models)
PASS  <model> on lmstudio answers  (pong)
PASS  its cost reads local
```

and `e2e/shots/endpoint-live.png`.

- [ ] **Step 5: Commit**

```bash
git add e2e/run.mjs README.md
git commit -m "e2e: add an OpenAI-compatible endpoint in Settings, a tool round on it, and switch the chat to Ollama; a live LM Studio check

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 6: Open PR 5**

```bash
git push -u origin claude/model-endpoints-e2e
gh pr create --title "Model endpoints 5/5: e2e" --body "$(cat <<'EOF'
Part 5 of 5 of model endpoints (spec: docs/superpowers/specs/2026-09-27-model-endpoints-design.md).

## What changes
- **One `fakeServer({ dialect })` factory** replaces the five fake-Ollama servers in `e2e/run.mjs`. It speaks Ollama's API or an OpenAI-compatible one (SSE, tool calls in pieces, `stream_options` usage), and each section points the migrated `ollama` endpoint at it with one helper, `useOllamaAt` (PR 2 moved that wiring to the endpoints IPC and made the Kiln stand-in undo the model-key migration; the e2e has passed since).
- **Quota checks follow the app's rule**: the chip is expected only with an ollama.com key or an Ollama endpoint.
- **A new section**: Settings → Models → Add endpoint (Check, then Add) → the endpoint's chip in the picker → a skill load in OpenAI's shape (call id and JSON arguments echoed, the result carrying the id) → the `local` label → the same chat switched to the Ollama endpoint, with no tool-call ids reaching Ollama → no quota chip once there's no Ollama endpoint or key.
- **An optional live section** with `OLLMOST_E2E_OPENAI_URL` (e.g. LM Studio at `http://localhost:1234/v1`).

## Test plan
- [ ] `npm run lint && npm run format:check && npm run build && npm run e2e` — every check passes; screenshots in `e2e/shots/endpoint-*.png`
- [ ] `OLLMOST_E2E_OPENAI_URL=http://localhost:1234/v1 npm run e2e` with LM Studio's server running
- [ ] `OLLMOST_INSTALL_DIR=~/Applications npm run install:mac`

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 7: The user's install check**

```bash
OLLMOST_INSTALL_DIR=~/Applications npm run install:mac
```

Then add LM Studio from Settings → Models in the installed app, send a message that loads a skill, and switch the chat to an Ollama model. Merge only when the user says so.

---

## Known risks and choices left open (decided while assembling, 2026-09-27)

- **The out-of-memory error keeps "Settings → Models".** It still leads to the right tab, where each endpoint's page holds its context size, and `tests/client.test.ts` pins the wording. It isn't reworded to name the endpoint.
- **Made-up stream ids (`t…`) restart at `t00000000` in each request**, so two rounds in one reply can both use `t00000000`. Each id still pairs with its own result, and servers normally send their own ids, so this path is rare.
  - If vLLM or Mistral rejects a repeated id (seen in the capture spike or the user's vLLM test), move the counter to one per reply: `runRounds` passes a starting number, and the adapter continues from it.
- **`updateEndpoint` becomes async in PR 3.** It has to re-probe an OpenAI endpoint's new address. PR 2's tests are updated to `await` it in the same task.
- **Line numbers drift.** `src/main/index.ts` moves about 6 lines after Task 2.3. #175 has merged (24f4623) and the plan's numbers include it; anything that merges after it moves them again. The anchors rule applies: re-read before each PR. Code that moved wins over the plan's line numbers, never over its behaviour.
- **#175's batches meet the OpenAI dialect in PR 3.** An OpenAI-compatible server pairs a result with its call only by `tool_call_id`, so the call-order loop PR 1 keeps must push each result with its own call's id. Task 1.6 does, and Task 3.10's "two sub-agents at once" script pins it over both dialects.
- **PR 2's e2e run needs a live Ollama, signed in, like every e2e run.** It's the first run after the picker and Settings rewrite. The selectors e2e uses (`Choose model`, `Search models`, the Settings buttons) are kept on purpose.
- **vLLM and llama.cpp fixtures are written from their docs** and marked `# unverified`. The user will check vLLM on a real server and report problems. The spec's six capture-spike questions are answered for LM Studio in PR 0.
