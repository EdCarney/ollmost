# Capture spike findings: LM Studio 0.4.24+1, Ollama 0.34.4 (2026-09-28)

Models: LM Studio tools `google/gemma-4-e4b`, vision `google/gemma-4-e4b`, think `qwen/qwen3.8-27b`. Ollama tools
`gpt-oss:20b`, vision `gemma4:e4b-mlx`, think `gpt-oss:20b`.

- LM Studio's `lms version` prints only the CLI commit (`ff50809`), so the app version comes from
  `/Applications/LM Studio.app` (`CFBundleShortVersionString` 0.4.24+1). The server was on `127.0.0.1:1234`, with
  just-in-time loading on, "unload the previous JIT model on load" on, and a 3600 s TTL. It was run with
  `lms unload --all` first, so every listing starts cold.
- The LM Studio models are the two already on this Mac, set with `LMSTUDIO_TOOLS_MODEL`, `LMSTUDIO_VISION_MODEL` and
  `LMSTUDIO_THINK_MODEL`. The plan's suggested `qwen/qwen3-8b`, `google/gemma-3-4b` and `openai/gpt-oss-20b` were
  downloading at under 100 KB/s, so they weren't used. Between them the two cover every case: gemma-4-e4b calls
  tools, sees images and thinks on/off, and qwen3.8-27b thinks at graded levels. So question 1 covers both kinds of
  reasoning control, while gpt-oss's own parser is not covered.
- The Ollama models are also the ones already installed, set with `OLLAMA_TOOLS_MODEL`, `OLLAMA_VISION_MODEL` and
  `OLLAMA_THINK_MODEL`, instead of the plan's `qwen3:8b` and `gemma3:4b`. According to `/api/show`, gpt-oss:20b does
  `tools` and `thinking`, and gemma4:e4b-mlx does `vision`, `tools` and `thinking`. gpt-oss also takes thinking levels,
  so `think-low` tests something real. Ollama 0.34.4 was signed in to ollama.com, but every request went to local
  models, with no key set. The script listed `qwen3:8b` too (`show-qwen3_8b.json`), because it had been pulled by then.
- The script ran unchanged, with no fixes, in two runs: `node capture.mjs lmstudio`, then `node capture.mjs ollama`.
  `FINDINGS.draft.md` is written from whatever `out/` holds, so the second run's draft covers both.
- Extra requests sent with curl are in `out/lmstudio/extra/`. They are not the script's.
- Reasoning lengths come from single samples. The 27B's requests that change nothing (default, `high`, `xhigh`, the
  `reasoning` object and both kwargs) land between 182 and 192 characters, so read about ±10 as noise.

## LM Studio

1. **What changes reasoning on `/v1/chat/completions`?** Only `reasoning_effort`, and only with OpenAI's values:
   `none, minimal, low, medium, high, xhigh`. The `reasoning: { effort }` object and
   `chat_template_kwargs.enable_thinking` are accepted (200) but change nothing.

   The same prompt ("What is 17 × 23? …"), streamed with `include_usage`, gave:

   | Model | Sent | Status | Reasoning chars | `reasoning_tokens` | File |
   |---|---|---|---|---|---|
   | qwen3.8-27b | (nothing) | 200 | 191 | 76 | `think-default.sse` |
   | qwen3.8-27b | `reasoning_effort: "none"` | 200 | **0** | 0 | `extra/effort-qwen3.8-27b-none.sse` |
   | qwen3.8-27b | `reasoning_effort: "minimal"` | 200 | 70 | 48 | `extra/effort-qwen3.8-27b-minimal.sse` |
   | qwen3.8-27b | `reasoning_effort: "low"` | 200 | 74 | 49 | `think-effort-low.sse` |
   | qwen3.8-27b | `reasoning_effort: "medium"` | 200 | 143 | 64 | `extra/effort-qwen3.8-27b-medium.sse` |
   | qwen3.8-27b | `reasoning_effort: "high"` (not advertised) | 200 | 183 | 70 | `think-effort-high.sse` |
   | qwen3.8-27b | `reasoning_effort: "xhigh"` | 200 | 192 | 77 | `extra/effort-qwen3.8-27b-xhigh.sse` |
   | qwen3.8-27b | `reasoning_effort: "off"` | **400** | — | — | `extra/effort-qwen3.8-27b-off.sse` |
   | qwen3.8-27b | `reasoning_effort: "on"` | **400** | — | — | `extra/effort-qwen3.8-27b-on.sse` |
   | qwen3.8-27b | `reasoning: { effort: "low" }` | 200 | 182 | 73 | `think-reasoning-object.sse` |
   | qwen3.8-27b | `chat_template_kwargs: { enable_thinking: false }` | 200 | 182 | 78 | `think-kwargs-off.sse` |
   | qwen3.8-27b | `chat_template_kwargs: { enable_thinking: true }` | 200 | 191 | 73 | `think-kwargs-on.sse` |
   | gemma-4-e4b | (nothing) | 200 | 373 | 190 | `extra/effort-gemma-4-e4b-default.sse` |
   | gemma-4-e4b | `reasoning_effort: "none"` | 200 | **0** | 0 | `extra/effort-gemma-4-e4b-none.sse` |
   | gemma-4-e4b | `reasoning_effort: "minimal"` | 200 | 400 | 222 | `extra/effort-gemma-4-e4b-minimal.sse` |
   | gemma-4-e4b | `reasoning_effort: "low"` | 200 | 668 | 301 | `extra/effort-gemma-4-e4b-low.sse` |
   | gemma-4-e4b | `reasoning_effort: "off"` | **400** | — | — | `extra/effort-gemma-4-e4b-off.sse` |
   | gemma-4-e4b | `reasoning_effort: "on"` | **400** | — | — | `extra/effort-gemma-4-e4b-on.sse` |

   **The advertised options.** `GET /api/v1/models` reports `capabilities.reasoning`. The objects were the same in
   all three listings (`models-api-v1-before.json`, `-after-load.json`, `-after.json`):
   - `qwen/qwen3.8-27b`: `{"allowed_options":["off","low","medium","xhigh","on"],"default":"xhigh"}`
   - `google/gemma-4-e4b`: `{"allowed_options":["off","on"],"default":"on"}`
   - `text-embedding-nomic-embed-text-v1.5`: no `capabilities` key at all.

   Three things follow:
   - **The vocabularies differ.** `off` and `on` are LM Studio's own words. The OpenAI endpoint rejects both with 400:
     `{"error":{"message":"Invalid 'reasoning_effort' value: 'off'. Supported values: none, minimal, low, medium, high, xhigh.","type":"invalid_request_error","param":"reasoning_effort","code":"invalid_value"}}`.
   - **`none` is the working "off".**
   - **Graded models follow the levels; on/off models ignore them.** On the graded model, reasoning grows in order:
     minimal ≈ low < medium < high ≈ xhigh = default. On the on/off model every value except `none` keeps full
     reasoning.

   The advertised options the script didn't try were `off`, `medium`, `xhigh` and `on` on qwen3.8-27b, and `off` and
   `on` on gemma-4-e4b. Each got one curl. The 400 message then named `none` and `minimal`, which were tried on both
   models, plus `low` on gemma and a no-effort baseline for gemma, because the script only ran the think prompt on the
   27B. The commands, run from `out/lmstudio/extra/` in zsh:

   ```bash
   for pair in 'qwen/qwen3.8-27b off' 'qwen/qwen3.8-27b medium' 'qwen/qwen3.8-27b xhigh' 'qwen/qwen3.8-27b on' \
               'qwen/qwen3.8-27b none' 'qwen/qwen3.8-27b minimal' \
               'google/gemma-4-e4b off' 'google/gemma-4-e4b on' 'google/gemma-4-e4b none' \
               'google/gemma-4-e4b minimal' 'google/gemma-4-e4b low'; do
     m=${pair%% *}; v=${pair##* }; slug=${m#*/}
     curl -sS -N -o "effort-$slug-$v.sse" -w 'HTTP %{http_code} %{time_total}s\n' \
       http://localhost:1234/v1/chat/completions -H 'Content-Type: application/json' \
       -d "{\"model\":\"$m\",\"messages\":[{\"role\":\"user\",\"content\":\"What is 17 × 23? Think it through, then reply with just the number.\"}],\"stream\":true,\"stream_options\":{\"include_usage\":true},\"reasoning_effort\":\"$v\"}"
   done
   # gemma's baseline: the same curl without "reasoning_effort", saved as effort-gemma-4-e4b-default.sse
   ```

   → **Task 3.5:** `openAIThink` for LM Studio should:
   - read the options from `capabilities.reasoning`;
   - send `reasoning_effort: "none"` for `off`;
   - leave the field out for `on` and for the model's `default`;
   - pass `low`/`medium`/`high`/`xhigh` straight through.

   Never send `off` or `on`. One case wasn't tested: a model whose default is `off`, where `on` has no OpenAI value.
   Sending `medium` there is a guess. Don't send `reasoning` or `chat_template_kwargs` to LM Studio: they're silently
   ignored.
2. **Tool calls: deltas or whole?** Deltas, in `tool-single.sse` and `tool-parallel.sse`:
   - **Fragments:** each call comes as exactly two fragments. The first is
     `{"index":0,"id":"330268305","type":"function","function":{"name":"get_weather","arguments":""}}` and the second is
     `{"index":0,"type":"function","function":{"arguments":"{\"city\":\"Paris\"}"}}`. The `id` and `name` come on the
     first fragment only, and the whole arguments string comes in the second.
   - **Parallel calls** are `index` 0 then 1, and one call finishes before the next starts.
   - **Ids** are 9-digit numeric strings (`"456579262"`).
   - **Order:** reasoning deltas come before the calls. A tool-only reply has no `content` delta at all.
   - **The end:** the last chunk before usage is `{"delta":{},"finish_reason":"tool_calls"}`, and the stream ends with
     `data: [DONE]`.
   - **Non-streamed** (`tool-single-once.json`): the whole call has no `index`, and `message.content` is `""`, not
     `null`.

   → **Task 3.4:** the fixtures accumulate by `index`, take `id` and `name` from the first fragment, and concatenate
   `arguments`. Also test arguments split across several fragments, which LM Studio didn't do here but other servers do.
3. **Is `stream_options.include_usage` honoured?** Yes:
   - **`plain.sse`:** after the `finish_reason` chunk comes one chunk with `"choices":[]` and
     `"usage":{"prompt_tokens":22,"completion_tokens":8,"total_tokens":30,"completion_tokens_details":{"reasoning_tokens":0}}`,
     then `data: [DONE]`.
   - **`plain-no-usage.sse`:** without `stream_options` there is no usage anywhere.

   → **Task 3.6:** always send `stream_options: { include_usage: true }`. Read `usage` from the `choices: []` chunk.
   `completion_tokens_details.reasoning_tokens` is there too.
4. **`reasoning` or `reasoning_content`?** `reasoning_content`, in every stream. The delta keys seen were `content`,
   `reasoning_content`, `role` and `tool_calls`. The non-streamed `message` uses `reasoning_content` as well
   (`plain-once.json`, `tool-single-once.json`). → **Task 3.6:** keep `delta.reasoning ?? delta.reasoning_content`, and
   note that the LM Studio fixtures exercise `reasoning_content`.
5. **Is `content: ''` accepted next to `tool_calls`?** Yes: `history-empty-content.sse` is 200 and replies "The weather
   in Paris is currently sunny and 21°C." `null` is accepted too (`history-null-content.sse`, 200). The replayed id
   `c00000000` was matched without trouble. → **Task 3.5:** send `''`. It works here and matches what LM Studio itself
   returns (`tool-single-once.json`).
6. **Does `loaded_instances[].config.context_length` appear after a just-in-time load?** Yes:
   - **`models-api-v1-before.json`:** every `loaded_instances` is `[]`.
   - **`models-api-v1-after-load.json`, after gemma's just-in-time load:**
     `[{"id":"google/gemma-4-e4b","config":{"context_length":131072,"parallel":4,"reasoning_budget_message":""},"remaining_ttl_seconds":3600}]`.
     That equals its `max_context_length`.
   - **`models-api-v1-after.json`, after the 27B's load:** `context_length` is **42496**, against
     `max_context_length` 262144. Gemma's instance is gone, because the previous just-in-time model was unloaded.
     LM Studio picked 42496 itself; none of this Mac's saved per-model configs set it.

   → **Task 3.7:** prefer `loaded_instances[0].config.context_length` whenever a model is loaded. When it isn't loaded,
   `max_context_length` is only an upper bound, and the next load may use far less.

## Ollama

O1. **Do native tool calls carry `id` / `function.index`?** Yes, both. In `tool-single.ndjson`:
    `{"id":"call_gbmhusmk","function":{"index":0,"name":"get_weather","arguments":{"city":"Paris"}}}`.
    - **Id shape:** `id` is `call_` plus 8 lowercase letters, and `index` sits inside `function`, not beside it.
    - **Whole, in the final chunk:** the call comes whole (`arguments` is an object) and only in the final
      `"done":true` chunk, which has `"done_reason":"stop"`, not `tool_calls`.
    - **The parallel prompt made only one call:** in `tool-parallel.ndjson`, gpt-oss thought for 3163 chars, then
      called only for Paris. So the Ollama recordings have no `index: 1` call, and LM Studio's `tool-parallel.sse`
      is the only parallel fixture.

    → PR 1 echoes the calls exactly either way. PR 4's debugger can show Ollama's own `id`. Ollmost can't use
    `done_reason` to tell a tool turn from a text turn; it has to look for `tool_calls`.
O2. **Does `/api/chat` accept `tool_call_id`?** Yes, it doesn't reject it:
    - **Both variants work:** `history-tool-name.ndjson` (today's shape: `tool_name` and no ids) and
      `history-tool-call-id.ndjson` (with `id` on the call and `tool_call_id` on the result) are both HTTP 200.
    - **The replies match:** both are right: "In Paris right now it’s sunny with a temperature of **21 °C**." and
      "The weather in Paris right now is **sunny** with a temperature of **21 °C**."
    - **Can't tell whether it's used:** with one call, the capture can't show whether Ollama reads the id or ignores
      it.

    → Sending `tool_call_id` to Ollama is safe. Keep `tool_name` too, because that's the field Ollama is known to use.
O3. **Which durations does the final chunk carry for a local model?** All four, in nanoseconds:
    - **The fields:** `total_duration`, `load_duration`, `prompt_eval_duration` and `eval_duration`, plus
      `prompt_eval_count`, `prompt_eval_cached_count` (new since the plan was written) and `eval_count`.
    - **Example:** `plain.ndjson`'s cold load had `"load_duration":5076284041` and `"eval_duration":7650494000`
      for `"eval_count":254`.
    - **Same for tool turns:** `tool-single.ndjson` has the same keys.

    → Local Ollama replies keep their exact tok/s (`eval_count / eval_duration`), and PR 3's wall-clock fallback isn't
    needed for them.

Ollama's thinking control, which isn't one of the plan's questions but matters for Task 3.5:
- **`think: 'low'` works on gpt-oss:** 18 thinking chars (`think-low.ndjson`), against 244 for `think: true`
  (`think-on.ndjson`).
- **`think: false` is ignored by gpt-oss:** 225 chars (`think-off.ndjson`), a full think.
- **Leaving `think` out still thinks:** `plain.ndjson` has 823 chars of `message.thinking`.
- **Thinking goes in its own field:** it is always `message.thinking`, never in `content`, across every case.
  gemma4:e4b-mlx thinks too, 348 chars before answering "Red" in `image.ndjson`.

## Surprises

- **An unknown model name isn't an error while a model is loaded.** `error-unknown-model.json` is **HTTP 200**: LM
  Studio answered `ollmost-no-such-model` with the loaded model, and only the body's `"model":"qwen/qwen3.8-27b"` shows
  it. With nothing loaded, the same request (`extra/error-unknown-model-cold.json`) is **400**
  `{"error":{"message":"No models loaded. Please load a model in the developer page or use the 'lms load' command.","type":"invalid_request_error","param":"model","code":null}}`.
  That message never says the model doesn't exist. → PR 3 should compare the response's `model` with the key it asked
  for, and treat a 400 with `param: "model"` as "this model isn't available".
- **Errors use OpenAI's shape:** `{"error":{"message","type","param","code"}}`, `Content-Type: application/json`.
  Mid-stream errors weren't seen.
- **Every network chunk is exactly one event on localhost**, for both servers: all 13 LM Studio `.sse` files and all 9
  Ollama `.ndjson` files. No chunk ended mid-event or held two. So the recorded splits never exercise the parser's
  buffering, and Task 3.1's mock should add artificial splits.
- **The SSE framing is plain:** `data: <json>` lines, each event followed by a blank line, ending in `data: [DONE]`.
  There are no `event:` lines, `:` comments or keep-alives.
- **A just-in-time load delays the first byte:** 11.5 s for gemma-4-e4b (`plain.meta.json`) and 11.3 s for the 27B
  (`think-default.meta.json`), against under 1 s once loaded. Ollama's cold gpt-oss:20b took 5.7 s
  (`ollama/plain.meta.json`). Bigger models will take longer, so the adapter's first-byte timeout must allow for a load.
- **Qwen's content after reasoning starts with `"\n\n"`** (the content is `"\n\n391"`), and so does the non-streamed
  unknown-model reply. Gemma's doesn't. Leading blank lines in `content` should be trimmed or rendered harmlessly.
- **Text replies end with an empty delta:** a `{"content":""}` delta comes right before the `{"delta":{}, "finish_reason":"stop"}`
  chunk. The first delta carries `role` together with the first `reasoning_content` or `content`.
- **`/v1/models` lists the embedding model** (`text-embedding-nomic-embed-text-v1.5`) with no type. Only `/api/v1/models`
  has `type: "embedding"`. `/api/v0/models` has `type: "vlm"` for vision models and `capabilities: ["tool_use"]`, but
  nothing about reasoning. → Task 3.7 should use `/api/v1/models`.
- **Non-streamed replies also carry** `"stats": {}`, `"tool_calls": []` (even without tools) and `system_fingerprint`
  equal to the model key.
- **The plan's script fails CI's lint and format checks as written**, though it runs fine. `eslint .` reported 30
  `no-undef` errors for `process` and `console`, because `docs/**` gets no Node globals. `prettier --check .` flagged
  its long lines. The script stays exactly as the plan wrote it. Instead, this folder is added to `.prettierignore` and
  to `eslint.config.mjs`'s `ignores`, like `out/`. With that, `eslint . --max-warnings 0` and `prettier --check .` pass
  on this branch.
