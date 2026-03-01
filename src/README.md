# LLM Plugin — Source Implementation Guide

Technical reference for the client and server modules that make up the LLM Plugin sidebar.

---

## Architecture Overview

```
llm_plugin.js          Node-RED plugin entry point — loads server.js
llm_plugin.html        Settings template (<script type="text/html">) + CDN links
llm-plugin_styles.css  All plugin CSS
src/
  client.js            Browser entry — sequential script loader
  chat_manager.js      Chat CRUD, server persistence (fetch API)
  importer.js          JSON extraction from LLM output + Node-RED import
  ui_core.js           Message rendering, flow export, retry logic
  settings.js          Settings dialog controller (provider toggle, load/save)
  vibe_ui.js           Main sidebar UI construction + generation workflow
  server.js            All backend logic — endpoints, prompts, LLM adapters
```

### Loading sequence

1. Node-RED loads `llm_plugin.html` which includes CDN resources (Font Awesome, marked.js) and the settings form template.
2. `llm_plugin.html` loads `llm-plugin/src/client.js`.
3. `client.js` dynamically injects the remaining scripts **in order**:
   `chat_manager.js` → `importer.js` → `ui_core.js` → `settings.js` → `vibe_ui.js`
4. `vibe_ui.js` polls for `RED.sidebar` availability, then registers the sidebar tab.

All client modules use the **IIFE pattern** `(function(){ ... })()` and communicate through the shared `window.LLMPlugin` namespace.

---

## Client Modules

### client.js

Minimal sequential script loader. Loads each module via dynamic `<script>` tags. Order matters because later modules depend on earlier ones.

### chat_manager.js

Manages the chat session lifecycle.

| API | Description |
|-----|-------------|
| `ChatManager.getCurrentChatId()` | Returns (or creates) the active chat ID |
| `ChatManager.startNewChat()` | Creates a fresh chat session, clears UI |
| `ChatManager.addMessage(content, isUser)` | Appends message to history + UI + persists |
| `ChatManager.saveChatToServer(chatId)` | `POST /llm-plugin/save-chat` |
| `ChatManager.loadChatHistoriesFromServer()` | `GET /llm-plugin/chat-histories` |
| `ChatManager.loadChat(chatId)` | Replays messages into the chat area |
| `ChatManager.showChatList()` | Builds and shows the chat history modal |
| `ChatManager.deleteChat(chatId, cb)` | `POST /llm-plugin/delete-chat` |

Uses **`fetch`** for all server calls. DOM manipulation uses plain `document.createElement` / `document.getElementById`.

### importer.js

Extracts Node-RED flow JSON from LLM responses and imports it into the editor.

**`extractFlowNodes(messageContent)`** — Main extraction pipeline:
1. Scan for fenced code blocks (` ```json `, ` ``` `, ` ```javascript ` — case-insensitive).
2. Try parsing each block as JSON; pick the **last valid** block (LLMs tend to refine output).
3. Fallback: find raw `[…]` JSON arrays outside code fences.
4. Accepts `{nodes:[…]}`, `[…]`, or single `{type:"…"}` objects.

**`importFlowFromMessage(messageContent)`** — Full import workflow:
1. Extract nodes via `extractFlowNodes`.
2. Generate new IDs only on collision with existing editor nodes.
3. Strip `tab`-type nodes; assign all nodes to the active workspace.
4. Validate node shapes; emit warnings for empty function nodes or missing wires.
5. Call `RED.view.importNodes(nodes)` to inject into the editor canvas.

### ui_core.js

Rendering and utility layer.

- **`escapeHtml(str)`** — XSS protection for the fallback formatter.
- **`formatMessage(text)`** — Uses `marked.parse()` when available; otherwise falls back to a simple regex-based Markdown→HTML converter.
- **`addMessageToUI(content, isUser, showActions)`** — Creates the message DOM element, attaches retry/import buttons.
- **`retryLastUserMessage()`** — Finds the last user message and re-triggers generation.
- **`getCurrentFlow()`** — Exports all nodes on the **active tab** via `RED.nodes.filterNodes({z: activeWorkspace})`.  Uses `RED.nodes.createExportableNodeSet` to strip credentials. Falls back to manual cloning on older Node-RED versions.

### settings.js

Small controller that binds to the settings form defined in `llm_plugin.html`.

- Accepts a **raw DOM element** as `root` (the settings dialog container).
- Returns `{ load, save, updateVisibility }`.
- Provider toggle: shows/hides Ollama URL vs OpenAI API key fields.
- API key is never pre-filled; a masked placeholder is shown instead.

### vibe_ui.js

The main entry module. Builds the entire sidebar DOM tree and wires up all interactive behaviour.

**`createLLMPluginUI()`**
  - Constructs the sidebar layout using HTML string literals (header, chat area, input area, settings overlay).
  - Initialises the settings manager.
  - Schedules `initializeClientApp()` after a short delay.

**`initializeClientApp(settingsManager)`**
  - Binds all event listeners (generate, stop, settings open/close/save, Ctrl+Enter, model chips).
  - Manages the generate/stop toggle using a single click handler + `classList` state.
  - Uses `AbortController` for fetch cancellation (replaces jQuery's `jqXHR.abort()`).
  - Settings dialog: focus management, Escape key, backdrop click.

**`initializeWhenReady()`** — Polls `RED.sidebar` and calls `RED.sidebar.addTab(…)` to register the tab.

---

## Server Module (server.js)

Node.js module loaded by `llm_plugin.js`. Exports `createLLMPluginServer(RED)`.

### Section layout

| Section | Key functions |
|---------|--------------|
| Settings persistence | `getPluginSettings()`, `savePluginSettings()`, `maskApiKey()` |
| Ollama model discovery | `listOllamaModels()` (CLI + HTTP), `listOllamaModelsFromApi()` |
| Recent-model tracking | `saveRecentModel()`, `getRecentModels()` — file-based JSON |
| Chat history persistence | `saveChatHistory()`, `loadAllChatHistories()` — per-chat JSON files |
| Prompt construction | `buildFlowContextDescription()`, `buildPrompt()` |
| LLM adapters | `generateWithOllama()` (HTTP/HTTPS), `generateWithOpenAI()` (SDK) |
| HTTP admin endpoints | All `RED.httpAdmin.*` routes |

### Endpoints

| Method | Path | Purpose |
|--------|------|---------|
| POST | `/llm-plugin/generate` | Send prompt + flow context to LLM |
| GET | `/llm-plugin/settings` | Read settings (API key masked) |
| POST | `/llm-plugin/settings` | Write settings (whitelisted fields) |
| GET | `/llm-plugin/ollama/models` | List available Ollama models |
| GET | `/llm-plugin/chat-histories` | List all persisted chats |
| POST | `/llm-plugin/save-chat` | Persist a chat session |
| POST | `/llm-plugin/delete-chat` | Delete by filename or ID |
| GET | `/llm-plugin/recent-models` | Get recently used model names |
| GET | `/llm-plugin_styles.css` | Serve plugin stylesheet |
| GET | `/llm-plugin/src/:file` | Serve client JS modules |

### Security measures

- **API key**: never returned to the client; masked via `maskApiKey()`. POST whitelist prevents field injection.
- **Path traversal**: `path.basename()` + equality check on file-serving routes.
- **Error sanitisation**: OpenAI SDK errors wrapped in clean `Error` objects; only `.message` logged.
- **Credentials**: stripped from flow context before sending to the LLM.

### Prompt structure

```
You are a Node-RED expert.
RULES: …
FLOW CONTEXT SUMMARY:          ← only if "Send current flow" is checked
  Flow summary: N node(s)
  Types present: inject, function, debug
  Nodes:
    - inject - My Inject (id:abc12345)
    …
  FlowJSON:
    [ { "id": "…", … }, … ]    ← full JSON, no truncation
USER REQUEST: <user prompt>
```

No chat history is sent — each request is stateless from the LLM's perspective.

---

## Data Flow

```
User types prompt
      │
      ▼
  vibe_ui.handleGenerate()
      │  reads model, prompt, checkbox
      │  calls ChatManager.addMessage(prompt, true)
      │  optionally calls UI.getCurrentFlow()
      │
      ▼
  fetch POST /llm-plugin/generate  ──►  server.js
      │                                     │
      │                                buildPrompt(prompt, currentFlow)
      │                                     │
      │                         ┌───────────┴──────────┐
      │                    Ollama adapter         OpenAI adapter
      │                    (HTTP/HTTPS)           (openai SDK)
      │                         └───────────┬──────────┘
      │                                     │
      ◄─────── JSON { response: "…" } ◄────┘
      │
      ▼
  ChatManager.addMessage(response, false)
      │  persists to server (POST /save-chat)
      │  calls UI.addMessageToUI(response, …)
      │     └── Importer.extractFlowNodes(response)
      │            → shows "Import Flow" button if nodes found
      ▼
  Chat area updated
```

---

## Development Notes

- **No jQuery**: All client modules use vanilla DOM APIs and the `fetch` API. jQuery is available in the Node-RED editor environment but is intentionally not used.
- **Module communication**: Via `window.LLMPlugin` namespace (`ChatManager`, `UI`, `Importer`).
- **Adding a new endpoint**: Add the route in the *HTTP admin endpoints* section of `server.js`. Restart Node-RED to apply.
- **Adding a new client module**: Create a new file under `src/`, add it to the load list in `client.js`, and expose its API on `window.LLMPlugin`.
- **Chat storage**: JSON files in `.logs/llm-plugin/chats/` with pattern `YYYY-MM-DD-<title>-<id>.json`.
- **Settings storage**: `RED.settings.get/set('llmPluginSettings')` — persisted in Node-RED's internal config, not in exported flows.