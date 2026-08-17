// OrbiterX account SSO — the app's hosted sign-in flow. The Rust CLI/desktop
// flows use the same issuer (see orbiterx-rs/login), and the web callback lives
// at /auth/callback where the authorization code is exchanged for a token.
//
// The web flow follows the same OAuth shape as the Rust flows: a `state` value
// guards against CSRF and an S256 PKCE challenge proves the code belongs to the
// browser tab that started the sign-in. The verifier/state are kept in
// localStorage because the callback may land in a different tab (the login page
// opens the authorize URL in a new tab on web).

export const ORBITERX_AUTH_ISSUER = "https://auth.orbiterxai.online"
export const ORBITERX_AUTH_CLIENT_ID = "orbiterx-desktop"

const PKCE_VERIFIER_KEY = "orbiterx_pkce_verifier"
const OAUTH_STATE_KEY = "orbiterx_oauth_state"

function randomBase64Url(byteLength: number): string {
  const bytes = new Uint8Array(byteLength)
  crypto.getRandomValues(bytes)
  return base64UrlEncode(bytes)
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = ""
  for (const byte of bytes) {
    binary += String.fromCharCode(byte)
  }
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "")
}

async function pkceChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(verifier)
  )
  return base64UrlEncode(new Uint8Array(digest))
}

/** Drop any in-flight OAuth PKCE/state so a cancelled sign-in can't be replayed. */
export function clearOrbiterxOAuthFlow(): void {
  try {
    localStorage.removeItem(PKCE_VERIFIER_KEY)
    localStorage.removeItem(OAUTH_STATE_KEY)
  } catch {
    // Storage unavailable — the params simply stay; they are short-lived and
    // keyed to the next successful exchange.
  }
}

/**
 * Start a hosted sign-in: generate state + PKCE, persist them, and return the
 * authorize URL for the current origin. `redirect_uri` must match the callback
 * route the auth server has registered for this client.
 */
export async function beginOrbiterxOAuth(): Promise<string> {
  const verifier = randomBase64Url(64)
  const state = randomBase64Url(32)
  // `crypto.subtle` is only available in secure contexts; degrade to a
  // state-only flow there rather than breaking sign-in entirely.
  let challenge: string | null = null
  try {
    if (crypto?.subtle) {
      challenge = await pkceChallenge(verifier)
    }
  } catch {
    challenge = null
  }
  try {
    if (challenge) {
      localStorage.setItem(PKCE_VERIFIER_KEY, verifier)
    }
    localStorage.setItem(OAUTH_STATE_KEY, state)
  } catch {
    // Storage unavailable — proceed anyway; the exchange will simply omit the
    // code_verifier if the callback cannot read it back.
  }

  const origin =
    typeof window !== "undefined"
      ? window.location.origin
      : "http://localhost:3000"
  const params = new URLSearchParams({
    response_type: "code",
    client_id: ORBITERX_AUTH_CLIENT_ID,
    redirect_uri: `${origin}/auth/callback`,
    state,
  })
  if (challenge) {
    params.set("code_challenge", challenge)
    params.set("code_challenge_method", "S256")
  }
  return `${ORBITERX_AUTH_ISSUER}/oauth/authorize?${params.toString()}`
}

/**
 * Read (and clear) the PKCE verifier + state stored by `beginOrbiterxOAuth`.
 * Returns nulls when no flow was started (e.g. a stale bookmark to the
 * callback URL).
 */
export function consumeOrbiterxOAuthParams(): {
  verifier: string | null
  state: string | null
} {
  let verifier: string | null = null
  let state: string | null = null
  try {
    verifier = localStorage.getItem(PKCE_VERIFIER_KEY)
    state = localStorage.getItem(OAUTH_STATE_KEY)
  } catch {
    // Storage unavailable — treat as no flow.
  }
  clearOrbiterxOAuthFlow()
  return { verifier, state }
}

/**
 * Decode the `properties` claim from an OrbiterX auth JWT (base64url payload).
 * The auth server embeds the user's stable gateway API key there so the app can
 * authenticate to the gateway with the user's own key (per-user usage/billing)
 * instead of the expiring access token.
 */
export function decodeJwtProperties(
  token: string
): Record<string, unknown> | null {
  try {
    const payload = token.split(".")[1]
    if (!payload) return null
    const normalized = payload.replace(/-/g, "+").replace(/_/g, "/")
    // Restore base64 padding (base64url omits it) before atob.
    const padded = normalized.padEnd(
      normalized.length + ((4 - (normalized.length % 4)) % 4),
      "="
    )
    const decoded = atob(padded)
    const claims = JSON.parse(decoded) as Record<string, unknown>
    // The gateway key lives in the nested `properties` claim
    // (payload.properties.apiKey); callers read `props?.apiKey`. Fall back to
    // the whole payload so a future shape with top-level keys still works.
    if (
      claims.properties &&
      typeof claims.properties === "object" &&
      !Array.isArray(claims.properties)
    ) {
      return claims.properties as Record<string, unknown>
    }
    return claims
  } catch {
    return null
  }
}
