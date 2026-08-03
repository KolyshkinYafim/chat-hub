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

./node_modules/.bin/electron-builder "${TARGET[@]}"

# electron-builder suffixes the output dir with the arch it built for.
case "$(uname -m)" in
  arm64) APP="${ROOT}/release/mac-arm64/Chat Hub.app" ;;
  *)     APP="${ROOT}/release/mac/Chat Hub.app" ;;
esac
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

echo "Built ${APP}"
echo "  ${VERSION} · ${COMMIT} · ${BUILD_DATE}"
