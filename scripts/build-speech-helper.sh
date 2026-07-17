#!/bin/bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUTPUT="$ROOT/build/native/StudyBuddySpeech"
mkdir -p "$(dirname "$OUTPUT")"

xcrun swiftc \
  -O \
  -target arm64-apple-macos13.0 \
  -framework Foundation \
  -framework AVFoundation \
  -framework Speech \
  -Xlinker -sectcreate \
  -Xlinker __TEXT \
  -Xlinker __info_plist \
  -Xlinker "$ROOT/native/StudyBuddySpeech-Info.plist" \
  "$ROOT/native/StudyBuddySpeech.swift" \
  -o "$OUTPUT"

chmod 755 "$OUTPUT"
echo "$OUTPUT"
