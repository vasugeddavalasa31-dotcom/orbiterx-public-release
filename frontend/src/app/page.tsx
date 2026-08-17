"use client"

import { useEffect, useState } from "react"
import { useRouter } from "next/navigation"
import { LandingPage } from "@/components/landing/landing-page"
import { BrandMark } from "@/components/landing/brand-mark"
import { isDesktop } from "@/lib/platform"
import { isExplicitLogout } from "@/lib/transport/web-auth"

type GateState = "checking" | "landing"

export default function Page() {
  const router = useRouter()
  const [state, setState] = useState<GateState>("checking")

  useEffect(() => {
    if (isDesktop()) {
      // Explicitly signed out → the login page owns the screen until sign-in.
      if (isExplicitLogout()) {
        router.replace("/login")
        return
      }
      router.replace("/workspace")
      return
    }
    // Web mode: validate token before entering the app. No token → land on
    // the marketing page; a valid token goes straight to the workspace; a
    // rejected token drops it and shows the landing page.
    const token = localStorage.getItem("orbiterx_token")
    if (!token) {
      // A returning user who just signed out goes straight to login; a brand
      // new visitor (no flag) sees the landing page instead.
      if (isExplicitLogout()) {
        router.replace("/login")
        return
      }
      // Defer the state flip out of the effect body (rAF) so the gate keeps
      // its "checking" frame through hydration, then swaps to the landing page.
      const id = window.requestAnimationFrame(() => setState("landing"))
      return () => window.cancelAnimationFrame(id)
    }
    fetch("/api/health", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: "{}",
    })
      .then((res) => {
        if (res.ok) {
          router.replace("/workspace")
          return
        }
        if (res.status === 401) {
          // Token genuinely rejected → clear it and re-authenticate.
          localStorage.removeItem("orbiterx_token")
          setState("landing")
          return
        }
        // Server reachable but unhealthy (5xx / proxy error). Keep the token
        // and enter the app; the in-app reconnect dialog handles recovery
        // instead of bouncing a valid session to /login.
        router.replace("/workspace")
      })
      .catch(() => {
        // Server unreachable (restart, network blip, sleep/wake). The token is
        // almost certainly still valid — don't discard it. Enter the workspace
        // and let WebConnectionGuard surface the offline state and recover.
        router.replace("/workspace")
      })
  }, [router])

  if (state === "checking") {
    return (
      <div className="grid min-h-screen place-items-center bg-background">
        <BrandMark />
      </div>
    )
  }

  return <LandingPage />
}
