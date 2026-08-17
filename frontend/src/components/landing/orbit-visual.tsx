import { cn } from "@/lib/utils"

/**
 * Pure-CSS orbital system: concentric rings around a glowing core, with
 * satellites tracing different radii and speeds (keyframes live in
 * globals.css and honor prefers-reduced-motion). Decorative only.
 */
export function OrbitVisual({ className }: { className?: string }) {
  return (
    <div
      aria-hidden
      className={cn(
        "pointer-events-none relative aspect-square select-none",
        className
      )}
    >
      {/* Core */}
      <div className="absolute left-1/2 top-1/2 grid size-14 -translate-x-1/2 -translate-y-1/2 place-items-center rounded-2xl border border-border bg-card shadow-lg">
        <span className="size-3 rounded-full bg-amber-500 shadow-[0_0_18px_rgba(245,158,11,0.65)]" />
      </div>

      {/* Rings */}
      <div className="absolute inset-0 rounded-full border border-foreground/10" />
      <div className="absolute inset-[13%] rounded-full border border-dashed border-foreground/10" />
      <div className="absolute inset-[27%] rounded-full border border-amber-500/20" />

      {/* Satellites */}
      <div className="absolute inset-[13%] animate-orbit-slow">
        <span className="absolute -top-1 left-1/2 size-2 -translate-x-1/2 rounded-full bg-amber-500 shadow-[0_0_10px_rgba(245,158,11,0.8)]" />
      </div>
      <div className="absolute inset-[27%] animate-orbit-reverse">
        <span className="absolute -right-1 top-1/2 size-2.5 -translate-y-1/2 rounded-full bg-foreground/60" />
      </div>
      <div className="absolute inset-0 animate-orbit-fast">
        <span className="absolute -bottom-1 left-1/2 size-1.5 -translate-x-1/2 rounded-full bg-amber-400" />
      </div>
    </div>
  )
}
