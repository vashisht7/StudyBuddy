import katex from 'katex';

function escapeMarkup(value = '') {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function renderMath(expression, displayMode) {
  try {
    return katex.renderToString(expression.trim(), {
      displayMode,
      throwOnError: false,
      strict: 'ignore',
      output: 'html'
    });
  } catch (_) {
    return `<code class="latex-source">${escapeMarkup(expression)}</code>`;
  }
}

export function convertMarkdownToHtml(markdown = '') {
  const blocks = [];
  const stash = (html) => `%%STUDYBLOCK${blocks.push(html) - 1}%%`;
  let source = String(markdown).replace(/\r\n?/g, '\n');

  source = source.replace(/```([\w-]*)\n([\s\S]*?)```/g, (_, language, code) =>
    stash(`<pre><code data-language="${escapeMarkup(language)}">${escapeMarkup(code.trim())}</code></pre>`));
  source = source.replace(/\$\$([\s\S]+?)\$\$/g, (_, expression) =>
    stash(`<div class="math-display">${renderMath(expression, true)}</div>`));
  source = source.replace(/(^|[^\\])\$([^$\n]+?)\$/g, (_, prefix, expression) =>
    `${prefix}${stash(`<span class="math-inline">${renderMath(expression, false)}</span>`)}`);

  source = escapeMarkup(source)
    .replace(/!\[([^\]]*)\]\((data:image\/[^)]+|https?:\/\/[^)]+)\)/g,
      '<figure><img src="$2" alt="$1"/><figcaption>$1</figcaption></figure>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/__([^_]+)__/g, '<strong>$1</strong>')
    .replace(/\*([^*]+)\*/g, '<em>$1</em>')
    .replace(/_([^_]+)_/g, '<em>$1</em>');

  const output = [];
  let listType = null;
  const closeList = () => {
    if (listType) output.push(`</${listType}>`);
    listType = null;
  };

  source.split('\n').forEach((rawLine) => {
    const line = rawLine.trim();
    if (!line) {
      closeList();
      return;
    }
    if (/^%%STUDYBLOCK\d+%%$/.test(line)) {
      closeList();
      output.push(line);
      return;
    }
    const heading = line.match(/^(#{1,4})\s+(.+)$/);
    if (heading) {
      closeList();
      const level = heading[1].length;
      output.push(`<h${level}>${heading[2]}</h${level}>`);
      return;
    }
    const unordered = line.match(/^[-*]\s+(.+)$/);
    const ordered = line.match(/^\d+[.)]\s+(.+)$/);
    if (unordered || ordered) {
      const nextType = unordered ? 'ul' : 'ol';
      if (listType !== nextType) {
        closeList();
        listType = nextType;
        output.push(`<${listType}>`);
      }
      output.push(`<li>${(unordered || ordered)[1]}</li>`);
      return;
    }
    const quote = line.match(/^&gt;\s?(.+)$/);
    if (quote) {
      closeList();
      output.push(`<blockquote>${quote[1]}</blockquote>`);
      return;
    }
    closeList();
    output.push(`<p>${line}</p>`);
  });
  closeList();

  return output.join('\n').replace(/%%STUDYBLOCK(\d+)%%/g, (_, index) => blocks[Number(index)] || '');
}

export function buildNotesExportDocument({ text, documentName, katexCss = '', baseHref = '', style = 'typeset', mode = 'notes' }) {
  const cleanName = String(documentName || 'Study Notes').replace(/\.pdf$/i, '');
  const isHandwritten = style === 'handwritten';
  const isCheatSheet = mode === 'cheatsheet';
  const exportedAt = new Intl.DateTimeFormat(undefined, {
    year: 'numeric', month: 'long', day: 'numeric'
  }).format(new Date());
  const notesHtml = convertMarkdownToHtml(text) || '<p class="empty-note">No notes were written for this document.</p>';
  const bodyClass = `${isHandwritten ? 'handwritten' : 'typeset'} ${isCheatSheet ? 'cheat-sheet' : 'reading-notes'}`;
  const titlePage = isCheatSheet ? '' : `
  <section class="title-page">
    <div class="brand">StudyBuddy</div>
    <p class="eyebrow">Reading Notes</p>
    <h1>${escapeMarkup(cleanName)}</h1>
    <div class="title-rule"></div>
    <p class="subtitle">A carefully typeset record of ideas, highlights, equations, and reflections.</p>
    <div class="meta">Prepared locally on ${escapeMarkup(exportedAt)}<br>Source: ${escapeMarkup(documentName || 'Personal study workspace')}</div>
  </section>`;
  const cheatHeader = isCheatSheet ? `
  <header class="cheat-header">
    <span>StudyBuddy · Cheat Sheet</span>
    <h1>${escapeMarkup(cleanName)}</h1>
    <small>Condensed locally on ${escapeMarkup(exportedAt)}</small>
  </header>` : '';

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  ${baseHref ? `<base href="${escapeMarkup(baseHref)}">` : ''}
  <title>${escapeMarkup(cleanName)} - StudyBuddy ${isCheatSheet ? 'Cheat Sheet' : 'Notes'}</title>
  <style>${katexCss}</style>
  <style>
    :root { color-scheme: light; }
    * { box-sizing: border-box; }
    @page { size: ${isCheatSheet ? 'A4 landscape' : 'A4'}; margin: ${isCheatSheet ? '12mm' : '22mm 20mm 24mm'}; }
    body {
      margin: 0; color: #202124; background: #fff;
      font: 11.2pt/1.68 "New York", "Iowan Old Style", "Palatino Linotype", Palatino, Georgia, serif;
      text-rendering: optimizeLegibility; -webkit-font-smoothing: antialiased;
    }
    .title-page { min-height: 225mm; display: flex; flex-direction: column; justify-content: center; page-break-after: always; }
    .brand { margin-bottom: 22mm; color: #367c78; font: 700 9pt/1.2 -apple-system, BlinkMacSystemFont, sans-serif; letter-spacing: .18em; text-transform: uppercase; }
    .eyebrow { margin: 0 0 5mm; color: #77807f; font: 600 9pt/1.2 -apple-system, BlinkMacSystemFont, sans-serif; letter-spacing: .12em; text-transform: uppercase; }
    .title-page h1 { max-width: 155mm; margin: 0; color: #17201f; font-size: 34pt; line-height: 1.08; font-weight: 600; letter-spacing: -.025em; }
    .title-rule { width: 28mm; height: 1.2mm; margin: 10mm 0 7mm; border-radius: 2mm; background: linear-gradient(90deg, #4aaea7, #669ad2); }
    .subtitle { max-width: 120mm; margin: 0; color: #6d7675; font-size: 12pt; }
    .meta { margin-top: auto; padding-top: 12mm; border-top: .25mm solid #dfe5e4; color: #7b8382; font: 9pt/1.5 -apple-system, BlinkMacSystemFont, sans-serif; }
    .notes { max-width: 168mm; margin: 0 auto; padding-top: 9mm; padding-bottom: 8mm; }
    h1, h2, h3, h4 { color: #17201f; font-family: "New York", "Iowan Old Style", Georgia, serif; page-break-after: avoid; }
    h1 { margin: 0 0 9mm; padding-bottom: 4mm; border-bottom: .35mm solid #cfd8d6; font-size: 25pt; line-height: 1.18; }
    h2 { margin: 12mm 0 4mm; font-size: 18pt; line-height: 1.25; }
    h3 { margin: 8mm 0 3mm; color: #315b58; font-size: 14pt; }
    h4 { margin: 6mm 0 2mm; font-size: 11.5pt; font-style: italic; }
    p { margin: 0 0 4.2mm; orphans: 3; widows: 3; }
    strong { color: #182321; font-weight: 700; }
    ul, ol { margin: 2mm 0 5mm; padding-left: 7mm; }
    li { margin: 0 0 1.7mm; padding-left: 1.5mm; }
    blockquote { margin: 6mm 0; padding: 1mm 0 1mm 6mm; border-left: 1.2mm solid #67aaa5; color: #536361; font-style: italic; }
    code { padding: .25mm 1.2mm; border: .2mm solid #dce4e3; border-radius: 1mm; background: #f2f6f5; font: 9.2pt/1.45 "SFMono-Regular", Menlo, monospace; }
    pre { margin: 5mm 0; padding: 4mm; overflow: hidden; border: .2mm solid #d7dfde; border-radius: 2mm; background: #f4f7f6; page-break-inside: avoid; white-space: pre-wrap; }
    pre code { padding: 0; border: 0; background: transparent; }
    .math-display { margin: 6mm 0; padding: 4mm 3mm; overflow: hidden; border-radius: 2mm; background: #f7f9f8; text-align: center; page-break-inside: avoid; }
    .math-inline { white-space: nowrap; }
    .katex { font-size: 1.04em; }
    figure { margin: 7mm 0; page-break-inside: avoid; }
    figure img { display: block; max-width: 100%; max-height: 175mm; margin: 0 auto; border-radius: 2mm; }
    figcaption { margin-top: 2mm; color: #747d7c; font: italic 8.5pt/1.4 -apple-system, BlinkMacSystemFont, sans-serif; text-align: center; }
    .empty-note { color: #7d8584; font-style: italic; }
    body.handwritten {
      color: #302d2b;
      background-color: #faf6ed;
      background-image: repeating-linear-gradient(transparent 0, transparent 7.4mm, rgba(91,117,155,.1) 7.65mm);
      font-family: "Bradley Hand", "Noteworthy", "Marker Felt", "Comic Sans MS", cursive;
      font-size: 12pt;
      line-height: 1.72;
    }
    body.handwritten h1, body.handwritten h2, body.handwritten h3, body.handwritten h4,
    body.handwritten strong { color: #261f20; font-family: inherit; }
    body.handwritten .title-rule { background: linear-gradient(90deg, #b72d34, #d36a61); }
    body.handwritten blockquote { border-left-color: #b84a50; }
    body.cheat-sheet { font-size: 8.5pt; line-height: 1.38; }
    .cheat-header { margin: 0 0 6mm; padding-bottom: 3.5mm; border-bottom: .45mm solid #b72d34; break-after: avoid; }
    .cheat-header span { color: #a33239; font: 700 7.5pt/1.2 -apple-system, BlinkMacSystemFont, sans-serif; letter-spacing: .12em; text-transform: uppercase; }
    .cheat-header h1 { margin: 1.5mm 0 1mm; padding: 0; border: 0; font-size: 19pt; }
    .cheat-header small { color: #747b7a; font: 7.5pt/1.2 -apple-system, BlinkMacSystemFont, sans-serif; }
    body.cheat-sheet .notes { max-width: none; padding: 0; column-count: 3; column-gap: 8mm; column-rule: .2mm solid #e0e3e2; }
    body.cheat-sheet .notes h1 { margin: 0 0 2.5mm; padding-bottom: 1.5mm; font-size: 14pt; }
    body.cheat-sheet .notes h2 { margin: 4mm 0 1.5mm; font-size: 11.5pt; }
    body.cheat-sheet .notes h3 { margin: 3mm 0 1mm; font-size: 9.5pt; }
    body.cheat-sheet .notes h4 { margin: 2.5mm 0 1mm; font-size: 8.5pt; }
    body.cheat-sheet p { margin-bottom: 2mm; }
    body.cheat-sheet ul, body.cheat-sheet ol { margin: 1mm 0 2.5mm; padding-left: 5mm; }
    body.cheat-sheet li { margin-bottom: .8mm; padding-left: .7mm; }
    body.cheat-sheet blockquote { margin: 2.5mm 0; padding-left: 3mm; }
    body.cheat-sheet .math-display { margin: 2.5mm 0; padding: 2mm; }
    body.cheat-sheet h1, body.cheat-sheet h2, body.cheat-sheet h3, body.cheat-sheet h4,
    body.cheat-sheet pre, body.cheat-sheet blockquote, body.cheat-sheet .math-display { break-inside: avoid; }
  </style>
</head>
<body class="${bodyClass}">
  ${titlePage}
  ${cheatHeader}
  <main class="notes">${notesHtml}</main>
</body>
</html>`;
}
