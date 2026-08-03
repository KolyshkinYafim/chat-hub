#!/usr/bin/env bash
#
# Build Chat Hub, install it to /Applications, start at login.
# Re-runnable. Pass --no-login to skip the LaunchAgent. Undo: ./uninstall-app.sh
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEST="/Applications/Chat Hub.app"
PLIST_SRC="${ROOT}/packaging/com.agentdesktop.ChatHub.plist"
PLIST_DST="${HOME}/Library/LaunchAgents/com.agentdesktop.ChatHub.plist"

LOGIN=1
[[ "${1:-}" == "--no-login" ]] && LOGIN=0

"${ROOT}/packaging/build-app.sh"

case "$(uname -m)" in
  arm64) APP="${ROOT}/release/mac-arm64/Chat Hub.app" ;;
  *)     APP="${ROOT}/release/mac/Chat Hub.app" ;;
esac

echo "Installing to ${DEST}..."
# Only the main process is matched by name; its helpers exit with it.
pkill -x "Chat Hub" 2>/dev/null || true
sleep 1
rm -rf "${DEST}"
# ditto, not cp: it is the copy that keeps a bundle's symlinks and metadata
# intact, which is the difference between an installed app that still verifies
# and one macOS calls damaged.
ditto "${APP}" "${DEST}"
# Strip whatever rode along from the synced tree — quarantine included — then
# check the signature build-app.sh applied actually survived the trip.
xattr -cr "${DEST}" 2>/dev/null || true
codesign --verify --deep --strict "${DEST}" \
  || echo "WARNING: installed bundle failed codesign --verify"

if [[ "${LOGIN}" == "1" ]]; then
  echo "Enabling launch at login..."
  mkdir -p "${HOME}/Library/LaunchAgents"
  cp "${PLIST_SRC}" "${PLIST_DST}"
  launchctl bootout "gui/$(id -u)/com.agentdesktop.ChatHub" 2>/dev/null || true
  launchctl unload "${PLIST_DST}" 2>/dev/null || true
  if ! launchctl bootstrap "gui/$(id -u)" "${PLIST_DST}" 2>/dev/null; then
    launchctl load "${PLIST_DST}" 2>/dev/null || true
  fi
else
  echo "Skipping launch at login (--no-login)."
fi

open "${DEST}"
echo "Installed and started."
"${ROOT}/packaging/app-status.sh" || true
echo "  Undo: ${ROOT}/packaging/uninstall-app.sh"
