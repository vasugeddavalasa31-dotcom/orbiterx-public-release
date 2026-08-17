import Link from "next/link"
import { useTranslations } from "next-intl"
import {
  ArrowRight,
  FileDiff,
  Orbit,
  PanelsRightBottom,
  Puzzle,
  Radio,
  ShieldCheck,
  Workflow,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { BrandMark } from "@/components/landing/brand-mark"
import { OrbitVisual } from "@/components/landing/orbit-visual"
import { useState } from "react"
import { beginOrbiterxOAuth } from "@/lib/auth-oauth"

const FEATURES = [
  {
    icon: Workflow,
    titleKey: "featureParallelTitle",
    descKey: "featureParallelDesc",
  },
  {
    icon: Radio,
    titleKey: "featureLiveTitle",
    descKey: "featureLiveDesc",
  },
  {
    icon: FileDiff,
    titleKey: "featureDiffsTitle",
    descKey: "featureDiffsDesc",
  },
  {
    icon: PanelsRightBottom,
    titleKey: "featureTabsTitle",
    descKey: "featureTabsDesc",
  },
  {
    icon: ShieldCheck,
    titleKey: "featureSecureTitle",
    descKey: "featureSecureDesc",
  },
  {
    icon: Puzzle,
    titleKey: "featureSkillsTitle",
    descKey: "featureSkillsDesc",
  },
] as const

const STEPS = [
  { titleKey: "howStep1Title", descKey: "howStep1Desc" },
  { titleKey: "howStep2Title", descKey: "howStep2Desc" },
  { titleKey: "howStep3Title", descKey: "howStep3Desc" },
] as const

/**
 * Public landing page shown to web users before they authenticate. The auth
 * gate lives in app/page.tsx — this component is pure presentation.
 */
export function LandingPage() {
  const t = useTranslations("LandingPage")
  const year = new Date().getFullYear()
  const [signingIn, setSigningIn] = useState(false)

  async function handleSignIn() {
    if (signingIn) return
    setSigningIn(true)
    try {
      window.location.href = await beginOrbiterxOAuth()
    } catch {
      setSigningIn(false)
    }
  }

  return (
    <div className="relative min-h-screen overflow-x-clip bg-background text-foreground">
      {/* Faint orbit backdrop spanning the hero */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 flex justify-center"
      >
        <OrbitVisual className="size-[44rem] opacity-[0.06]" />
      </div>

      {/* ── Nav ─────────────────────────────────────────────────────────── */}
      <header className="sticky top-0 z-50 border-b bg-background/80 backdrop-blur-md">
        <nav className="mx-auto flex h-16 max-w-6xl items-center justify-between px-6">
          <Link href="/" aria-label="OrbiterX home">
            <BrandMark />
          </Link>
          <div className="hidden items-center gap-8 text-sm text-muted-foreground sm:flex">
            <a
              href="#features"
              className="transition-colors hover:text-foreground"
            >
              {t("navFeatures")}
            </a>
            <a
              href="#how-it-works"
              className="transition-colors hover:text-foreground"
            >
              {t("navHowItWorks")}
            </a>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={handleSignIn}
            disabled={signingIn}
          >
            {t("navSignIn")}
          </Button>
        </nav>
      </header>

      {/* ── Hero ────────────────────────────────────────────────────────── */}
      <section className="relative px-6 pb-20 pt-16 sm:pt-24">
        <div className="relative mx-auto max-w-3xl text-center">
          <span className="inline-flex items-center gap-1.5 rounded-full border border-amber-500/30 bg-amber-500/10 px-3 py-1 text-xs font-medium text-amber-600 dark:text-amber-400">
            <Orbit className="size-3.5" aria-hidden />
            {t("badge")}
          </span>

          <OrbitVisual className="mx-auto mt-10 size-48 sm:mt-14 sm:size-60" />

          <h1 className="mt-10 text-5xl font-semibold leading-[1.05] tracking-tighter sm:text-7xl">
            {t("heroTitle")}
            <br />
            <span className="text-amber-500">{t("heroTitleAccent")}</span>
          </h1>

          <p className="mx-auto mt-6 max-w-xl text-base text-muted-foreground sm:text-lg">
            {t("heroSubtitle")}
          </p>

          <div className="mt-10 flex flex-col items-center justify-center gap-4 sm:flex-row">
            <Button
              size="lg"
              className="h-12 px-6"
              onClick={handleSignIn}
              disabled={signingIn}
            >
              {t("heroCta")}
              <ArrowRight data-icon="inline-end" aria-hidden />
            </Button>
          </div>
          <p className="mt-3 text-xs text-muted-foreground">{t("heroHint")}</p>

          <div className="mt-12 flex flex-wrap items-center justify-center gap-2">
            {[t("chipLive"), t("chipParallel"), t("chipDiffs")].map((chip) => (
              <span
                key={chip}
                className="inline-flex items-center gap-1.5 rounded-full border bg-card px-3 py-1 text-xs text-muted-foreground"
              >
                <span
                  className="size-1.5 rounded-full bg-amber-500"
                  aria-hidden
                />
                {chip}
              </span>
            ))}
          </div>
        </div>
      </section>

      {/* ── Features ────────────────────────────────────────────────────── */}
      <section id="features" className="scroll-mt-20 px-6 py-20 sm:py-24">
        <div className="mx-auto max-w-6xl">
          <div className="mx-auto max-w-2xl text-center">
            <h2 className="text-3xl font-semibold tracking-tight sm:text-4xl">
              {t("featureTitle")}
            </h2>
            <p className="mt-3 text-muted-foreground">{t("featureSubtitle")}</p>
          </div>

          <div className="mt-14 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {FEATURES.map(({ icon: Icon, titleKey, descKey }) => (
              <div
                key={titleKey}
                className="group rounded-2xl border bg-card p-6 transition-colors hover:border-amber-500/40"
              >
                <span className="grid size-10 place-items-center rounded-xl bg-amber-500/10 text-amber-600 transition-colors group-hover:bg-amber-500/20 dark:text-amber-400">
                  <Icon className="size-5" aria-hidden />
                </span>
                <h3 className="mt-4 font-medium">{t(titleKey)}</h3>
                <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
                  {t(descKey)}
                </p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── How it works ────────────────────────────────────────────────── */}
      <section
        id="how-it-works"
        className="scroll-mt-20 border-t bg-muted/30 px-6 py-20 sm:py-24"
      >
        <div className="mx-auto max-w-5xl">
          <div className="mx-auto max-w-2xl text-center">
            <h2 className="text-3xl font-semibold tracking-tight sm:text-4xl">
              {t("howTitle")}
            </h2>
          </div>

          <div className="mt-14 grid gap-12 lg:grid-cols-3 lg:gap-0">
            {STEPS.map(({ titleKey, descKey }, i) => (
              <div key={titleKey} className="relative lg:px-10">
                <div className="flex items-center gap-3">
                  <span className="grid size-10 shrink-0 place-items-center rounded-full border border-amber-500/40 bg-amber-500/10 text-sm font-semibold text-amber-600 dark:text-amber-400">
                    {String(i + 1).padStart(2, "0")}
                  </span>
                  {i < STEPS.length - 1 && (
                    <span
                      aria-hidden
                      className="hidden h-px flex-1 bg-gradient-to-r from-amber-500/40 to-transparent lg:block"
                    />
                  )}
                </div>
                <h3 className="mt-5 font-medium">{t(titleKey)}</h3>
                <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
                  {t(descKey)}
                </p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── CTA ─────────────────────────────────────────────────────────── */}
      <section className="px-6 py-20 sm:py-24">
        <div className="mx-auto max-w-5xl overflow-hidden rounded-3xl border bg-foreground px-8 py-14 text-center text-background shadow-xl">
          <h2 className="text-3xl font-semibold tracking-tight sm:text-4xl">
            {t("ctaTitle")}
          </h2>
          <p className="mx-auto mt-3 max-w-xl text-background/70">
            {t("ctaDesc")}
          </p>
          <Button
            size="lg"
            className="mt-8 h-12 bg-amber-500 px-6 text-amber-950 hover:bg-amber-400"
            onClick={handleSignIn}
            disabled={signingIn}
          >
            {t("ctaButton")}
            <ArrowRight data-icon="inline-end" aria-hidden />
          </Button>
        </div>
      </section>

      {/* ── Footer ──────────────────────────────────────────────────────── */}
      <footer className="border-t px-6 py-10">
        <div className="mx-auto flex max-w-6xl flex-col items-center justify-between gap-4 text-center sm:flex-row sm:text-left">
          <BrandMark />
          <p className="text-sm text-muted-foreground">{t("footerTagline")}</p>
          <p className="text-xs text-muted-foreground">
            {t("footerRights", { year })}
          </p>
        </div>
      </footer>
    </div>
  )
}
