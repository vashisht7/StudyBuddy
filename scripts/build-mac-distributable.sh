#!/bin/bash
set -euo pipefail

PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$PROJECT_ROOT"

VERSION="$(node -p "require('./package.json').version")"
BUILD_ROOT="$(mktemp -d /tmp/studybuddy-mac-build.XXXXXX)"
UNPACKED_ROOT="$BUILD_ROOT/unpacked"
PACKAGE_ROOT="$BUILD_ROOT/packages"
APP_PATH="$UNPACKED_ROOT/mac-arm64/StudyBuddy.app"
VERIFY_MOUNT=""

cleanup() {
  if [[ -n "$VERIFY_MOUNT" && -d "$VERIFY_MOUNT" ]]; then
    hdiutil detach "$VERIFY_MOUNT" >/dev/null 2>&1 || true
  fi
  case "$BUILD_ROOT" in
    /tmp/studybuddy-mac-build.*) /bin/rm -rf -- "$BUILD_ROOT" ;;
  esac
}
trap cleanup EXIT

npm run build:web
npm run build:speech
npx electron-builder --mac dir --config.directories.output="$UNPACKED_ROOT"

if ! codesign --verify --deep --strict "$APP_PATH" >/dev/null 2>&1; then
  echo "The app has no valid distribution identity; applying a complete ad-hoc beta signature."
  xattr -cr "$APP_PATH"
  codesign --force --deep --sign - --timestamp=none "$APP_PATH"
fi

codesign --verify --deep --strict --verbose=4 "$APP_PATH"
npx electron-builder --mac dmg zip --prepackaged "$APP_PATH" --config.directories.output="$PACKAGE_ROOT"

DMG_PATH="$PACKAGE_ROOT/StudyBuddy-${VERSION}-arm64.dmg"
ZIP_PATH="$PACKAGE_ROOT/StudyBuddy-${VERSION}-arm64-mac.zip"
hdiutil verify "$DMG_PATH"

VERIFY_MOUNT="$(mktemp -d /tmp/studybuddy-mac-verify.XXXXXX)"
hdiutil attach "$DMG_PATH" -nobrowse -readonly -mountpoint "$VERIFY_MOUNT" >/dev/null
codesign --verify --deep --strict --verbose=4 "$VERIFY_MOUNT/StudyBuddy.app"
hdiutil detach "$VERIFY_MOUNT" >/dev/null
rmdir "$VERIFY_MOUNT"
VERIFY_MOUNT=""

mkdir -p release
/usr/bin/ditto "$DMG_PATH" "release/StudyBuddy-${VERSION}-arm64.dmg"
/usr/bin/ditto "$ZIP_PATH" "release/StudyBuddy-${VERSION}-arm64-mac.zip"

echo
echo "Verified Mac artifacts:"
ls -lh "release/StudyBuddy-${VERSION}-arm64.dmg" "release/StudyBuddy-${VERSION}-arm64-mac.zip"
shasum -a 256 "release/StudyBuddy-${VERSION}-arm64.dmg" "release/StudyBuddy-${VERSION}-arm64-mac.zip"
echo "The beta signature is internally valid. Developer ID signing and Apple notarization are still required for a warning-free first launch."
