#!/usr/bin/env bash
set -e

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$DIR"

GREEN='\033[0;32m'
PURPLE='\033[0;35m'
CYAN='\033[0;36m'
RED='\033[0;31m'
NC='\033[0m'

DIST_DIR="$DIR/distribution"

echo -e "${PURPLE}🛰️  Building OrbiterX beta DMG...${NC}"

# Distribution folder where the finished DMG lands.
mkdir -p "$DIST_DIR"

# Sanity checks: the release pipeline needs Node tooling + Rust toolchain.
for cmd in pnpm cargo rustc; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo -e "${RED}❌ Missing required command: ${cmd}${NC}"
    exit 1
  fi
done

# 1. Build the desktop app. `tauri build` runs the configured
#    beforeBuildCommand (`pnpm tauri:before-build`), which prepares the
#    codeg-mcp sidecar binary and builds the frontend static export, then
#    compiles the release app and bundles the DMG.
echo -e "${GREEN}📦 Building frontend + Tauri app (this takes a while)...${NC}"
if [ -n "${TAURI_SIGNING_PRIVATE_KEY:-}" ]; then
  (
    cd frontend
    pnpm tauri build
  )
else
  echo -e "${CYAN}ℹ️  TAURI_SIGNING_PRIVATE_KEY is not set — building without updater artifact signing.${NC}"
  echo -e "${CYAN}   Set it (plus TAURI_SIGNING_PRIVATE_KEY_PASSWORD if needed) to also produce signed updater artifacts.${NC}"
  (
    cd frontend
    pnpm tauri build --config '{"bundle":{"createUpdaterArtifacts":false}}'
  )
fi

# 2. Pick the newest DMG produced by the bundle step.
DMG="$(ls -t frontend/src-tauri/target/release/bundle/dmg/*.dmg 2>/dev/null | head -1 || true)"
if [ -z "$DMG" ]; then
  echo -e "${RED}❌ No DMG was produced — check the build output above.${NC}"
  exit 1
fi

# 3. Copy the DMG into distribution/ so every beta build is easy to find.
cp "$DMG" "$DIST_DIR/"

echo ""
echo -e "${GREEN}✅ Beta build complete:${NC}"
echo -e "${GREEN}   ${DIST_DIR}/$(basename "$DMG")${NC}"
echo -e "${GREEN}   Size: $(du -h "${DIST_DIR}/$(basename "$DMG")" | cut -f1)${NC}"
