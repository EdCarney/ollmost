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
      // An event with no data, or only an empty `data:`, dispatches nothing, as the SSE spec says.
      const payload = data.join('\n')
      data = []
      return payload === '' ? null : payload
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
