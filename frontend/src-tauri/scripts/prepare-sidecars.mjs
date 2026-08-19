#!/usr/bin/env node
//
// Prepare Tauri sidecars before `tauri build` / `tauri dev` consume them.
//
// What it does:
//   1. Resolves the target triple — `--target <triple>` arg, or
//      `TAURI_TARGET_TRIPLE` env, or the host's `rustc -vV` host triple.
//   2. Runs `cargo build --release --bin codeg-mcp --no-default-features`
//      for that triple from `src-tauri/`.
//   3. Copies the produced binary to
//      `src-tauri/binaries/codeg-mcp-<triple>{.exe}` so Tauri's externalBin
//      bundler picks it up under the bare name `codeg-mcp` at install time.
//
// Why a separate script (not inline in beforeBuildCommand / GitHub Actions):
//   - Cross-compile in release.yml passes `--target <triple>` so we honour
//     the matrix triple rather than rebuilding for the host.
//   - Local `pnpm tauri dev` / `pnpm tauri build` invoke it without args and
//     get a host-triple build, so the externalBin lookup still finds a file.
//   - Skippable: set `CODEG_SKIP_SIDECAR=1` when iterating on the frontend
//     and you don't care about delegation.
//
// Intentionally Node-only (no shell): runs identically on macOS, Linux,
// Windows GitHub runners.

import { execFileSync } from "node:child_process"
import { existsSync, copyFileSync, mkdirSync, chmodSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import process from "node:process"

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
const SRC_TAURI = resolve(SCRIPT_DIR, "..")
const BINARIES_DIR = join(SRC_TAURI, "binaries")
const REPO_ROOT = resolve(SRC_TAURI, "..", "..")
const BIN_NAME = "codeg-mcp"
const APP_SERVER_BIN = "orbiterx-app-server"

function log(msg) {
  console.log(`[prepare-sidecars] ${msg}`)
}

function die(msg) {
  console.error(`[prepare-sidecars][ERROR] ${msg}`)
  process.exit(1)
}

function parseArgs(argv) {
  const args = { target: null }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === "--target" && argv[i + 1]) {
      args.target = argv[++i]
    } else if (a.startsWith("--target=")) {
      args.target = a.slice("--target=".length)
    }
  }
  return args
}

function resolveHostTriple() {
  try {
    const out = execFileSync("rustc", ["-vV"], { encoding: "utf8" })
    const line = out.split(/\r?\n/).find((l) => l.startsWith("host:"))
    if (!line) throw new Error("rustc -vV missing host: line")
    return line.replace(/^host:\s*/, "").trim()
  } catch (e) {
    die(`cannot determine host triple via rustc -vV: ${e.message}`)
  }
}

function main() {
  if (process.env.CODEG_SKIP_SIDECAR === "1") {
    log("CODEG_SKIP_SIDECAR=1 — skipping sidecar preparation")
    return
  }

  const { target: cliTarget } = parseArgs(process.argv.slice(2))
  const target =
    cliTarget || process.env.TAURI_TARGET_TRIPLE || resolveHostTriple()
  const isWindows = target.includes("windows")
  const ext = isWindows ? ".exe" : ""

  log(`target triple: ${target}`)
  log(`building ${BIN_NAME} (--release --no-default-features)`)

  // cargo build needs to run from src-tauri so it resolves the local manifest
  // and shares the swatinem/rust-cache key with other cargo invocations.
  // `--no-default-features` keeps codeg-mcp free of the Tauri runtime deps —
  // the bin's required-features is empty, so this just enables cross-compile
  // without dragging in macOS-private-api / Linux WebKit / Windows WebView2.
  execFileSync(
    "cargo",
    [
      "build",
      "--release",
      "--bin",
      BIN_NAME,
      "--no-default-features",
      "--target",
      target,
    ],
    { stdio: "inherit", cwd: SRC_TAURI }
  )

  const targetDir =
    process.env.CARGO_TARGET_DIR || join(REPO_ROOT, "target")

  const candidateBuiltPaths = [
    join(targetDir, target, "release", `${BIN_NAME}${ext}`),
    join(targetDir, "release", `${BIN_NAME}${ext}`),
    join(SRC_TAURI, "target", target, "release", `${BIN_NAME}${ext}`),
    join(SRC_TAURI, "target", "release", `${BIN_NAME}${ext}`),
  ]

  const built = candidateBuiltPaths.find((p) => existsSync(p))
  if (!built) {
    die(
      `expected ${BIN_NAME}${ext} after cargo build, but could not find in:\n${candidateBuiltPaths.join("\n")}`
    )
  }

  mkdirSync(BINARIES_DIR, { recursive: true })
  const dest = join(BINARIES_DIR, `${BIN_NAME}-${target}${ext}`)
  copyFileSync(built, dest)
  if (!isWindows) {
    // copyFileSync preserves modes on POSIX, but be explicit for tarball
    // sources that may strip the +x bit.
    chmodSync(dest, 0o755)
  }
  log(`sidecar staged at ${dest}`)

  // ── orbiterx-app-server ───────────────────────────────────────────────
  // The conversation engine the desktop UI talks to over
  // ws://127.0.0.1:3001. Dev starts it separately via start.sh; the packaged
  // DMG bundles it as a sidecar so the app can spawn it on launch.
  const appServerDir = join(REPO_ROOT, "orbiterx-rs", "app-server")
  log(`building ${APP_SERVER_BIN} (--release)`)
  execFileSync(
    "cargo",
    ["build", "--release", "--bin", APP_SERVER_BIN, "--target", target],
    { stdio: "inherit", cwd: appServerDir }
  )

  const candidateAppServerPaths = [
    join(targetDir, target, "release", `${APP_SERVER_BIN}${ext}`),
    join(targetDir, "release", `${APP_SERVER_BIN}${ext}`),
    join(REPO_ROOT, "orbiterx-rs", "target", target, "release", `${APP_SERVER_BIN}${ext}`),
    join(REPO_ROOT, "orbiterx-rs", "target", "release", `${APP_SERVER_BIN}${ext}`),
  ]

  const appServerBuilt = candidateAppServerPaths.find((p) => existsSync(p))
  if (!appServerBuilt) {
    die(
      `expected ${APP_SERVER_BIN}${ext} after cargo build, but could not find in:\n${candidateAppServerPaths.join("\n")}`
    )
  }
  const appServerDest = join(
    BINARIES_DIR,
    `${APP_SERVER_BIN}-${target}${ext}`
  )
  copyFileSync(appServerBuilt, appServerDest)
  if (!isWindows) {
    chmodSync(appServerDest, 0o755)
  }
  log(`sidecar staged at ${appServerDest}`)
}

main()
