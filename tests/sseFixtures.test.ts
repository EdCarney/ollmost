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
