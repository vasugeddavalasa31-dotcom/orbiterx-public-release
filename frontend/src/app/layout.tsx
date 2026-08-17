import type { Metadata, Viewport } from "next"
import "katex/dist/katex.min.css"
import "./globals.css"
import { NextIntlClientProvider } from "next-intl"
import { AppI18nProvider } from "@/components/i18n-provider"
import { getMessagesForLocale } from "@/i18n/messages"
import { resolveRequestLocale } from "@/i18n/resolve-request-locale"
import { ThemeProvider } from "@/components/theme-provider"
import { toIntlLocale } from "@/lib/i18n"
import { APPEARANCE_INIT_SCRIPT } from "@/lib/appearance-script"
import { AppearanceProvider } from "@/components/appearance-provider"
import { OverlayScrollbarsInit } from "@/components/overlay-scrollbars-init"
import { ClipboardFallbackInit } from "@/components/clipboard-fallback-init"
import { WebConnectionGuard } from "@/components/connection/web-connection-guard"
import { AuthGate } from "@/components/auth/auth-gate"
import { WindowResizeGrips } from "@/components/layout/window-resize-grips"

import Script from "next/script"

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
}

export const metadata: Metadata = {
  title: "orbiterx",
  description: "AI Coding Agent Conversation Manager",
  icons: {
    icon: [
      { url: "/icon-32x32.png", sizes: "32x32", type: "image/png" },
      { url: "/icon.svg", type: "image/svg+xml" },
    ],
    apple: { url: "/icon-128x128.png", sizes: "128x128", type: "image/png" },
  },
}

export default async function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  const appLocale = await resolveRequestLocale()
  const initialLocale = toIntlLocale(appLocale)
  const initialMessages = await getMessagesForLocale(appLocale)

  return (
    <html lang={initialLocale} suppressHydrationWarning>
      <head>
        {/* CSS-only dark background: applies before JS executes, preventing white flash in dark mode */}
        <style
          dangerouslySetInnerHTML={{
            __html: `@media(prefers-color-scheme:dark){html:not(.light){background-color:#09090b;color-scheme:dark}}`,
          }}
        />
        {/* Apply appearance preferences (theme color + zoom + dark class) before first paint to prevent FOUC */}
        <Script
          id="appearance-init"
          strategy="beforeInteractive"
          dangerouslySetInnerHTML={{ __html: APPEARANCE_INIT_SCRIPT }}
        />
        {/* Suppress benign ResizeObserver loop warnings (W3C spec §3.3) */}
        <Script
          id="resize-observer-suppress"
          strategy="beforeInteractive"
          dangerouslySetInnerHTML={{
            __html: `window.addEventListener("error",function(e){if(e.message&&e.message.indexOf("ResizeObserver")!==-1){e.stopImmediatePropagation();e.preventDefault()}});window.onerror=function(m){if(typeof m==="string"&&m.indexOf("ResizeObserver")!==-1)return true}`,
          }}
        />
        {/* Silence verbose ACP debug logs */}
        <Script
          id="silence-acp-debug"
          strategy="beforeInteractive"
          dangerouslySetInnerHTML={{
            __html: `
              (function() {
                function isAcpDebugMessage(value) {
                  return typeof value === "string" && (
                    value.indexOf("[ACP-TRACE]") !== -1 ||
                    value.indexOf("[ACP-DEBUG") !== -1 ||
                    value.indexOf("[OrbiterX-TRACE]") !== -1
                  );
                }
                var orgLog = console.log;
                var orgWarn = console.warn;
                var orgError = console.error;
                console.log = function() {
                  if (isAcpDebugMessage(arguments[0])) return;
                  orgLog.apply(console, arguments);
                };
                console.warn = function() {
                  if (isAcpDebugMessage(arguments[0])) return;
                  orgWarn.apply(console, arguments);
                };
                console.error = function() {
                  if (isAcpDebugMessage(arguments[0])) return;
                  orgError.apply(console, arguments);
                };
              })();
            `,
          }}
        />
        {/* Forward webview console errors to ui.log so the packaged DMG (no dev
            console) can be debugged. Only active inside Tauri; no-op in browser. */}
        <Script
          id="ui-log-bridge"
          strategy="beforeInteractive"
          dangerouslySetInnerHTML={{
            __html: `
              (function() {
                if (!("__TAURI_INTERNALS__" in window)) return;
                function fmt(a) {
                  try { return a.map(function(v){ return typeof v === "string" ? v : (v instanceof Error ? (v.stack || v.message || String(v)) : (function(){ try { return JSON.stringify(v); } catch(e){ return String(v); } })()) }).join(" "); } catch(e){ return String(a); }
                }
                var orgError = console.error;
                var orgWarn = console.warn;
                function forward(kind, args) {
                  try {
                    if (window.__TAURI_INTERNALS__ && typeof window.__TAURI_INTERNALS__.invoke === "function") {
                      window.__TAURI_INTERNALS__.invoke("log_ui", { message: "[" + kind + "] " + fmt(Array.prototype.slice.call(args)) }).catch(function(){});
                    }
                  } catch(e) {}
                }
                console.error = function() { forward("error", arguments); orgError.apply(console, arguments); };
                console.warn = function() { forward("warn", arguments); orgWarn.apply(console, arguments); };
                window.addEventListener("error", function(e) { forward("uncaught", [e.message, e.filename, e.lineno]); });
                window.addEventListener("unhandledrejection", function(e) { forward("unhandledrejection", [String(e.reason)]); });
              })();
            `,
          }}
        />
      </head>
      <body>
        <NextIntlClientProvider
          locale={initialLocale}
          messages={initialMessages}
        >
          <AppI18nProvider
            initialLocale={initialLocale}
            initialMessages={initialMessages}
          >
            <ThemeProvider
              attribute="class"
              defaultTheme="system"
              enableSystem
              disableTransitionOnChange
            >
              <AppearanceProvider>
                <OverlayScrollbarsInit />
                <ClipboardFallbackInit />
                <WebConnectionGuard />
                <AuthGate />
                <WindowResizeGrips />
                {children}
              </AppearanceProvider>
            </ThemeProvider>
          </AppI18nProvider>
        </NextIntlClientProvider>
      </body>
    </html>
  )
}
