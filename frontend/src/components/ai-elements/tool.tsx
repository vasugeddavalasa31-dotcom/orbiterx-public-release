"use client"

import type { DynamicToolUIPart, ToolUIPart } from "ai"
import type { ComponentProps, ReactNode } from "react"

import { Badge } from "@/components/ui/badge"
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/instant-collapsible"
import { cn } from "@/lib/utils"
import {
  CheckCircleIcon,
  ChevronRightIcon,
  CircleIcon,
  ClockIcon,
  WrenchIcon,
  XCircleIcon,
} from "lucide-react"
import { useTranslations } from "next-intl"
import { isValidElement } from "react"

import { CodeBlock } from "./code-block"
import { UnifiedDiffPreview } from "@/components/diff/unified-diff-preview"
import { MessageResponse } from "./message"

export type ToolProps = ComponentProps<typeof Collapsible>

export const Tool = ({ className, ...props }: ToolProps) => (
  <Collapsible
    className={cn(
      "group w-full min-w-0 overflow-hidden rounded-lg border border-border/80 bg-muted/30",
      className
    )}
    {...props}
  />
)

export type ToolPart = ToolUIPart | DynamicToolUIPart

export type ToolHeaderProps = {
  title?: ReactNode
  titleSuffix?: ReactNode
  icon?: ReactNode
  className?: string
  /** Suppress the trailing status chip (icon + label) entirely. Edit cards
   *  use this so the header reads "Edit calculator.py +2 −2" with no
   *  "· Ran"/"· Edited" suffix. */
  hideStatus?: boolean
} & (
  | { type: ToolUIPart["type"]; state: ToolUIPart["state"]; toolName?: never }
  | {
      type: DynamicToolUIPart["type"]
      state: DynamicToolUIPart["state"]
      toolName: string
    }
)

const statusIcons: Record<ToolPart["state"], ReactNode> = {
  "approval-requested": <ClockIcon className="size-3.5 text-yellow-600" />,
  "approval-responded": <CheckCircleIcon className="size-3.5 text-blue-600" />,
  "input-available": <ClockIcon className="size-3.5 animate-pulse" />,
  "input-streaming": <CircleIcon className="size-3.5 animate-pulse" />,
  "output-available": <CheckCircleIcon className="size-3.5 text-green-600" />,
  "output-denied": <XCircleIcon className="size-3.5 text-orange-600" />,
  "output-error": <XCircleIcon className="size-3.5 text-red-600" />,
}

export const getStatusBadge = (status: ToolPart["state"], label: string) => (
  <Badge className="gap-1.5 rounded-full text-xs" variant="secondary">
    {statusIcons[status]}
    {label}
  </Badge>
)

export const ToolHeader = ({
  className,
  title,
  titleSuffix,
  icon,
  type,
  state,
  toolName,
  hideStatus = false,
  ...props
}: ToolHeaderProps) => {
  const t = useTranslations("Folder.chat.tool")
  const derivedName =
    type === "dynamic-tool" ? toolName : type.split("-").slice(1).join("-")
  const isError = state === "output-error" || state === "output-denied"
  const statusLabel =
    state === "approval-requested"
      ? t("status.approvalRequested")
      : state === "approval-responded"
        ? t("status.approvalResponded")
        : state === "input-available"
          ? t("status.inputAvailable")
          : state === "input-streaming"
            ? t("status.inputStreaming")
            : state === "output-available"
              ? t("status.outputAvailable")
              : state === "output-denied"
                ? t("status.outputDenied")
                : t("status.outputError")

  return (
    <CollapsibleTrigger
      className={cn(
        "flex w-full min-w-0 items-center gap-2 rounded-t-md border-b border-border bg-muted/30 px-3 py-1.5 text-left transition-colors",
        "hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1",
        isError && "text-destructive hover:bg-destructive/5",
        className
      )}
      {...props}
    >
      <div className="flex min-w-0 flex-1 items-baseline gap-1.5">
        <span className="flex size-4 shrink-0 items-center justify-center">
          {icon ?? <WrenchIcon className="size-4 text-muted-foreground" />}
        </span>
        <span className="shrink-0 truncate whitespace-nowrap text-[13px] font-semibold leading-5 text-foreground">
          {title ?? derivedName}
        </span>
        {titleSuffix ? (
          <>
            <span
              aria-hidden="true"
              className="shrink-0 text-xs text-muted-foreground/60"
            >
              ·
            </span>
            <span className="min-w-0 truncate text-xs text-muted-foreground">
              {titleSuffix}
            </span>
          </>
        ) : null}
        {/* Always show the lifecycle status on dynamic tool cards: "Running"
            while the tool is in flight, "Ran" once it completes (plus the
            error/approval states). The user asked for this explicit feedback —
            a finished command card reads "Bash · Ran" instead of the status
            being hidden. Legacy (non-dynamic) ToolUIPart types keep the old
            sr-only behavior. */}
        {hideStatus ? null : type === "dynamic-tool" ? (
          <>
            <span
              aria-hidden="true"
              className="shrink-0 text-xs text-muted-foreground/60"
            >
              ·
            </span>
            <span className="flex size-3.5 shrink-0 items-center justify-center">
              {statusIcons[state]}
            </span>
            <span
              className={cn(
                "shrink-0 text-xs",
                isError ? "text-destructive" : "text-muted-foreground"
              )}
            >
              {statusLabel}
            </span>
          </>
        ) : (
          <span className="sr-only">{statusLabel}</span>
        )}
      </div>
      <ChevronRightIcon className="size-4 shrink-0 text-muted-foreground/70 transition-transform group-data-[state=open]:rotate-90" />
    </CollapsibleTrigger>
  )
}

export type ToolContentProps = ComponentProps<typeof CollapsibleContent> & {
  /** Extra classes for the inner body wrapper (the default carries
   *  `bg-background`; pass `bg-transparent` to remove it). */
  contentClassName?: string
}

export const ToolContent = ({
  className,
  contentClassName,
  children,
  ...props
}: ToolContentProps) => (
  <CollapsibleContent
    className={cn(
      "tool-collapsible-content overflow-hidden text-popover-foreground outline-none",
      className
    )}
    {...props}
  >
    <div
      className={cn(
        "space-y-2.5 bg-background px-3 pb-2 pt-1.5",
        contentClassName
      )}
    >
      {children}
    </div>
  </CollapsibleContent>
)

export type ToolInputProps = ComponentProps<"div"> & {
  input: ToolPart["input"]
}

export const ToolInput = ({ className, input, ...props }: ToolInputProps) => {
  const t = useTranslations("Folder.chat.tool")
  const formattedCode = (() => {
    if (typeof input === "string") {
      try {
        const parsed = JSON.parse(input)
        return JSON.stringify(parsed, null, 2)
      } catch {
        return input
      }
    }
    return JSON.stringify(input, null, 2)
  })()

  return (
    <div className={cn("space-y-2 overflow-hidden", className)} {...props}>
      <h4 className="font-medium text-muted-foreground text-xs uppercase tracking-wide">
        {t("parameters")}
      </h4>
      <div className="rounded-md bg-muted/50">
        <CodeBlock code={formattedCode} language="json" />
      </div>
    </div>
  )
}

function detectOutputLanguage(text: string) {
  const trimmed = text.trimStart()
  if (
    (trimmed.startsWith("{") || trimmed.startsWith("[")) &&
    (() => {
      try {
        JSON.parse(trimmed)
        return true
      } catch {
        return false
      }
    })()
  ) {
    return "json" as const
  }
  if (trimmed.includes("diff --git") || trimmed.includes("@@")) {
    return "diff" as const
  }
  if (trimmed.startsWith("<")) {
    return "xml" as const
  }
  return "log" as const
}

const ERROR_LIKE_KEYS = [
  "error",
  "message",
  "stderr",
  "detail",
  "details",
  "reason",
  "text",
  "output",
  "formatted_output",
  "aggregated_output",
  "result",
]

function stripErrorPrefix(text: string): string {
  return text
    .trim()
    .replace(/^error:\s*/i, "")
    .trim()
}

function normalizeErrorForCompare(text: string): string {
  return stripErrorPrefix(text).replace(/\s+/g, " ")
}

function collectErrorCandidates(value: unknown): string[] {
  if (!value) {
    return []
  }

  if (typeof value === "string") {
    return [value]
  }

  if (Array.isArray(value)) {
    return value.flatMap((item) => collectErrorCandidates(item))
  }

  if (typeof value !== "object") {
    return []
  }

  const obj = value as Record<string, unknown>
  const candidates: string[] = []

  for (const key of ERROR_LIKE_KEYS) {
    if (!(key in obj)) continue
    candidates.push(...collectErrorCandidates(obj[key]))
  }

  return candidates
}

function parseJson(value: string): unknown | null {
  try {
    return JSON.parse(value)
  } catch {
    return null
  }
}

function formatErrorFieldValue(value: unknown): string {
  if (typeof value === "string") {
    return value
  }
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

function renderErrorText(errorText: string): ReactNode {
  const parsed = parseJson(errorText.trim())

  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    const entries = Object.entries(parsed as Record<string, unknown>)
    if (entries.length > 0) {
      return (
        <div className="space-y-2 p-3">
          {entries.map(([key, value]) => (
            <div key={key} className="space-y-1">
              <div className="text-[11px] font-medium uppercase tracking-wide text-destructive/80">
                {key}
              </div>
              <pre className="whitespace-pre-wrap break-words font-mono text-xs text-destructive">
                {formatErrorFieldValue(value)}
              </pre>
            </div>
          ))}
        </div>
      )
    }
  }

  return (
    <pre className="whitespace-pre-wrap break-words p-3 font-mono text-xs text-destructive">
      {errorText}
    </pre>
  )
}

function isDuplicateErrorOutput(
  output: ToolPart["output"],
  normalizedErrorText: string | null
): boolean {
  if (!normalizedErrorText || !output) {
    return false
  }

  const rawCandidates: string[] = []
  if (typeof output === "string") {
    rawCandidates.push(output)
    const parsed = parseJson(output)
    if (parsed) {
      rawCandidates.push(...collectErrorCandidates(parsed))
    }
  } else if (typeof output === "object" && !isValidElement(output)) {
    rawCandidates.push(...collectErrorCandidates(output))
  }

  return rawCandidates.some((candidate) => {
    const normalizedCandidate = normalizeErrorForCompare(candidate)
    return (
      normalizedCandidate.length > 0 &&
      normalizedCandidate === normalizedErrorText
    )
  })
}

export type ToolOutputProps = ComponentProps<"div"> & {
  output: ToolPart["output"]
  errorText: ToolPart["errorText"]
  renderAsMarkdown?: boolean
}

const MD_INDICATORS = [
  /^#{1,6}\s/m,
  /^\s*[-*+]\s/m,
  /^\s*\d+\.\s/m,
  /\*\*[^*]+\*\*/,
  /\[.+\]\(.+\)/,
  /```[\s\S]*?```/,
  /^\s*>/m,
  /^\|.+\|$/m,
]

function looksLikeMarkdown(text: string): boolean {
  let count = 0
  for (const re of MD_INDICATORS) {
    if (re.test(text)) count++
    if (count >= 2) return true
  }
  return false
}

export const ToolOutput = ({
  className,
  output,
  errorText,
  renderAsMarkdown,
  ...props
}: ToolOutputProps) => {
  const t = useTranslations("Folder.chat.tool")
  if (!(output || errorText)) {
    return null
  }

  const normalizedErrorText =
    typeof errorText === "string" ? normalizeErrorForCompare(errorText) : null
  const hasDuplicateErrorOutput = isDuplicateErrorOutput(
    output,
    normalizedErrorText
  )

  let Output = <div>{output as ReactNode}</div>

  if (typeof output === "object" && !isValidElement(output)) {
    Output = (
      <CodeBlock code={JSON.stringify(output, null, 2)} language="json" />
    )
  } else if (typeof output === "string") {
    const lang = detectOutputLanguage(output)
    const shouldRenderMd =
      renderAsMarkdown ?? (lang === "log" && looksLikeMarkdown(output))
    if (shouldRenderMd) {
      Output = (
        <div className="prose prose-sm dark:prose-invert max-w-none p-3 text-sm [&_ul]:list-inside [&_ol]:list-inside">
          <MessageResponse>{output}</MessageResponse>
        </div>
      )
    } else if (lang === "diff") {
      Output = <UnifiedDiffPreview diffText={output} clickableFilePath />
    } else {
      Output = <CodeBlock code={output} language={lang} />
    }
  }

  return (
    <div className={cn("space-y-2", className)} {...props}>
      <h4 className="font-medium text-muted-foreground text-xs uppercase tracking-wide">
        {errorText ? t("error") : t("result")}
      </h4>
      <div
        className={cn(
          "max-h-56 overflow-y-auto overflow-x-auto rounded-lg text-xs ring-1 ring-inset ring-border/40 [&_table]:w-full",
          errorText
            ? "bg-destructive/10 text-destructive"
            : "bg-muted/50 text-foreground"
        )}
      >
        {typeof errorText === "string" && renderErrorText(errorText)}
        {!hasDuplicateErrorOutput && Output}
      </div>
    </div>
  )
}
