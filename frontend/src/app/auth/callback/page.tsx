"use client"

import { useEffect, useState } from "react"
import { useRouter, useSearchParams } from "next/navigation"
import Link from "next/link"
import { ArrowLeft, CheckCircle2, Loader2, XCircle } from "lucide-react"
import { Button } from "@/components/ui/button"
import { BrandMark } from "@/components/landing/brand-mark"
import { OrbitVisual } from "@/components/landing/orbit-visual"
import {
  ORBITERX_AUTH_CLIENT_ID,
  ORBITERX_AUTH_ISSUER,
  consumeOrbiterxOAuthParams,
  decodeJwtProperties,
} from "@/lib/auth-oauth"
import { setOrbiterxGatewayApiKey } from "@/lib/api"
import { clearLogoutFlag } from "@/lib/transport/web-auth"

export default function AuthCallbackPage() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const [status, setStatus] = useState<"loading" | "success" | "error">(
    "loading"
  )
  const [errorMsg, setErrorMsg] = useState<string | null>(null)

  useEffect(() => {
    const code = searchParams.get("code")
    const state = searchParams.get("state")
    if (!code) {
      const id = window.requestAnimationFrame(() => {
        setStatus("error")
        setErrorMsg("No authorization code provided in callback URL.")
      })
      return () => window.cancelAnimationFrame(id)
    }

    // The state we started the sign-in with must round-trip, or the code may
    // have been injected by someone other than the tab that initiated login.
    const { verifier, state: storedState } = consumeOrbiterxOAuthParams()
    if (storedState && state !== storedState) {
      const id = window.requestAnimationFrame(() => {
        setStatus("error")
        setErrorMsg(
          "Sign-in state mismatch. This can happen if you opened the callback URL directly; please sign in again."
        )
      })
      return () => window.cancelAnimationFrame(id)
    }

    async function exchangeToken() {
      try {
        const body = new URLSearchParams({
          grant_type: "authorization_code",
          code: code!,
          client_id: ORBITERX_AUTH_CLIENT_ID,
          redirect_uri: `${window.location.origin}/auth/callback`,
        })
        // S256 PKCE verifier from `beginOrbiterxOAuth`. Omitted only when the
        // flow was started without one (e.g. a legacy direct callback).
        if (verifier) {
          body.set("code_verifier", verifier)
        }
        const res = await fetch(`${ORBITERX_AUTH_ISSUER}/oauth/token`, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body,
        })

        if (!res.ok) {
          const detail = await res.text().catch(() => "")
          setStatus("error")
          setErrorMsg(
            `Sign-in failed: the auth server returned ${res.status}${
              detail ? ` (${detail.slice(0, 200)})` : ""
            }.`
          )
          return
        }

        const data = await res.json()
        if (!data.access_token) {
          setStatus("error")
          setErrorMsg(
            "The auth server did not return an access token. Please try signing in again."
          )
          return
        }

        localStorage.setItem("orbiterx_access_token", data.access_token)
        // The auth server embeds the user's stable gateway API key in the
        // token's `properties`. Persist it as the orbiterx-gateway bearer so
        // model calls authenticate with the user's own key (per-user usage
        // and billing) instead of the expiring access token.
        const props = decodeJwtProperties(data.access_token)
        const apiKey = props?.apiKey
        if (typeof apiKey === "string" && apiKey) {
          try {
            await setOrbiterxGatewayApiKey(apiKey)
          } catch (err) {
            console.error(
              "[auth/callback] failed to persist gateway API key:",
              err
            )
            // Sign-in itself succeeded; don't pretend the key was saved.
            setStatus("error")
            setErrorMsg(
              `Signed in, but failed to save the gateway API key: ${
                err instanceof Error ? err.message : String(err)
              }`
            )
            return
          }
        }

        setStatus("success")
        clearLogoutFlag()
        setTimeout(() => {
          router.push("/workspace")
        }, 1500)
      } catch (err) {
        setStatus("error")
        setErrorMsg(
          `Sign-in failed: ${err instanceof Error ? err.message : String(err)}`
        )
      }
    }

    exchangeToken()
  }, [searchParams, router])

  return (
    <div className="relative flex min-h-screen items-center justify-center overflow-hidden bg-background p-6 text-foreground">
      <OrbitVisual className="absolute -left-48 -top-48 size-[32rem] opacity-15" />
      <OrbitVisual className="absolute -bottom-56 -right-56 size-[36rem] opacity-10" />

      <div className="relative w-full max-w-md rounded-3xl border bg-card p-8 text-center shadow-xl sm:p-10">
        <div className="flex justify-center">
          <BrandMark />
        </div>

        <div className="mt-6 flex justify-center">
          {status === "loading" && (
            <Loader2
              className="size-8 animate-spin text-amber-500"
              aria-hidden
            />
          )}
          {status === "success" && (
            <CheckCircle2 className="size-8 text-emerald-500" aria-hidden />
          )}
          {status === "error" && (
            <XCircle className="size-8 text-destructive" aria-hidden />
          )}
        </div>

        <h1 className="mt-4 text-xl font-semibold tracking-tight">
          OrbiterX Authentication
        </h1>

        {status === "loading" && (
          <p className="mt-2 text-sm text-muted-foreground">
            Completing sign in with your OrbiterX Account…
          </p>
        )}

        {status === "success" && (
          <div className="mt-4 space-y-2">
            <p className="text-sm font-medium text-emerald-600 dark:text-emerald-400">
              Successfully authenticated!
            </p>
            <p className="text-xs text-muted-foreground">
              Redirecting to your workstation…
            </p>
          </div>
        )}

        {status === "error" && (
          <div className="mt-4 space-y-4">
            <p className="text-sm text-destructive">
              {errorMsg || "Authentication failed."}
            </p>
            <div className="flex flex-col items-center gap-2">
              <Button onClick={() => router.push("/login")}>
                Back to Sign in
              </Button>
              <Link
                href="/"
                className="inline-flex items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
              >
                <ArrowLeft className="size-4" aria-hidden />
                Back to home
              </Link>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
