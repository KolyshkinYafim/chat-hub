#!/usr/bin/env bash
#
# Build "Chat Hub.app" with a real build identity (version + commit) baked in,
# so a packaged app can always be traced back to the tree it came from.
# Default target is an unpacked .app; pass --dmg for a disk image.
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${ROOT}"

TARGET=(--mac --dir)
[[ "${1:-}" == "--dmg" ]] && TARGET=(--mac dmg)

VERSION="$(node -p "require('./package.json').version")"
BUILD_DATE="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
if COMMIT="$(git rev-parse --short HEAD 2>/dev/null)"; then
  # Untracked files count as dirty too: the question this answers is "does the
  # installed app match my tree right now", not "which commit was checked out".
  [[ -n "$(git status --porcelain 2>/dev/null)" ]] && COMMIT="${COMMIT}-dirty"
else
  COMMIT="nogit"
fi

# The repo lives under an iCloud-synced Desktop, which resolves a sync race by
# leaving "<name> 2" copies behind. In node_modules those are broken duplicates
# of pnpm's symlinks, and electron-builder's dependency walk dies on the first
# one it stats ("ENOENT ... @babel/core 2"). Cheap to sweep, fatal to skip.
STRAYS="$(find node_modules -name '* [0-9]' 2>/dev/null | wc -l | tr -d ' ')"
if [[ "${STRAYS}" != "0" ]]; then
  echo "Removing ${STRAYS} iCloud conflict copies from node_modules..."
  find node_modules -name '* [0-9]' -print0 2>/dev/null | xargs -0 rm -rf
fi

echo "Building Chat Hub ${VERSION} (${COMMIT})..."
./node_modules/.bin/electron-vite build

# Written after the bundle: electron-vite empties out/ on every build, and
# electron-builder ships out/**/* so this file rides along inside the asar.
cat > out/build-info.json <<JSON
{
  "version": "${VERSION}",
  "commit": "${COMMIT}",
  "builtAt": "${BUILD_DATE}"
}
JSON

# Deliberately outside the repo. This tree lives on an iCloud-synced Desktop,
# where the file provider re-stamps every directory it touches with
# com.apple.FinderInfo within seconds — and codesign rejects that as "resource
# fork, Finder information, or similar detritus not allowed", both while signing
# and on every later `codesign --verify`. `xattr -cr` loses that race by design,
# so the bundle is built and signed on a filesystem nobody is syncing.
OUT_DIR="${CHAT_HUB_OUT_DIR:-${TMPDIR:-/tmp}/chat-hub-release}"
mkdir -p "${OUT_DIR}"

./node_modules/.bin/electron-builder "${TARGET[@]}" \
  -c.directories.output="${OUT_DIR}"

# electron-builder suffixes the output dir with the arch it built for.
case "$(uname -m)" in
  arm64) ARCH_DIR="mac-arm64" ;;
  *)     ARCH_DIR="mac" ;;
esac
APP="${OUT_DIR}/${ARCH_DIR}/Chat Hub.app"
[[ -d "${APP}" ]] || { echo "Build produced no app at ${APP}" >&2; exit 1; }

# Info.plist is the one place the identity stays readable without unpacking the
# asar — packaging/app-status.sh reads exactly these keys back.
PLIST="${APP}/Contents/Info.plist"
for entry in "AgentDesktopBuildCommit:${COMMIT}" "AgentDesktopBuildDate:${BUILD_DATE}"; do
  key="${entry%%:*}"
  value="${entry#*:}"
  /usr/libexec/PlistBuddy -c "Delete :${key}" "${PLIST}" 2>/dev/null || true
  /usr/libexec/PlistBuddy -c "Add :${key} string ${value}" "${PLIST}"
done

# Signing comes last, after the Info.plist edits above — codesign seals the
# bundle, and any byte written afterwards invalidates the signature it just made.
#
# electron-builder is told `identity: null`, so the app arrives carrying only the
# linker's ad-hoc signature, which fails `codesign --verify` ("code has no
# resources but signature indicates they must be present") and makes macOS call
# the app damaged the moment it is zipped or AirDropped. Signing ad-hoc here
# fixes that without a certificate. Hardened runtime stays off — it only means
# something with a Developer ID and notarization.
#
# Cheap insurance: electron-builder copies from node_modules, which *is* synced,
# so a stray xattr can still ride in on a nested framework.
echo "Signing (ad-hoc)..."
xattr -cr "${APP}"
codesign --force --deep --sign - "${APP}"
codesign --verify --deep --strict "${APP}"

# release/mac-arm64 stays the address everything else knows — install-app.sh, the
# README, muscle memory — it is just a pointer now. A symlink and not a copy on
# purpose: a copy back into the synced tree would grow the same FinderInfo again
# and stop verifying within seconds of being made. The link goes *inside*
# release/ rather than replacing it, because .gitignore ignores `release/` as a
# directory and a symlink in its place would show up as an untracked file.
mkdir -p "${ROOT}/release"
rm -rf "${ROOT}/release/${ARCH_DIR}"
ln -s "${OUT_DIR}/${ARCH_DIR}" "${ROOT}/release/${ARCH_DIR}"

echo "Built ${APP}"
echo "  ${VERSION} · ${COMMIT} · ${BUILD_DATE}"
echo "  signed ad-hoc · verifies · release/${ARCH_DIR} -> ${OUT_DIR}/${ARCH_DIR}"
