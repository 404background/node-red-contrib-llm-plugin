# `llm-request` node

The node registered alongside the LLM Plugin sidebar (palette category
**llm-plugin**) so a flow can call an LLM: `msg.payload` goes in, the model's
reply comes out on `msg.payload`. Provider, model and an optional system prompt
are set on the node; API keys and URLs are inherited from the **LLM Plugin
sidebar** (Settings).

The node does not edit flows. An earlier design had an **Agent** mode that
applied the reply to the open editor; it was withdrawn before release because
an edit made from inside a running flow is hard to debug, and a plain
request/reply node is the more useful building block. The last version that
had it is commit `2c0e3e9` (`node/llm-request/`, `src/agent_apply.js`,
`src/agent_dispatch.js`, `node/lib/admin_api.js`). Editing flows with an LLM is
the sidebar's job.

## Configuring an `llm-request` node

| Field | Notes |
|-------|-------|
| Provider | Ollama / OpenAI / Custom. Keys & URLs come from the sidebar. |
| Model | Free text (e.g. `llama3.1`, `gpt-5-mini`); **required**. `msg.model` overrides per message. |
| System | Optional system prompt sent with every request. `msg.system` overrides it per message (an empty string sends none). The sidebar's own system prompt is **not** used: it is about editing flows. |
| Timeout | Seconds; default **3600** (1 h — local LLMs can be slow). `0` = no limit. `msg.timeout` overrides per message. |

**Inputs:** `payload` (the prompt, sent as given; objects are JSON-stringified),
and optionally `system`, `model`, `timeout`.
**Outputs:** `payload` (the reply text) and `llm` (`{ provider, model, elapsed }`,
elapsed in ms). Every other property of the message passes through.

**Status:** blue dot while requesting (ticks the elapsed seconds), green
`done (…)` on success, red `error` / `timeout` on failure. An error goes to
`done(err)` — a Catch node sees it — with any API key redacted from the text.

## What goes to the provider

One request per message: the system prompt (if any) and the prompt, nothing
else — the plugin adds no prompt of its own, no flow context, no chat history,
and no length limit (the sidebar's prompt limit does not apply).

| Provider | API |
|----------|-----|
| OpenAI | The **Responses API** (`POST /v1/responses`), streamed. The system prompt is sent as `instructions`. `store: false`, so OpenAI does not keep the response. Newer models are served through this API, some only through it. |
| Custom | **Chat completions** (`POST {Base URL}/chat/completions`), streamed — what OpenAI-compatible servers (llama.cpp, LM Studio, vLLM, LocalAI, …) speak. |
| Ollama | `POST /api/chat`, streamed. |

Every adapter streams, because an unstreamed reply over 300 s dies waiting for
headers. A stream that ends without its end marker is reported as an error
rather than passed on as a short reply; so is an OpenAI response that ends
`incomplete` (e.g. `max_output_tokens`) — the reason is in the error.

## Files

```
node/
  llm-request/llm-request.js    runtime side: msg -> prompt, provider call, msg out
  llm-request/llm-request.html  editor side: the config dialog and the help panel
```

The shared LLM engine (settings, credentials, provider adapters, redaction)
lives in [`src/llm_core.js`](../../src/llm_core.js) and is reused by the
sidebar. The node owns only what is node-shaped: `msg` in, status, timeout,
config.

## Example

**Menu → Import → Examples → llm-plugin → llm-nodes**: two `llm-request` nodes,
a plain question and a translator driven by a system prompt (core nodes only).
Set a model on both before deploying.
