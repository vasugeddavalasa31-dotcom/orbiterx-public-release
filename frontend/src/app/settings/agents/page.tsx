"use client"

import { useEffect } from "react"
import { useRouter } from "next/navigation"

// The Agents section is hidden from Settings; keep a direct URL from
// showing it. Redirect to the default settings page instead.
export default function SettingsAgentsPage() {
  const router = useRouter()

  useEffect(() => {
    router.replace("/settings/appearance")
  }, [router])

  return null
}
