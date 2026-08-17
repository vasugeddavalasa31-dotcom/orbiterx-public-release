// SSR-safe adapter between the app-server transport's persistent-WS health and
// React's `useSyncExternalStore`, mirroring `web-connection-store.ts` so the
// same reconnect UI drives both transports. The app-server transport flips
// `_wsConnected` on socket close/reopen (and only after `initialize` succeeds),
// so a dead app-server (network drop / process death) surfaces as a
// "Reconnecting…" banner instead of silently looking connected.

import { getShellTransport } from "./index"
import type { UnsubscribeFn } from "./types"

type ShellConnState = "connected" | "reconnecting"

const CONNECTED: ShellConnState = "connected"
const noop = () => {}

interface ShellConnectionTransport {
  subscribeConnection(callback: () => void): UnsubscribeFn
  getConnectionSnapshot(): ShellConnState
}

// The app-server shell transport is the health source on BOTH web and desktop.
// Shape-checked (like the web store) so a future transport swap degrades to
// the "connected" default instead of crashing.
function shellTransport(): ShellConnectionTransport | null {
  if (typeof window === "undefined") return null
  const transport = getShellTransport()
  if (
    typeof (transport as Partial<ShellConnectionTransport>)
      .subscribeConnection !== "function" ||
    typeof (transport as Partial<ShellConnectionTransport>)
      .getConnectionSnapshot !== "function"
  ) {
    return null
  }
  return transport as unknown as ShellConnectionTransport
}

export function subscribeShellConnection(callback: () => void): () => void {
  const transport = shellTransport()
  if (!transport) return noop
  return transport.subscribeConnection(callback)
}

export function getShellConnectionSnapshot(): ShellConnState {
  return shellTransport()?.getConnectionSnapshot() ?? CONNECTED
}

export function getShellConnectionServerSnapshot(): ShellConnState {
  return CONNECTED
}
