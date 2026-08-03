#!/usr/bin/env bash
#
# Answer "does /Applications/Chat Hub.app match this working tree?".
# Exits non-zero when it does not, so it can gate a script.
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PLIST="/Applications/Chat Hub.app/Contents/Info.plist"

if [[ ! -f "${PLIST}" ]]; then
  echo "✗ Not installed — run ${ROOT}/packaging/install-app.sh"
  exit 1
fi

read_key() { /usr/libexec/PlistBuddy -c "Print :$1" "${PLIST}" 2>/dev/null || echo "unknown"; }

INSTALLED_VERSION="$(read_key CFBundleShortVersionString)"
INSTALLED_COMMIT="$(read_key AgentDesktopBuildCommit)"
INSTALLED_DATE="$(read_key AgentDesktopBuildDate)"

if TREE_COMMIT="$(git -C "${ROOT}" rev-parse --short HEAD 2>/dev/null)"; then
  [[ -n "$(git -C "${ROOT}" status --porcelain 2>/dev/null)" ]] && TREE_COMMIT="${TREE_COMMIT}-dirty"
else
  TREE_COMMIT="nogit"
fi

echo "  installed: ${INSTALLED_VERSION} · ${INSTALLED_COMMIT} · ${INSTALLED_DATE}"
echo "  tree:      $(node -p "require('${ROOT}/package.json').version") · ${TREE_COMMIT}"

if [[ "${INSTALLED_COMMIT}" != "${TREE_COMMIT}" ]]; then
  echo "✗ /Applications is out of date — rerun ${ROOT}/packaging/install-app.sh"
  exit 1
fi

# Matching -dirty strings only prove the build came from an uncommitted tree,
# not that the tree stayed the same after it, so say so instead of claiming ✓.
if [[ "${TREE_COMMIT}" == *-dirty ]]; then
  echo "~ Built from this uncommitted tree — edits made after the build are not in it."
else
  echo "✓ /Applications matches the working tree."
fi
exit 0
