import { cn } from "@/lib/utils"

/**
 * OrbiterX brand mark: the portal glyph in a rounded square plus an optional
 * wordmark. Shared by the landing page and the standalone login page so the
 * two entry surfaces read as one brand.
 */
export function BrandMark({
  className,
  showWordmark = true,
  wordmarkClassName,
}: {
  className?: string
  showWordmark?: boolean
  wordmarkClassName?: string
}) {
  return (
    <span className={cn("inline-flex items-center gap-2.5", className)}>
      <span
        aria-hidden
        className="grid size-9 place-items-center rounded-xl bg-foreground text-background shadow-sm"
      >
        <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden>
          <rect
            x="3"
            y="3"
            width="14"
            height="14"
            rx="2"
            stroke="currentColor"
            strokeWidth="1.6"
          />
          <rect
            x="6.5"
            y="6.5"
            width="7"
            height="7"
            rx="1"
            fill="currentColor"
          />
        </svg>
      </span>
      {showWordmark && (
        <span
          className={cn(
            "text-lg font-semibold tracking-tight text-foreground",
            wordmarkClassName
          )}
        >
          Orbiter
          <span className="text-amber-500">X</span>
        </span>
      )}
    </span>
  )
}
