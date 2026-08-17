"use client"

import { useMemo } from "react"
import { getShellTransport } from "@/lib/transport"
import { convIdFromThreadId } from "@/lib/app-server-ids"

/**
 * Resolve the MAIN (parent) session for a sub-agent conversation tab.
 *
 * The transport records child→parent links from live/history
 * `collabAgentToolCall` items (`senderThreadId` = parent thread, child =
 * `receiverThreadIds` / `agentsStates` keys). Given a conversation id, resolve
 * its thread UUID, then the parent thread UUID → parent conversation id (for
 * "Back to main session"). Returns null when the tab isn't a known sub-agent.
 */
export function resolveParentConversationId(
  conversationId: number | null
): number | null {
  if (!conversationId || typeof window === "undefined") return null
  const transport = getShellTransport() as unknown as {
    getThreadIdByConvId?(convId: number): string | null
    parentThreadIdOfChild?(childThreadId: string): string | null
  }
  if (typeof transport.getThreadIdByConvId !== "function") return null
  const threadId = transport.getThreadIdByConvId(conversationId)
  if (!threadId) return null
  const parentThreadId =
    typeof transport.parentThreadIdOfChild === "function"
      ? transport.parentThreadIdOfChild(threadId)
      : null
  if (!parentThreadId) return null
  return convIdFromThreadId(parentThreadId)
}

/** Hook wrapper for the active conversation id. */
export function useParentConversationId(
  conversationId: number | null
): number | null {
  return useMemo(
    () => resolveParentConversationId(conversationId),
    [conversationId]
  )
}
