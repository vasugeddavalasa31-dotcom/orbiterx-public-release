"use client"

import type { ComponentProps, ReactNode } from "react"

import { useControllableState } from "@radix-ui/react-use-controllable-state"
import { useTranslations } from "next-intl"
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/instant-collapsible"
import { cn } from "@/lib/utils"
import { BrainIcon, ChevronRightIcon } from "lucide-react"
import {
  createContext,
  memo,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react"
import { Streamdown, defaultRemarkPlugins } from "streamdown"

import { ThinkingOrbIndicator } from "./thinking-orb"
import { markdownLinkComponents } from "./markdown-link"
import { normalizeMathDelimiters } from "./message"
import { remarkRewriteFileUriLinks } from "./remark-file-uri-links"
import { useStreamdownPlugins } from "./streamdown-plugins"

interface ReasoningContextValue {
  isStreaming: boolean
  isOpen: boolean
  setIsOpen: (open: boolean) => void
  duration: number | undefined
  expandable: boolean
}

const ReasoningContext = createContext<ReasoningContextValue | null>(null)

export const useReasoning = () => {
  const context = useContext(ReasoningContext)
  if (!context) {
    throw new Error("Reasoning components must be used within Reasoning")
  }
  return context
}

export type ReasoningProps = ComponentProps<typeof Collapsible> & {
  isStreaming?: boolean
  open?: boolean
  defaultOpen?: boolean
  onOpenChange?: (open: boolean) => void
  duration?: number
  expandable?: boolean
}

const AUTO_CLOSE_DELAY = 1000
const MS_IN_S = 1000

export const Reasoning = memo(
  ({
    className,
    isStreaming = false,
    open,
    defaultOpen,
    onOpenChange,
    duration: durationProp,
    expandable = true,
    children,
    ...props
  }: ReasoningProps) => {
    const resolvedDefaultOpen = expandable
      ? (defaultOpen ?? isStreaming)
      : false
    // Track if defaultOpen was explicitly set to false (to prevent auto-open)
    const isExplicitlyClosed = defaultOpen === false || !expandable

    const [isOpen, setIsOpen] = useControllableState<boolean>({
      defaultProp: resolvedDefaultOpen,
      onChange: onOpenChange,
      prop: expandable ? open : false,
    })
    const [duration, setDuration] = useControllableState<number | undefined>({
      defaultProp: undefined,
      prop: durationProp,
    })

    const hasEverStreamedRef = useRef(isStreaming)
    const [hasAutoClosed, setHasAutoClosed] = useState(false)
    const startTimeRef = useRef<number | null>(null)

    // Track when streaming starts and compute duration
    useEffect(() => {
      if (isStreaming) {
        hasEverStreamedRef.current = true
        if (startTimeRef.current === null) {
          startTimeRef.current = Date.now()
        }
      } else if (startTimeRef.current !== null) {
        setDuration(Math.ceil((Date.now() - startTimeRef.current) / MS_IN_S))
        startTimeRef.current = null
      }
    }, [isStreaming, setDuration])

    // Auto-open when streaming starts (unless explicitly closed)
    useEffect(() => {
      if (isStreaming && !isOpen && !isExplicitlyClosed) {
        setIsOpen(true)
      }
    }, [isStreaming, isOpen, setIsOpen, isExplicitlyClosed])

    // Auto-close when streaming ends (once only, and only if it ever streamed)
    useEffect(() => {
      if (
        hasEverStreamedRef.current &&
        !isStreaming &&
        isOpen &&
        !hasAutoClosed
      ) {
        const timer = setTimeout(() => {
          setIsOpen(false)
          setHasAutoClosed(true)
        }, AUTO_CLOSE_DELAY)

        return () => clearTimeout(timer)
      }
    }, [isStreaming, isOpen, setIsOpen, hasAutoClosed])

    const handleOpenChange = useCallback(
      (newOpen: boolean) => {
        setIsOpen(newOpen)
      },
      [setIsOpen]
    )

    const contextValue = useMemo(
      () => ({ duration, isOpen, isStreaming, setIsOpen, expandable }),
      [duration, isOpen, isStreaming, setIsOpen, expandable]
    )

    return (
      <ReasoningContext.Provider value={contextValue}>
        <Collapsible
          className={cn(
            "not-prose w-full overflow-hidden text-muted-foreground",
            className
          )}
          onOpenChange={handleOpenChange}
          open={isOpen}
          {...props}
        >
          {children}
        </Collapsible>
      </ReasoningContext.Provider>
    )
  }
)

export type ReasoningTriggerProps = ComponentProps<
  typeof CollapsibleTrigger
> & {
  getThinkingMessage?: (isStreaming: boolean, duration?: number) => ReactNode
}

export const ReasoningTrigger = memo(
  ({
    className,
    children,
    getThinkingMessage,
    ...props
  }: ReasoningTriggerProps) => {
    const t = useTranslations("Folder.chat.reasoning")
    const { isStreaming, isOpen, duration, expandable } = useReasoning()
    const defaultGetThinkingMessage = useCallback(
      (nextIsStreaming: boolean, nextDuration?: number) => {
        if (nextIsStreaming || nextDuration === 0) {
          return (
            <>
              <ThinkingOrbIndicator
                variant="working"
                size={20}
                label={t("thinking")}
              />
              <span>{t("thinking")}</span>
            </>
          )
        }
        if (nextDuration === undefined) {
          return <p>{t("thoughtForFewSeconds")}</p>
        }
        return <p>{t("thoughtForSeconds", { duration: nextDuration })}</p>
      },
      [t]
    )
    const thinkingMessageBuilder =
      getThinkingMessage ?? defaultGetThinkingMessage

    return (
      <CollapsibleTrigger
        className={cn(
          "flex w-full items-center gap-1.5 rounded-md px-1 py-1 text-left text-[13px] leading-5 text-muted-foreground transition-colors",
          expandable
            ? "hover:bg-muted/40 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1"
            : "cursor-default hover:text-muted-foreground",
          className
        )}
        disabled={!expandable}
        {...props}
      >
        {children ?? (
          <>
            <BrainIcon className="size-3.5 shrink-0" />
            {thinkingMessageBuilder(isStreaming, duration)}
            {expandable && (
              <ChevronRightIcon
                className={cn(
                  "size-3.5 shrink-0 transition-transform",
                  isOpen ? "rotate-90" : "rotate-0"
                )}
              />
            )}
          </>
        )}
      </CollapsibleTrigger>
    )
  }
)

export type ReasoningContentProps = ComponentProps<
  typeof CollapsibleContent
> & {
  children: string
}

const remarkPlugins = [
  ...Object.values(defaultRemarkPlugins),
  remarkRewriteFileUriLinks,
]

export const ReasoningContent = memo(
  ({ className, children, dir, ...props }: ReasoningContentProps) => {
    const normalized = useMemo(
      () => normalizeMathDelimiters(children),
      [children]
    )
    const plugins = useStreamdownPlugins(normalized)
    const validDir =
      dir === "auto" || dir === "ltr" || dir === "rtl" ? dir : undefined

    return (
      <CollapsibleContent
        className={cn(
          "px-1 pb-1 text-[13px] leading-6",
          "data-[state=closed]:fade-out-0 data-[state=closed]:slide-out-to-top-1 data-[state=open]:slide-in-from-top-1 text-muted-foreground outline-none data-[state=closed]:animate-out data-[state=open]:animate-in",
          className
        )}
        dir={dir}
        {...props}
      >
        <Streamdown
          plugins={plugins}
          remarkPlugins={remarkPlugins}
          dir={validDir}
          // Enforce the link icon + safety override after spreading props.
          components={markdownLinkComponents}
        >
          {normalized}
        </Streamdown>
      </CollapsibleContent>
    )
  }
)

Reasoning.displayName = "Reasoning"
ReasoningTrigger.displayName = "ReasoningTrigger"
ReasoningContent.displayName = "ReasoningContent"
