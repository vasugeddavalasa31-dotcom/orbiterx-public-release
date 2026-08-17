import { COLLAB_AGENT_TOOL_NAME } from "@/lib/collab-tool"

export type ToolKindLabel =
  | "search"
  | "list"
  | "command"
  | "read"
  | "memory"
  | "edit"
  | "fetch"
  | "think"
  | "todo"
  | "task"
  | "other"

// Count display order for the "Explored" context group — mirrors opencode's
// read → search → list lane summary.
export const TOOL_KIND_ORDER: ToolKindLabel[] = [
  "read",
  "search",
  "list",
  "memory",
  "edit",
  "command",
  "fetch",
  "task",
  "todo",
  "think",
  "other",
]

/**
 * Identify agent-like tool calls that own their own card-style rendering
 * (e.g. AgentToolCallPart, DelegatedSubThread). These should not be folded
 * into a tool-group; they each break the run and render standalone.
 *
 * The delegation MCP tools surface with a host-specific server prefix and
 * separator: Claude Code emits `mcp__<server>__<tool>`, Codex live ACP
 * exposes them as `<server>/<tool>`, and other hosts may use `.` or `:`.
 * Match the suffix after any non-alphanumeric separator so every form lands
 * on the same code path. The bare-name comparisons cover the live-streaming
 * path (where `inferLiveToolName` has already collapsed to the canonical
 * name); the suffix regexes cover the historical path (raw tool name).
 */
const DELEGATE_TO_AGENT_SUFFIX_RE = /[^a-z0-9]delegate_to_agent$/
const GET_DELEGATION_STATUS_SUFFIX_RE = /[^a-z0-9]get_delegation_status$/
const CANCEL_DELEGATION_SUFFIX_RE = /[^a-z0-9]cancel_delegation$/
const CREATE_GOAL_SUFFIX_RE = /[^a-z0-9]create_goal$/
const UPDATE_GOAL_SUFFIX_RE = /[^a-z0-9]update_goal$/
const ASK_USER_QUESTION_SUFFIX_RE = /[^a-z0-9]ask_user_question$/
const CHECK_USER_FEEDBACK_SUFFIX_RE = /[^a-z0-9]check_user_feedback$/

export function isAgentLikeToolName(toolName: string): boolean {
  const name = toolName.toLowerCase().trim()
  if (name === "agent") return true
  // codex live collab / sub-agent card (codex-acp 1.0.1 #223): owns a dedicated
  // compact card, so it breaks the run and renders standalone, like the other
  // agent-like tools, rather than folding into a generic tool-group.
  if (name === COLLAB_AGENT_TOOL_NAME) return true
  if (
    name === "delegate_to_agent" ||
    name === "get_delegation_status" ||
    name === "cancel_delegation" ||
    name === "create_goal" ||
    name === "update_goal" ||
    // codeg-mcp ask_user_question — owns the AskQuestionResultCard, so it must
    // break the run and render standalone rather than fold into a tool-group.
    // "question" is the canonical name (live path); the bare raw name plus the
    // suffix RE below cover the historical `mcp__<server>__ask_user_question`
    // forms, since this runs pre-normalize.
    name === "question" ||
    name === "ask_user_question" ||
    // codex Plan-mode `request_user_input` (delivered via elicitation) owns the
    // same AskQuestionResultCard. The history parser keeps this raw name, so
    // hoist it here too; the live path already collapses it to "question".
    name === "request_user_input" ||
    // codeg-mcp check_user_feedback — owns the FeedbackCheckResultCard capsule,
    // so the (visible) ones must break the run and render standalone rather than
    // fold into a tool-group. The no-op polls are dropped upstream by
    // `dropHiddenFeedbackChecks`, so only received-feedback checks reach here.
    name === "check_user_feedback"
  )
    return true
  if (DELEGATE_TO_AGENT_SUFFIX_RE.test(name)) return true
  if (GET_DELEGATION_STATUS_SUFFIX_RE.test(name)) return true
  if (CANCEL_DELEGATION_SUFFIX_RE.test(name)) return true
  if (CREATE_GOAL_SUFFIX_RE.test(name)) return true
  if (UPDATE_GOAL_SUFFIX_RE.test(name)) return true
  if (ASK_USER_QUESTION_SUFFIX_RE.test(name)) return true
  if (CHECK_USER_FEEDBACK_SUFFIX_RE.test(name)) return true
  return false
}

/**
 * Specifically the `get_delegation_status` companion tool, in either the bare
 * canonical form (live streaming, post-`inferLiveToolName`) or any host-
 * prefixed form (historical raw name: `mcp__<server>__get_delegation_status`,
 * `<server>/get_delegation_status`, …). Used to collapse a run of consecutive
 * status polls into a single merged card.
 */
export function isDelegationStatusToolName(toolName: string): boolean {
  const name = toolName.toLowerCase().trim()
  return (
    name === "get_delegation_status" ||
    GET_DELEGATION_STATUS_SUFFIX_RE.test(name)
  )
}

export function classifyToolKind(toolName: string): ToolKindLabel {
  const name = toolName.toLowerCase().trim()
  const cleanName = name
    .replace(/^(?:mcp__)?[a-z0-9_-]+__/, "") // mcp__server__tool or namespace__tool
    .replace(/^[a-z0-9_-]+\//, "") // server/tool
    .replace(/^[a-z0-9_-]+\./, "") // server.tool
    .replace(/^[a-z0-9_-]+:/, "") // server:tool

  if (
    cleanName === "grep" ||
    cleanName === "glob" ||
    cleanName === "search" ||
    cleanName === "find" ||
    cleanName === "list_code_definition_names" ||
    cleanName === "grep_search" ||
    cleanName === "search_web"
  ) {
    return "search"
  }

  // Directory listings get their own lane ("List <dir>") so the "Explored"
  // group summary can count reads / searches / lists separately, like opencode.
  if (cleanName === "list_files" || cleanName === "list_dir" || cleanName === "ls") {
    return "list"
  }

  if (
    cleanName === "bash" ||
    cleanName === "exec_command" ||
    cleanName === "shell" ||
    cleanName === "execute_command" ||
    cleanName === "run_command" ||
    cleanName === "computer" ||
    cleanName === "terminal" ||
    cleanName === "zsh" ||
    cleanName === "sh" ||
    cleanName === "cmd" ||
    cleanName === "powershell" ||
    cleanName === "execute" ||
    cleanName === "run_terminal_cmd" ||
    cleanName === "run_bash_command" ||
    cleanName === "execute_bash"
  ) {
    return "command"
  }

  if (
    cleanName === "read" ||
    cleanName === "read file" ||
    cleanName === "read_file" ||
    cleanName === "view" ||
    cleanName === "view_file" ||
    cleanName === "read_url_content"
  ) {
    return "read"
  }

  if (cleanName === "memory_recall") {
    return "memory"
  }

  if (
    cleanName === "edit" ||
    cleanName === "write" ||
    cleanName === "notebookedit" ||
    cleanName === "apply_patch" ||
    cleanName === "str_replace" ||
    cleanName === "create_file" ||
    cleanName === "write_to_file" ||
    cleanName === "replace_in_file" ||
    cleanName === "replace_file_content" ||
    cleanName === "multi_replace_file_content"
  ) {
    return "edit"
  }

  if (
    cleanName === "webfetch" ||
    cleanName === "websearch" ||
    cleanName === "fetch" ||
    cleanName === "browser" ||
    cleanName === "browser_action" ||
    cleanName === "web_search"
  ) {
    return "fetch"
  }

  if (
    cleanName === "think" ||
    cleanName === "sequentialthinking" ||
    cleanName === "enterplanmode" ||
    cleanName === "exitplanmode" ||
    cleanName === "switch_mode"
  ) {
    return "think"
  }

  if (
    cleanName === "todowrite" ||
    cleanName === "tasklist" ||
    cleanName === "taskcreate" ||
    cleanName === "taskupdate" ||
    cleanName === "update_todo_list"
  ) {
    return "todo"
  }

  if (
    cleanName === "task" ||
    cleanName === "agent" ||
    cleanName === "skill" ||
    cleanName === "new_task" ||
    cleanName === "attempt_completion"
  ) {
    return "task"
  }

  return "other"
}
