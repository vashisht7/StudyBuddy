# StudyBuddy — next features

This roadmap keeps StudyBuddy focused on one promise: turn any document into a private, calm, active-reading workspace. Priorities may change as real readers test the app.

## Next release — trust and daily usability

- Signed and notarized universal macOS build with an in-app update channel.
- First-run welcome flow that verifies storage, speech recognition, and the selected local AI model.
- Local backup and restore for the complete library, notes, chats, highlights, and settings.
- Keychain storage for optional API credentials and account tokens.
- Better recovery when a PDF is damaged, an AI model stops, or an import is interrupted.
- VoiceOver labels, complete keyboard navigation, focus indicators, scalable text, and reduced-motion support.
- Search across document titles, notes, highlights, and past Buddy answers.
- Collections, tags, favorites, recent items, and reading status.

## Reading and annotation

- Native-looking margin notes, ink drawing, shapes, stamps, and color-coded highlight categories.
- Backlinks between a note and the exact PDF page, paragraph, table, image, or equation that produced it.
- A citation inspector that shows the source passage beside every grounded Buddy answer.
- Split reading for comparing two documents or two distant sections of one book.
- Reading goals, session history, bookmarks, and a distraction-free focus mode.
- OCR for scanned PDFs, photographed pages, handwriting, figures, and tables.
- EPUB and richer Office-document support while preserving headings and page structure.
- Reference manager import/export for BibTeX, RIS, Zotero, and formatted bibliographies.

## Study tools

- Generate editable flashcards from selected notes, highlights, chapters, or the whole workspace.
- Spaced repetition with local scheduling, review history, and difficulty controls.
- Chapter quizzes with answer explanations and citations back to the document.
- Exam mode, oral-question mode, concept maps, timelines, and one-page revision sheets.
- Notebook mode that combines ideas from several documents without mixing their source citations.
- Learning presets such as “teach me,” “Socratic tutor,” “research assistant,” and “quick revision.”
- Export study packs as polished PDF, Markdown, Anki-compatible cards, or printable worksheets.

## Local AI

- A built-in model manager for download, pause, resume, update, removal, and storage estimates.
- Automatic model selection based on available memory, Apple silicon generation, task, and battery state.
- Smaller quantized models for basic Macs and optional higher-quality models for larger-memory Macs.
- Local image and page understanding for diagrams, charts, equations, and scanned content.
- Hybrid lexical and vector retrieval with transparent source scoring and per-document index controls.
- Background indexing with progress, pause, battery-awareness, and automatic recovery.
- Local evaluation checks that warn when an answer is weakly supported or conflicts with the document.

## Accounts and sync — later, opt-in only

- Encrypted sync for users who explicitly enable it; local-only remains the default.
- Selective sync by workspace, with clear device, storage, and deletion controls.
- End-to-end encrypted notes and annotations where the service cannot read the content.
- Conflict history and safe merge when the same note changes on two devices.
- Apple and Google accounts remain identity providers; signing in alone never enables uploads.
- Family, class, and research-group sharing only after private single-user sync is dependable.

## macOS integration

- Share extension, Quick Look preview, Finder “Open in StudyBuddy,” and Services menu actions.
- Shortcuts app actions for importing, summarizing, creating a study pack, and starting a review.
- Spotlight indexing for locally stored titles and user-approved notes.
- Continuity features such as Handoff only when an encrypted sync mode is enabled.
- Menu-bar quick capture for thoughts, quotations, and voice notes.
- A sandbox-compatible Mac App Store edition alongside the full direct-download edition.

## Production quality gates

- Clean-install tests on supported Apple-silicon macOS versions.
- Large-library, long-document, low-disk-space, offline, and model-failure stress tests.
- Privacy review proving that local mode makes no document, note, chat, or audio upload.
- Automated accessibility, import/export, persistence, RAG-grounding, and release-package tests.
- Public privacy policy, support channel, crash recovery plan, and documented data deletion behavior.

