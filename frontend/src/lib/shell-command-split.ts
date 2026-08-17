/**
 * Client-side shell command splitter.
 *
 * The engine classifies every shell command into `commandActions`
 * (`read` / `search` / `listFiles` / `unknown`), but chained commands —
 * `head -n 20 f && echo "----TAIL----" && tail -n 10 f`, or
 * `grep -n x f; echo "File contents:"; cat -n f` — come back as a single
 * `unknown` action (or a mixed set), so the UI shows one opaque
 * `/bin/zsh -lc "..."` bash card. Official Codex runs reads/searches as
 * separate tool calls and shows one labeled card per operation.
 *
 * This module splits a chained command into individually classifiable
 * segments (Read / Grep / List / command) and — when the chain used
 * `echo`/`printf` labels as separators — segments the combined output back
 * onto the right card, so `head && echo && tail` renders two "Read <path>"
 * cards each showing its own lines.
 *
 * Deliberately dependency-free (no `@/` imports) so its unit tests run under
 * vitest without the alias resolver.
 */

export type SplitCommandSegmentKind = "read" | "search" | "list" | "command"

export interface SplitCommandSegment {
  command: string
  kind: SplitCommandSegmentKind
  output: string | null
}

const READ_WORDS = new Set([
  "head",
  "cat",
  "sed",
  "tail",
  "less",
  "more",
  "awk",
  "view",
  "od",
  "xxd",
])

const SEARCH_WORDS = new Set(["grep", "rg", "ack", "ag"])

const LIST_WORDS = new Set(["ls", "find", "tree", "glob"])

function isEchoToken(token: string): boolean {
  const t = token.trim().toLowerCase()
  return (
    t === "echo" ||
    t === "printf" ||
    t.startsWith("echo ") ||
    t.startsWith("printf ")
  )
}

/** Strip a `/bin/zsh -lc 'CMD'` / `bash -c "CMD"` wrapper the engine adds.
 *  Flags are often combined (`-lc` = `-l -c`), so match the shell binary
 *  followed by any flag tokens and take the quoted payload verbatim. */
function unwrapShellCommand(command: string): string {
  const trimmed = command.trim()
  const m = trimmed.match(
    /^(?:\/[^\s]*\/)?(?:bash|zsh|sh|dash)\b(?:\s+-\w+)*\s+(['"])([\s\S]*)\1$/
  )
  if (m && m[2]) return m[2]
  return trimmed
}

/** Quote-aware split on `&&`, `||`, `;`, and newlines (not `|` — pipelines stay whole). */
function tokenize(command: string): string[] {
  const tokens: string[] = []
  let current = ""
  let quote: "'" | '"' | null = null
  let i = 0
  const flush = () => {
    const t = current.trim()
    if (t) tokens.push(t)
    current = ""
  }
  while (i < command.length) {
    const ch = command[i]
    if (quote) {
      current += ch
      if (ch === quote) quote = null
      i++
      continue
    }
    if (ch === "'" || ch === '"') {
      quote = ch
      current += ch
      i++
      continue
    }
    const pair = command.slice(i, i + 2)
    if (pair === "&&" || pair === "||") {
      flush()
      i += 2
      continue
    }
    if (ch === ";" || ch === "\n") {
      flush()
      i++
      continue
    }
    current += ch
    i++
  }
  flush()
  return tokens
}

function classifyToken(token: string): SplitCommandSegmentKind {
  const first = token.trim().split(/\s+/)[0] ?? ""
  const base = first.includes("/") ? (first.split("/").pop() ?? first) : first
  const lower = base.toLowerCase()
  if (READ_WORDS.has(lower)) return "read"
  if (SEARCH_WORDS.has(lower)) return "search"
  if (LIST_WORDS.has(lower)) return "list"
  return "command"
}

/** The literal text an `echo`/`printf` token prints, for output segmentation. */
function echoLabel(token: string): string | null {
  const t = token.trim()
  const m = t.match(/^(?:echo|printf)\s+(.*)$/i)
  if (!m) return null
  let label = m[1].trim()
  label = label.replace(/^-(?:e|n|E)\s+/, "")
  if (
    (label.startsWith('"') && label.endsWith('"')) ||
    (label.startsWith("'") && label.endsWith("'"))
  ) {
    label = label.slice(1, -1)
  }
  if (!label) return null
  return label
}

/** File path for a read segment — the last non-flag, non-numeric argument. */
function readFilePath(cmd: string): string | null {
  const tokens = cmd.trim().split(/\s+/)
  for (let i = tokens.length - 1; i >= 0; i--) {
    const t = tokens[i]
    if (t.startsWith("-")) continue
    if (/^\d+$/.test(t)) continue
    if (t === "2>/dev/null" || t === ">" || t === "|") continue
    return t.replace(/^['"]|['"]$/g, "")
  }
  return null
}

/** Query for a search segment — first quoted arg, else first non-flag arg. */
function searchQuery(cmd: string): string | null {
  const quoted = cmd.match(/["']([^"']+)["']/)
  if (quoted) return quoted[1]
  const tokens = cmd.trim().split(/\s+/)
  for (let i = 1; i < tokens.length; i++) {
    const t = tokens[i]
    if (t.startsWith("-")) continue
    return t.replace(/^["']|['"]$/g, "")
  }
  return null
}

/** Directory a list segment targets — the FIRST positional argument
 *  (`find <dir> -name x`, `ls -la <dir>`, `tree <dir>`). */
function listDirPath(cmd: string): string | null {
  const tokens = cmd.trim().split(/\s+/)
  for (let i = 1; i < tokens.length; i++) {
    const t = tokens[i]
    if (t.startsWith("-")) continue
    if (t === "2>/dev/null") continue
    return t.replace(/^["']|['"]$/g, "")
  }
  return null
}

/**
 * Synthesize the model-facing input JSON a read/grep/list segment needs for
 * the "Read <path>" / "Grep <query>" / "List <path>" titles (mirrors the
 * backend-action synthesis in the adapter).
 */
export function synthesizeSegmentInput(
  segment: SplitCommandSegment
): string | null {
  switch (segment.kind) {
    case "read": {
      const path = readFilePath(segment.command)
      if (!path) return null
      return JSON.stringify({ file_path: path })
    }
    case "search": {
      const pattern = searchQuery(segment.command)
      if (!pattern) return null
      return JSON.stringify({ pattern })
    }
    case "list": {
      const path = listDirPath(segment.command)
      if (!path) return null
      return JSON.stringify({ pattern: path })
    }
    default:
      return null
  }
}

/** Canonical tool name for a segment, understood by the renderer's lanes. */
export function segmentToolName(kind: SplitCommandSegmentKind): string {
  switch (kind) {
    case "read":
      return "read"
    case "search":
      return "grep"
    case "list":
      return "list_files"
    case "command":
      return "bash"
  }
}

/** Split `output` on the found echo labels, returning labelCount+1 parts.
 *  The label text itself is excluded from every part. */
function segmentByLabels(output: string, labels: string[]): string[] {
  const cuts: Array<{ start: number; end: number }> = []
  let cursor = 0
  for (const label of labels) {
    const idx = output.indexOf(label, cursor)
    if (idx === -1) continue
    cuts.push({ start: idx, end: idx + label.length })
    cursor = idx + label.length
  }
  const parts: string[] = []
  let prev = 0
  for (const cut of cuts) {
    parts.push(output.slice(prev, cut.start))
    prev = cut.end
  }
  parts.push(output.slice(prev))
  return parts
}

/**
 * Split a shell command into individually classifiable segments with
 * per-segment output.
 *
 * Returns `null` when the command should keep its single-card rendering:
 * - a single GENERIC command (`python3 x.py`, `wc -l f`, `cd && mkdir`) —
 *   the backend may have already classified clean reads/searches, and
 *   anything else has no context-lane verb to show
 * - every segment is a generic command (`mkdir && cd && touch` stays one card)
 * - the command contains a heredoc (`<<`), which splitting would mangle
 *
 * A single READ/SEARCH/LIST command that the engine left unclassified
 * (e.g. `find <dir> -name x`) DOES split into one segment so it renders as a
 * clean "List <dir>" card instead of a raw `/bin/zsh -lc '...'` bash card.
 */
export function splitChainedCommandWithOutputs(
  command: string,
  output: string | null
): SplitCommandSegment[] | null {
  const unwrapped = unwrapShellCommand(command)
  if (unwrapped.includes("<<")) return null

  const tokens = tokenize(unwrapped)
  if (tokens.length === 0) return null

  const segments: SplitCommandSegment[] = []
  const labels: string[] = []
  for (const token of tokens) {
    if (isEchoToken(token)) {
      const label = echoLabel(token)
      if (label) labels.push(label)
      continue
    }
    segments.push({
      command: token,
      kind: classifyToken(token),
      output: null,
    })
  }
  if (segments.length === 0) return null

  // A single generic command stays a bash card; a single read/search/list
  // command the engine left unclassified becomes a clean lane card. A lone
  // token that still contains a pipe (`head f | grep x`) is a pipeline doing
  // multiple operations — it stays a bash card, matching Codex.
  if (segments.length === 1) {
    if (segments[0].kind === "command") return null
    if (segments[0].command.includes("|")) return null
    if (output) segments[0].output = output
    return segments
  }

  // A chain of only generic commands (setup chains) keeps its single card.
  if (!segments.some((s) => s.kind !== "command")) return null

  if (output) {
    const parts = segmentByLabels(output, labels)
    if (parts.length >= segments.length) {
      for (let i = 0; i < segments.length - 1; i++) {
        segments[i].output = parts[i] ?? null
      }
      segments[segments.length - 1].output = parts
        .slice(segments.length - 1)
        .join("")
    } else {
      // Labels couldn't be matched — keep the full output on the last card.
      for (let i = 0; i < segments.length - 1; i++) {
        segments[i].output = null
      }
      segments[segments.length - 1].output = output
    }
  }

  return segments
}
