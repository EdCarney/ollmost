import { execFileSync } from 'node:child_process'
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
import { EndpointGoneError } from '../src/main/providers/registry'

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
    ollama: {
      id: 'ollama',
      name: 'Ollama',
      kind: 'ollama',
      flavor: 'ollama',
      baseUrl: 'http://127.0.0.1:11434',
      enabled: true,
      hasKey: false
    },
    'lm-studio': {
      id: 'lm-studio',
      name: 'LM Studio',
      kind: 'openai',
      flavor: 'lmstudio',
      baseUrl: 'http://localhost:1234/v1',
      enabled: true,
      hasKey: false
    }
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
    expect(curl.split('\n')[0]).toBe(': 1 image was not recorded and is left out.')
    expect(toCurl('http://127.0.0.1:11434/api/chat', { model: 'm', messages: [] }, null)).not.toContain('Authorization')
    const openai = toCurl('http://localhost:1234/v1/chat/completions', redactImages(openaiBody), 'LM_STUDIO_API_KEY')
    expect(openai).toContain('Bearer $LM_STUDIO_API_KEY')
    expect(openai).toContain('"stream": false')
    expect(openai).not.toContain('stream_options')
    expect(openai.split('\n')[0]).toBe(': 1 image was not recorded and is left out.')
  })

  it('notes the images it left out in a line every shell runs as a no-op, pasted or not', () => {
    const images = (n: number) => ({ model: 'm', messages: [{ role: 'user', content: 'x', images: Array(n).fill('<image 3 KB>') }] })
    const notes = [1, 2].map((n) => toCurl('http://127.0.0.1:11434/api/chat', images(n), null).split('\n')[0])
    expect(notes).toEqual([': 1 image was not recorded and is left out.', ': 2 images were not recorded and are left out.'])
    for (const note of notes) {
      // Not a # comment: an interactive zsh reads # as a word unless interactivecomments is on, and then an apostrophe
      // would open a quote and swallow the curl line. Plain words after `:` mean the same to every shell.
      expect(note).not.toMatch(/['"$()&;|<>\\*?[\]#!{}`]/)
      expect(execFileSync('sh', ['-c', note], { encoding: 'utf8' })).toBe('')
    }
  })

  it('quotes the address, so a shell reads it as written and runs nothing in it', () => {
    // An address keeps its path, and a path can hold what a shell would act on.
    const url = "http://box:8000/it's$(id);true&|/v1/chat/completions"
    const curl = toCurl(url, { model: 'm', messages: [] }, null)
    const quoted = curl.match(/^curl (.*) \\$/m)![1]
    expect(quoted).toBe(`'http://box:8000/it'\\''s$(id);true&|/v1/chat/completions'`)
    expect(execFileSync('sh', ['-c', `printf %s ${quoted}`], { encoding: 'utf8' })).toBe(url)
    // zsh reads an unquoted [::1] as a glob, and stops at "no matches found".
    expect(toCurl('http://[::1]:11434/api/chat', { model: 'm', messages: [] }, null)).toContain("curl 'http://[::1]:11434/api/chat' \\\n")
  })

  it('reads the key from an environment variable named after the endpoint', () => {
    expect(curlKeyVar({ auth: 'ollama.com', endpointId: 'ollama' })).toBe('OLLAMA_API_KEY')
    expect(curlKeyVar({ auth: 'endpoint', endpointId: 'lm-studio' })).toBe('LM_STUDIO_API_KEY')
    // $OLLAMA_API_KEY holds the ollama.com key, which goes only to ollama.com: endpoint `ollama`'s own key reads another.
    expect(curlKeyVar({ auth: 'endpoint', endpointId: 'ollama' })).toBe('OLLAMA_ENDPOINT_API_KEY')
    // A shell variable can't start with a digit.
    expect(curlKeyVar({ auth: 'endpoint', endpointId: '8080-box' })).toBe('_8080_BOX_API_KEY')
    // The name goes inside double quotes, where $( ` " would be acted on: a hand-edited id keeps to what a name can hold.
    expect(curlKeyVar({ auth: 'endpoint', endpointId: 'a$(rm -rf ~)`"b' })).toBe('A__RM__RF_____B_API_KEY')
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
    // As the Ollama wire sends keys: ollama.com gets the account key over https, nothing over http, and never an endpoint key.
    expect(traceTarget(e({ id: 'cloud', baseUrl: 'https://ollama.com', hasKey: true })).auth).toBe('ollama.com')
    expect(traceTarget(e({ id: 'cloud', baseUrl: 'http://ollama.com', hasKey: true })).auth).toBeNull()
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
    // A recorded dialect is kept, whatever the address.
    expect(storedTraceTarget({ endpoint: 'http://box/chat/completions', dialect: 'ollama' }).dialect).toBe('ollama')
  })

  it('reads an OpenAI request recorded before traces kept their dialect by its address, with no key it can tell', () => {
    // PR 3 recorded OpenAI-compatible requests with no dialect. Whether one carried a key can't be told afterwards.
    expect(storedTraceTarget({ endpoint: 'http://localhost:1234/v1/chat/completions' })).toEqual({
      dialect: 'openai',
      auth: null,
      endpointId: null,
      endpointName: null
    })
    expect(storedTraceTarget({ endpoint: 'http://10.0.0.5:8000/api/v1/chat/completions' }).dialect).toBe('openai')
    expect(storedTraceTarget({ endpoint: 'http://127.0.0.1:11434/api/chat' }).dialect).toBe('ollama')
    expect(storedTraceTarget({}).dialect).toBe('ollama')
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
    const err = await replayRequest(null, 'old-box/llama3', { model: 'llama3', messages }).catch((e: Error) => e)
    expect(err).toMatchObject({ message: "This trace's endpoint (old-box) no longer exists." })
    // The registry's error is kept as the cause.
    expect((err as Error).cause).toBeInstanceOf(EndpointGoneError)
    expect((err as Error).cause).toMatchObject({ endpointId: 'old-box' })
    expect(hits.sent).toEqual([])
  })
})
