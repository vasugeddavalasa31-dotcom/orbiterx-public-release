"use client"

import { useEffect, useMemo, useRef, useState } from "react"
import { GitBranch, X } from "lucide-react"
import { useTranslations } from "next-intl"
import { useActiveFolder } from "@/contexts/active-folder-context"
import { useIsActiveChatMode } from "@/hooks/use-is-active-chat-mode"
import { useWorkspaceStateStore } from "@/hooks/use-workspace-state-store"
import { useTabStore } from "@/contexts/tab-context"
import { useAppWorkspaceStore } from "@/stores/app-workspace-store"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import { Button } from "@/components/ui/button"
import {
  CommitFileAdditions,
  CommitFileDeletions,
} from "@/components/ai-elements/commit"
import { cn } from "@/lib/utils"

const UNTRACKED_STATUS = "??"

function isUntrackedStatus(status: string): boolean {
  return status.trim().toUpperCase() === UNTRACKED_STATUS
}

/**
 * Compact branch + working-tree-changes summary anchored below the top-right
 * window-chrome cluster (terminal / aux / settings). Auto-pops when a session
 * is opened (new or existing conversation tab becomes active) so the user
 * immediately sees the branch and change counts; closing it (× / outside
 * click) hides it and it stays hidden until a DIFFERENT session is opened.
 *
 * The popover is KEYED by the active session (`conv:<id>` / `tab:<id>`), so
 * opening a different session remounts it and re-arms the auto-pop. The
 * auto-pop itself runs as an effect that fires the moment `canShow` is true
 * for the freshly-mounted session — the tab can activate a tick before the
 * folder resolves, and seeding `open` from `canShow` at mount would miss that
 * window and leave the popup closed. A per-mount ref makes it pop exactly
 * once; closing it is a user action that persists until the key remounts us.
 * The trigger is disabled only when CLOSED and there is nothing to show, so a
 * transient `activeFolder` flip can never disable it mid-open (which is what
 * made the earlier version flash open-then-closed: Radix dismisses a popover
 * whose trigger turns disabled).
 */
export function GitStatusPopover() {
  const { activeFolder } = useActiveFolder()
  const isChatMode = useIsActiveChatMode()
  const activeTabId = useTabStore((s) => s.activeTabId)
  const tabs = useTabStore((s) => s.tabs)
  const activeTab = useMemo(
    () => tabs.find((tab) => tab.id === activeTabId) ?? null,
    [tabs, activeTabId]
  )

  // Stable per-session key: real conversation id once bound, tab id for an
  // unbound draft, "none" when no conversation tab is active.
  const sessionKey = activeTab
    ? activeTab.conversationId != null
      ? `conv:${activeTab.conversationId}`
      : `tab:${activeTab.id}`
    : "none"

  // Chat mode / no folder: nothing to show, so the popover never auto-opens.
  const canShow = activeFolder != null && !isChatMode

  return (
    <SessionGitStatusPopover
      key={sessionKey}
      sessionKey={sessionKey}
      canShow={canShow}
    />
  )
}

interface SessionGitStatusPopoverProps {
  sessionKey: string
  canShow: boolean
}

/**
 * The actual popover. Remounts (via `key`) whenever the active session
 * changes, re-arming the one-shot auto-pop for the new session.
 */
function SessionGitStatusPopover({
  sessionKey,
  canShow,
}: SessionGitStatusPopoverProps) {
  const t = useTranslations("Folder.gitStatusPopover")
  const { activeFolder } = useActiveFolder()
  const [open, setOpen] = useState(false)
  const autoOpenedRef = useRef(false)

  // Auto-pop once per mounted session: fire the moment the folder has
  // resolved (the tab can activate before the folder store catches up), then
  // never re-open for this session — the user's close is honored until a new
  // session key remounts us.
  useEffect(() => {
    if (sessionKey === "none" || !canShow || autoOpenedRef.current) return
    autoOpenedRef.current = true
    setOpen(true)
  }, [canShow, sessionKey])

  // Branch name: same source the below-composer branch chip reads (polled
  // git-head, falling back to the folder's stored branch).
  const branch = useAppWorkspaceStore((s) =>
    activeFolder
      ? (s.branches.get(activeFolder.id) ?? activeFolder.git_branch ?? null)
      : null
  )

  // Changes: the same workspace-state snapshot the aux-panel Changes tab
  // consumes. `useWorkspaceStateStore` acquires a full watch token while the
  // popover is mounted; that's the same cost the aux panel already pays.
  const workspaceState = useWorkspaceStateStore(activeFolder?.path ?? null)

  const { trackedCount, untrackedCount, additions, deletions } = useMemo(() => {
    let trackedCount = 0
    let untrackedCount = 0
    let additions = 0
    let deletions = 0
    for (const entry of workspaceState.git) {
      if (isUntrackedStatus(entry.status)) {
        untrackedCount += 1
      } else {
        trackedCount += 1
        additions += entry.additions
        deletions += entry.deletions
      }
    }
    return { trackedCount, untrackedCount, additions, deletions }
  }, [workspaceState.git])

  const isRepo = workspaceState.isGitRepo
  // Only disable when CLOSED and there's nothing to show — never while open,
  // or a transient folder resolution would flip it mid-open and Radix would
  // dismiss the popover (the open-then-closed bug).
  const triggerDisabled = !canShow && !open

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className={cn(
            "h-6 w-6 hover:bg-foreground/10 hover:text-foreground/80 dark:hover:bg-foreground/10",
            open && "bg-accent"
          )}
          disabled={triggerDisabled}
          title={t("toggle")}
        >
          <GitBranch className="h-3.5 w-3.5" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        side="bottom"
        align="end"
        sideOffset={6}
        className="w-72 gap-0 p-0"
      >
        <div className="flex items-center justify-between border-b px-3 py-2">
          <span className="text-xs font-medium">{t("title")}</span>
          <Button
            variant="ghost"
            size="icon"
            className="h-5 w-5 hover:bg-foreground/10"
            onClick={() => setOpen(false)}
            title={t("close")}
            aria-label={t("close")}
          >
            <X className="size-3.5" />
          </Button>
        </div>

        {!isRepo ? (
          <div className="px-3 py-3 text-xs text-muted-foreground">
            {t("notAGitRepo")}
          </div>
        ) : (
          <div className="flex flex-col gap-2 px-3 py-3 text-sm">
            <div className="flex items-center gap-2">
              <GitBranch className="size-3.5 shrink-0 text-muted-foreground" />
              <span className="truncate font-medium">
                {branch ?? t("detachedHead")}
              </span>
            </div>
            <div className="flex items-center gap-2">
              <span className="shrink-0 text-xs text-muted-foreground">
                {t("changes")}
              </span>
              <span className="flex min-w-0 flex-1 flex-wrap items-center gap-x-1 gap-y-0.5 text-xs">
                {trackedCount > 0 && (
                  <>
                    <span className="text-muted-foreground">
                      {t("tracked", { count: trackedCount })}
                    </span>
                    <CommitFileAdditions count={additions} />
                    <CommitFileDeletions count={deletions} />
                  </>
                )}
                {untrackedCount > 0 && (
                  <span className="text-muted-foreground">
                    {t("untracked", { count: untrackedCount })}
                  </span>
                )}
                {trackedCount === 0 && untrackedCount === 0 && (
                  <span className="text-muted-foreground">{t("clean")}</span>
                )}
              </span>
            </div>
          </div>
        )}
      </PopoverContent>
    </Popover>
  )
}
