#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PART_A="$SCRIPT_DIR/StudyBuddy-1.0.0-Compact-Offline-arm64.dmg.part-aa"
PART_B="$SCRIPT_DIR/StudyBuddy-1.0.0-Compact-Offline-arm64.dmg.part-ab"
OUTPUT_DMG="$SCRIPT_DIR/StudyBuddy-1.0.0-Compact-Offline-arm64.dmg"
EXPECTED_SHA256="7fb617077a153c7225f51bc0476910ffa9e6d6b30143d4103036ff79b64cfdc2"

clear
echo "StudyBuddy Complete Offline — Secure Join"
echo "=========================================="
echo

if [[ ! -f "$PART_A" || ! -f "$PART_B" ]]; then
  echo "Keep this script and both .part files in the same folder, then try again."
  read -r -p "Press Return to close…" _
  exit 1
fi

if [[ -e "$OUTPUT_DMG" ]]; then
  echo "The joined DMG already exists:"
  echo "$OUTPUT_DMG"
  read -r -p "Move it elsewhere and press Return to close…" _
  exit 1
fi

echo "Joining the two verified download parts…"
/bin/cat "$PART_A" "$PART_B" > "$OUTPUT_DMG"

echo "Checking SHA-256 integrity…"
ACTUAL_SHA256="$(/usr/bin/shasum -a 256 "$OUTPUT_DMG" | /usr/bin/awk '{print $1}')"
if [[ "$ACTUAL_SHA256" != "$EXPECTED_SHA256" ]]; then
  echo "Integrity check failed. Do not open the DMG; download both parts again."
  echo "Expected: $EXPECTED_SHA256"
  echo "Received: $ACTUAL_SHA256"
  read -r -p "Press Return to close…" _
  exit 1
fi

echo "✓ Download verified. Opening StudyBuddy Complete Offline…"
/usr/bin/open "$OUTPUT_DMG"
read -r -p "Press Return to close…" _
