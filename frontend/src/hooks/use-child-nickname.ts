"use client"

import { useSyncExternalStore } from "react"
import { getShellTransport } from "@/lib/transport"
import type { UnsubscribeFn } from "@/lib/transport/types"

/**
 * Reactive sub-agent nickname (e.g. "Galileo", "Dewey") for a child thread.
 *
 * The transport resolves nicknames lazily via `thread/read` (`agentNickname`)
 * and caches them, notifying subscribers on arrival. This hook bridges that
 * cache to React via `useSyncExternalStore`, so a collab capsule shows the
 * friendly name the moment it resolves (falling back to the short thread id).
 */
interface NicknameTransport {
  subscribeChildNicknames(callback: () => void): UnsubscribeFn
  getChildNickname(threadId: string): string | null
  resolveChildNickname(threadId: string): string | null
}

function nicknameTransport(): NicknameTransport | null {
  if (typeof window === "undefined") return null
  const t = getShellTransport() as Partial<NicknameTransport>
  if (
    typeof t.subscribeChildNicknames !== "function" ||
    typeof t.getChildNickname !== "function" ||
    typeof t.resolveChildNickname !== "function"
  ) {
    return null
  }
  return t as unknown as NicknameTransport
}

/** Current cached nickname, or `null` when not yet resolved. */
export function getChildNickname(threadId: string): string | null {
  return nicknameTransport()?.getChildNickname(threadId) ?? null
}

/** Trigger a best-effort nickname lookup (no-op when already cached/in-flight). */
export function resolveChildNickname(threadId: string): void {
  nicknameTransport()?.resolveChildNickname(threadId)
}

/** Subscribe to nickname-cache changes. */
export function subscribeChildNicknames(callback: () => void): () => void {
  const transport = nicknameTransport()
  if (!transport) return () => {}
  return transport.subscribeChildNicknames(callback)
}

export function getChildNicknamesServerSnapshot(): null {
  return null
}

/**
 * Hook: returns the nickname for `threadId`, kicking the lookup once.
 * Re-renders when the transport's nickname cache resolves it.
 */
export function useChildNickname(threadId: string): string | null {
  const nickname = useSyncExternalStore(
    subscribeChildNicknames,
    () => {
      // Kick the lookup on every read; the transport de-dupes in-flight
      // requests, so this is cheap after the first call.
      resolveChildNickname(threadId)
      return getChildNickname(threadId)
    },
    getChildNicknamesServerSnapshot
  )
  return nickname
}
