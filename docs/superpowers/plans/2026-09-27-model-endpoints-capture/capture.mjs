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
