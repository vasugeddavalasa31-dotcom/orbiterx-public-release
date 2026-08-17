import type {
  EventStream,
  EventStreamSubscription,
  AttachHandlers,
  Transport,
  UnsubscribeFn,
} from "./types"
import {
  segmentToolName,
  splitChainedCommandWithOutputs,
  synthesizeSegmentInput,
} from "@/lib/shell-command-split"
import { convIdFromThreadId, folderIdFromPath } from "@/lib/app-server-ids"
import { beginOrbiterxOAuth } from "@/lib/auth-oauth"
import { classifyCollabOp, COLLAB_OP_KEY } from "@/lib/collab-tool"
import { useConversationRuntimeStore } from "@/stores/conversation-runtime-store"
import { buildBaseInstructions } from "@/lib/orbiterx-base-instructions"
import { normalizeStatus } from "@/lib/plan-parse"

/**
 * The app-server rejects `thread/read` with `includeTurns` on a brand-new
 * thread before its first user message ("thread … is not materialized yet").
 * That's a normal "no content yet" state — retrying only burns time and spams
 * the console, so callers treat it as an empty thread.
 */
function isThreadNotMaterializedError(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    typeof (err as { message?: unknown }).message === "string" &&
    /not materialized yet/i.test((err as { message: string }).message)
  )
}

/**
 * Strip internal model-context fragments (e.g. the `<subagent_notification>…`
 * envelope the backend injects so the parent model learns a sub-agent
 * finished) from user-visible text. These are MODEL context — never chat
 * content — and must not render as messages/cards in the UI.
 */
function stripSubagentNotificationFragments(text: string): string {
  return text
    .replace(/<subagent_notification>[\s\S]*?<\/subagent_notification>/g, "")
    .trim()
}

function makeAgentInfo(
  agentType: string,
  name: string,
  desc: string,
  sortOrder: number
) {
  return {
    agent_type: agentType,
    registry_id: agentType,
    registry_version: "2.0.0",
    name,
    description: desc,
    available: true,
    enabled: true,
    distribution_type: "builtin",
    sort_order: sortOrder,
    installed_version: "2.0.0",
    env: {},
    config_json: null,
    config_file_path: null,
    opencode_auth_json: null,
    codex_auth_json: JSON.stringify({
      tokens: {
        access_token: "orbiterx_valid_token",
        id_token: "orbiterx_valid_token",
        refresh_token: "orbiterx_valid_token",
        account_id: "orbiterx_user",
      },
    }),
    codex_config_toml: null,
    codex_model_catalog: null,
    codex_sandbox_settings: null,
    cline_secrets_json: null,
    hermes_config_yaml: null,
    grok_config_toml: null,
    grok_settings: null,
    cursor_cli_config_json: null,
    cursor_settings: null,
    model_provider_id: null,
  }
}

/**
 * Map a frontend `permission_mode` selector value to the app-server
 * `AskForApproval` wire enum (kebab-case: `untrusted` | `on-request` |
 * `granular` | `never`). The app-server rejects unknown variants with a
 * "unknown variant" serde error, so legacy labels from older builds
 * (`default` / `auto` / `full_auto` / `read_only`) are normalized here —
 * a stale saved selection must never break `turn/start`.
 */
function toApprovalPolicyWire(
  mode: string | undefined
): string | Record<string, unknown> | null {
  switch (mode) {
    case "never":
    case "full_auto":
      return "never"
    case "untrusted":
    case "default":
      return "untrusted"
    case "on-request":
    case "auto":
    case "read_only":
      return "on-request"
    case "granular":
      // The wire enum's `Granular` variant is a STRUCT
      // (`{ granular: { sandbox_approval, rules, mcp_elicitations, … } }`),
      // not a bare string — sending `"granular"` fails thread/start with
      // "invalid type: unit variant, expected struct variant". Enable the
      // per-category approval prompts so the UI's granular mode behaves like
      // "ask on each category".
      return {
        granular: {
          sandbox_approval: true,
          rules: true,
          mcp_elicitations: true,
          skill_approval: true,
          request_permissions: true,
        },
      }
    default:
      return null
  }
}

/** Decisions we can answer without extra payload fields. The
 *  `AcceptWithExecpolicyAmendment` / `ApplyNetworkPolicyAmendment` variants
 *  carry required payloads we can't reconstruct from the dialog, so they are
 *  filtered out (the server falls back to Decline when it can't parse). */
const SIMPLE_PERMISSION_DECISIONS = new Set([
  "accept",
  "acceptForSession",
  "decline",
  "cancel",
])

/** Human-readable labels for `CommandExecutionApprovalDecision` / related
 *  decision enums, used to render the app-server approval dialog's buttons. */
const PERMISSION_DECISION_NAMES: Record<string, string> = {
  accept: "Allow",
  acceptForSession: "Allow for this session",
  decline: "Deny",
  cancel: "Cancel and interrupt",
}

/** Default decision options when the server request carries no
 *  `availableDecisions` list. option_id is the wire decision value, echoed
 *  straight back in the response. */
function defaultPermissionOptions(
  method: string
): Array<{ option_id: string; name: string; kind: string }> {
  if (method === "item/commandExecution/requestApproval") {
    return [
      { option_id: "accept", name: "Allow", kind: "allow_once" },
      {
        option_id: "acceptForSession",
        name: "Allow for this session",
        kind: "allow_always",
      },
      { option_id: "decline", name: "Deny", kind: "reject_once" },
      {
        option_id: "cancel",
        name: "Cancel and interrupt",
        kind: "reject_always",
      },
    ]
  }
  return [
    { option_id: "accept", name: "Allow", kind: "allow_once" },
    { option_id: "decline", name: "Deny", kind: "reject_once" },
  ]
}

/** Build the `tool_call` payload for a `permission_request` envelope from an
 *  app-server `*RequestApproval` params object, shaped for the existing
 *  `parsePermissionToolCall` parser (reads `raw_input` / `command` / `cwd` /
 *  `reason`). */
function buildApprovalToolCall(method: string, params: any): unknown {
  if (method === "item/commandExecution/requestApproval") {
    return {
      kind: "command_execution",
      raw_input: {
        command: params?.command ?? null,
        cwd: params?.cwd ?? null,
        reason: params?.reason ?? null,
      },
      ...(params?.reason ? { content: params.reason } : {}),
    }
  }
  if (method === "item/fileChange/requestApproval") {
    return {
      kind: "file_change",
      raw_input: {
        reason: params?.reason ?? null,
        grant_root: params?.grantRoot ?? null,
      },
    }
  }
  return {
    kind: "permissions",
    raw_input: { reason: params?.reason ?? null },
  }
}

/** Fallback collaboration modes when `collaborationMode/list` is unreachable.
 *  Ids are the real wire `ModeKind` values (`plan`/`default`), NOT the legacy
 *  fake `code`/`architect` labels the transport used to hardcode. */
const FALLBACK_MODES: Array<{
  id: string
  name: string
  description: string
}> = [
  {
    id: "default",
    name: "Default",
    description: "Read and edit files, and run commands.",
  },
  {
    id: "plan",
    name: "Plan",
    description: "Plan first, then implement after review.",
  },
]

/** Slash commands advertised to the composer "/" menu. Mirrors the TUI's
 *  `SlashCommand` set. Serialized to literal `/name` prompt text on send (the
 *  agent/CLI parses the token); goal/review/compact also have dedicated RPCs
 *  wired separately. */
const ORBITERX_AVAILABLE_COMMANDS: Array<{
  name: string
  description: string
  input_hint?: string
}> = [
  {
    name: "goal",
    description: "set or view the goal for a long-running task",
  },
  {
    name: "review",
    description: "review my current changes and find issues",
  },
  {
    name: "compact",
    description: "summarize conversation to prevent hitting the context limit",
  },
  {
    name: "status",
    description: "show current session configuration and token usage",
  },
  {
    name: "model",
    description: "choose what model and reasoning effort to use",
    input_hint: "<model>",
  },
  {
    name: "personality",
    description: "choose a communication style for OrbiterX",
  },
  {
    name: "permissions",
    description: "choose what OrbiterX is allowed to do",
  },
  {
    name: "plan",
    description: "switch to Plan mode",
  },
  {
    name: "skills",
    description: "use skills to improve how OrbiterX performs specific tasks",
  },
  {
    name: "mcp",
    description: "list configured MCP tools",
  },
  {
    name: "diff",
    description: "show git diff (including untracked files)",
  },
  {
    name: "rename",
    description: "rename the current thread",
    input_hint: "<name>",
  },
  {
    name: "fork",
    description: "fork the current chat",
  },
  {
    name: "copy",
    description: "copy last response as markdown",
  },
]

/** Personality select option values (mirror of backend `Personality` enum:
 *  `none` | `friendly` | `pragmatic`, lowercase on the wire). */
const PERSONALITY_OPTIONS: Array<{
  value: string
  name: string
  description: string
}> = [
  {
    value: "none",
    name: "Default",
    description: "Standard communication style",
  },
  {
    value: "friendly",
    name: "Friendly",
    description: "Warmer, more conversational tone",
  },
  {
    value: "pragmatic",
    name: "Pragmatic",
    description: "Direct, results-focused tone",
  },
]

export class OrbiterXTransport implements Transport {
  private baseUrl: string
  private ws: WebSocket | null = null
  private eventListeners: Set<(event: any) => void> = new Set()
  /** Connection-health subscribers (React via useSyncExternalStore). `true`
   *  while the persistent WS is open and initialized; flips false on close so
   *  the UI can show "reconnecting" instead of silently pretending the link is
   *  up. Never called during SSR (no socket exists). */
  private connectionSubscribers: Set<() => void> = new Set()
  private _wsConnected = false
  private pendingRpc: Map<
    number,
    { resolve: (val: any) => void; reject: (err: any) => void }
  > = new Map()
  /** Server→client JSON-RPC requests awaiting our response (approval prompts
   *  and `request_user_input` question prompts). Keyed by the id shipped in the
   *  `permission_request` / `question_request` envelope; stores the wire `id`
   *  to echo back in the response frame. `questionIds` is present only for
   *  question prompts (the per-question answer map in the response). */
  private pendingServerRequests = new Map<
    string,
    { id: unknown; responded?: boolean; questionIds?: string[] }
  >()
  private activeThreadId: string | null = null
  private activeTurnId: string | null = null
  /** Active turn id PER THREAD. Sub-agents run their own turns on their own
   *  threads; a single global `activeTurnId` gets clobbered by the child's
   *  `turn/started`, so `acp_cancel` would interrupt the parent thread with
   *  the CHILD's turn id → server rejects ("expected active turn id X but
   *  found Y") and the Stop button silently fails mid-sub-agent-run. */
  private activeTurnIdByThread: Map<string, string> = new Map()
  private connectionThreadMap: Map<string, string> = new Map()
  public seqCounter = 10
  public streamInstance: EventStream | null = null
  private sse: EventSource | null = null
  private _fallbackConvSeq = 0
  /** Maps the numeric conversation ids we mint for sidebar tabs back to the
   *  app-server thread UUIDs, so `get_folder_conversation` can resolve a
   *  numeric id to the `thread/read` target. */
  private _threadIdByConvId: Map<number, string> = new Map()
  /** Sub-agent thread UUIDs minted from live `collabAgentToolCall` items, so
   *  "open session as a tab" can resolve the child thread even though it never
   *  appears in `thread/list` (children are parent-scoped). */
  private childThreadIds: Set<string> = new Set()
  /** Sub-agent thread → its parent (main) session thread. Populated from the
   *  collab `senderThreadId` + `receiverThreadIds` so a sub-agent conversation
   *  tab can offer "Back to main session". */
  private childParentThreadIds: Map<string, string> = new Map()
  /** Sub-agent thread → the collab SPAWN item id (the `delegation_started`
   *  `parent_tool_use_id`). `DelegationProvider` indexes bindings by that id,
   *  so a later `wait`/`closeAgent` completion must emit
   *  `delegation_completed` against it — using the wait/close item's own id
   *  would miss the binding and leak the child's synthetic connection. */
  private spawnToolUseIdByChild: Map<string, string> = new Map()

  /** localStorage key for persisted child-thread registrations. Children are
   *  NOT in `thread/list` and have no Tauri DB row — they only exist via this
   *  registry, so without persistence a reload/recompile loses the mapping and
   *  reopening a sub-agent session shows "Loading…" forever (the numeric id
   *  can't resolve to `thread/read`). */
  private static CHILD_REGISTRY_KEY = "orbiterx:child-thread-registry:v1"

  /** Register a sub-agent thread so `get_folder_conversation` can resolve its
   *  numeric id to a `thread/read` even though `thread/list` omits children.
   *  `parentThreadId` (when known) links the child back to its main session.
   *  Persisted so the mapping survives reloads/recompiles. */
  registerChildThread(threadId: string, parentThreadId?: string): void {
    if (!threadId) return
    this.childThreadIds.add(threadId)
    const convId = convIdFromThreadId(threadId)
    this._threadIdByConvId.set(convId, threadId)
    if (parentThreadId) {
      this.childParentThreadIds.set(threadId, parentThreadId)
    }
    this.persistChildRegistry()
    try {
      useConversationRuntimeStore
        .getState()
        .actions.setExternalId(convId, threadId)
    } catch {}
  }

  private persistChildRegistry(): void {
    if (typeof window === "undefined") return
    try {
      window.localStorage.setItem(
        OrbiterXTransport.CHILD_REGISTRY_KEY,
        JSON.stringify({
          threadIds: Array.from(this.childThreadIds),
          parents: Array.from(this.childParentThreadIds.entries()),
        })
      )
    } catch {
      // Storage unavailable (private mode) — registry stays in-memory only.
    }
  }

  private restoreChildRegistry(): void {
    if (typeof window === "undefined") return
    try {
      const raw = window.localStorage.getItem(
        OrbiterXTransport.CHILD_REGISTRY_KEY
      )
      if (!raw) return
      const parsed = JSON.parse(raw)
      const threadIds: string[] = Array.isArray(parsed?.threadIds)
        ? parsed.threadIds
        : []
      const parents: [string, string][] = Array.isArray(parsed?.parents)
        ? parsed.parents
        : []
      for (const threadId of threadIds) {
        if (typeof threadId !== "string" || !threadId) continue
        this.childThreadIds.add(threadId)
        this._threadIdByConvId.set(convIdFromThreadId(threadId), threadId)
      }
      for (const [threadId, parentId] of parents) {
        if (typeof threadId !== "string" || typeof parentId !== "string")
          continue
        this.childParentThreadIds.set(threadId, parentId)
      }
    } catch {
      // Corrupt/absent — ignore.
    }
  }

  /** The main session thread a sub-agent belongs to, or null. */
  parentThreadIdOfChild(threadId: string): string | null {
    return this.childParentThreadIds.get(threadId) ?? null
  }

  /** Whether a numeric conversation id maps to a registered sub-agent thread
   *  or app-server thread UUID (absent from the Tauri SQLite DB). */
  isChildThreadConvId(convId: number): boolean {
    const threadId = this._threadIdByConvId.get(convId)
    return threadId != null
  }

  /** Whether a thread UUID is a registered sub-agent child thread (minted from
   *  live/history `collabAgentToolCall` items or restored from the persisted
   *  child registry). Child-thread connections must stream their delegated run
   *  even when the attach misses the child's prompting status event — see the
   *  connection-context out-of-turn guard exemption. */
  isChildThreadId(threadId: string): boolean {
    return (
      this.childThreadIds.has(threadId) ||
      this.childParentThreadIds.has(threadId)
    )
  }

  /** Resolve a numeric conversation id back to its thread UUID (registered
   *  children or normal app-server threads). */
  getThreadIdByConvId(convId: number): string | null {
    return this._threadIdByConvId.get(convId) ?? null
  }

  /** Sub-agent nicknames (e.g. "Galileo", "Dewey") resolved lazily from
   *  `thread/read` and cached, so the collab capsule can show a friendly name
   *  instead of the raw thread id. Single in-flight lookup per thread. */
  private childNicknames = new Map<string, string>()
  private childNicknameInflight = new Set<string>()
  private nicknameSubscribers: Set<() => void> = new Set()

  /** Subscribe to nickname-cache changes (React useSyncExternalStore). */
  subscribeChildNicknames(callback: () => void): UnsubscribeFn {
    this.nicknameSubscribers.add(callback)
    return () => {
      this.nicknameSubscribers.delete(callback)
    }
  }

  /** Current cached nickname for a sub-agent thread, or `null` when unknown. */
  getChildNickname(threadId: string): string | null {
    const cached = this.childNicknames.get(threadId)
    if (cached === undefined || cached === "") return null
    return cached
  }

  /** Resolve a registered sub-agent thread's nickname (best-effort, cached).
   *  Returns immediately with the cached value or `null`; when unknown it kicks
   *  a single in-flight `thread/read` and notifies subscribers on arrival. The
   *  backend mints the name (`agentNickname`) at spawn — there is NO frontend
   *  fallback: a locally-invented name shown while the real one resolves makes
   *  the UI disagree with the running agent (e.g. "Galileo" vs the backend's
   *  "Leibniz"). Unknown ids stay nameless so the real name is the only one
   *  ever rendered. */
  resolveChildNickname(threadId: string): string | null {
    if (!threadId) return null
    const current = this.getChildNickname(threadId)
    if (current !== null) return current
    if (this.childNicknameInflight.has(threadId)) return null
    this.childNicknameInflight.add(threadId)
    this.rpcOverFreshWs("thread/read", { threadId, includeTurns: false })
      .then((res) => {
        const nickname = res?.thread?.agentNickname ?? null
        if (typeof nickname === "string" && nickname.length > 0) {
          this.childNicknames.set(threadId, nickname)
          this.nicknameSubscribers.forEach((cb) => cb())
        } else {
          // No backend name — cache empty so a later resolve can retry.
          this.childNicknames.set(threadId, "")
          this.nicknameSubscribers.forEach((cb) => cb())
        }
      })
      .catch(() => {
        // Transient read failure — leave unknown (never invent a name).
        this.childNicknames.delete(threadId)
      })
      .finally(() => {
        this.childNicknameInflight.delete(threadId)
      })
    return null
  }

  public currentConfigOptions: Record<string, string> = {
    permission_mode: "never",
    // No hardcoded default model — the selected value resolves once the
    // backend's `model/list` results arrive.
    model: "",
    effort: "max",
    personality: "none",
  }

  /** Effective personality wire value. `"none"` (the selector default) means
   *  "don't override" — the field is OMITTED so the backend's config.toml
   *  `personality` (or its own Pragmatic default) takes effect. Only an
   *  explicit friendly/pragmatic pick is forwarded. */
  private effectivePersonality(): string | undefined {
    const value = this.currentConfigOptions["personality"]
    if (!value || value === "none") return undefined
    return value
  }

  /** Resolve the app-server thread UUID for a connection. `connectionId` is
   *  usually the thread UUID itself (or a mapped temp id); falls back to the
   *  active thread. Returns null when no valid UUID is known yet. */
  private resolveThreadId(connectionId?: string): string | null {
    const mapped = connectionId
      ? this.connectionThreadMap.get(connectionId)
      : null
    const id = mapped ?? connectionId ?? this.activeThreadId
    if (!id) return null
    return /^[0-9a-fA-F-]{36}$/.test(id.replace(/^urn:uuid:/i, "")) ? id : null
  }

  constructor(baseUrl = "http://127.0.0.1:3001") {
    this.baseUrl = baseUrl.replace(/\/+$/, "")
    this.restoreChildRegistry()
    this.initWebSocket()
  }

  private initWebSocket(): void {
    if (typeof WebSocket === "undefined") return
    // Never spawn a second socket while one is alive or mid-handshake: the
    // 2s reconnect timer and rawRpc's CLOSED check could otherwise each mint
    // sockets that keep replacing `this.ws` with a fresh CONNECTING one, so
    // the persistent connection never stabilizes as OPEN.
    if (
      this.ws &&
      (this.ws.readyState === WebSocket.CONNECTING ||
        this.ws.readyState === WebSocket.OPEN)
    ) {
      return
    }
    const wsUrl = this.baseUrl.replace(/^http/, "ws")
    console.log(`[ACP-DEBUG] Connecting persistent WebSocket to ${wsUrl}...`)
    try {
      this.ws = new WebSocket(wsUrl)
      this.ws.onopen = () => {
        console.log(
          `[ACP-DEBUG] Persistent WebSocket CONNECTED to ${wsUrl}. Sending initialize request...`
        )
        try {
          this.ws!.send(
            JSON.stringify({
              jsonrpc: "2.0",
              id: 1,
              method: "initialize",
              params: {
                clientInfo: { name: "orbiterx-frontend", version: "1.0.0" },
                capabilities: { experimentalApi: true },
              },
            })
          )
        } catch (e) {
          console.error("[ACP-DEBUG] Failed to send initialize request:", e)
        }
      }
      this.ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data)
          // Handle initialization response. Match ONLY the response frame: a
          // response carries `result`/`error` and never `method`. Server→client
          // REQUESTS (approval prompts) also arrive with small ids — the
          // server's request-id counter starts at 0, so the SECOND approval has
          // id 1 and a bare `data.id === 1` check would swallow it (no dialog,
          // agent waits forever). `!data.method` lets those fall through.
          if (data.id === 1 && !data.method) {
            console.log(
              "[ACP-DEBUG] Persistent WebSocket initialization SUCCESS. Sending notifications/initialized..."
            )
            // Mark the link healthy only after the server accepted `initialize` —
            // a raw TCP/WS connect with no server behind it is NOT connected.
            this.setWsConnected(true)
            try {
              this.ws!.send(
                JSON.stringify({
                  jsonrpc: "2.0",
                  method: "notifications/initialized",
                })
              )
            } catch (e) {
              console.error(
                "[ACP-DEBUG] Failed to send notifications/initialized:",
                e
              )
            }
            return
          }

          // Handle RPC response
          if (data.id && this.pendingRpc.has(data.id)) {
            const pending = this.pendingRpc.get(data.id)!
            this.pendingRpc.delete(data.id)
            if (data.error) {
              console.warn(
                `[ACP-DEBUG] WS RPC error for id ${data.id}:`,
                data.error
              )
              pending.reject(new Error(data.error.message || "RPC error"))
            } else {
              console.log(
                `[ACP-DEBUG] WS RPC SUCCESS for id ${data.id}:`,
                data.result
              )
              pending.resolve(data.result)
            }
            return
          }
          // Handle server notifications
          this.handleServerNotification(data)
        } catch {
          // ignore invalid json
        }
      }
      this.ws.onclose = () => {
        console.log(
          "[ACP-DEBUG] Persistent WebSocket closed, will reconnect in 2s..."
        )
        // Flip the health flag so the UI shows "reconnecting" immediately —
        // the 2s timer below re-establishes the link and onopen/initialize
        // clears it. Without this the app silently looks connected while the
        // server is unreachable.
        this.setWsConnected(false)
        // Fail in-flight RPCs FAST so callers (connect, thread/read retries…)
        // can retry right away instead of riding the 10s timeout on a socket
        // that is already gone — the timeout path exists for half-open links
        // the browser hasn't noticed yet, not for a confirmed close.
        const lost = new Error("WebSocket connection lost")
        for (const pending of this.pendingRpc.values()) {
          pending.reject(lost)
        }
        this.pendingRpc.clear()
        // Drop the stale handle so rawRpc sees no socket (instead of a CLOSED
        // one) and can immediately establish a fresh connection if needed.
        this.ws = null
        setTimeout(() => this.initWebSocket(), 2000)
      }
      this.ws.onerror = (err) => {
        console.warn("[ACP-DEBUG] Persistent WebSocket error:", err)
      }
    } catch (e) {
      console.warn("[ACP-DEBUG] Failed to initialize WebSocket:", e)
    }
  }

  private handleServerNotification(data: any): void {
    console.log("[ACP-DEBUG] WS Notification received:", data)
    const method = data.method || data.type
    const params = data.params || data

    // --- ORBITERX EVENT HANDLING ---
    // The passthrough logic below handles all event types that the reducer
    // expects (content_delta, thinking, status_changed, turn_complete, etc.).
    // The old translateOrbiterxEvent layer emitted different type names
    // (item_created, item_delta, turn_start) that the reducer didn't recognize,
    // causing all streaming events to be silently dropped.

    const emit = (event: any) => {
      let connId =
        params?.threadId ||
        params?.thread_id ||
        params?.thread?.id ||
        data?.threadId ||
        data?.thread_id ||
        this.activeThreadId ||
        "00000000-0000-0000-0000-000000000000"

      const originalConnId = connId

      // Sub-agent approval routing: a child thread's requestApproval /
      // requestUserInput arrives over the PARENT's WS (the parent is now a
      // subscriber of the child thread, see thread_lifecycle.rs). Route ONLY
      // the dialog envelopes' `connection_id` to the PARENT thread so the
      // provider's reverse-map finds the parent contextKey and the
      // PermissionDialog / AskQuestionCard renders on the main session —
      // instead of being buffered as an unmapped child-thread event that never
      // surfaces. Streaming events (content_delta, tool_call…) stay keyed to
      // the child so the auto-opened sub-agent tab renders them. The approval
      // response still echoes back on this same WS (which carried the child
      // request), so the child thread's prompt resolves correctly.
      if (
        this.childParentThreadIds.has(connId) &&
        (event.type === "permission_request" ||
          event.type === "question_request" ||
          event.type === "plan_approval_request")
      ) {
        const parentThreadId = this.childParentThreadIds.get(connId)!
        connId = parentThreadId
      }

      // Reverse lookup: Map real UUID back to temporary ID if mapped
      for (const [tempId, realId] of this.connectionThreadMap.entries()) {
        if (realId === connId) {
          connId = tempId
          break
        }
      }

      const envelope = {
        seq: this.seqCounter++,
        connection_id: connId,
        // `turn_complete` carries the REAL thread id (before the temp-id
        // reverse mapping above) as `session_id` so the frontend can resolve
        // the conversation row by external_id even when `connection_id` was
        // mapped back to a draft/temp tab id.
        ...(event.type === "turn_complete"
          ? { session_id: originalConnId }
          : {}),
        ...event,
      }
      console.log("[ACP-DEBUG] Emitting envelope to listeners:", envelope)
      this.eventListeners.forEach((l) => l(envelope))

      // Dispatch to the attach-protocol stream subscribers if available (Web mode)
      if (this.streamInstance) {
        const stream = this.streamInstance as unknown as {
          subs: Map<string, Set<AttachHandlers>>
        }
        const handlerSet =
          stream.subs.get(originalConnId) ?? stream.subs.get(connId)
        if (handlerSet && handlerSet.size > 0) {
          // Fan out to every subscriber for this connection. Collab children
          // attach under the same connection id for BOTH the delegation
          // context and a manually opened session tab; all of them get the
          // live events so neither feed freezes mid-run.
          for (const handler of handlerSet) {
            try {
              handler.onEvent(envelope)
            } catch (err) {
              console.error("[ACP-DEBUG] attach sub handler threw:", err)
            }
          }
          console.log(
            "[ACP-DEBUG] Forwarding envelope to attach sub handlers for:",
            connId,
            "count:",
            handlerSet.size
          )
        } else {
          console.log(
            "[ACP-DEBUG] No attach sub handler found for:",
            connId,
            "Available subs:",
            Array.from(stream.subs.keys())
          )
        }
      }
    }

    if (method === "thread/started" || method === "thread_started") {
      emit({ type: "status_changed", status: "connected" })

      // ── OrbiterX backend SSE events (gateway → frontend) ─────────────────
      // These are the raw OpenAI-compatible SSE events our gateway emits.
      // We translate them here into the ACP event types the reducer expects.
    } else if (method === "response.created") {
      // Turn just started — show prompting state
      emit({ type: "status_changed", status: "prompting" })
    } else if (method === "response.output_text.delta") {
      // Streaming text delta from the LLM
      const deltaText = params.delta || ""
      if (deltaText) {
        emit({ type: "content_delta", text: deltaText })
      }
    } else if (method === "response.reasoning_text.delta") {
      // Streaming thinking/reasoning token from the LLM (Kimi-K3, DeepSeek, etc.)
      const deltaText = params.delta || ""
      if (deltaText) {
        emit({ type: "thinking", text: deltaText })
      }
    } else if (method === "response.output_item.added") {
      // A new output item started — could be a message or a function_call
      const item = params.item || params
      if (item && item.type === "function_call") {
        // Tool call started — emit tool_call so the UI shows it immediately
        const toolName = item.name || item.tool || "unknown"
        const callId = item.id || item.call_id || `call_${Date.now()}`
        let rawInput: string | null = null
        if (item.arguments) {
          rawInput =
            typeof item.arguments === "string"
              ? item.arguments
              : JSON.stringify(item.arguments)
        }
        emit({
          type: "tool_call",
          tool_call_id: callId,
          title: toolName,
          kind: "tool",
          status: "running",
          raw_input: rawInput,
          raw_output: null,
          content: null,
          locations: null,
          meta: null,
          images: null,
        })
      }
    } else if (method === "response.output_item.done") {
      // An output item completed — update tool_call status to completed
      const item = params.item || params
      if (item && item.type === "function_call") {
        const toolName = item.name || item.tool || "unknown"
        const callId = item.id || item.call_id || `call_${Date.now()}`
        let rawInput: string | null = null
        if (item.arguments) {
          rawInput =
            typeof item.arguments === "string"
              ? item.arguments
              : JSON.stringify(item.arguments)
        }
        emit({
          type: "tool_call_update",
          tool_call_id: callId,
          title: toolName,
          kind: "tool",
          status: "completed",
          raw_input: rawInput,
          raw_output: null,
          content: null,
          locations: null,
          meta: null,
          images: null,
        })
      }
    } else if (method === "response.completed") {
      // Turn fully done — signal completion
      this.activeTurnId = null
      emit({ type: "turn_complete" })
      emit({ type: "status_changed", status: "connected" })
    } else if (method === "error") {
      // Gateway/LLM error — surface in UI
      const errMsg =
        params?.error?.message || params?.message || "Unknown error"
      emit({ type: "error", kind: "turn_failed_unknown", message: errMsg })
      emit({ type: "status_changed", status: "connected" })

      // ── Standard ACP protocol events ─────────────────────────────────────
    } else if (method === "turn/started" || method === "turn_started") {
      const turnId = params?.turn?.id || params?.turnId || params?.id
      const threadId = params?.threadId || params?.thread_id || ""
      if (turnId) {
        this.activeTurnId = turnId
        if (threadId) {
          this.activeTurnIdByThread.set(threadId, turnId)
        }
      }
      emit({ type: "status_changed", status: "prompting" })
    } else if (
      method === "turn/plan/updated" ||
      method === "turn/planUpdated" ||
      method === "turn_plan_updated"
    ) {
      // The app-server emits a `turn/plan/updated` notification whenever the
      // agent calls its `update_plan` todo/checklist tool. Surface it as a
      // `plan_update` envelope so the live PlanCard / AgentPlan overlay render
      // the checklist instead of the tool call silently disappearing.
      const plan: unknown[] = Array.isArray(params.plan) ? params.plan : []
      const entries = plan
        .map((step: unknown) => {
          const record =
            step && typeof step === "object"
              ? (step as Record<string, unknown>)
              : null
          return {
            content:
              typeof record?.step === "string"
                ? record.step
                : typeof record?.title === "string"
                  ? record.title
                  : "",
            status: normalizeStatus(
              typeof record?.status === "string" ? record.status : undefined
            ),
            priority: "medium",
          }
        })
        .filter((entry) => entry.content.length > 0)
      if (entries.length > 0) {
        emit({ type: "plan_update", entries })
      }
    } else if (method === "turn/completed" || method === "turn_completed") {
      this.activeTurnId = null
      // Clear the per-thread entry so a later `turn/interrupt` with an empty
      // turn id falls back to the startup-interrupt path instead of reusing a
      // stale turn id.
      const threadId = params?.threadId || params?.thread_id || ""
      if (threadId) {
        this.activeTurnIdByThread.delete(threadId)
      }
      // Map the notification's turn status to the stop-reason vocabulary the
      // frontend uses to tell a clean completion apart from a cancel/failure
      // (`end_turn` only for genuinely completed turns).
      const stopReason =
        params?.turn?.status === "interrupted"
          ? "cancelled"
          : params?.turn?.status === "failed"
            ? "failed"
            : "end_turn"
      emit({ type: "turn_complete", stop_reason: stopReason })
      emit({ type: "status_changed", status: "connected" })
    } else if (
      method === "agentMessageDelta" ||
      method === "turn/delta" ||
      method === "item/agentMessage/delta" ||
      method === "rawResponseItem/created"
    ) {
      const deltaText = params.delta || params.text || ""
      emit({
        type: "content_delta",
        text: deltaText,
      })
    } else if (
      method === "reasoningTextDelta" ||
      method === "item/reasoning/textDelta" ||
      method === "item/reasoning/summaryTextDelta" ||
      method === "reasoningSummaryTextDelta"
    ) {
      // Reasoning arrives as TWO streams: the raw content (`textDelta`) and the
      // per-paragraph summary (`summaryTextDelta`). Many models emit only the
      // summary (raw content is redacted/empty), so the summary must stream too —
      // otherwise live reasoning is invisible while the restored session (which
      // surfaces `summary`) shows a thinking block.
      const deltaText = params.delta || params.text || ""
      if (deltaText) {
        emit({
          type: "thinking",
          text: deltaText,
        })
      }
    } else if (
      method === "item/reasoning/summaryPartAdded" ||
      method === "reasoningSummaryPartAdded"
    ) {
      // A new reasoning summary paragraph began. Emit an empty thinking delta so
      // the reasoning block stays visible while the first summary token arrives
      // (the reducer coalesces into the trailing thinking block).
      emit({
        type: "thinking",
        text: "",
      })
    } else if (
      method === "item/commandExecution/outputDelta" ||
      method === "commandExecutionOutputDelta"
    ) {
      // Stream a running command's stdout/stderr into the existing tool card so
      // the live terminal types out instead of appearing as a spinner that
      // suddenly dumps `aggregatedOutput` at completion. `raw_output_append`
      // makes the reducer append the chunk to the card's output buffer.
      const itemId = params.itemId || params.item_id || params.id
      const deltaText = params.delta || params.text || ""
      if (itemId && deltaText) {
        emit({
          type: "tool_call_update",
          tool_call_id: itemId,
          title: null,
          kind: null,
          status: "in_progress",
          raw_input: null,
          raw_output: deltaText,
          raw_output_append: true,
          content: null,
          locations: null,
          meta: null,
          images: null,
        })
      }
    } else if (method === "itemStarted" || method === "item/started") {
      const item = params.item
      if (
        item &&
        (item.type === "mcpToolCall" ||
          item.type === "commandExecution" ||
          item.type === "fileChange" ||
          item.type === "dynamicToolCall" ||
          item.type === "collabAgentToolCall" ||
          item.type === "imageGeneration" ||
          item.type === "contextCompaction" ||
          item.type === "sleep")
      ) {
        let kind = "tool"
        let title = item.tool || ""
        let rawInput = item.arguments ? JSON.stringify(item.arguments) : null
        let rawOutput = null
        let meta: Record<string, unknown> | null = null

        if (item.type === "commandExecution") {
          kind = "command"
          title = item.command || ""
          rawInput = item.command || ""
          rawOutput = item.aggregatedOutput || null
        } else if (item.type === "sleep") {
          // The `clock.sleep` tool (interruptible wait): show a "Sleeping…"
          // card for the duration instead of dropping the item, so the UI
          // visibly reflects the wait ("wait 30s then re-check the server").
          // `durationMs` is the wait in milliseconds.
          title = "sleep"
          rawInput = JSON.stringify({
            duration_ms: item.durationMs ?? null,
          })
        } else if (item.type === "fileChange") {
          kind = "edit"
          title = "File Change"
          rawInput = item.changes ? JSON.stringify(item.changes) : null
        } else if (item.type === "contextCompaction") {
          // Context-compaction lifecycle item (thread/compact/start result):
          // tag the tool call with `_meta.contextCompaction` so the reducer/
          // adapter routes it to the subtle ContextCompactionCard instead of a
          // generic tool shell — mirrors the desktop ACP bridge shape
          // (`_meta.contextCompaction === true`).
          title = "context_compaction"
          rawInput = "{}"
          meta = { contextCompaction: true }
        } else if (item.type === "imageGeneration") {
          // Live image generation: the app-server item carries the prompt +
          // status. Forward as a tool call so the adapter renders the
          // dedicated `generated-image` block (same as the history path).
          kind = "image_generation"
          title = "Image Generation"
          rawInput = item.prompt
            ? JSON.stringify({ prompt: item.prompt })
            : "{}"
        } else if (item.type === "collabAgentToolCall") {
          // Sub-agent (collab) tool call: the app-server's `collabAgentToolCall`
          // item carries `tool` (the op: spawnAgent/wait/closeAgent/…), the
          // sender + receiver thread ids and per-agent states — the exact trio
          // `isCodexCollabInput` keys on. Serialize it into the rawInput shape
          // the CollabAgentCard capsule parses (`parseCollabToolInput`), with
          // the op in `title` so the runtime store folds it back in under
          // `COLLAB_OP_KEY`. Without this the item is dropped and a spawned
          // sub-agent renders nothing live.
          title = item.tool || "collab_agent"
          rawInput = JSON.stringify({
            senderThreadId: item.senderThreadId ?? null,
            receiverThreadIds: item.receiverThreadIds ?? [],
            agentsStates: item.agentsStates ?? {},
            ...(item.prompt != null ? { prompt: item.prompt } : {}),
            ...(item.model != null ? { model: item.model } : {}),
            ...(item.reasoningEffort != null
              ? { reasoningEffort: item.reasoningEffort }
              : {}),
          })
          // Register the spawned sub-agent thread(s) so the collab capsule's
          // "open session as a tab" can resolve them (children never appear in
          // `thread/list`). The collab `senderThreadId` is the parent (main)
          // session — record it so a sub-agent tab can offer "Back to main".
          const parentThreadId =
            typeof item.senderThreadId === "string" && item.senderThreadId
              ? item.senderThreadId
              : undefined
          const childIds = item.receiverThreadIds ?? []
          for (const childId of childIds) {
            if (typeof childId === "string" && childId.length > 0) {
              this.registerChildThread(childId, parentThreadId)
            }
          }
          if (item.agentsStates && typeof item.agentsStates === "object") {
            for (const childId of Object.keys(item.agentsStates)) {
              this.registerChildThread(childId, parentThreadId)
            }
          }
          // Synthesize `delegation_started` for a SPAWN so the existing
          // DelegationProvider → attachDelegationChild machinery registers the
          // child's live connection (child events then route to a context the
          // UI can render — live streaming, approvals, inline session). The
          // collab path has no broker envelope, so without this the child's
          // live events are buffered as unmapped and never render.
          if (item.tool === "spawnAgent") {
            const parentToolUseId = item.id || `collab_${this.seqCounter++}`
            for (const childId of childIds) {
              if (typeof childId !== "string" || !childId) continue
              // Remember the spawn's item id per child so a later
              // wait/closeAgent completion can emit `delegation_completed`
              // against the binding `delegation_started` created (keyed by
              // this same `parent_tool_use_id`).
              this.spawnToolUseIdByChild.set(childId, parentToolUseId)
              emit({
                type: "delegation_started",
                parent_connection_id:
                  parentThreadId ?? this.activeThreadId ?? "",
                parent_tool_use_id: parentToolUseId,
                child_connection_id: childId,
                child_conversation_id: convIdFromThreadId(childId),
                agent_type: "codex",
                task_preview: item.prompt ?? null,
              })
            }
          }
        }

        // Forward the engine's shell-command classification
        // (`commandActions`: read / search / listFiles / unknown) so the
        // frontend can render `cat`/`rg`/`ls` commands as Read / Search /
        // List cards (and group them) instead of a generic bash card. Opaque
        // pass-through — the reducer carries it in `meta`.
        if (item.commandActions && Array.isArray(item.commandActions)) {
          meta = { ...(meta ?? {}), commandActions: item.commandActions }
        }

        emit({
          type: "tool_call",
          tool_call_id: item.id,
          title,
          kind,
          status: item.status || "running",
          raw_input: rawInput,
          raw_output: rawOutput,
          content: null,
          locations: null,
          meta,
          images: null,
        })
      }
      emit({
        type: "item_started",
        itemId: params.itemId || params.item?.id,
        item: params.item,
      })
    } else if (method === "itemCompleted" || method === "item/completed") {
      const item = params.item
      if (
        item &&
        (item.type === "mcpToolCall" ||
          item.type === "commandExecution" ||
          item.type === "fileChange" ||
          item.type === "dynamicToolCall" ||
          item.type === "collabAgentToolCall" ||
          item.type === "imageGeneration" ||
          item.type === "contextCompaction" ||
          item.type === "sleep")
      ) {
        let kind = "tool"
        let title = item.tool || ""
        let rawInput = item.arguments ? JSON.stringify(item.arguments) : null
        let rawOutput = null
        let meta: Record<string, unknown> | null = null

        if (item.type === "commandExecution") {
          kind = "command"
          title = item.command || ""
          rawInput = item.command || ""
          rawOutput = item.aggregatedOutput || null
        } else if (item.type === "sleep") {
          // Mirror the item/started sleep forwarding so the "Sleeping…"
          // card resolves to completed once the wait finishes.
          title = "sleep"
          rawInput = JSON.stringify({
            duration_ms: item.durationMs ?? null,
          })
        } else if (item.type === "fileChange") {
          kind = "edit"
          title = "File Change"
          rawInput = item.changes ? JSON.stringify(item.changes) : null
        } else if (item.type === "mcpToolCall") {
          rawOutput = item.result
            ? JSON.stringify(item.result)
            : item.error
              ? JSON.stringify(item.error)
              : null
        } else if (item.type === "contextCompaction") {
          // Mirror the item/started context-compaction tagging so the
          // ContextCompactionCard resolves on completion too.
          title = "context_compaction"
          rawInput = "{}"
          meta = { contextCompaction: true }
        } else if (item.type === "imageGeneration") {
          kind = "image_generation"
          title = "Image Generation"
          rawInput = item.prompt
            ? JSON.stringify({ prompt: item.prompt })
            : "{}"
          rawOutput = item.savedPath ? item.savedPath : null
        } else if (item.type === "collabAgentToolCall") {
          // Mirror the item/started collab forwarding so the sub-agent
          // capsule's live state resolves on completion too (spawn → wait →
          // close status progression).
          title = item.tool || "collab_agent"
          rawInput = JSON.stringify({
            senderThreadId: item.senderThreadId ?? null,
            receiverThreadIds: item.receiverThreadIds ?? [],
            agentsStates: item.agentsStates ?? {},
            ...(item.prompt != null ? { prompt: item.prompt } : {}),
            ...(item.model != null ? { model: item.model } : {}),
            ...(item.reasoningEffort != null
              ? { reasoningEffort: item.reasoningEffort }
              : {}),
          })
          // The spawn's child id arrives on the COMPLETED frame (item/started
          // carries an empty receiverThreadIds). Register it and synthesize
          // `delegation_started` so the child's live connection attaches and
          // its events (streaming, approvals) render.
          const parentThreadId =
            typeof item.senderThreadId === "string" && item.senderThreadId
              ? item.senderThreadId
              : undefined
          const childIds = item.receiverThreadIds ?? []
          for (const childId of childIds) {
            if (typeof childId === "string" && childId.length > 0) {
              this.registerChildThread(childId, parentThreadId)
            }
          }
          if (item.agentsStates && typeof item.agentsStates === "object") {
            for (const childId of Object.keys(item.agentsStates)) {
              this.registerChildThread(childId, parentThreadId)
            }
          }
          if (item.tool === "spawnAgent") {
            const parentToolUseId = item.id || `collab_${this.seqCounter++}`
            for (const childId of childIds) {
              if (typeof childId !== "string" || !childId) continue
              // Remember the spawn's item id per child so a later
              // wait/closeAgent completion can emit `delegation_completed`
              // against the binding `delegation_started` created (keyed by
              // this same `parent_tool_use_id`).
              this.spawnToolUseIdByChild.set(childId, parentToolUseId)
              emit({
                type: "delegation_started",
                parent_connection_id:
                  parentThreadId ?? this.activeThreadId ?? "",
                parent_tool_use_id: parentToolUseId,
                child_connection_id: childId,
                child_conversation_id: convIdFromThreadId(childId),
                agent_type: "codex",
                task_preview: item.prompt ?? null,
              })
            }
          }
          // A `wait`/`closeAgent` completion resolves the spawned sub-agent.
          // Mirror the broker's `delegation_completed` so DelegationProvider
          // flips the binding to ok/err and reaps the synthetic child
          // connection (the idle sweep skips isDelegationChild entries, so an
          // uncompleted binding leaks that connection forever). Keyed by the
          // SPAWN item id `delegation_started` used, not this item's own id.
          if (item.tool === "wait" || item.tool === "closeAgent") {
            const parentConnectionId =
              typeof item.senderThreadId === "string" && item.senderThreadId
                ? item.senderThreadId
                : (this.activeThreadId ?? "")
            const completed = item.status !== "failed"
            for (const childId of childIds) {
              if (typeof childId !== "string" || !childId) continue
              const spawnToolUseId = this.spawnToolUseIdByChild.get(childId)
              if (!spawnToolUseId) continue
              emit({
                type: "delegation_completed",
                parent_connection_id: parentConnectionId,
                parent_tool_use_id: spawnToolUseId,
                child_connection_id: childId,
                child_conversation_id: convIdFromThreadId(childId),
                agent_type: "codex",
                result: completed
                  ? { kind: "ok", duration_ms: 0 }
                  : { kind: "err", error_code: "failed" },
              })
            }
          }
        }

        // Mirror the `item/started` forwarding: carry the shell-command
        // classification on the completion update too, so a command that only
        // surfaced actions on completion still renders as Read/Search/List.
        if (item.commandActions && Array.isArray(item.commandActions)) {
          meta = { ...(meta ?? {}), commandActions: item.commandActions }
        }

        emit({
          type: "tool_call_update",
          tool_call_id: item.id,
          title,
          kind,
          status: item.status || "completed",
          raw_input: rawInput,
          raw_output: rawOutput,
          content: null,
          locations: null,
          meta,
          images: null,
        })
      }
      emit({
        type: "item_completed",
        itemId: params.itemId || params.item?.id,
        item: params.item,
      })
    } else if (
      method === "item/commandExecution/requestApproval" ||
      method === "item/fileChange/requestApproval" ||
      method === "item/permissions/requestApproval"
    ) {
      // Server→client approval prompt (JSON-RPC request with an id). Surface
      // it as an ACP `permission_request` envelope so the PermissionDialog
      // renders, and remember the wire id so `acp_respond_permission` can
      // reply with the matching decision. Decisions that carry required
      // payloads we can't reconstruct (execpolicy/network amendments) are
      // dropped — the server declines those if we never answer.
      const requestId =
        data.id != null ? String(data.id) : `approval_${this.seqCounter++}`
      const allDecisions = Array.isArray(params?.availableDecisions)
        ? params.availableDecisions.map((d: string) => ({
            option_id: d,
            name: PERMISSION_DECISION_NAMES[d] ?? d,
            kind:
              d === "decline" || d === "cancel" ? "reject_once" : "allow_once",
          }))
        : defaultPermissionOptions(method)
      const decisions = allDecisions.filter((d: { option_id: string }) =>
        SIMPLE_PERMISSION_DECISIONS.has(d.option_id)
      )
      this.pendingServerRequests.set(requestId, { id: data.id })
      emit({
        type: "permission_request",
        request_id: requestId,
        tool_call: buildApprovalToolCall(method, params),
        options: decisions,
      })
    } else if (method === "item/tool/requestUserInput") {
      // Server→client question prompt (JSON-RPC request with an id). The model
      // called `request_user_input`; surface it as a `question_request`
      // envelope so the AskQuestionCard renders, and remember the wire id +
      // question ids so `acp_answer_question` can reply with the matching
      // answers frame. Backend options are optional (free-text question when
      // absent); the backend has no multi-select flag, so the card's "Other"
      // free-text input (always present in the UI) covers `is_other`.
      const questionId =
        data.id != null ? String(data.id) : `question_${this.seqCounter++}`
      const questions = (params?.questions ?? []).map((q: any) => ({
        id: q.id ?? "",
        question: q.question ?? "",
        header: q.header ?? q.question ?? "",
        multi_select: false,
        options: (q.options ?? []).map((o: any) => ({
          label: o.label ?? "",
          description: o.description ?? "",
        })),
        ...(q.is_secret ? { is_secret: true } : {}),
      }))
      this.pendingServerRequests.set(questionId, {
        id: data.id,
        questionIds: questions.map((q: { id: string }) => q.id).filter(Boolean),
      })
      emit({
        type: "question_request",
        question_id: questionId,
        questions,
      })
    } else if (method === "process/outputDelta") {
      // Streamed PTY output from `process/spawn` — route to the matching
      // xterm instance via its `terminal://output/<handle>` subscribers.
      const handle = params?.processHandle
      const handlers = handle
        ? this.terminalOutputHandlers.get(handle)
        : undefined
      if (handlers) {
        const data =
          typeof params?.deltaBase64 === "string"
            ? OrbiterXTransport.decodeBase64Utf8(params.deltaBase64)
            : ""
        if (data) {
          handlers.forEach((h) => h({ data }))
        }
      }
    } else if (method === "process/exited") {
      // PTY exited — signal the xterm's `terminal://exit/<handle>` subscribers
      // (stops the input pump, marks the tab exited) and clear the handlers.
      const handle = params?.processHandle
      const handlers = handle
        ? this.terminalExitHandlers.get(handle)
        : undefined
      if (handlers) {
        const exitCode =
          typeof params?.exitCode === "number" ? params.exitCode : 0
        handlers.forEach((h) => h({ exitCode }))
      }
      if (handle) {
        this.terminalOutputHandlers.delete(handle)
        this.terminalExitHandlers.delete(handle)
      }
    } else if (
      method === "thread/goal/updated" ||
      method === "thread/goal/cleared"
    ) {
      // Goal lifecycle updates from the app-server (thread/goal/set / clear
      // round-trips). Forward them so a live goal card can reflect the
      // status change without waiting for a new item event.
      if (method === "thread/goal/cleared") {
        emit({ type: "goal_cleared", threadId: params?.threadId })
      } else {
        emit({
          type: "goal_updated",
          threadId: params?.threadId,
          goal: params?.goal ?? null,
        })
      }
    }
  }

  private async fetchModelOptionsFromWs(): Promise<
    Array<{ value: string; name: string }>
  > {
    return new Promise((resolve, reject) => {
      if (typeof WebSocket === "undefined") {
        return reject(new Error("WebSocket not available"))
      }
      const wsUrl = this.baseUrl.replace(/^http/, "ws")
      const ws = new WebSocket(wsUrl)
      const timeoutId = setTimeout(() => {
        try {
          ws.close()
        } catch {}
        reject(new Error("WebSocket RPC timeout"))
      }, 5000)

      let step = 1
      ws.onopen = () => {
        ws.send(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "initialize",
            params: {
              clientInfo: { name: "orbiterx-frontend", version: "1.0.0" },
              capabilities: { experimentalApi: true },
            },
          })
        )
      }

      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data)
          if (step === 1 && msg.id === 1) {
            ws.send(
              JSON.stringify({
                jsonrpc: "2.0",
                method: "notifications/initialized",
              })
            )
            step = 2
            ws.send(
              JSON.stringify({
                jsonrpc: "2.0",
                id: 2,
                method: "model/list",
                params: { includeHidden: false },
              })
            )
          } else if (step === 2 && msg.id === 2) {
            clearTimeout(timeoutId)
            try {
              ws.close()
            } catch {}
            const data: any[] = msg.result?.data ?? []
            const options = data
              .map((m: any) => ({
                value: m.id ?? m.model ?? m.slug ?? "",
                name:
                  m.displayName ??
                  m.display_name ??
                  m.id ??
                  m.model ??
                  m.slug ??
                  "",
              }))
              .filter((m) => m.value)
            resolve(options)
          }
        } catch (e) {
          clearTimeout(timeoutId)
          try {
            ws.close()
          } catch {}
          reject(e)
        }
      }

      ws.onerror = (err) => {
        clearTimeout(timeoutId)
        try {
          ws.close()
        } catch {}
        reject(err)
      }
    })
  }

  /** Fetch the app-server's collaboration-mode presets (`collaborationMode/list`).
   *  Maps each preset mask to a `SessionModeInfo`-shaped entry keyed by the
   *  real wire `mode` value (`plan`/`default`). Falls back to the static list
   *  when the RPC is unreachable so the composer mode selector never vanishes. */
  private async fetchCollaborationModes(): Promise<
    Array<{ id: string; name: string; description?: string | null }>
  > {
    try {
      const res: any = await this.rpcOverFreshWs("collaborationMode/list", {})
      const data: any[] = res?.data ?? []
      const mapped = data
        .map((m: any) => ({
          id: m.mode ?? m.name ?? "",
          name: m.name ?? m.mode ?? "",
          description: null,
        }))
        .filter((m) => m.id && m.name)
      if (mapped.length > 0) return mapped
    } catch (e) {
      console.warn(
        "[OrbiterXTransport] collaborationMode/list failed, using fallback modes:",
        e
      )
    }
    return FALLBACK_MODES
  }

  private async fetchModelOptionsFromHttpGateway(): Promise<
    Array<{ value: string; name: string }>
  > {
    // Try local ports first, then fall back to the live Railway gateway
    const endpoints = [
      "http://127.0.0.1:8001/v1/models",
      "http://127.0.0.1:8000/v1/models",
      "http://127.0.0.1:3001/v1/models",
      "https://railway-gateway-production.up.railway.app/v1/models",
    ]
    for (const url of endpoints) {
      try {
        const res = await fetch(url)
        if (res.ok) {
          const json = await res.json()
          const rawList =
            json.data ?? json.models ?? (Array.isArray(json) ? json : [])
          if (Array.isArray(rawList) && rawList.length > 0) {
            const options = rawList
              .map((m: any) => ({
                value: m.id ?? m.slug ?? m.model ?? m.value ?? "",
                name:
                  m.displayName ??
                  m.display_name ??
                  m.name ??
                  m.id ??
                  m.slug ??
                  "",
              }))
              .filter((m: any) => m.value)
            if (options.length > 0) return options
          }
        }
      } catch {
        // try next endpoint
      }
    }
    return []
  }

  /** Fetch model list from the real app-server `model/list` RPC or HTTP `/v1/models` endpoint.
   *  Maps ModelListResponse.data to select option objects.
   *  Falls back to gateway server models when the server is unreachable. */
  private async fetchModelOptions(): Promise<
    Array<{ value: string; name: string }>
  > {
    try {
      const live = await this.fetchModelOptionsFromWs()
      if (live.length > 0) return live
    } catch {
      // server unavailable or handshake failed — try HTTP gateway
    }

    try {
      const httpLive = await this.fetchModelOptionsFromHttpGateway()
      if (httpLive.length > 0) return httpLive
    } catch {
      // fall through to server models
    }

    // Always fetch live models from the gateway — no hardcoded fallback
    return []
  }

  /** Map an absolute path to a stable sidebar folder id (positive integer). */
  private folderIdFromPath(cwd: string): number {
    return folderIdFromPath(cwd)
  }

  /** Map an app-server thread UUID to a stable positive numeric conversation
   *  id. The sidebar/runtime keys conversations by NUMBER — a string UUID
   *  makes `useConversationDetail` classify the id as "virtual" and skip the
   *  fetch ("No messages in this conversation."). Shared with the UI
   *  (`@/lib/app-server-ids`) so the collab "open session" affordance computes
   *  the same id. */
  private convIdFromThreadId(threadId: string): number {
    return convIdFromThreadId(threadId)
  }

  /** Fallback conversation id when the app-server RPC fails. Kept within i32
   *  range (< 2^31-1) because codeg's Tauri `get_folder_conversation` takes an
   *  i32 `conversationId` — a raw `Date.now()` (~1.7e12) overflows it and the
   *  sidebar errors "invalid value: integer … expected i32" when loading the
   *  conversation. A monotonic counter reset per session avoids collisions
   *  while staying well under the limit. */
  private fallbackConversationId(): number {
    this._fallbackConvSeq = (this._fallbackConvSeq + 1) % 1_000_000
    return 1_000_000_000 + this._fallbackConvSeq
  }

  /** Map `thread/read` turns to the frontend `MessageTurn[]` shape used by
   *  the live path (command cards, collab/sub-agent capsules, compaction,
   *  sleep, image gen). Shared by the web reopen path AND the desktop
   *  reopen path so close-and-reopen renders identically to the live
   *  stream - the Tauri parser produces a different (richer) layout, which
   *  is why sessions looked completely changed after reopening.
   *  `thread` is the `thread/read` response thread. */
  private mapThreadReadTurns(thread: any): any[] {
    return (thread.turns || [])
      .map((t: any) => {
        const blocks: any[] = []
        // User-message blocks are split into their OWN turn (role "user") so the
        // prompt renders as a proper user bubble — bundling it into the assistant
        // turn (last item sets the role) made the user message disappear on
        // reopen.
        const userBlocks: any[] = []
        // Per-call sub-agent child ids: each collab op's OWN child(ren). The
        // wait carries `targets`, close carries `target`, and the spawn's child
        // is recovered from ITS metadata output (`agent_id`). Using per-call
        // ids keeps parallel agents distinct after reopen — a turn-wide set
        // made every capsule show the FIRST child's name.
        const collabCallChildIds = new Map<string, string[]>()
        // IDs of collab tool calls (spawn/wait/close/resume) in this turn. The
        // backend also records a metadata `commandExecution` with the SAME id
        // (empty command, JSON payload — e.g. the spawned agent's nickname or the
        // child's status envelope) which is collab bookkeeping, NOT a real shell
        // command — skip those so a reopened session doesn't show opaque
        // metadata command cards next to the collab capsule.
        const collabToolCallIds = new Set<string>()
        // Per-agent terminal status + result message recovered from the collab
        // tool metadata `commandExecution` outputs (wait's `status`, close's
        // `previous_status`). Lets the reconstructed WAIT capsule show the
        // child's final message like the live stream, and the execution capsule
        // settle to its terminal state.
        const collabAgentResults = new Map<
          string,
          { status: string; message: string | null }
        >()
        if (Array.isArray(t.items)) {
          for (const item of t.items) {
            if (!item || item.type !== "dynamicToolCall") continue
            if (classifyCollabOp(item.tool) !== "other" && item.id) {
              collabToolCallIds.add(String(item.id))
            }
            const args = item.arguments
            if (args && typeof args === "object" && !Array.isArray(args)) {
              const targets = Array.isArray(args.targets) ? args.targets : []
              const ids: string[] = []
              for (const target of targets) {
                if (typeof target === "string" && target.length > 0) {
                  ids.push(target)
                }
              }
              if (typeof args.target === "string" && args.target.length > 0) {
                ids.push(args.target)
              }
              if (ids.length > 0 && item.id) {
                collabCallChildIds.set(String(item.id), ids)
              }
            }
          }
          // Second pass: parse the collab metadata executions (same id) for the
          // child status/message payloads.
          for (const item of t.items) {
            if (
              item?.type !== "commandExecution" ||
              !item.id ||
              !collabToolCallIds.has(String(item.id))
            ) {
              continue
            }
            if (typeof item.aggregatedOutput !== "string") continue
            try {
              const parsed = JSON.parse(item.aggregatedOutput)
              // Spawn metadata carries the spawned agent id — associate it with
              // THIS spawn call so the execution capsule links the right child.
              const agentId =
                parsed && typeof parsed === "object"
                  ? (parsed.agent_id ?? parsed.agentId ?? null)
                  : null
              if (typeof agentId === "string" && agentId.length > 0) {
                collabCallChildIds.set(String(item.id), [agentId])
              }
              const statusObj =
                (parsed && typeof parsed === "object"
                  ? (parsed.status ?? parsed.previous_status)
                  : null) ?? null
              if (!statusObj || typeof statusObj !== "object") continue
              for (const [agentId, value] of Object.entries(statusObj)) {
                if (typeof value === "string") {
                  collabAgentResults.set(agentId, {
                    status: "completed",
                    message: value,
                  })
                } else if (value && typeof value === "object") {
                  const entries = Object.entries(
                    value as Record<string, unknown>
                  )
                  const status = entries[0]?.[0] ?? "completed"
                  const message =
                    typeof entries[0]?.[1] === "string" ? entries[0][1] : null
                  collabAgentResults.set(agentId, { status, message })
                }
              }
            } catch {
              // Unparseable metadata — ignore; the capsule falls back to
              // completed with no message.
            }
          }
        }
        if (t.items && Array.isArray(t.items)) {
          for (const item of t.items) {
            if (item.type === "userMessage") {
              if (item.content && Array.isArray(item.content)) {
                for (const c of item.content) {
                  if (c.type === "text") {
                    const text = stripSubagentNotificationFragments(c.text)
                    if (text.length > 0) {
                      userBlocks.push({
                        type: "text",
                        text,
                      })
                    }
                  } else if (c.type === "image" || c.type === "localImage") {
                    userBlocks.push({
                      type: "image",
                      data: c.url || c.path || "",
                      mime_type: "image/png",
                    })
                  }
                }
              }
            } else if (item.type === "agentMessage") {
              if (typeof item.text === "string") {
                const text = stripSubagentNotificationFragments(item.text)
                if (text.length > 0) {
                  blocks.push({
                    type: "text",
                    text,
                  })
                }
              }
            } else if (item.type === "reasoning") {
              // A reasoning item carries BOTH a per-paragraph `summary`
              // and raw `content`. Many models emit only the summary
              // (raw content is redacted/empty) — mirror the live path
              // (which streams `summaryTextDelta` + `textDelta`) by
              // surfacing both so a restored thinking block matches the
              // live one instead of being empty/dropped.
              const summaryText = Array.isArray(item.summary)
                ? item.summary.join("\n")
                : ""
              const contentText = Array.isArray(item.content)
                ? item.content.join("\n")
                : ""
              const reasoningText =
                [summaryText, contentText].filter(Boolean).join("\n") ||
                contentText
              if (reasoningText) {
                blocks.push({
                  type: "thinking",
                  text: reasoningText,
                })
              }
            } else if (item.type === "plan") {
              // Restored plan items: prefer structured steps (`plan`/`steps`)
              // so the checklist renders like the live PlanCard; fall back to
              // freeform text when the item carries no structured entries.
              const structured = Array.isArray(item.plan)
                ? item.plan
                : Array.isArray(item.steps)
                  ? item.steps
                  : null
              const entries = (structured ?? [])
                .map((step: unknown) => {
                  const record =
                    step && typeof step === "object"
                      ? (step as Record<string, unknown>)
                      : null
                  return {
                    content:
                      typeof record?.step === "string"
                        ? record.step
                        : typeof record?.title === "string"
                          ? record.title
                          : typeof record?.content === "string"
                            ? record.content
                            : "",
                    status: normalizeStatus(
                      typeof record?.status === "string"
                        ? record.status
                        : undefined
                    ),
                    priority: "medium",
                  }
                })
                .filter(
                  (entry: { content: string }) => entry.content.length > 0
                )
              if (entries.length > 0) {
                blocks.push({ type: "plan", entries })
              } else if (typeof item.text === "string" && item.text.trim()) {
                blocks.push({
                  type: "text",
                  text: item.text,
                })
              }
            } else if (item.type === "commandExecution") {
              // Collab tool metadata execution (same id as the collab tool call):
              // not a user-visible command — skip.
              if (item.id && collabToolCallIds.has(String(item.id))) {
                continue
              }
              const callId =
                item.id || `exec_${Math.random().toString(36).substring(2, 11)}`
              const commandActions: any[] = Array.isArray(item.commandActions)
                ? item.commandActions
                : []
              const output = item.aggregatedOutput || ""
              const isError = item.exitCode !== 0 && item.exitCode !== null
              // A clean engine classification (all read/search/list)
              // keeps the single card — it folds into "Explored" with
              // a Read/Grep/List title. Only chained commands the
              // engine left unclassified (`unknown`/empty/mixed) get
              // split into per-op cards here, mirroring the live path.
              // A SINGLE uniform engine classification (pure read /
              // pure search / pure list) keeps the one card — it folds
              // into "Explored" with a Read/Grep/List title. MIXED
              // context-lane kinds (`ls && cat` → [listFiles, read])
              // can't map to one title, so they split into per-op
              // cards here — mirroring the live path and the
              // unclassified case below.
              const kinds = new Set(commandActions.map((a: any) => a.type))
              const isContextLaneKind = (t: string) =>
                t === "read" || t === "search" || t === "listFiles"
              const singleContextKind =
                commandActions.length > 0 &&
                kinds.size === 1 &&
                isContextLaneKind([...kinds][0])
              const segments = singleContextKind
                ? null
                : splitChainedCommandWithOutputs(
                    item.command || "",
                    output || null
                  )
              if (segments) {
                segments.forEach((seg, i) => {
                  blocks.push({
                    type: "tool_use",
                    tool_use_id: `${callId}::seg${i}`,
                    tool_name: segmentToolName(seg.kind),
                    input_preview: synthesizeSegmentInput(seg) ?? seg.command,
                    status: item.status || "completed",
                    meta: null,
                  })
                  blocks.push({
                    type: "tool_result",
                    tool_use_id: `${callId}::seg${i}`,
                    output_preview: seg.output ?? output,
                    is_error: isError,
                  })
                })
              } else {
                blocks.push({
                  type: "tool_use",
                  tool_use_id: callId,
                  tool_name: "shell",
                  input_preview: item.command || "",
                  // Forward the item's real lifecycle status (inProgress/
                  // completed/failed) instead of hardcoding "completed",
                  // so a restored interrupted turn renders the same
                  // terminal state the live stream showed.
                  status: item.status || "completed",
                  meta: commandActions.length > 0 ? { commandActions } : null,
                })
                blocks.push({
                  type: "tool_result",
                  tool_use_id: callId,
                  output_preview: output,
                  is_error: isError,
                })
              }
            } else if (item.type === "mcpToolCall") {
              const callId =
                item.id || `mcp_${Math.random().toString(36).substring(2, 11)}`
              blocks.push({
                type: "tool_use",
                tool_use_id: callId,
                tool_name: `${item.server}/${item.tool}`,
                input_preview:
                  typeof item.arguments === "string"
                    ? item.arguments
                    : JSON.stringify(item.arguments),
                status: item.status || "completed",
              })
              let outputPreview = ""
              let isError = false
              let resultImages: Array<{
                data: string
                mime_type: string
              }> | null = null
              if (item.result) {
                outputPreview =
                  typeof item.result === "string"
                    ? item.result
                    : JSON.stringify(item.result)
                // Some MCP tools return images as content blocks (e.g.
                // `{type:"image", data, mimeType}`). Lift them onto the
                // tool_result so the adapter renders the picture
                // in-position (live `ToolCallInfo.images` path) instead
                // of a bare text blob.
                const content: any[] = item.result?.content ?? null
                if (Array.isArray(content)) {
                  const imgs = content
                    .filter(
                      (c: any) =>
                        c &&
                        (c.type === "image" || c.type === "localImage") &&
                        (c.data || c.url)
                    )
                    .map((c: any) => ({
                      data: c.data || c.url || "",
                      mime_type: c.mime_type || "image/png",
                    }))
                  if (imgs.length > 0) {
                    resultImages = imgs
                    outputPreview = ""
                  }
                }
              } else if (item.error) {
                outputPreview =
                  typeof item.error === "string"
                    ? item.error
                    : JSON.stringify(item.error)
                isError = true
              }
              blocks.push({
                type: "tool_result",
                tool_use_id: callId,
                output_preview: outputPreview,
                is_error: isError,
                ...(resultImages ? { images: resultImages } : {}),
              })
            } else if (item.type === "imageGeneration") {
              // codex image generation: render as the dedicated
              // `image_generation` block (same as the live path) instead
              // of degrading to a generic tool card.
              const savedPath = item.savedPath || item.saved_path
              blocks.push({
                type: "image_generation",
                revised_prompt: item.revisedPrompt || null,
                image:
                  typeof savedPath === "string" && savedPath
                    ? {
                        data: savedPath,
                        mime_type: "image/png",
                        uri: savedPath,
                      }
                    : null,
                status: item.status || null,
              })
            } else if (item.type === "fileChange") {
              blocks.push(...this.fileChangeBlocks(item))
            } else if (item.type === "dynamicToolCall") {
              const callId =
                item.id || `dyn_${Math.random().toString(36).substring(2, 11)}`
              // Sub-agent collab ops (spawn_agent / wait_agent / close_agent /
              // resume_agent): the app-server persists the live
              // `collabAgentToolCall` items as generic dynamicToolCall items.
              // Reconstruct the live collab capsule so a reopened parent session
              // renders the same sub-agent cards the stream showed instead of
              // opaque "spawn_agent" tool shells.
              if (classifyCollabOp(item.tool) !== "other") {
                // `close` is folded into the execution capsule (live parity) —
                // the close metadata has no new user-visible content.
                if (classifyCollabOp(item.tool) === "close") {
                  continue
                }
                const args =
                  item.arguments &&
                  typeof item.arguments === "object" &&
                  !Array.isArray(item.arguments)
                    ? (item.arguments as Record<string, unknown>)
                    : {}
                const prompt =
                  typeof args.message === "string" && args.message.trim()
                    ? args.message
                    : null
                const childIds = collabCallChildIds.get(String(item.id)) ?? []
                const parentThreadId =
                  typeof thread?.id === "string" ? thread.id : undefined
                const isWait = classifyCollabOp(item.tool) === "wait"
                const agentsStates = Object.fromEntries(
                  childIds.map((childId) => {
                    const result = collabAgentResults.get(childId)
                    return [
                      childId,
                      {
                        status:
                          result?.status ??
                          (item.status === "failed" ? "errored" : "completed"),
                        // The wait capsule carries the child's result message;
                        // the execution capsule shows it only when the agent was
                        // never waited on (mirrors the live collapse).
                        message: isWait ? (result?.message ?? null) : null,
                      },
                    ]
                  })
                )
                const rawInput = JSON.stringify({
                  senderThreadId: parentThreadId ?? "",
                  receiverThreadIds: childIds,
                  agentsStates,
                  ...(prompt != null ? { prompt } : {}),
                  [COLLAB_OP_KEY]: item.tool,
                })
                for (const childId of childIds) {
                  this.registerChildThread(childId, parentThreadId)
                }
                blocks.push({
                  type: "tool_use",
                  tool_use_id: callId,
                  tool_name: "collab_agent",
                  input_preview: rawInput,
                  status: item.status || "completed",
                  meta: null,
                })
              } else {
                blocks.push({
                  type: "tool_use",
                  tool_use_id: callId,
                  tool_name: item.tool,
                  input_preview:
                    typeof item.arguments === "string"
                      ? item.arguments
                      : JSON.stringify(item.arguments),
                  status: item.status || "completed",
                })
                let outputPreview = ""
                if (item.contentItems && Array.isArray(item.contentItems)) {
                  outputPreview = item.contentItems
                    .map((ci: any) => ci.text || "")
                    .join("\n")
                }
                blocks.push({
                  type: "tool_result",
                  tool_use_id: callId,
                  output_preview: outputPreview,
                  is_error: item.success === false,
                })
              }
            } else if (item.type === "collabAgentToolCall") {
              // Sub-agent (collab) tool call on history reload: render
              // as the dedicated collab tool card (same shape the live
              // path forwards) so restored sessions show the sub-agent
              // capsule instead of dropping it.
              const callId =
                item.id ||
                `collab_${Math.random().toString(36).substring(2, 11)}`
              const op = item.tool || "collab_agent"
              const rawInput = JSON.stringify({
                senderThreadId: item.senderThreadId ?? null,
                receiverThreadIds: item.receiverThreadIds ?? [],
                agentsStates: item.agentsStates ?? {},
                ...(item.prompt != null ? { prompt: item.prompt } : {}),
                ...(item.model != null ? { model: item.model } : {}),
                ...(item.reasoningEffort != null
                  ? { reasoningEffort: item.reasoningEffort }
                  : {}),
                __codegCollabOp: op,
              })
              // Register the spawned sub-agent thread(s) on reload too,
              // so "open session as a tab" works from history.
              const parentThreadId =
                typeof item.senderThreadId === "string" && item.senderThreadId
                  ? item.senderThreadId
                  : undefined
              const childIds = item.receiverThreadIds ?? []
              for (const childId of childIds) {
                if (typeof childId === "string" && childId.length > 0) {
                  this.registerChildThread(childId, parentThreadId)
                }
              }
              if (item.agentsStates && typeof item.agentsStates === "object") {
                for (const childId of Object.keys(item.agentsStates)) {
                  this.registerChildThread(childId, parentThreadId)
                }
              }
              blocks.push({
                type: "tool_use",
                tool_use_id: callId,
                tool_name: "collab_agent",
                input_preview: rawInput,
                status: item.status || "completed",
                meta: null,
              })
            } else if (item.type === "contextCompaction") {
              // Context-compaction lifecycle item on history reload:
              // tag the block with `_meta.contextCompaction` so the
              // adapter routes it to the subtle ContextCompactionCard
              // (same contract the live path uses).
              blocks.push({
                type: "tool_use",
                tool_use_id:
                  item.id ||
                  `compaction_${Math.random().toString(36).substring(2, 11)}`,
                tool_name: "context_compaction",
                input_preview: "{}",
                status: "completed",
                meta: { contextCompaction: true },
              })
            } else if (item.type === "sleep") {
              // The `clock.sleep` tool on history reload: render the
              // same "Sleeping…" card the live path shows, so a
              // restored session reflects the wait that happened.
              blocks.push({
                type: "tool_use",
                tool_use_id:
                  item.id ||
                  `sleep_${Math.random().toString(36).substring(2, 11)}`,
                tool_name: "sleep",
                input_preview: JSON.stringify({
                  duration_ms: item.durationMs ?? null,
                }),
                status: "completed",
                meta: null,
              })
            }
          }
        }
        // A turn that failed with a terminal error (e.g. the response
        // stream disconnected before completion) has no reply text to
        // render. Surface the error inline so the session doesn't look
        // like it ended silently — the reply truly was never persisted.
        if (
          (t.status === "failed" || t.status === "interrupted") &&
          t.error?.message
        ) {
          blocks.push({
            type: "text",
            text: `[Response interrupted] ${t.error.message}`,
          })
        }
        const timestamp = t.startedAt
          ? new Date(t.startedAt * 1000).toISOString()
          : new Date().toISOString()
        const base = {
          usage: null,
          duration_ms: t.durationMs || null,
          model: thread.model || null,
          completed_at: t.completedAt
            ? new Date(t.completedAt * 1000).toISOString()
            : null,
        }
        const turns: any[] = []
        if (userBlocks.length > 0) {
          turns.push({
            id: `${t.id}:user`,
            role: "user",
            blocks: userBlocks,
            timestamp,
            ...base,
          })
        }
        if (blocks.length > 0) {
          turns.push({
            id: t.id,
            role: "assistant",
            blocks: blocks,
            timestamp,
            ...base,
          })
        }
        return turns
      })
      .flat()
  }

  /** Convert a `fileChange` item into the apply_patch edit-card blocks. */
  private fileChangeBlocks(item: any): any[] {
    const callId =
      item.id || `edit_${Math.random().toString(36).substring(2, 11)}`
    const changes: any[] = Array.isArray(item.changes) ? item.changes : []
    const failed = item.status === "failed" || item.status === "declined"
    const fileList = changes
      .map((c) => c.path)
      .filter(Boolean)
      .join(", ")
    return [
      {
        type: "tool_use",
        tool_use_id: callId,
        tool_name: "apply_patch",
        input_preview:
          changes.length > 0 ? JSON.stringify({ changes: item.changes }) : "",
        status:
          item.status === "inProgress"
            ? "in_progress"
            : failed
              ? "failed"
              : "completed",
        meta: null,
      },
      {
        type: "tool_result",
        tool_use_id: callId,
        output_preview: fileList
          ? `Updated ${changes.length} file${changes.length > 1 ? "s" : ""}: ${fileList}`
          : "",
        is_error: failed,
      },
    ]
  }

  /**
   * Surface a sub-agent's file changes (diffs) INLINE in the parent
   * conversation, right after its collab capsule. The child's edits live in
   * its own thread — without this they'd only be visible in the sub-agent
   * session tab, never in the main timeline. Bounded: at most a few child
   * threads per fetch, one round-trip each, and only when the parent turn has
   * collab capsules.
   */
  private async enrichTurnsWithSubagentDiffs(turns: any[]): Promise<any[]> {
    if (!Array.isArray(turns) || turns.length === 0) return turns

    const childIdsByTurn: Array<{ turn: any; childIds: string[] }> = []
    for (const turn of turns) {
      const childIds = new Set<string>()
      for (const block of turn.blocks ?? []) {
        if (
          block?.type === "tool_use" &&
          block.tool_name === "collab_agent" &&
          typeof block.input_preview === "string"
        ) {
          try {
            const parsed = JSON.parse(block.input_preview)
            const receivers = Array.isArray(parsed.receiverThreadIds)
              ? parsed.receiverThreadIds
              : []
            for (const id of receivers) {
              if (typeof id === "string" && id.length > 0) childIds.add(id)
            }
          } catch {
            // Unparseable collab input — ignore.
          }
        }
      }
      if (childIds.size > 0) {
        childIdsByTurn.push({ turn, childIds: Array.from(childIds) })
      }
    }
    if (childIdsByTurn.length === 0) return turns

    const MAX_CHILDREN = 5
    const childDiffBlocks = new Map<string, any[]>()
    for (const { childIds } of childIdsByTurn) {
      for (const childId of childIds) {
        if (
          childDiffBlocks.has(childId) ||
          childDiffBlocks.size >= MAX_CHILDREN
        ) {
          continue
        }
        try {
          const res = await this.rpcOverFreshWs("thread/read", {
            threadId: childId,
            includeTurns: true,
          })
          const blocks: any[] = []
          for (const turn of res?.thread?.turns ?? []) {
            for (const item of turn.items ?? []) {
              if (item?.type === "fileChange") {
                blocks.push(...this.fileChangeBlocks(item))
              }
            }
          }
          childDiffBlocks.set(childId, blocks)
        } catch {
          childDiffBlocks.set(childId, [])
        }
      }
    }

    let changed = false
    for (const { turn, childIds } of childIdsByTurn) {
      const blocks: any[] = Array.isArray(turn.blocks) ? turn.blocks : []
      let insertAt = -1
      for (let i = 0; i < blocks.length; i++) {
        if (
          blocks[i]?.type === "tool_use" &&
          blocks[i]?.tool_name === "collab_agent"
        ) {
          insertAt = i
        }
      }
      if (insertAt < 0) continue
      const extra: any[] = []
      for (const childId of childIds) {
        extra.push(...(childDiffBlocks.get(childId) ?? []))
      }
      if (extra.length === 0) continue
      turn.blocks = [
        ...blocks.slice(0, insertAt + 1),
        ...extra,
        ...blocks.slice(insertAt + 1),
      ]
      changed = true
    }
    return changed ? turns : turns
  }

  /** Invoke a real codeg-server command on the desktop sidecar. Tauri mode has
   *  an actual SQLite DB that owns folder/conversation rows — ids minted by
   *  `folderIdFromPath`/`convIdFromThreadId` (which mirror the app-server's
   *  cwd-derived view for web mode) are NOT valid FK targets there, so any
   *  create/fetch keyed by a fabricated id fails with "FOREIGN KEY constraint
   *  failed". Desktop list/CRUD must round-trip through the real commands. */
  private async tauriInvoke(method: string, params?: any): Promise<any> {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { invoke } = require("@tauri-apps/api/core")
    return invoke(method, params || {})
  }

  /** Call one app-server RPC over a FRESH WebSocket with its own initialize
   *  handshake. `rawRpc` over the shared persistent WS can silently fail in
   *  the browser (empty result, no error) — the same failure that left the
   *  model dropdown empty until `fetchModelOptionsFromWs` switched to this
   *  pattern. A fresh socket is deterministic: initialize → notifications/
   *  initialized → the RPC → resolve. */
  private rpcOverFreshWs(method: string, params?: any): Promise<any> {
    return new Promise((resolve, reject) => {
      if (typeof WebSocket === "undefined") {
        return reject(new Error("WebSocket not available"))
      }
      const wsUrl = this.baseUrl.replace(/^http/, "ws")
      const ws = new WebSocket(wsUrl)
      const timeoutId = setTimeout(() => {
        try {
          ws.close()
        } catch {}
        reject(new Error(`WebSocket RPC timeout for ${method}`))
      }, 10000)

      let step = 1
      ws.onopen = () => {
        ws.send(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "initialize",
            params: {
              clientInfo: { name: "orbiterx-frontend", version: "1.0.0" },
              capabilities: { experimentalApi: true },
            },
          })
        )
      }

      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data)
          if (step === 1 && msg.id === 1) {
            ws.send(
              JSON.stringify({
                jsonrpc: "2.0",
                method: "notifications/initialized",
              })
            )
            step = 2
            ws.send(
              JSON.stringify({
                jsonrpc: "2.0",
                id: 2,
                method,
                params: params || {},
              })
            )
          } else if (step === 2 && msg.id === 2) {
            clearTimeout(timeoutId)
            try {
              ws.close()
            } catch {}
            if (msg.error) {
              reject(new Error(msg.error.message || "RPC error"))
            } else {
              resolve(msg.result)
            }
          }
        } catch (e) {
          clearTimeout(timeoutId)
          try {
            ws.close()
          } catch {}
          reject(e)
        }
      }

      ws.onerror = (err) => {
        clearTimeout(timeoutId)
        try {
          ws.close()
        } catch {}
        reject(err)
      }
    })
  }

  /** Fetch all threads from the app-server, paging through `thread/list`. */
  private async fetchAllThreads(): Promise<any[]> {
    const all: any[] = []
    let cursor: string | null = null
    try {
      for (let page = 0; page < 20; page++) {
        const res = await this.rpcOverFreshWs("thread/list", {
          limit: 100,
          cursor: cursor ?? undefined,
        })
        const data: any[] = res?.data ?? []
        all.push(...data)
        cursor = res?.next_cursor ?? null
        if (!cursor || data.length === 0) break
      }
    } catch {
      // server unavailable — return what we have
    }
    return all
  }

  async call(method: string, params?: any): Promise<any> {
    switch (method) {
      case "acp_list_agents":
      case "acp_agents":
        return [
          makeAgentInfo(
            "codex",
            "OrbiterX Engine",
            "OrbiterX Autonomous Coding Engine",
            1
          ),
        ]

      case "acp_get_agent_status":
      case "acp_detect_agent_local_version":
        return {
          agent_type: params?.agentType || "codex",
          status: "ready",
          installed: true,
          installed_version: "2.0.0",
          available: true,
          enabled: true,
          ready: true,
          version: "2.0.0",
        }

      case "acp_describe_agent_options": {
        const [modelOptions, collaborationModes] = await Promise.all([
          this.fetchModelOptions(),
          this.fetchCollaborationModes(),
        ])
        return {
          modes: {
            current_mode_id:
              this.currentConfigOptions["mode"] ??
              collaborationModes[0]?.id ??
              "default",
            available_modes: collaborationModes,
          },
          config_options: [
            {
              id: "permission_mode",
              name: "Permission Mode",
              category: "Permissions",
              kind: {
                type: "select",
                current_value:
                  this.currentConfigOptions["permission_mode"] ?? "never",
                options: [
                  {
                    value: "never",
                    name: "Bypass Permissions",
                    description:
                      "Never ask for approval — commands and edits run automatically",
                  },
                  {
                    value: "untrusted",
                    name: "Ask Every Time",
                    description:
                      "Prompt before executing shell or editing files",
                  },
                  {
                    value: "on-request",
                    name: "Ask on Request",
                    description:
                      "Prompt for approval when the model requests it",
                  },
                  {
                    value: "granular",
                    name: "Granular Approvals",
                    description:
                      "Per-category approval checks for command execution",
                  },
                ],
                groups: [],
              },
            },
            {
              id: "model",
              name: "Model",
              category: "Model",
              kind: {
                type: "select",
                current_value:
                  this.currentConfigOptions["model"] ||
                  modelOptions[0]?.value ||
                  "",
                options: modelOptions,
                groups: [],
              },
            },
            {
              id: "effort",
              name: "Reasoning Effort",
              category: "Reasoning",
              kind: {
                type: "select",
                current_value: this.currentConfigOptions["effort"] ?? "max",
                options: [
                  {
                    value: "max",
                    name: "Max",
                    description: "Maximum reasoning depth",
                  },
                  {
                    value: "high",
                    name: "High",
                    description: "Deeper reasoning for complex tasks",
                  },
                  {
                    value: "medium",
                    name: "Medium",
                    description: "Balanced speed and reasoning depth",
                  },
                  {
                    value: "low",
                    name: "Low",
                    description: "Faster, lighter reasoning",
                  },
                  {
                    value: "off",
                    name: "Off",
                    description: "Disable reasoning model features",
                  },
                ],
                groups: [],
              },
            },
            {
              id: "personality",
              name: "Personality",
              category: "Personality",
              kind: {
                type: "select",
                current_value:
                  this.currentConfigOptions["personality"] ?? "none",
                options: PERSONALITY_OPTIONS,
                groups: [],
              },
            },
          ],
          available_commands: ORBITERX_AVAILABLE_COMMANDS,
        }
      }

      case "acp_get_session_snapshot":
      case "acp_get_session_snapshot_by_conversation": {
        const [modelOptions, collaborationModes] = await Promise.all([
          this.fetchModelOptions(),
          this.fetchCollaborationModes(),
        ])
        return {
          connection_id: params?.connectionId || "session_default",
          agent_type: "codex",
          modes: {
            current_mode_id:
              this.currentConfigOptions["mode"] ??
              collaborationModes[0]?.id ??
              "default",
            available_modes: collaborationModes,
          },
          config_options: [
            {
              id: "permission_mode",
              name: "Permission Mode",
              category: "Permissions",
              kind: {
                type: "select",
                current_value:
                  this.currentConfigOptions["permission_mode"] ?? "never",
                options: [
                  {
                    value: "never",
                    name: "Bypass Permissions",
                    description:
                      "Never ask for approval — commands and edits run automatically",
                  },
                  {
                    value: "untrusted",
                    name: "Ask Every Time",
                    description:
                      "Prompt before executing shell or editing files",
                  },
                  {
                    value: "on-request",
                    name: "Ask on Request",
                    description:
                      "Prompt for approval when the model requests it",
                  },
                  {
                    value: "granular",
                    name: "Granular Approvals",
                    description:
                      "Per-category approval checks for command execution",
                  },
                ],
                groups: [],
              },
            },
            {
              id: "model",
              name: "Model",
              category: "Model",
              kind: {
                type: "select",
                current_value:
                  this.currentConfigOptions["model"] ||
                  modelOptions[0]?.value ||
                  "",
                options: modelOptions,
                groups: [],
              },
            },
            {
              id: "effort",
              name: "Reasoning Effort",
              category: "Reasoning",
              kind: {
                type: "select",
                current_value: this.currentConfigOptions["effort"] ?? "max",
                options: [
                  {
                    value: "max",
                    name: "Max",
                    description: "Maximum reasoning depth",
                  },
                  {
                    value: "high",
                    name: "High",
                    description: "Deeper reasoning for complex tasks",
                  },
                  {
                    value: "medium",
                    name: "Medium",
                    description: "Balanced speed and reasoning depth",
                  },
                  {
                    value: "low",
                    name: "Low",
                    description: "Faster, lighter reasoning",
                  },
                  {
                    value: "off",
                    name: "Off",
                    description: "Disable reasoning model features",
                  },
                ],
                groups: [],
              },
            },
            {
              id: "personality",
              name: "Personality",
              category: "Personality",
              kind: {
                type: "select",
                current_value:
                  this.currentConfigOptions["personality"] ?? "none",
                options: PERSONALITY_OPTIONS,
                groups: [],
              },
            },
          ],
          available_commands: ORBITERX_AVAILABLE_COMMANDS,
        }
      }

      case "acp_set_config_option": {
        if (params?.configId && params?.valueId) {
          this.currentConfigOptions[params.configId] = params.valueId
        }
        // Thread-local options are applied per turn (turn/start) or via
        // thread/settings/update — never written into config.toml.
        if (
          params?.configId === "permission_mode" ||
          params?.configId === "effort"
        ) {
          return { status: "ok" }
        }
        // Personality lives on the thread, not in config.toml — persist it via
        // thread/settings/update so the running session picks it up.
        if (params?.configId === "personality") {
          const threadId = this.resolveThreadId(params?.connectionId)
          if (threadId) {
            try {
              await this.rawRpc("thread/settings/update", {
                threadId,
                personality: params?.valueId,
              })
            } catch (e) {
              console.warn(
                "[OrbiterXTransport] thread/settings/update (personality) failed:",
                e
              )
            }
          }
          return { status: "ok" }
        }
        try {
          return await this.rawRpc("config/value/write", {
            key: params?.configId,
            value: params?.valueId,
          })
        } catch {
          return { status: "ok" }
        }
      }

      case "acp_set_mode": {
        // The app-server has NO `collaborationMode/set` RPC — the old
        // hardcoded "code"/"architect" modes were never real. The real way to
        // switch the active collaboration mode is `thread/settings/update` with
        // a `collaborationMode` object. `settings.model` is required on the
        // wire (serde would reject an omitted model), so it is filled from the
        // currently selected model (resolving the live list when the picker
        // hasn't loaded yet); `developer_instructions: null` means "use the
        // preset's built-in instructions" (server resolves the preset).
        const threadId = this.resolveThreadId(params?.connectionId)
        const mode = params?.modeId ?? "default"
        if (!threadId) {
          console.warn(
            "[OrbiterXTransport] acp_set_mode: no thread id, deferring to turn/start",
            params
          )
          return { status: "ok" }
        }
        this.currentConfigOptions["mode"] = mode
        let model = this.currentConfigOptions["model"]
        if (!model) {
          try {
            const models = await this.fetchModelOptions()
            model = models[0]?.value ?? ""
            if (model) this.currentConfigOptions["model"] = model
          } catch {
            // keep empty — thread/settings/update below still runs; the server
            // resolves the mode preset's own model when ours is blank.
          }
        }
        try {
          return await this.rawRpc("thread/settings/update", {
            threadId,
            collaborationMode: {
              mode,
              settings: {
                model,
                reasoning_effort: this.currentConfigOptions["effort"] ?? "max",
                developer_instructions: null,
              },
            },
          })
        } catch {
          return { status: "ok" }
        }
      }

      case "acp_goal_control": {
        // The app-server goal API is `thread/goal/set` (status + objective) and
        // `thread/goal/clear` — there is no `acp_goal_control` RPC (that name
        // only exists on the legacy codex-acp sidecar). Map the two UI actions
        // onto the real methods.
        const threadId = this.resolveThreadId(params?.connectionId)
        if (!threadId) {
          console.warn(
            "[OrbiterXTransport] acp_goal_control: no thread id",
            params
          )
          return { status: "ok" }
        }
        try {
          if (params?.action === "clear") {
            return await this.rawRpc("thread/goal/clear", { threadId })
          }
          if (params?.action === "pause") {
            return await this.rawRpc("thread/goal/set", {
              threadId,
              status: "paused",
            })
          }
          // "resume" (not currently exposed by the goal card) re-activates.
          if (params?.action === "resume") {
            return await this.rawRpc("thread/goal/set", {
              threadId,
              status: "active",
            })
          }
          return { status: "ok" }
        } catch (e) {
          console.warn("[OrbiterXTransport] goal control failed:", e)
          return { status: "ok" }
        }
      }

      case "acp_review_start": {
        // Wire the composer's "Review changes" action to the app-server
        // `review/start` RPC (target + delivery). Returns the review turn +
        // review thread id so the UI can navigate to it.
        const threadId = this.resolveThreadId(params?.connectionId)
        if (!threadId) {
          console.warn("[OrbiterXTransport] review/start: no thread id", params)
          return { status: "ok" }
        }
        try {
          return await this.rawRpc("review/start", {
            threadId,
            target: params?.target ?? { type: "uncommittedChanges" },
            ...(params?.delivery ? { delivery: params.delivery } : {}),
          })
        } catch (e) {
          console.warn("[OrbiterXTransport] review/start failed:", e)
          throw e
        }
      }

      case "acp_compact_start": {
        // Wire the "/" menu's compact command to the app-server
        // `thread/compact/start` RPC. The app-server does NOT interpret literal
        // `/compact` text from a user turn — compaction only starts via this
        // RPC (the TUI dispatches its SlashCommand::Compact here too), so a
        // badge that just serializes to `/compact` would be sent to the model
        // as prose and nothing would compact.
        const threadId = this.resolveThreadId(params?.connectionId)
        if (!threadId) {
          console.warn(
            "[OrbiterXTransport] thread/compact/start: no thread id",
            params
          )
          return { status: "ok" }
        }
        try {
          return await this.rawRpc("thread/compact/start", { threadId })
        } catch (e) {
          console.warn("[OrbiterXTransport] thread/compact/start failed:", e)
          throw e
        }
      }

      case "acp_mcp_server_status": {
        // App-server mode: MCP server inventory lives behind `mcpServerStatus/
        // list` (the Tauri-sidecar `mcp_scan_local` etc. are unavailable here).
        try {
          return await this.rawRpc("mcpServerStatus/list", {})
        } catch (e) {
          console.warn("[OrbiterXTransport] mcpServerStatus/list failed:", e)
          return { data: [], nextCursor: null }
        }
      }

      case "acp_mcp_server_reload": {
        try {
          return await this.rawRpc("config/mcpServer/reload", {})
        } catch (e) {
          console.warn("[OrbiterXTransport] config/mcpServer/reload failed:", e)
          throw e
        }
      }

      case "acp_respond_permission": {
        // The app-server approval protocol is a JSON-RPC request/response
        // exchange: it sends `item/commandExecution/requestApproval` (etc.)
        // with an id, and the client must reply with a *response* frame
        // carrying the decision — NOT a new request. Only take that path when
        // the request actually came from the app-server (it is registered in
        // `pendingServerRequests`); otherwise fall through to the Tauri
        // invoke, which resolves the legacy sidecar's sacp responder.
        if (this.pendingServerRequests.has(params?.requestId)) {
          return this.respondToServerRequest(
            params?.requestId,
            params?.optionId
          )
        }
        return this.rawRpc("acp_respond_permission", params)
      }

      case "acp_answer_question": {
        // The app-server question protocol is the same JSON-RPC request/
        // response exchange as approvals: `item/tool/requestUserInput` arrives
        // with an id, and the answer must be a *response* frame carrying the
        // per-question answers. Only take that path when the request actually
        // came from the app-server; otherwise fall through to the Tauri
        // invoke for the legacy sidecar's sacp responder.
        if (this.pendingServerRequests.has(params?.questionId)) {
          return this.respondToQuestionRequest(
            params?.questionId,
            params?.answer
          )
        }
        return this.rawRpc("acp_answer_question", params)
      }

      case "acp_connect": {
        console.log(
          "[ACP-DEBUG-CONNECT] acp_connect called with params:",
          params
        )
        // Apply the user's saved per-agent preferences (permission mode,
        // effort, personality) onto the transport's working config so a fresh
        // thread/turn honors them server-side — not just in the selector UI.
        const preferred = params?.preferredConfigValues
        if (preferred && typeof preferred === "object") {
          for (const key of [
            "permission_mode",
            "effort",
            "personality",
          ] as const) {
            const value = preferred[key]
            if (typeof value === "string" && value.length > 0) {
              this.currentConfigOptions[key] = value
            }
          }
        }
        // If resuming an existing session
        if (params?.sessionId && !params.sessionId.startsWith("new-")) {
          console.log(
            "[ACP-DEBUG-CONNECT] Resuming existing session. sessionId:",
            params.sessionId
          )
          // Sub-agent child tabs resume their thread UUID as the session id,
          // but the child is NOT the transport's active thread — the main
          // session owns that pointer (the emit() fallback when a notification
          // carries no thread id). Clobbering it here re-keys parent-side
          // events to the child mid-collab, so only non-child resumes move it.
          if (!this.childParentThreadIds.has(params.sessionId)) {
            this.activeThreadId = params.sessionId
          }
          this.connectionThreadMap.set(params.sessionId, params.sessionId)
          // Emit `session_started` so the connection's `sessionId` is
          // populated (CONNECTION_CREATED leaves it null). Without it the
          // thread UUID never lands in the runtime external-id map, the
          // sidebar status flip can't resolve the row, and the conversation
          // stays stuck "in_progress" after the turn completes.
          this.emitSessionStarted(params.sessionId)

          // Do NOT update external_id during resume: params.sessionId is
          // actually a connection_id, not the session_id in the rollout file.
          // The SessionStarted lifecycle event will set the correct ID, and
          // the fallback in get_folder_conversation_core handles mismatches.
          return params.sessionId
        }

        // Starting a new session
        console.log(
          "[ACP-DEBUG-CONNECT] Starting new session. cwd:",
          params?.workingDir
        )
        const res = await this.rawRpc("thread/start", {
          cwd: params?.workingDir || null,
          permissions: ":workspace",
          // Default the thread's approval policy to the user's selected mode so
          // `/goal`-style server-side turns (which carry no per-turn policy)
          // honor it too. The per-turn `turn/start` override below still wins.
          approvalPolicy:
            toApprovalPolicyWire(
              this.currentConfigOptions["permission_mode"]
            ) ?? "on-request",
          // Personality: thread-level communication style (none/friendly/
          // pragmatic), forwarded from the composer selector. Omitted when
          // "none" so config.toml's `personality` stays authoritative.
          ...(this.effectivePersonality()
            ? { personality: this.effectivePersonality() }
            : {}),
          // Inject the OrbiterX coding-agent base instructions (adapted from
          // the official Codex desktop model entry) on every new thread. The
          // load-bearing rules — "prefer parallel tool calls" and "do not
          // chain shell commands with echo/printf separators" — are what make
          // the model emit one exec_command per read/search, which the UI
          // renders as separate Read/Grep cards (like Codex) instead of one
          // opaque chained bash card. `baseInstructions` is a thread/start
          // override with highest precedence in session/mod.rs. Built per
          // selected model + personality so each model gets its own identity
          // (like Codex's per-model catalog) and the composer's personality
          // pick actually changes the system prompt.
          baseInstructions: buildBaseInstructions(
            this.currentConfigOptions["model"],
            this.effectivePersonality() ?? "none"
          ),
        })

        // THE FIX: Drill down into the nested response to get the real UUID
        const threadId = res?.thread?.id

        if (!threadId) {
          console.error(
            "[OrbiterXTransport] thread/start did not return a valid thread.id. Response was:",
            res
          )
          throw new Error(
            "Failed to create thread: missing thread.id in response"
          )
        }

        console.log(
          `[OrbiterXTransport] Thread created successfully: ${threadId}`
        )
        this.activeThreadId = threadId
        if (params?.sessionId) {
          this.connectionThreadMap.set(params.sessionId, threadId)
        }
        // Populate the connection's `sessionId` (and the runtime external-id
        // map) so the sidebar status flip resolves this thread. See the
        // resume branch for the full rationale.
        this.emitSessionStarted(threadId)

        const convId = params?.conversationId
        if (
          typeof convId === "number" &&
          convId > 0 &&
          typeof window !== "undefined" &&
          "__TAURI_INTERNALS__" in window
        ) {
          try {
            // eslint-disable-next-line @typescript-eslint/no-require-imports
            const { invoke } = require("@tauri-apps/api/core")
            console.log(
              "[ACP-DEBUG-CONNECT] New session: Updating conversation external_id in Tauri DB. convId:",
              convId,
              "threadId:",
              threadId
            )
            await invoke("update_conversation_external_id", {
              conversationId: convId,
              externalId: threadId,
            })
            console.log(
              `[ACP-DEBUG-CONNECT] Associated conversation ${convId} with external_id ${threadId} successfully.`
            )
          } catch (dbErr) {
            console.error(
              "[ACP-DEBUG-CONNECT] Failed to update conversation external_id in Tauri DB during new session:",
              dbErr
            )
          }
        }

        // Emit session modes/models here (if you haven't moved it)
        this.emitSessionModes()

        console.log(`[OrbiterX-TRACE] acp_connect RETURNING UUID:`, threadId)
        // MUST return the exact string UUID so the frontend uses it for turn/start
        return threadId
      }

      case "acp_disconnect": {
        console.warn(
          `[ACP-TRACE] acp_disconnect called for connectionId:`,
          params?.connectionId || params?.sessionId
        )
        console.warn(`[ACP-TRACE] acp_disconnect stack:`, new Error().stack)
        if (params?.connectionId) {
          this.connectionThreadMap.delete(params.connectionId)
        }
        return { status: "ok" }
      }

      case "acp_prompt": {
        console.log(
          `[OrbiterX-TRACE] acp_prompt RECEIVED connectionId:`,
          params?.connectionId
        )

        let threadId = params?.connectionId || params?.sessionId
        if (threadId) {
          const mapped = this.connectionThreadMap.get(threadId)
          if (mapped) {
            threadId = mapped
          }
        }

        let isUuid =
          threadId &&
          /^[0-9a-fA-F-]{36}$/.test(threadId.replace(/^urn:uuid:/i, ""))
        if (!isUuid && this.activeThreadId) {
          threadId = this.activeThreadId
          isUuid = true
        }

        // LAZY CONNECTION FALLBACK: If we don't have a UUID yet, create the thread now
        if (!isUuid || threadId === "00000000-0000-0000-0000-000000000000") {
          console.log(
            `[OrbiterX-TRACE] Lazy connecting for ${params?.connectionId}`
          )
          try {
            const res = await this.rawRpc("thread/start", {
              cwd: params?.workingDir || null,
              permissions: ":workspace",
              approvalPolicy:
                toApprovalPolicyWire(
                  this.currentConfigOptions["permission_mode"]
                ) ?? "on-request",
              ...(this.effectivePersonality()
                ? { personality: this.effectivePersonality() }
                : {}),
              baseInstructions: buildBaseInstructions(
                this.currentConfigOptions["model"],
                this.effectivePersonality() ?? "none"
              ),
            })
            const newThreadId = res?.thread?.id
            if (newThreadId) {
              threadId = newThreadId
              this.activeThreadId = newThreadId
              if (params?.connectionId) {
                this.connectionThreadMap.set(params.connectionId, newThreadId)
              }
              console.log(
                `[OrbiterX-TRACE] Lazy connected! New Thread ID: ${newThreadId}`
              )
              // Populate the connection's sessionId (see emitSessionStarted).
              this.emitSessionStarted(newThreadId)
              // Tell the UI state machine we are officially connected so
              // turn_complete lands on the current tab instead of spawning a new one.
              this.eventListeners.forEach((l) =>
                l({
                  seq: this.seqCounter++,
                  connection_id: newThreadId,
                  type: "status_changed",
                  status: "connected",
                })
              )
            } else {
              throw new Error("No thread.id returned from lazy thread/start")
            }
          } catch (e) {
            console.error("[OrbiterX-TRACE] Lazy connection FAILED:", e)
            throw e
          }
        }

        const promptText = (params?.blocks || [])
          .filter((b: any) => b.type === "text")
          .map((b: any) => b.text)
          .join("\n")

        const selectedModel = this.currentConfigOptions["model"]
        const selectedEffort = this.currentConfigOptions["effort"]
        const selectedPermissionMode =
          this.currentConfigOptions["permission_mode"]

        console.log(
          `[ACP-DEBUG] acp_prompt called! Prompt text: "${promptText}"`,
          {
            connectionId: params?.connectionId,
            resolvedThreadId: threadId,
            selectedModel,
            selectedEffort,
            selectedPermissionMode,
          }
        )
        // Emit prompting status so composer transitions into prompting mode
        this.eventListeners.forEach((l) => {
          console.log("[ACP-DEBUG] Emitting status_changed: prompting")
          l({ type: "status_changed", status: "prompting" })
        })

        try {
          const rpcParams = {
            threadId,
            input: [{ type: "text", text: promptText }],
            stream: true,
            ...(selectedModel ? { model: selectedModel } : {}),
            // `effort` is the wire field on TurnStartParams. (`reasoningEffort`
            // was never a field there — serde silently ignored it — so it is
            // not sent anymore.) The backend applies `effort` as a thread
            // settings override, which takes precedence over config.toml's
            // model_reasoning_effort.
            ...(selectedEffort ? { effort: selectedEffort } : {}),
            // `approvalPolicy` is the only wire field the backend accepts for
            // the permission mode (TurnStartParams.approval_policy:
            // AskForApproval — untrusted/on-request/granular/never). There is
            // no `permissionMode` field; sending the raw UI label used to
            // fail turn/start with an "unknown variant" serde error, so the
            // selector value is mapped to the wire enum here.
            ...(selectedPermissionMode
              ? { approvalPolicy: toApprovalPolicyWire(selectedPermissionMode) }
              : {}),
            // Personality: per-turn communication style override, forwarded
            // from the composer selector. Omitted when "none" so config.toml's
            // `personality` stays authoritative.
            ...(this.effectivePersonality()
              ? { personality: this.effectivePersonality() }
              : {}),
          }
          console.log(
            `[ACP-DEBUG] Sending turn/start RPC request to backend:`,
            rpcParams
          )
          const res = await this.rawRpc("turn/start", rpcParams)
          console.log(
            "[ACP-DEBUG] turn/start RPC SUCCESS response from backend:",
            res
          )
          return res
        } catch (e: any) {
          console.error("[ACP-DEBUG] turn/start RPC ERROR:", e)
          const errorMsg = e?.message || "Failed to start turn on server"
          // Emit error event to surface error banner in UI
          this.eventListeners.forEach((l) =>
            l({
              type: "error",
              kind: "turn_failed_unknown",
              message: errorMsg,
            })
          )
          this.eventListeners.forEach((l) =>
            l({ type: "status_changed", status: "connected" })
          )
          throw new Error(errorMsg)
        }
      }

      case "acp_cancel": {
        try {
          const threadId = params?.connectionId || this.activeThreadId
          if (!threadId) {
            console.error("[acp_cancel] Missing threadId")
            return null
          }
          // Resolve the turn id for THIS connection's thread. The old single
          // global `activeTurnId` was clobbered by sub-agent `turn/started`
          // events (children run their own turns on their own threads), so
          // interrupting the parent would send the CHILD's turn id → server
          // error "expected active turn id X but found Y" and Stop did nothing.
          const turnId =
            this.activeTurnIdByThread.get(threadId) ??
            (this.activeThreadId === threadId ? this.activeTurnId : null)

          // Cascade the interrupt to THIS thread's own spawned sub-agents:
          // interrupting the parent's `wait_agent` only aborts the WAIT — the
          // child keeps running on its own thread and is left "active" (its
          // rollout stalls mid-work) until its own command timeout eventually
          // kills it. The user pressing Stop expects the whole sub-agent tree
          // to stop. Scoped via `childParentThreadIds` so we only interrupt
          // children of the canceling thread — the old code iterated every
          // registered child (restored from localStorage, including stale
          // children of finished/other sessions), firing turn/interrupt at
          // long-gone threads → server "thread not found" on every Stop.
          const childThreadIds = Array.from(this.childParentThreadIds.entries())
            .filter(([, parentId]) => parentId === threadId)
            .map(([childId]) => childId)
          for (const childId of childThreadIds) {
            this.interruptThreadSafe(
              childId,
              this.activeTurnIdByThread.get(childId) ?? ""
            ).catch((e) => {
              console.warn(
                `[acp_cancel] Failed to interrupt sub-agent ${childId}:`,
                e
              )
            })
          }

          if (turnId) {
            console.log(
              `[acp_cancel] Interrupting active turn ${turnId} for thread ${threadId}` +
                (childThreadIds.length > 0
                  ? ` + ${childThreadIds.length} sub-agent(s)`
                  : "")
            )
            return await this.interruptThreadSafe(threadId, turnId)
          } else if (threadId === this.activeThreadId) {
            console.log(
              `[acp_cancel] No active turnId, sending startup interrupt for thread ${threadId}`
            )
            return await this.interruptThreadSafe(threadId, "")
          } else {
            // Non-active thread with no recorded turn (a stale restored child
            // tab or a finished session): nothing is running there — don't
            // fire a doomed turn/interrupt.
            console.warn(
              `[acp_cancel] No active turn for non-active thread ${threadId}; skipping interrupt`
            )
            return null
          }
        } catch (e) {
          console.error("[acp_cancel] Error during turn/interrupt:", e)
          return null
        }
      }

      case "create_conversation": {
        try {
          return await this.rawRpc("create_conversation", params || {})
        } catch (e) {
          // In Tauri mode the DB row is mandatory (the sidebar + detail fetch
          // resolve conversation ids against the local DB) — minting a synthetic
          // id strands the tab behind a phantom conversation that can never load.
          // Re-throw so the panel surfaces the real error. Only web mode, where
          // conversations are synthetic by design, may fall back.
          if (this.isDesktop()) {
            console.error("[ACP-DEBUG] create_conversation failed:", e)
            throw e
          }
          console.warn(
            "[ACP-DEBUG] create_conversation RPC failed — minting fallback id:",
            e
          )
          return this.fallbackConversationId()
        }
      }

      case "create_chat_conversation": {
        try {
          return await this.rawRpc("create_chat_conversation", params || {})
        } catch (e) {
          if (this.isDesktop()) {
            console.error("[ACP-DEBUG] create_chat_conversation failed:", e)
            throw e
          }
          console.warn(
            "[ACP-DEBUG] create_chat_conversation RPC failed — minting fallback id:",
            e
          )
          const convId = this.fallbackConversationId()
          const folderId = convId + 1
          return {
            conversationId: convId,
            folderId: folderId,
            folder: {
              id: folderId,
              path: params?.existingDir || "/tmp/orbiterx-chat",
              name: params?.title || "Chat Session",
              agentType: params?.agentType || "codex",
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
            },
          }
        }
      }

      case "create_chat_dir": {
        try {
          return await this.rawRpc("create_chat_dir", params || {})
        } catch {
          return { path: "/tmp/orbiterx-chat" }
        }
      }

      case "list_conversations": {
        if (this.isDesktop()) {
          return this.tauriInvoke("list_conversations", params)
        }
        try {
          const threads = await this.rawRpc("thread/list", params || {})
          if (!Array.isArray(threads)) return []
          return threads.map((t: any) => ({
            id: t.threadId || t.id,
            title: t.title || "Untitled Session",
            updatedAt: t.updatedAt || t.updated_at || new Date().toISOString(),
            agentType: "codex",
          }))
        } catch {
          return []
        }
      }

      case "get_folder_conversation": {
        const idVal = params?.conversationId
        let threadId = typeof idVal === "string" ? idVal : ""
        if (!threadId && typeof idVal === "number") {
          // Numeric sidebar id: resolve back to the thread UUID minted in
          // `list_all_conversations`. On a cold reload the map is empty, so
          // rebuild it from the authoritative source:
          //   - desktop: the Tauri DB rows carry `external_id` (thread UUID) —
          //     matching against app-server hash ids would never resolve a real
          //     sidebar id;
          //   - web/remote: `thread/list` minted hash ids.
          threadId = this._threadIdByConvId.get(idVal) || ""
          if (!threadId) {
            if (this.isDesktop()) {
              try {
                const rows = await this.tauriInvoke(
                  "list_all_conversations",
                  {}
                )
                const list = Array.isArray(rows) ? rows : (rows?.data ?? [])
                for (const row of list) {
                  const extId = row.external_id ?? row.externalId ?? null
                  const convId = typeof row.id === "number" ? row.id : null
                  if (
                    convId != null &&
                    typeof extId === "string" &&
                    extId.length > 0
                  ) {
                    this._threadIdByConvId.set(convId, extId)
                    if (convId === idVal) threadId = extId
                  }
                }
              } catch {
                // Fall through to the thread/list rebuild below.
              }
            }
            if (!threadId) {
              const threads = await this.fetchAllThreads()
              for (const t of threads) {
                const convId = this.convIdFromThreadId(t.id)
                this._threadIdByConvId.set(convId, t.id)
                if (convId === idVal) threadId = t.id
              }
            }
          }
        }
        console.log(
          "[ACP-DEBUG-GET-CONV] get_folder_conversation called with params:",
          params,
          "threadId:",
          threadId
        )
        if (threadId) {
          try {
            console.log(
              "[ACP-DEBUG-GET-CONV] Web/remote mode: fetching thread turns via thread/read for threadId:",
              threadId
            )
            // Use a FRESH WebSocket (not `rawRpc` over the shared persistent
            // WS): the persistent socket can silently return empty in the
            // browser, which left old sessions showing "No messages in this
            // conversation." — same failure that hit model/list and thread/list.
            // Retry a few rounds: a single fresh+persistent pass can both time
            // out while the app-server is mid-reconnect (startup, a busy GC, or
            // the zombie socket this helper just closed), and giving up leaves
            // the opened tab stuck on "No messages" — but the server comes
            // back within a second or two.
            let res: any = null
            for (let attempt = 1; attempt <= 3 && res == null; attempt++) {
              if (attempt > 1) {
                await new Promise((r) => setTimeout(r, 500))
              }
              try {
                res = await this.rpcOverFreshWs("thread/read", {
                  threadId,
                  includeTurns: true,
                })
              } catch (freshErr) {
                // A brand-new thread has no user message yet — the server
                // rejects `includeTurns` until it materializes. That's a
                // benign "no content" state, not a failure: stop retrying and
                // let the empty-thread path below return zero turns.
                if (isThreadNotMaterializedError(freshErr)) {
                  res = { thread: null }
                  break
                }
                console.warn(
                  `[ACP-DEBUG-GET-CONV] rpcOverFreshWs failed (attempt ${attempt}), trying rawRpc fallback:`,
                  freshErr
                )
                try {
                  res = await this.rawRpc("thread/read", {
                    threadId,
                    includeTurns: true,
                  })
                } catch (rawErr) {
                  if (isThreadNotMaterializedError(rawErr)) {
                    res = { thread: null }
                    break
                  }
                  if (attempt < 3) {
                    console.warn(
                      `[ACP-DEBUG-GET-CONV] rawRpc fallback also failed for thread/read (attempt ${attempt}), retrying:`,
                      rawErr
                    )
                  } else {
                    console.error(
                      "[ACP-DEBUG-GET-CONV] rawRpc fallback also failed for thread/read:",
                      rawErr
                    )
                  }
                }
              }
            }
            console.log(
              "[ACP-DEBUG-GET-CONV] thread/read response received:",
              res
            )
            const thread = res?.thread
            if (thread) {
              // Keep the summary id NUMERIC (the same minted id the sidebar
              // tab is keyed by) and carry the thread UUID in external_id.
              // Desktop passes the REAL DB row id (not the hash) — preserve it
              // so the tab's conversation binding stays consistent.
              const summaryId =
                typeof idVal === "number"
                  ? idVal
                  : this.convIdFromThreadId(threadId)
              this._threadIdByConvId.set(summaryId, threadId)
              // The sub-agent inherits the parent's cwd, so derive its folder
              // from that path — lets the opened tab land in the real folder.
              const childFolderId = this.folderIdFromPath(thread.cwd || "")
              const summary: any = {
                id: summaryId,
                folder_id: childFolderId,
                title: thread.title || "Untitled Session",
                title_locked: false,
                agent_type: "codex",
                status: thread.status?.type || "completed",
                kind: "chat",
                model: thread.model || null,
                git_branch: null,
                external_id: threadId,
                message_count: thread.turns?.length ?? 0,
                child_count: 0,
                created_at: new Date().toISOString(),
                updated_at: new Date().toISOString(),
                pinned_at: null,
              }
              const turns = await this.enrichTurnsWithSubagentDiffs(
                this.mapThreadReadTurns(thread)
              )
              console.log(
                "[ACP-DEBUG-GET-CONV] successfully mapped thread turns. summary:",
                summary,
                "turns count:",
                turns.length
              )
              return {
                summary,
                turns,
                session_stats: null,
                transcript_watermark: null,
                in_flight_user_turn_id: null,
              }
            } else {
              console.warn(
                "[ACP-DEBUG-GET-CONV] No thread object returned in thread/read response."
              )
            }
          } catch (e) {
            console.error(
              "[ACP-DEBUG-GET-CONV] thread/read failed in get_folder_conversation wrapper:",
              e
            )
          }
        }

        if (typeof window !== "undefined" && "__TAURI_INTERNALS__" in window) {
          console.log(
            "[ACP-DEBUG-GET-CONV] Tauri desktop mode: invoking Tauri backend get_folder_conversation with params:",
            params
          )
          try {
            // eslint-disable-next-line @typescript-eslint/no-require-imports
            const { invoke } = require("@tauri-apps/api/core")
            const result = await invoke("get_folder_conversation", params || {})
            console.log(
              "[ACP-DEBUG-GET-CONV] Tauri invoke get_folder_conversation success. Result details:",
              {
                hasSummary: !!result?.summary,
                turnsCount: result?.turns?.length,
                externalId: result?.summary?.external_id,
              }
            )

            // Match-live-everywhere: if this conversation is backed by an
            // app-server thread (its DB `external_id` is the thread UUID),
            // prefer the SAME `thread/read` mapping the live path uses so
            // close-and-reopen renders identically to the streaming view.
            // The Tauri parser produces a different (richer) layout, which is
            // why sessions looked "completely changed" after reopening.
            // Fall back to the parser result if the thread is unreachable.
            const extId = result?.summary?.external_id
            if (
              typeof extId === "string" &&
              /^[0-9a-fA-F-]{36}$/.test(extId.replace(/^urn:uuid:/i, ""))
            ) {
              try {
                const readRes = await this.rpcOverFreshWs("thread/read", {
                  threadId: extId,
                  includeTurns: true,
                })
                const thread = readRes?.thread
                if (thread) {
                  this._threadIdByConvId.set(
                    this.convIdFromThreadId(extId),
                    extId
                  )
                  const turns = await this.enrichTurnsWithSubagentDiffs(
                    this.mapThreadReadTurns(thread)
                  )
                  console.log(
                    "[ACP-DEBUG-GET-CONV] Re-mapped via thread/read (live-match). turns:",
                    turns.length
                  )
                  return {
                    ...result,
                    summary: {
                      ...result.summary,
                      external_id: extId,
                      message_count: thread.turns?.length ?? 0,
                    },
                    turns,
                  }
                }
              } catch (readErr) {
                console.warn(
                  "[ACP-DEBUG-GET-CONV] thread/read re-map failed, keeping parser result:",
                  readErr
                )
              }
            }
            return result
          } catch (tauriErr) {
            console.error(
              "[ACP-DEBUG-GET-CONV] Tauri invoke get_folder_conversation failed:",
              tauriErr
            )
            throw tauriErr
          }
        }

        return {
          summary: {
            id: idVal,
            folder_id: 1,
            title: "Untitled Session",
            title_locked: false,
            agent_type: "codex",
            status: "completed",
            kind: "chat",
            model: null,
            git_branch: null,
            external_id: typeof idVal === "string" ? idVal : null,
            message_count: 0,
            child_count: 0,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
            pinned_at: null,
          },
          turns: [],
          session_stats: null,
          transcript_watermark: null,
          in_flight_user_turn_id: null,
        }
      }

      case "list_folders": {
        if (this.isDesktop()) {
          return this.tauriInvoke("list_folders", params)
        }
        try {
          return await this.rawRpc("list_folders", params || {})
        } catch {
          return []
        }
      }

      case "get_stats": {
        if (this.isDesktop()) {
          return this.tauriInvoke("get_stats", params)
        }
        try {
          return await this.rawRpc("get_stats", params || {})
        } catch {
          return { total_conversations: 0, total_messages: 0, by_agent: [] }
        }
      }

      case "codex_request_device_code": {
        if (this.isDesktop()) {
          return this.tauriInvoke("codex_request_device_code", {})
        }
        // Web login completes in the OAuth callback page (same origin). Start
        // the real authorize flow (state + PKCE) so the callback can exchange
        // the code; the device-code fields are only UI placeholders.
        return {
          userCode: "ORBITERX-AI",
          verificationUrl: await beginOrbiterxOAuth(),
          deviceAuthId: `dev_${Date.now()}`,
          interval: 5,
          redirectUri: `${window.location.origin}/auth/callback`,
        }
      }

      case "codex_poll_device_code": {
        if (this.isDesktop()) {
          return this.tauriInvoke("codex_poll_device_code", {
            deviceAuthId: params.deviceAuthId,
            userCode: params.userCode,
          })
        }
        // Web login completes in the OAuth callback page (same tab), which
        // stores the real access token + gateway key. Keep "pending" so the
        // login page's in-poll auth check picks up the stored session.
        return {
          status: "pending",
        }
      }

      case "get_sidebar_data": {
        if (this.isDesktop()) {
          return this.tauriInvoke("get_sidebar_data", params)
        }
        try {
          return await this.rawRpc("get_sidebar_data", params || {})
        } catch {
          return {
            folders: [],
            stats: { total_conversations: 0, total_messages: 0, by_agent: [] },
          }
        }
      }

      // ────────────────────────────────────────────────────────────────────
      // Codeg-sidecar-only methods. The UI was originally wired to the
      // codeg desktop server (Tauri sidecar), which implemented these. Now the
      // UI talks to the OrbiterX app-server, which does NOT expose them — so
      // they would fall through to the WS and be rejected, throwing out of
      // call() and breaking connect() / attach() (which is what left the model
      // dropdown empty). Stub them here with safe no-op defaults so the app
      // runs purely against the app-server.
      // ────────────────────────────────────────────────────────────────────
      case "acp_find_connection_for_conversation":
        // No cross-client live connection in app-server mode: treat every
        // conversation as ownerless so connect() spawns a fresh owner session
        // (which is what delivers session_modes / session_config_options).
        return null
      case "acp_touch_connection":
        return true
      case "acp_list_connections":
        return []
      case "acp_list_agent_skills": {
        // App-server mode: skills are the backend's `skills/list` registry
        // (per-cwd SkillMetadata), not the Tauri sidecar's per-agent skill
        // files. Map entries onto the settings page's `AgentSkillsListResult`
        // shape so the skills UI actually lists/reads them. Scope mapping:
        // repo-scoped skills are "project" (per-folder); user/system/admin
        // skills are "global" (ORBITERX_HOME). System + admin skills are
        // embedded and always read-only.
        try {
          const cwd = params?.workspacePath ?? null
          const res: any = await this.rawRpc(
            "skills/list",
            cwd ? { cwds: [cwd], forceReload: true } : { forceReload: true }
          )
          const entries: any[] = res?.data ?? []
          const skills = entries.flatMap((entry) =>
            (entry.skills ?? []).map((s: any) => ({
              id: s.name ?? s.path ?? "",
              name: s.name ?? "",
              scope: s.scope === "repo" ? "project" : "global",
              layout: "skill_directory",
              path: s.path ?? "",
              description: s.shortDescription ?? s.description ?? null,
              read_only:
                s.scope === "system" || s.scope === "admin"
                  ? true
                  : s.enabled === false,
            }))
          )
          // Derive the user-level skills store root (`~/.orbiterx/skills`)
          // from an embedded system skill's cache path
          // (`~/.orbiterx/skills/.system/<name>/SKILL.md`) so the page can
          // preview where a new user skill would land.
          const systemSample = skills.find((s) => s.path.includes("/.system/"))
          const globalLocation = systemSample
            ? systemSample.path.split("/.system/")[0]
            : null
          return {
            supported: true,
            message: null,
            locations: [
              ...(globalLocation
                ? [
                    {
                      scope: "global" as const,
                      path: globalLocation,
                      exists: true,
                    },
                  ]
                : []),
              ...entries
                .filter((e) => e.cwd)
                .map((e) => ({
                  scope: "project" as const,
                  path: e.cwd,
                  exists: true,
                })),
            ],
            skills,
          }
        } catch (e) {
          console.warn("[OrbiterXTransport] skills/list failed:", e)
          return { supported: false, message: null, locations: [], skills: [] }
        }
      }
      case "acp_read_agent_skill": {
        // Locate the skill in the backend registry, then read its SKILL.md via
        // `fs/readFile` (base64) — the app-server has no per-agent skill API.
        try {
          const cwd = params?.workspacePath ?? null
          const res: any = await this.rawRpc(
            "skills/list",
            cwd ? { cwds: [cwd], forceReload: true } : { forceReload: true }
          )
          const entries: any[] = res?.data ?? []
          const match = entries
            .flatMap((entry) => entry.skills ?? [])
            .find(
              (s: any) =>
                s.name === params?.skillId || s.path === params?.skillId
            )
          if (!match) return { skill: null, content: "" }
          const skill = {
            id: match.name ?? match.path ?? "",
            name: match.name ?? "",
            scope:
              match.scope === "repo"
                ? ("project" as const)
                : ("global" as const),
            layout: "skill_directory" as const,
            path: match.path ?? "",
            description: match.shortDescription ?? match.description ?? null,
            read_only:
              match.scope === "system" || match.scope === "admin"
                ? true
                : match.enabled === false,
          }
          const readRes: any = await this.rawRpc("fs/readFile", {
            path: match.path,
          })
          if (typeof readRes?.dataBase64 !== "string") {
            return { skill, content: "" }
          }
          const bytes = Uint8Array.from(atob(readRes.dataBase64), (c) =>
            c.charCodeAt(0)
          )
          return { skill, content: new TextDecoder().decode(bytes) }
        } catch (e) {
          console.warn("[OrbiterXTransport] acp_read_agent_skill failed:", e)
          return { skill: null, content: "" }
        }
      }
      case "experts_list":
      case "experts_get_install_status":
      case "experts_list_all_install_statuses":
      case "experts_apply_links":
        return []
      case "experts_link_to_agent":
        return null
      case "experts_unlink_from_agent":
        return null
      case "get_system_language_settings":
        return { mode: "system", language: "en" }
      case "get_feedback_settings":
        return { feedback_enabled: false, detailed: false }
      case "automation_list":
        return []
      case "get_system_terminal_settings": {
        // The app-server doesn't expose terminal settings; report a sensible
        // default shell for the platform so the TerminalView can spawn a PTY.
        const isMac =
          typeof navigator !== "undefined" &&
          /mac/i.test(navigator.platform || navigator.userAgent)
        return { default_shell: isMac ? "/bin/zsh" : "/bin/bash" }
      }
      case "update_system_terminal_settings":
        return { default_shell: params?.settings?.default_shell ?? null }

      // ── Terminal (PTY) — wired to the app-server `process/*` RPCs ────────
      case "terminal_spawn": {
        // Map the frontend terminal API onto `process/spawn`: a PTY shell in
        // the given cwd, streaming stdout/stderr and accepting stdin, keyed by
        // the client's terminalId as the connection-scoped processHandle.
        const cwd = params?.workingDir || null
        if (!cwd) throw new Error("No working directory for terminal")
        const shell = params?.shell || null
        const initialCommand = params?.initialCommand || null
        const argv = shell
          ? [shell, "-lc", initialCommand || ""]
          : initialCommand
            ? ["/bin/sh", "-lc", initialCommand]
            : ["/bin/sh", "-l"]
        const res: any = await this.rawRpc("process/spawn", {
          command: argv,
          processHandle: params?.terminalId || cwd,
          cwd,
          tty: true,
          streamStdin: true,
          streamStdoutStderr: true,
        })
        return res?.processHandle ?? params?.terminalId
      }
      case "terminal_write": {
        const handle = params?.terminalId
        if (!handle || typeof params?.data !== "string") return null
        // stdin bytes are base64 on the wire
        const bytes = new TextEncoder().encode(params.data)
        let binary = ""
        for (const b of bytes) binary += String.fromCharCode(b)
        await this.rawRpc("process/writeStdin", {
          processHandle: handle,
          deltaBase64: btoa(binary),
          closeStdin: false,
        })
        return null
      }
      case "terminal_resize": {
        const handle = params?.terminalId
        if (!handle) return null
        await this.rawRpc("process/resizePty", {
          processHandle: handle,
          size: { rows: params?.rows ?? 24, cols: params?.cols ?? 80 },
        })
        return null
      }
      case "terminal_kill": {
        const handle = params?.terminalId
        if (!handle) return null
        try {
          await this.rawRpc("process/kill", { processHandle: handle })
        } catch {
          // process already gone — treat as success
        }
        return null
      }
      case "terminal_list":
        return []

      case "list_opened_tabs":
        return { items: [], version: 0 }
      case "save_opened_tabs":
        return { accepted: true, version: 0, tabs: [] }
      case "app_update_state":
        return {}
      case "list_open_folder_details":
      case "list_all_folder_details": {
        // Tauri mode owns real folder rows in the local SQLite DB. The
        // app-server-derived view below fabricates numeric ids from cwds that
        // don't exist as FK targets — sending one of those ids to
        // `create_conversation` fails with "FOREIGN KEY constraint failed".
        if (this.isDesktop()) {
          return this.tauriInvoke(method, params)
        }
        // The app-server stores sessions as threads keyed by cwd. Derive the
        // sidebar's folder list from the distinct cwds of `thread/list`.
        const threads = await this.fetchAllThreads()
        const byCwd = new Map<string, any[]>()
        for (const t of threads) {
          const cwd = t.cwd || ""
          if (!cwd) continue
          const list = byCwd.get(cwd) ?? []
          list.push(t)
          byCwd.set(cwd, list)
        }
        const folders = Array.from(byCwd.entries()).map(([cwd, list], i) => {
          const base = cwd.split("/").filter(Boolean).pop() || cwd
          const newest = Math.max(...list.map((t) => t.updatedAt || 0))
          return {
            id: this.folderIdFromPath(cwd),
            name: base,
            path: cwd,
            git_branch: null,
            default_agent_type: "codex",
            last_opened_at: newest
              ? new Date(newest * 1000).toISOString()
              : new Date(0).toISOString(),
            sort_order: i + 1,
            color: "",
            parent_id: null,
            // Chat-mode sessions live under a chat-sessions dir — keep them
            // in allFolders but hidden from the user-facing open list.
            kind: cwd.includes("chat-sessions") ? "chat" : "regular",
          }
        })
        // `list_all_folder_details` includes everything; the open list hides
        // chat folders (mirrors the codeg backend split).
        return method === "list_all_folder_details"
          ? folders
          : folders.filter((f) => f.kind !== "chat")
      }
      case "list_all_conversations": {
        // Tauri mode owns the real conversation rows (numeric ids in SQLite) —
        // the fabricated app-server-derived view below would return ids that
        // have no FK-valid folder, and `create_conversation` on them fails.
        if (this.isDesktop()) {
          return this.tauriInvoke("list_all_conversations", params)
        }
        const threads = await this.fetchAllThreads()
        const folderIds = new Set((params?.folderIds ?? []) as number[])
        return threads
          .filter(
            (t) =>
              folderIds.size === 0 ||
              folderIds.has(this.folderIdFromPath(t.cwd || ""))
          )
          .map((t) => {
            const title = t.name || t.preview || "Untitled Session"
            // The runtime/sidebar/tab system keys conversations by NUMERIC ids
            // (codeg DB autoincrement); a string UUID here makes the detail
            // panel treat the conversation as a virtual draft and never fetch
            // its messages ("No messages in this conversation."). Map the
            // thread UUID to a stable numeric id and keep the UUID in
            // `external_id` so `get_folder_conversation` can still resolve it.
            const convId = this.convIdFromThreadId(t.id)
            this._threadIdByConvId.set(convId, t.id)
            return {
              id: convId,
              folder_id: this.folderIdFromPath(t.cwd || ""),
              title,
              title_locked: false,
              agent_type: "codex",
              status: t.status?.type || "completed",
              kind: (t.cwd || "").includes("chat-sessions")
                ? "chat"
                : "regular",
              model: t.modelProvider || null,
              git_branch: null,
              external_id: t.id,
              message_count: t.turns?.length ?? 0,
              child_count: 0,
              created_at: new Date((t.createdAt || 0) * 1000).toISOString(),
              updated_at: new Date((t.updatedAt || 0) * 1000).toISOString(),
              pinned_at: null,
            }
          })
      }
      case "list_child_conversations":
        return []
      case "list_folder_commands":
        // The codeg DB's folder_command table has a FK to a real folder row,
        // but app-server mode derives folders from thread/list cwds (fabricated
        // numeric ids), so querying commands by that id would violate the FK.
        // No command store exists in app-server mode — return empty.
        return []
      case "create_folder_command":
      case "update_folder_command":
      case "delete_folder_command":
      case "reorder_folder_commands":
      case "bootstrap_folder_commands_from_package_json":
        return []
      case "acp_env_diagnostics":
        return { ok: true }
      case "acp_clear_binary_cache":
      case "acp_download_agent_binary":
        return null

      case "get_git_head": {
        // The app-server has no `get_git_head` RPC, but it DOES expose
        // `fs/readFile`. Read `.git/HEAD` through it so the branch chip below
        // the composer works in app-server mode instead of reporting "not a
        // repo" for every folder. `.git/HEAD` holds either `ref: refs/heads/
        // <branch>` (on a branch — including unborn) or a raw commit SHA
        // (detached HEAD). A missing/invalid `.git` means the folder isn't a
        // repo — return `is_repo: false` so the polling loop stays quiet.
        const folderPath = (params?.path as string) ?? ""
        const resolveGitDir = async (): Promise<string | null> => {
          try {
            const res: any = await this.rawRpc("fs/readFile", {
              path: `${folderPath}/.git/HEAD`,
            })
            if (typeof res?.dataBase64 === "string") return res.dataBase64
            return null
          } catch {
            return null
          }
        }
        const headB64 = await resolveGitDir()
        if (headB64 === null) {
          return {
            is_repo: false,
            branch: null,
            detached: false,
            short_sha: null,
          }
        }
        const headText = new TextDecoder()
          .decode(Uint8Array.from(atob(headB64), (c) => c.charCodeAt(0)))
          .trim()
          .replace(/\r?\n/g, "")
        const refMatch = /^ref:\s*refs\/heads\/(.+)$/.exec(headText)
        if (refMatch) {
          return {
            is_repo: true,
            branch: refMatch[1],
            detached: false,
            short_sha: null,
          }
        }
        // Bare SHA → detached HEAD.
        return {
          is_repo: true,
          branch: null,
          detached: true,
          short_sha: headText.slice(0, 7) || null,
        }
      }
      case "start_workspace_state_stream":
      case "get_workspace_snapshot": {
        // Desktop (Tauri) mode: real Rust commands exist that run the git-
        // aware workspace watcher (file tree + git snapshot + deltas). Route
        // to them so the aux panel's Files/Changes/Commits tabs work. Only
        // the app-server-only (web) mode falls back to the empty snapshot.
        if (this.isDesktop()) {
          return this.tauriInvoke(method, params)
        }
        // No workspace state stream on the app-server — return an empty full
        // snapshot so the workspace-state store's token machine settles and
        // stops re-requesting the unsupported method.
        return {
          root_path: params?.rootPath ?? "",
          seq: 0,
          version: 1,
          full: true,
          tree_snapshot: [],
          git_snapshot: [],
          deltas: [],
          degraded: false,
          is_git_repo: false,
        }
      }
      case "stop_workspace_state_stream":
        if (this.isDesktop()) {
          return this.tauriInvoke(method, params)
        }
        return null

      case "update_conversation_status":
      case "update_conversation_pinned":
      case "update_conversation_external_id":
      case "update_conversation_title":
        // Desktop keeps persisting to the Tauri SQLite DB (the real row
        // owner). App-server mode has no such rows — status/pin are local
        // bookkeeping (authoritative status comes from `thread/status/changed`
        // + `thread/list`), external_id lives in the transport registry, and
        // title syncs best-effort via `thread/name/set`. Without this the
        // sidebar's update_conversation_* calls fall through to rawRpc and
        // reject with "{}" on every status flip.
        if (this.isDesktop()) {
          return this.tauriInvoke(method, params)
        }
        switch (method) {
          case "update_conversation_external_id": {
            const convId = params?.conversationId
            const threadId = params?.externalId
            if (typeof convId === "number" && typeof threadId === "string") {
              this._threadIdByConvId.set(convId, threadId)
            }
            return { ok: true }
          }
          case "update_conversation_title": {
            const threadId =
              typeof params?.conversationId === "number"
                ? (this._threadIdByConvId.get(params.conversationId) ?? null)
                : null
            if (threadId && typeof params?.title === "string") {
              this.rawRpc("thread/name/set", {
                threadId,
                name: params.title,
              }).catch(() => {})
            }
            return { ok: true }
          }
          default:
            return { ok: true }
        }

      default:
        return this.rawRpc(method, params)
    }
  }

  /** Interrupt a turn, treating "thread not found" / "thread not loaded" as a
   *  benign no-op. A canceled tab may hold a thread the app-server already
   *  unloaded/closed (e.g. a restored sub-agent child whose parent finished,
   *  or an old session after a server restart) — firing turn/interrupt at it
   *  would otherwise surface a spurious "Error during turn/interrupt" on every
   *  Stop press. */
  private async interruptThreadSafe(
    threadId: string,
    turnId: string
  ): Promise<any> {
    try {
      return await this.rawRpc("turn/interrupt", { threadId, turnId })
    } catch (e: any) {
      const msg = e?.message ?? String(e)
      if (/thread not found|thread not loaded|not found/i.test(msg)) {
        console.warn(
          `[acp_cancel] Thread ${threadId} is gone (${msg}); skipping interrupt`
        )
        return null
      }
      throw e
    }
  }

  private async rawRpc(
    method: string,
    params?: any,
    timeoutMs = 10000
  ): Promise<any> {
    console.log(`[ACP-DEBUG] rawRpc method: "${method}"`, params)

    // Send App-Server JSON-RPC methods over persistent WebSocket first
    const APP_SERVER_METHODS = new Set([
      "turn/start",
      "turn/interrupt",
      "thread/start",
      "thread/read",
      "thread/list",
      "config/value/write",
      // The login flow persists the gateway key by writing the
      // `orbiterx-gateway` provider into the user config. On desktop this must
      // go over the app-server WS too — the Tauri Rust binary has no
      // `config/batchWrite` command, so without this entry the write is routed
      // to `invoke()`, throws, and the key is silently never saved.
      "config/batchWrite",
      "collaborationMode/set",
      "model/list",
      // The rest of the app-server surface my wiring uses. These MUST be in
      // the whitelist so they go over the app-server WS even in desktop Tauri
      // mode — otherwise `rawRpc` routes them through `invoke()`, and the
      // Tauri Rust binary has no such commands, so they throw and the
      // feature silently breaks (e.g. Skills page → "No agents available").
      "thread/settings/update",
      "thread/name/set",
      "thread/goal/set",
      "thread/goal/get",
      "thread/goal/clear",
      "collaborationMode/list",
      "review/start",
      "thread/compact/start",
      "skills/list",
      "fs/readFile",
      "mcpServerStatus/list",
      "config/mcpServer/reload",
      // Terminal PTY support — the app-server's standalone process API.
      "process/spawn",
      "process/writeStdin",
      "process/kill",
      "process/resizePty",
    ])

    if (APP_SERVER_METHODS.has(method) || !("__TAURI_INTERNALS__" in window)) {
      // Fast path: the persistent socket is already open — reuse it so the
      // RPC response and any streamed events share a single connection.
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        return new Promise((resolve, reject) => {
          const reqId = Date.now()
          this.pendingRpc.set(reqId, { resolve, reject })
          console.log(
            `[ACP-DEBUG] Sending "${method}" over persistent WS (id: ${reqId})`,
            params
          )
          try {
            this.ws!.send(
              JSON.stringify({
                jsonrpc: "2.0",
                id: reqId,
                method,
                params: params || {},
              })
            )
          } catch (e) {
            this.pendingRpc.delete(reqId)
            reject(e)
            return
          }
          setTimeout(() => {
            if (this.pendingRpc.has(reqId)) {
              this.pendingRpc.delete(reqId)
              // The socket accepted the frame but never answered — most often a
              // half-open link (the app-server restarted or is so busy it's not
              // draining the socket) that the browser hasn't detected. Close it
              // so onclose re-initializes a fresh persistent connection instead
              // of leaving every subsequent RPC to ride the zombie.
              try {
                if (this.ws && this.ws.readyState === WebSocket.OPEN) {
                  this.ws.close()
                }
              } catch {
                // already closing/closed — the reinit timer handles it
              }
              reject(new Error(`WebSocket RPC timeout for method: "${method}"`))
            }
          }, timeoutMs)
        })
      }

      // Slow path: the persistent socket is not open yet (still CONNECTING,
      // closing, or dead). Do NOT throw — that is what broke `thread/start`
      // whenever the first RPC raced the socket opening (readyState 0 → the
      // "WebSocket is not connected" error). Open a fresh socket with its own
      // initialize handshake instead, the same deterministic pattern that
      // model/list, thread/list and thread/read already use because the shared
      // persistent WS can sit in CONNECTING indefinitely in the browser.
      if (!this.ws || this.ws.readyState === WebSocket.CLOSED) {
        // Give the persistent socket a chance to come back for event
        // streaming; the fresh socket below carries the RPC regardless.
        this.initWebSocket()
      }
      console.warn(
        `[ACP-DEBUG] Persistent WS not OPEN (readyState: ${this.ws?.readyState}); using fresh WS for "${method}"`
      )
      return this.rpcOverFreshWs(method, params)
    }

    if (typeof window !== "undefined" && "__TAURI_INTERNALS__" in window) {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { invoke } = require("@tauri-apps/api/core")
      return await invoke(method, params || {})
    }

    try {
      console.log(
        `[ACP-DEBUG] Sending HTTP POST to ${this.baseUrl}/rpc for "${method}"`
      )
      const res = await fetch(`${this.baseUrl}/rpc`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: Date.now(),
          method,
          params,
        }),
      })
      if (res.ok) {
        const json = await res.json()
        if (json.error) {
          throw new Error(
            json.error.message || `OrbiterX RPC error on ${method}`
          )
        }
        console.log(`[ACP-DEBUG] HTTP RPC "${method}" SUCCESS:`, json.result)
        return json.result
      }
      console.warn(
        `[ACP-DEBUG] HTTP RPC "${method}" status ${res.status}, trying WS fallback...`
      )
    } catch (httpErr) {
      console.warn(
        `[ACP-DEBUG] HTTP RPC "${method}" failed, trying WS fallback:`,
        httpErr
      )
    }

    return new Promise((resolve, reject) => {
      const wsUrl = this.baseUrl.replace(/^http/, "ws")
      console.log(
        `[ACP-DEBUG] Connecting WebSocket RPC to ${wsUrl} for method: "${method}"`
      )
      const ws = new WebSocket(wsUrl)
      const reqId = Date.now()
      const timeout = setTimeout(() => {
        try {
          ws.close()
        } catch {}
        console.error(`[ACP-DEBUG] WS RPC timeout for method: "${method}"`)
        reject(
          new Error(`WebSocket RPC timeout after 5s for method: "${method}"`)
        )
      }, 5000)

      ws.onopen = () => {
        console.log(
          `[ACP-DEBUG] WS RPC connected for "${method}", sending payload...`
        )
        ws.send(
          JSON.stringify({
            jsonrpc: "2.0",
            id: reqId,
            method,
            params: params || {},
          })
        )
      }

      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data)
          if (msg.id === reqId) {
            clearTimeout(timeout)
            try {
              ws.close()
            } catch {}
            if (msg.error) {
              console.error(
                `[ACP-DEBUG] WS RPC error for "${method}":`,
                msg.error
              )
              reject(new Error(msg.error.message || `RPC error on ${method}`))
            } else {
              console.log(
                `[ACP-DEBUG] WS RPC SUCCESS for "${method}":`,
                msg.result
              )
              resolve(msg.result)
            }
          }
        } catch (e) {
          clearTimeout(timeout)
          try {
            ws.close()
          } catch {}
          reject(e)
        }
      }

      ws.onerror = (err) => {
        clearTimeout(timeout)
        try {
          ws.close()
        } catch {}
        console.error(
          `[ACP-DEBUG] WS RPC connection failed for "${method}":`,
          err
        )
        reject(new Error(`WebSocket RPC connection failed for "${method}"`))
      }
    })
  }

  /** Reply to a server→client approval prompt (the `item/.../requestApproval`
   *  family). The app-server protocol is a JSON-RPC request/response exchange,
   *  so we echo the original request `id` back with the chosen decision as the
   *  result. Accepting leaves the turn running (the command's approval was
   *  granted); declining denies that one request without interrupting. */
  private async respondToServerRequest(
    requestId: string,
    optionId: string
  ): Promise<any> {
    const entry = this.pendingServerRequests.get(requestId)
    if (!entry) {
      console.warn(
        `[OrbiterXTransport] No pending server request for id "${requestId}"`
      )
      return { status: "ok" }
    }
    if (entry.responded) return { status: "ok" }
    entry.responded = true
    try {
      await this.sendResponseFrame(entry.id, { decision: optionId })
    } catch (e) {
      entry.responded = false
      throw e
    }
    this.pendingServerRequests.delete(requestId)
    // Mirror the resolved state so the reducer drops the dialog without
    // waiting for TurnComplete (same event the Tauri backend emits). Resolve
    // the connection id exactly like `emit()` does (UUID → temp id reverse
    // map) so the envelope lands on the right connection's context.
    this.emitResolved(this.resolvedConnectionId(), "permission_resolved", {
      request_id: requestId,
    })
    return { status: "ok" }
  }

  /** Reply to a server→client `item/tool/requestUserInput` prompt. The model
   *  called `request_user_input`; the app-server protocol is a JSON-RPC
   *  request/response exchange, so we echo the original request `id` back with
   *  the per-question answers. The card's submission carries one
   *  `{questionId, labels[]}` item per question in the set. */
  private async respondToQuestionRequest(
    questionId: string,
    answer: any
  ): Promise<any> {
    const entry = this.pendingServerRequests.get(questionId)
    if (!entry) {
      console.warn(
        `[OrbiterXTransport] No pending server request for question "${questionId}"`
      )
      return { status: "ok" }
    }
    if (entry.responded) return { status: "ok" }
    entry.responded = true
    const answers: Record<string, { answers: string[] }> = {}
    for (const item of answer?.answers ?? []) {
      if (item?.questionId && Array.isArray(item.labels)) {
        answers[item.questionId] = { answers: item.labels }
      }
    }
    try {
      await this.sendResponseFrame(entry.id, { answers })
    } catch (e) {
      entry.responded = false
      throw e
    }
    this.pendingServerRequests.delete(questionId)
    this.emitResolved(this.resolvedConnectionId(), "question_resolved", {
      question_id: questionId,
    })
    return { status: "ok" }
  }

  /** Send a JSON-RPC *response* frame (not a request) to the app-server over
   *  the persistent WS, falling back to the HTTP `/rpc` endpoint. */
  private async sendResponseFrame(
    wireId: unknown,
    result: unknown
  ): Promise<void> {
    const frame = JSON.stringify({ jsonrpc: "2.0", id: wireId, result })
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(frame)
      return
    }
    await fetch(`${this.baseUrl}/rpc`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: frame,
    })
  }

  /** Resolve the connection id for synthetic resolved events exactly like
   *  `emit()` does (UUID → temp id reverse map). */
  private resolvedConnectionId(): string {
    let connId = this.activeThreadId ?? "00000000-0000-0000-0000-000000000000"
    for (const [tempId, realId] of this.connectionThreadMap.entries()) {
      if (realId === connId) {
        connId = tempId
        break
      }
    }
    return connId
  }

  private emitResolved(
    connId: string,
    type: "permission_resolved" | "question_resolved",
    payload: Record<string, unknown>
  ): void {
    this.eventListeners.forEach((l) =>
      l({
        seq: this.seqCounter++,
        connection_id: connId,
        type,
        ...payload,
      })
    )
  }

  onEvent(listener: (event: any) => void): UnsubscribeFn {
    this.eventListeners.add(listener)
    return () => {
      this.eventListeners.delete(listener)
    }
  }

  /** Subscribe to persistent-WS connection health (React useSyncExternalStore).
   *  Mirrors `WebTransport.subscribeConnection` so the same reconnect UI can
   *  drive both the web and app-server transports. */
  subscribeConnection(callback: () => void): UnsubscribeFn {
    this.connectionSubscribers.add(callback)
    return () => {
      this.connectionSubscribers.delete(callback)
    }
  }

  /** Current persistent-WS health: `"connected"` when the socket is open AND
   *  the server accepted `initialize`; `"reconnecting"` otherwise. */
  getConnectionSnapshot(): "connected" | "reconnecting" {
    return this._wsConnected ? "connected" : "reconnecting"
  }

  private setWsConnected(connected: boolean): void {
    if (this._wsConnected === connected) return
    this._wsConnected = connected
    this.connectionSubscribers.forEach((cb) => cb())
  }

  /** Emit `session_modes` and `session_config_options` events to all listeners
   *  so the frontend model dropdown populates immediately after acp_connect. */
  private emitSessionModes(): void {
    // Always fetch live models + collaboration modes — no hardcoded defaults

    const emit = (
      models: Array<{ id: string; name: string }>,
      collaborationModes: Array<{ id: string; name: string }>
    ) => {
      const modesEvent = {
        type: "session_modes",
        modes: {
          current_mode_id: collaborationModes[0]?.id ?? "default",
          available_modes: collaborationModes,
        },
      }
      const configEvent = {
        type: "session_config_options",
        config_options: [
          {
            id: "permission_mode",
            name: "Permission Mode",
            category: "Permissions",
            kind: {
              type: "select",
              current_value:
                this.currentConfigOptions["permission_mode"] ?? "never",
              options: [
                {
                  value: "never",
                  name: "Bypass Permissions",
                  description:
                    "Bypass all approval prompts for fully automated runs",
                },
                {
                  value: "untrusted",
                  name: "Ask Every Time",
                  description: "Prompt before executing shell or editing files",
                },
                {
                  value: "on-request",
                  name: "Ask on Request",
                  description: "Prompt for approval on explicit request",
                },
                {
                  value: "granular",
                  name: "Granular Approvals",
                  description: "Granular check for specific command execution",
                },
              ],
              groups: [],
            },
          },
          {
            id: "model",
            name: "Model",
            category: "Model",
            kind: {
              type: "select",
              current_value:
                this.currentConfigOptions["model"] || models[0]?.id || "",
              options: models.map((m) => ({ value: m.id, name: m.name })),
              groups: [],
            },
          },
          {
            id: "effort",
            name: "Reasoning Effort",
            category: "Reasoning",
            kind: {
              type: "select",
              current_value: this.currentConfigOptions["effort"] ?? "max",
              options: [
                {
                  value: "max",
                  name: "Max",
                  description: "Maximum reasoning depth",
                },
                {
                  value: "high",
                  name: "High",
                  description: "Deeper reasoning for complex tasks",
                },
                {
                  value: "medium",
                  name: "Medium",
                  description: "Balanced speed and reasoning depth",
                },
                {
                  value: "low",
                  name: "Low",
                  description: "Faster, lighter reasoning",
                },
                {
                  value: "off",
                  name: "Off",
                  description: "Disable reasoning model features",
                },
              ],
              groups: [],
            },
          },
          {
            id: "personality",
            name: "Personality",
            category: "Personality",
            kind: {
              type: "select",
              current_value: this.currentConfigOptions["personality"] ?? "none",
              options: PERSONALITY_OPTIONS,
              groups: [],
            },
          },
        ],
      }
      const readyEvent = { type: "selectors_ready" }
      const statusEvent = { type: "status_changed", status: "connected" }
      this.eventListeners.forEach((l) => {
        l(modesEvent)
        l(configEvent)
        l(readyEvent)
        l(statusEvent)
      })
    }

    // Always fetch live models from gateway — emit once when ready
    this.fetchModelOptions()
      .then((modelOptions) =>
        this.fetchCollaborationModes().then((modes) => ({
          modelOptions,
          modes,
        }))
      )
      .then(({ modelOptions, modes }) => {
        emit(
          modelOptions.map((m) => ({ id: m.value, name: m.name })),
          modes.map((m) => ({ id: m.id, name: m.name }))
        )
      })
      .catch(() => {
        /* gateway unreachable — model picker will be empty until reconnect */
      })
  }

  /** Emit a `session_started` envelope so the connection's `sessionId` gets
   *  populated and the thread UUID lands in the runtime external-id map.
   *  `CONNECTION_CREATED` seeds `sessionId: null`; the app-server path has no
   *  lifecycle `session_started` notification, so without this the sidebar
   *  status flip can never resolve the conversation row (stuck "in_progress"
   *  after every turn). Mirrors the envelope shape the context expects. */
  private emitSessionStarted(threadId: string): void {
    this.eventListeners.forEach((l) =>
      l({
        seq: this.seqCounter++,
        connection_id: threadId,
        type: "session_started",
        session_id: threadId,
      })
    )
  }

  async subscribe<T>(
    event: string,
    handler: (payload: T) => void
  ): Promise<UnsubscribeFn> {
    // Terminal events are routed by the app-server's `process/outputDelta` /
    // `process/exited` notifications (keyed by processHandle = terminalId),
    // not by the legacy Tauri `app.emit` bridge. Register per-terminal handlers
    // so each xterm instance gets only its own output. Every other event name
    // falls back to the generic listener (matching the old behavior).
    const outputMatch = /^terminal:\/\/output\/(.+)$/.exec(event)
    if (outputMatch) {
      return this.subscribeTerminalOutput(
        outputMatch[1],
        handler as unknown as (payload: { data: string }) => void
      )
    }
    const exitMatch = /^terminal:\/\/exit\/(.+)$/.exec(event)
    if (exitMatch) {
      return this.subscribeTerminalExit(
        exitMatch[1],
        handler as unknown as (payload: { exitCode: number }) => void
      )
    }
    const unsub = this.onEvent((e) => handler(e as T))
    return unsub
  }

  /** Per-terminal output handlers: `processHandle` (terminal id) → callbacks.
   *  Delivered from `process/outputDelta` notifications. */
  private terminalOutputHandlers = new Map<
    string,
    Set<(payload: { data: string }) => void>
  >()

  /** Per-terminal exit handlers: `processHandle` → callbacks. Delivered from
   *  `process/exited` notifications. */
  private terminalExitHandlers = new Map<
    string,
    Set<(payload: { exitCode: number }) => void>
  >()

  private subscribeTerminalOutput(
    terminalId: string,
    handler: (payload: { data: string }) => void
  ): UnsubscribeFn {
    let set = this.terminalOutputHandlers.get(terminalId)
    if (!set) {
      set = new Set()
      this.terminalOutputHandlers.set(terminalId, set)
    }
    set.add(handler)
    return () => {
      set?.delete(handler)
      if (set?.size === 0) this.terminalOutputHandlers.delete(terminalId)
    }
  }

  private subscribeTerminalExit(
    terminalId: string,
    handler: (payload: { exitCode: number }) => void
  ): UnsubscribeFn {
    let set = this.terminalExitHandlers.get(terminalId)
    if (!set) {
      set = new Set()
      this.terminalExitHandlers.set(terminalId, set)
    }
    set.add(handler)
    return () => {
      set?.delete(handler)
      if (set?.size === 0) this.terminalExitHandlers.delete(terminalId)
    }
  }

  /** Decode a base64 string to UTF-8 text (browser-safe). */
  private static decodeBase64Utf8(value: string): string {
    try {
      const bytes = Uint8Array.from(atob(value), (c) => c.charCodeAt(0))
      return new TextDecoder().decode(bytes)
    } catch {
      return ""
    }
  }

  /** Return a synthetic EventStream so the context uses the attach-protocol
   *  path (web mode) instead of the legacy Tauri acp://event path. */
  eventStream(): EventStream {
    if (!this.streamInstance) {
      this.streamInstance = new OrbiterXEventStream(this)
    }
    return this.streamInstance
  }

  isDesktop(): boolean {
    return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window
  }

  destroy(): void {
    this.sse?.close()
    this.sse = null
  }
}

// ---------------------------------------------------------------------------
// OrbiterXEventStream — implements EventStream for OrbiterXTransport.
// When attach() is called, it immediately delivers a LiveSessionSnapshot so the
// frontend selectors render, but the model dropdown starts EMPTY — no hardcoded
// fallback catalog. The picker populates only once the live `model/list` RPC
// resolves (see below), so the UI always reflects the models the backend
// actually serves instead of flashing a stale hardcoded list.
// ---------------------------------------------------------------------------

class OrbiterXEventStream implements EventStream {
  private transport: OrbiterXTransport
  /** Per-connection handlers. A Set so a sub-agent child can be attached by
   *  BOTH the delegation context (keyed by the child connection id) and a
   *  manually opened session tab (same connection id) without one overwriting
   *  the other's live feed — the collab card keeps streaming while the tab
   *  renders the same child, and each subscriber's detach only removes itself. */
  private subs = new Map<string, Set<AttachHandlers>>()

  constructor(transport: OrbiterXTransport) {
    this.transport = transport
  }

  attach(
    connectionId: string,
    _options: { sinceSeq?: number },
    handlers: AttachHandlers
  ): EventStreamSubscription {
    const existing = this.subs.get(connectionId)
    if (existing) {
      existing.add(handlers)
    } else {
      this.subs.set(connectionId, new Set([handlers]))
    }

    const buildConfigOptions = (
      models: Array<{ value: string; name: string }>
    ) => [
      {
        id: "permission_mode",
        name: "Permission Mode",
        category: "Permissions",
        kind: {
          type: "select" as const,
          current_value:
            this.transport.currentConfigOptions["permission_mode"] ?? "never",
          options: [
            {
              value: "never",
              name: "Bypass Permissions",
              description:
                "Bypass all approval prompts for fully automated runs",
            },
            {
              value: "untrusted",
              name: "Ask Every Time",
              description: "Prompt before executing shell or editing files",
            },
            {
              value: "on-request",
              name: "Ask on Request",
              description: "Prompt for approval on explicit request",
            },
            {
              value: "granular",
              name: "Granular Approvals",
              description: "Granular check for specific command execution",
            },
          ],
          groups: [],
        },
      },
      {
        id: "model",
        name: "Model",
        category: "Model",
        kind: {
          type: "select" as const,
          current_value:
            this.transport.currentConfigOptions["model"] ||
            (models[0]?.value ?? ""),
          options: models,
          groups: [],
        },
      },
      {
        id: "effort",
        name: "Reasoning Effort",
        category: "Reasoning",
        kind: {
          type: "select" as const,
          current_value: this.transport.currentConfigOptions["effort"] ?? "max",
          options: [
            {
              value: "max",
              name: "Max",
              description: "Maximum reasoning depth",
            },
            {
              value: "high",
              name: "High",
              description: "Deeper reasoning for complex tasks",
            },
            {
              value: "medium",
              name: "Medium",
              description: "Balanced speed and reasoning depth",
            },
            {
              value: "low",
              name: "Low",
              description: "Faster, lighter reasoning",
            },
            {
              value: "off",
              name: "Off",
              description: "Disable reasoning model features",
            },
          ],
          groups: [],
        },
      },
      {
        id: "personality",
        name: "Personality",
        category: "Personality",
        kind: {
          type: "select" as const,
          current_value:
            this.transport.currentConfigOptions["personality"] ?? "none",
          options: PERSONALITY_OPTIONS,
          groups: [],
        },
      },
    ]

    const modes = {
      current_mode_id:
        this.transport.currentConfigOptions["mode"] ??
        FALLBACK_MODES[0]?.id ??
        "default",
      available_modes: FALLBACK_MODES,
    }

    // Fetch the live model list BEFORE emitting any snapshot/config events.
    //
    // Previously the models were fetched asynchronously AFTER the initial
    // config (empty model list) was emitted, then pushed as a follow-up
    // `session_config_options` event with a low synthetic seq. By the time
    // the fetch resolved, real backend events had already advanced the
    // connection's `lastAppliedSeq` past that seq, so the dedup in
    // `applyMappedEnvelope` dropped the update and the model dropdown stayed
    // permanently empty. Fetching first means the config that lands at seq-3
    // already carries the models — there is no late low-seq emit to drop.
    const snapshotReady = this.transport["fetchModelOptions"]().then(
      (modelOptions) => buildConfigOptions(modelOptions)
    )

    const emitReady = snapshotReady.then((configOptions) => {
      const snapshot = {
        connection_id: connectionId,
        conversation_id: null,
        folder_id: null,
        // "ready" is not a ConnectionStatus the reducer/UI understands: a
        // resumed connection hydrated from this snapshot would sit in a
        // zombie state where isConnectionReady/composer gating and the
        // prompting-status transitions never line up. "connected" is the
        // neutral live state — the backend's own status events (turn/started
        // etc.) then drive the real transitions.
        status: "connected" as const,
        // The thread UUID (app-server mode: connectionId IS the thread id) is
        // the snapshot's external_id, NOT null. `denormalizeSnapshot` maps
        // `sessionId: wire.external_id`, and HYDRATE_FROM_SNAPSHOT sets
        // `conn.sessionId` from it. With null here the connection's sessionId
        // stays null forever on the attach path, the detail-panel
        // `connSessionId` effect never binds the thread UUID to the sidebar
        // row (DB external_id stays NULL), and turn_complete can't resolve the
        // row — every conversation stays stuck "in_progress".
        external_id: connectionId,
        live_message: null,
        active_tool_calls: [],
        pending_permission: null,
        active_delegations: [],
        feedback: [],
        modes,
        current_mode: modes.current_mode_id,
        config_options: configOptions,
        prompt_capabilities: null,
        usage: null,
        fork_supported: false,
        available_commands: ORBITERX_AVAILABLE_COMMANDS,
        selectors_ready: true,
        event_seq: 1,
      }

      // Deliver snapshot first, then stream events to populate selectorsCache
      // + connection state. The config event carries the live models, so the
      // model dropdown is populated on first render.
      handlers.onSnapshot(snapshot as any, 0)

      handlers.onEvent({
        connection_id: connectionId,
        seq: 2,
        type: "session_modes",
        modes,
      } as any)

      handlers.onEvent({
        connection_id: connectionId,
        seq: 3,
        type: "session_config_options",
        config_options: configOptions,
      } as any)

      handlers.onEvent({
        connection_id: connectionId,
        seq: 4,
        type: "selectors_ready",
      } as any)
    })

    // Best-effort: if the model fetch throws (server unreachable), fall back
    // to an empty catalog so selectors still render.
    emitReady.catch(() => {
      handlers.onSnapshot(
        {
          connection_id: connectionId,
          conversation_id: null,
          folder_id: null,
          status: "connected" as const,
          // See the primary snapshot above: the thread UUID rides here as
          // external_id so conn.sessionId hydrates even on the fallback path.
          external_id: connectionId,
          live_message: null,
          active_tool_calls: [],
          pending_permission: null,
          active_delegations: [],
          feedback: [],
          modes,
          current_mode: "code",
          config_options: buildConfigOptions([]),
          prompt_capabilities: null,
          usage: null,
          fork_supported: false,
          available_commands: [],
          selectors_ready: true,
          event_seq: 1,
        } as any,
        0
      )
      handlers.onEvent({
        connection_id: connectionId,
        seq: 2,
        type: "session_modes",
        modes,
      } as any)
      handlers.onEvent({
        connection_id: connectionId,
        seq: 3,
        type: "session_config_options",
        config_options: buildConfigOptions([]),
      } as any)
      handlers.onEvent({
        connection_id: connectionId,
        seq: 4,
        type: "selectors_ready",
      } as any)
    })

    return {
      subscriptionId: connectionId,
      detach: () => {
        const set = this.subs.get(connectionId)
        if (!set) return
        set.delete(handlers)
        if (set.size === 0) {
          this.subs.delete(connectionId)
        }
      },
    }
  }
}
