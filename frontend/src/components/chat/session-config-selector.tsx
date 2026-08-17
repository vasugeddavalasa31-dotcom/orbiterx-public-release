"use client"

import { Fragment } from "react"
import { ChevronDown } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { DropdownRadioItemContent } from "@/components/chat/dropdown-radio-item-content"
import type { ModelOptionGroup } from "@/lib/model-config-groups"
import type { SessionConfigOptionInfo } from "@/lib/types"

interface SessionConfigSelectorProps {
  option: SessionConfigOptionInfo
  onSelect: (configId: string, valueId: string) => void
  /**
   * Frontend-derived grouping for the model picker (split on the `provider/`
   * prefix). When provided, it overrides the option's own (flat) value list;
   * a group with `name === null` renders its options with no header. `null`
   * means "no grouping" — fall back to server groups, else the flat list.
   */
  derivedGroups?: ModelOptionGroup[] | null
}

/**
 * Tone mapping for the permission-mode selector: each level gets a distinct
 * accent so the user can tell at a glance how much power the agent has.
 * Keys are the wire `permission_mode` values; legacy labels from older
 * builds are folded onto their modern equivalents.
 */
const PERMISSION_TONES: Record<
  string,
  { dot: string; text: string; name: string }
> = {
  never: { dot: "bg-rose-500", text: "text-rose-500", name: "Full bypass" },
  full_auto: { dot: "bg-rose-500", text: "text-rose-500", name: "Full bypass" },
  untrusted: {
    dot: "bg-amber-500",
    text: "text-amber-500",
    name: "Ask every time",
  },
  default: {
    dot: "bg-amber-500",
    text: "text-amber-500",
    name: "Ask every time",
  },
  "on-request": {
    dot: "bg-sky-500",
    text: "text-sky-500",
    name: "Ask on request",
  },
  auto: { dot: "bg-sky-500", text: "text-sky-500", name: "Ask on request" },
  granular: { dot: "bg-violet-500", text: "text-violet-500", name: "Granular" },
  read_only: {
    dot: "bg-emerald-500",
    text: "text-emerald-500",
    name: "Read only",
  },
}

function permissionTone(value: string) {
  return PERMISSION_TONES[value] ?? null
}

export function InlineSessionConfigSelector({
  option,
  onSelect,
  derivedGroups,
}: SessionConfigSelectorProps) {
  if (option.kind.type !== "select") return null

  const isPermissionMode = option.id === "permission_mode"

  // Unified group list rendered in the dropdown body. Derived (model) groups
  // win; otherwise server-provided groups; otherwise `null` → flat options.
  // `name === null` is a headerless bucket (the leading prefix-less models).
  const renderGroups: ModelOptionGroup[] | null =
    derivedGroups && derivedGroups.length > 0
      ? derivedGroups
      : option.kind.groups.length > 0
        ? option.kind.groups.map((group) => ({
            key: group.group,
            name: group.name,
            options: group.options,
          }))
        : null

  // Resolve the trigger label against the *rendered* options so the selected
  // model shows its prefix-stripped name (its provider is already implied by
  // the group it sits in) rather than repeating `provider/`.
  const renderedOptions = renderGroups
    ? renderGroups.flatMap((group) => group.options)
    : option.kind.options
  const selected = renderedOptions.find(
    (item) => item.value === option.kind.current_value
  )
  const currentLabel = selected?.name ?? option.kind.current_value
  const currentTone = isPermissionMode
    ? permissionTone(option.kind.current_value)
    : null

  const renderOption = (item: {
    value: string
    name: string
    description?: string | null
  }) => {
    const tone = isPermissionMode ? permissionTone(item.value) : null
    return (
      <div className="flex min-w-0 items-start gap-2">
        {tone && (
          <span
            className={`mt-1.5 size-2 shrink-0 rounded-full ${tone.dot}`}
            aria-hidden
          />
        )}
        <DropdownRadioItemContent
          label={item.name}
          description={item.description}
        />
      </div>
    )
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="xs"
          title={option.name}
          aria-label={
            currentLabel ? `${option.name}: ${currentLabel}` : option.name
          }
          className="min-w-0 gap-0.5 px-1 text-muted-foreground"
        >
          {currentTone && (
            <span
              className={`size-1.5 shrink-0 rounded-full ${currentTone.dot}`}
              aria-hidden
            />
          )}
          <span
            className={`max-w-[10rem] truncate ${
              currentTone ? currentTone.text : ""
            }`}
          >
            {currentLabel}
          </span>
          <ChevronDown className="size-3 shrink-0 text-muted-foreground" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        side="top"
        align="start"
        className="min-w-72 overflow-y-auto"
        style={{
          maxWidth: "min(20rem, calc(100vw - 1rem))",
          maxHeight:
            "min(60vh, var(--radix-dropdown-menu-content-available-height))",
        }}
      >
        <DropdownMenuRadioGroup
          value={option.kind.current_value}
          onValueChange={(value) => onSelect(option.id, value)}
        >
          {renderGroups
            ? renderGroups.map((group, index) => (
                <Fragment key={group.key}>
                  {index > 0 && <DropdownMenuSeparator />}
                  {group.name !== null && (
                    <DropdownMenuLabel>{group.name}</DropdownMenuLabel>
                  )}
                  {group.options.map((item) => (
                    <DropdownMenuRadioItem
                      key={`${group.key}-${item.value}`}
                      value={item.value}
                      title={item.name}
                    >
                      {renderOption(item)}
                    </DropdownMenuRadioItem>
                  ))}
                </Fragment>
              ))
            : option.kind.options.map((item) => (
                <DropdownMenuRadioItem
                  key={item.value}
                  value={item.value}
                  title={item.name}
                >
                  {renderOption(item)}
                </DropdownMenuRadioItem>
              ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
