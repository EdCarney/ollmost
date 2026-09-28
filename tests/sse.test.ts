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
    expect(await drain(body(['data: {"a":1}\n\ndata: {"b":2}\n\ndata: [DONE]\n\n']))).toEqual({
      data: ['{"a":1}', '{"b":2}'],
      sawDone: true
    })
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
    const text =
      ': keep-alive\n\nevent: message\ndata:{"a":1}\nid: 7\nretry: 100\n\n: OPENROUTER PROCESSING\n\ndata: {"b":2}\n\ndata: [DONE]\n\n'
    expect(await drain(body([text]))).toEqual({ data: ['{"a":1}', '{"b":2}'], sawDone: true })
  })

  it('reads CRLF line endings', async () => {
    expect(await drain(body(['data: {"a":1}\r\n\r\ndata: [DONE]\r\n\r\n']))).toEqual({ data: ['{"a":1}'], sawDone: true })
  })

  it('dispatches nothing for an event whose data is empty', async () => {
    expect(await drain(body(['data:\n\ndata: {"a":1}\n\ndata: \n\ndata: [DONE]\n\n']))).toEqual({ data: ['{"a":1}'], sawDone: true })
    expect(await drain(body(['data: {"a":1}\n\ndata:']))).toEqual({ data: ['{"a":1}'], sawDone: false })
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
