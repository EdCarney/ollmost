import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { Endpoint } from '@shared/types'
import { friendlyOpenAIError, OpenAIError, unreachableError } from '../src/main/providers/openai/errors'
import { FIXTURES, fixtureText } from './ollamaMock'

const lm: Endpoint = {
  id: 'lm-studio',
  name: 'LM Studio',
  kind: 'openai',
  flavor: 'lmstudio',
  baseUrl: 'http://localhost:1234/v1',
  enabled: true,
  hasKey: false
}
const gpu: Endpoint = { ...lm, id: 'gpu-box', name: 'GPU box', flavor: 'vllm', baseUrl: 'http://192.168.1.20:8000/v1' }
const box: Endpoint = { ...lm, id: 'box', name: 'Box', flavor: 'llamacpp', baseUrl: 'http://localhost:8080/v1' }

describe('unreachableError', () => {
  it('names the endpoint and its address, with how to start that server', () => {
    expect(unreachableError(lm).message).toBe(
      "Can't reach LM Studio at localhost:1234. Is its server started? Start it in LM Studio’s Developer tab."
    )
    expect(unreachableError(gpu).message).toBe(
      "Can't reach GPU box at 192.168.1.20:8000. Is its server started? Start it with `vllm serve`."
    )
    expect(unreachableError(box).message).toBe("Can't reach Box at localhost:8080. Is its server started? Start it with `llama-server`.")
    expect(unreachableError({ ...lm, name: 'Lab', flavor: 'generic' }).message).toBe(
      "Can't reach Lab at localhost:1234. Is its server started?"
    )
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
    const body = JSON.stringify({
      object: 'error',
      message: 'The model `qwen` does not exist.',
      type: 'NotFoundError',
      param: null,
      code: 404
    })
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
      error: {
        code: 400,
        message: 'the request exceeds the available context size, try increasing it',
        type: 'exceed_context_size_error',
        n_prompt_tokens: 5000,
        n_ctx: 4096
      }
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

  // LM Studio's 400 with nothing loaded never says the model is missing, and with just-in-time loading off it means
  // "load a model": its own words say what to do (capture/FINDINGS.md, Surprises).
  it.runIf(existsSync(join(FIXTURES, 'once/lmstudio-error-unknown-model.json')))(
    'passes LM Studio’s own words through for a 400 with nothing loaded',
    () => {
      const { status } = JSON.parse(readFileSync(join(FIXTURES, 'once/lmstudio-error-unknown-model.meta.json'), 'utf8')) as {
        status: number
      }
      const body = fixtureText('once/lmstudio-error-unknown-model.json')
      expect(friendlyOpenAIError(lm, status, body, 'ollmost-no-such-model').error.message).toBe(
        "LM Studio: No models loaded. Please load a model in the developer page or use the 'lms load' command."
      )
    }
  )
})
