# StudyBuddy

StudyBuddy is a local-first document reading workspace for macOS and the web. It combines PDF reading, editable documents, per-document notes, grounded Buddy chat, local RAG, polished exports, and Apple on-device speech-to-text.

## Download

Download the latest workspace and RAG beta from [GitHub Releases](https://github.com/vashisht7/StudyBuddy/releases/tag/v1.1.0-beta.1).

| Edition | Download | Use it when |
|---|---|---|
| Standard Mac | [StudyBuddy-1.1.0-arm64.dmg](https://github.com/vashisht7/StudyBuddy/releases/download/v1.1.0-beta.1/StudyBuddy-1.1.0-arm64.dmg) | You already use Ollama, or only need the reader and local workspace |
| Portable Mac | [StudyBuddy-1.1.0-arm64-mac.zip](https://github.com/vashisht7/StudyBuddy/releases/download/v1.1.0-beta.1/StudyBuddy-1.1.0-arm64-mac.zip) | You prefer an application ZIP |
| Complete Offline Mac | [Release assets and joining instructions](https://github.com/vashisht7/StudyBuddy/releases/tag/v1.1.0-beta.1) | You want Ollama and Gemma 3 4B included |
| Website | [StudyBuddy-1.1.0-Website.zip](https://github.com/vashisht7/StudyBuddy/releases/download/v1.1.0-beta.1/StudyBuddy-1.1.0-Website.zip) | You want to host or inspect the web build |

### Install the standard Mac edition

1. Open the downloaded DMG.
2. Drag **StudyBuddy** onto **Applications**.
3. This beta has a complete ad-hoc signature but is not Apple-notarized yet. On first launch, Control-click StudyBuddy, choose **Open**, then confirm **Open**.
4. Add a document. Notes, chats, highlights, RAG data, and reading progress remain on the Mac.

The complete offline DMG is larger than GitHub's per-file upload limit. Download both `.part-aa` and `.part-ab` assets plus `Join-StudyBuddy-Offline-1.1.0.zip`. Expand the ZIP, keep the resulting command beside both parts, and open it. The script verifies the reconstructed DMG before opening it.

See the [complete Mac installation guide](./MAC_INSTALL_GUIDE.md) for permissions, local AI setup, speech-to-text, shortcuts, and privacy details.

## Start developing

```bash
npm install
npm run dev:web
```

The website runs at `http://localhost:5173`.

## Build releases

```bash
npm run release:both
npm run build:offline-lite
```

## Documentation

Project documentation and planning:

1. [Mac installation and downloads](./MAC_INSTALL_GUIDE.md)
2. [Visual app workflow and architecture](./APP_WORKFLOW_REPORT.md)
3. [Beginner-friendly code guide](./CODE_GUIDE.md)
4. [Next-features roadmap](./NEXT_FEATURES.md)

The website, standard Mac app, and complete offline Mac app use the same Vite frontend. The Mac app additionally supplies native PDF export, Ollama bridging, and private Apple Speech dictation.
