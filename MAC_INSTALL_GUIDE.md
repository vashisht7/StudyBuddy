# StudyBuddy for Mac — install and download

## Choose a download

| Edition | Download | Approximate size | Best for |
|---|---|---:|---|
| Standard Mac | `release/StudyBuddy-1.0.0-arm64.dmg` | 150 MB | Existing Ollama, cloud AI, or document tools without a bundled model |
| Complete Offline Mac | `release/StudyBuddy-1.0.0-Compact-Offline-arm64.dmg` | 3.50 GB | Ollama and multimodal Gemma 3 4B included |
| Portable Mac | `release/StudyBuddy-1.0.0-arm64-mac.zip` | 143 MB | Running without a DMG installer |
| Website | `release/StudyBuddy-1.0.0-Website.zip` | 1.7 MB | Hosting or browser development |

All editions share the same interface and workspace behavior. Apple Speech dictation adds less than 0.1 MB because the recognition engine is supplied by macOS.

## Install the standard Mac app

1. Download `StudyBuddy-1.0.0-arm64.dmg`, then double-click it.
2. In the dark installer window, drag **StudyBuddy** onto the **Applications** folder shortcut.
3. Eject the StudyBuddy disk image from Finder.
4. Open **Applications**. Because this development build is not notarized yet, Control-click **StudyBuddy**, choose **Open**, then confirm **Open** once more.
5. Optionally connect an Apple or Google profile. This identifies the local user only; it does not upload study data.
6. Add a PDF, DOCX, TXT, Markdown, or source-code file. The library and every workspace are saved automatically on this Mac.

For generated AI answers, open **AI Settings** and either:

- connect an Ollama server/model already installed on the Mac;
- configure an OpenAI-compatible or Gemini provider; or
- download the Complete Offline edition.

## Install the complete offline edition

1. From the GitHub release, download both offline `.part-aa` and `.part-ab` files plus `Join-StudyBuddy-Offline.command` into the same folder.
2. Double-click the join script. It reconstructs the DMG, verifies its SHA-256 checksum, and opens it only when the download is intact.
3. In the opened DMG, read **READ ME — Install StudyBuddy.txt**.
4. Double-click **Install StudyBuddy Offline.command**, type `y`, and leave the DMG mounted while its three progress steps finish.
5. The installer checks free space, copies StudyBuddy, Ollama, and Gemma 3 4B into the user account, then launches them automatically.
6. In StudyBuddy, open **AI Settings** → choose **Ollama** → **Scan** → select `gemma3:4b` if it is not already selected.

After installation, document reading, local RAG, dictation, notes, and Gemma answers work without internet. Allow roughly 6 GB of free installed space for the app, model, Ollama, and working cache.

## Accounts and local privacy

- Apple and Google sign-in require a brief internet connection because those companies verify the account.
- Signing in is optional and only personalizes the profile shown in StudyBuddy.
- Cloud synchronization is disabled in this release.
- Documents, notes, highlights, chats, reading position, and the RAG index remain in the local browser/app storage.
- Apple sign-in must be enabled and configured in the project's Firebase Authentication console before that button can authenticate public users.

## Use Apple Speech dictation

1. Open a document and select **Notes**.
2. Click **Dictate** or press `⌘⇧D`.
3. The first use asks for **Speech Recognition** and **Microphone** access. Allow both.
4. Speak naturally. Partial words appear live at the current note cursor.
5. Click **Listening** or press `⌘⇧D` again to stop. The transcript is saved into that document’s notes.

StudyBuddy forces Apple’s on-device recognition mode. If a language model is missing, enable that language under **System Settings → Keyboard → Dictation**. Microphone audio is not sent to StudyBuddy servers.

## Website development

```bash
npm install
npm run dev:web
```

Open `http://localhost:5173`. Edit the shared `index.html`, `src/main.js`, and `src/style.css`; both website and Mac builds use these files.

Create releases:

```bash
npm run release:both
npm run build:offline-lite
```

Apple Speech dictation is Mac-only. It remains hidden in the ordinary website because browser speech recognition cannot guarantee the same on-device privacy behavior.

## Main shortcuts

| Shortcut | Action |
|---|---|
| `⌘1` / `⌘2` | Buddy / Notes |
| `⌘E` | Edit notes |
| `⌘⇧D` | Start or stop local dictation |
| `⌘⇧H` | Highlight selected PDF text |
| `⌘⇧N` | Add selected PDF text to notes |
| `⌘⌥B` | Show or hide the workspace |
| `⌘S` | Save the open editable document |

## Distribution note

The current DMGs pass integrity verification but are not Developer ID signed or notarized. A public warning-free release still requires an Apple Developer certificate, hardened runtime signing, notarization, and stapling.
