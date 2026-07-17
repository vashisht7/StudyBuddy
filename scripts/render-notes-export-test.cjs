const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

app.whenReady().then(async () => {
  const projectRoot = path.join(__dirname, '..');
  const renderCheatSheet = process.argv.includes('--cheatsheet');
  const { buildNotesExportDocument } = await import(pathToFileURL(path.join(projectRoot, 'src', 'notes-export.js')).href);
  const katexRoot = path.join(projectRoot, 'node_modules', 'katex', 'dist');
  const fontBase = `${pathToFileURL(path.join(katexRoot, 'fonts')).href}/`;
  const katexCss = fs.readFileSync(path.join(katexRoot, 'katex.min.css'), 'utf8').replace(/url\(fonts\//g, `url(${fontBase}`);
  const html = buildNotesExportDocument({
    documentName: 'Foundations of Machine Learning.pdf',
    katexCss,
    mode: renderCheatSheet ? 'cheatsheet' : 'notes',
    style: renderCheatSheet ? 'handwritten' : 'typeset',
    text: `# Foundations of Machine Learning

## Core idea

Learning is the process of selecting a function that generalizes from observed examples. A useful objective balances **fit** with *simplicity*.

> A model should explain the training data without memorizing its accidental noise.

### Regularized objective

The empirical objective can be written inline as $R(\\theta)=\\frac{1}{n}\\sum_{i=1}^{n}\\ell(f_\\theta(x_i), y_i)$.

$$
\\theta^* = \\arg\\min_\\theta \\left[ \\frac{1}{n} \\sum_{i=1}^{n} \\ell(f_\\theta(x_i), y_i) + \\lambda \\lVert \\theta \\rVert_2^2 \\right]
$$

## Reading notes

- The loss function measures prediction error.
- The regularizer controls model complexity.
- Cross-validation estimates performance on unseen examples.

1. Define the hypothesis class.
2. Fit parameters on training data.
3. Evaluate on held-out data.

### Practical reminder

Use \`page-aware retrieval\` so every generated answer remains connected to its source.`
  });

  const outputDir = path.join(projectRoot, 'output', 'pdf');
  const outputPath = path.join(outputDir, renderCheatSheet ? 'StudyBuddy-Handwritten-Cheat-Sheet-Sample.pdf' : 'StudyBuddy-Notes-Export-Sample.pdf');
  const tempPath = path.join(app.getPath('temp'), 'studybuddy-notes-export-test.html');
  fs.mkdirSync(outputDir, { recursive: true });
  fs.writeFileSync(tempPath, html, 'utf8');

  const window = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true } });
  await window.loadFile(tempPath);
  await window.webContents.executeJavaScript('document.fonts.ready.then(() => true)');
  const pdf = await window.webContents.printToPDF({
    pageSize: 'A4', printBackground: true, preferCSSPageSize: true,
    displayHeaderFooter: true, headerTemplate: '<span></span>',
    footerTemplate: '<div style="width:100%;padding:0 18mm;color:#7b8382;font:8px -apple-system,sans-serif;display:flex;justify-content:space-between"><span>StudyBuddy Notes</span><span><span class="pageNumber"></span> / <span class="totalPages"></span></span></div>',
    margins: { top: 0.35, bottom: 0.55, left: 0, right: 0 }
  });
  fs.writeFileSync(outputPath, pdf);
  fs.unlinkSync(tempPath);
  window.destroy();
  process.stdout.write(`${outputPath}\n`);
  app.quit();
}).catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  app.exit(1);
});
