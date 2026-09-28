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

  it('sends LM Studio reasoning_effort: none for a toggle turned off, and no chat_template_kwargs', () => {
    const b = toOpenAIBody(
      { ...base, profile: { kind: 'toggle' }, think: 'off' },
      { stream: true, streamOptions: true, flavor: 'lmstudio' }
    )
    expect(b).toMatchObject({ reasoning_effort: 'none' })
    expect(b).not.toHaveProperty('chat_template_kwargs')
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

  it('other flavours keep the plain OpenAI mapping', () => {
    expect(openAIThink({ kind: 'toggle' }, 'off', 'vllm')).toEqual({ chat_template_kwargs: { enable_thinking: false } })
    expect(openAIThink({ kind: 'levels', canDisable: true }, 'off', 'llamacpp')).toEqual({ reasoning_effort: 'low' })
  })

  it('LM Studio: none is the working off; kwargs and the reasoning object are ignored, so a level goes straight through', () => {
    expect(openAIThink({ kind: 'toggle' }, 'off', 'lmstudio')).toEqual({ reasoning_effort: 'none' })
    expect(openAIThink({ kind: 'toggle' }, null, 'lmstudio')).toEqual({ reasoning_effort: 'none' })
    // Any value but none keeps an on/off model reasoning, so medium turns on one whose default is off too.
    expect(openAIThink({ kind: 'toggle' }, 'on', 'lmstudio')).toEqual({ reasoning_effort: 'medium' })
    expect(openAIThink({ kind: 'levels', canDisable: true }, 'off', 'lmstudio')).toEqual({ reasoning_effort: 'none' })
    expect(openAIThink({ kind: 'levels', canDisable: true }, 'high', 'lmstudio')).toEqual({ reasoning_effort: 'high' })
    expect(openAIThink({ kind: 'levels', canDisable: false }, null, 'lmstudio')).toEqual({ reasoning_effort: 'medium' })
    expect(openAIThink({ kind: 'always' }, 'on', 'lmstudio')).toEqual({})
  })
})
