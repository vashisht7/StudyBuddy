#!/bin/bash
set -euo pipefail

if ! command -v ollama >/dev/null 2>&1; then
  echo "Ollama is required for the optional local model."
  echo "Install it from https://ollama.com/download/mac, then rerun this command."
  exit 1
fi

echo "StudyBuddy Local AI Setup"
echo
echo "Choose an AI package:"
echo "  1) Tiny text  — Gemma 3 1B (~815 MB, no page-image understanding)"
echo "  2) Compact 4B — Gemma 3 4B multimodal (~3.3 GB, recommended)"
echo "  3) 4B + Embed — Compact 4B plus semantic embeddings (~3.6 GB total)"
echo "  4) 3n Quality — Gemma 3n E4B plus embeddings (~7.8 GB total)"
echo "  5) No model   — Local PDF reader + lexical retrieval only"
echo
read -r -p "Selection [2]: " CHOICE
CHOICE="${CHOICE:-2}"

case "$CHOICE" in
  1)
    MODEL="gemma3:1b"
    EMBED_MODEL=""
    DESCRIPTION="approximately 815 MB"
    ;;
  2)
    MODEL="gemma3:4b"
    EMBED_MODEL=""
    DESCRIPTION="approximately 3.3 GB"
    ;;
  3)
    MODEL="gemma3:4b"
    EMBED_MODEL="embeddinggemma:300m-qat-q4_0"
    DESCRIPTION="approximately 3.6 GB"
    ;;
  4)
    MODEL="gemma3n:e4b"
    EMBED_MODEL="embeddinggemma:300m-qat-q4_0"
    DESCRIPTION="approximately 7.8 GB"
    ;;
  5)
    echo "No model downloaded. StudyBuddy will still read, map, search, cite, and retrieve PDF passages locally."
    exit 0
    ;;
  *)
    echo "Invalid selection."
    exit 1
    ;;
esac

echo
echo "Download size: $DESCRIPTION"
echo "Generation:    $MODEL"
if [[ -n "$EMBED_MODEL" ]]; then
  echo "Embeddings:    $EMBED_MODEL"
else
  echo "Embeddings:    built-in lexical RAG (no additional download)"
fi
echo
read -r -p "Continue? [y/N] " ANSWER
case "$ANSWER" in
  y|Y|yes|YES) ;;
  *) echo "Cancelled. No models were downloaded."; exit 0 ;;
esac

ollama pull "$MODEL"
if [[ -n "$EMBED_MODEL" ]]; then
  ollama pull "$EMBED_MODEL"
fi

echo
echo "Local AI is ready."
echo "Open StudyBuddy → Settings → Ollama → Scan, then select $MODEL."
