# OrbiterX Architecture & Request Flow

This document details the complete end-to-end architecture and request flow between the **OrbiterX App**, **Gateway**, **OGX Server**, and **LLM Backends**.

---

## 🏛️ System Overview

```text
┌────────────────────────┐     /v1/responses     ┌────────────────────────┐
│                        │ ─────────────────────> │                        │
│      OrbiterX App      │                        │        Gateway         │
│  (TUI / Rust App-Server)│ <───────────────────── │  (Railway Proxy / Auth)│
└────────────────────────┘      SSE Stream        └───────────┬────────────┘
                                                              │
                                                /v1/responses │
                                                 (Reverse     │
                                                  Proxy)      ▼
┌────────────────────────┐     /v1/chat/compl    ┌────────────────────────┐
│                        │ <───────────────────── │                        │
│      LLM Backend       │                        │       OGX Engine       │
│  (Ollama / vLLM / etc.)│ ─────────────────────> │   (Port 8321 / Core)   │
└────────────────────────┘      SSE Stream        └────────────────────────┘
```

---

## 🔄 Detailed Step-by-Step Request Lifecycle

### 1. Client Trigger (OrbiterX App)
- The user enters a prompt or triggers an agent action (e.g. `"Spawn a sub-agent to inspect repo"`).
- The Rust App-Server creates an OpenAI Responses API request (`POST /v1/responses`) with:
  - `instructions` — System prompt & guidelines.
  - `input` — Conversation items (`message`, `function_call`, `function_call_output`).
  - `tools` — Tool definitions, including sub-agent tools packaged in a `namespace` container:
    ```json
    {
      "type": "namespace",
      "namespace": "multi_agent_v1",
      "tools": [
        { "type": "function", "name": "spawn_agent", ... },
        { "type": "function", "name": "list_agents", ... }
      ]
    }
    ```

---

### 2. Gateway Layer (`gateway.py`)
*Repository: `railway-gateway-repo` (`https://github.com/vasugeddavalasa31-dotcom/railway-gateway.git`)*

- **Security & Protection Checks:**
  - **Bearer Token Auth:** Validates `GATEWAY_SECRET` if enabled.
  - **Rate Limiting:** Enforces sliding-window per-IP limits (`MAX_TURNS_PER_MIN`) and global concurrency limits (`MAX_CONCURRENT_IP`).
  - **Body Size Guard:** Rejects payloads exceeding `MAX_BODY_BYTES` (512 KB).
- **Reverse Proxying:**
  - Streams the `/v1/responses` request payload directly to `OGX_URL/v1/responses` without modifying the JSON body or headers.
  - Returns `StreamingResponse` (`text/event-stream`) directly back to the caller.
- **Monitoring & Auto-Scaling:**
  - Exposes `/health` and `/metrics` (Prometheus text exposition format) for cloud auto-scalers.

---

### 3. OGX Engine (`ogx`)
*Repository: `ogx` (`https://github.com/vasugeddavalasa31-dotcom/ogxraiwy.git`)*

- **Responses API Provider (`inline::builtin`):**
  - Receives `POST /v1/responses` on port `8321`.
  - Parses input tools schema via `OpenAIResponseInputToolNamespace`.
  - Recognizes `spawn_agent` and `list_agents` inside `type: "namespace"` containers as valid **client-side function calls**.
- **Context Management & Storage:**
  - Persists turn state and conversation history to SQLite / PostgreSQL.
  - Applies context window pruning (`prune_chat_messages_for_context`).
- **Protocol Translation:**
  - Converts `/v1/responses` items into OpenAI `/v1/chat/completions` format.
  - Prefixes namespaced tools as `multi_agent_v1__spawn_agent`.
  - Dispatches the request to the configured model's backend.

---

### 4. LLM Backend (Ollama / vLLM / OpenAI)
- Processes the chat completion prompt.
- Generates completion text or tool call (e.g. `multi_agent_v1__spawn_agent`).
- Streams completion deltas back to OGX.

---

### 5. Return Execution Loop
- OGX translates ChatCompletions deltas back into Responses API SSE events (`response.output_item.added`, `function_call`).
- Gateway proxies the raw SSE bytes directly back to OrbiterX App-Server.
- OrbiterX App-Server receives the `function_call` event and executes `spawn_agent` locally in Rust.
- On completion, OrbiterX submits the `function_call_output` item to initiate the next turn.

---

## 🛠️ Component Responsibility Matrix

| Component | Repository | Primary Role |
| :--- | :--- | :--- |
| **OrbiterX App** | `rustorbiterx` | UI, session state, local tool execution (`spawn_agent`, `shell`, `read_file`). |
| **Gateway** | `railway-gateway-repo` | Rate limiting, bearer auth, body guard, metrics, reverse proxy. |
| **OGX** | `ogx` | Responses API engine, model router, memory vector store, history persistence. |
| **LLM Backend** | *External (Ollama/vLLM)* | Token generation & tool call output generation. |
