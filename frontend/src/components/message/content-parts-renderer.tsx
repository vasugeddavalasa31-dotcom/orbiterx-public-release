import { memo, useMemo, useState, type ReactNode } from "react"
import type { AdaptedContentPart } from "@/lib/adapters/ai-elements-adapter"
import {
  classifyToolKind,
  TOOL_KIND_ORDER,
  type ToolKindLabel,
} from "@/lib/adapters/tool-kind-classifier"
import type { MessageRole } from "@/lib/types"
import { normalizeToolName } from "@/lib/tool-call-normalization"
import { parseBackgroundLaunch } from "@/lib/background-task"
import { isDelegateToAgentToolName } from "@/lib/delegation-card"
import { useTranslations } from "next-intl"
import { cn } from "@/lib/utils"
import {
  countUnifiedDiffLineChanges,
  estimateChangedLineStats,
} from "@/lib/line-change-stats"
import { MessageResponse } from "@/components/ai-elements/message"
import { Shimmer } from "@/components/ai-elements/shimmer"
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/instant-collapsible"
import {
  Tool,
  ToolHeader,
  ToolContent,
  ToolOutput,
} from "@/components/ai-elements/tool"
import { TerminalOutput } from "@/components/ai-elements/terminal"
import { CodeBlock } from "@/components/ai-elements/code-block"
import { UnifiedDiffPreview } from "@/components/diff/unified-diff-preview"
import { generateUnifiedDiff } from "@/lib/unified-diff-generator"
import { FilePathLink } from "@/components/ai-elements/link-safety"
import {
  Reasoning,
  ReasoningTrigger,
  ReasoningContent,
} from "@/components/ai-elements/reasoning"
import { AgentToolCallPart } from "./agent-tool-call"
import { AskQuestionResultCard } from "./ask-question-result-card"
import { CollabAgentCard } from "./collab-agent-card"
import {
  ContextCompactionCard,
  isContextCompactionMeta,
} from "./context-compaction-card"
import { FeedbackCheckResultCard } from "./feedback-check-result-card"
import { COLLAB_AGENT_TOOL_NAME } from "@/lib/collab-tool"
import { DelegatedSubThread } from "./delegated-sub-thread"
import { DelegationStatusCard } from "./delegation-status-card"
import { DelegationStatusGroupCard } from "./delegation-status-group-card"
import { BackgroundTaskCard } from "./background-task-card"
import { GeneratedImagesBlock } from "./generated-images-block"
import { GoalRunPart, GoalToolCallPart } from "./goal-tool-call"
import { PlanModeCard } from "./plan-mode-card"
import { PlainTextWithBadges } from "./plain-text-with-badges"
import {
  FileTextIcon,
  FilePenLineIcon,
  FilePlusIcon,
  TerminalIcon,
  SearchIcon,
  GlobeIcon,
  ClipboardListIcon,
  ListTodoIcon,
  SparklesIcon,
  CircleCheckIcon,
  CompassIcon,
  MapIcon,
  MinusIcon,
  PlusIcon,
  WrenchIcon,
  ChevronRightIcon,
  BrainIcon,
  MessageCircleQuestionMarkIcon,
  UsersIcon,
} from "lucide-react"

// ── helpers ────────────────────────────────────────────────────────────

/** Try JSON.parse; return null on failure. */
export function tryParseJson(s: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(s)
    return typeof v === "object" && v !== null && !Array.isArray(v) ? v : null
  } catch {
    return null
  }
}

/** Regex-extract a JSON string value for a given key (works on truncated JSON). */
export function extractJsonField(input: string, key: string): string | null {
  const re = new RegExp(`"${key}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`)
  const m = input.match(re)
  return m?.[1]?.replace(/\\"/g, '"').replace(/\\\\/g, "\\") ?? null
}

function asObjectLike(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>
  }
  if (typeof value !== "string") return null
  const trimmed = value.trim()
  if (!trimmed.startsWith("{")) return null
  return tryParseJson(trimmed)
}

const NESTED_PAYLOAD_KEYS = ["input", "arguments", "params", "payload"]

function findStringFieldDeep(
  value: unknown,
  key: string,
  depth: number = 0
): string | null {
  if (depth > 4) return null
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findStringFieldDeep(item, key, depth + 1)
      if (found) return found
    }
    return null
  }
  const obj = asObjectLike(value)
  if (!obj) return null

  const direct = obj[key]
  if (typeof direct === "string" && direct.trim().length > 0) {
    return direct
  }

  for (const nestedKey of NESTED_PAYLOAD_KEYS) {
    const found = findStringFieldDeep(obj[nestedKey], key, depth + 1)
    if (found) return found
  }

  for (const nestedValue of Object.values(obj)) {
    const found = findStringFieldDeep(nestedValue, key, depth + 1)
    if (found) return found
  }

  return null
}

function findObjectFieldDeep(
  value: unknown,
  key: string,
  depth: number = 0
): Record<string, unknown> | null {
  if (depth > 4) return null
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findObjectFieldDeep(item, key, depth + 1)
      if (found) return found
    }
    return null
  }
  const obj = asObjectLike(value)
  if (!obj) return null

  const direct = asObjectLike(obj[key])
  if (direct) return direct

  for (const nestedKey of NESTED_PAYLOAD_KEYS) {
    const found = findObjectFieldDeep(obj[nestedKey], key, depth + 1)
    if (found) return found
  }

  for (const nestedValue of Object.values(obj)) {
    const found = findObjectFieldDeep(nestedValue, key, depth + 1)
    if (found) return found
  }

  return null
}

function decodeJsonEscapedString(value: string): string {
  return value.replace(/\\"/g, '"').replace(/\\\//g, "/").replace(/\\\\/g, "\\")
}

function extractEditPathsFromChangesPayload(
  input: string,
  parsed: Record<string, unknown> | null
): string[] {
  const changes = findObjectFieldDeep(parsed, "changes")
  if (changes) {
    const paths = Object.keys(changes)
      .map((path) => path.trim())
      .filter((path) => path.length > 0)
    if (paths.length > 0) return paths
  }

  // The app-server `fileChange` item carries `changes` as an ARRAY of
  // `{ path, kind, diff }` entries (not a path→change map). Collect each
  // entry's `path` so the edit card titles "Edit <path>" instead of falling
  // back to a bare "Edit".
  if (Array.isArray(parsed)) {
    const paths = parsed
      .map((change) => {
        if (!change || typeof change !== "object") return null
        const p = (change as Record<string, unknown>).path
        return typeof p === "string" && p.trim() ? p.trim() : null
      })
      .filter((p): p is string => p !== null)
    if (paths.length > 0) return paths
  }

  const firstPathMatch = input.match(/"changes"\s*:\s*\{\s*"((?:[^"\\]|\\.)+)"/)
  if (!firstPathMatch?.[1]) return []

  return [decodeJsonEscapedString(firstPathMatch[1])]
}

function extractPathFromDiffText(
  text: string | null | undefined
): string | null {
  if (!text) return null
  const match = text.match(/^(?:---|\+\+\+)\s+([^\n]+)$/m)
  if (!match?.[1]) return null
  const raw = match[1].trim()
  if (!raw || raw === "/dev/null") return null
  return raw.replace(/^[ab]\//, "")
}

function isLikelyIdField(key: string): boolean {
  const lower = key.toLowerCase()
  return (
    lower === "id" ||
    lower === "uuid" ||
    lower === "callid" ||
    lower === "call_id" ||
    lower === "tool_call_id" ||
    lower.endsWith("_id") ||
    lower.endsWith("id")
  )
}

/** Shorten an absolute path to its last 2 segments. */
function shortPath(p: string): string {
  return p.split("/").slice(-2).join("/")
}

/** Truncate text to maxLen, appending "…" if truncated. */
export function ellipsis(s: string, maxLen: number): string {
  return s.length > maxLen ? s.slice(0, maxLen - 1) + "…" : s
}

function unwrapQuotedCommand(command: string): string {
  const trimmed = command.trim()
  if (trimmed.length < 2) return trimmed

  if (trimmed.startsWith("'") && trimmed.endsWith("'")) {
    return trimmed.slice(1, -1)
  }

  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed
      .slice(1, -1)
      .replace(/\\"/g, '"')
      .replace(/\\n/g, "\n")
      .replace(/\\\\/g, "\\")
  }

  return trimmed
}

function simplifyShellCommand(command: string): string {
  let current = command.trim()
  const wrapperRe =
    /^(?:\/usr\/bin\/env\s+)?(?:(?:\/[^\s]+\/)?(?:bash|zsh|sh))\s+-(?:l?c)\s+(.+)$/i

  // Strip nested shell wrappers like "/bin/zsh -lc bash -lc '<cmd>'".
  for (let i = 0; i < 6; i += 1) {
    const wrapped = current.match(wrapperRe)
    if (!wrapped) break
    const next = unwrapQuotedCommand(wrapped[1] ?? "").trim()
    if (!next || next === current) break
    current = next
  }

  return current
}

function extractDisplayCommandFromToolInput(
  input: string | null | undefined
): string | null {
  if (!input) return null
  const parsed = tryParseJson(input)
  const command =
    (parsed ? commandFromUnknownValue(parsed) : null) ??
    extractCommandFromUnknownInput(input)
  if (!command) return null
  const simplified = simplifyShellCommand(command).trim()
  return simplified.length > 0 ? simplified : null
}

function formatCommandPrompt(command: string): string {
  return command
    .split("\n")
    .map((line, index) => `${index === 0 ? "$" : ">"} ${line}`)
    .join("\n")
}

function buildCommandTerminalOutput(
  command: string | null,
  output: string | null,
  isStreaming: boolean = false
): string {
  if (!command) return output ?? ""
  const prompt = formatCommandPrompt(command)
  const terminalOutput = output ?? ""
  const withTrailingNewline = (text: string): string =>
    text.endsWith("\n") ? text : `${text}\n`
  if (!terminalOutput) {
    return isStreaming ? withTrailingNewline(prompt) : prompt
  }

  const lines = terminalOutput.split("\n")
  const firstNonEmptyLine = lines.find((line) => line.trim().length > 0)
  const commandFirstLine = command.split("\n")[0]?.trim() ?? ""

  if (firstNonEmptyLine) {
    const trimmedLine = firstNonEmptyLine.trim()
    const lineWithoutPrompt = trimmedLine.replace(/^\$\s*/, "")
    if (
      trimmedLine === commandFirstLine ||
      lineWithoutPrompt === commandFirstLine
    ) {
      if (isStreaming && !terminalOutput.includes("\n")) {
        return withTrailingNewline(terminalOutput)
      }
      return terminalOutput
    }
  }

  return `${prompt}\n${terminalOutput}`
}

function extractCommandFromUnknownInput(input: string): string | null {
  const trimmed = input.trim()
  if (!trimmed) return null

  try {
    const parsed: unknown = JSON.parse(trimmed)
    if (typeof parsed === "string") {
      return parsed
    }
    if (Array.isArray(parsed)) {
      const parts = parsed.filter((p): p is string => typeof p === "string")
      if (parts.length > 0) return parts.join(" ")
    }
    if (parsed && typeof parsed === "object") {
      const obj = parsed as Record<string, unknown>
      const direct = obj.command ?? obj.cmd ?? obj.script
      if (typeof direct === "string") {
        return direct
      }
      if (Array.isArray(direct)) {
        const parts = direct.filter((p): p is string => typeof p === "string")
        if (parts.length > 0) return parts.join(" ")
      }
    }
  } catch {
    // Non-JSON command text is handled below.
  }

  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    return null
  }
  return trimmed
}

function commandFromUnknownValue(value: unknown): string | null {
  if (typeof value === "string") {
    const trimmed = value.trim()
    return trimmed.length > 0 ? trimmed : null
  }

  if (Array.isArray(value)) {
    const parts = value
      .map((item) => (typeof item === "string" ? item : null))
      .filter((item): item is string => item !== null && item.length > 0)
    if (parts.length > 0) {
      return parts.join(" ")
    }
    return null
  }

  if (!value || typeof value !== "object") {
    return null
  }

  const obj = value as Record<string, unknown>
  const directKeys = [
    "command",
    "cmd",
    "script",
    "args",
    "argv",
    "command_args",
  ]
  for (const key of directKeys) {
    const found = commandFromUnknownValue(obj[key])
    if (found) return found
  }

  const nestedKeys = ["input", "arguments", "params", "payload"]
  for (const key of nestedKeys) {
    const found = commandFromUnknownValue(obj[key])
    if (found) return found
  }

  return null
}

/** Get string field from parsed object */
function str(obj: Record<string, unknown>, key: string): string | undefined {
  const v = obj[key]
  return typeof v === "string" ? v : undefined
}

/** Get number field from parsed object */
function num(obj: Record<string, unknown>, key: string): number | undefined {
  const v = obj[key]
  return typeof v === "number" ? v : undefined
}

type ApplyPatchOp = "add" | "update" | "delete" | "move"

type ApplyPatchFile = {
  op: ApplyPatchOp
  path: string
  from?: string
  to?: string
}

type LineChangeStats = {
  additions: number
  deletions: number
}

function parseApplyPatchInput(input: string): {
  files: ApplyPatchFile[]
  additions: number
  deletions: number
} {
  const files: ApplyPatchFile[] = []
  let currentFileIndex = -1
  let additions = 0
  let deletions = 0

  for (const line of input.split("\n")) {
    if (line.startsWith("*** Add File: ")) {
      files.push({ op: "add", path: line.slice(14).trim() })
      currentFileIndex = files.length - 1
      continue
    }
    if (line.startsWith("*** Update File: ")) {
      files.push({ op: "update", path: line.slice(17).trim() })
      currentFileIndex = files.length - 1
      continue
    }
    if (line.startsWith("*** Delete File: ")) {
      files.push({ op: "delete", path: line.slice(17).trim() })
      currentFileIndex = files.length - 1
      continue
    }
    if (line.startsWith("*** Move to: ")) {
      const to = line.slice(13).trim()
      if (currentFileIndex >= 0) {
        const current = files[currentFileIndex]
        files[currentFileIndex] = {
          op: "move",
          path: `${current.path} -> ${to}`,
          from: current.path,
          to,
        }
      }
      continue
    }
    if (line.startsWith("+") && !line.startsWith("+++")) {
      additions += 1
      continue
    }
    if (line.startsWith("-") && !line.startsWith("---")) {
      deletions += 1
    }
  }

  return { files, additions, deletions }
}

function hasLineChanges(
  stats: LineChangeStats | null | undefined
): stats is LineChangeStats {
  return !!stats && (stats.additions > 0 || stats.deletions > 0)
}

function looksLikeDiffPayload(input: string): boolean {
  if (!input.trim()) return false
  const normalized = unescapeInlineEscapes(input)

  return (
    normalized.includes("*** Begin Patch") ||
    normalized.includes("*** Update File:") ||
    /^diff --git /m.test(normalized) ||
    (/^--- .+/m.test(normalized) && /^\+\+\+ .+/m.test(normalized)) ||
    /^@@ /m.test(normalized)
  )
}

function extractEditLineChangeStats(
  input: string | null | undefined
): LineChangeStats | null {
  if (!input || input.trim().length === 0) return null

  const parsed = tryParseJson(input)
  const patchInput = extractApplyPatchTextFromUnknownInput(input, parsed)
  if (patchInput) {
    const patchStats = parseApplyPatchInput(patchInput)
    const stats = {
      additions: patchStats.additions,
      deletions: patchStats.deletions,
    }
    if (hasLineChanges(stats)) return stats
  }

  if (parsed) {
    const changesPayload = extractEditChangesPayload(parsed)
    if (changesPayload.length > 0) {
      let additions = 0
      let deletions = 0

      for (const change of changesPayload) {
        if (change.unifiedDiff && change.unifiedDiff.trim().length > 0) {
          const diffStats = countUnifiedDiffLineChanges(change.unifiedDiff)
          additions += diffStats.additions
          deletions += diffStats.deletions
          continue
        }

        const estimated = estimateChangedLineStats(
          change.oldText,
          change.newText
        )
        additions += estimated.additions
        deletions += estimated.deletions
      }

      const stats = { additions, deletions }
      if (hasLineChanges(stats)) return stats
    }

    if (isCanonicalEditPayload(parsed)) {
      const oldString =
        str(parsed, "old_string") ?? str(parsed, "old_text") ?? ""
      const newString =
        str(parsed, "new_string") ?? str(parsed, "new_text") ?? ""
      const stats = estimateChangedLineStats(oldString, newString)
      if (hasLineChanges(stats)) return stats
    }

    const parsedDiff =
      findStringFieldDeep(parsed, "unified_diff") ??
      findStringFieldDeep(parsed, "unifiedDiff") ??
      findStringFieldDeep(parsed, "patch") ??
      findStringFieldDeep(parsed, "diff")
    if (parsedDiff && looksLikeDiffPayload(parsedDiff)) {
      const stats = countUnifiedDiffLineChanges(
        unescapeInlineEscapes(parsedDiff)
      )
      if (hasLineChanges(stats)) return stats
    }
  } else {
    // Live app-server `fileChange` input is a TOP-LEVEL array of
    // `{ path, kind, diff }` — `tryParseJson` rejects arrays, so read the
    // diff previews directly. This drives the inline `+N -M` on the edit
    // card header (matches Codex's "Edited calculator.py +1 -1").
    const previews = extractEditPreviews(input)
    if (previews.length > 0) {
      let additions = 0
      let deletions = 0
      for (const change of previews) {
        if (change.unifiedDiff && change.unifiedDiff.trim().length > 0) {
          const diffStats = countUnifiedDiffLineChanges(change.unifiedDiff)
          additions += diffStats.additions
          deletions += diffStats.deletions
          continue
        }
        const estimated = estimateChangedLineStats(
          change.oldText,
          change.newText
        )
        additions += estimated.additions
        deletions += estimated.deletions
      }
      const stats = { additions, deletions }
      if (hasLineChanges(stats)) return stats
    }
  }

  if (looksLikeDiffPayload(input)) {
    const stats = countUnifiedDiffLineChanges(unescapeInlineEscapes(input))
    if (hasLineChanges(stats)) return stats
  }

  return null
}

function unescapeInlineEscapes(text: string): string {
  return text
    .replace(/\\r\\n/g, "\n")
    .replace(/\\n/g, "\n")
    .replace(/\\t/g, "\t")
}

function extractApplyPatchTextFromUnknownInput(
  input: string,
  parsed: Record<string, unknown> | null
): string | null {
  const candidates: string[] = [input]
  const parsedCommand = parsed ? commandFromUnknownValue(parsed) : null
  if (parsedCommand) candidates.push(parsedCommand)

  const fallbackCommand = extractCommandFromUnknownInput(input)
  if (fallbackCommand) candidates.push(fallbackCommand)

  const seen = new Set<string>()

  for (const rawCandidate of candidates) {
    const candidate = rawCandidate.trim()
    if (!candidate || seen.has(candidate)) continue
    seen.add(candidate)

    const variants = [candidate]
    const unescaped = unescapeInlineEscapes(candidate)
    if (unescaped !== candidate) variants.push(unescaped)

    for (const variant of variants) {
      if (!variant.includes("*** Begin Patch")) continue

      const block = variant.match(
        /(\*\*\* Begin Patch[\s\S]*?\*\*\* End Patch(?:\n|$))/m
      )?.[1]

      if (block) return block.trim()
      return variant.trim()
    }
  }

  return null
}

function parseApplyPatchFilesFromUnknownInput(
  input: string,
  parsed: Record<string, unknown> | null
): ApplyPatchFile[] {
  const patchText = extractApplyPatchTextFromUnknownInput(input, parsed)
  if (patchText) {
    const fromPatchText = parseApplyPatchInput(patchText)
    if (fromPatchText.files.length > 0) return fromPatchText.files
  }

  const direct = parseApplyPatchInput(input)
  if (direct.files.length > 0) return direct.files

  const unescaped = unescapeInlineEscapes(input)
  if (unescaped !== input) {
    const normalized = parseApplyPatchInput(unescaped)
    if (normalized.files.length > 0) return normalized.files
  }

  return []
}

function isCanonicalEditPayload(parsed: Record<string, unknown>): boolean {
  return (
    typeof parsed.file_path === "string" ||
    typeof parsed.path === "string" ||
    typeof parsed.old_string === "string" ||
    typeof parsed.new_string === "string" ||
    parsed.replace_all === true
  )
}

type EditChangePreview = {
  path: string
  oldText: string
  newText: string
  unifiedDiff?: string
}

const EDIT_CHANGE_OLD_KEYS = [
  "old_string",
  "oldString",
  "old_text",
  "oldText",
  "old",
  "previous",
  "before",
  "source",
  "original",
]

const EDIT_CHANGE_NEW_KEYS = [
  "new_string",
  "newString",
  "new_text",
  "newText",
  "new_content",
  "newContent",
  "new",
  "new_value",
  "newValue",
  "replacement",
  "after",
  "after_text",
  "afterText",
  "updated",
  "updated_text",
  "updatedText",
  "content",
  "new_source",
  "newSource",
  "text",
]

const EDIT_CHANGE_DIFF_KEYS = ["diff", "patch", "unified_diff", "unifiedDiff"]

function collectLikelyChangeStrings(value: Record<string, unknown>): string[] {
  const entries = Object.entries(value).filter(
    ([, v]) => typeof v === "string" && v.length > 0
  ) as Array<[string, string]>
  if (entries.length === 0) return []

  const preferred = entries
    .filter(([key]) =>
      /(old|new|before|after|content|text|source|replace|value)/i.test(key)
    )
    .map(([, v]) => v)

  if (preferred.length > 0) return preferred

  return entries
    .filter(
      ([key]) =>
        !/^(id|status|type|call_id|callId|source|auto_approved)$/i.test(key)
    )
    .map(([, v]) => v)
}

function firstStringField(
  value: Record<string, unknown>,
  keys: string[]
): string | null {
  for (const key of keys) {
    const field = value[key]
    if (typeof field === "string") {
      return field
    }
  }
  return null
}

function parseEditChangeValue(
  path: string,
  value: unknown
): EditChangePreview | null {
  if (typeof value === "string") {
    return {
      path,
      oldText: "",
      newText: value,
    }
  }

  const record = asObjectLike(value)
  if (!record) return null

  const oldText =
    firstStringField(record, EDIT_CHANGE_OLD_KEYS) ??
    findStringFieldDeep(record, "old_string") ??
    findStringFieldDeep(record, "old_text") ??
    findStringFieldDeep(record, "before_text") ??
    findStringFieldDeep(record, "old") ??
    ""
  const newText =
    firstStringField(record, EDIT_CHANGE_NEW_KEYS) ??
    findStringFieldDeep(record, "new_string") ??
    findStringFieldDeep(record, "new_text") ??
    findStringFieldDeep(record, "after_text") ??
    findStringFieldDeep(record, "new") ??
    ""
  const unifiedDiff =
    firstStringField(record, EDIT_CHANGE_DIFF_KEYS) ??
    findStringFieldDeep(record, "diff") ??
    ""

  if (unifiedDiff) {
    return {
      path,
      oldText,
      newText,
      unifiedDiff,
    }
  }

  if (oldText || newText) {
    return {
      path,
      oldText,
      newText,
    }
  }

  const fallbackStrings = collectLikelyChangeStrings(record)
  if (fallbackStrings.length >= 2) {
    return {
      path,
      oldText: fallbackStrings[0],
      newText: fallbackStrings[1],
    }
  }

  if (fallbackStrings.length === 1) {
    return {
      path,
      oldText: "",
      newText: fallbackStrings[0],
    }
  }

  return {
    path,
    oldText: "",
    newText: "",
  }
}

function extractEditChangesPayload(
  parsed: Record<string, unknown>
): EditChangePreview[] {
  const changes = findObjectFieldDeep(parsed, "changes")
  if (!changes) return []

  const items: EditChangePreview[] = []
  // App-server `fileChange` array shape (`[{ path, kind, diff }]`).
  if (Array.isArray(changes)) {
    for (const change of changes) {
      const record = asObjectLike(change)
      if (!record) continue
      const path = firstStringField(record, ["path", "file_path"])
      if (!path) continue
      const parsedItem = parseEditChangeValue(path, record)
      if (parsedItem) items.push(parsedItem)
    }
    return items
  }

  // Path→change map shape (`{ "a.py": { old_string, new_string } }`).
  for (const [path, value] of Object.entries(changes)) {
    const normalizedPath = path.trim()
    if (!normalizedPath) continue
    const parsedItem = parseEditChangeValue(normalizedPath, value)
    if (parsedItem) {
      items.push(parsedItem)
    }
  }

  return items
}

// ── tool icon mapping ────────────────────────────────────────────────

const ICON_CLASS = "size-4 text-muted-foreground"

function getTaskToolIcon(input: string | null): ReactNode {
  if (!input) return <ListTodoIcon className={ICON_CLASS} />
  const t = extractJsonField(input, "subagent_type")?.toLowerCase()
  if (!t) return <ListTodoIcon className={ICON_CLASS} />
  if (t.includes("explore")) return <CompassIcon className={ICON_CLASS} />
  if (t.includes("plan")) return <MapIcon className={ICON_CLASS} />
  if (t.includes("bash")) return <TerminalIcon className={ICON_CLASS} />
  return <WrenchIcon className={ICON_CLASS} />
}

function getToolIcon(
  toolName: string,
  input?: string | null
): ReactNode | undefined {
  const name = toolName.toLowerCase()
  if (name === "read" || name === "read file")
    return <FileTextIcon className={ICON_CLASS} />
  if (name === "edit") return <FilePenLineIcon className={ICON_CLASS} />
  if (name === "write" || name === "notebookedit")
    return <FilePlusIcon className={ICON_CLASS} />
  if (name === "bash" || name === "exec_command")
    return <TerminalIcon className={ICON_CLASS} />
  if (name === "apply_patch") return <FilePenLineIcon className={ICON_CLASS} />
  if (name === "glob" || name === "grep" || name === "list_files")
    return <SearchIcon className={ICON_CLASS} />
  if (name === "memory_recall") return <BrainIcon className={ICON_CLASS} />
  if (name === "webfetch" || name === "websearch")
    return <GlobeIcon className={ICON_CLASS} />
  if (name === "todowrite") return <ListTodoIcon className={ICON_CLASS} />
  if (name === "task") return getTaskToolIcon(input ?? null)
  if (name === "taskcreate" || name === "taskupdate" || name === "tasklist")
    return <ListTodoIcon className={ICON_CLASS} />
  if (name === "agent") return getTaskToolIcon(input ?? null)
  if (name === COLLAB_AGENT_TOOL_NAME)
    return <UsersIcon className={ICON_CLASS} />
  if (name === "skill") return <SparklesIcon className={ICON_CLASS} />
  if (
    name === "enterplanmode" ||
    name === "exitplanmode" ||
    name === "switch_mode"
  )
    return <ListTodoIcon className={ICON_CLASS} />
  if (name === "attempt_completion")
    return <CircleCheckIcon className={ICON_CLASS} />
  if (name === "question")
    return <MessageCircleQuestionMarkIcon className={ICON_CLASS} />
  return undefined
}

// ── title derivation ──────────────────────────────────────────────────

function deriveToolTitle(
  toolName: string,
  input: string | null,
  output?: string | null
): string | null {
  const name = toolName.toLowerCase()
  const titleSource = input ?? output ?? null
  if (!titleSource) return null
  const parsedInput = input ? tryParseJson(input) : null
  const parsedOutput = output ? tryParseJson(output) : null
  const parsed = parsedInput ?? parsedOutput

  const getField = (key: string): string | null => {
    const nested = findStringFieldDeep(parsed, key)
    if (nested) return nested
    if (input) {
      const fromInput = extractJsonField(input, key)
      if (fromInput) return fromInput
    }
    if (output) {
      const fromOutput = extractJsonField(output, key)
      if (fromOutput) return fromOutput
    }
    return null
  }

  // Cline: attempt_completion — show result summary as title
  if (name === "attempt_completion") {
    const result = getField("result")
    if (result) {
      const firstLine = result.split("\n")[0].trim()
      return `${ellipsis(firstLine, 80)}`
    }
    return "Completion"
  }

  // File-based tools
  const filePath =
    getField("file_path") ??
    getField("filePath") ??
    getField("target_file") ??
    getField("targetFile") ??
    getField("filename") ??
    getField("path") ??
    getField("notebook_path")
  if (filePath) {
    const sp = shortPath(filePath)
    if (name === "read" || name === "read file") return `Read ${sp}`
    if (name === "edit") return `Edit ${sp}`
    if (name === "write") return `Write ${sp}`
    if (name === "notebookedit") return `NotebookEdit ${sp}`
  }

  // Command tools
  if (name === "bash" || name === "exec_command") {
    const description = getField("description")
    if (description) {
      return ellipsis(description, 80)
    }
    const direct = getField("command") ?? getField("cmd") ?? getField("script")
    const parsedCommand = commandFromUnknownValue(parsed)
    const fallback = extractCommandFromUnknownInput(titleSource)
    const command = direct ?? parsedCommand ?? fallback
    if (command) {
      return `Ran ${ellipsis(simplifyShellCommand(command).split("\n")[0], 80)}`
    }
    return null
  }

  if (name === "apply_patch") {
    const files = parseApplyPatchFilesFromUnknownInput(titleSource, parsed)
    if (files.length === 0) return "Edit"
    if (files.length === 1) {
      const file = files[0]
      const targetPath =
        file.op === "move" && file.to
          ? file.to
          : (file.from ?? file.to ?? file.path)
      return `Edit ${shortPath(targetPath)}`
    }
    return `Edit (${files.length} files)`
  }

  if (name === "edit") {
    const patchFiles = parseApplyPatchFilesFromUnknownInput(titleSource, parsed)
    if (patchFiles.length === 1) {
      const file = patchFiles[0]
      const targetPath =
        file.op === "move" && file.to
          ? file.to
          : (file.from ?? file.to ?? file.path)
      return `Edit ${shortPath(targetPath)}`
    }
    if (patchFiles.length > 1) return `Edit (${patchFiles.length} files)`

    const changedPaths = extractEditPathsFromChangesPayload(titleSource, parsed)
    if (changedPaths.length === 1) return `Edit ${shortPath(changedPaths[0])}`
    if (changedPaths.length > 1) return `Edit (${changedPaths.length} files)`

    const diffPath = extractPathFromDiffText(output)
    if (diffPath) return `Edit ${shortPath(diffPath)}`
    return "Edit"
  }

  // Command-like fallback: if input looks like a shell command payload,
  // keep title behavior consistent with historical command tool rendering.
  const commandLike =
    (parsed ? commandFromUnknownValue(parsed) : null) ??
    extractCommandFromUnknownInput(titleSource)
  if (commandLike && commandLike.trim().length > 0) {
    return ellipsis(simplifyShellCommand(commandLike).split("\n")[0], 80)
  }

  // Search tools
  if (name === "glob") {
    const p = getField("pattern")
    if (p) return `Glob ${p}`
  }
  if (name === "grep") {
    const p = getField("pattern")
    if (p) return `Grep ${ellipsis(p, 50)}`
    // Args may not be forwarded yet (or at all) on some hosts; fall back to
    // the first result line so the card isn't a bare "grep" with no context.
    if (output) {
      const firstHit = output.trim().split("\n")[0]?.trim()
      if (firstHit) return `Grep ${ellipsis(firstHit, 50)}`
    }
    return "Search"
  }
  // Engine-classified directory listings (`ls`, `find`): "List <dir>".
  if (name === "list_files") {
    const p = getField("pattern")
    return `List ${p && p !== "*" ? shortPath(p) : "files"}`
  }

  // Task / agent tools
  if (name === "task") {
    const subagent = getField("subagent_type")
    const desc = getField("description")
    const prefix = subagent ? `${subagent}: ` : ""
    if (desc) return `${prefix}${ellipsis(desc, 60 - prefix.length)}`
    if (subagent) return subagent
  }
  if (name === "agent") {
    const subagent = getField("subagent_type")
    const desc = getField("description")
    const prefix = subagent ? `${subagent}: ` : ""
    if (desc) return `${prefix}${ellipsis(desc, 60 - prefix.length)}`
    if (subagent) return subagent
  }
  if (name === "taskcreate") {
    const subj = getField("subject")
    if (subj) return `TaskCreate: ${ellipsis(subj, 50)}`
  }
  if (name === "taskupdate") {
    const id = getField("taskId")
    const status = getField("status")
    if (id) return `TaskUpdate #${id}${status ? ` → ${status}` : ""}`
  }

  // Web tools
  if (name === "webfetch") {
    const url = getField("url")
    if (url) return `WebFetch ${ellipsis(url, 60)}`
  }
  if (name === "websearch") {
    const q = getField("query")
    if (q) return `WebSearch: ${ellipsis(q, 50)}`
  }

  // TodoWrite
  if (name === "todowrite") {
    if (parsed) {
      const todos = parsed.todos
      if (Array.isArray(todos)) {
        const count = todos.length
        const done = todos.filter(
          (t: Record<string, unknown>) => t.status === "completed"
        ).length
        return `Todos (${done}/${count})`
      }
    }
    return "TodoWrite"
  }

  // Skill
  if (name === "skill") {
    const sk = getField("skill")
    if (sk) return `Skill: ${sk}`
  }

  // clock.sleep — show the wait duration ("Sleep 30s") instead of a bare
  // tool name. durationMs (wire camelCase) or duration_ms both accepted.
  if (name === "sleep") {
    const rawDuration = getField("durationMs") ?? getField("duration_ms")
    const durationMs = Number(rawDuration)
    if (Number.isFinite(durationMs) && durationMs > 0) {
      const secs = durationMs / 1000
      const label = secs >= 60 ? `${Math.round(secs / 60)}m` : `${secs}s`
      return `Sleep ${label}`
    }
    return "Sleep"
  }

  // EnterPlanMode / ExitPlanMode / SwitchMode
  if (
    name === "enterplanmode" ||
    name === "exitplanmode" ||
    name === "switch_mode"
  ) {
    const plan = getField("plan")
    if (plan) {
      const firstLine = plan
        .split("\n")
        .map((l) => l.replace(/^#+\s*/, "").trim())
        .find((l) => l.length > 0)
      if (firstLine) return `Plan · ${ellipsis(firstLine, 60)}`
    }
    const title = getField("title")
    if (title) return `Plan · ${title}`
    return "Plan"
  }

  // Generic: try to show the first string field as context
  if (parsed) {
    for (const [k, v] of Object.entries(parsed)) {
      if (isLikelyIdField(k)) {
        continue
      }
      if (typeof v === "string" && v.length > 0) {
        return `${toolName}: ${ellipsis(v, 50)}`
      }
    }
  }

  return null
}

function sanitizeLiveTitle(title: string | null | undefined): string | null {
  const trimmed = title?.trim()
  if (!trimmed) return null

  const callIdTitle = trimmed.match(
    /^[:：'"`“”‘’\s]*([a-z0-9_.-]+)(?:\s*[:：])?\s*call[\w-]*['"`“”‘’\s]*$/i
  )
  const source = callIdTitle?.[1] ?? trimmed
  const normalized = normalizeToolName(source)
  if (normalized === "apply_patch" || normalized === "edit") {
    return "Edit"
  }
  if (
    /\b(?:functions\.)?(?:edit|apply[_\s-]?patch)\b/i.test(trimmed) &&
    /\bcall[\w-]*\b/i.test(trimmed)
  ) {
    return "Edit"
  }
  if (normalized === "bash" || normalized === "exec_command") {
    return "Command"
  }
  return trimmed
}

function localizeDerivedToolTitle(
  title: string | null,
  t: (key: string, values?: Record<string, unknown>) => string
): string | null {
  if (!title) return null

  if (title === "Edit") return t("title.edit")
  if (title === "Command") return t("title.command")
  if (title === "TodoWrite") return t("title.todoWrite")
  if (title === "Read") return t("title.read")
  if (title === "Write") return t("title.write")
  if (title === "NotebookEdit") return t("title.notebookEdit")

  const editFilesMatch = title.match(/^Edit \((\d+) files\)$/)
  if (editFilesMatch) {
    return t("title.editFiles", { count: Number(editFilesMatch[1]) })
  }

  const editWithTarget = title.match(/^Edit (.+)$/)
  if (editWithTarget) {
    return t("title.editWithTarget", { target: editWithTarget[1] })
  }

  const readWithTarget = title.match(/^Read (.+)$/)
  if (readWithTarget) {
    return t("title.readWithTarget", { target: readWithTarget[1] })
  }

  const writeWithTarget = title.match(/^Write (.+)$/)
  if (writeWithTarget) {
    return t("title.writeWithTarget", { target: writeWithTarget[1] })
  }

  const notebookEditWithTarget = title.match(/^NotebookEdit (.+)$/)
  if (notebookEditWithTarget) {
    return t("title.notebookEditWithTarget", {
      target: notebookEditWithTarget[1],
    })
  }

  const globWithPattern = title.match(/^Glob (.+)$/)
  if (globWithPattern) {
    return t("title.globWithPattern", { pattern: globWithPattern[1] })
  }

  const grepWithPattern = title.match(/^Grep (.+)$/)
  if (grepWithPattern) {
    return t("title.grepWithPattern", { pattern: grepWithPattern[1] })
  }

  const taskCreateWithSubject = title.match(/^TaskCreate: (.+)$/)
  if (taskCreateWithSubject) {
    return t("title.taskCreateWithSubject", {
      subject: taskCreateWithSubject[1],
    })
  }

  const taskUpdateWithStatus = title.match(/^TaskUpdate #([^ ]+)(?: → (.+))?$/)
  if (taskUpdateWithStatus) {
    const id = taskUpdateWithStatus[1]
    const status = taskUpdateWithStatus[2]
    if (status) {
      return t("title.taskUpdateWithStatus", { id, status })
    }
    return t("title.taskUpdate", { id })
  }

  const webFetchWithUrl = title.match(/^WebFetch (.+)$/)
  if (webFetchWithUrl) {
    return t("title.webFetchWithUrl", { url: webFetchWithUrl[1] })
  }

  const webSearchWithQuery = title.match(/^WebSearch: (.+)$/)
  if (webSearchWithQuery) {
    return t("title.webSearchWithQuery", { query: webSearchWithQuery[1] })
  }

  const todosProgress = title.match(/^Todos \((\d+)\/(\d+)\)$/)
  if (todosProgress) {
    return t("title.todosProgress", {
      done: Number(todosProgress[1]),
      total: Number(todosProgress[2]),
    })
  }

  const skillWithName = title.match(/^Skill: (.+)$/)
  if (skillWithName) {
    return t("title.skillWithName", { name: skillWithName[1] })
  }

  const genericWithContext = title.match(/^([^:]+): (.+)$/)
  if (genericWithContext) {
    return t("title.genericWithContext", {
      tool: genericWithContext[1],
      context: genericWithContext[2],
    })
  }

  return title
}

// ── Specialized tool input renderers ─────────────────────────────────

/** Edit tool: file path + unified diff view */
function EditToolInput({ input }: { input: Record<string, unknown> }) {
  const filePath = str(input, "file_path")
  const oldString = str(input, "old_string") ?? ""
  const newString = str(input, "new_string") ?? ""
  const startLine = num(input, "_start_line")

  const diffCode = useMemo(() => {
    const diff = generateUnifiedDiff(
      oldString,
      newString,
      filePath ?? undefined
    )
    if (!diff || !startLine || startLine <= 1) return diff ?? ""
    // Replace line numbers in hunk headers with real start line
    return diff.replace(
      /^@@ -(\d+),(\d+) \+(\d+),(\d+) @@/gm,
      (_, _o, oc, _n, nc) => `@@ -${startLine},${oc} +${startLine},${nc} @@`
    )
  }, [oldString, newString, filePath, startLine])

  return diffCode ? (
    <UnifiedDiffPreview diffText={diffCode} clickableFilePath />
  ) : null
}

/** Edit tool (changes payload): combined diff view */
function EditChangesToolInput({ changes }: { changes: EditChangePreview[] }) {
  const diffCode = useMemo(() => {
    const diffParts: string[] = []

    for (const change of changes) {
      if (change.unifiedDiff && change.unifiedDiff.trim().length > 0) {
        diffParts.push(change.unifiedDiff.trim())
        diffParts.push("")
        continue
      }

      const generated = generateUnifiedDiff(
        change.oldText,
        change.newText,
        change.path
      )
      if (generated) {
        diffParts.push(generated)
        diffParts.push("")
      }
    }

    return diffParts.join("\n").trim()
  }, [changes])

  return diffCode ? (
    <UnifiedDiffPreview diffText={diffCode} clickableFilePath />
  ) : null
}

/** Bash / exec_command: terminal-style command display */
function BashToolInput({ input }: { input: Record<string, unknown> }) {
  const t = useTranslations("Folder.chat.contentParts")
  const command =
    commandFromUnknownValue(input) ??
    str(input, "command") ??
    str(input, "cmd") ??
    str(input, "script")
  const description = str(input, "description")
  const timeout = num(input, "timeout")
  const background = input.run_in_background === true
  const displayCommand = command ? simplifyShellCommand(command) : null

  return (
    <div className="space-y-2">
      {description && (
        <div className="flex items-center gap-2 text-xs">
          <TerminalIcon className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="text-muted-foreground">{description}</span>
        </div>
      )}
      {displayCommand && <CodeBlock code={displayCommand} language="bash" />}
      {(timeout || background) && (
        <div className="flex flex-wrap gap-3 text-xs text-muted-foreground">
          {timeout && <span>{t("timeoutMs", { timeout })}</span>}
          {background && <span>{t("backgroundTrue")}</span>}
        </div>
      )}
    </div>
  )
}

/**
 * Parse structured read output from backend: `{"start_line":N,"content":"..."}`.
 * Falls back to raw text with startLine=1 if not structured.
 */
/**
 * codex classifies file-reading shell commands (sed/cat/head) as ACP `read`
 * commandActions whose output is a command-execution envelope — codex-acp's
 * `createCommandExecutionCompleteUpdate` always sends BOTH
 * `{ formatted_output: <string>, exit_code: <number> }` — NOT the
 * `{ start_line, content }` read shape. Return the inner `formatted_output` so the
 * file content renders. Requiring BOTH keys keeps a genuine JSON-file read
 * (`{ output: … }`, `{ stdout: … }`, a lone `{ exit_code: 0 }`, …) from being
 * mistaken for a command envelope. Returns null when it isn't that exact shape.
 */
export function codexCommandReadOutput(raw: string): string | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    return null
  const obj = parsed as Record<string, unknown>
  if (
    typeof obj.exit_code !== "number" ||
    typeof obj.formatted_output !== "string"
  ) {
    return null
  }
  const out = obj.formatted_output
  // Strip codex's CLI framing ("Chunk ID:/Wall time:/…/Output:\n<content>") only
  // when the output actually STARTS with that metadata — so a clean file whose
  // first line happens to be "Output:" is never truncated by the envelope parser.
  const firstLine = (
    out.split("\n").find((l) => l.trim().length > 0) ?? ""
  ).trim()
  return CLI_META_LINE_RE.test(firstLine)
    ? parseCliExecutionEnvelope(out).output
    : out
}

export function parseReadOutput(raw: string): {
  startLine: number
  content: string
} {
  try {
    const parsed = JSON.parse(raw)
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      typeof parsed.start_line === "number" &&
      typeof parsed.content === "string"
    ) {
      return { startLine: parsed.start_line, content: parsed.content }
    }
  } catch {
    // not JSON
  }
  const cmdOut = codexCommandReadOutput(raw)
  if (cmdOut !== null) return { startLine: 1, content: cmdOut }
  return { startLine: 1, content: raw }
}

/** Lightweight file content viewer with line numbers */
function FileContentLines({
  content,
  startLine = 1,
  highlight,
}: {
  content: string
  startLine?: number
  /** "added" tints every line green to indicate new content (e.g. Write tool). */
  highlight?: "added"
}) {
  const lines = useMemo(() => content.split("\n"), [content])
  const rowClass =
    highlight === "added"
      ? "flex bg-green-500/10 text-green-900 dark:text-green-300"
      : "flex"

  return (
    <div className="inline-block min-w-full font-mono text-[12px] leading-[20px]">
      {lines.map((line, i) => (
        <div key={i} className={rowClass}>
          <span className="w-[3.5rem] shrink-0 select-none pr-1 text-right text-muted-foreground/40">
            {startLine + i}
          </span>
          <span className="flex-1 whitespace-pre pr-3">{line}</span>
        </div>
      ))}
    </div>
  )
}

/** Read / Write / NotebookEdit: file-focused display */
function FileToolInput({
  toolName,
  input,
  output,
}: {
  toolName: string
  input: Record<string, unknown>
  output?: string | null
}) {
  const t = useTranslations("Folder.chat.contentParts")
  const name = toolName.toLowerCase()
  const filePath =
    str(input, "file_path") ?? str(input, "path") ?? str(input, "notebook_path")
  const content = str(input, "content")
  const newSource = str(input, "new_source")
  const offset = num(input, "offset")
  const limit = num(input, "limit")
  const pages = str(input, "pages")
  const cellType = str(input, "cell_type")
  const editMode = str(input, "edit_mode")
  const isRead = name === "read" || name === "read file"

  const badges: string[] = []
  if (offset != null) badges.push(t("offset", { offset }))
  if (limit != null) badges.push(t("limit", { limit }))
  if (pages) badges.push(t("pages", { pages }))
  if (editMode) badges.push(t("mode", { mode: editMode }))
  if (cellType) badges.push(t("cell", { cell: cellType }))

  const { displayContent, startLine } = useMemo(() => {
    if (isRead && output) {
      const parsed = parseReadOutput(output)
      return { displayContent: parsed.content, startLine: parsed.startLine }
    }
    return {
      displayContent: content ?? newSource ?? null,
      startLine: 1,
    }
  }, [isRead, output, content, newSource])

  return (
    <section className="flex max-h-[420px] flex-col rounded-lg border border-border bg-background">
      <header className="flex shrink-0 items-center gap-2 border-b border-border bg-muted/40 px-3 py-2 text-[11px]">
        <span className="shrink-0 rounded border border-border bg-background px-1.5 py-0.5 text-[10px] text-muted-foreground">
          {isRead ? "READ" : "WRITE"}
        </span>
        {filePath ? (
          <FilePathLink
            filePath={filePath}
            className="min-w-0 flex-1 font-mono text-foreground"
          >
            {filePath}
          </FilePathLink>
        ) : (
          <span className="min-w-0 flex-1 truncate font-mono text-foreground">
            {t("unknown")}
          </span>
        )}
        {badges.length > 0 && (
          <span className="ml-auto inline-flex shrink-0 items-center gap-2 text-[10px] text-muted-foreground">
            {badges.map((b) => (
              <span key={b}>{b}</span>
            ))}
          </span>
        )}
      </header>
      {displayContent && (
        <div className="overflow-auto">
          <FileContentLines
            content={displayContent}
            startLine={startLine}
            highlight={isRead ? undefined : "added"}
          />
        </div>
      )}
    </section>
  )
}

/** Glob / Grep: search-focused display */
function SearchToolInput({
  toolName,
  input,
}: {
  toolName: string
  input: Record<string, unknown>
}) {
  const t = useTranslations("Folder.chat.contentParts")
  const name = toolName.toLowerCase()
  const pattern = str(input, "pattern")
  const path = str(input, "path")
  const glob = str(input, "glob")
  const outputMode = str(input, "output_mode")
  const fileType = str(input, "type")
  const caseInsensitive = input["-i"] === true
  const multiline = input.multiline === true

  return (
    <div className="space-y-2">
      {pattern && (
        <div className="flex items-center gap-2 rounded-md bg-muted/50 px-3 py-2">
          <SearchIcon className="size-3.5 shrink-0 text-muted-foreground" />
          <code className="break-all text-xs text-foreground">{pattern}</code>
        </div>
      )}
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
        {path && (
          <span>
            {t("pathLabel")}{" "}
            <span className="font-mono text-foreground">{path}</span>
          </span>
        )}
        {glob && (
          <span>
            {t("globLabel")}{" "}
            <span className="font-mono text-foreground">{glob}</span>
          </span>
        )}
        {fileType && (
          <span>
            {t("typeLabel")}{" "}
            <span className="font-mono text-foreground">{fileType}</span>
          </span>
        )}
        {name === "grep" && outputMode && (
          <span>
            {t("outputLabel")}{" "}
            <span className="font-mono text-foreground">{outputMode}</span>
          </span>
        )}
        {caseInsensitive && <span>{t("caseInsensitive")}</span>}
        {multiline && <span>{t("multiline")}</span>}
      </div>
    </div>
  )
}

/** Web tools: URL / query focused */
function WebToolInput({
  toolName,
  input,
}: {
  toolName: string
  input: Record<string, unknown>
}) {
  const t = useTranslations("Folder.chat.contentParts")
  const name = toolName.toLowerCase()
  const url = str(input, "url")
  const query = str(input, "query")
  const prompt = str(input, "prompt")

  return (
    <div className="space-y-2">
      {name === "websearch" && query && (
        <div className="flex items-center gap-2 rounded-md bg-muted/50 px-3 py-2">
          <SearchIcon className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="break-all text-xs font-medium text-foreground">
            {query}
          </span>
        </div>
      )}
      {name === "webfetch" && url && (
        <div className="flex items-center gap-2 rounded-md bg-muted/50 px-3 py-2">
          <GlobeIcon className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="break-all font-mono text-xs text-foreground">
            {url}
          </span>
        </div>
      )}
      {prompt && (
        <div className="space-y-1">
          <span className="text-xs font-medium text-muted-foreground">
            {t("promptLabel")}
          </span>
          <div className="rounded-md bg-muted/50 p-3 text-xs prose prose-sm dark:prose-invert max-w-none [&_ul]:list-inside [&_ol]:list-inside">
            <MessageResponse>{prompt}</MessageResponse>
          </div>
        </div>
      )}
    </div>
  )
}

/** Task tools: description / subject focused */
function TaskToolInput({ input }: { input: Record<string, unknown> }) {
  const t = useTranslations("Folder.chat.contentParts")
  const subject = str(input, "subject")
  const taskId = str(input, "taskId")
  const status = str(input, "status")
  const agentName = str(input, "name")

  const hasFields = subject || taskId || agentName
  if (!hasFields) return null

  return (
    <div className="space-y-2">
      {subject && (
        <div className="flex items-baseline gap-2 text-xs">
          <span className="shrink-0 font-medium text-muted-foreground">
            {t("subjectLabel")}
          </span>
          <span className="text-foreground">{subject}</span>
        </div>
      )}
      {taskId && (
        <div className="flex items-baseline gap-2 text-xs">
          <span className="shrink-0 font-medium text-muted-foreground">
            {t("taskLabel")}
          </span>
          <span className="font-mono text-foreground">
            #{taskId}
            {status ? ` → ${status}` : ""}
          </span>
        </div>
      )}
      {agentName && (
        <div className="text-xs text-muted-foreground">
          {t("nameLabel")}{" "}
          <span className="font-mono text-foreground">{agentName}</span>
        </div>
      )}
    </div>
  )
}

/**
 * TodoWrite tool input. The todo checklist intentionally renders ONLY in the
 * floating Agent Plan overlay — no inline checklist in the message flow.
 */
function TodoWriteToolInput({ input }: { input: Record<string, unknown> }) {
  void input
  return null
}

function ApplyPatchToolInput({ input }: { input: string }) {
  return <UnifiedDiffPreview diffText={input} clickableFilePath />
}

// ── Generic structured input (fallback) ──────────────────────────────

/** Fields that typically contain code / long text → render in code blocks */
const CODE_FIELDS = new Set([
  "command",
  "old_string",
  "new_string",
  "content",
  "new_source",
  "prompt",
])

/** Fields to hide */
const HIDDEN_FIELDS = new Set(["dangerouslyDisableSandbox"])

function GenericToolInput({ input }: { input: string }) {
  const t = useTranslations("Folder.chat.contentParts")
  const parsed = useMemo(() => tryParseJson(input), [input])

  if (!parsed) {
    return (
      <pre className="whitespace-pre-wrap break-all rounded-md bg-muted/50 p-3 text-xs text-muted-foreground">
        {input}
      </pre>
    )
  }

  const entries = Object.entries(parsed).filter(([k]) => !HIDDEN_FIELDS.has(k))

  if (entries.length === 0) return null

  return (
    <div className="space-y-3">
      {entries.map(([key, value]) => {
        const labelKey = fieldLabelKey(key)
        const label = labelKey ? t(labelKey) : key

        if (CODE_FIELDS.has(key) && typeof value === "string") {
          const lang =
            key === "command"
              ? ("bash" as const)
              : key === "prompt"
                ? ("log" as const)
                : ("log" as const)
          return (
            <FieldBlock key={key} label={label}>
              <CodeBlock code={value} language={lang} />
            </FieldBlock>
          )
        }

        if (typeof value === "string") {
          if (value.length > 200) {
            return (
              <FieldBlock key={key} label={label}>
                <pre className="whitespace-pre-wrap break-all rounded-md bg-muted/50 p-3 text-xs">
                  {value}
                </pre>
              </FieldBlock>
            )
          }
          return <FieldInline key={key} label={label} value={value} />
        }

        if (typeof value === "number" || typeof value === "boolean") {
          return <FieldInline key={key} label={label} value={String(value)} />
        }

        if (value !== null && value !== undefined) {
          return (
            <FieldBlock key={key} label={label}>
              <CodeBlock
                code={JSON.stringify(value, null, 2)}
                language="json"
              />
            </FieldBlock>
          )
        }

        return null
      })}
    </div>
  )
}

// ── Dispatcher ───────────────────────────────────────────────────────

function isTruncatedInput(input: string): boolean {
  return input.endsWith('..."') || input.endsWith("...")
}

/**
 * Edit-change previews for a tool input across every producer shape:
 *   - LIVE app-server `fileChange`: the input IS a TOP-LEVEL array of
 *     `{ path, kind, diff }` (`JSON.stringify(item.changes)`).
 *   - Web restore / other agents: `{ changes: [...] }` or `{ changes: {...} }`.
 * `tryParseJson` rejects arrays, so callers that want the array shape must go
 * through this (it powers the edit diff body instead of raw JSON noise).
 */
function extractEditPreviews(input: string): EditChangePreview[] {
  if (!input) return []
  let raw: unknown
  try {
    raw = JSON.parse(input)
  } catch {
    return []
  }
  if (Array.isArray(raw)) {
    const items: EditChangePreview[] = []
    for (const entry of raw) {
      const record = asObjectLike(entry)
      if (!record) continue
      const path = firstStringField(record, ["path", "file_path"]) ?? ""
      const item = parseEditChangeValue(path, record)
      if (item) items.push(item)
    }
    return items
  }
  const obj = asObjectLike(raw)
  if (!obj) return []
  return extractEditChangesPayload(obj)
}

function StructuredToolInput({
  toolName,
  input,
  output,
}: {
  toolName: string
  input: string
  output?: string | null
}) {
  const t = useTranslations("Folder.chat.contentParts")
  const name = toolName.toLowerCase()
  const parsed = useMemo(() => tryParseJson(input), [input])
  const truncated =
    (name === "edit" || name === "write" || name === "apply_patch") &&
    isTruncatedInput(input)

  const truncationBanner = truncated ? (
    <div className="rounded-md bg-yellow-500/10 px-2.5 py-1.5 text-[11px] text-yellow-700 dark:text-yellow-400">
      {t("inputTruncated")}
    </div>
  ) : null

  if (name === "apply_patch") {
    // Direct apply_patch scripts (shell heredocs, dedicated tool calls).
    const patchInput = extractApplyPatchTextFromUnknownInput(input, parsed)
    if (patchInput) {
      return (
        <>
          {truncationBanner}
          <ApplyPatchToolInput input={patchInput} />
        </>
      )
    }
    // Reopened sessions persist the app-server `fileChange` as a
    // `{ changes: [...] }` payload rather than an apply_patch script —
    // render those diffs the same way the live "edit" card does instead of
    // dumping the raw JSON.
    const previews = extractEditPreviews(input)
    if (previews.length > 0) {
      return (
        <>
          {truncationBanner}
          <EditChangesToolInput changes={previews} />
        </>
      )
    }
    // Structured diff in the tool output (injected by the backend).
    if (output && typeof output === "string" && /^@@ /m.test(output)) {
      return (
        <>
          {truncationBanner}
          <UnifiedDiffPreview diffText={output} clickableFilePath />
        </>
      )
    }
    return (
      <>
        {truncationBanner}
        <ApplyPatchToolInput input={input} />
      </>
    )
  }

  if (name === "bash" || name === "exec_command") {
    if (parsed) {
      return <BashToolInput input={parsed} />
    }
    const plainCommand = extractCommandFromUnknownInput(input)
    if (plainCommand) {
      return <BashToolInput input={{ command: plainCommand }} />
    }
  }

  if (name === "edit") {
    // The LIVE app-server `fileChange` input is a TOP-LEVEL array of
    // `{ path, kind, diff }` entries (`JSON.stringify(item.changes)`).
    // `tryParseJson` rejects arrays, so build the diff preview from the raw
    // input — otherwise the card dumps the raw JSON noise instead of the diff.
    const previews = extractEditPreviews(input)
    if (previews.length > 0) {
      return (
        <>
          {truncationBanner}
          <EditChangesToolInput changes={previews} />
        </>
      )
    }
    const patchInput = extractApplyPatchTextFromUnknownInput(input, parsed)
    if (patchInput) {
      return (
        <>
          {truncationBanner}
          <ApplyPatchToolInput input={patchInput} />
        </>
      )
    }
    // Prefer tool output if it contains a structured diff with real line numbers
    // (injected by backend from toolUseResult.structuredPatch)
    if (output && typeof output === "string" && /^@@ /m.test(output)) {
      return (
        <>
          {truncationBanner}
          <UnifiedDiffPreview diffText={output} clickableFilePath />
        </>
      )
    }
    if (parsed && isCanonicalEditPayload(parsed)) {
      return (
        <>
          {truncationBanner}
          <EditToolInput input={parsed} />
        </>
      )
    }
    if (!parsed) {
      return (
        <pre className="whitespace-pre-wrap break-all rounded-md bg-muted/50 p-3 text-xs text-muted-foreground">
          {input}
        </pre>
      )
    }
    return <GenericToolInput input={input} />
  }

  if (!parsed) {
    return (
      <pre className="whitespace-pre-wrap break-all rounded-md bg-muted/50 p-3 text-xs text-muted-foreground">
        {input}
      </pre>
    )
  }

  if (name === "bash" || name === "exec_command")
    return <BashToolInput input={parsed} />
  if (
    name === "read" ||
    name === "read file" ||
    name === "write" ||
    name === "notebookedit"
  )
    return <FileToolInput toolName={toolName} input={parsed} output={output} />
  if (name === "glob" || name === "grep")
    return <SearchToolInput toolName={toolName} input={parsed} />
  if (name === "webfetch" || name === "websearch")
    return <WebToolInput toolName={toolName} input={parsed} />
  if (name === "todowrite") return <TodoWriteToolInput input={parsed} />
  if (
    name === "task" ||
    name === "taskcreate" ||
    name === "taskupdate" ||
    name === "tasklist"
  )
    return <TaskToolInput input={parsed} />

  return <GenericToolInput input={input} />
}

// ── Shared field components ──────────────────────────────────────────

function FieldInline({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline gap-2 text-xs">
      <span className="shrink-0 font-medium text-muted-foreground">
        {label}
      </span>
      <span className="break-all font-mono text-foreground">{value}</span>
    </div>
  )
}

function FieldBlock({
  label,
  children,
}: {
  label: string
  children: React.ReactNode
}) {
  return (
    <div className="space-y-1">
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      <div className="rounded-md bg-muted/50">{children}</div>
    </div>
  )
}

const FIELD_LABEL_KEYS = {
  file_path: "field.file",
  notebook_path: "field.notebook",
  command: "field.command",
  cmd: "field.command",
  old_string: "field.old",
  new_string: "field.new",
  pattern: "field.pattern",
  path: "field.path",
  query: "field.query",
  url: "field.url",
  description: "field.description",
  content: "field.content",
  new_source: "field.source",
  prompt: "field.prompt",
  subject: "field.subject",
  taskId: "field.taskId",
  status: "field.status",
  skill: "field.skill",
  args: "field.args",
  offset: "field.offset",
  limit: "field.limit",
  glob: "field.glob",
  type: "field.type",
  output_mode: "field.output",
  replace_all: "field.replaceAll",
  language: "field.language",
  timeout: "field.timeout",
  run_in_background: "field.background",
  subagent_type: "field.agentType",
  libraryName: "field.library",
  libraryId: "field.libraryId",
} as const

function fieldLabelKey(
  key: string
): (typeof FIELD_LABEL_KEYS)[keyof typeof FIELD_LABEL_KEYS] | null {
  const translationKey = FIELD_LABEL_KEYS[key as keyof typeof FIELD_LABEL_KEYS]
  return translationKey ?? null
}

function commandOutputFromJsonString(output: string): string | null {
  try {
    const parsed: unknown = JSON.parse(output)
    if (typeof parsed === "string") {
      return parsed
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null
    }

    const obj = parsed as Record<string, unknown>
    const isCommandEnvelope =
      "command" in obj ||
      "parsed_cmd" in obj ||
      "cwd" in obj ||
      "exit_code" in obj ||
      "stdout" in obj ||
      "stderr" in obj ||
      "formatted_output" in obj ||
      "aggregated_output" in obj
    // Prefer raw stdout/stderr when present (more likely to preserve ANSI colors).
    const stdout = typeof obj.stdout === "string" ? obj.stdout : ""
    const stderr = typeof obj.stderr === "string" ? obj.stderr : ""
    if (stdout.length > 0 || stderr.length > 0) {
      if (stdout.length > 0 && stderr.length > 0) {
        return `${stdout}\n[stderr]\n${stderr}`
      }
      return stdout || stderr
    }

    const preferredKeys = [
      "formatted_output",
      "aggregated_output",
      "output",
      "text",
      "result",
    ]
    for (const key of preferredKeys) {
      const value = obj[key]
      if (typeof value === "string" && value.length > 0) {
        return value
      }
    }

    // Some command results are metadata-only envelopes (command/cwd/exit_code).
    // Returning empty string avoids rendering raw JSON as terminal output.
    if (isCommandEnvelope) {
      return ""
    }

    return null
  } catch {
    return null
  }
}

function stripMarkdownCodeFence(text: string): string {
  let result = text
  // Remove leading fenced-code line like ```sh / ```bash / ```
  result = result.replace(/^\s*```[\w-]*\s*\n?/, "")
  // Remove trailing closing fence if present
  result = result.replace(/\n?\s*```\s*$/, "")
  return result
}

/** Regex matching metadata lines in CLI execution output envelopes. */
const CLI_META_LINE_RE =
  /^(exit code\s*[:=]|wall time\s*[:=]|chunk id\s*[:=]|original token count\s*[:=]|total output lines\s*[:=]|process exited with code\s)/i

/**
 * Parse a CLI execution envelope, stripping all metadata and the "Output:"
 * separator, returning only the actual command output and the wall time.
 *
 * Handles formats like:
 *   Chunk ID: 065b2b
 *   Wall time: 0.05s
 *   Process exited with code 0
 *   Original token count: 27006
 *   Output:
 *   Total output lines: 1134
 *   <actual output here>
 */
function parseCliExecutionEnvelope(text: string): {
  output: string
  wallTime: string | null
} {
  const lines = text.split("\n")
  let wallTime: string | null = null

  // Look for "Output:" separator and extract wall time from header
  let outputSepIndex = -1
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim()
    const wtMatch = trimmed.match(/^wall time\s*:\s*(.+)/i)
    if (wtMatch) wallTime = wtMatch[1].trim()
    if (/^output:\s*$/i.test(trimmed)) {
      outputSepIndex = i
      break
    }
    // Stop scanning if we hit a non-metadata, non-blank line (actual content)
    if (!CLI_META_LINE_RE.test(trimmed) && trimmed.length > 0) break
  }

  // If "Output:" separator found, skip everything before it plus any
  // remaining metadata/blank lines after it
  if (outputSepIndex >= 0) {
    let start = outputSepIndex + 1
    while (start < lines.length) {
      const trimmed = lines[start].trim()
      if (CLI_META_LINE_RE.test(trimmed) || trimmed.length === 0) {
        start++
        continue
      }
      break
    }
    return { output: lines.slice(start).join("\n"), wallTime }
  }

  // No "Output:" separator — strip leading metadata lines
  let index = 0
  let sawMeta = false
  while (index < lines.length) {
    const trimmed = lines[index].trim()
    if (CLI_META_LINE_RE.test(trimmed)) {
      sawMeta = true
      if (!wallTime) {
        const wtMatch = trimmed.match(/^wall time\s*:\s*(.+)/i)
        if (wtMatch) wallTime = wtMatch[1].trim()
      }
      index++
      continue
    }
    if (sawMeta && trimmed.length === 0) {
      index++
      continue
    }
    break
  }

  if (!sawMeta) return { output: text, wallTime: null }

  while (index < lines.length && lines[index].trim().length === 0) index++
  return { output: lines.slice(index).join("\n"), wallTime }
}

// ── Part components ───────────────────────────────────────────────────

const TextPart = memo(function TextPart({
  text,
  isUser = false,
}: {
  text: string
  // User messages render as plain text + inline reference badges (no Markdown),
  // matching the plain-text composer. Assistant / system text keeps full Markdown.
  isUser?: boolean
}) {
  if (isUser) {
    return (
      <div className="break-words text-sm">
        <PlainTextWithBadges text={text} />
      </div>
    )
  }
  return (
    <div className='break-words text-sm leading-6 prose prose-sm dark:prose-invert max-w-none prose-p:my-3 first:prose-p:mt-0 last:prose-p:mb-0 [&_ul]:list-inside [&_ol]:list-inside [&_[data-streamdown="code-block-body"]]:max-h-96 [&_[data-streamdown="code-block-body"]]:overflow-auto'>
      <MessageResponse>{text}</MessageResponse>
    </div>
  )
})

const ToolCallPart = memo(function ToolCallPart({
  part,
}: {
  part: Extract<AdaptedContentPart, { type: "tool-call" }>
}) {
  const t = useTranslations("Folder.chat.contentParts")
  const [manualOpen, setManualOpen] = useState(false)
  const normalizedToolName = useMemo(
    () => normalizeToolName(part.toolName),
    [part.toolName]
  )
  const rawToolNameLower = normalizedToolName.toLowerCase()
  const isRawCommandTool =
    rawToolNameLower === "bash" || rawToolNameLower === "exec_command"
  // The agent often runs apply_patch THROUGH the shell as a heredoc
  // (`apply_patch << 'PATCH' … *** Begin Patch …`), which otherwise renders as
  // a noisy bash card full of patch text. Detect it and treat it like a
  // dedicated apply_patch tool: clean "Edit <file>" header + diff preview.
  const isShellApplyPatch = useMemo(() => {
    if (!isRawCommandTool) return false
    const parsed = tryParseJson(part.input ?? "")
    const command =
      parsed && typeof parsed.cmd === "string" ? parsed.cmd : (part.input ?? "")
    return (
      command.includes("*** Begin Patch") ||
      /^\s*apply_patch\b/.test(command.trim())
    )
  }, [isRawCommandTool, part.input])
  const effectiveToolName = isShellApplyPatch
    ? "apply_patch"
    : normalizedToolName
  const toolNameLower = effectiveToolName.toLowerCase()
  const isCommandTool = isRawCommandTool && !isShellApplyPatch
  const isCommandLikeTool = isCommandTool || toolNameLower === "apply_patch"
  const isRunning =
    part.state === "input-available" || part.state === "input-streaming"
  // A `Bash(run_in_background: true)` launch — its result is just the task id +
  // an "output is being written to …" notice. Flag the command card as a
  // background launch (header badge + concise body) instead of dumping that
  // notice; the actual run surfaces later in a <BackgroundTaskCard>.
  const backgroundLaunch = useMemo(
    () =>
      isCommandTool
        ? parseBackgroundLaunch(part.output ?? part.errorText ?? null)
        : null,
    [isCommandTool, part.output, part.errorText]
  )
  const title = useMemo(() => {
    const rawTitle =
      deriveToolTitle(
        effectiveToolName,
        part.input,
        part.output ?? part.errorText ?? null
      ) ??
      sanitizeLiveTitle(part.displayTitle) ??
      null
    return localizeDerivedToolTitle(rawTitle, ((key, values) =>
      t(key as never, values as never)) as (
      key: string,
      values?: Record<string, unknown>
    ) => string)
  }, [
    effectiveToolName,
    part.input,
    part.output,
    part.errorText,
    part.displayTitle,
    t,
  ])
  const lineChangeStats = useMemo(() => {
    if (toolNameLower !== "edit" && toolNameLower !== "apply_patch") {
      return null
    }

    // Prefer finalized tool output, then the declared input.
    // Keep error text as last fallback because permission wrappers can include
    // verbose envelopes that inflate +/- counts before approval.
    const prioritizedCandidates = [
      part.output ?? null,
      part.input,
      part.errorText ?? null,
    ]
    for (const candidate of prioritizedCandidates) {
      const stats = extractEditLineChangeStats(candidate)
      if (!stats) continue
      return stats
    }
    return null
  }, [toolNameLower, part.input, part.output, part.errorText])
  const wallTime = useMemo(() => {
    const source = part.output ?? part.errorText
    if (!source) return null
    const normalized = commandOutputFromJsonString(source) ?? source
    const match = normalized.match(/^wall time\s*:\s*(.+)/im)
    if (!match) return null
    const raw = match[1].trim()
    // Parse "0.0519 seconds" → "52ms", "1.234 seconds" → "1.2s"
    const numMatch = raw.match(/^([\d.]+)\s*s/)
    if (!numMatch) return raw
    const sec = parseFloat(numMatch[1])
    if (Number.isNaN(sec)) return raw
    if (sec < 0.001) return "<1ms"
    if (sec < 1) return `${Math.round(sec * 1000)}ms`
    if (sec < 60) return `${sec.toFixed(1)}s`
    return `${(sec / 60).toFixed(1)}m`
  }, [part.output, part.errorText])
  const titleSuffix = useMemo(() => {
    const hasStats =
      lineChangeStats &&
      (lineChangeStats.additions > 0 || lineChangeStats.deletions > 0)
    if (!hasStats && !wallTime && !backgroundLaunch) return null

    return (
      <span className="flex items-center gap-1.5 text-xs font-medium">
        {backgroundLaunch && (
          <span
            className="inline-flex items-center gap-1 rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground"
            title={backgroundLaunch.taskId}
          >
            <TerminalIcon className="size-3" />
            {t("backgroundTask.runningInBackground")}
          </span>
        )}
        {hasStats && lineChangeStats.additions > 0 && (
          <span className="inline-flex items-center gap-0.5 text-green-600 dark:text-green-400">
            <PlusIcon className="size-3" />
            {lineChangeStats.additions}
          </span>
        )}
        {hasStats && lineChangeStats.deletions > 0 && (
          <span className="inline-flex items-center gap-0.5 text-red-600 dark:text-red-400">
            <MinusIcon className="size-3" />
            {lineChangeStats.deletions}
          </span>
        )}
        {wallTime && (
          <span className="text-muted-foreground/60 font-normal">
            {wallTime}
          </span>
        )}
      </span>
    )
  }, [lineChangeStats, wallTime, backgroundLaunch, t])

  const icon = useMemo(
    () => getToolIcon(effectiveToolName, part.input),
    [effectiveToolName, part.input]
  )
  const displayCommand = useMemo(() => {
    if (!isCommandTool) return null
    return (
      extractDisplayCommandFromToolInput(part.input) ??
      extractDisplayCommandFromToolInput(part.output) ??
      extractDisplayCommandFromToolInput(part.errorText)
    )
  }, [isCommandTool, part.input, part.output, part.errorText])
  const commandOutput = useMemo(() => {
    if (!isCommandLikeTool) return null
    const source =
      typeof part.output === "string"
        ? part.output
        : typeof part.errorText === "string"
          ? part.errorText
          : null
    if (!source) return null
    const normalized = commandOutputFromJsonString(source) ?? source
    const envelope = parseCliExecutionEnvelope(normalized)
    return stripMarkdownCodeFence(envelope.output)
  }, [isCommandLikeTool, part.output, part.errorText])
  const hasLiveOutput =
    isRunning && isCommandTool && typeof commandOutput === "string"
  const liveOutput = useMemo(() => {
    if (!hasLiveOutput || typeof commandOutput !== "string") {
      return null
    }
    const maxChars = 24000
    return commandOutput.length > maxChars
      ? commandOutput.slice(-maxChars)
      : commandOutput
  }, [hasLiveOutput, commandOutput])
  const liveOutputTruncated =
    hasLiveOutput &&
    typeof commandOutput === "string" &&
    typeof liveOutput === "string" &&
    liveOutput.length < commandOutput.length
  const shouldRenderCommandTerminal =
    isCommandTool &&
    (isRunning ||
      (typeof commandOutput === "string" && commandOutput.length > 0) ||
      (typeof displayCommand === "string" && displayCommand.length > 0))
  const terminalOutput = useMemo(() => {
    if (!shouldRenderCommandTerminal) return ""
    if (backgroundLaunch) {
      // Replace the verbose "Output is being written to <tmp path>…" notice
      // with a concise localized line; the real run shows in its own card.
      return buildCommandTerminalOutput(
        displayCommand,
        t("backgroundTask.launchNote", { id: backgroundLaunch.taskId }),
        false
      )
    }
    const output = hasLiveOutput ? (liveOutput ?? "") : (commandOutput ?? "")
    return buildCommandTerminalOutput(displayCommand, output, isRunning)
  }, [
    shouldRenderCommandTerminal,
    backgroundLaunch,
    t,
    hasLiveOutput,
    liveOutput,
    commandOutput,
    displayCommand,
    isRunning,
  ])
  const isFileTool =
    toolNameLower === "read" ||
    toolNameLower === "read file" ||
    toolNameLower === "write" ||
    toolNameLower === "notebookedit"
  const shouldHideDuplicateResult =
    (toolNameLower === "edit" ||
      toolNameLower === "apply_patch" ||
      toolNameLower === "switch_mode" ||
      toolNameLower === "enterplanmode" ||
      toolNameLower === "exitplanmode" ||
      isFileTool) &&
    !part.errorText
  // codex-acp #288: the context-compaction lifecycle is a `tool_call` tagged
  // with `_meta.contextCompaction` (not addressed by tool name) → a subtle
  // status card instead of the generic tool shell.
  if (isContextCompactionMeta(part.meta)) {
    return <ContextCompactionCard state={part.state} meta={part.meta} />
  }

  // Agent/subagent tools get a dedicated container rendering
  if (toolNameLower === "agent") {
    return (
      <AgentToolCallPart
        part={part}
        renderToolCall={(p, key) => (
          // Strip agentStats to prevent recursive Agent nesting
          <ToolCallPart key={key} part={{ ...p, agentStats: undefined }} />
        )}
      />
    )
  }

  if (toolNameLower === "create_goal" || toolNameLower === "update_goal") {
    return <GoalToolCallPart part={{ ...part, toolName: normalizedToolName }} />
  }

  // codex live collab / sub-agent activity (codex-acp 1.0.1 #223): a compact
  // streaming-time card showing the sub-agent message. Reconstructed into the
  // richer "Agent" capsule from the rollout on history reload.
  if (toolNameLower === COLLAB_AGENT_TOOL_NAME) {
    return (
      <CollabAgentCard
        input={part.input ?? null}
        errorText={part.errorText ?? null}
        state={part.state}
      />
    )
  }

  // Multi-agent delegation tool: surfaces an inline DelegatedSubThread
  // bound to the child sub-session via parent_tool_use_id. Matches the
  // bare `delegate_to_agent` (post-normalization) plus any host-specific
  // server-prefixed form (`mcp__<server>__delegate_to_agent`,
  // `<server>/delegate_to_agent`, `<server>.delegate_to_agent`, etc.)
  // as a defensive fallback in case the value reaches the renderer
  // un-normalized. Falls through to the normal renderer when no
  // toolCallId is available (snapshot replays without a live binding)
  // so the user still sees the tool input/output.
  if (isDelegateToAgentToolName(normalizedToolName) && part.toolCallId) {
    return (
      <DelegatedSubThread
        parentToolUseId={part.toolCallId}
        input={part.input ?? null}
        output={part.output ?? null}
        errorText={part.errorText ?? null}
        state={part.state}
        meta={part.meta ?? null}
      />
    )
  }

  // Multi-agent delegation companion tools: render compact status cards
  // consistent with DelegatedSubThread instead of the generic tool shell.
  // `normalizeToolName` has already collapsed any host-specific server prefix
  // (`mcp__<server>__…`) to these canonical names.
  if (toolNameLower === "get_delegation_status") {
    return (
      <DelegationStatusCard
        kind="status"
        input={part.input ?? null}
        output={part.output ?? null}
        errorText={part.errorText ?? null}
        state={part.state}
      />
    )
  }
  if (toolNameLower === "cancel_delegation") {
    return (
      <DelegationStatusCard
        kind="cancel"
        input={part.input ?? null}
        output={part.output ?? null}
        errorText={part.errorText ?? null}
        state={part.state}
      />
    )
  }

  // codeg-mcp ask_user_question: render the asked question(s) and the user's
  // selection as a dedicated read-only card instead of the generic tool shell.
  // The live interactive answering is handled separately by the pinned
  // AskQuestionCard; this is the in-stream record (historical + in-flight).
  if (toolNameLower === "question") {
    return (
      <AskQuestionResultCard
        input={part.input ?? null}
        output={part.output ?? null}
        errorText={part.errorText ?? null}
        state={part.state}
      />
    )
  }

  // codeg-mcp check_user_feedback: render the received steering notes as a
  // capsule. The no-op polls (count: 0) and in-flight checks are dropped upstream
  // by `dropHiddenFeedbackChecks`, so reaching here means there is feedback to
  // show (or, rarely, an error).
  if (toolNameLower === "check_user_feedback") {
    return (
      <FeedbackCheckResultCard
        output={part.output ?? null}
        errorText={part.errorText ?? null}
        state={part.state}
      />
    )
  }

  // Cline: attempt_completion — render as an expanded card with result + progress
  if (toolNameLower === "attempt_completion") {
    const parsedCompletion = tryParseJson(part.input ?? "")
    const completionResult =
      (parsedCompletion?.result as string | undefined)?.trim() ?? null
    const taskProgress =
      (parsedCompletion?.task_progress as string | undefined)?.trim() ?? null
    return (
      <Tool open onOpenChange={setManualOpen}>
        <ToolHeader
          type="dynamic-tool"
          state={part.state}
          toolName={effectiveToolName}
          title={title ?? "Completion"}
          icon={icon}
        />
        <ToolContent>
          {completionResult && (
            <div className="text-sm prose prose-sm dark:prose-invert max-w-none [&_ul]:list-inside [&_ol]:list-inside">
              <MessageResponse>{completionResult}</MessageResponse>
            </div>
          )}
          {taskProgress && (
            <div className="mt-2 rounded-md border bg-muted/30 px-3 py-2">
              <div className="text-[11px] font-medium text-muted-foreground mb-1">
                Progress
              </div>
              <div className="text-xs prose prose-sm dark:prose-invert max-w-none [&_ul]:list-inside [&_ol]:list-inside">
                <MessageResponse>{taskProgress}</MessageResponse>
              </div>
            </div>
          )}
        </ToolContent>
      </Tool>
    )
  }

  // Plan-mode transition tools (EnterPlanMode/ExitPlanMode/switch_mode): render
  // the plan directly via a dedicated card instead of folding into a misleading
  // "思考 N 次" tool-group. `toolNameLower` is the underscore-preserving
  // `tool-call-normalization` form, so `switch_mode` keeps its underscore here.
  if (
    toolNameLower === "enterplanmode" ||
    toolNameLower === "exitplanmode" ||
    toolNameLower === "switch_mode"
  ) {
    return (
      <PlanModeCard
        toolName={toolNameLower}
        input={part.input ?? null}
        errorText={part.errorText ?? null}
        state={part.state}
      />
    )
  }

  // Only auto-open while the tool is actively running (so live streaming
  // output stays visible). A COMPLETED tool — e.g. a finished Read whose file
  // content just arrived — stays collapsed showing its header; the user
  // expands it on demand instead of the card popping open with the output.
  const open = isRunning || manualOpen
  // Edit / apply_patch cards render transparent (no gray backdrop) so the
  // patch diff reads inline against the chat background — matches how the
  // diff appears in the editor rather than inside a "card".
  const isEditLike =
    toolNameLower === "edit" ||
    toolNameLower === "apply_patch" ||
    toolNameLower === "write" ||
    toolNameLower === "notebookedit"
  // Command cards show the lifecycle status as a PREFIX word (Codex-style
  // "Ran git -C . status ..."). `deriveToolTitle` already returns
  // "Ran <command>" for bash/exec_command titles, so the prefix is baked in —
  // this only flips it to "Running" while the command is in flight.
  const commandDisplayTitle =
    isCommandTool && isRunning && title?.startsWith("Ran ")
      ? `Running ${title.slice(4)}`
      : title
  // Command cards are also transparent (no gray box) with a terminal icon.
  const isTransparentCard = isEditLike || isCommandTool
  return (
    <Tool
      open={open}
      onOpenChange={setManualOpen}
      className={
        isTransparentCard ? "border-transparent bg-transparent" : undefined
      }
    >
      <ToolHeader
        type="dynamic-tool"
        state={part.state}
        toolName={effectiveToolName}
        title={commandDisplayTitle}
        titleSuffix={titleSuffix ?? undefined}
        icon={icon}
        className={
          isTransparentCard
            ? "border-b-transparent bg-transparent hover:bg-transparent"
            : undefined
        }
        // Edit cards drop the status chip entirely — the header reads
        // "Edit calculator.py +2 −2" with no "· Ran"/"· Edited" suffix.
        // Command cards fold the status into the title prefix instead.
        hideStatus={isEditLike || isCommandTool}
      />
      <ToolContent
        contentClassName={isTransparentCard ? "bg-transparent" : undefined}
      >
        {(part.input || (isFileTool && !!part.output)) &&
          (!isCommandTool || !shouldRenderCommandTerminal) && (
            <StructuredToolInput
              toolName={effectiveToolName}
              // File tools may legitimately arrive without args (mid-stream
              // tool_call, or a shell command classified as read with no
              // location). The file view still has everything it needs from
              // `output`, so don't let a missing input blank the card body.
              input={part.input ?? "{}"}
              output={part.output}
            />
          )}
        {toolNameLower === "task" && part.output ? (
          <div className="text-sm prose prose-sm dark:prose-invert max-w-none [&_ul]:list-inside [&_ol]:list-inside">
            <MessageResponse>{part.output}</MessageResponse>
          </div>
        ) : (
          <>
            {shouldRenderCommandTerminal ? (
              <div>
                <TerminalOutput
                  output={terminalOutput}
                  isStreaming={isRunning}
                />
                {liveOutputTruncated && (
                  <div className="text-[11px] text-muted-foreground">
                    {t("showingTailOutput")}
                  </div>
                )}
              </div>
            ) : (
              !shouldHideDuplicateResult &&
              (part.output || part.errorText) && (
                <ToolOutput output={part.output} errorText={part.errorText} />
              )
            )}
          </>
        )}
      </ToolContent>
    </Tool>
  )
})

const ToolResultPart = memo(function ToolResultPart({
  part,
}: {
  part: Extract<AdaptedContentPart, { type: "tool-result" }>
}) {
  const t = useTranslations("Folder.chat.contentParts")
  return (
    <Tool>
      <ToolHeader
        type="dynamic-tool"
        state={part.state}
        toolName={t("result")}
      />
      <ToolContent>
        <ToolOutput output={part.output} errorText={part.errorText} />
      </ToolContent>
    </Tool>
  )
})

const ReasoningPart = memo(function ReasoningPart({
  part,
}: {
  part: Extract<AdaptedContentPart, { type: "reasoning" }>
}) {
  const hasContent = part.content.trim().length > 0
  const expandable = hasContent || part.isStreaming
  return (
    <Reasoning isStreaming={part.isStreaming} expandable={expandable}>
      <ReasoningTrigger />
      {expandable && <ReasoningContent>{part.content}</ReasoningContent>}
    </Reasoning>
  )
})

const PlanPart = memo(function PlanPart({
  part,
}: {
  part: Extract<AdaptedContentPart, { type: "plan" }>
}) {
  // The todo checklist is shown only in the floating Agent Plan overlay —
  // keep the part in the adapted data (the overlay reads `plan` parts) but
  // render nothing inline in the message flow.
  void part
  return null
})

// Codex Plan-mode `<proposed_plan>` block: free-form markdown plan document
// rendered inside card chrome (distinct from the TodoWrite checklist PlanCard).
const ProposedPlanPart = memo(function ProposedPlanPart({
  part,
}: {
  part: Extract<AdaptedContentPart, { type: "proposed-plan" }>
}) {
  const t = useTranslations("Folder.chat.proposedPlan")
  const markdown = part.markdown.trim()
  return (
    <div className="overflow-hidden rounded-lg border bg-card/50 ws-msg-card">
      <div className="flex items-center gap-2 border-b px-3 py-2">
        <ClipboardListIcon className="size-4 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate text-sm font-medium">
          {t("title")}
        </span>
      </div>
      <div className="px-3 py-2 text-sm">
        {markdown.length > 0 ? (
          <MessageResponse>{markdown}</MessageResponse>
        ) : (
          <span className="text-muted-foreground">{t("planning")}</span>
        )}
      </div>
    </div>
  )
})

// ── Tool group ("Explored") ───────────────────────────────────────────

/**
 * Parse the row label + detail for a tool inside the "Explored" group, in
 * opencode's shape: a bare lane word as the title ("Read" / "Grep" / "List")
 * and the target as a muted subtitle. The adapted part's `input` is the
 * synthesized per-lane payload (read → `{"file_path": …}`, search/list →
 * `{"pattern": …}`).
 */
function groupItemDetail(
  item: Extract<AdaptedContentPart, { type: "tool-call" }>
): {
  title: string
  subtitle: string | null
} {
  let parsed: Record<string, unknown> | null = null
  try {
    parsed = item.input
      ? (JSON.parse(item.input) as Record<string, unknown>)
      : null
  } catch {
    parsed = null
  }
  const pattern =
    typeof parsed?.pattern === "string" && parsed.pattern.length > 0
      ? (parsed.pattern as string)
      : null
  const kind = classifyToolKind(item.toolName)
  switch (kind) {
    case "read": {
      const filePath =
        typeof parsed?.file_path === "string"
          ? (parsed.file_path as string)
          : null
      return { title: "Read", subtitle: filePath ? shortPath(filePath) : null }
    }
    case "search":
      return { title: "Grep", subtitle: pattern ? ellipsis(pattern, 50) : null }
    case "list":
      return {
        title: "List",
        subtitle: pattern && pattern !== "*" ? shortPath(pattern) : null,
      }
    default:
      return {
        title:
          deriveToolTitle(item.toolName, item.input, item.output) ??
          item.toolName,
        subtitle: null,
      }
  }
}

const ToolGroupItemRow = memo(function ToolGroupItemRow({
  item,
}: {
  item: Extract<AdaptedContentPart, { type: "tool-call" }>
}) {
  const t = useTranslations("Folder.chat.contentParts.toolGroup")
  const { title, subtitle } = groupItemDetail(item)
  const icon = getToolIcon(item.toolName, item.input)
  const hasOutput = typeof item.output === "string" && item.output.length > 0
  const isError = item.state === "output-error" || !!item.errorText
  // Each lane (Read/Grep/List) gets its own collapse/expand control for its
  // output — collapsed by default, manual chevron toggles it. No auto-open.
  const [rowOpen, setRowOpen] = useState(false)
  return (
    <div className="flex min-w-0 flex-col">
      <div className="flex min-w-0 items-baseline gap-1.5 py-0.5">
        <span className="flex size-3.5 shrink-0 items-center justify-center text-muted-foreground">
          {icon ?? <WrenchIcon className="size-3.5" />}
        </span>
        <span className="shrink-0 text-[13px] font-medium leading-5 text-foreground">
          {title}
        </span>
        {subtitle && (
          <span className="min-w-0 truncate text-[13px] leading-5 text-muted-foreground">
            {subtitle}
          </span>
        )}
        {isError && (
          <span className="shrink-0 text-xs text-destructive">
            {t("errorSuffix", { count: 1 })}
          </span>
        )}
        {hasOutput && (
          <button
            type="button"
            onClick={() => setRowOpen((v) => !v)}
            aria-expanded={rowOpen}
            aria-label={rowOpen ? t("collapseOutput") : t("expandOutput")}
            className="ml-auto -mr-1 shrink-0 rounded p-0.5 text-muted-foreground/60 transition-colors hover:bg-muted/40 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <ChevronRightIcon
              className={cn(
                "size-3.5 transition-transform",
                rowOpen && "rotate-90"
              )}
            />
          </button>
        )}
      </div>
      {hasOutput && rowOpen && (
        <pre
          className={cn(
            "mt-0.5 ml-5 max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-md px-2.5 py-1.5 font-mono text-xs leading-5",
            isError ? "text-destructive" : "text-muted-foreground"
          )}
        >
          {item.output}
        </pre>
      )}
    </div>
  )
})

const ToolGroupPart = memo(function ToolGroupPart({
  part,
}: {
  part: Extract<AdaptedContentPart, { type: "tool-group" }>
}) {
  const t = useTranslations("Folder.chat.contentParts.toolGroup")
  const [userOpen, setUserOpen] = useState<boolean | null>(null)
  // Collapsed by default — the user expands the "Explored" row with the
  // chevron when they want to see the read/search lanes. No auto-expand on
  // completion; the toggle is purely manual.
  const open = userOpen ?? false

  const { phrases, errorPhrase } = useMemo(() => {
    const counts = TOOL_KIND_ORDER.reduce(
      (acc, kind) => {
        acc[kind] = 0
        return acc
      },
      {} as Record<ToolKindLabel, number>
    )
    let errors = 0
    for (const item of part.items) {
      counts[classifyToolKind(item.toolName)] += 1
      if (item.state === "output-error" || item.errorText) errors += 1
    }
    const built: string[] = []
    for (const kind of TOOL_KIND_ORDER) {
      const count = counts[kind]
      if (count <= 0) continue
      built.push(t(kind, { count }))
    }
    if (built.length === 0) {
      built.push(t("other", { count: part.items.length }))
    }
    return {
      phrases: built,
      errorPhrase: errors > 0 ? t("errorSuffix", { count: errors }) : null,
    }
  }, [part, t])

  if (part.items.length === 0) return null

  const joiner = t("joiner")
  const titleText = phrases.join(joiner)
  // opencode-style: "Exploring" / "Explored" status word, then the per-lane
  // counts ("2 reads, 1 search") — inline row with the chevron on the right.
  const statusLabel = part.isStreaming ? t("exploring") : t("explored")

  return (
    <Collapsible open={open} onOpenChange={setUserOpen} className="w-full">
      <CollapsibleTrigger
        className={cn(
          "group flex w-full min-w-0 items-center gap-1.5 rounded-md py-1 text-left transition-colors",
          "hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1"
        )}
      >
        <span className="shrink-0 text-[13px] font-medium leading-5 text-foreground">
          {part.isStreaming ? (
            <Shimmer as="span" duration={1} shineColor="var(--primary)">
              {statusLabel}
            </Shimmer>
          ) : (
            statusLabel
          )}
        </span>
        <span className="min-w-0 truncate text-[13px] font-normal leading-5 text-muted-foreground">
          {titleText}
          {errorPhrase && (
            <span className="pl-1.5 text-destructive">{errorPhrase}</span>
          )}
        </span>
        <ChevronRightIcon
          aria-hidden="true"
          className={cn(
            "ml-auto size-3.5 shrink-0 text-muted-foreground/60 transition-transform",
            open && "rotate-90"
          )}
        />
      </CollapsibleTrigger>
      <CollapsibleContent
        className={cn(
          "w-full outline-none",
          "data-[state=open]:animate-in data-[state=closed]:animate-out",
          "data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0"
        )}
      >
        <div className="ml-3 mt-1 flex flex-col gap-0.5 border-l border-border/60 pl-3">
          {part.items.map((item, idx) => (
            <ToolGroupItemRow
              key={`grouped-tc-${item.toolCallId ?? idx}-${idx}`}
              item={item}
            />
          ))}
        </div>
      </CollapsibleContent>
    </Collapsible>
  )
})

// ── Main renderer ─────────────────────────────────────────────────────

interface ContentPartsRendererProps {
  parts: AdaptedContentPart[]
  role?: MessageRole
}

export const ContentPartsRenderer = memo(function ContentPartsRenderer({
  parts,
  role,
}: ContentPartsRendererProps) {
  const renderPart = (part: AdaptedContentPart, keyId: string): ReactNode => {
    if (part.type === "text") {
      return (
        <TextPart
          key={`text-${keyId}`}
          text={part.text}
          isUser={role === "user"}
        />
      )
    }

    if (part.type === "tool-call") {
      // Include the part index in the key: a duplicated tool call id (e.g. the
      // same call bridged twice after a reconnect) would otherwise produce
      // non-unique React keys and duplicate/omit children.
      return (
        <ToolCallPart
          key={`tc-${part.toolCallId ?? "call"}-${keyId}`}
          part={part}
        />
      )
    }

    if (part.type === "tool-group") {
      return <ToolGroupPart key={`tg-${keyId}`} part={part} />
    }

    if (part.type === "goal-run") {
      return (
        <GoalRunPart
          key={`goal-${keyId}`}
          part={part}
          renderPart={(child, childKey) => renderPart(child, childKey)}
        />
      )
    }

    if (part.type === "delegation-status-group") {
      return (
        <DelegationStatusGroupCard key={`dsg-${keyId}`} polls={part.polls} />
      )
    }

    if (part.type === "background-task-group") {
      return <BackgroundTaskCard key={`btg-${keyId}`} polls={part.polls} />
    }

    if (part.type === "tool-result") {
      return (
        <ToolResultPart
          key={`tr-${part.toolCallId ?? "result"}-${keyId}`}
          part={part}
        />
      )
    }

    if (part.type === "reasoning") {
      return <ReasoningPart key={`reasoning-${keyId}`} part={part} />
    }

    if (part.type === "plan") {
      return <PlanPart key={`plan-${keyId}`} part={part} />
    }

    if (part.type === "proposed-plan") {
      return <ProposedPlanPart key={`proposed-plan-${keyId}`} part={part} />
    }

    if (part.type === "generated-image") {
      return (
        <GeneratedImagesBlock
          key={`gimg-${keyId}`}
          revisedPrompt={part.revisedPrompt}
          image={part.image}
          status={part.status}
        />
      )
    }

    return null
  }

  return (
    <div className="space-y-4">
      {parts.map((part, i) => renderPart(part, `${i}`))}
    </div>
  )
})
