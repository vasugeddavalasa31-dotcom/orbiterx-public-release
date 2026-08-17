"use client"

import { ThinkingOrb, type OrbState } from "thinking-orbs"
import { cn } from "@/lib/utils"

/**
 * Thin wrapper around the `thinking-orbs` canvas orb so the rest of the app
 * never depends on the library's API directly. `theme="auto"` resolves from
 * the host project's `dark` class / `data-theme` (our AppearanceProvider adds
 * `dark` to <html>), and the orb self-pauses offscreen / honors
 * `prefers-reduced-motion` internally.
 *
 * Maps our UI contexts onto the six shipped states:
 * - `working`   — agent reasoning / a normal turn in flight
 * - `searching` — explore / context gathering / web search
 * - `composing` — assistant composing a reply
 * - `listening` — voice input / awaiting audio
 */
export type ThinkingOrbVariant =
  "working" | "searching" | "composing" | "listening"

const STATE_MAP: Record<ThinkingOrbVariant, OrbState> = {
  working: "working",
  searching: "searching",
  composing: "composing",
  listening: "listening",
}

interface ThinkingOrbIndicatorProps {
  /** Which animation to show. @default "working" */
  variant?: ThinkingOrbVariant
  /** Tuned preset — 64 (chat-avatar) or 20 (inline text). @default 20 */
  size?: 64 | 20
  className?: string
  /** Accessible label. @default "Thinking" */
  label?: string
}

export function ThinkingOrbIndicator({
  variant = "working",
  size = 20,
  className,
  label = "Thinking",
}: ThinkingOrbIndicatorProps) {
  return (
    <ThinkingOrb
      state={STATE_MAP[variant]}
      size={size}
      theme="auto"
      aria-label={label}
      className={cn("shrink-0", className)}
    />
  )
}
