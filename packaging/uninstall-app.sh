#!/usr/bin/env bash
#
# Quit Chat Hub, remove it from /Applications, and disable launch at login.
#
set -euo pipefail

PLIST_DST="$HOME/Library/LaunchAgents/com.agentdesktop.ChatHub.plist"
DST="/Applications/Chat Hub.app"

launchctl bootout "gui/$(id -u)/com.agentdesktop.ChatHub" 2>/dev/null || true
launchctl unload "$PLIST_DST" 2>/dev/null || true
rm -f "$PLIST_DST"
pkill -f "Chat Hub.app/Contents/MacOS/Chat Hub" 2>/dev/null || true
rm -rf "$DST"
echo "✓ Uninstalled Chat Hub and disabled launch at login."
echo "  (Sessions and settings stay in ~/Library/Application Support/chat-hub.)"
