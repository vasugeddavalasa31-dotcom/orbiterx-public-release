"use client"

import { useEffect } from "react"
import { usePathname, useRouter } from "next/navigation"
import { isDesktop } from "@/lib/platform"
import {
  hasOrbiterxAuth,
  isExplicitLogout,
  onOrbiterxAuthChange,
} from "@/lib/transport/web-auth"

/**
 * Route-level auth guard mounted once in the root layout. The landing page,
 * login page, and OAuth callback are public; every other route requires a
 * session: web mode needs a stored credential, and desktop mode must not be
 * in an explicit signed-out state. Anything else is bounced to /login
 * instantly — so opening Settings (or any window/route) while logged out
 * shows the login page instead of the app.
 */
export function AuthGate() {
  const pathname = usePathname()
  const router = useRouter()

  useEffect(() => {
    const isPublicRoute = () =>
      pathname === "/" ||
      pathname === "/login" ||
      pathname.startsWith("/login/") ||
      pathname === "/auth/callback" ||
      pathname.startsWith("/auth/callback/")

    const check = () => {
      if (!pathname || isPublicRoute()) return
      if (isDesktop()) {
        if (isExplicitLogout()) {
          router.replace("/login")
        }
        return
      }
      if (!hasOrbiterxAuth()) {
        router.replace("/login")
      }
    }

    check()
    // Sign-out/sign-in from another window (e.g. the Settings popup) must be
    // reflected here immediately instead of waiting for a page reload.
    const unsubscribeStorage = onOrbiterxAuthChange(check)
    const onVisible = () => {
      if (document.visibilityState === "visible") check()
    }
    document.addEventListener("visibilitychange", onVisible)
    return () => {
      unsubscribeStorage()
      document.removeEventListener("visibilitychange", onVisible)
    }
  }, [pathname, router])

  return null
}
