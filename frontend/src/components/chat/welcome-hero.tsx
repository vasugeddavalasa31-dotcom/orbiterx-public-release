"use client"

import { useEffect, useState, type ReactNode } from "react"
import { useTranslations } from "next-intl"
import { Lightbulb } from "lucide-react"
import { useShortcutSettings } from "@/hooks/use-shortcut-settings"
import { useIsMac } from "@/hooks/use-is-mac"
import {
  formatShortcutLabel,
  type ShortcutSettings,
} from "@/lib/keyboard-shortcuts"

type TipKey =
  | "tileTabs"
  | "pinTab"
  | "shortcutsNewSearch"
  | "slashAtMention"
  | "pasteDropFiles"
  | "queueMessage"
  | "draftAutoSave"
  | "forkSend"
  | "exportConversation"
  | "chatChannels"
  | "shortcutsAuxPanel"
  | "shortcutsTerminalSidebar"
  | "customShortcuts"
  | "webService"
  | "fusionMode"
  | "quickMessages"
  | "experts"

interface TipDef {
  key: TipKey
  buildValues?: (ctx: {
    shortcuts: ShortcutSettings
    isMac: boolean
    kbd: (chunks: ReactNode) => ReactNode
  }) => Record<string, ReactNode | ((chunks: ReactNode) => ReactNode) | string>
}

const TIPS: TipDef[] = [
  { key: "tileTabs" },
  { key: "pinTab" },
  {
    key: "shortcutsNewSearch",
    buildValues: ({ shortcuts, isMac, kbd }) => ({
      shortcut: kbd,
      newConversation: formatShortcutLabel(shortcuts.new_conversation, isMac),
      searchConversations: formatShortcutLabel(shortcuts.toggle_search, isMac),
    }),
  },
  { key: "slashAtMention" },
  { key: "pasteDropFiles" },
  { key: "queueMessage" },
  { key: "draftAutoSave" },
  { key: "forkSend" },
  { key: "exportConversation" },
  { key: "chatChannels" },
  {
    key: "shortcutsAuxPanel",
    buildValues: ({ shortcuts, isMac, kbd }) => ({
      shortcut: kbd,
      toggleAuxPanel: formatShortcutLabel(shortcuts.toggle_aux_panel, isMac),
    }),
  },
  {
    key: "shortcutsTerminalSidebar",
    buildValues: ({ shortcuts, isMac, kbd }) => ({
      shortcut: kbd,
      toggleTerminal: formatShortcutLabel(shortcuts.toggle_terminal, isMac),
      toggleSidebar: formatShortcutLabel(shortcuts.toggle_sidebar, isMac),
    }),
  },
  { key: "customShortcuts" },
  { key: "webService" },
  { key: "fusionMode" },
  { key: "quickMessages" },
  { key: "experts" },
]

const highlightTip = (chunks: ReactNode) => (
  <span className="font-medium text-primary">{chunks}</span>
)

/** Time-of-day greeting key, from the user's local clock. */
function greetingKeyForNow():
  | "greetingMorning"
  | "greetingAfternoon"
  | "greetingEvening"
  | "greetingNight" {
  const hour = new Date().getHours()
  if (hour >= 5 && hour < 12) return "greetingMorning"
  if (hour >= 12 && hour < 17) return "greetingAfternoon"
  if (hour >= 17 && hour < 22) return "greetingEvening"
  return "greetingNight"
}

/** Type the greeting one character at a time (typewriter) with a blinking
 *  caret, keeping the highlight phrase styled. Respects reduced motion (shows
 *  the full text instantly). */
function TypewriterGreeting({
  text,
  highlight,
}: {
  text: string
  highlight: string
}) {
  const highlightIndex = text.indexOf(highlight)
  const parts: Array<{ text: string; highlighted: boolean }> =
    highlightIndex >= 0
      ? [
          { text: text.slice(0, highlightIndex), highlighted: false },
          { text: highlight, highlighted: true },
          {
            text: text.slice(highlightIndex + highlight.length),
            highlighted: false,
          },
        ]
      : [{ text, highlighted: false }]
  const full = parts.map((p) => p.text).join("")

  const [count, setCount] = useState(
    typeof window !== "undefined" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches
      ? full.length
      : 0
  )

  useEffect(() => {
    if (count >= full.length) return
    const id = setInterval(() => {
      setCount((c) => {
        const next = c + 1
        if (next >= full.length) clearInterval(id)
        return next
      })
    }, 36)
    return () => clearInterval(id)
  }, [count, full.length])

  let remaining = count
  const nodes = parts.map((part, i) => {
    const take = Math.min(part.text.length, remaining)
    remaining -= take
    const sub = part.text.slice(0, take)
    if (!sub) return null
    return part.highlighted ? (
      <span
        key={i}
        className="bg-gradient-to-br from-primary via-primary/85 to-chart-3 bg-clip-text text-transparent"
      >
        {sub}
      </span>
    ) : (
      <span key={i}>{sub}</span>
    )
  })

  return (
    <span className="inline-block">
      {nodes}
      {count < full.length && (
        <span
          aria-hidden
          className="ml-0.5 inline-block h-[0.9em] w-[2px] translate-y-[0.12em] animate-pulse bg-primary"
        />
      )}
    </span>
  )
}

export function WelcomeHero() {
  const t = useTranslations("Folder.chat.welcomePanel")
  const greetingKey = greetingKeyForNow()

  return (
    <h1 className="text-center text-3xl font-semibold tracking-tight text-foreground sm:text-4xl">
      <TypewriterGreeting
        text={t(greetingKey)}
        highlight={t("greetingHighlight")}
      />
    </h1>
  )
}

export function WelcomeTip() {
  const t = useTranslations("Folder.chat.welcomePanel")
  const { shortcuts } = useShortcutSettings()
  const isMac = useIsMac()

  const [tipIndex] = useState(() => Math.floor(Math.random() * TIPS.length))
  const tip = TIPS[tipIndex]

  const kbd = (chunks: ReactNode) => (
    <kbd className="mx-0.5 inline-flex items-center rounded border border-border bg-muted px-1.5 py-0.5 font-mono text-[10.5px] font-medium text-foreground/80">
      {chunks}
    </kbd>
  )

  const values = {
    ...(tip.buildValues?.({ shortcuts, isMac, kbd }) ?? {}),
    highlight: highlightTip,
  }
  const tipNode = t.rich(
    `tips.${tip.key}` as Parameters<typeof t.rich>[0],
    values as Parameters<typeof t.rich>[1]
  )

  return (
    <div className="flex max-w-full justify-center">
      <div className="flex max-w-full items-start gap-2 rounded-full border border-border/40 bg-muted/40 px-4 py-1.5 text-center text-xs text-muted-foreground/90">
        <span className="flex h-[1.375em] shrink-0 items-center">
          <Lightbulb aria-hidden className="h-3.5 w-3.5 text-primary" />
        </span>
        <p className="min-w-0 leading-snug">{tipNode}</p>
      </div>
    </div>
  )
}
