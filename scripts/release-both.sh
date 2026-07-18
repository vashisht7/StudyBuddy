#!/bin/bash
set -euo pipefail

VERSION="$(node -p "require('./package.json').version")"
WEB_ZIP="release/StudyBuddy-${VERSION}-Website.zip"

npm run build:mac
mkdir -p release
rm -f "$WEB_ZIP"
/usr/bin/ditto -c -k --sequesterRsrc dist "$WEB_ZIP"

echo
echo "Both editions were generated from the same dist/ build:"
du -h "$WEB_ZIP" "release/StudyBuddy-${VERSION}-arm64.dmg"
