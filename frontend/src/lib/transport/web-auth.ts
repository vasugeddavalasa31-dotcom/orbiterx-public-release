import { clearOrbiterxOAuthFlow } from "@/lib/auth-oauth"

// Shared helpers for web-mode HTTP calls — the JSON transport in
// `web-transport.ts` and direct multipart/file callers in `lib/api.ts` both
// need consistent token retrieval and 401 redirect behavior. Keeping them in
// one place means a future move from `localStorage` to cookies (or rotation
// rules, multi-tenant prefixing, etc.) doesn't have to be remembered at every
// call site.

const TOKEN_KEY = "orbiterx_token"
const ACCESS_TOKEN_KEY = "orbiterx_access_token"
const AUTH_CODE_KEY = "orbiterx_auth_code"
const LOGGED_OUT_FLAG = "orbiterx_logged_out"
const AUTH_STORAGE_KEYS = [
  TOKEN_KEY,
  ACCESS_TOKEN_KEY,
  AUTH_CODE_KEY,
  LOGGED_OUT_FLAG,
]

export function getOrbiterxToken(): string {
  return localStorage.getItem(TOKEN_KEY) ?? ""
}

/** Drop every client-side credential (web token + OAuth session keys). */
export function clearOrbiterxAuth(): void {
  localStorage.removeItem(TOKEN_KEY)
  localStorage.removeItem(ACCESS_TOKEN_KEY)
  localStorage.removeItem(AUTH_CODE_KEY)
  clearOrbiterxOAuthFlow()
}

/** True when any client-side credential is present. */
export function hasOrbiterxAuth(): boolean {
  return Boolean(
    localStorage.getItem(TOKEN_KEY) || localStorage.getItem(ACCESS_TOKEN_KEY)
  )
}

/**
 * True when the current session was ended by an explicit "Sign out" (as
 * opposed to a normal visit or a 401 bounce). The login page uses this to
 * stay visible after desktop logout instead of redirecting back to the
 * workspace. Stored in localStorage so the signed-out state survives closing
 * and reopening windows/tabs — not just the current session.
 */
export function isExplicitLogout(): boolean {
  try {
    return localStorage.getItem(LOGGED_OUT_FLAG) === "1"
  } catch {
    return false
  }
}

export function clearLogoutFlag(): void {
  try {
    localStorage.removeItem(LOGGED_OUT_FLAG)
  } catch {
    // Storage unavailable — the flag just stays; harmless.
  }
}

/** Sign out and return to the standalone login page. */
export async function logoutOrbiterx(): Promise<void> {
  const token =
    getOrbiterxToken() || localStorage.getItem(ACCESS_TOKEN_KEY) || ""
  // Clear client-side state first so the UI immediately reflects sign-out.
  clearOrbiterxAuth()
  try {
    localStorage.setItem(LOGGED_OUT_FLAG, "1")
  } catch {
    // Storage unavailable — proceed with the redirect anyway.
  }

  // Best-effort cleanup: revoke the provisioned gateway key server-side and
  // remove the key embedded in the app config. Both are bounded so a hung
  // network never blocks the redirect; local sign-out already happened.
  const cleanup = async () => {
    const api = await import("@/lib/api")
    await Promise.allSettled([
      token ? api.revokeOrbiterxGatewayKey(token) : Promise.resolve(false),
      api.clearOrbiterxGatewayProvider(),
    ])
  }
  await Promise.race([
    cleanup(),
    new Promise((resolve) => setTimeout(resolve, 2500)),
  ])

  window.location.href = "/login"
}

/**
 * Subscribe to auth-state changes made from another window/tab. localStorage
 * fires `storage` events only in *other* documents, so this is how the main
 * window learns that Settings signed out (or signed back in) without a page
 * reload. Returns an unsubscribe function.
 */
export function onOrbiterxAuthChange(callback: () => void): () => void {
  const onStorage = (event: StorageEvent) => {
    if (event.key === null || AUTH_STORAGE_KEYS.includes(event.key)) {
      callback()
    }
  }
  window.addEventListener("storage", onStorage)
  return () => window.removeEventListener("storage", onStorage)
}

export function redirectToOrbiterxLogin(): void {
  if (window.location.pathname.startsWith("/login")) return
  clearOrbiterxAuth()
  window.location.href = "/login"
}
