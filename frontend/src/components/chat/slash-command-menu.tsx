"use client"

import { useEffect, useRef } from "react"
import {
  Activity,
  ClipboardList,
  Command,
  Copy,
  Cpu,
  Diff,
  GitFork,
  PenLine,
  Plug,
  SearchCheck,
  Shield,
  Shrink,
  Smile,
  Sparkles,
  Target,
  type LucideIcon,
} from "lucide-react"
import { cn } from "@/lib/utils"
import type { AvailableCommandInfo } from "@/lib/types"

interface SlashCommandMenuProps {
  commands: AvailableCommandInfo[]
  selectedIndex: number
  onSelect: (command: AvailableCommandInfo) => void
}

/** Icon per slash command name (mirrors the TUI's command set). Falls back to
 *  a generic command glyph for unknown names. */
const COMMAND_ICONS: Record<string, LucideIcon> = {
  goal: Target,
  review: SearchCheck,
  compact: Shrink,
  status: Activity,
  model: Cpu,
  personality: Smile,
  permissions: Shield,
  plan: ClipboardList,
  skills: Sparkles,
  mcp: Plug,
  diff: Diff,
  rename: PenLine,
  fork: GitFork,
  copy: Copy,
}

function CommandIcon({ name }: { name: string }) {
  const Icon = COMMAND_ICONS[name] ?? Command
  return <Icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
}

export function SlashCommandMenu({
  commands,
  selectedIndex,
  onSelect,
}: SlashCommandMenuProps) {
  const listRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const el = listRef.current?.children[selectedIndex] as
      HTMLElement | undefined
    el?.scrollIntoView({ block: "nearest" })
  }, [selectedIndex])

  if (commands.length === 0) return null

  return (
    <div
      ref={listRef}
      className="absolute bottom-full left-0 right-0 mb-1 z-50 max-h-48 overflow-y-auto rounded-xl border border-border bg-popover p-1 shadow-lg"
    >
      {commands.map((cmd, i) => (
        <button
          key={cmd.name}
          type="button"
          className={cn(
            "flex w-full items-start gap-2 rounded-lg px-3 py-2 text-left text-sm",
            i === selectedIndex
              ? "bg-accent text-accent-foreground"
              : "hover:bg-muted"
          )}
          onMouseDown={(e) => {
            e.preventDefault()
            onSelect(cmd)
          }}
        >
          <CommandIcon name={cmd.name} />
          <span className="shrink-0 font-mono text-primary">/{cmd.name}</span>
          <span className="truncate text-xs text-muted-foreground">
            {cmd.description}
          </span>
        </button>
      ))}
    </div>
  )
}
