#!/bin/bash
set -euo pipefail

MODEL="${1:-gemma3:4b}"
VERSION="$(node -p "require('./package.json').version")"
SAFE_MODEL="${MODEL//[:\/]/-}"
STAGE="release/offline-lite-${SAFE_MODEL}"
OUTPUT="release/StudyBuddy-${VERSION}-Compact-Offline-arm64.dmg"
APP_SOURCE="release/mac-arm64/StudyBuddy.app"
OLLAMA_APP="/Applications/Ollama.app"
MODEL_NAME="${MODEL%%:*}"
MODEL_TAG="${MODEL#*:}"
MANIFEST="$HOME/.ollama/models/manifests/registry.ollama.ai/library/$MODEL_NAME/$MODEL_TAG"

if [[ ! -d "$APP_SOURCE" ]]; then
  echo "Mac application is missing; building it first."
  npm run build:mac:dir
fi

if [[ ! -d "$OLLAMA_APP" ]]; then
  echo "Ollama.app was not found at $OLLAMA_APP." >&2
  exit 1
fi

if [[ ! -f "$MANIFEST" ]]; then
  echo "$MODEL is not installed. Run: ollama pull $MODEL" >&2
  exit 1
fi

rm -rf "$STAGE" "$OUTPUT"
mkdir -p "$STAGE/Resources/models/manifests/registry.ollama.ai/library/$MODEL_NAME" "$STAGE/Resources/models/blobs"

/usr/bin/ditto "$APP_SOURCE" "$STAGE/StudyBuddy.app"
/usr/bin/ditto "$OLLAMA_APP" "$STAGE/Resources/Ollama.app"
/usr/bin/ditto "$MANIFEST" "$STAGE/Resources/models/manifests/registry.ollama.ai/library/$MODEL_NAME/$MODEL_TAG"
/usr/bin/ditto "scripts/install-offline.command" "$STAGE/Install StudyBuddy Offline.command"
/usr/bin/ditto "scripts/OFFLINE_READ_ME.txt" "$STAGE/READ ME — Install StudyBuddy.txt"
chmod +x "$STAGE/Install StudyBuddy Offline.command"
printf '%s\n' "$MODEL (compact multimodal 4B; built-in lexical RAG)" > "$STAGE/Resources/MODEL_INFO.txt"

node - "$MANIFEST" "$HOME/.ollama/models/blobs" "$STAGE/Resources/models/blobs" <<'NODE'
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const [manifestPath, blobRoot, outputRoot] = process.argv.slice(2);
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
const digests = [manifest.config, ...manifest.layers].map(item => item.digest.replace(':', '-'));
for (const digest of digests) {
  const source = path.join(blobRoot, digest);
  if (!fs.existsSync(source)) throw new Error(`Missing Ollama blob: ${source}`);
  execFileSync('/usr/bin/ditto', [source, path.join(outputRoot, digest)]);
}
NODE

ln -s /Applications "$STAGE/Applications"
hdiutil create -volname "StudyBuddy Compact Offline" -srcfolder "$STAGE" -ov -format UDZO "$OUTPUT"
rm -rf "$STAGE"

echo
du -h "$OUTPUT"
shasum -a 256 "$OUTPUT"
