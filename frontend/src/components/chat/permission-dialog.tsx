"use client"

import { useMemo, useState } from "react"
import { useTranslations } from "next-intl"
import {
  ShieldAlert,
  Terminal,
  ListTodo,
  Compass,
  FileText,
  Globe,
  Search,
  ChevronDown,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { CodeBlock } from "@/components/ai-elements/code-block"
import { UnifiedDiffPreview } from "@/components/diff/unified-diff-preview"
import { MessageResponse } from "@/components/ai-elements/message"
import { cn } from "@/lib/utils"
import type { PendingPermission } from "@/contexts/acp-connections-context"
import { parsePermissionToolCall } from "@/lib/permission-request"

interface PermissionDialogProps {
  permission: PendingPermission | null
  onRespond: (requestId: string, optionId: string) => void
}

export function PermissionDialog({
  permission,
  onRespond,
}: PermissionDialogProps) {
  const t = useTranslations("Folder.chat.permissionDialog")
  const parsed = useMemo(
    () => parsePermissionToolCall(permission?.tool_call),
    [permission?.tool_call]
  )
  const [showDetails, setShowDetails] = useState(false)
  if (!permission) return null

  const hasFileChanges = parsed.fileChanges.length > 0
  const hasPlan =
    parsed.planEntries.length > 0 || Boolean(parsed.planExplanation)
  const hasPlanMarkdown = Boolean(parsed.planMarkdown)
  const hasAllowedPrompts = parsed.allowedPrompts.length > 0
  const hasWeb = Boolean(parsed.url) || Boolean(parsed.query)
  const hasOtherStructured =
    Boolean(parsed.command) ||
    hasFileChanges ||
    hasPlan ||
    hasPlanMarkdown ||
    hasAllowedPrompts ||
    Boolean(parsed.modeTarget) ||
    hasWeb
  // Agent-provided description (ACP `content` text). Shown only when no richer
  // structured view exists, so it replaces the raw-JSON fallback for agents
  // like Kimi Code that carry the request text in `content` rather than
  // `rawInput`, while leaving command/diff/plan dialogs untouched.
  const hasContentText = Boolean(parsed.contentText)
  const hasStructured = hasOtherStructured || hasContentText
  // The details body renders structured content when present, else the raw
  // JSON fallback — keep the toggle whenever either has something to show.
  const hasDetails =
    hasStructured || hasFileChanges || parsed.jsonPreview.trim().length > 0

  // Compact one-line summary of what the agent wants to do, shown on the card
  // itself. The full command / diff / plan lives behind the Details toggle.
  const summary = (() => {
    if (parsed.command) return parsed.command.split("\n")[0].trim()
    if (parsed.fileChanges.length === 1) {
      const change = parsed.fileChanges[0]
      return change.path || t("filesSummary", { count: 1 })
    }
    if (parsed.fileChanges.length > 1) {
      return t("filesSummary", { count: parsed.fileChanges.length })
    }
    if (parsed.modeTarget) return t("targetMode", { mode: parsed.modeTarget })
    if (parsed.planExplanation)
      return parsed.planExplanation.split("\n")[0].trim()
    if (parsed.url) return parsed.url
    if (parsed.query) return parsed.query
    if (parsed.prompt) return parsed.prompt.split("\n")[0].trim()
    if (parsed.contentText) return parsed.contentText.split("\n")[0].trim()
    return ""
  })()

  return (
    <div className="mb-2 rounded-lg border border-border/70 bg-card/95 px-3 py-2 shadow-sm">
      {/* Compact header row: summary + inline actions. */}
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5">
        <ShieldAlert className="size-4 shrink-0 text-amber-500" />
        <span className="truncate text-xs font-medium text-foreground">
          {parsed.title}
        </span>
        {summary && (
          <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-muted-foreground">
            {summary}
          </span>
        )}
        {hasDetails && (
          <Button
            variant="ghost"
            size="xs"
            className="gap-0.5 px-1 text-[11px] text-muted-foreground"
            onClick={() => setShowDetails((v) => !v)}
            aria-expanded={showDetails}
          >
            {showDetails ? t("hideDetails") : t("details")}
            <ChevronDown
              className={cn(
                "size-3 transition-transform",
                showDetails && "rotate-180"
              )}
            />
          </Button>
        )}
        <div className="ml-auto flex shrink-0 flex-wrap items-center gap-1.5">
          {permission.options.map((opt) => {
            const isReject = opt.kind.startsWith("reject")
            return (
              <Button
                key={opt.option_id}
                size="xs"
                variant={isReject ? "outline" : "default"}
                onClick={() => onRespond(permission.request_id, opt.option_id)}
              >
                {opt.name}
              </Button>
            )
          })}
        </div>
      </div>

      {/* Expandable details: command / diff / plan / web — collapsed by default
          so the card stays a slim bar above the composer. */}
      {showDetails && (
        <div className="mt-2 max-h-[min(36vh,18rem)] space-y-2 overflow-y-auto border-t border-border/60 pt-2 pr-1">
          {parsed.command && (
            <div className="space-y-1.5 rounded-md border border-border/60 bg-muted/20 p-2">
              <div className="flex items-center gap-1 text-xs text-muted-foreground">
                <Terminal className="h-3.5 w-3.5" />
                <span>{t("command")}</span>
              </div>
              <CodeBlock code={parsed.command} language="bash" />
              {parsed.cwd && (
                <div className="break-all text-xs text-muted-foreground">
                  {t("cwd", { cwd: parsed.cwd })}
                </div>
              )}
            </div>
          )}

          {hasFileChanges && parsed.diffPreview && (
            <UnifiedDiffPreview diffText={parsed.diffPreview} />
          )}

          {hasPlan && (
            <div className="space-y-1.5 rounded-md border border-border/60 bg-muted/20 p-2">
              <div className="flex items-center gap-1 text-xs text-muted-foreground">
                <ListTodo className="h-3.5 w-3.5" />
                <span>{t("plan")}</span>
              </div>
              {parsed.planExplanation && (
                <p className="text-xs text-foreground/90">
                  {parsed.planExplanation}
                </p>
              )}
              {parsed.planEntries.length > 0 && (
                <div className="space-y-1 rounded-md bg-muted/40 p-2">
                  {parsed.planEntries.map((entry, index) => (
                    <div key={`${entry.text}-${index}`} className="text-xs">
                      <span className="text-foreground/90">{entry.text}</span>
                      {entry.status && (
                        <span className="ml-2 text-muted-foreground">
                          ({entry.status})
                        </span>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {hasPlanMarkdown && (
            <div className="space-y-1.5 rounded-md border border-border/60 bg-muted/20 p-2">
              <div className="flex items-center gap-1 text-xs text-muted-foreground">
                <FileText className="h-3.5 w-3.5" />
                <span>{t("plan")}</span>
              </div>
              <div className="prose prose-sm dark:prose-invert max-w-none text-sm [&_ul]:list-inside [&_ol]:list-inside">
                <MessageResponse>{parsed.planMarkdown!}</MessageResponse>
              </div>
            </div>
          )}

          {hasAllowedPrompts && (
            <div className="space-y-1.5 rounded-md border border-border/60 bg-muted/20 p-2">
              <div className="flex items-center gap-1 text-xs text-muted-foreground">
                <Terminal className="h-3.5 w-3.5" />
                <span>{t("allowedActions")}</span>
              </div>
              <div className="space-y-1 rounded-md bg-muted/40 p-2">
                {parsed.allowedPrompts.map((item, index) => (
                  <div
                    key={`${item.prompt}-${index}`}
                    className="flex items-center gap-2 text-xs"
                  >
                    {item.tool && (
                      <Badge variant="outline" className="shrink-0 text-[10px]">
                        {item.tool}
                      </Badge>
                    )}
                    <span className="text-foreground/90">{item.prompt}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {parsed.modeTarget && (
            <div className="rounded-md border border-border/60 bg-muted/20 p-2 text-xs">
              <div className="flex items-center gap-1 text-muted-foreground">
                <Compass className="h-3.5 w-3.5" />
                <span>{t("targetMode", { mode: parsed.modeTarget })}</span>
              </div>
            </div>
          )}

          {hasWeb && (
            <div className="space-y-1.5 rounded-md border border-border/60 bg-muted/20 p-2">
              {parsed.url && (
                <div className="flex items-center gap-2 text-xs">
                  <Globe className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                  <span className="break-all font-mono text-foreground/90">
                    {parsed.url}
                  </span>
                </div>
              )}
              {parsed.query && (
                <div className="flex items-center gap-2 text-xs">
                  <Search className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                  <span className="break-all text-foreground/90">
                    {parsed.query}
                  </span>
                </div>
              )}
              {parsed.prompt && (
                <div className="mt-1 text-xs text-muted-foreground">
                  <MessageResponse>{parsed.prompt}</MessageResponse>
                </div>
              )}
            </div>
          )}

          {!hasOtherStructured && parsed.contentText && (
            <div className="rounded-md border border-border/60 bg-muted/20 p-2 text-xs text-foreground/90">
              <MessageResponse>{parsed.contentText}</MessageResponse>
            </div>
          )}

          {!hasStructured && (
            <pre className="rounded-md border border-border/60 bg-muted/20 p-2 text-xs whitespace-pre-wrap break-all text-foreground/90">
              {parsed.jsonPreview}
            </pre>
          )}
        </div>
      )}
    </div>
  )
}
