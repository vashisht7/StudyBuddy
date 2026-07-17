#!/bin/bash
set -euo pipefail

INSTALLER_ROOT="$(cd "$(dirname "$0")" && pwd)"
TARGET_APPS="${HOME}/Applications"
TARGET_MODELS="${HOME}/.ollama/models"

MODEL_DESCRIPTION="$(cat "$INSTALLER_ROOT/Resources/MODEL_INFO.txt" 2>/dev/null || echo "a local AI model")"

clear
echo "╭──────────────────────────────────────────────╮"
echo "│       StudyBuddy Complete Offline Setup      │"
echo "╰──────────────────────────────────────────────╯"
echo
echo "Includes StudyBuddy, Ollama, and $MODEL_DESCRIPTION."
echo "Everything is installed for this Mac user; no administrator password"
echo "or internet connection is required. Allow several minutes to finish."
echo
read -r -p "Continue? [y/N] " ANSWER
case "$ANSWER" in y|Y|yes|YES) ;; *) echo; echo "Installation cancelled — nothing was changed."; exit 0 ;; esac

if [[ ! -d "$INSTALLER_ROOT/StudyBuddy.app" || ! -d "$INSTALLER_ROOT/Resources/Ollama.app" || ! -d "$INSTALLER_ROOT/Resources/models" ]]; then
  echo "The installer is incomplete. Download the Complete Offline DMG again."
  read -r -p "Press Return to close…" _
  exit 1
fi

AVAILABLE_KB="$(df -Pk "${HOME}" | awk 'NR==2 {print $4}')"
if [[ "${AVAILABLE_KB:-0}" -lt 6291456 ]]; then
  echo "At least 6 GB of free disk space is required before installation."
  read -r -p "Press Return to close…" _
  exit 1
fi

mkdir -p "$TARGET_APPS" "$TARGET_MODELS"
echo
echo "[1/3] Installing StudyBuddy…"
/usr/bin/ditto "$INSTALLER_ROOT/StudyBuddy.app" "$TARGET_APPS/StudyBuddy.app"
echo "[2/3] Installing the private local AI engine…"
/usr/bin/ditto "$INSTALLER_ROOT/Resources/Ollama.app" "$TARGET_APPS/Ollama.app"

echo "[3/3] Installing Gemma 3 4B — this is the longest step…"
/usr/bin/ditto "$INSTALLER_ROOT/Resources/models" "$TARGET_MODELS"

echo
echo "Starting local AI and StudyBuddy…"
/usr/bin/open "$TARGET_APPS/Ollama.app"
sleep 3
/usr/bin/open "$TARGET_APPS/StudyBuddy.app"
/usr/bin/osascript -e 'display notification "StudyBuddy and Gemma 3 4B are ready." with title "Installation complete"' >/dev/null 2>&1 || true

echo
echo "✓ Installation complete"
echo "  App:   $TARGET_APPS/StudyBuddy.app"
echo "  Model: $TARGET_MODELS"
echo
echo "Your study data remains local. In StudyBuddy, open AI Settings and"
echo "choose Ollama; the bundled Gemma model should be detected automatically."
echo
read -r -p "Press Return to close this installer…" _
