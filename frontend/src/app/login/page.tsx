"use client"

import { useEffect, useState } from "react"
import { useRouter } from "next/navigation"
import Link from "next/link"
import { useTranslations } from "next-intl"
import {
  ArrowLeft,
  Eye,
  EyeOff,
  FileDiff,
  KeyRound,
  Loader2,
  Radio,
  ShieldCheck,
  Workflow,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { AppTitleBar } from "@/components/layout/app-title-bar"
import { BrandMark } from "@/components/landing/brand-mark"
import { OrbitVisual } from "@/components/landing/orbit-visual"
import { decodeJwtProperties } from "@/lib/auth-oauth"
import { openUrl } from "@/lib/platform"
import { codexPollDeviceCode, codexRequestDeviceCode } from "@/lib/api"
import { isDesktop } from "@/lib/platform"
import {
  clearLogoutFlag,
  hasOrbiterxAuth,
  isExplicitLogout,
  onOrbiterxAuthChange,
} from "@/lib/transport/web-auth"
import { setOrbiterxGatewayApiKey } from "@/lib/api"

const BRAND_POINTS = [
  { icon: Workflow, key: "chipParallel" },
  { icon: Radio, key: "chipLive" },
  { icon: FileDiff, key: "chipDiffs" },
] as const

export default function LoginPage() {
  const router = useRouter()
  const t = useTranslations("LoginPage")
  const tLanding = useTranslations("LandingPage")
  const [token, setToken] = useState("")
  const [showToken, setShowToken] = useState(false)
  const [error, setError] = useState("")
  const [loading, setLoading] = useState(false)
  const [ssoStatus, setSsoStatus] = useState<"idle" | "polling" | "error">(
    "idle"
  )
  const [ssoError, setSsoError] = useState("")
  const [deviceCode, setDeviceCode] = useState<{
    userCode: string
    verificationUrl: string
    deviceAuthId: string
    interval: number
    redirectUri?: string
  } | null>(null)

  useEffect(() => {
    document.title = t("documentTitle")
  }, [t])

  // If sign-in completes in another window (OAuth callback, token form in the
  // Settings popup), follow it into the workspace instead of sitting here.
  useEffect(() => {
    return onOrbiterxAuthChange(() => {
      if (!isExplicitLogout() && hasOrbiterxAuth()) {
        clearLogoutFlag()
        router.replace("/workspace")
      }
    })
  }, [router])

  // Poll for the browser sign-in to complete (same pattern as Settings →
  // Agents device-code login): the app auto-logs-in once the account login
  // finishes, no manual refresh needed.
  useEffect(() => {
    if (ssoStatus !== "polling" || !deviceCode) return
    const pollInterval = (deviceCode.interval || 5) * 1000
    const deadline = Date.now() + 15 * 60 * 1000
    let timer: ReturnType<typeof setTimeout> | null = null
    let active = true

    const poll = async () => {
      if (!active) return
      if (Date.now() > deadline) {
        setSsoStatus("error")
        setSsoError(t("ssoTimeout"))
        return
      }
      try {
        const result = await codexPollDeviceCode({
          deviceAuthId: deviceCode.deviceAuthId,
          userCode: deviceCode.userCode,
        })
        if (!active) return
        if (result.status === "success") {
          if (result.accessToken) {
            // The Rust sidecar completes the OAuth browser flow and returns
            // the tokens. Keep the access token as the web session; the
            // gateway key comes from the sidecar's token-exchange (`apiKey`)
            // or, on web, from the token's `properties` claim. When the token
            // is a per-user key itself (landing-page `sess_` flow, no JWT
            // claims, no separate exchange key), use it directly as the
            // gateway key — that is what the gateway validates.
            localStorage.setItem("orbiterx_access_token", result.accessToken)
            const props = decodeJwtProperties(result.accessToken)
            const apiKey =
              result.apiKey ?? props?.apiKey ?? result.accessToken
            if (typeof apiKey === "string" && apiKey) {
              try {
                await setOrbiterxGatewayApiKey(apiKey)
              } catch (err) {
                console.error("[login] failed to persist gateway API key:", err)
                setSsoStatus("error")
                setSsoError(
                  t("ssoSaveFailed", {
                    message: err instanceof Error ? err.message : String(err),
                  })
                )
                return
              }
            }
          }
          clearLogoutFlag()
          router.replace("/workspace")
          return
        }
        if (result.status === "error") {
          setSsoStatus("error")
          setSsoError(result.message ?? t("ssoFailed"))
          return
        }
        timer = setTimeout(poll, pollInterval)
      } catch {
        if (active) timer = setTimeout(poll, pollInterval)
      }
    }

    timer = setTimeout(poll, pollInterval)
    return () => {
      active = false
      if (timer) clearTimeout(timer)
    }
  }, [ssoStatus, deviceCode, router, t])

  // Desktop users who are already signed in skip straight to the workspace.
  // A fresh install (no persisted credential) must NOT skip — they see the
  // login form. An explicit logout also keeps the login page visible.
  if (isDesktop() && hasOrbiterxAuth() && !isExplicitLogout()) {
    router.replace("/workspace")
    return null
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError("")
    setLoading(true)

    try {
      // Validate token by calling the lightweight health endpoint
      const res = await fetch("/api/health", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token.trim()}`,
        },
        body: "{}",
      })

      if (res.ok) {
        localStorage.setItem("orbiterx_token", token.trim())
        // Same as SSO: make the gateway provider use the logged-in user's key.
        try {
          await setOrbiterxGatewayApiKey(token.trim())
        } catch (err) {
          console.error("[login] failed to persist gateway API key:", err)
          setError(
            t("ssoSaveFailed", {
              message: err instanceof Error ? err.message : String(err),
            })
          )
          return
        }
        clearLogoutFlag()
        router.replace("/workspace")
      } else if (res.status === 401) {
        setError(t("invalidToken"))
      } else {
        setError(t("connectionFailed", { status: res.status }))
      }
    } catch {
      setError(t("networkError"))
    } finally {
      setLoading(false)
    }
  }

  // Start the hosted sign-in. On desktop the Rust sidecar runs a short-lived
  // localhost callback server and opens the auth server's authorize URL; the
  // browser redirects back with a code, the sidecar exchanges it and returns
  // the tokens, and this page polls for the result. On web this uses the
  // authorize flow in a new tab, completed by /auth/callback.
  async function handleSso() {
    setSsoStatus("polling")
    setSsoError("")
    try {
      const code = await codexRequestDeviceCode()
      setDeviceCode(code)
      await openUrl(code.verificationUrl)
    } catch {
      setSsoStatus("error")
      setSsoError(t("ssoFailed"))
    }
  }

  return (
    <div className="relative flex h-screen flex-col overflow-hidden bg-background text-foreground">
      {/* In-window title bar: the Tauri main window has no native frame on
          Windows/Linux, so this renders the min/max/close controls + a drag
          region. macOS keeps the native traffic lights overlaid, so this
          provides the top spacing for them on the login screen too. */}
      <AppTitleBar />

      {/* Decorative orbit, tucked into the corner */}
      <OrbitVisual className="absolute -right-48 -top-48 size-[34rem] opacity-15" />

      <div className="relative flex min-h-0 flex-1 overflow-y-auto">
        <div className="relative mx-auto flex w-full max-w-6xl flex-col justify-center gap-12 px-6 py-12 lg:flex-row lg:items-center lg:gap-20">
        {/* ── Brand panel (desktop) ─────────────────────────────────────── */}
        <div className="hidden flex-1 lg:block">
          <BrandMark />
          <h1 className="mt-10 max-w-md text-5xl font-semibold leading-[1.08] tracking-tighter">
            {tLanding("heroTitle")}
            <br />
            <span className="text-amber-500">
              {tLanding("heroTitleAccent")}
            </span>
          </h1>
          <p className="mt-5 max-w-md text-muted-foreground">
            {tLanding("heroSubtitle")}
          </p>
          <ul className="mt-8 space-y-3">
            {BRAND_POINTS.map(({ icon: Icon, key }) => (
              <li key={key} className="flex items-center gap-3 text-sm">
                <span className="grid size-8 place-items-center rounded-lg bg-amber-500/10 text-amber-600 dark:text-amber-400">
                  <Icon className="size-4" aria-hidden />
                </span>
                <span className="text-muted-foreground">{tLanding(key)}</span>
              </li>
            ))}
          </ul>
          <div className="mt-10 inline-flex items-center gap-2 rounded-full border bg-card px-3 py-1.5 text-xs text-muted-foreground">
            <ShieldCheck className="size-4 text-emerald-500" aria-hidden />
            {t("secureBadge")}
          </div>
        </div>

        {/* ── Login card ────────────────────────────────────────────────── */}
        <div className="mx-auto w-full max-w-md lg:mx-0">
          <div className="rounded-3xl border bg-card p-8 shadow-xl sm:p-10">
            <div className="lg:hidden">
              <BrandMark />
            </div>
            <div className="mt-2 lg:mt-0">
              <h2 className="text-2xl font-semibold tracking-tight">
                {t("brand")}
              </h2>
              <p className="mt-1.5 text-sm text-muted-foreground">
                {t("subtitle")}
              </p>
            </div>

            {ssoStatus === "idle" && (
              <Button
                size="lg"
                className="mt-8 h-11 w-full"
                onClick={handleSso}
              >
                <KeyRound aria-hidden />
                {t("ssoButton")}
              </Button>
            )}

            {ssoStatus === "polling" && deviceCode && (
              <div className="mt-3 space-y-3 rounded-2xl border bg-muted/40 p-4">
                <p className="flex items-center gap-2 text-xs text-muted-foreground">
                  <Loader2 className="size-3.5 animate-spin" aria-hidden />
                  {t("ssoLaunched")}
                </p>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="w-full"
                  onClick={() => openUrl(deviceCode.verificationUrl)}
                >
                  {t("ssoRefresh")}
                </Button>
                <div className="flex items-center justify-between gap-2">
                  <code className="rounded bg-muted px-2 py-1 font-mono text-xs font-semibold tracking-widest">
                    {deviceCode.userCode}
                  </code>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      setSsoStatus("idle")
                      setDeviceCode(null)
                    }}
                  >
                    {t("ssoCancel")}
                  </Button>
                </div>
              </div>
            )}

            {ssoStatus === "error" && (
              <div className="mt-3 space-y-2">
                <p
                  role="alert"
                  className="rounded-xl border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive"
                >
                  {ssoError}
                </p>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="w-full"
                  onClick={() => setSsoStatus("idle")}
                >
                  {t("ssoRetry")}
                </Button>
              </div>
            )}

            <div className="my-5 flex items-center gap-3 text-xs text-muted-foreground">
              <span className="h-px flex-1 bg-border" aria-hidden />
              {t("orToken")}
              <span className="h-px flex-1 bg-border" aria-hidden />
            </div>

            <form onSubmit={handleSubmit} className="space-y-4">
              <div className="space-y-2">
                <label
                  htmlFor="access-token"
                  className="text-sm font-medium text-foreground"
                >
                  {t("tokenPlaceholder")}
                </label>
                <div className="relative">
                  <Input
                    id="access-token"
                    type={showToken ? "text" : "password"}
                    value={token}
                    onChange={(e) => setToken(e.target.value)}
                    placeholder={t("tokenPlaceholder")}
                    autoFocus
                    autoComplete="off"
                    spellCheck={false}
                    className="h-11 pr-11"
                    aria-invalid={error ? true : undefined}
                  />
                  <button
                    type="button"
                    onClick={() => setShowToken((v) => !v)}
                    disabled={!token}
                    className="absolute right-2 top-1/2 grid size-8 -translate-y-1/2 place-items-center rounded-full text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-40"
                    aria-label={showToken ? t("hideToken") : t("showToken")}
                  >
                    {showToken ? (
                      <EyeOff className="size-4" aria-hidden />
                    ) : (
                      <Eye className="size-4" aria-hidden />
                    )}
                  </button>
                </div>
              </div>

              {error && (
                <p
                  role="alert"
                  className="rounded-xl border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
                >
                  {error}
                </p>
              )}

              <Button
                type="submit"
                disabled={!token.trim() || loading}
                className="h-11 w-full"
              >
                {loading ? (
                  <>
                    <Loader2 className="animate-spin" aria-hidden />
                    {t("connecting")}
                  </>
                ) : (
                  t("connect")
                )}
              </Button>
            </form>

            {/* Where to find the token */}
            <details className="group mt-6 rounded-2xl border bg-muted/40 px-4 py-3">
              <summary className="cursor-pointer list-none text-sm font-medium text-foreground marker:hidden">
                <span className="flex items-center justify-between gap-2">
                  {t("helpTitle")}
                  <span
                    aria-hidden
                    className="text-muted-foreground transition-transform group-open:rotate-180"
                  >
                    ▾
                  </span>
                </span>
              </summary>
              <ol className="mt-3 space-y-1.5 pl-1 text-sm text-muted-foreground">
                <li>1. {t("helpStep1")}</li>
                <li>2. {t("helpStep2")}</li>
                <li>3. {t("helpStep3")}</li>
              </ol>
              <p className="mt-3 border-t pt-3 text-xs text-muted-foreground/80">
                {t("helpNote")}
              </p>
            </details>

            <Link
              href="/"
              className="mt-6 inline-flex items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
            >
              <ArrowLeft className="size-4" aria-hidden />
              {t("backHome")}
            </Link>
          </div>
        </div>
        </div>
      </div>
    </div>
  )
}
