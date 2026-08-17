"use client"

import { useSyncExternalStore } from "react"
import { WifiOff } from "lucide-react"
import { useTranslations } from "next-intl"
import {
  getShellConnectionServerSnapshot,
  getShellConnectionSnapshot,
  subscribeShellConnection,
} from "@/lib/transport/shell-connection-store"

/**
 * "Reconnecting…" banner shown when the app-server persistent WebSocket drops
 * (network loss / server restart). The transport reconnects automatically every
 * 2s and flips the health flag back once `initialize` succeeds, so this banner
 * appears while the link is down and disappears on recovery. Drives off the
 * app-server shell transport — the web transport's full-screen guard handles
 * web mode separately.
 */
export function ShellReconnectBanner() {
  const t = useTranslations("Folder.statusBar.connection")
  const state = useSyncExternalStore(
    subscribeShellConnection,
    getShellConnectionSnapshot,
    getShellConnectionServerSnapshot
  )

  if (state === "connected") return null

  return (
    <div className="flex items-center justify-center gap-2 border-b border-amber-500/20 bg-amber-500/10 px-3 py-1.5 text-xs text-amber-700 dark:text-amber-300">
      <WifiOff className="size-3.5 shrink-0" />
      <span className="truncate">{t("reconnecting")}</span>
    </div>
  )
}
