"use client"

import { getShellTransport } from "@/lib/transport"
import { convIdFromThreadId } from "@/lib/app-server-ids"

/**
 * Resolve the MAIN session for a sub-agent conversation tab.
 *
 * When a sub-agent session opens as a tab, this tells the UI which parent
 * (main) session it belongs to, so a "Back to main session" affordance can
 * jump back to the parent tab. The transport records the child→parent link
 * from the live/history `collabAgentToolCall` items (`senderThreadId`).
 */
interface ChildParentTransport {
  parentThreadIdOfChild(threadId: string): string | null
  isChildThreadConvId(convId: number): boolean
}

function childParentTransport(): ChildParentTransport | null {
  if (typeof window === "undefined") return null
  const t = getShellTransport() as Partial<ChildParentTransport>
  if (typeof t.parentThreadIdOfChild !== "function") return null
  return t as unknown as ChildParentTransport
}

/**
 * Whether a numeric conversation id is a sub-agent session, and if so the
 * parent (main) conversation id to jump back to — or null when not a child.
 */
export function resolveMainSessionForChild(
  conversationId: number
): { parentConversationId: number | null } | null {
  const transport = childParentTransport()
  if (!transport) return null
  if (!transport.isChildThreadConvId(conversationId)) return null
  // Resolve the child thread uuid, then its parent thread uuid → parent conv id.
  const t = transport as unknown as {
    getThreadIdByConvId?(convId: number): string | null
  }
  const childThreadId = t.getThreadIdByConvId?.(conversationId) ?? null
  if (!childThreadId) return null
  const parentThreadId = transport.parentThreadIdOfChild(childThreadId)
  if (!parentThreadId) return null
  return { parentConversationId: convIdFromThreadId(parentThreadId) }
}
