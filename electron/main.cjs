const { app, BrowserWindow, Menu, ipcMain, shell, dialog } = require('electron');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const APP_PORT = 17871;
let server;
let speechProcess = null;
let speechOwner = null;

const contentTypes = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.woff2': 'font/woff2',
  '.woff': 'font/woff', '.ttf': 'font/ttf',
  '.json': 'application/json', '.wasm': 'application/wasm'
};

function startLocalServer() {
  const root = path.join(__dirname, '..', 'dist');
  return new Promise((resolve, reject) => {
    server = http.createServer((request, response) => {
      const urlPath = decodeURIComponent((request.url || '/').split('?')[0]);
      let filePath = path.join(root, urlPath === '/' ? 'index.html' : urlPath);
      if (!filePath.startsWith(root)) {
        response.writeHead(403).end('Forbidden');
        return;
      }
      if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) filePath = path.join(root, 'index.html');
      response.setHeader('Content-Type', contentTypes[path.extname(filePath)] || 'application/octet-stream');
      response.setHeader('Cache-Control', 'no-cache');
      fs.createReadStream(filePath).pipe(response);
    });
    server.once('error', reject);
    server.listen(APP_PORT, '127.0.0.1', resolve);
  });
}

async function ollamaRequest(apiPath, options = {}) {
  try {
    const response = await fetch(`http://127.0.0.1:11434${apiPath}`, {
      method: options.method || 'GET',
      headers: options.headers || {},
      body: options.body || undefined
    });
    const raw = await response.text();
    let data;
    try { data = JSON.parse(raw); } catch { data = raw; }
    return { ok: response.ok, status: response.status, data };
  } catch (error) {
    return { ok: false, status: 503, data: { error: `Local AI is unavailable: ${error.message}` } };
  }
}

function installLocalAI() {
  const script = path.join(process.resourcesPath, 'tools', 'setup-local-ai.sh');
  fs.chmodSync(script, 0o755);
  spawn('/usr/bin/open', ['-a', 'Terminal', script], { detached: true, stdio: 'ignore' }).unref();
  return true;
}

function sendAppCommand(command) {
  BrowserWindow.getFocusedWindow()?.webContents.send('app:command', command);
}

function speechHelperPath() {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'bin', 'StudyBuddySpeech')
    : path.join(__dirname, '..', 'build', 'native', 'StudyBuddySpeech');
}

function sendSpeechEvent(payload) {
  if (speechOwner && !speechOwner.isDestroyed()) speechOwner.send('speech:event', payload);
}

async function startSpeechDictation(event, locale = 'en-US') {
  if (speechProcess) return { ok: true, alreadyRunning: true };
  const helper = speechHelperPath();
  if (!fs.existsSync(helper)) return { ok: false, error: 'The Apple Speech helper is missing from this build.' };
  fs.chmodSync(helper, 0o755);
  speechOwner = event.sender;
  let pending = '';
  try {
    speechProcess = spawn(helper, [String(locale || 'en-US')], { stdio: ['ignore', 'pipe', 'pipe'] });
    speechProcess.stdout.setEncoding('utf8');
    speechProcess.stdout.on('data', chunk => {
      pending += chunk;
      const lines = pending.split('\n');
      pending = lines.pop() || '';
      lines.filter(Boolean).forEach(line => {
        try { sendSpeechEvent(JSON.parse(line)); }
        catch { sendSpeechEvent({ type: 'error', message: 'Apple Speech returned an unreadable response.' }); }
      });
    });
    speechProcess.stderr.setEncoding('utf8');
    speechProcess.stderr.on('data', message => console.warn('[StudyBuddy Speech]', message.trim()));
    speechProcess.once('error', error => sendSpeechEvent({ type: 'error', message: error.message }));
    speechProcess.once('exit', code => {
      if (pending.trim()) {
        try { sendSpeechEvent(JSON.parse(pending)); } catch {}
      }
      sendSpeechEvent({ type: 'stopped', code });
      speechProcess = null;
      speechOwner = null;
    });
    return { ok: true };
  } catch (error) {
    speechProcess = null;
    speechOwner = null;
    return { ok: false, error: error.message };
  }
}

function stopSpeechDictation() {
  if (!speechProcess) return { ok: true, alreadyStopped: true };
  speechProcess.kill('SIGINT');
  return { ok: true };
}

function safePdfName(name) {
  const clean = String(name || 'Study Notes.pdf').replace(/[\\/:*?"<>|]+/g, '-').trim();
  return clean.toLowerCase().endsWith('.pdf') ? clean : `${clean}.pdf`;
}

async function exportNotesPdf(event, payload = {}) {
  const parent = BrowserWindow.fromWebContents(event.sender);
  const defaultPath = path.join(app.getPath('documents'), safePdfName(payload.defaultName));
  const selection = await dialog.showSaveDialog(parent, {
    title: 'Export Polished Study Notes',
    defaultPath,
    buttonLabel: 'Export PDF',
    filters: [{ name: 'PDF Document', extensions: ['pdf'] }]
  });
  if (selection.canceled || !selection.filePath) return { ok: false, cancelled: true };

  const exportWindow = new BrowserWindow({
    show: false,
    backgroundColor: '#ffffff',
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true }
  });
  const tempFile = path.join(app.getPath('temp'), `studybuddy-notes-${Date.now()}.html`);
  const footerLabel = payload.footerLabel === 'StudyBuddy Cheat Sheet' ? 'StudyBuddy Cheat Sheet' : 'StudyBuddy Notes';
  try {
    await fs.promises.writeFile(tempFile, String(payload.html || ''), 'utf8');
    await exportWindow.loadFile(tempFile);
    await exportWindow.webContents.executeJavaScript('document.fonts.ready.then(() => true)');
    const pdf = await exportWindow.webContents.printToPDF({
      pageSize: 'A4',
      printBackground: true,
      preferCSSPageSize: true,
      displayHeaderFooter: true,
      headerTemplate: '<span></span>',
      footerTemplate: `<div style="width:100%;padding:0 18mm;color:#7b8382;font:8px -apple-system,BlinkMacSystemFont,sans-serif;display:flex;justify-content:space-between"><span>${footerLabel}</span><span><span class="pageNumber"></span> / <span class="totalPages"></span></span></div>`,
      margins: { top: 0.35, bottom: 0.55, left: 0, right: 0 }
    });
    await fs.promises.writeFile(selection.filePath, pdf);
    return { ok: true, filePath: selection.filePath };
  } catch (error) {
    return { ok: false, cancelled: false, error: error.message };
  } finally {
    if (!exportWindow.isDestroyed()) exportWindow.destroy();
    fs.promises.unlink(tempFile).catch(() => {});
  }
}

function createWindow() {
  const window = new BrowserWindow({
    width: 1510, height: 940, minWidth: 1040, minHeight: 700,
    title: 'StudyBuddy', backgroundColor: '#111517', titleBarStyle: 'hiddenInset',
    vibrancy: 'under-window', visualEffectState: 'active',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true, nodeIntegration: false, sandbox: true
    }
  });
  window.loadURL(`http://localhost:${APP_PORT}`);
  window.webContents.setWindowOpenHandler(({ url }) => {
    const host = new URL(url).hostname;
    if (host === 'accounts.google.com' || host === 'appleid.apple.com' || host.endsWith('.apple.com') || host.endsWith('.firebaseapp.com') || host.endsWith('.googleapis.com')) return { action: 'allow' };
    if (url.startsWith('https://') || url.startsWith('http://')) shell.openExternal(url);
    return { action: 'deny' };
  });
}

function createMenu() {
  return Menu.buildFromTemplate([
    { label: 'StudyBuddy', submenu: [
      { role: 'about' }, { type: 'separator' },
      { label: 'Install Local AI…', click: installLocalAI },
      { type: 'separator' }, { role: 'services' }, { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' },
      { type: 'separator' }, { role: 'quit' }
    ]},
    { label: 'Edit', submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] },
    { label: 'Workspace', submenu: [
      { label: 'Open Buddy', accelerator: 'CmdOrCtrl+1', click: () => sendAppCommand('buddy') },
      { label: 'Open Notes', accelerator: 'CmdOrCtrl+2', click: () => sendAppCommand('notes') },
      { label: 'Edit Notes', accelerator: 'CmdOrCtrl+E', click: () => sendAppCommand('edit-notes') },
      { type: 'separator' },
      { label: 'Highlight Selection', accelerator: 'CmdOrCtrl+Shift+H', click: () => sendAppCommand('highlight-yellow') },
      { label: 'Add Selection to Notes', accelerator: 'CmdOrCtrl+Shift+N', click: () => sendAppCommand('add-note') },
      { label: 'Toggle Notes Dictation', accelerator: 'CmdOrCtrl+Shift+D', click: () => sendAppCommand('toggle-dictation') },
      { label: 'Toggle Workspace', accelerator: 'CmdOrCtrl+Alt+B', click: () => sendAppCommand('toggle-workspace') }
    ]},
    { label: 'View', submenu: [{ role: 'reload' }, { role: 'togglefullscreen' }] },
    { label: 'Window', submenu: [{ role: 'minimize' }, { role: 'zoom' }, { role: 'front' }] }
  ]);
}

ipcMain.handle('ollama:fetch', (_, apiPath, options) => ollamaRequest(apiPath, options));
ipcMain.handle('local-ai:install', installLocalAI);
ipcMain.handle('local-ai:status', () => ollamaRequest('/api/tags'));
ipcMain.handle('notes:export-pdf', exportNotesPdf);
ipcMain.handle('speech:start', startSpeechDictation);
ipcMain.handle('speech:stop', stopSpeechDictation);

app.whenReady().then(async () => {
  await startLocalServer();
  Menu.setApplicationMenu(createMenu());
  createWindow();
  app.on('activate', () => { if (!BrowserWindow.getAllWindows().length) createWindow(); });
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('before-quit', () => {
  if (speechProcess) speechProcess.kill('SIGINT');
  server?.close();
});
