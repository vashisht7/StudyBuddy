import './style.css';
import 'pdfjs-dist/web/pdf_viewer.css';
import * as pdfjsLib from 'pdfjs-dist/build/pdf.js';
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.js?url';
import 'katex/dist/katex.min.css';
import katexCss from 'katex/dist/katex.min.css?inline';
import * as mammoth from 'mammoth';
import { buildNotesExportDocument, convertMarkdownToHtml } from './notes-export.js';
import {
  auth,
  db,
  storage,
  signInAnonymously,
  GoogleAuthProvider,
  OAuthProvider,
  signInWithPopup,
  linkWithPopup,
  signOut,
  onAuthStateChanged,
  doc,
  collection,
  setDoc,
  getDoc,
  getDocs,
  ref,
  uploadBytes,
  getDownloadURL
} from './firebase.js';

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;
document.documentElement.classList.toggle('native-app', Boolean(window.studybuddy?.isNative));

// Application State
let pdfDoc = null;
let pdfScale = parseFloat(localStorage.getItem('study_pdf_scale') || '1.2');
let currentPageNum = parseInt(localStorage.getItem('study_page_num') || '1');
let pdfPagesCount = 0;
let isRenderingPage = {};
let pageRenderTasks = {};
let geminiApiKey = localStorage.getItem('study_gemini_api_key') || '';
let aiProvider = localStorage.getItem('study_ai_provider') || 'demo';
let ollamaUrl = localStorage.getItem('study_ollama_url') || 'http://localhost:11434';
let ollamaModel = localStorage.getItem('study_ollama_model') || 'gemma3:4b';
let openAIBaseUrl = localStorage.getItem('study_openai_base_url') || 'https://api.openai.com/v1';
let openAIModel = localStorage.getItem('study_openai_model') || 'gpt-4.1-mini';
let openAIApiKey = localStorage.getItem('study_openai_api_key') || '';
// Account sign-in is identity-only for this release. Workspace data stays in
// IndexedDB/localStorage even when the user signs in with Apple or Google.
const cloudSyncEnabled = false;
localStorage.removeItem('study_cloud_sync_enabled');
let firebaseAuthInitialized = false;
let flashcards = JSON.parse(localStorage.getItem('study_flashcards') || '[]');
let currentCardIndex = 0;
let selectedText = '';
let selectedTextPageNum = 1;
let selectionHighlightsMap = {};
let selectedPagesList = [];
let highlights = JSON.parse(localStorage.getItem('study_highlights') || '{}');
let activeDocumentId = null;
let activeDocumentName = '';
let activeDocumentType = 'pdf';
let activeDocumentText = '';
let initialAssistantMarkup = '';
let currentDocumentOutline = [];
let currentDocumentKind = 'document';
let currentDocumentAnalysisText = '';
let currentRagIndex = null;
let ragBuildPromise = null;

async function ollamaFetch(path, options = {}) {
  if (window.studybuddy?.ollamaFetch) {
    const result = await window.studybuddy.ollamaFetch(path, {
      method: options.method || 'GET',
      headers: options.headers || {},
      body: options.body || null
    });
    return {
      ok: result.ok,
      status: result.status,
      json: async () => result.data,
      text: async () => typeof result.data === 'string' ? result.data : JSON.stringify(result.data)
    };
  }
  return fetch(`/api/ollama${path}`, options);
}
let temporaryHighlight = null;
let pdfPageImages = {};
let currentUser = null;
let lastKnownUid = null;
let sessionAuthInitialized = false;
let activeAiResponse = '';

function cleanPdfText(text) {
  if (!text) return '';
  return text
    // Replace multiple newlines with a special placeholder
    .replace(/\r?\n\s*\r?\n/g, '___PARAGRAPH_BREAK___')
    // Replace single newlines (PDF line wraps) with a space
    .replace(/\r?\n/g, ' ')
    // Replace multiple consecutive spaces with a single space
    .replace(/\s+/g, ' ')
    // Restore the paragraph breaks as double newlines
    .replace(/___PARAGRAPH_BREAK___/g, '\n\n')
    .trim();
}

function processPdfSelection(selection) {
  if (!selection || selection.rangeCount === 0) {
    return null;
  }
  
  const range = selection.getRangeAt(0);
  let startPageNum = null;
  let endPageNum = null;
  
  // Find start page container
  let node = range.startContainer;
  while (node) {
    if (node.classList && node.classList.contains('pdf-page-container')) {
      startPageNum = parseInt(node.getAttribute('data-page'));
      break;
    }
    node = node.parentNode;
  }
  
  // Find end page container
  node = range.endContainer;
  while (node) {
    if (node.classList && node.classList.contains('pdf-page-container')) {
      endPageNum = parseInt(node.getAttribute('data-page'));
      break;
    }
    node = node.parentNode;
  }
  
  if (!startPageNum && !endPageNum) {
    return null;
  }
  if (!startPageNum) startPageNum = endPageNum;
  if (!endPageNum) endPageNum = startPageNum;
  
  const minPage = Math.min(startPageNum, endPageNum);
  const maxPage = Math.max(startPageNum, endPageNum);
  
  const highlightsMap = {};
  const pageTexts = [];
  const pagesList = [];
  
  for (let pNum = minPage; pNum <= maxPage; pNum++) {
    const pageContainer = document.getElementById(`page-container-${pNum}`);
    if (!pageContainer) continue;
    
    const textLayer = pageContainer.querySelector('.textLayer');
    if (!textLayer) continue;
    
    const spans = textLayer.querySelectorAll('span');
    const pageRect = pageContainer.getBoundingClientRect();
    const pageHeight = pageRect.height;
    
    // Get all spans that are in the selection
    const selectedSpans = [];
    spans.forEach(span => {
      if (selection.containsNode(span, true)) {
        selectedSpans.push(span);
      }
    });
    
    if (selectedSpans.length === 0) continue;
    
    // Group spans by position and build line structures
    const spanInfos = selectedSpans.map(span => {
      const spanRange = document.createRange();
      spanRange.selectNodeContents(span);
      
      if (span.contains(range.startContainer) || span === range.startContainer) {
        if (range.startContainer.nodeType === Node.TEXT_NODE) {
          spanRange.setStart(range.startContainer, range.startOffset);
        } else {
          spanRange.setStart(span, 0);
        }
      }
      if (span.contains(range.endContainer) || span === range.endContainer) {
        if (range.endContainer.nodeType === Node.TEXT_NODE) {
          spanRange.setEnd(range.endContainer, range.endOffset);
        } else {
          spanRange.setEnd(span, span.childNodes.length);
        }
      }
      
      const rect = spanRange.getBoundingClientRect();
      const text = spanRange.toString();
      
      return {
        span: span,
        rect: rect,
        left: rect.left - pageRect.left,
        top: rect.top - pageRect.top,
        width: rect.width,
        height: rect.height,
        text: text
      };
    }).filter(info => info.text.trim().length > 0 && info.width > 0 && info.height > 0);
    
    if (spanInfos.length === 0) continue;
    
    // Sort spanInfos by top position, then by left position
    spanInfos.sort((a, b) => {
      if (Math.abs(a.top - b.top) < 4) {
        return a.left - b.left;
      }
      return a.top - b.top;
    });
    
    // Group spanInfos into lines
    const lines = [];
    let currentLine = [];
    
    spanInfos.forEach(info => {
      if (currentLine.length === 0) {
        currentLine.push(info);
      } else {
        const lastInfo = currentLine[currentLine.length - 1];
        const verticalDiff = Math.abs(info.top - lastInfo.top);
        const threshold = Math.min(info.height, lastInfo.height) * 0.6;
        if (verticalDiff <= Math.max(5, threshold)) {
          currentLine.push(info);
        } else {
          lines.push(currentLine);
          currentLine = [info];
        }
      }
    });
    if (currentLine.length > 0) {
      lines.push(currentLine);
    }
    
    // Filter noise lines and collect valid spans/text
    const validRects = [];
    let prevLineBottom = null;
    let accumulatedPageText = '';
    
    lines.forEach(line => {
      let lineText = '';
      for (let i = 0; i < line.length; i++) {
        const info = line[i];
        if (i > 0) {
          const prevInfo = line[i - 1];
          const gap = info.left - (prevInfo.left + prevInfo.width);
          const needsSpace = gap > 2 && !prevInfo.text.endsWith(' ') && !info.text.startsWith(' ');
          if (needsSpace) {
            lineText += ' ';
          }
        }
        lineText += info.text;
      }
      
      const trimmedLineText = lineText.trim();
      if (!trimmedLineText) return;
      
      const avgTop = line.reduce((sum, info) => sum + info.top, 0) / line.length;
      const avgHeight = line.reduce((sum, info) => sum + info.height, 0) / line.length;
      const avgBottom = pageHeight - (avgTop + avgHeight);
      
      const relativeTopScaled = avgTop / pdfScale;
      const relativeBottomScaled = avgBottom / pdfScale;
      
      let isNoise = false;
      
      const isPageNum = /^\s*(page\s*\|?\s*)?(\d+|[ivxldm]+)(\s+of\s+\d+)?\s*$/i.test(trimmedLineText);
      if (isPageNum && (relativeTopScaled < 75 || relativeBottomScaled < 75)) {
        isNoise = true;
      }
      
      if (!isNoise && relativeTopScaled < 45) {
        const isAllCaps = trimmedLineText === trimmedLineText.toUpperCase() && /[A-Z]/.test(trimmedLineText);
        if (isAllCaps || trimmedLineText.length < 80 || /^\d+(\.\d+)*\s+[A-Z]/i.test(trimmedLineText) || /chapter/i.test(trimmedLineText)) {
          isNoise = true;
        }
      }
      
      if (!isNoise && relativeBottomScaled < 45) {
        const isAllCaps = trimmedLineText === trimmedLineText.toUpperCase() && /[A-Z]/.test(trimmedLineText);
        if (isAllCaps || trimmedLineText.length < 80 || /chapter/i.test(trimmedLineText)) {
          isNoise = true;
        }
      }
      
      if (!isNoise) {
        if (isCaptionLine(trimmedLineText)) {
          isNoise = true;
        }
      }
      
      if (isNoise) {
        console.log(`[StudyBuddy] Filtered noise line: "${trimmedLineText}" (Top: ${relativeTopScaled.toFixed(1)}, Bottom: ${relativeBottomScaled.toFixed(1)})`);
        return;
      }
      
      line.forEach(info => {
        validRects.push({
          left: info.left / pdfScale,
          top: info.top / pdfScale,
          width: info.width / pdfScale,
          height: info.height / pdfScale
        });
      });
      
      if (accumulatedPageText.length > 0) {
        const gap = avgTop - prevLineBottom;
        const prevHeight = line[0].height;
        if (gap > prevHeight * 1.5) {
          accumulatedPageText += '\n\n';
        } else {
          accumulatedPageText += '\n';
        }
      }
      
      accumulatedPageText += lineText;
      prevLineBottom = avgTop + avgHeight;
    });
    
    if (validRects.length > 0) {
      highlightsMap[pNum] = validRects;
      pageTexts.push(accumulatedPageText);
      pagesList.push(pNum);
    }
  }
  
  if (pagesList.length === 0) {
    return null;
  }
  
  const combinedText = pageTexts.join('\n\n');
  
  return {
    selectedText: cleanPdfText(combinedText),
    highlightsMap: highlightsMap,
    pagesList: pagesList,
    firstPageNum: pagesList[0]
  };
}

function getRangeBoundingClientRect(range) {
  const rects = range.getClientRects();
  if (rects.length === 0) {
    return range.getBoundingClientRect();
  }
  
  let minLeft = Infinity;
  let minTop = Infinity;
  let maxRight = -Infinity;
  let maxBottom = -Infinity;
  
  for (const r of rects) {
    if (r.width > 0 && r.height > 0) {
      if (r.left < minLeft) minLeft = r.left;
      if (r.top < minTop) minTop = r.top;
      if (r.right > maxRight) maxRight = r.right;
      if (r.bottom > maxBottom) maxBottom = r.bottom;
    }
  }
  
  if (minLeft === Infinity) {
    return range.getBoundingClientRect();
  }
  
  return {
    left: minLeft,
    top: minTop,
    right: maxRight,
    bottom: maxBottom,
    width: maxRight - minLeft,
    height: maxBottom - minTop
  };
}

function isCaptionLine(text) {
  if (/^\s*(figure|fig|table|chart|image|diagram|plate)\b\.?\s*\d*[:.\-–—]/i.test(text)) {
    return true;
  }
  if (text.length < 150 && /^\s*(figure|fig|table|chart|image|diagram|plate)\b\.?\s*\d+/i.test(text)) {
    return true;
  }
  return false;
}

function cleanRenderedTextLayer(pageContainer, textLayerDiv) {
  const spans = textLayerDiv.querySelectorAll('span');
  if (spans.length === 0) return;
  
  const pageRect = pageContainer.getBoundingClientRect();
  const pageHeight = pageRect.height;
  
  // Group spans by position and build line structures
  const spanInfos = Array.from(spans).map(span => {
    const rect = span.getBoundingClientRect();
    return {
      span: span,
      rect: rect,
      left: rect.left - pageRect.left,
      top: rect.top - pageRect.top,
      width: rect.width,
      height: rect.height,
      text: span.textContent
    };
  });
  
  // Sort spanInfos by top position, then by left position
  spanInfos.sort((a, b) => {
    if (Math.abs(a.top - b.top) < 4) {
      return a.left - b.left;
    }
    return a.top - b.top;
  });
  
  // Group spanInfos into lines
  const lines = [];
  let currentLine = [];
  
  spanInfos.forEach(info => {
    if (currentLine.length === 0) {
      currentLine.push(info);
    } else {
      const lastInfo = currentLine[currentLine.length - 1];
      const verticalDiff = Math.abs(info.top - lastInfo.top);
      const threshold = Math.min(info.height, lastInfo.height) * 0.6;
      if (verticalDiff <= Math.max(5, threshold)) {
        currentLine.push(info);
      } else {
        lines.push(currentLine);
        currentLine = [info];
      }
    }
  });
  if (currentLine.length > 0) {
    lines.push(currentLine);
  }
  
  // Check each line and mark noise spans as unselectable
  lines.forEach(line => {
    // Reconstruct line text
    let lineText = '';
    for (let i = 0; i < line.length; i++) {
      const info = line[i];
      if (i > 0) {
        const prevInfo = line[i - 1];
        const gap = info.left - (prevInfo.left + prevInfo.width);
        const needsSpace = gap > 2 && !prevInfo.text.endsWith(' ') && !info.text.startsWith(' ');
        if (needsSpace) {
          lineText += ' ';
        }
      }
      lineText += info.text;
    }
    
    const trimmedLineText = lineText.trim();
    if (!trimmedLineText) return;
    
    // Calculate average position
    const avgTop = line.reduce((sum, info) => sum + info.top, 0) / line.length;
    const avgHeight = line.reduce((sum, info) => sum + info.height, 0) / line.length;
    const avgBottom = pageHeight - (avgTop + avgHeight);
    
    // Scale positions to PDF scale (points/pixels)
    const relativeTopScaled = avgTop / pdfScale;
    const relativeBottomScaled = avgBottom / pdfScale;
    
    let isNoise = false;
    
    // 1. Page numbers / page indicators
    const isPageNum = /^\s*(page\s*\|?\s*)?(\d+|[ivxldm]+)(\s+of\s+\d+)?\s*$/i.test(trimmedLineText);
    if (isPageNum && (relativeTopScaled < 75 || relativeBottomScaled < 75)) {
      isNoise = true;
    }
    
    // 2. Running headers (top zone)
    if (!isNoise && relativeTopScaled < 45) {
      const isAllCaps = trimmedLineText === trimmedLineText.toUpperCase() && /[A-Z]/.test(trimmedLineText);
      if (isAllCaps || trimmedLineText.length < 80 || /^\d+(\.\d+)*\s+[A-Z]/i.test(trimmedLineText) || /chapter/i.test(trimmedLineText)) {
        isNoise = true;
      }
    }
    
    // 3. Running footers (bottom zone)
    if (!isNoise && relativeBottomScaled < 45) {
      const isAllCaps = trimmedLineText === trimmedLineText.toUpperCase() && /[A-Z]/.test(trimmedLineText);
      if (isAllCaps || trimmedLineText.length < 80 || /chapter/i.test(trimmedLineText)) {
        isNoise = true;
      }
    }
    
    // 4. Image / figure / table descriptions
    if (!isNoise) {
      if (isCaptionLine(trimmedLineText)) {
        isNoise = true;
      }
    }
    
    if (isNoise) {
      line.forEach(info => {
        info.span.style.userSelect = 'none';
        info.span.style.webkitUserSelect = 'none';
        info.span.style.pointerEvents = 'none';
        info.span.classList.add('pdf-noise-text');
      });
    }
  });
}

function cleanUpOffscreenPages() {
  const scrollContainer = document.getElementById('pdf-scroll-container');
  if (!scrollContainer) return;
  const containerRect = scrollContainer.getBoundingClientRect();
  
  const pages = document.querySelectorAll('.pdf-page-container');
  pages.forEach(pageContainer => {
    const pageNum = parseInt(pageContainer.getAttribute('data-page'));
    // If it's currently selected, do not unrender
    if (selectedPagesList && selectedPagesList.includes(pageNum)) {
      return;
    }
    
    // Check if it's offscreen (using the same 150px buffer as IntersectionObserver)
    const rect = pageContainer.getBoundingClientRect();
    const isOffscreen = (rect.bottom < containerRect.top - 150) || (rect.top > containerRect.bottom + 150);
    
    // If it is offscreen and currently rendered, unrender it
    if (isOffscreen && !isRenderingPage[pageNum] && pageContainer.querySelector('canvas')) {
      console.log(`[StudyBuddy] Cleaned up offscreen page ${pageNum}`);
      unrenderPage(pageNum);
    }
  });
}

// Intersection Observer for PDF lazy rendering and scroll tracking
let pageObserver = null;

// ==========================================================================
// Local Storage for Large Files (IndexedDB)
// ==========================================================================
const DB_NAME = 'StudyBuddyDB';
const DB_VERSION = 3;
const STORE_NAME = 'pdf_store';
const LIBRARY_STORE_NAME = 'document_library';
const RAG_STORE_NAME = 'rag_indexes';

function openDB() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME);
      }
      if (!db.objectStoreNames.contains(LIBRARY_STORE_NAME)) {
        db.createObjectStore(LIBRARY_STORE_NAME, { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains(RAG_STORE_NAME)) {
        db.createObjectStore(RAG_STORE_NAME, { keyPath: 'documentId' });
      }
    };
    request.onsuccess = (e) => resolve(e.target.result);
    request.onerror = (e) => reject(e.target.error);
  });
}

function documentSessionKey(id) {
  return `study_document_session_${id}`;
}

function normalizeBuddyMarkup(markup = initialAssistantMarkup) {
  return String(markup || initialAssistantMarkup)
    .replace(/How can I help with this document\?/g, 'Your reading buddy is ready.')
    .replace(/Ask about any chapter, topic, definition, or idea in this document\./g, 'Ask Buddy about any chapter, topic, definition, or idea in this document.')
    .replace(/Study AI Assistant/gi, 'Buddy');
}

function createDocumentId(fileName, size = 0, stamp = Date.now()) {
  const source = `${fileName}-${size}-${stamp}`.toLowerCase();
  let hash = 0;
  for (let index = 0; index < source.length; index++) {
    hash = ((hash << 5) - hash + source.charCodeAt(index)) | 0;
  }
  return `doc-${Math.abs(hash).toString(36)}`;
}

async function saveLibraryDocument(record) {
  const db = await openDB();
  const tx = db.transaction(LIBRARY_STORE_NAME, 'readwrite');
  tx.objectStore(LIBRARY_STORE_NAME).put(record);
  return new Promise((resolve, reject) => {
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
}

async function getLibraryDocuments() {
  const db = await openDB();
  const tx = db.transaction(LIBRARY_STORE_NAME, 'readonly');
  const request = tx.objectStore(LIBRARY_STORE_NAME).getAll();
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result || []);
    request.onerror = () => reject(request.error);
  });
}

async function getLibraryDocument(id) {
  const db = await openDB();
  const tx = db.transaction(LIBRARY_STORE_NAME, 'readonly');
  const request = tx.objectStore(LIBRARY_STORE_NAME).get(id);
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result || null);
    request.onerror = () => reject(request.error);
  });
}

async function saveRagIndex(index) {
  const db = await openDB();
  const tx = db.transaction(RAG_STORE_NAME, 'readwrite');
  tx.objectStore(RAG_STORE_NAME).put(index);
  return new Promise((resolve, reject) => {
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
}

async function getRagIndex(documentId) {
  const db = await openDB();
  const tx = db.transaction(RAG_STORE_NAME, 'readonly');
  const request = tx.objectStore(RAG_STORE_NAME).get(documentId);
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result || null);
    request.onerror = () => reject(request.error);
  });
}

function saveActiveDocumentSession() {
  if (!activeDocumentId) return;
  const notes = document.getElementById('notes-textarea')?.value || '';
  const chat = document.getElementById('chat-messages')?.innerHTML || initialAssistantMarkup;
  localStorage.setItem(documentSessionKey(activeDocumentId), JSON.stringify({
    notes,
    chat,
    notesDocumentId: activeDocumentId,
    chatDocumentId: activeDocumentId,
    documentName: activeDocumentName,
    page: currentPageNum,
    scale: pdfScale,
    highlights,
    outline: currentDocumentOutline,
    documentKind: currentDocumentKind,
    outlineVersion: 9,
    updatedAt: Date.now()
  }));
}

function persistActiveNotes() {
  if (!activeDocumentId) return;
  saveActiveDocumentSession();
  showSaveStatus('Saved to this workspace');
}

function restoreDocumentSession(id) {
  let session = {};
  try { session = JSON.parse(localStorage.getItem(documentSessionKey(id)) || '{}'); } catch (_) {}
  currentPageNum = session.page || 1;
  pdfScale = session.scale || 1.2;
  highlights = session.highlights || {};
  currentDocumentOutline = session.outlineVersion === 9 ? (session.outline || []) : [];
  currentDocumentKind = session.documentKind || 'document';
  const notes = document.getElementById('notes-textarea');
  const chat = document.getElementById('chat-messages');
  if (notes) notes.value = session.notes || '';
  const chatBelongsToDocument = session.chatDocumentId === id;
  if (chat) chat.innerHTML = chatBelongsToDocument ? normalizeBuddyMarkup(session.chat) : initialAssistantMarkup;
  localStorage.setItem('study_highlights', JSON.stringify(highlights));
  document.getElementById('zoom-text').textContent = `${Math.round(pdfScale * 100)}%`;
  if (currentDocumentOutline.length) renderDocumentOutline(currentDocumentOutline, currentDocumentKind);
}

function formatDocumentDate(timestamp) {
  return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(new Date(timestamp));
}

function documentExtension(fileName = '') {
  return fileName.includes('.') ? fileName.split('.').pop().toLowerCase() : 'txt';
}

function documentTypeLabel(fileName = '') {
  const extension = documentExtension(fileName);
  if (extension === 'pdf') return 'PDF';
  if (extension === 'docx') return 'DOCX';
  if (['md', 'markdown'].includes(extension)) return 'MD';
  return extension.toUpperCase().slice(0, 5) || 'TEXT';
}

function isPdfDocument(record) {
  return documentExtension(record?.fileName) === 'pdf';
}

async function renderLibrary() {
  const grid = document.getElementById('library-grid');
  const empty = document.getElementById('library-empty');
  if (!grid || !empty) return;
  const documents = (await getLibraryDocuments()).sort((a, b) => b.updatedAt - a.updatedAt);
  grid.innerHTML = '';
  empty.style.display = documents.length ? 'none' : 'flex';
  grid.style.display = documents.length ? 'grid' : 'none';

  documents.forEach((documentRecord, index) => {
    let session = {};
    try { session = JSON.parse(localStorage.getItem(documentSessionKey(documentRecord.id)) || '{}'); } catch (_) {}
    const card = document.createElement('button');
    card.className = 'document-card';
    card.dataset.documentId = documentRecord.id;
    card.style.setProperty('--card-index', index);
    card.innerHTML = `
      <span class="document-cover">
        <span class="document-fold"></span>
        <span class="document-lines"><i></i><i></i><i></i></span>
        <span class="document-type">${documentTypeLabel(documentRecord.fileName)}</span>
      </span>
      <span class="document-info">
        <strong>${escapeHtml(documentRecord.fileName.replace(/\.[^.]+$/i, ''))}</strong>
        <span>${isPdfDocument(documentRecord) && session.page ? `Page ${session.page} · ` : ''}${formatDocumentDate(documentRecord.updatedAt)}</span>
      </span>
      <span class="document-arrow">→</span>`;
    card.addEventListener('click', () => openLibraryDocument(documentRecord.id));
    grid.appendChild(card);
  });
}

async function openLibraryDocument(id) {
  saveActiveDocumentSession();
  const record = await getLibraryDocument(id);
  if (!record) return;
  activeDocumentId = id;
  activeDocumentName = record.fileName;
  activeDocumentType = documentExtension(record.fileName);
  currentRagIndex = null;
  ragBuildPromise = null;
  selectedText = '';
  restoreDocumentSession(id);
  const notesLabel = document.getElementById('notes-document-label');
  if (notesLabel) notesLabel.textContent = `Notes · ${record.fileName.replace(/\.[^.]+$/i, '')}`;
  document.getElementById('app').classList.remove('library-mode');
  document.getElementById('welcome-screen').style.display = 'none';
  document.getElementById('workspace-panel').classList.remove('collapsed');
  document.getElementById('btn-toggle-sidebar').classList.add('active');
  if (isPdfDocument(record)) {
    document.getElementById('app').classList.remove('text-document-mode');
    document.getElementById('text-document-container').style.display = 'none';
    document.getElementById('pdf-scroll-container').style.display = 'flex';
    await loadPdfDoc(new Uint8Array(record.arrayBuffer));
  } else {
    await openTextDocument(record);
  }
  await loadActiveDocumentCloudSession();
}

async function showLibrary() {
  saveActiveDocumentSession();
  activeDocumentId = null;
  activeDocumentName = '';
  activeDocumentText = '';
  currentRagIndex = null;
  ragBuildPromise = null;
  document.getElementById('app').classList.add('library-mode');
  document.getElementById('welcome-screen').style.display = 'flex';
  document.getElementById('pdf-scroll-container').style.display = 'none';
  document.getElementById('text-document-container').style.display = 'none';
  document.getElementById('app').classList.remove('text-document-mode');
  document.getElementById('workspace-panel').classList.add('collapsed');
  document.getElementById('btn-toggle-sidebar').classList.remove('active');
  await renderLibrary();
}

// Each signed-in account gets its own IndexedDB key so switching accounts
// in the same browser never shows another account's cached PDF.
function activePdfKey() {
  return currentUser ? `active_pdf_${currentUser.uid}` : 'active_pdf_guest';
}

async function savePdfToIndexedDB(arrayBuffer, fileName) {
  try {
    const db = await openDB();
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    store.put({ arrayBuffer, fileName }, activePdfKey());
    return new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } catch (err) {
    console.error('Failed to save PDF to IndexedDB:', err);
  }
}

async function getPdfFromIndexedDB() {
  try {
    const db = await openDB();
    const tx = db.transaction(STORE_NAME, 'readonly');
    const store = tx.objectStore(STORE_NAME);
    const request = store.get(activePdfKey());
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  } catch (err) {
    console.error('Failed to get PDF from IndexedDB:', err);
    return null;
  }
}

async function restorePersistedPdf() {
  try {
    const saved = await getPdfFromIndexedDB();
    if (saved && saved.arrayBuffer) {
      // Clear and hide welcome
      document.getElementById('welcome-screen').style.display = 'none';
      const scrollContainer = document.getElementById('pdf-scroll-container');
      scrollContainer.style.display = 'flex';

      addSystemChatMessage(`Restoring saved document: <strong>${saved.fileName}</strong>...`, "primary");

      const typedarray = new Uint8Array(saved.arrayBuffer);
      await loadPdfDoc(typedarray);
      return true;
    }
  } catch (err) {
    console.error("Failed to restore PDF from IndexedDB", err);
  }
  return false;
}

function safeCloudFileName(fileName) {
  return (fileName || 'document.pdf').replace(/[^a-z0-9._-]+/gi, '-');
}

// Every PDF has its own private Storage object and Firestore workspace
// document. The RAG index is derived locally from the PDF on each device.
async function uploadPdfToCloud(arrayBuffer, fileName, documentId = activeDocumentId) {
  if (!cloudSyncEnabled || !currentUser || !documentId) return;
  const bytes = arrayBuffer instanceof ArrayBuffer ? arrayBuffer : arrayBuffer.buffer;
  try {
    const storagePath = `users/${currentUser.uid}/documents/${documentId}/${safeCloudFileName(fileName)}`;
    await uploadBytes(ref(storage, storagePath), bytes);

    const documentDocRef = doc(db, 'users', currentUser.uid, 'documents', documentId);
    await setDoc(documentDocRef, {
      documentId,
      fileName,
      size: bytes.byteLength,
      fileStoragePath: storagePath,
      pdfStoragePath: storagePath,
      documentType: documentExtension(fileName),
      updatedAt: new Date().toISOString()
    }, { merge: true });
  } catch (err) {
    console.error('Failed to upload PDF to cloud', err);
    addSystemChatMessage("Could not sync this PDF to your account's cloud storage.", "warning");
  }
}

async function syncLocalLibraryToCloud() {
  if (!cloudSyncEnabled || !currentUser) return;
  const localDocuments = await getLibraryDocuments();
  for (const record of localDocuments) {
    try {
      const cloudRef = doc(db, 'users', currentUser.uid, 'documents', record.id);
      const cloudSnapshot = await getDoc(cloudRef);
      const cloudData = cloudSnapshot.exists() ? cloudSnapshot.data() : null;
      if ((cloudData?.fileStoragePath || cloudData?.pdfStoragePath) && Number(cloudData.size) === Number(record.size)) continue;
      await uploadPdfToCloud(record.arrayBuffer, record.fileName, record.id);
    } catch (error) {
      console.warn(`Could not upload ${record.fileName}`, error);
    }
  }
}

async function syncCloudLibraryToLocal() {
  if (!cloudSyncEnabled || !currentUser) return;
  try {
    const documentsRef = collection(db, 'users', currentUser.uid, 'documents');
    const cloudDocuments = await getDocs(documentsRef);
    for (const cloudSnapshot of cloudDocuments.docs) {
      const data = cloudSnapshot.data();
      const documentId = data.documentId || cloudSnapshot.id;
      const storagePath = data.fileStoragePath || data.pdfStoragePath;
      if (!storagePath || !data.fileName) continue;

      let localRecord = await getLibraryDocument(documentId);
      if (!localRecord) {
        const url = await getDownloadURL(ref(storage, storagePath));
        const response = await fetch(url);
        if (!response.ok) throw new Error(`Could not download ${data.fileName}`);
        const arrayBuffer = await response.arrayBuffer();
        localRecord = {
          id: documentId,
          arrayBuffer,
          fileName: data.fileName,
          size: data.size || arrayBuffer.byteLength,
          updatedAt: Date.parse(data.updatedAt) || Date.now()
        };
        await saveLibraryDocument(localRecord);
      }

      let localSession = {};
      try { localSession = JSON.parse(localStorage.getItem(documentSessionKey(documentId)) || '{}'); } catch (_) {}
      const cloudUpdatedAt = Date.parse(data.updatedAt) || 0;
      if (cloudUpdatedAt > Number(localSession.updatedAt || 0)) {
        localStorage.setItem(documentSessionKey(documentId), JSON.stringify({
          notes: data.notes || '',
          chat: normalizeBuddyMarkup(data.chat),
          notesDocumentId: documentId,
          chatDocumentId: documentId,
          documentName: data.fileName,
          page: data.currentPageNum || 1,
          scale: data.pdfScale || 1.2,
          highlights: data.highlights || {},
          outline: data.outline || [],
          documentKind: data.documentKind || 'document',
          outlineVersion: 9,
          updatedAt: cloudUpdatedAt
        }));
      }
    }
  } catch (err) {
    console.error("Failed to sync this account's cloud library", err);
    addSystemChatMessage("Could not refresh the cloud library. Local documents remain available.", "warning");
  }
}

// ==========================================================================
// Area Capture (Snipping) Tool
// ==========================================================================
let isCaptureModeActive = false;
let captureStartPageNum = null;
let captureStartX = 0;
let captureStartY = 0;
let captureSelectionBox = null;
let activeCapturePageContainer = null;

function initCaptureMode() {
  const btnCapture = document.getElementById('btn-capture-mode');
  const scrollContainer = document.getElementById('pdf-scroll-container');
  if (!btnCapture || !scrollContainer) return;

  btnCapture.addEventListener('click', () => {
    toggleCaptureMode();
  });

  // Event delegation on page containers
  scrollContainer.addEventListener('mousedown', (e) => {
    if (!isCaptureModeActive) return;
    
    // Find closest page container
    const pageContainer = e.target.closest('.pdf-page-container');
    if (!pageContainer) return;
    
    e.preventDefault();
    activeCapturePageContainer = pageContainer;
    captureStartPageNum = parseInt(pageContainer.getAttribute('data-page'));
    
    const rect = pageContainer.getBoundingClientRect();
    captureStartX = e.clientX - rect.left;
    captureStartY = e.clientY - rect.top;
    
    // Create selection box element
    captureSelectionBox = document.createElement('div');
    captureSelectionBox.className = 'capture-selection-box';
    captureSelectionBox.style.left = `${captureStartX}px`;
    captureSelectionBox.style.top = `${captureStartY}px`;
    captureSelectionBox.style.width = '0px';
    captureSelectionBox.style.height = '0px';
    
    pageContainer.appendChild(captureSelectionBox);
    
    // Listen for mousemove and mouseup on document to handle bounds outside the container
    document.addEventListener('mousemove', onCaptureMouseMove);
    document.addEventListener('mouseup', onCaptureMouseUp);
  });
}

function toggleCaptureMode(forceState) {
  const btnCapture = document.getElementById('btn-capture-mode');
  const scrollContainer = document.getElementById('pdf-scroll-container');
  if (!btnCapture || !scrollContainer) return;

  isCaptureModeActive = forceState !== undefined ? forceState : !isCaptureModeActive;

  if (isCaptureModeActive) {
    btnCapture.classList.add('active');
    scrollContainer.classList.add('capture-mode-active');
    addSystemChatMessage("📸 <strong>Capture Mode Active</strong>: Click and drag over any part of the PDF to copy it as an image.", "primary");
  } else {
    btnCapture.classList.remove('active');
    scrollContainer.classList.remove('capture-mode-active');
    // Clean up box if it exists
    if (captureSelectionBox && captureSelectionBox.parentNode) {
      captureSelectionBox.parentNode.removeChild(captureSelectionBox);
    }
    captureSelectionBox = null;
    activeCapturePageContainer = null;
  }
}

function onCaptureMouseMove(e) {
  if (!activeCapturePageContainer || !captureSelectionBox) return;
  
  const rect = activeCapturePageContainer.getBoundingClientRect();
  const currentX = Math.max(0, Math.min(e.clientX - rect.left, rect.width));
  const currentY = Math.max(0, Math.min(e.clientY - rect.top, rect.height));
  
  const x = Math.min(captureStartX, currentX);
  const y = Math.min(captureStartY, currentY);
  const width = Math.abs(captureStartX - currentX);
  const height = Math.abs(captureStartY - currentY);
  
  captureSelectionBox.style.left = `${x}px`;
  captureSelectionBox.style.top = `${y}px`;
  captureSelectionBox.style.width = `${width}px`;
  captureSelectionBox.style.height = `${height}px`;
}

async function onCaptureMouseUp(e) {
  document.removeEventListener('mousemove', onCaptureMouseMove);
  document.removeEventListener('mouseup', onCaptureMouseUp);
  
  if (!activeCapturePageContainer || !captureSelectionBox) return;
  
  const width = parseFloat(captureSelectionBox.style.width);
  const height = parseFloat(captureSelectionBox.style.height);
  const left = parseFloat(captureSelectionBox.style.left);
  const top = parseFloat(captureSelectionBox.style.top);
  
  // Clean up the UI selection box immediately
  if (captureSelectionBox && captureSelectionBox.parentNode) {
    captureSelectionBox.parentNode.removeChild(captureSelectionBox);
  }
  captureSelectionBox = null;
  
  const targetPageNum = captureStartPageNum;
  const pageContainer = activeCapturePageContainer;
  
  // Deactivate capture mode visually
  toggleCaptureMode(false);
  
  if (width < 5 || height < 5) {
    // Too small, user probably just clicked without dragging
    activeCapturePageContainer = null;
    return;
  }
  
  try {
    const canvas = pageContainer.querySelector('canvas');
    if (!canvas) throw new Error("Could not find canvas on page.");
    
    const canvasRect = canvas.getBoundingClientRect();
    
    // Map selection coordinates to actual raw canvas coordinates
    const scaleX = canvas.width / canvasRect.width;
    const scaleY = canvas.height / canvasRect.height;
    
    const cropX = left * scaleX;
    const cropY = top * scaleY;
    const cropWidth = width * scaleX;
    const cropHeight = height * scaleY;
    
    // Draw cropped portion to an offscreen canvas
    const cropCanvas = document.createElement('canvas');
    cropCanvas.width = cropWidth;
    cropCanvas.height = cropHeight;
    const cropCtx = cropCanvas.getContext('2d');
    
    cropCtx.drawImage(canvas, cropX, cropY, cropWidth, cropHeight, 0, 0, cropWidth, cropHeight);
    
    const base64Data = cropCanvas.toDataURL('image/png');
    
    // 1. Copy image to Clipboard as PNG Blob
    cropCanvas.toBlob(async (blob) => {
      try {
        await navigator.clipboard.write([
          new ClipboardItem({ 'image/png': blob })
        ]);
        addSystemChatMessage(`📸 Successfully captured area of page ${targetPageNum} and copied it to your clipboard!`, "success");
      } catch (err) {
        console.error("Clipboard copy failure", err);
      }
    }, 'image/png');
    
    // 2. Show confirm dialog to Add to Notes or Discard
    const captureDialog = document.getElementById('capture-dialog');
    const previewImg = document.getElementById('capture-preview-img');
    const btnDiscard = document.getElementById('btn-capture-discard');
    const btnAddNote = document.getElementById('btn-capture-add-note');
    
    if (captureDialog && previewImg && btnDiscard && btnAddNote) {
      previewImg.src = base64Data;
      
      // Clean up previous event listeners (to prevent duplicate additions)
      const newBtnDiscard = btnDiscard.cloneNode(true);
      const newBtnAddNote = btnAddNote.cloneNode(true);
      btnDiscard.parentNode.replaceChild(newBtnDiscard, btnDiscard);
      btnAddNote.parentNode.replaceChild(newBtnAddNote, btnAddNote);
      
      newBtnDiscard.addEventListener('click', () => {
        captureDialog.close();
      });
      
      newBtnAddNote.addEventListener('click', () => {
        const notesTextarea = document.getElementById('notes-textarea');
        if (notesTextarea) {
          const markdownImage = `\n\n![Captured Image (Page ${targetPageNum})](${base64Data})\n\n`;
          notesTextarea.value += markdownImage;
          
          // Save only to the currently open document workspace.
          persistActiveNotes();
          saveSessionToCloud();
          
          // Switch to Notes tab
          const notesTabBtn = document.getElementById('tab-btn-notes');
          if (notesTabBtn) {
            notesTabBtn.click();
          }
          addSystemChatMessage("Appended the captured image directly to Notes.", "success");
        }
        captureDialog.close();
      });
      
      captureDialog.showModal();
    }
    
  } catch (err) {
    console.error("Area capture failed", err);
    addSystemChatMessage(`Area capture failed: ${err.message}`, "error");
  }
  
  activeCapturePageContainer = null;
}

// Initialize application on load
document.addEventListener('DOMContentLoaded', () => {
  initialAssistantMarkup = document.getElementById('chat-messages')?.innerHTML || '';
  initResizer();
  initTabs();
  initSettings();
  initUploads();
  initPdfControls();
  initFloatingToolbar();
  initNotesEditor();
  initImageSelectionTracker();
  initSidebarToggle();
  initCaptureMode();
  initDocumentOutline();
  initTextDocumentEditor();
  initCustomSelects();
  initNotesDictation();
  initKeyboardShortcuts();
  
  // Try loading API status
  updateApiStatusDisplay();

  // PDF restoration is handled per-account once Firebase Auth resolves
  // (see onAuthStateChanged in initFirebaseAuth), so each account only
  // ever sees its own document.

  // Initialize Firebase Auth
  initFirebaseAuth();
  document.getElementById('btn-home')?.addEventListener('click', showLibrary);
  document.getElementById('notes-textarea')?.addEventListener('input', debounce(saveActiveDocumentSession, 350));
  window.addEventListener('beforeunload', saveActiveDocumentSession);
  showLibrary();
});

function initCustomSelects() {
  document.querySelectorAll('select').forEach((select) => {
    if (select.dataset.liquidSelect === 'true') return;
    select.dataset.liquidSelect = 'true';

    const shell = document.createElement('div');
    shell.className = 'liquid-select';
    select.parentNode.insertBefore(shell, select);
    shell.appendChild(select);

    const trigger = document.createElement('button');
    trigger.type = 'button';
    trigger.className = 'liquid-select-trigger';
    trigger.setAttribute('aria-haspopup', 'listbox');
    trigger.setAttribute('aria-expanded', 'false');
    trigger.innerHTML = '<span></span><i aria-hidden="true"></i>';

    const menu = document.createElement('div');
    menu.className = 'liquid-select-menu';
    menu.setAttribute('role', 'listbox');
    menu.setAttribute('popover', 'auto');
    shell.append(trigger, menu);

    const positionMenu = () => {
      const rect = trigger.getBoundingClientRect();
      menu.style.left = `${Math.max(10, Math.min(rect.left, window.innerWidth - Math.max(rect.width, 220) - 10))}px`;
      menu.style.top = `${Math.min(rect.bottom + 7, window.innerHeight - Math.min(menu.scrollHeight || 280, 280) - 12)}px`;
      menu.style.width = `${Math.max(rect.width, 220)}px`;
    };

    const sync = () => {
      const selected = select.options[select.selectedIndex];
      trigger.querySelector('span').textContent = selected?.textContent || 'Choose';
      menu.querySelectorAll('[role="option"]').forEach((option) => {
        const active = option.dataset.value === select.value;
        option.classList.toggle('selected', active);
        option.setAttribute('aria-selected', String(active));
      });
      trigger.disabled = select.disabled;
    };

    const rebuild = () => {
      menu.innerHTML = '';
      [...select.options].forEach((nativeOption) => {
        const option = document.createElement('button');
        option.type = 'button';
        option.className = 'liquid-select-option';
        option.dataset.value = nativeOption.value;
        option.setAttribute('role', 'option');
        option.disabled = nativeOption.disabled;
        option.innerHTML = '<span></span><i aria-hidden="true">✓</i>';
        option.querySelector('span').textContent = nativeOption.textContent;
        option.addEventListener('click', () => {
          select.value = nativeOption.value;
          select.dispatchEvent(new Event('change', { bubbles: true }));
          menu.hidePopover?.();
          trigger.focus();
          sync();
        });
        menu.appendChild(option);
      });
      sync();
    };

    trigger.addEventListener('click', () => {
      positionMenu();
      if (menu.matches(':popover-open')) menu.hidePopover();
      else menu.showPopover?.();
    });
    trigger.addEventListener('keydown', (event) => {
      if (!['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(event.key)) return;
      event.preventDefault();
      positionMenu();
      if (!menu.matches(':popover-open')) menu.showPopover?.();
      const options = [...menu.querySelectorAll('.liquid-select-option:not(:disabled)')];
      const selectedIndex = options.findIndex(option => option.classList.contains('selected'));
      const target = event.key === 'ArrowUp'
        ? options[Math.max(0, selectedIndex - 1)]
        : options[Math.min(options.length - 1, selectedIndex + 1)];
      target?.focus();
    });
    menu.addEventListener('toggle', () => trigger.setAttribute('aria-expanded', String(menu.matches(':popover-open'))));
    select.addEventListener('change', sync);
    window.addEventListener('resize', () => { if (menu.matches(':popover-open')) positionMenu(); });
    new MutationObserver(rebuild).observe(select, { childList: true, subtree: true, attributes: true });
    document.querySelector(`label[for="${CSS.escape(select.id)}"]`)?.addEventListener('click', (event) => {
      event.preventDefault();
      trigger.focus();
      trigger.click();
    });
    rebuild();
  });
}

// ==========================================================================
// Split Pane Resizing
// ==========================================================================
function initResizer() {
  const divider = document.getElementById('split-divider');
  const viewerPanel = document.getElementById('pdf-viewer-panel');
  const workspacePanel = document.getElementById('workspace-panel');
  
  let isDragging = false;
  
  divider.addEventListener('mousedown', (e) => {
    isDragging = true;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  });
  
  document.addEventListener('mousemove', (e) => {
    if (!isDragging) return;
    const workspaceWidth = window.innerWidth - e.clientX;
    // Bounds check
    if (workspaceWidth > 320 && workspaceWidth < window.innerWidth - 200) {
      workspacePanel.style.width = `${workspaceWidth}px`;
    }
  });
  
  document.addEventListener('mouseup', () => {
    if (isDragging) {
      isDragging = false;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      
      // Trigger pdf layout updates due to width changes
      if (pdfDoc) {
        // Redraw active pages
        const visiblePages = getVisiblePageNumbers();
        visiblePages.forEach(num => {
          rerenderPage(num);
        });
      }
    }
  });
}

function getVisiblePageNumbers() {
  const visible = [];
  document.querySelectorAll('.pdf-page-container').forEach(el => {
    const rect = el.getBoundingClientRect();
    // If element is partially visible in the viewport
    if (rect.bottom > 64 && rect.top < window.innerHeight) {
      visible.push(parseInt(el.getAttribute('data-page')));
    }
  });
  return visible;
}

// ==========================================================================
// Workspace Tab Controls
// ==========================================================================
function initTabs() {
  const tabButtons = document.querySelectorAll('.tab-btn');
  const tabPanes = document.querySelectorAll('.tab-pane');
  
  tabButtons.forEach(btn => {
    btn.addEventListener('click', () => {
      const targetTab = btn.getAttribute('data-tab');
      const nextPane = document.getElementById(targetTab);
      if (!nextPane || btn.classList.contains('active')) return;
      const currentIndex = Array.from(tabButtons).findIndex(button => button.classList.contains('active'));
      const nextIndex = Array.from(tabButtons).indexOf(btn);

      tabButtons.forEach(b => b.classList.remove('active'));
      tabPanes.forEach(p => p.classList.remove('active'));

      btn.classList.add('active');
      nextPane.style.setProperty('--tab-direction', nextIndex >= currentIndex ? '1' : '-1');
      nextPane.classList.add('active');
    });
  });
}

function performStudyShortcut(action) {
  const toolbar = document.getElementById('floating-toolbar');
  if (action === 'buddy') document.getElementById('tab-btn-ai')?.click();
  if (action === 'notes') document.getElementById('tab-btn-notes')?.click();
  if (action === 'toggle-workspace') document.getElementById('btn-toggle-sidebar')?.click();
  if (action === 'toggle-dictation') document.getElementById('btn-notes-dictation')?.click();
  if (action === 'edit-notes') {
    document.getElementById('tab-btn-notes')?.click();
    document.getElementById('editor-btn-write')?.click();
    document.getElementById('notes-textarea')?.focus();
  }
  if (action === 'highlight-yellow' && selectedText && Object.keys(selectionHighlightsMap || {}).length) {
    applyHighlight('yellow');
    if (toolbar) toolbar.style.display = 'none';
  }
  if (action === 'add-note' && selectedText) {
    appendToLocalFile(selectedText, selectedTextPageNum);
    clearTemporaryHighlight();
    window.getSelection()?.removeAllRanges();
    if (toolbar) toolbar.style.display = 'none';
  }
}

function initKeyboardShortcuts() {
  window.studybuddy?.onAppCommand?.(performStudyShortcut);
  document.addEventListener('keydown', (event) => {
    const command = event.metaKey || event.ctrlKey;
    if (!command) {
      if (event.key === 'Escape') {
        const toolbar = document.getElementById('floating-toolbar');
        if (toolbar) toolbar.style.display = 'none';
        clearTemporaryHighlight();
      }
      return;
    }

    const key = event.key.toLowerCase();
    const notesEditor = document.getElementById('notes-textarea');
    const editingNotes = document.activeElement === notesEditor;
    let action = null;

    if (!event.shiftKey && key === '1') action = 'buddy';
    if (!event.shiftKey && key === '2') action = 'notes';
    if (!event.shiftKey && key === 'e') action = 'edit-notes';
    if (event.altKey && key === 'b') action = 'toggle-workspace';
    if (event.shiftKey && key === 'h') action = 'highlight-yellow';
    if (event.shiftKey && key === 'n') action = 'add-note';

    if (editingNotes && !event.shiftKey && key === 'b') {
      event.preventDefault();
      document.getElementById('editor-btn-bold')?.click();
      return;
    }
    if (editingNotes && !event.shiftKey && key === 'i') {
      event.preventDefault();
      document.getElementById('editor-btn-italic')?.click();
      return;
    }
    if (editingNotes && event.shiftKey && key === 'm') {
      event.preventDefault();
      document.getElementById('editor-btn-inline-math')?.click();
      return;
    }

    if (action) {
      event.preventDefault();
      performStudyShortcut(action);
    }
  });
}

// ==========================================================================
// Settings Dialog & API Management
// ==========================================================================
function initSettings() {
  const dialog = document.getElementById('settings-dialog');
  const btnOpen = document.getElementById('btn-api-settings');
  const btnClose = document.getElementById('btn-close-settings');
  const btnSave = document.getElementById('btn-save-settings');
  
  const providerSelect = document.getElementById('ai-provider');
  const groupGemini = document.getElementById('settings-group-gemini');
  const groupOpenAI = document.getElementById('settings-group-openai');
  const groupOllama = document.getElementById('settings-group-ollama');
  
  const inputKey = document.getElementById('gemini-api-key');
  const inputOpenAIUrl = document.getElementById('openai-base-url');
  const inputOpenAIModel = document.getElementById('openai-model');
  const inputOpenAIKey = document.getElementById('openai-api-key');
  const inputOllamaUrl = document.getElementById('ollama-url');
  const selectOllamaModel = document.getElementById('ollama-model-select');
  const btnScan = document.getElementById('btn-refresh-models');
  const statusOllama = document.getElementById('ollama-status-text');
  const nativeInstallButton = document.getElementById('btn-native-install-ai');

  if (window.studybuddy?.isNative && nativeInstallButton) {
    nativeInstallButton.style.display = 'inline-flex';
    nativeInstallButton.addEventListener('click', async () => {
      await window.studybuddy.installLocalAI();
      statusOllama.textContent = 'Installer opened in Terminal. Return here and click Scan when it finishes.';
      statusOllama.style.color = 'var(--aqua)';
    });
  }
  
  function toggleSettingsGroups() {
    const val = providerSelect.value;
    groupGemini.style.display = val === 'gemini' ? 'flex' : 'none';
    groupOpenAI.style.display = val === 'openai-compatible' ? 'flex' : 'none';
    groupOllama.style.display = val === 'ollama' ? 'flex' : 'none';
  }
  
  providerSelect.addEventListener('change', toggleSettingsGroups);
  
  btnOpen.addEventListener('click', () => {
    providerSelect.value = aiProvider;
    inputKey.value = geminiApiKey;
    inputOpenAIUrl.value = openAIBaseUrl;
    inputOpenAIModel.value = openAIModel;
    inputOpenAIKey.value = openAIApiKey;
    inputOllamaUrl.value = ollamaUrl;
    
    // Add active model option to select if not already present
    let exists = Array.from(selectOllamaModel.options).some(opt => opt.value === ollamaModel);
    if (!exists && ollamaModel) {
      const opt = document.createElement('option');
      opt.value = ollamaModel;
      opt.textContent = `${ollamaModel} (Active)`;
      selectOllamaModel.appendChild(opt);
    }
    selectOllamaModel.value = ollamaModel;
    providerSelect.dispatchEvent(new Event('change', { bubbles: true }));
    selectOllamaModel.dispatchEvent(new Event('change', { bubbles: true }));
    
    toggleSettingsGroups();
    updateApiStatusDisplay();
    dialog.showModal();
  });
  
  btnClose.addEventListener('click', () => {
    dialog.close();
  });
  
  btnScan.addEventListener('click', async () => {
    btnScan.disabled = true;
    btnScan.classList.add('is-scanning');
    statusOllama.textContent = "Scanning local models...";
    statusOllama.style.color = "var(--text-secondary)";
    
    try {
      const response = await ollamaFetch('/api/tags');
      if (!response.ok) throw new Error("Connection failed");
      
      const data = await response.json();
      const models = data.models || [];
      
      selectOllamaModel.innerHTML = '';
      if (models.length === 0) {
        selectOllamaModel.innerHTML = '<option value="gemma">gemma (Default)</option>';
        statusOllama.textContent = "Connected! No local models found. Pull gemma first.";
        statusOllama.style.color = "var(--accent-amber)";
      } else {
        models.forEach(m => {
          const opt = document.createElement('option');
          opt.value = m.name;
          opt.textContent = m.name;
          selectOllamaModel.appendChild(opt);
        });
        
        // Restore selected model if found
        if (models.some(m => m.name === ollamaModel)) {
          selectOllamaModel.value = ollamaModel;
        }
        selectOllamaModel.dispatchEvent(new Event('change', { bubbles: true }));
        statusOllama.textContent = `Successfully detected ${models.length} model(s).`;
        statusOllama.style.color = "var(--accent-emerald)";
      }
    } catch (err) {
      console.warn("Ollama scan failed", err);
      statusOllama.textContent = "Server offline. Ensure Ollama is running locally.";
      statusOllama.style.color = "var(--accent-rose)";
    } finally {
      btnScan.disabled = false;
      btnScan.classList.remove('is-scanning');
    }
  });
  
  btnSave.addEventListener('click', () => {
    aiProvider = providerSelect.value;
    geminiApiKey = inputKey.value.trim();
    openAIBaseUrl = inputOpenAIUrl.value.trim().replace(/\/$/, '');
    openAIModel = inputOpenAIModel.value.trim();
    openAIApiKey = inputOpenAIKey.value.trim();
    ollamaUrl = inputOllamaUrl.value.trim();
    ollamaModel = selectOllamaModel.value;
    
    localStorage.setItem('study_ai_provider', aiProvider);
    localStorage.setItem('study_gemini_api_key', geminiApiKey);
    localStorage.setItem('study_openai_base_url', openAIBaseUrl);
    localStorage.setItem('study_openai_model', openAIModel);
    localStorage.setItem('study_openai_api_key', openAIApiKey);
    localStorage.setItem('study_ollama_url', ollamaUrl);
    localStorage.setItem('study_ollama_model', ollamaModel);
    
    updateApiStatusDisplay();
    dialog.close();
    
    let msg = "AI settings saved. ";
    if (aiProvider === 'demo') msg += "Using simulated Demo Mode.";
    else if (aiProvider === 'gemini') msg += "Using Gemini Cloud API.";
    else if (aiProvider === 'openai-compatible') msg += `Using ${openAIModel} through an OpenAI-compatible API.`;
    else if (aiProvider === 'ollama') msg += `Using local Ollama model: ${ollamaModel}.`;
    
    addSystemChatMessage(msg, "success");
  });
  
  dialog.addEventListener('click', (e) => {
    if (e.target === dialog) {
      dialog.close();
    }
  });
}

function updateApiStatusDisplay() {
  const badge = document.getElementById('api-status-badge');
  const desc = document.getElementById('api-status-desc');
  const settingsBtn = document.getElementById('btn-api-settings');
  
  if (aiProvider === 'gemini') {
    if (geminiApiKey) {
      badge.className = "badge badge-active";
      badge.textContent = "GEMINI ACTIVE";
      desc.textContent = "Gemini Cloud API is processing study intelligence.";
      settingsBtn.classList.remove('btn-secondary');
      settingsBtn.classList.add('btn-primary');
    } else {
      badge.className = "badge badge-demo";
      badge.textContent = "GEMINI KEY MISSING";
      desc.textContent = "Enter a Gemini key or select another AI provider.";
      settingsBtn.classList.add('btn-secondary');
      settingsBtn.classList.remove('btn-primary');
    }
  } else if (aiProvider === 'openai-compatible') {
    badge.className = openAIApiKey ? "badge badge-active" : "badge badge-demo";
    badge.textContent = openAIApiKey ? "COMPATIBLE API ACTIVE" : "API KEY MISSING";
    desc.textContent = openAIApiKey ? `${openAIModel} · ${openAIBaseUrl}` : "Enter the key supplied by your compatible API provider.";
    settingsBtn.classList.toggle('btn-primary', Boolean(openAIApiKey));
    settingsBtn.classList.toggle('btn-secondary', !openAIApiKey);
  } else if (aiProvider === 'ollama') {
    badge.className = "badge badge-active";
    badge.style.backgroundColor = "rgba(99, 102, 241, 0.15)";
    badge.style.color = "var(--accent-indigo)";
    badge.style.borderColor = "rgba(99, 102, 241, 0.25)";
    badge.textContent = "OLLAMA ACTIVE";
    desc.textContent = `Local Model: "${ollamaModel}"`;
    settingsBtn.classList.remove('btn-secondary');
    settingsBtn.classList.add('btn-primary');
  } else {
    badge.className = "badge badge-demo";
    badge.textContent = "DEMO MODE";
    desc.textContent = "Simulated answers will be used. Input API Key to activate.";
    settingsBtn.classList.add('btn-secondary');
    settingsBtn.classList.remove('btn-primary');
  }
}

// ==========================================================================
// File Upload Actions
// ==========================================================================
const CODE_EXTENSIONS = new Set(['js', 'jsx', 'ts', 'tsx', 'py', 'java', 'c', 'cpp', 'h', 'hpp', 'swift', 'go', 'rs', 'sh', 'css', 'html', 'xml', 'json', 'yaml', 'yml', 'toml']);

function buildTextDocumentOutline(text, kind = 'document') {
  const lines = text.split(/\r?\n/);
  const items = [];
  let offset = 0;
  lines.forEach((rawLine) => {
    const line = rawLine.trim();
    const markdown = line.match(/^(#{1,4})\s+(.+)/);
    const numbered = line.match(/^((?:\d+\.){0,3}\d+|chapter\s+\w+|section\s+\w+)[:.)\s-]+(.+)/i);
    const codeSymbol = kind === 'code' && line.match(/^(?:export\s+)?(?:async\s+)?(?:class|function|interface|type|enum|struct|protocol|def|func|fn)\s+([A-Za-z_$][\w$]*)|^(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\(/);
    const resumeHeading = kind === 'resume' && /^(summary|profile|experience|work experience|employment|education|skills|projects|certifications|awards|publications|languages|volunteering|interests)$/i.test(line.replace(/:$/, ''));
    const shortHeading = line.length >= 3 && line.length <= 72 && !/[.!?]$/.test(line) && (/^[A-Z][A-Za-z0-9 '&:/_-]+$/.test(line) || line === line.toUpperCase());
    if (markdown || numbered || codeSymbol || resumeHeading || shortHeading) {
      const title = (markdown?.[2] || codeSymbol?.[1] || codeSymbol?.[2] || line.replace(/^#+\s*/, '').replace(/:$/, '')).trim();
      if (title && !items.some(item => item.title.toLowerCase() === title.toLowerCase())) {
        const level = markdown ? Math.min(markdown[1].length, 3) : (codeSymbol ? 2 : (numbered ? 2 : 1));
        items.push({ title, page: items.length + 1, level, position: offset });
      }
    }
    offset += rawLine.length + 1;
  });
  if (!items.length) {
    const paragraphs = text.split(/\n\s*\n/).filter(part => part.trim());
    let searchFrom = 0;
    paragraphs.slice(0, 16).forEach((paragraph, index) => {
      const clean = paragraph.replace(/\s+/g, ' ').trim();
      const position = text.indexOf(paragraph, searchFrom);
      searchFrom = Math.max(searchFrom, position + paragraph.length);
      items.push({ title: clean.slice(0, 58) + (clean.length > 58 ? '…' : ''), page: index + 1, level: 2, position: Math.max(0, position) });
    });
  }
  return items.slice(0, 120);
}

function renderOutlineHierarchy(items, onActivate) {
  const list = document.getElementById('outline-list');
  if (!list) return;
  list.innerHTML = '';
  const groups = [];
  let currentGroup = null;
  items.forEach((item, index) => {
    if ((item.level || 2) === 1 || !currentGroup) {
      currentGroup = { parent: item, parentIndex: index, children: [] };
      groups.push(currentGroup);
    } else {
      currentGroup.children.push({ item, index });
    }
  });

  groups.forEach((group) => {
    const wrapper = document.createElement('div');
    wrapper.className = 'outline-folder expanded';
    const parent = document.createElement('button');
    parent.className = 'outline-item outline-folder-row level-1';
    parent.innerHTML = `<span class="outline-chevron">⌄</span><span class="outline-label">${escapeHtml(group.parent.title)}</span><span class="outline-page">${group.parent.page || ''}</span>`;
    parent.addEventListener('click', () => {
      onActivate(group.parent, parent);
      if (group.children.length) wrapper.classList.toggle('expanded');
    });
    wrapper.appendChild(parent);
    if (group.children.length) {
      const children = document.createElement('div');
      children.className = 'outline-children';
      group.children.forEach(({ item, index }) => {
        const child = document.createElement('button');
        child.className = `outline-item level-${item.level || 2}`;
        child.innerHTML = `<span class="outline-index">${String(index + 1).padStart(2, '0')}</span><span class="outline-label">${escapeHtml(item.title)}</span><span class="outline-page">${item.page || ''}</span>`;
        child.addEventListener('click', () => onActivate(item, child));
        children.appendChild(child);
      });
      wrapper.appendChild(children);
    } else {
      parent.querySelector('.outline-chevron').textContent = '·';
    }
    list.appendChild(wrapper);
  });
}

function renderTextDocumentOutline(items) {
  const list = document.getElementById('outline-list');
  const kindElement = document.getElementById('document-kind');
  const editor = document.getElementById('text-document-editor');
  if (!list || !kindElement || !editor) return;
  const typeLabels = { code: 'Source code', resume: 'Résumé', article: 'Article', blog: 'Blog post', document: activeDocumentType === 'docx' ? 'Word document' : 'Editable document' };
  const typeLabel = typeLabels[currentDocumentKind] || 'Editable document';
  kindElement.innerHTML = `<span class="kind-icon">⌘</span><span><strong>${typeLabel}</strong><small>Mapped locally · ${items.length} sections</small></span>`;
  renderOutlineHierarchy(items, (item, button) => {
      editor.focus();
      editor.setSelectionRange(item.position || 0, item.position || 0);
      const lineHeight = parseFloat(getComputedStyle(editor).lineHeight) || 24;
      editor.scrollTop = Math.max(0, (activeDocumentText.slice(0, item.position || 0).split('\n').length - 3) * lineHeight);
      list.querySelectorAll('.outline-item').forEach(node => node.classList.remove('active'));
      button.classList.add('active');
  });
}

async function initializeTextRag(text) {
  if (!activeDocumentId) return null;
  setRagStatus('indexing', 'Indexing this document locally…');
  const chunks = chunkPageText(text, 1, 165, 35).map((chunk, index) => ({ ...chunk, page: index + 1 }));
  const documentFrequency = {};
  let totalLength = 0;
  chunks.forEach((chunk, id) => {
    chunk.id = id;
    const approximateCharacter = chunk.position * 6;
    chunk.sectionTitle = [...currentDocumentOutline].reverse().find(item => (item.position || 0) <= approximateCharacter)?.title || '';
    const tokens = tokenizeForRag(chunk.text);
    chunk.terms = {};
    tokens.forEach(token => { chunk.terms[token] = (chunk.terms[token] || 0) + 1; });
    chunk.length = tokens.length;
    totalLength += tokens.length;
    Object.keys(chunk.terms).forEach(token => { documentFrequency[token] = (documentFrequency[token] || 0) + 1; });
  });
  currentRagIndex = {
    documentId: activeDocumentId,
    version: 7,
    pageCount: 1,
    chunks,
    documentFrequency,
    averageLength: totalLength / Math.max(chunks.length, 1),
    createdAt: Date.now()
  };
  await addLocalEmbeddingsIfAvailable(currentRagIndex);
  await saveRagIndex(currentRagIndex);
  setRagStatus('ready', `Local RAG ready · ${chunks.length} passages`);
  return currentRagIndex;
}

async function openTextDocument(record) {
  if (pageObserver) pageObserver.disconnect();
  pdfDoc = null;
  pdfPagesCount = 0;
  currentPageNum = 1;
  if (record.contentText != null) {
    activeDocumentText = record.contentText;
  } else if (activeDocumentType === 'docx') {
    activeDocumentText = (await mammoth.extractRawText({ arrayBuffer: record.arrayBuffer })).value;
  } else {
    activeDocumentText = new TextDecoder('utf-8').decode(record.arrayBuffer);
  }
  currentDocumentAnalysisText = activeDocumentText.slice(0, 60000);
  currentDocumentKind = classifyDocument(activeDocumentText, 1, record.fileName);
  currentDocumentOutline = buildTextDocumentOutline(activeDocumentText, currentDocumentKind);
  document.getElementById('app').classList.add('text-document-mode');
  document.getElementById('pdf-scroll-container').style.display = 'none';
  document.getElementById('text-document-container').style.display = 'flex';
  const editor = document.getElementById('text-document-editor');
  editor.value = activeDocumentText;
  editor.spellcheck = !['json', 'js', 'jsx', 'ts', 'tsx', 'py', 'java', 'c', 'cpp', 'swift', 'go', 'rs', 'sh', 'css', 'html', 'xml'].includes(activeDocumentType);
  document.getElementById('text-document-badge').textContent = documentTypeLabel(record.fileName);
  document.getElementById('text-document-status').textContent = 'Saved locally';
  renderTextDocumentOutline(currentDocumentOutline);
  ragBuildPromise = initializeTextRag(activeDocumentText);
}

async function saveTextDocumentChanges() {
  if (!activeDocumentId || activeDocumentType === 'pdf') return;
  const editor = document.getElementById('text-document-editor');
  const status = document.getElementById('text-document-status');
  const record = await getLibraryDocument(activeDocumentId);
  if (!record || !editor) return;
  activeDocumentText = editor.value;
  const isWordSource = activeDocumentType === 'docx';
  const encoded = isWordSource ? record.arrayBuffer : new TextEncoder().encode(activeDocumentText).buffer;
  await saveLibraryDocument({ ...record, arrayBuffer: encoded, contentText: activeDocumentText, size: encoded.byteLength, updatedAt: Date.now() });
  currentDocumentAnalysisText = activeDocumentText.slice(0, 60000);
  currentDocumentKind = classifyDocument(activeDocumentText, 1, activeDocumentName);
  currentDocumentOutline = buildTextDocumentOutline(activeDocumentText, currentDocumentKind);
  renderTextDocumentOutline(currentDocumentOutline);
  currentRagIndex = null;
  ragBuildPromise = initializeTextRag(activeDocumentText);
  status.textContent = isWordSource ? 'Editable local text copy saved' : 'Saved locally';
  await renderLibrary();
  saveSessionToCloud();
}

function initTextDocumentEditor() {
  const editor = document.getElementById('text-document-editor');
  const status = document.getElementById('text-document-status');
  const save = debounce(saveTextDocumentChanges, 900);
  editor?.addEventListener('input', () => {
    activeDocumentText = editor.value;
    if (status) status.textContent = 'Editing…';
    save();
  });
  document.getElementById('btn-save-document')?.addEventListener('click', saveTextDocumentChanges);
  document.addEventListener('keydown', event => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's' && activeDocumentType !== 'pdf') {
      event.preventDefault();
      saveTextDocumentChanges();
    }
  });
}

function initUploads() {
  const headerUpload = document.getElementById('pdf-upload');
  const welcomeUpload = document.getElementById('pdf-upload-welcome');
  const sampleBtn = document.getElementById('btn-load-sample');
  
  const handleFile = async (e) => {
    const files = [...e.target.files];
    for (const file of files) {
      await importDocumentToLibrary(file);
    }
    e.target.value = '';
  };
  
  headerUpload.addEventListener('change', handleFile);
  welcomeUpload.addEventListener('change', handleFile);
  
  sampleBtn.addEventListener('click', () => {
    // Show loading indicator
    addSystemChatMessage("Fetching sample PDF document. Please wait...", "primary");
    const sampleUrl = 'https://raw.githubusercontent.com/mozilla/pdf.js/master/web/compressed.tracemonkey-pldi-09.pdf';
    
    // Clear and hide welcome
    document.getElementById('welcome-screen').style.display = 'none';
    const scrollContainer = document.getElementById('pdf-scroll-container');
    scrollContainer.style.display = 'flex';
    
    fetch(sampleUrl)
      .then(res => {
        if (!res.ok) throw new Error("Failed to fetch sample PDF");
        return res.arrayBuffer();
      })
      .then(async (arrayBuffer) => {
        const id = createDocumentId('Understanding Computing.pdf', arrayBuffer.byteLength, 2024);
        await saveLibraryDocument({ id, arrayBuffer, fileName: 'Understanding Computing.pdf', size: arrayBuffer.byteLength, updatedAt: Date.now() });
        await openLibraryDocument(id);
      })
      .catch(err => {
        console.error("Failed to load sample", err);
        addSystemChatMessage("Failed to fetch sample PDF from server. Attempting standard load...", "warning");
        loadPdfDoc(sampleUrl);
      });
  });
}

async function importDocumentToLibrary(file) {
  const arrayBuffer = await file.arrayBuffer();
  const extension = documentExtension(file.name);
  let contentText = '';
  if (extension !== 'pdf') {
    try {
      contentText = extension === 'docx'
        ? (await mammoth.extractRawText({ arrayBuffer })).value
        : new TextDecoder('utf-8').decode(arrayBuffer);
    } catch (error) {
      addSystemChatMessage(`Could not read ${escapeHtml(file.name)}: ${escapeHtml(error.message)}`, 'error');
      return;
    }
  }
  const id = createDocumentId(file.name, file.size, file.lastModified);
  await saveLibraryDocument({
    id,
    arrayBuffer,
    fileName: file.name,
    size: file.size,
    mimeType: file.type || 'application/octet-stream',
    contentText,
    updatedAt: Date.now()
  });
  if (extension === 'pdf') await savePdfToIndexedDB(arrayBuffer, file.name);
  await uploadPdfToCloud(arrayBuffer, file.name, id);
  await renderLibrary();
  await openLibraryDocument(id);
}

function loadLocalPdfFile(file) {
  // Clear and hide welcome
  document.getElementById('welcome-screen').style.display = 'none';
  const scrollContainer = document.getElementById('pdf-scroll-container');
  scrollContainer.style.display = 'flex';
  
  addSystemChatMessage(`Loading PDF: <strong>${file.name}</strong>...`, "primary");
  
  const fileReader = new FileReader();
  fileReader.onload = async function() {
    const arrayBuffer = this.result;
    const typedarray = new Uint8Array(arrayBuffer);
    loadPdfDoc(typedarray);
    await savePdfToIndexedDB(arrayBuffer, file.name);
    await uploadPdfToCloud(arrayBuffer, file.name, activeDocumentId);
  };
  fileReader.readAsArrayBuffer(file);
}

// ==========================================================================
// PDF Renderer
// ==========================================================================
async function loadPdfDoc(pdfSource) {
  const viewerContent = document.getElementById('pdf-viewer-content');
  viewerContent.innerHTML = ''; // Reset viewer
  
  // Reset render states
  isRenderingPage = {};
  pageRenderTasks = {};
  
  try {
    const loadingTask = pdfjsLib.getDocument(pdfSource);
    pdfDoc = await loadingTask.promise;
    pdfPagesCount = pdfDoc.numPages;
    
    document.getElementById('page-count').textContent = pdfPagesCount;
    document.getElementById('page-number-input').max = pdfPagesCount;
    
    // Pre-create container nodes for scroll heights
    for (let pageNum = 1; pageNum <= pdfPagesCount; pageNum++) {
      const pageContainer = document.createElement('div');
      pageContainer.className = 'pdf-page-container';
      pageContainer.id = `page-container-${pageNum}`;
      pageContainer.setAttribute('data-page', pageNum);
      
      viewerContent.appendChild(pageContainer);
      
      // Determine viewport dimensions dynamically
      const page = await pdfDoc.getPage(pageNum);
      const viewport = page.getViewport({ scale: pdfScale });
      
      pageContainer.style.width = `${viewport.width}px`;
      pageContainer.style.height = `${viewport.height}px`;
    }
    
    // Initialize observer for lazy rendering
    setupPageObserver();
    
    // Auto restore position if currentPageNum is set
    if (currentPageNum > 1) {
      setTimeout(() => {
        jumpToPage(currentPageNum);
      }, 500);
    }

    if (!currentDocumentOutline.length) {
      await analyzeDocumentLocally();
    } else {
      renderDocumentOutline(currentDocumentOutline, currentDocumentKind);
    }
    ragBuildPromise = initializeLocalRag();
    
  } catch (err) {
    console.error("PDF load failure", err);
    addSystemChatMessage(`Error loading PDF document: ${err.message}`, "error");
    // Show welcome screen again
    document.getElementById('welcome-screen').style.display = 'flex';
    document.getElementById('pdf-scroll-container').style.display = 'none';
  }
}

const RAG_STOP_WORDS = new Set(`a an and are as at be been being but by can could did do does doing for from had has have having he her here hers herself him himself his how i if in into is it its itself may me might more most must my myself no nor not of on once only or other our ours ourselves out over own same she should so some such than that the their theirs them themselves then there these they this those through to too under until up very was we were what when where which while who whom why will with would you your yours yourself yourselves`.split(' '));

function normalizeRagToken(token) {
  let value = token.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (!value || RAG_STOP_WORDS.has(value) || value.length < 2) return '';
  if (value.length > 5 && value.endsWith('ing')) value = value.slice(0, -3);
  else if (value.length > 4 && value.endsWith('ed')) value = value.slice(0, -2);
  else if (value.length > 4 && value.endsWith('es')) value = value.slice(0, -2);
  else if (value.length > 3 && value.endsWith('s')) value = value.slice(0, -1);
  return value;
}

function tokenizeForRag(text) {
  return (text.match(/[A-Za-z0-9][A-Za-z0-9_'-]*/g) || []).map(normalizeRagToken).filter(Boolean);
}

function chunkPageText(text, page, targetWords = 165, overlapWords = 35) {
  const words = text.replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
  const chunks = [];
  if (!words.length) return chunks;
  for (let start = 0; start < words.length; start += targetWords - overlapWords) {
    const slice = words.slice(start, start + targetWords);
    if (slice.length < 25 && chunks.length) break;
    chunks.push({ page, text: slice.join(' '), position: start });
    if (start + targetWords >= words.length) break;
  }
  return chunks;
}

function setRagStatus(state, text) {
  let status = document.getElementById('rag-status');
  if (!status) {
    status = document.createElement('div');
    status.id = 'rag-status';
    const shortcuts = document.querySelector('.chat-shortcuts');
    shortcuts?.parentNode.insertBefore(status, shortcuts);
  }
  if (!status) return;
  status.className = `rag-status ${state}`;
  status.innerHTML = `<i></i><span>${escapeHtml(text)}</span>`;
}

async function initializeLocalRag() {
  if (!activeDocumentId || !pdfDoc) return null;
  setRagStatus('indexing', `Indexing ${pdfPagesCount} pages locally…`);
  try {
    const saved = await getRagIndex(activeDocumentId);
    if (saved?.version === 7 && saved.pageCount === pdfPagesCount && saved.documentId === activeDocumentId) {
      currentRagIndex = saved;
      setRagStatus('ready', `${saved.embeddings?.length ? 'Hybrid RAG' : 'Local RAG'} ready · ${saved.chunks.length} passages`);
      return saved;
    }

    const chunks = [];
    for (let pageNumber = 1; pageNumber <= pdfPagesCount; pageNumber++) {
      const page = await pdfDoc.getPage(pageNumber);
      const content = await page.getTextContent();
      const text = content.items.map(item => item.str).join(' ').replace(/\s+/g, ' ').trim();
      const pageSections = currentDocumentOutline.filter(item => item.page <= pageNumber);
      const sectionTitle = pageSections.length ? pageSections[pageSections.length - 1].title : '';
      chunks.push(...chunkPageText(text, pageNumber).map(chunk => ({ ...chunk, sectionTitle })));
      if (pageNumber % 8 === 0) {
        setRagStatus('indexing', `Indexing locally · ${pageNumber}/${pdfPagesCount} pages`);
        await new Promise(resolve => setTimeout(resolve, 0));
      }
    }

    const documentFrequency = {};
    let totalLength = 0;
    chunks.forEach((chunk, id) => {
      chunk.id = id;
      const tokens = tokenizeForRag(chunk.text);
      const termFrequency = {};
      tokens.forEach(token => { termFrequency[token] = (termFrequency[token] || 0) + 1; });
      chunk.terms = termFrequency;
      chunk.length = tokens.length;
      totalLength += tokens.length;
      Object.keys(termFrequency).forEach(token => { documentFrequency[token] = (documentFrequency[token] || 0) + 1; });
    });
    currentRagIndex = {
      documentId: activeDocumentId,
      version: 7,
      pageCount: pdfPagesCount,
      chunks,
      documentFrequency,
      averageLength: totalLength / Math.max(chunks.length, 1),
      createdAt: Date.now()
    };
    await addLocalEmbeddingsIfAvailable(currentRagIndex);
    await saveRagIndex(currentRagIndex);
    const mode = currentRagIndex.embeddings?.length ? 'Hybrid RAG' : 'Local RAG';
    setRagStatus('ready', `${mode} ready · ${chunks.length} passages`);
    return currentRagIndex;
  } catch (error) {
    console.error('Local RAG indexing failed', error);
    setRagStatus('error', 'Local document memory unavailable');
    return null;
  }
}

async function addLocalEmbeddingsIfAvailable(index) {
  try {
    const response = await ollamaFetch('/api/tags', { signal: AbortSignal.timeout(1800) });
    if (!response.ok) return;
    const data = await response.json();
    const embeddingModel = (data.models || []).find(model => /(^|[-_:])(embed|embedding)|nomic-embed/i.test(model.name));
    if (!embeddingModel) return;
    index.embeddingModel = embeddingModel.name;
    index.embeddings = [];
    for (let start = 0; start < index.chunks.length; start += 24) {
      setRagStatus('indexing', `Building local semantic memory · ${Math.min(start + 24, index.chunks.length)}/${index.chunks.length}`);
      const batch = index.chunks.slice(start, start + 24).map(chunk => chunk.text);
      const embedResponse = await ollamaFetch('/api/embed', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: embeddingModel.name, input: batch, truncate: true })
      });
      if (!embedResponse.ok) throw new Error('Embedding model request failed');
      const embedData = await embedResponse.json();
      index.embeddings.push(...(embedData.embeddings || []));
      await new Promise(resolve => setTimeout(resolve, 0));
    }
    if (index.embeddings.length !== index.chunks.length) {
      delete index.embeddings;
      delete index.embeddingModel;
    }
  } catch (error) {
    delete index.embeddings;
    delete index.embeddingModel;
    console.info('Local embedding enhancement unavailable; using BM25 retrieval.', error.message);
  }
}

function cosineSimilarity(a, b) {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  const length = Math.min(a?.length || 0, b?.length || 0);
  for (let index = 0; index < length; index++) {
    dot += a[index] * b[index];
    normA += a[index] * a[index];
    normB += b[index] * b[index];
  }
  return normA && normB ? dot / Math.sqrt(normA * normB) : 0;
}

async function embedRagQuery(query) {
  if (!currentRagIndex?.embeddingModel) return null;
  try {
    const response = await ollamaFetch('/api/embed', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: currentRagIndex.embeddingModel, input: query, truncate: true })
    });
    if (!response.ok) return null;
    const data = await response.json();
    return data.embeddings?.[0] || null;
  } catch (_) {
    return null;
  }
}

async function retrieveDocumentContext(query, limit = 6) {
  if (!currentRagIndex?.chunks?.length || currentRagIndex.documentId !== activeDocumentId) return [];
  const focusedQuery = query
    .replace(/\b(please|can you|could you|would you|explain|describe|tell me about|what is|what are|the section|the chapter)\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim() || query;
  const queryTokens = tokenizeForRag(`${focusedQuery} ${query}`);
  const uniqueTerms = [...new Set(queryTokens)];
  const { chunks, documentFrequency, averageLength } = currentRagIndex;
  const totalChunks = chunks.length;
  const normalizedQuery = focusedQuery.toLowerCase();
  const queryEmbedding = await embedRagQuery(focusedQuery);
  let matchedSection = null;
  let matchedSectionScore = 0;
  let matchedSectionOverlap = 0;
  const requestedSectionNumber = query.match(/\b\d+(?:\.\d+)+\b/)?.[0] || '';
  currentDocumentOutline.forEach((item, index) => {
    const titleTokens = [...new Set(tokenizeForRag(item.title))];
    const overlap = titleTokens.filter(token => uniqueTerms.includes(token)).length;
    const titleSectionNumber = item.title.match(/^\s*(\d+(?:\.\d+)+)\b/)?.[1] || '';
    const exactSectionNumber = requestedSectionNumber && requestedSectionNumber === titleSectionNumber;
    const score = exactSectionNumber ? 2 : overlap / Math.max(titleTokens.length, 1);
    if (overlap >= 1 && (score > matchedSectionScore || (score === matchedSectionScore && overlap > matchedSectionOverlap))) {
      const next = currentDocumentOutline.slice(index + 1).find(candidate => (candidate.level || 2) <= (item.level || 2));
      matchedSection = { ...item, endPage: next ? Math.max(item.page, next.page - 1) : currentRagIndex.pageCount };
      matchedSectionScore = score;
      matchedSectionOverlap = overlap;
    }
  });
  if (matchedSectionScore < .5) matchedSection = null;
  const scored = chunks.map(chunk => {
    let score = 0;
    uniqueTerms.forEach(term => {
      const tf = chunk.terms[term] || 0;
      if (!tf) return;
      const df = documentFrequency[term] || 0;
      const idf = Math.log(1 + (totalChunks - df + .5) / (df + .5));
      const denominator = tf + 1.35 * (.25 + .75 * chunk.length / Math.max(averageLength, 1));
      score += idf * ((tf * 2.35) / denominator);
    });
    const lowerText = chunk.text.toLowerCase();
    const lowerSection = (chunk.sectionTitle || '').toLowerCase();
    if (normalizedQuery.length > 8 && lowerText.includes(normalizedQuery)) score += 8;
    if (normalizedQuery.length > 2 && lowerSection.includes(normalizedQuery)) score += 12;
    const sectionCoverage = uniqueTerms.filter(term => tokenizeForRag(lowerSection).includes(term)).length / Math.max(uniqueTerms.length, 1);
    score += sectionCoverage * 6;
    if (matchedSection && chunk.page >= matchedSection.page && chunk.page <= matchedSection.endPage) score += 10;
    const coverage = uniqueTerms.filter(term => chunk.terms[term]).length / Math.max(uniqueTerms.length, 1);
    score += coverage * 2.5;
    if (queryEmbedding && currentRagIndex.embeddings?.[chunk.id]) {
      score += Math.max(0, cosineSimilarity(queryEmbedding, currentRagIndex.embeddings[chunk.id])) * 4;
    }
    if (chunk.page === currentPageNum) score += .25;
    return { ...chunk, score };
  }).sort((a, b) => b.score - a.score);

  let rankedPool = scored;
  if (matchedSection) {
    const withinSection = scored.filter(item => item.page >= matchedSection.page && item.page <= matchedSection.endPage);
    if (withinSection.length) rankedPool = [...withinSection, ...scored.filter(item => !withinSection.includes(item))];
  }
  let anchors = rankedPool.filter(item => item.score > .12).slice(0, Math.max(3, Math.ceil(limit / 2)));
  if (!anchors.length) anchors = scored.slice(0, 3);
  let selected = [];
  anchors.forEach(anchor => {
    selected.push(anchor);
    const previous = chunks[anchor.id - 1];
    const next = chunks[anchor.id + 1];
    if (previous && (previous.page === anchor.page || previous.sectionTitle === anchor.sectionTitle)) selected.push({ ...previous, score: anchor.score * .72 });
    if (next && (next.page === anchor.page || next.sectionTitle === anchor.sectionTitle)) selected.push({ ...next, score: anchor.score * .76 });
  });
  if (/\b(summary|summarize|overview|about|main idea|thesis)\b/i.test(query)) {
    selected = [...chunks.slice(0, 2).map(chunk => ({ ...chunk, score: 1 })), ...selected];
  }
  const unique = new Map();
  selected.forEach(item => unique.set(item.id, item));
  return [...unique.values()].sort((a, b) => b.score - a.score).slice(0, limit);
}

function buildRagPrompt(question, passages) {
  const isPdf = activeDocumentType === 'pdf';
  const location = isPdf ? 'Page' : 'Passage';
  const context = passages.map(item => `[${location} ${item.page}${item.sectionTitle ? ` · Section: ${item.sectionTitle}` : ''}]\n${item.text}`).join('\n\n---\n\n');
  return `You are a document-grounded study assistant answering only about the currently open document: "${activeDocumentName}". Answer the question using only the retrieved passages below.

Rules:
- Base factual claims on the passages. Do not invent missing details.
- Never use facts from a different document or previous workspace.
- Cite supporting ${isPdf ? 'pages inline as [p. N]' : 'passages inline as [passage N]'}.
- If the passages do not contain enough information, say what is missing.
- Explain clearly for a student. Use short headings or bullets only when helpful.
- When asked to explain a section, combine all relevant retrieved passages into a coherent explanation: begin with the central idea, then explain the details and relationships, and end with a brief takeaway.
- Treat section titles as navigation metadata, not as evidence by themselves.
- ${isPdf ? 'A rendered image of the currently visible PDF page may be attached. Use it for diagrams, tables, equations, and visual layout, while citing that page.' : 'The source is editable text; respect its current locally saved contents.'}
- The document is classified as a ${currentDocumentKind}.

Question: ${question}

Retrieved passages:
${context}`;
}

function addRagAssistantMessage(text, passages) {
  addChatMessage('assistant', text);
  const container = document.getElementById('chat-messages');
  const bubble = container.lastElementChild;
  if (!bubble || !passages.length) return;
  const sources = document.createElement('div');
  sources.className = 'rag-sources';
  const pages = [...new Set(passages.map(item => item.page))].slice(0, 6);
  const prefix = activeDocumentType === 'pdf' ? 'p.' : 'passage';
  sources.innerHTML = `<span>Sources</span>${pages.map(page => `<button data-page="${page}">${prefix} ${page}</button>`).join('')}`;
  if (activeDocumentType === 'pdf') {
    sources.querySelectorAll('button').forEach(button => button.addEventListener('click', () => jumpToPage(Number(button.dataset.page))));
  }
  bubble.appendChild(sources);
}

function initDocumentOutline() {
  const outline = document.getElementById('document-outline');
  const hideButton = document.getElementById('btn-outline-collapse');
  const showButton = document.getElementById('btn-outline-reveal');
  hideButton?.addEventListener('click', () => outline?.classList.add('collapsed'));
  showButton?.addEventListener('click', () => outline?.classList.remove('collapsed'));
  document.getElementById('btn-enhance-outline')?.addEventListener('click', enhanceOutlineWithAI);
}

function median(values) {
  if (!values.length) return 12;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

function classifyDocument(text, pageCount, fileName = activeDocumentName) {
  const normalized = text.toLowerCase();
  const extension = documentExtension(fileName || '');
  if (CODE_EXTENSIONS.has(extension)) return 'code';
  const resumeSignals = ['work experience', 'professional experience', 'education', 'skills', 'employment', 'certifications', 'curriculum vitae'];
  const resumeScore = resumeSignals.filter(signal => normalized.includes(signal)).length;
  if (resumeScore >= 2 && pageCount <= 6) return 'resume';
  if (/\babstract\b/.test(normalized) && /\b(references|bibliography)\b/.test(normalized)) return 'research paper';
  const chapterSignals = (normalized.match(/\bchapter\s+(\d+|[ivxlcdm]+|one|two|three|four|five|six|seven|eight|nine|ten)\b/g) || []).length;
  if (chapterSignals >= 1 || /\b(textbook|study guide|table of contents|isbn)\b/.test(normalized) || pageCount >= 28) return 'book';
  if (/\bposted (on|by)\b|\bmin(?:ute)? read\b|\bblog\b|\bsubscribe\b|\bcomments?\b/.test(normalized)) return 'blog';
  if (pageCount <= 16) return 'article';
  return 'document';
}

async function extractEmbeddedPdfOutline() {
  const outline = await pdfDoc.getOutline();
  if (!outline?.length) return [];
  const items = [];
  async function visit(nodes, level = 1) {
    for (const node of nodes) {
      let destination = node.dest;
      if (typeof destination === 'string') destination = await pdfDoc.getDestination(destination);
      const pageRef = Array.isArray(destination) ? destination[0] : null;
      let page = null;
      if (pageRef && typeof pageRef === 'object') {
        try { page = (await pdfDoc.getPageIndex(pageRef)) + 1; } catch (_) {}
      } else if (Number.isInteger(pageRef)) {
        page = pageRef + 1;
      }
      const title = (node.title || '').replace(/\s+/g, ' ').trim();
      if (title && page && page <= pdfPagesCount) {
        items.push({ title, page, level: Math.min(level, 3), source: 'pdf-outline' });
      }
      if (node.items?.length) await visit(node.items, level + 1);
    }
  }
  await visit(outline);
  return items;
}

async function analyzeDocumentLocally() {
  if (!pdfDoc) return;
  const kindElement = document.getElementById('document-kind');
  const list = document.getElementById('outline-list');
  if (list) list.innerHTML = '<div class="outline-loading"><i></i><span>Reading structure locally…</span></div>';
  if (kindElement) kindElement.classList.add('analyzing');

  // Author-provided bookmarks are the highest-quality source of chapter
  // structure and avoid treating bold body text as headings.
  try {
    const embeddedOutline = await extractEmbeddedPdfOutline();
    if (embeddedOutline.length) {
      const sampleText = [];
      for (let pageNumber = 1; pageNumber <= Math.min(pdfPagesCount, 8); pageNumber++) {
        const page = await pdfDoc.getPage(pageNumber);
        const content = await page.getTextContent();
        sampleText.push(content.items.map(item => item.str).join(' '));
      }
      currentDocumentAnalysisText = sampleText.join('\n').slice(0, 24000);
      currentDocumentKind = classifyDocument(currentDocumentAnalysisText, pdfPagesCount);
      if (embeddedOutline.some(item => /^(chapter|part|introduction)\b/i.test(item.title))) currentDocumentKind = 'book';
      currentDocumentOutline = embeddedOutline.slice(0, 120);
      renderDocumentOutline(currentDocumentOutline, currentDocumentKind);
      saveActiveDocumentSession();
      return;
    }
  } catch (error) {
    console.info('No usable embedded PDF outline; using local typography analysis.', error.message);
  }

  const pages = [];
  const fontSizes = [];
  const pageLimit = Math.min(pdfPagesCount, 60);
  for (let pageNumber = 1; pageNumber <= pageLimit; pageNumber++) {
    const page = await pdfDoc.getPage(pageNumber);
    const content = await page.getTextContent();
    const rows = new Map();
    content.items.forEach(item => {
      const text = item.str.trim();
      if (!text) return;
      const y = Math.round((item.transform?.[5] || 0) / 3) * 3;
      const size = Math.max(1, Math.abs(item.transform?.[3] || item.height || 10));
      fontSizes.push(size);
      if (!rows.has(y)) rows.set(y, []);
      rows.get(y).push({ text, x: item.transform?.[4] || 0, size });
    });
    const lines = [...rows.entries()].sort((a, b) => b[0] - a[0]).map(([, items]) => ({
      text: items.sort((a, b) => a.x - b.x).map(item => item.text).join(' ').replace(/\s+/g, ' ').trim(),
      size: Math.max(...items.map(item => item.size))
    }));
    pages.push({ page: pageNumber, lines, text: lines.map(line => line.text).join(' ') });
  }

  const sizeFrequency = new Map();
  fontSizes.filter(size => size < 40).forEach(size => {
    const rounded = Math.round(size * 2) / 2;
    sizeFrequency.set(rounded, (sizeFrequency.get(rounded) || 0) + 1);
  });
  const baseSize = [...sizeFrequency.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || median(fontSizes.filter(size => size < 40));
  const allText = pages.map(page => page.text).join('\n');
  currentDocumentAnalysisText = allText.slice(0, 24000);
  currentDocumentKind = classifyDocument(allText, pdfPagesCount);
  const repeated = new Map();
  pages.forEach(page => page.lines.forEach(line => {
    const key = line.text.toLowerCase().replace(/\d+/g, '#');
    repeated.set(key, (repeated.get(key) || 0) + 1);
  }));
  const structuralPattern = /^(chapter(?:\s+[\w.-]+)?|part(?:\s+[\w.-]+)?|unit(?:\s+[\w.-]+)?|lesson(?:\s+[\w.-]+)?|module(?:\s+[\w.-]+)?|appendix(?:\s+[\w.-]+)?|introduction|abstract|overview|conclusions?|discussion|results|methodology|methods|references|bibliography)\s*[:.-]?$/i;
  const numberedPattern = /^(\d+(?:\.\d+){0,3}|[IVXLC]+)[.)]?\s+[A-Z]/;
  const candidates = [];
  pages.forEach(page => page.lines.forEach((line, lineIndex) => {
    let text = line.text.replace(/^[-•]\s*/, '').trim();
    text = text.replace(/\s+(?:Now|This section|In this section|We (?:now|describe|present)|The remainder)\b,?.*$/i, '').trim();
    if (text.length < 3 || text.length > 105 || /^\d+$/.test(text)) return;
    const wordCount = text.split(/\s+/).length;
    const repeatCount = repeated.get(text.toLowerCase().replace(/\d+/g, '#')) || 0;
    const isStructural = structuralPattern.test(text) || numberedPattern.test(text);
    const isLarge = line.size >= baseSize * 1.32;
    const looksTitle = /^[A-Z][^.!?]{2,80}$/.test(text) && text.split(/\s+/).length <= 12;
    const words = text.split(/\s+/).filter(Boolean);
    const titleCaseRatio = words.filter(word => /^[A-Z0-9]/.test(word)).length / Math.max(words.length, 1);
    if (!isStructural && !numberedPattern.test(text) && !/^[A-Z]/.test(text)) return;
    if (!isStructural && !numberedPattern.test(text) && titleCaseRatio < .45) return;
    if ((isStructural || wordCount >= 2) && (isStructural || numberedPattern.test(text) || isLarge || (lineIndex < 4 && looksTitle && line.size >= baseSize * 1.18)) && repeatCount <= 2) {
      const score = (isStructural ? 5 : 0) + (isLarge ? Math.min(4, line.size / baseSize) : 0) + (lineIndex < 4 ? 1 : 0);
      let level = 2;
      if (/^(part|chapter|unit|introduction|conclusions?|appendix|abstract|references|bibliography)\b/i.test(text)) level = 1;
      else if (/^\d+[.)]?\s+/.test(text)) level = currentDocumentKind === 'book' ? 2 : 1;
      else if (/^\d+\.\d+\.\d+/.test(text)) level = 3;
      else if (/^\d+\.\d+/.test(text)) level = 2;
      candidates.push({ title: text, page: page.page, level, score, order: lineIndex });
    }
  }));

  const seen = new Set();
  currentDocumentOutline = candidates
    .sort((a, b) => a.page - b.page || a.order - b.order)
    .filter(item => {
      const key = item.title.toLowerCase().replace(/[^a-z0-9]/g, '');
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, 120);

  if (currentDocumentOutline.length < 2) {
    currentDocumentOutline = pages.map(page => {
      const line = page.lines.find(item => item.text.length >= 5 && item.text.length <= 80);
      return line ? { title: line.text, page: page.page, level: 2 } : null;
    }).filter(Boolean).slice(0, 60);
  }
  renderDocumentOutline(currentDocumentOutline, currentDocumentKind);
  saveActiveDocumentSession();
}

function renderDocumentOutline(items, kind) {
  const list = document.getElementById('outline-list');
  const kindElement = document.getElementById('document-kind');
  if (!list || !kindElement) return;
  kindElement.classList.remove('analyzing');
  const labels = { book: ['▤', 'Book'], article: ['◫', 'Article'], blog: ['◎', 'Blog'], resume: ['◉', 'Résumé'], code: ['⌘', 'Source code'], 'research paper': ['⌁', 'Research paper'], document: ['◇', 'Document'] };
  const [icon, label] = labels[kind] || labels.document;
  kindElement.innerHTML = `<span class="kind-icon">${icon}</span><span><strong>${label}</strong><small>Mapped locally · ${pdfPagesCount} pages</small></span>`;
  renderOutlineHierarchy(items, (item, button) => {
      jumpToPage(item.page);
      list.querySelectorAll('.outline-item').forEach(node => node.classList.remove('active'));
      button.classList.add('active');
  });
}

async function enhanceOutlineWithAI() {
  const button = document.getElementById('btn-enhance-outline');
  if (aiProvider === 'demo') {
    document.getElementById('settings-dialog')?.showModal();
    return;
  }
  button.disabled = true;
  button.innerHTML = '<span>✦</span> Refining map…';
  try {
    const prompt = `Classify this document and improve its navigation outline. Return ONLY JSON in this shape: {"kind":"book|article|blog|resume|code|research paper|document","outline":[{"title":"...","page":1,"level":1}]}. Level 1 is a folder/chapter and levels 2-3 are its subsections. Preserve accurate page numbers from the local candidates.\n\nLocal candidates: ${JSON.stringify(currentDocumentOutline)}\n\nDocument excerpt:\n${currentDocumentAnalysisText.slice(0, 12000)}`;
    const response = await fetchConfiguredAI(prompt);
    const parsed = JSON.parse(response.replace(/```json|```/g, '').trim());
    if (Array.isArray(parsed.outline) && parsed.outline.length) {
      currentDocumentKind = parsed.kind || currentDocumentKind;
      currentDocumentOutline = parsed.outline.filter(item => item.title && Number.isFinite(Number(item.page))).map(item => ({ ...item, page: Number(item.page), level: Math.max(1, Math.min(3, Number(item.level) || 2)) })).slice(0, 120);
      renderDocumentOutline(currentDocumentOutline, currentDocumentKind);
      saveActiveDocumentSession();
    }
  } catch (error) {
    addSystemChatMessage(`Could not refine the document map: ${error.message}`, 'warning');
  } finally {
    button.disabled = false;
    button.innerHTML = '<span>✦</span> Refine map with AI';
  }
}

function setupPageObserver() {
  if (pageObserver) {
    pageObserver.disconnect();
  }
  
  pageObserver = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
      const pageNum = parseInt(entry.target.getAttribute('data-page'));
      
      if (entry.isIntersecting) {
        // Page entered screen - render it
        renderPage(pageNum);
      } else {
        // Page left screen - clean up memory
        if (selectedPagesList && selectedPagesList.includes(pageNum)) {
          console.log(`[StudyBuddy] Retaining page ${pageNum} from unrendering because it is currently selected.`);
          return;
        }
        unrenderPage(pageNum);
      }
    });
  }, {
    root: document.getElementById('pdf-scroll-container'),
    rootMargin: '100px 0px 100px 0px', // Pre-render pages before they hit screen
    threshold: 0.1
  });
  
  // Observe all page nodes
  document.querySelectorAll('.pdf-page-container').forEach(el => {
    pageObserver.observe(el);
  });
  
  // Track scroll position to update header page count
  const scrollContainer = document.getElementById('pdf-scroll-container');
  scrollContainer.addEventListener('scroll', throttle(() => {
    const pages = document.querySelectorAll('.pdf-page-container');
    let currentInView = 1;
    let maxVisibleHeight = 0;
    
    const containerRect = scrollContainer.getBoundingClientRect();
    
    pages.forEach(p => {
      const rect = p.getBoundingClientRect();
      // Calculate height of page visible inside container
      const top = Math.max(rect.top, containerRect.top);
      const bottom = Math.min(rect.bottom, containerRect.bottom);
      const visibleHeight = Math.max(0, bottom - top);
      
      if (visibleHeight > maxVisibleHeight) {
        maxVisibleHeight = visibleHeight;
        currentInView = parseInt(p.getAttribute('data-page'));
      }
    });
    
    if (currentPageNum !== currentInView) {
      currentPageNum = currentInView;
      document.getElementById('page-number-input').value = currentPageNum;
      saveSessionToCloud();
    }
  }, 100));
}

async function renderPage(pageNum) {
  if (isRenderingPage[pageNum]) return;
  isRenderingPage[pageNum] = true;
  
  const pageContainer = document.getElementById(`page-container-${pageNum}`);
  if (!pageContainer) return;
  
  try {
    const page = await pdfDoc.getPage(pageNum);
    const viewport = page.getViewport({ scale: pdfScale });
    
    // Clear container sizing placeholders
    pageContainer.innerHTML = '';
    
    // 1. Create and render Canvas
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    
    // Support high-DPI (Retina) screens for crisp rendering
    const outputScale = window.devicePixelRatio || 1;
    canvas.width = Math.floor(viewport.width * outputScale);
    canvas.height = Math.floor(viewport.height * outputScale);
    canvas.style.width = `${viewport.width}px`;
    canvas.style.height = `${viewport.height}px`;
    
    pageContainer.appendChild(canvas);
    
    const transform = outputScale !== 1
      ? [outputScale, 0, 0, outputScale, 0, 0]
      : null;
      
    const renderContext = {
      canvasContext: ctx,
      transform: transform,
      viewport: viewport
    };
    
    const renderTask = page.render(renderContext);
    pageRenderTasks[pageNum] = renderTask;
    await renderTask.promise;
    
    // 2. Create and render selectable Text layer
    const textContent = await page.getTextContent();
    const textLayerDiv = document.createElement('div');
    textLayerDiv.className = 'textLayer';
    textLayerDiv.style.width = `${viewport.width}px`;
    textLayerDiv.style.height = `${viewport.height}px`;
    textLayerDiv.style.setProperty('--scale-factor', pdfScale);
    pageContainer.appendChild(textLayerDiv);
    
    const textLayerTask = pdfjsLib.renderTextLayer({
      textContent: textContent,
      container: textLayerDiv,
      viewport: viewport,
      textDivs: []
    });
    await textLayerTask.promise;
    cleanRenderedTextLayer(pageContainer, textLayerDiv);
    
    // 3. Create Highlight Overlay Layer & Render existing highlights
    const highlightLayer = document.createElement('div');
    highlightLayer.className = 'highlight-overlay-layer';
    pageContainer.appendChild(highlightLayer);
    
    renderHighlightsOnPage(pageNum, highlightLayer);
    
    // 4. Extract page images
    getPageImages(page).then(images => {
      pdfPageImages[pageNum] = images;
    }).catch(err => {
      console.warn("Failed to extract page images", err);
    });
    
  } catch (err) {
    if (err.name !== 'HeadingTaskCanceledException' && err.name !== 'RenderingCancelledException') {
      console.error(`Page render failed for page ${pageNum}`, err);
    }
  } finally {
    delete pageRenderTasks[pageNum];
    isRenderingPage[pageNum] = false;
  }
}

function unrenderPage(pageNum) {
  const pageContainer = document.getElementById(`page-container-${pageNum}`);
  if (!pageContainer) return;
  
  // Cancel active rendering task
  if (pageRenderTasks[pageNum]) {
    pageRenderTasks[pageNum].cancel();
    delete pageRenderTasks[pageNum];
  }
  
  isRenderingPage[pageNum] = false;
  
  // Re-apply layout sizing so heights don't collapse (prevents scroll jumps)
  if (pageContainer.children.length > 0) {
    const canvas = pageContainer.querySelector('canvas');
    if (canvas) {
      pageContainer.style.width = canvas.style.width;
      pageContainer.style.height = canvas.style.height;
    }
    pageContainer.innerHTML = '';
  }
}

async function rerenderPage(pageNum) {
  // Direct forced redraw (useful during zoom actions)
  unrenderPage(pageNum);
  await renderPage(pageNum);
}

function triggerPDFResize() {
  if (!pdfDoc) return;
  
  // For each page container, query page info at new zoom scale and set placeholder sizes
  const promises = [];
  for (let pageNum = 1; pageNum <= pdfPagesCount; pageNum++) {
    const container = document.getElementById(`page-container-${pageNum}`);
    if (container) {
      const p = pdfDoc.getPage(pageNum).then(page => {
        const viewport = page.getViewport({ scale: pdfScale });
        container.style.width = `${viewport.width}px`;
        container.style.height = `${viewport.height}px`;
      });
      promises.push(p);
    }
  }
  
  Promise.all(promises).then(() => {
    // Re-render only currently visible pages
    const visible = getVisiblePageNumbers();
    visible.forEach(num => {
      rerenderPage(num);
    });
  });
}

// ==========================================================================
// Zoom & Page controls
// ==========================================================================
function initPdfControls() {
  document.getElementById('btn-zoom-in').addEventListener('click', () => {
    if (pdfScale >= 3.0) return;
    pdfScale = parseFloat((pdfScale + 0.15).toFixed(2));
    updateZoomDisplay();
  });
  
  document.getElementById('btn-zoom-out').addEventListener('click', () => {
    if (pdfScale <= 0.6) return;
    pdfScale = parseFloat((pdfScale - 0.15).toFixed(2));
    updateZoomDisplay();
  });
  
  document.getElementById('btn-zoom-fit').addEventListener('click', () => {
    // Fits pdf viewer content exactly to container width minus padding
    if (!pdfDoc) return;
    const container = document.getElementById('pdf-scroll-container');
    const containerWidth = container.clientWidth - 80; // 40px padding left/right
    
    pdfDoc.getPage(1).then(page => {
      const unscaledViewport = page.getViewport({ scale: 1.0 });
      pdfScale = parseFloat((containerWidth / unscaledViewport.width).toFixed(2));
      updateZoomDisplay();
    });
  });
  
  function updateZoomDisplay() {
    document.getElementById('zoom-text').textContent = `${Math.round(pdfScale * 100)}%`;
    triggerPDFResize();
    saveSessionToCloud();
  }
  
  // Page Nav inputs
  const pageInput = document.getElementById('page-number-input');
  
  pageInput.addEventListener('change', () => {
    let targetPage = parseInt(pageInput.value);
    if (isNaN(targetPage) || targetPage < 1) targetPage = 1;
    if (targetPage > pdfPagesCount) targetPage = pdfPagesCount;
    
    jumpToPage(targetPage);
  });
  
  document.getElementById('btn-page-prev').addEventListener('click', () => {
    if (currentPageNum <= 1) return;
    jumpToPage(currentPageNum - 1);
  });
  
  document.getElementById('btn-page-next').addEventListener('click', () => {
    if (currentPageNum >= pdfPagesCount) return;
    jumpToPage(currentPageNum + 1);
  });
}

function jumpToPage(pageNum) {
  if (!pdfDoc) return;
  const pageContainer = document.getElementById(`page-container-${pageNum}`);
  if (pageContainer) {
    pageContainer.scrollIntoView({ behavior: 'smooth', block: 'start' });
    currentPageNum = pageNum;
    document.getElementById('page-number-input').value = pageNum;
    saveSessionToCloud();
  }
}

// ==========================================================================
// Highlights Layer Drawing
// ==========================================================================
function renderHighlightsOnPage(pageNum, overlayLayer) {
  overlayLayer.innerHTML = '';
  
  const pageHighlights = highlights[pageNum] || [];
  pageHighlights.forEach(hl => {
    hl.rects.forEach(r => {
      const span = document.createElement('div');
      span.className = `highlight-span ${hl.color}`;
      span.style.left = `${r.left * pdfScale}px`;
      span.style.top = `${r.top * pdfScale}px`;
      span.style.width = `${r.width * pdfScale}px`;
      span.style.height = `${r.height * pdfScale}px`;
      overlayLayer.appendChild(span);
    });
  });
  
  // Render temporary selection highlight
  if (temporaryHighlight && temporaryHighlight[pageNum]) {
    temporaryHighlight[pageNum].forEach(r => {
      const span = document.createElement('div');
      span.className = `highlight-span temporary`;
      span.style.left = `${r.left * pdfScale}px`;
      span.style.top = `${r.top * pdfScale}px`;
      span.style.width = `${r.width * pdfScale}px`;
      span.style.height = `${r.height * pdfScale}px`;
      overlayLayer.appendChild(span);
    });
  }
}

// ==========================================================================
// Text Selection & Floating Toolbar Controls
// ==========================================================================
function initFloatingToolbar() {
  const toolbar = document.getElementById('floating-toolbar');
  const input = document.getElementById('toolbar-cmd-input');
  const goBtn = document.getElementById('btn-toolbar-cmd-go');
  
  let cachedSelectionRange = null;
  
  // Selection change monitor (real-time visual feedback, does not show toolbar)
  document.addEventListener('selectionchange', throttle(() => {
    // Typing guard: If the user is currently typing in the input box, do NOT hide or reposition the toolbar!
    if (document.activeElement === input) {
      return;
    }
    
    const selection = window.getSelection();
    const selectionStr = selection.toString().trim();
    
    if (!selectionStr) {
      // Don't close if results are currently displaying
      const resultSec = document.getElementById('toolbar-result-section');
      if (resultSec && resultSec.style.display === 'none') {
        clearTemporaryHighlight();
        toolbar.style.display = 'none';
        collapseToolbarResult();
      }
      return;
    }
    
    const processed = processPdfSelection(selection);
    if (!processed) {
      const resultSec = document.getElementById('toolbar-result-section');
      if (resultSec && resultSec.style.display === 'none') {
        clearTemporaryHighlight();
        toolbar.style.display = 'none';
        collapseToolbarResult();
      }
      return;
    }
    
    cachedSelectionRange = selection.getRangeAt(0).cloneRange();
    selectedText = processed.selectedText;
    selectedTextPageNum = processed.firstPageNum;
    selectionHighlightsMap = processed.highlightsMap;
    selectedPagesList = processed.pagesList;
    
    // Render the temporary visual highlight overlay
    updateTemporaryHighlight(processed.highlightsMap);
  }, 100));
  
  const handleSelectionEnd = (e) => {
    if (document.activeElement === input) {
      return;
    }
    // Ignore click events originating inside the toolbar to prevent interference
    if (e && e.target && toolbar.contains(e.target)) {
      return;
    }
    
    setTimeout(() => {
      const selection = window.getSelection();
      const selectionStr = selection.toString().trim();
      
      if (!selectionStr) {
        const resultSec = document.getElementById('toolbar-result-section');
        if (resultSec && resultSec.style.display === 'none') {
          clearTemporaryHighlight();
          toolbar.style.display = 'none';
          collapseToolbarResult();
        }
        return;
      }
      
      // Re-process selection immediately at selection end to avoid race conditions
      const processed = processPdfSelection(selection);
      if (!processed) {
        const resultSec = document.getElementById('toolbar-result-section');
        if (resultSec && resultSec.style.display === 'none') {
          clearTemporaryHighlight();
          toolbar.style.display = 'none';
          collapseToolbarResult();
        }
        return;
      }
      
      // Update final state variables
      cachedSelectionRange = selection.getRangeAt(0).cloneRange();
      selectedText = processed.selectedText;
      selectedTextPageNum = processed.firstPageNum;
      selectionHighlightsMap = processed.highlightsMap;
      selectedPagesList = processed.pagesList;
      
      // Render the temporary visual highlight overlay
      updateTemporaryHighlight(processed.highlightsMap);
    }, 150);
  };
  
  document.addEventListener('mouseup', handleSelectionEnd);
  document.addEventListener('keyup', handleSelectionEnd);
  
  // Right-click context menu listener to show the floating toolbar
  document.addEventListener('contextmenu', (e) => {
    // If clicking inside the toolbar itself, allow normal behavior
    if (toolbar.contains(e.target)) {
      return;
    }
    
    const selection = window.getSelection();
    const selectionStr = selection.toString().trim();
    const scrollContainer = document.getElementById('pdf-scroll-container');
    
    // Only show toolbar if there's active selection text and right-click is inside PDF viewer
    if (selectionStr && selectedText && scrollContainer && scrollContainer.contains(e.target)) {
      e.preventDefault(); // Intercept browser context menu
      
      const resultSec = document.getElementById('toolbar-result-section');
      if (resultSec && resultSec.style.display === 'none') {
        const toolbarWidth = 430;
        const toolbarHeight = 154;
        
        let left = e.clientX - toolbarWidth / 2;
        let top = e.clientY - toolbarHeight - 10;
        
        // Boundary containment checks
        if (left < 10) left = 10;
        if (left + toolbarWidth > window.innerWidth - 10) left = window.innerWidth - toolbarWidth - 10;
        
        if (top < 10) {
          top = e.clientY + 10;
        }
        
        toolbar.style.left = `${left}px`;
        toolbar.style.top = `${top}px`;
        toolbar.style.setProperty('--toolbar-origin-x', `${Math.max(24, Math.min(toolbarWidth - 24, e.clientX - left))}px`);
        toolbar.style.display = 'flex';
      }
    }
  });
  
  function positionToolbar(selectionRect) {
    const toolbarWidth = 430;
    const toolbarHeight = 154;
    
    let left = selectionRect.left + (selectionRect.width / 2) - (toolbarWidth / 2);
    let top = selectionRect.top - toolbarHeight - 10;
    
    // Boundary containment checks
    if (left < 10) left = 10;
    if (left + toolbarWidth > window.innerWidth - 10) left = window.innerWidth - toolbarWidth - 10;
    
    if (top < 10) {
      top = selectionRect.bottom + 10;
    }
    
    toolbar.style.left = `${left}px`;
    toolbar.style.top = `${top}px`;
    toolbar.style.setProperty('--toolbar-origin-x', `${toolbarWidth / 2}px`);
    toolbar.style.display = 'flex';
  }
  
  // Intercept mousedown on tooltip so click doesn't deselect text
  toolbar.addEventListener('mousedown', (e) => {
    // DO NOT prevent default if clicking the input text box, the scroll actions container, or inside the result panel text
    if (e.target.id === 'toolbar-cmd-input' || e.target.tagName === 'INPUT' || e.target.closest('.toolbar-scroll-actions') || e.target.closest('#toolbar-result-section')) {
      return; 
    }
    e.preventDefault();
  });
  
  // Action Handlers: Highlights
  document.querySelectorAll('.btn-highlight').forEach(btn => {
    btn.addEventListener('click', () => {
      const color = btn.getAttribute('data-color');
      applyHighlight(color);
      clearTemporaryHighlight();
      toolbar.style.display = 'none';
      collapseToolbarResult();
    });
  });
  
  // Action Handlers: Format Bold
  document.getElementById('btn-format-bold').addEventListener('click', () => {
    appendToLocalFile(`**${selectedText}**`, selectedTextPageNum);
    clearTemporaryHighlight();
    window.getSelection().removeAllRanges();
    toolbar.style.display = 'none';
    collapseToolbarResult();
  });
  
  // Action Handlers: Format Italic
  document.getElementById('btn-format-italic').addEventListener('click', () => {
    appendToLocalFile(`*${selectedText}*`, selectedTextPageNum);
    clearTemporaryHighlight();
    window.getSelection().removeAllRanges();
    toolbar.style.display = 'none';
    collapseToolbarResult();
  });
  
  // Action Handlers: Format Heading
  document.getElementById('btn-format-heading').addEventListener('click', () => {
    appendToLocalFile(`### ${selectedText}`, selectedTextPageNum);
    clearTemporaryHighlight();
    window.getSelection().removeAllRanges();
    toolbar.style.display = 'none';
    collapseToolbarResult();
  });
  
  // Action Handlers: Format Plain Paragraph
  document.getElementById('btn-format-plain').addEventListener('click', () => {
    appendToLocalFile(selectedText, selectedTextPageNum);
    clearTemporaryHighlight();
    window.getSelection().removeAllRanges();
    toolbar.style.display = 'none';
    collapseToolbarResult();
  });
  
  // Action Handlers: Add to Notes
  document.getElementById('dropdown-action-note').addEventListener('click', () => {
    appendToLocalFile(selectedText, selectedTextPageNum);
    clearTemporaryHighlight();
    window.getSelection().removeAllRanges();
    toolbar.style.display = 'none';
    collapseToolbarResult();
  });
  
  // Action Handlers: Copy Selection as Image
  document.getElementById('dropdown-action-image').addEventListener('click', () => {
    copySelectedAreaAsImage();
  });
  
  // Action Handlers: AI Quick Summarize
  document.getElementById('dropdown-action-summarize').addEventListener('click', () => {
    runInlineAICommand(`/summarize`, selectedText);
  });
  
  // Action Handlers: AI Key Takeaways
  document.getElementById('dropdown-action-keypoints').addEventListener('click', () => {
    runInlineAICommand(`/keypoints`, selectedText);
  });
  
  // Action Handlers: AI Explain Concept
  document.getElementById('dropdown-action-explain').addEventListener('click', () => {
    runInlineAICommand(`/explain`, selectedText);
  });
  
  // Action Handlers: AI Make Flashcards
  document.getElementById('dropdown-action-flashcard').addEventListener('click', () => {
    runInlineAICommand(`/flashcard`, selectedText);
  });
  
  // Action Handlers: Command input triggers
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      const cmd = input.value.trim();
      if (cmd) {
        runInlineAICommand(cmd, selectedText);
        input.value = '';
      }
    }
  });
  
  goBtn.addEventListener('click', () => {
    const cmd = input.value.trim();
    if (cmd) {
      runInlineAICommand(cmd, selectedText);
      input.value = '';
    }
  });
  
  // Siri Result Panel Actions
  document.getElementById('btn-result-close').addEventListener('click', () => {
    collapseToolbarResult();
    clearTemporaryHighlight();
    window.getSelection().removeAllRanges();
    toolbar.style.display = 'none';
  });
  
  document.getElementById('btn-result-add-note').addEventListener('click', () => {
    if (activeAiResponse) {
      appendToLocalFile(activeAiResponse, selectedTextPageNum);
      addSystemChatMessage("Summary appended directly to notes workspace.", "success");
      
      // Switch to notes Preview mode so they see it formatted!
      const previewBtn = document.getElementById('editor-btn-preview');
      if (previewBtn) {
        previewBtn.click();
      }
    }
  });
  
  // Export cached range for use by inline AI runner
  window.getActiveSelectionRange = () => cachedSelectionRange;
}

async function copySelectedAreaAsImage() {
  const toolbar = document.getElementById('floating-toolbar');
  const cachedRange = window.getActiveSelectionRange ? window.getActiveSelectionRange() : null;
  
  if (!cachedRange) {
    addSystemChatMessage("No selection range found to copy as image.", "warning");
    toolbar.style.display = 'none';
    return;
  }
  
  try {
    const selectionRect = cachedRange.getBoundingClientRect();
    const pageContainer = document.getElementById(`page-container-${selectedTextPageNum}`);
    if (!pageContainer) throw new Error("Could not find the active page container.");
    
    const canvas = pageContainer.querySelector('canvas');
    if (!canvas) throw new Error("Could not find page canvas element.");
    
    const canvasRect = canvas.getBoundingClientRect();
    
    // Calculate pixel ratios to map viewport client rects to raw canvas coordinates
    const scaleX = canvas.width / canvasRect.width;
    const scaleY = canvas.height / canvasRect.height;
    
    const x = (selectionRect.left - canvasRect.left) * scaleX;
    const y = (selectionRect.top - canvasRect.top) * scaleY;
    const width = selectionRect.width * scaleX;
    const height = selectionRect.height * scaleY;
    
    if (width <= 0 || height <= 0) {
      throw new Error("Selection bounds are collapsed.");
    }
    
    // Draw the cropped portion to an offscreen canvas
    const cropCanvas = document.createElement('canvas');
    cropCanvas.width = width;
    cropCanvas.height = height;
    const cropCtx = cropCanvas.getContext('2d');
    
    cropCtx.drawImage(canvas, x, y, width, height, 0, 0, width, height);
    
    // Copy offscreen canvas blob to Clipboard
    cropCanvas.toBlob(async (blob) => {
      try {
        await navigator.clipboard.write([
          new ClipboardItem({ 'image/png': blob })
        ]);
        addSystemChatMessage("📸 Selected area successfully copied as image to your clipboard!", "success");
      } catch (err) {
        console.error("Clipboard copy failure", err);
        addSystemChatMessage(`Clipboard write failed: ${err.message}. Try manually copying.`, "error");
      }
    }, 'image/png');
    
  } catch (err) {
    console.error("Copy image failed", err);
    addSystemChatMessage(`Could not copy selection as image: ${err.message}`, "error");
  }
  
  // Hide toolbar
  clearTemporaryHighlight();
  window.getSelection().removeAllRanges();
  toolbar.style.display = 'none';
  collapseToolbarResult();
}

function collapseToolbarResult() {
  const toolbar = document.getElementById('floating-toolbar');
  const actionsSec = document.getElementById('toolbar-actions-section');
  const inputSec = document.getElementById('toolbar-input-section');
  const resultSec = document.getElementById('toolbar-result-section');
  
  toolbar.classList.remove('expanded');
  toolbar.classList.remove('siri-glowing');
  
  actionsSec.style.display = 'flex';
  inputSec.style.display = 'flex';
  resultSec.style.display = 'none';
}

async function runInlineAICommand(command, targetText) {
  const cleanCmd = command.toLowerCase().split(' ')[0];
  
  const toolbar = document.getElementById('floating-toolbar');
  const actionsSec = document.getElementById('toolbar-actions-section');
  const inputSec = document.getElementById('toolbar-input-section');
  const resultSec = document.getElementById('toolbar-result-section');
  const resultTitle = document.getElementById('result-status-title');
  const resultContent = document.getElementById('toolbar-result-content');
  
  // 1. Expand toolbar and show Siri glow
  toolbar.classList.add('expanded');
  toolbar.classList.add('siri-glowing');
  
  actionsSec.style.display = 'none';
  inputSec.style.display = 'none';
  resultSec.style.display = 'flex';
  
  // Update status title
  let displayTitle = "AI Thinking...";
  if (cleanCmd === '/summarize') displayTitle = "AI Summary";
  else if (cleanCmd === '/keypoints') displayTitle = "AI Key Points";
  else if (cleanCmd === '/explain') displayTitle = "AI Explanation";
  resultTitle.textContent = displayTitle;
  
  // Show Siri pulse loading text
  resultContent.innerHTML = `<div class="siri-loading-text">Analyzing selection...</div>`;
  
  // Re-position toolbar to fit its expanded size
  const cachedRange = window.getActiveSelectionRange ? window.getActiveSelectionRange() : null;
  if (cachedRange) {
    try {
      const rect = cachedRange.getBoundingClientRect();
      const toolbarWidth = 380;
      const toolbarHeight = 220; // approximate height when loading
      
      let left = rect.left + (rect.width / 2) - (toolbarWidth / 2);
      let top = rect.top - toolbarHeight - 10;
      
      if (left < 10) left = 10;
      if (left + toolbarWidth > window.innerWidth - 10) left = window.innerWidth - toolbarWidth - 10;
      if (top < 10) top = rect.bottom + 10;
      
      toolbar.style.left = `${left}px`;
      toolbar.style.top = `${top}px`;
    } catch (e) {}
  }
  
  // Build prompt
  let systemPrompt = '';
  let fallbackMessage = '';
  
  switch (cleanCmd) {
    case '/summarize':
      systemPrompt = `Write a concise direct summary of the following text, capturing the most important points and facts. Do not write meta-commentary (do NOT say 'this text explains', 'the author describes', etc.); write the summary directly as a condensed version of the content. Keep it in a single paragraph without bullet points or lists:\n\n${targetText}`;
      fallbackMessage = generateMockSummary(targetText);
      break;
    case '/keypoints':
      systemPrompt = `Extract the main key points and key definitions from the following text as a clear, high-impact bulleted summary. Capture the core facts directly without conversational preambles or meta-commentary:\n\n${targetText}`;
      fallbackMessage = generateMockKeypoints(targetText);
      break;
    case '/explain':
      systemPrompt = `Explain the following text in simple terms, defining any jargon and giving a practical real-world analogy if helpful:\n\n${targetText}`;
      fallbackMessage = generateMockExplanation(targetText);
      break;
    case '/flashcard':
      systemPrompt = `Analyze this text and generate 3 high-quality study flashcards for a student. Return strictly a JSON array of objects with 'front' (question/term) and 'back' (definition/answer) properties, and absolutely no other text, markdown formatting (like \`\`\`json blocks), or conversational introduction. Text:\n\n${targetText}`;
      fallbackMessage = generateMockFlashcards(targetText);
      break;
    default:
      systemPrompt = `${command}\n\nTarget text context:\n"${targetText}"`;
      fallbackMessage = `Analysis of custom query: "${command}"\n\nKeywords detected: ${extractKeywords(targetText).join(', ')}`;
      break;
  }
  
  try {
    let resultText = '';
    if (aiProvider === 'gemini') {
      if (!geminiApiKey) throw new Error("Gemini API Key is missing. Add it in the settings.");
      resultText = await fetchGeminiAPI(systemPrompt);
    } else if (aiProvider === 'openai-compatible') {
      resultText = await fetchOpenAICompatibleAPI(systemPrompt);
    } else if (aiProvider === 'ollama') {
      resultText = await fetchOllamaAPI(systemPrompt);
    } else {
      await new Promise(r => setTimeout(r, 1200));
      resultText = fallbackMessage;
    }
    
    activeAiResponse = resultText;
    
    // Command-specific action logic
    if (cleanCmd === '/flashcard') {
      try {
        const cleanedJson = resultText.replace(/```json|```/g, '').trim();
        const cardsArray = JSON.parse(cleanedJson);
        if (Array.isArray(cardsArray)) {
          addFlashcardsToDeck(cardsArray);
          resultContent.innerHTML = `<p>🃏 Generated and loaded <strong>${cardsArray.length} flashcards</strong> into your study deck!</p><p>Switch to the <em>Flashcards</em> tab in the workspace panel to practice them.</p>`;
          resultTitle.textContent = "Flashcards Created";
        } else {
          throw new Error("Invalid format");
        }
      } catch (e) {
        resultContent.innerHTML = formatMarkdown(resultText);
        resultTitle.textContent = "AI Result";
      }
    } else {
      resultContent.innerHTML = formatMarkdown(resultText);
      resultTitle.textContent = cleanCmd === '/summarize' ? "Summary View" : (cleanCmd === '/explain' ? "Explanation View" : (cleanCmd === '/keypoints' ? "Key Points View" : "AI Response"));
    }
    
    // Final position adjustment based on rendered text height
    if (cachedRange) {
      try {
        const rect = cachedRange.getBoundingClientRect();
        const finalHeight = toolbar.offsetHeight;
        let top = rect.top - finalHeight - 10;
        if (top < 10) top = rect.bottom + 10;
        toolbar.style.top = `${top}px`;
      } catch (e) {}
    }
    
  } catch (err) {
    resultContent.innerHTML = `<div style="color: var(--accent-rose); font-weight: 500;">AI Error: ${err.message}</div>`;
    resultTitle.textContent = "Error";
  }
}

function applyHighlight(color) {
  if (!selectionHighlightsMap || Object.keys(selectionHighlightsMap).length === 0) return;
  
  Object.keys(selectionHighlightsMap).forEach(pNumStr => {
    const pNum = parseInt(pNumStr);
    const rects = selectionHighlightsMap[pNum];
    if (rects.length === 0) return;
    
    if (!highlights[pNum]) {
      highlights[pNum] = [];
    }
    
    highlights[pNum].push({
      text: selectedText,
      color: color,
      rects: rects
    });
    
    // Force redraw highlight layer for this page
    const pageContainer = document.getElementById(`page-container-${pNum}`);
    if (pageContainer) {
      const layer = pageContainer.querySelector('.highlight-overlay-layer');
      if (layer) {
        renderHighlightsOnPage(pNum, layer);
      }
    }
  });
  
  // Persist highlights
  localStorage.setItem('study_highlights', JSON.stringify(highlights));
  saveSessionToCloud();
  
  // Clean window selection visual overlays
  window.getSelection().removeAllRanges();
  clearTemporaryHighlight();
}

// ==========================================================================
// Persistent File Sync (Web File System Access API)
// ==========================================================================
function initNotesEditor() {
  const notesTextarea = document.getElementById('notes-textarea');
  const exportBtn = document.getElementById('btn-export-txt');
  const clearBtn = document.getElementById('editor-btn-clear');
  
  const writeBtn = document.getElementById('editor-btn-write');
  const previewBtn = document.getElementById('editor-btn-preview');
  const previewDiv = document.getElementById('notes-preview');
  const outputStyleSelect = document.getElementById('note-output-style');
  const cheatSheetBtn = document.getElementById('btn-export-cheatsheet');

  if (outputStyleSelect) {
    outputStyleSelect.value = localStorage.getItem('study_notes_style') || 'typeset';
    outputStyleSelect.addEventListener('change', () => {
      localStorage.setItem('study_notes_style', outputStyleSelect.value);
      previewDiv?.classList.toggle('handwritten-preview', outputStyleSelect.value === 'handwritten');
      if (previewBtn?.classList.contains('active')) previewBtn.click();
    });
  }
  
  if (writeBtn && previewBtn && previewDiv) {
    writeBtn.addEventListener('click', () => {
      writeBtn.classList.add('active');
      previewBtn.classList.remove('active');
      notesTextarea.style.display = '';
      previewDiv.style.display = 'none';
      notesTextarea.focus();
    });
    
    previewBtn.addEventListener('click', () => {
      previewBtn.classList.add('active');
      writeBtn.classList.remove('active');
      notesTextarea.style.display = 'none';
      previewDiv.style.display = '';
      previewDiv.classList.toggle('handwritten-preview', outputStyleSelect?.value === 'handwritten');
      
      const text = notesTextarea.value;
      previewDiv.innerHTML = convertMarkdownToHtml(text) || '<p style="color:var(--text-muted); font-style:italic;">No notes written yet...</p>';
    });
  }
  
  // Note Text Change Autosave
  notesTextarea.addEventListener('input', () => {
    persistActiveNotes();
    saveSessionToCloud();
  });
  
  // Formatting helper buttons
  document.getElementById('editor-btn-bold').addEventListener('click', () => insertFormat('**'));
  document.getElementById('editor-btn-italic').addEventListener('click', () => insertFormat('*'));
  document.getElementById('editor-btn-header').addEventListener('click', () => insertFormat('\n# '));
  document.getElementById('editor-btn-inline-math')?.addEventListener('click', () => insertFormat('$'));
  document.getElementById('editor-btn-display-math')?.addEventListener('click', () => insertDisplayMath());
  
  function insertFormat(wrapper) {
    const startPos = notesTextarea.selectionStart;
    const endPos = notesTextarea.selectionEnd;
    const val = notesTextarea.value;
    const selected = val.substring(startPos, endPos);
    
    let replacement = '';
    if (wrapper === '\n# ') {
      replacement = wrapper + selected;
    } else {
      replacement = wrapper + selected + wrapper;
    }
    
    notesTextarea.value = val.substring(0, startPos) + replacement + val.substring(endPos);
    notesTextarea.focus();
    notesTextarea.selectionStart = startPos + wrapper.length;
    notesTextarea.selectionEnd = startPos + wrapper.length + selected.length;
    
    // Trigger save
    persistActiveNotes();
    saveSessionToCloud();
  }

  function insertDisplayMath() {
    const startPos = notesTextarea.selectionStart;
    const endPos = notesTextarea.selectionEnd;
    const selected = notesTextarea.value.substring(startPos, endPos) || '\\frac{a}{b}';
    const replacement = `\n$$\n${selected}\n$$\n`;
    notesTextarea.setRangeText(replacement, startPos, endPos, 'end');
    notesTextarea.focus();
    persistActiveNotes();
    saveSessionToCloud();
  }
  
  clearBtn.addEventListener('click', () => {
    if (confirm("Are you sure you want to clear your study workspace notes? This will clear local memory, though connected file content on disk remains unchanged.")) {
      notesTextarea.value = '';
      persistActiveNotes();
      saveSessionToCloud();
    }
  });
  
  exportBtn.addEventListener('click', () => {
    const text = notesTextarea.value;
    const blob = new Blob([text], { type: 'text/plain' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'study_notes.txt';
    a.click();
  });
  
  const exportDocxBtn = document.getElementById('btn-export-docx');
  if (exportDocxBtn) {
    exportDocxBtn.addEventListener('click', () => {
      const text = notesTextarea.value;
      const htmlContent = convertMarkdownToHtml(text);
      const fontFamily = outputStyleSelect?.value === 'handwritten'
        ? '"Bradley Hand", "Noteworthy", "Marker Felt", cursive'
        : '"Iowan Old Style", Georgia, serif';
      const styledDocument = `<html><head><meta charset="utf-8"></head><body style="font-family:${fontFamily};line-height:1.65;color:#242323">${htmlContent}</body></html>`;
      const blob = new Blob(['\ufeff' + styledDocument], { type: 'application/msword' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'study_notes.doc';
      a.click();
    });
  }
  
  const exportPdfBtn = document.getElementById('btn-export-pdf');
  async function exportNotesPdf(mode = 'notes', triggerButton = exportPdfBtn) {
      const text = notesTextarea.value;
      const cleanDocumentName = activeDocumentName || 'Study Notes';
      const exportHtml = buildNotesExportDocument({
        text,
        documentName: cleanDocumentName,
        katexCss,
        baseHref: window.studybuddy?.isNative ? 'http://localhost:17871/' : `${location.origin}/`,
        style: outputStyleSelect?.value || 'typeset',
        mode
      });
      const outputLabel = mode === 'cheatsheet' ? 'Cheat Sheet' : 'Study Notes';

      if (window.studybuddy?.exportNotesPdf) {
        if (triggerButton) triggerButton.disabled = true;
        showSaveStatus(mode === 'cheatsheet' ? 'Preparing cheat sheet…' : 'Preparing polished PDF…');
        try {
          const result = await window.studybuddy.exportNotesPdf({
            html: exportHtml,
            defaultName: `${cleanDocumentName.replace(/\.pdf$/i, '')} - ${outputLabel}.pdf`,
            footerLabel: mode === 'cheatsheet' ? 'StudyBuddy Cheat Sheet' : 'StudyBuddy Notes'
          });
          if (result?.ok) showSaveStatus(mode === 'cheatsheet' ? 'Cheat sheet exported' : 'PDF exported');
          else if (!result?.cancelled) showSaveStatus('PDF export failed');
        } catch (error) {
          console.error('Native PDF export failed', error);
          showSaveStatus('PDF export failed');
        } finally {
          if (triggerButton) triggerButton.disabled = false;
        }
        return;
      }

      const printWindow = window.open('', '_blank', 'width=800,height=600');
      if (printWindow) {
        printWindow.document.write(exportHtml);
        printWindow.document.close();
        printWindow.addEventListener('load', () => {
          printWindow.print();
          setTimeout(() => printWindow.close(), 500);
        }, { once: true });
      }
  }

  if (exportPdfBtn) {
    exportPdfBtn.addEventListener('click', () => exportNotesPdf('notes', exportPdfBtn));
  }
  if (cheatSheetBtn) {
    cheatSheetBtn.addEventListener('click', () => exportNotesPdf('cheatsheet', cheatSheetBtn));
  }
  
}

function initNotesDictation() {
  const button = document.getElementById('btn-notes-dictation');
  const label = document.getElementById('dictation-label');
  const notes = document.getElementById('notes-textarea');
  if (!button || !label || !notes || !window.studybuddy?.speechAvailable) return;
  button.style.display = 'inline-flex';

  let active = false;
  let prefix = '';
  let suffix = '';
  let latestText = '';

  const setState = (state, text) => {
    button.classList.toggle('listening', state === 'listening');
    button.classList.toggle('requesting', state === 'requesting');
    button.classList.toggle('speech-error', state === 'error');
    button.setAttribute('aria-pressed', String(state === 'listening' || state === 'requesting'));
    button.setAttribute('aria-label', state === 'listening' ? 'Stop notes dictation' : 'Start notes dictation');
    label.textContent = text;
  };

  const renderTranscript = (text) => {
    latestText = text || '';
    const trailingSpace = latestText && suffix && !/\s$/.test(latestText) && !/^\s/.test(suffix) ? ' ' : '';
    notes.value = `${prefix}${latestText}${trailingSpace}${suffix}`;
    const cursor = prefix.length + latestText.length;
    notes.setSelectionRange(cursor, cursor);
    notes.scrollTop = notes.scrollHeight;
  };

  const saveTranscript = () => {
    if (!latestText) return;
    notes.dispatchEvent(new Event('input', { bubbles: true }));
    saveActiveDocumentSession();
  };

  const finish = (message = 'Dictate') => {
    saveTranscript();
    active = false;
    setState('idle', message);
    window.setTimeout(() => { if (!active) setState('idle', 'Dictate'); }, message === 'Dictate' ? 0 : 1800);
  };

  window.studybuddy.onSpeechEvent((event) => {
    if (!event) return;
    if (event.type === 'ready') {
      active = true;
      setState('listening', 'Listening');
    } else if (event.type === 'partial') {
      renderTranscript(event.text);
      setState('listening', 'Listening');
    } else if (event.type === 'final') {
      renderTranscript(event.text);
      finish('Added');
    } else if (event.type === 'error') {
      finish('Permission needed');
      setState('error', 'Permission needed');
      addSystemChatMessage(escapeHtml(event.message || 'Apple Speech could not start.'), 'warning');
    } else if (event.type === 'stopped' && active) {
      finish(latestText ? 'Added' : 'Dictate');
    }
  });

  button.addEventListener('click', async () => {
    document.getElementById('tab-btn-notes')?.click();
    document.getElementById('editor-btn-write')?.click();
    if (active || button.classList.contains('requesting')) {
      await window.studybuddy.stopSpeech();
      finish(latestText ? 'Added' : 'Dictate');
      return;
    }

    const start = notes.selectionStart ?? notes.value.length;
    const end = notes.selectionEnd ?? start;
    const before = notes.value.slice(0, start);
    const needsSpace = before.length && !/\s$/.test(before);
    prefix = before + (needsSpace ? ' ' : '');
    suffix = notes.value.slice(end);
    latestText = '';
    setState('requesting', 'Starting…');
    const result = await window.studybuddy.startSpeech(navigator.language || 'en-US');
    if (!result?.ok) {
      active = false;
      setState('error', 'Unavailable');
      addSystemChatMessage(escapeHtml(result?.error || 'Apple Speech is unavailable in this build.'), 'warning');
      window.setTimeout(() => setState('idle', 'Dictate'), 1800);
    } else {
      active = true;
    }
  });
}

async function appendToLocalFile(text, pageNum = '') {
  const editor = document.getElementById('notes-textarea');
  
  // Clean append: double newline if editor contains notes, otherwise empty prefix
  const prefix = editor.value ? "\n\n" : "";
  const fullNote = prefix + text;
  
  // 1. Update text area locally
  editor.value += fullNote;
  editor.scrollTop = editor.scrollHeight;
  persistActiveNotes();
  saveSessionToCloud();
  
  showSaveStatus("Saved to this workspace");
}

function showSaveStatus(message) {
  const indicator = document.getElementById('save-status');
  indicator.textContent = message;
  indicator.style.opacity = '1.0';
  
  setTimeout(() => {
    indicator.textContent = "Saved locally";
  }, 3000);
}

// ==========================================================================
// AI Assistant Q&A Chat Client
// ==========================================================================
function initNotesEditorAndChat() {
  const chatInput = document.getElementById('chat-input');
  const chatSendBtn = document.getElementById('btn-chat-send');
  
  chatSendBtn.addEventListener('click', () => {
    const text = chatInput.value.trim();
    if (text) {
      sendUserChatMessage(text);
      chatInput.value = '';
    }
  });
  
  chatInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      const text = chatInput.value.trim();
      if (text) {
        sendUserChatMessage(text);
        chatInput.value = '';
      }
    }
  });
  
  // Prompt chips
  document.getElementById('btn-shortcut-summarize').addEventListener('click', () => {
    if (selectedText) {
      runAICommand('/summarize', selectedText);
    } else {
      addSystemChatMessage("Please select text in the PDF reader first.", "warning");
    }
  });
  
  document.getElementById('btn-shortcut-explain').addEventListener('click', () => {
    if (selectedText) {
      runAICommand('/explain', selectedText);
    } else {
      addSystemChatMessage("Please select text in the PDF reader first.", "warning");
    }
  });
  
  document.getElementById('btn-shortcut-questions').addEventListener('click', () => {
    if (selectedText) {
      runAICommand('/questions', selectedText);
    } else {
      // Prompt for whole page Q&A
      addSystemChatMessage(`No selection found. Generating study questions for current <strong>Page ${currentPageNum}</strong>...`, "primary");
      extractPageText(currentPageNum).then(text => {
        if (text) {
          runAICommand('/questions', text);
        } else {
          addSystemChatMessage("Failed to extract page text. Try manually selecting text.", "error");
        }
      });
    }
  });
}

// Make sure this is bound
const timerCheck = setInterval(() => {
  if (document.getElementById('btn-chat-send')) {
    initNotesEditorAndChat();
    clearInterval(timerCheck);
  }
}, 50);

async function extractPageText(pageNum) {
  if (!pdfDoc) return '';
  try {
    const page = await pdfDoc.getPage(pageNum);
    const textContent = await page.getTextContent();
    return textContent.items.map(item => item.str).join(' ');
  } catch (err) {
    console.error("Text extraction failure", err);
    return '';
  }
}

function sendUserChatMessage(message) {
  addChatMessage('user', message);
  
  // Switch to AI tab to show results if not active
  document.getElementById('tab-btn-ai').click();
  
  // Check for slash commands in standard chat
  if (message.startsWith('/')) {
    const firstSpaceIndex = message.indexOf(' ');
    const cmd = firstSpaceIndex !== -1 ? message.substring(0, firstSpaceIndex) : message;
    const body = firstSpaceIndex !== -1 ? message.substring(firstSpaceIndex + 1) : selectedText;
    
    runAICommand(cmd, body || 'No text selected.');
  } else {
    // Normal Q&A Prompt
    processGeneralAIPrompt(message);
  }
}

function addChatMessage(role, text) {
  const container = document.getElementById('chat-messages');
  const bubble = document.createElement('div');
  bubble.className = `message ${role}-message`;
  bubble.innerHTML = role === 'user' ? escapeHtml(text).replace(/\n/g, '<br>') : formatMarkdown(text);
  
  container.appendChild(bubble);
  container.scrollTop = container.scrollHeight;
  saveActiveDocumentSession();
}

function addSystemChatMessage(text, type = 'system') {
  const container = document.getElementById('chat-messages');
  const bubble = document.createElement('div');
  bubble.className = `message system-message alert-${type}`;
  bubble.innerHTML = text;
  
  container.appendChild(bubble);
  container.scrollTop = container.scrollHeight;
  saveActiveDocumentSession();
}

// Markdown formatting simplified regex
function formatMarkdown(text) {
  if (!text) return '';
  
  // 1. Escaping HTML first
  let html = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
    
  // 2. Code blocks
  html = html.replace(/```(?:javascript|json|html|css|python)?\n([\s\S]*?)```/g, '<pre><code>$1</code></pre>');
  
  // 3. Inline code
  html = html.replace(/`([^`]+)`/g, '<code>$1</code>');
  
  // 4. Headers
  html = html.replace(/^# (.*$)/gim, '<h3>$1</h3>');
  html = html.replace(/^## (.*$)/gim, '<h4>$1</h4>');
  html = html.replace(/^### (.*$)/gim, '<h5>$1</h5>');
  
  // 5. Bold & Italic
  html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/\*([^*]+)\*/g, '<em>$1</em>');
  
  // 6. Bullet lists
  html = html.replace(/^\s*[\*\-]\s+(.*$)/gim, '<li>$1</li>');
  
  // Wrap list items in <ul>
  const lines = html.split('\n');
  let inList = false;
  const processedLines = lines.map(line => {
    const trimmed = line.trim();
    if (trimmed.startsWith('<li>')) {
      if (!inList) {
        inList = true;
        return '<ul>' + line;
      }
      return line;
    } else {
      if (inList) {
        inList = false;
        return '</ul>' + line;
      }
    }
    
    // Normal paragraph spacing: wrap non-header/non-list elements
    if (trimmed && !trimmed.startsWith('<h') && !trimmed.startsWith('<pre') && !trimmed.startsWith('</pre') && !trimmed.startsWith('<code>') && !trimmed.startsWith('</code') && !trimmed.startsWith('<ul>') && !trimmed.startsWith('</ul>')) {
      return `<p>${line}</p>`;
    }
    return line;
  });
  
  if (inList) {
    processedLines.push('</ul>');
  }
  
  return processedLines.join('\n');
}

function escapeHtml(text) {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// AI Engine
async function runAICommand(command, targetText) {
  const cleanCmd = command.toLowerCase().split(' ')[0];
  
  addChatMessage('user', `AI Command: ${cleanCmd}`);
  
  // Prompt Construction
  let systemPrompt = '';
  let fallbackMessage = '';
  
  switch (cleanCmd) {
    case '/summarize':
      systemPrompt = `Write a concise direct summary of the following text, capturing the most important points and facts. Do not write meta-commentary (do NOT say 'this text explains', 'the author describes', etc.); write the summary directly as a condensed version of the content. Keep it in a single paragraph without bullet points or lists:\n\n${targetText}`;
      fallbackMessage = generateMockSummary(targetText);
      break;
    case '/keypoints':
      systemPrompt = `Extract the main key points and key definitions from the following text as a clear, high-impact bulleted summary. Capture the core facts directly without conversational preambles or meta-commentary:\n\n${targetText}`;
      fallbackMessage = generateMockKeypoints(targetText);
      break;
    case '/explain':
      systemPrompt = `Explain the following text in simple terms, defining any jargon and giving a practical real-world analogy if helpful:\n\n${targetText}`;
      fallbackMessage = generateMockExplanation(targetText);
      break;
    case '/flashcard':
      systemPrompt = `Analyze this text and generate 3 high-quality study flashcards for a student. Return strictly a JSON array of objects with 'front' (question/term) and 'back' (definition/answer) properties, and absolutely no other text, markdown formatting (like \`\`\`json blocks), or conversational introduction. Example structure: [{"front": "Front question", "back": "Back answer"}]. Text:\n\n${targetText}`;
      fallbackMessage = generateMockFlashcards(targetText);
      break;
    case '/note':
      // Append text directly to notes file with custom user annotation
      const annotation = command.substring(6).trim();
      const contentToNote = `Annotation: ${annotation}\nText: "${targetText}"`;
      appendToLocalFile(contentToNote, currentPageNum);
      addChatMessage('assistant', `Added selection to note file with annotation: <em>"${annotation}"</em>`);
      return;
    default:
      // Custom AI Query
      systemPrompt = `${command}\n\nTarget text context:\n"${targetText}"`;
      fallbackMessage = `Demo Mode Answer to custom query: "${command}"\n\nBased on your selected text, this is a simulated analysis showing how Study answers questions. Key keywords detected: ${extractKeywords(targetText).join(', ')}`;
      break;
  }
  
  // Execute request
  showChatLoadingBubble();
  
  try {
    let resultText = '';
    
    if (aiProvider === 'gemini') {
      if (!geminiApiKey) throw new Error("Gemini API Key is missing. Go to settings (top-right) to add it.");
      resultText = await fetchGeminiAPI(systemPrompt);
    } else if (aiProvider === 'openai-compatible') {
      resultText = await fetchOpenAICompatibleAPI(systemPrompt);
    } else if (aiProvider === 'ollama') {
      resultText = await fetchOllamaAPI(systemPrompt);
    } else {
      // Simulate delay
      await new Promise(r => setTimeout(r, 1200));
      resultText = fallbackMessage;
    }
    
    removeChatLoadingBubble();
    
    // Command-specific action logic
    if (cleanCmd === '/flashcard') {
      try {
        // Strip markdown code fences if LLM generated them
        const cleanedJson = resultText.replace(/```json|```/g, '').trim();
        const cardsArray = JSON.parse(cleanedJson);
        
        if (Array.isArray(cardsArray)) {
          addFlashcardsToDeck(cardsArray);
          addChatMessage('assistant', `🃏 Generated and loaded **${cardsArray.length}** interactive flashcards into your study deck! Switch to the **Flashcards** tab to practice.`);
        } else {
          throw new Error("Parsed JSON is not an array");
        }
      } catch (e) {
        console.error("JSON parsing flashcard error", resultText, e);
        addChatMessage('assistant', `Failed to parse generated flashcards. Here is the raw text output:\n\n${resultText}`);
      }
    } else {
      addChatMessage('assistant', resultText);
    }
    
  } catch (err) {
    removeChatLoadingBubble();
    addSystemChatMessage(`AI processing error: ${err.message}`, "error");
  }
}

async function processGeneralAIPrompt(prompt) {
  showChatLoadingBubble();
  
  try {
    let resultText = '';
    if (ragBuildPromise) await ragBuildPromise;
    const passages = await retrieveDocumentContext(`${prompt} ${selectedText || ''}`, 9);
    if (!passages.length) throw new Error('The local document index is not ready yet. Try again in a moment.');
    const enrichedPrompt = buildRagPrompt(prompt, passages);
      
    if (aiProvider === 'gemini') {
      if (!geminiApiKey) throw new Error("Gemini API Key is missing. Go to settings (top-right) to add it.");
      resultText = await fetchGeminiAPI(enrichedPrompt);
    } else if (aiProvider === 'openai-compatible') {
      resultText = await fetchOpenAICompatibleAPI(enrichedPrompt);
    } else if (aiProvider === 'ollama') {
      const visualQuestion = /\b(image|diagram|figure|chart|table|graph|equation|formula|illustration|shown|visible|layout|page|screenshot)\b/i.test(prompt);
      const pageImage = isMultimodalOllamaModel(ollamaModel) && visualQuestion ? capturePageForMultimodal(currentPageNum) : null;
      resultText = await fetchOllamaAPI(enrichedPrompt, pageImage ? [pageImage] : []);
    } else {
      resultText = `**Local retrieval found these relevant passages:**\n\n${passages.slice(0, 3).map(item => `- **Page ${item.page}:** ${item.text.slice(0, 240)}${item.text.length > 240 ? '…' : ''}`).join('\n')}\n\nSelect **Ollama** in Settings and choose a local Gemma model to synthesize a complete answer while keeping the document on this device.`;
    }
    
    removeChatLoadingBubble();
    addRagAssistantMessage(resultText, passages);
  } catch (err) {
    removeChatLoadingBubble();
    addSystemChatMessage(`AI processing error: ${err.message}`, "error");
  }
}

async function fetchGeminiAPI(prompt) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${geminiApiKey}`;
  
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }]
    })
  });
  
  if (!response.ok) {
    const errorData = await response.json();
    throw new Error(errorData.error?.message || `HTTP error ${response.status}`);
  }
  
  const data = await response.json();
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error("Received empty content from Gemini API");
  
  return text;
}

async function fetchOpenAICompatibleAPI(prompt) {
  if (!openAIBaseUrl || !openAIModel || !openAIApiKey) {
    throw new Error('Complete the endpoint, model, and API key in AI settings.');
  }
  const response = await fetch(`${openAIBaseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${openAIApiKey}`
    },
    body: JSON.stringify({
      model: openAIModel,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.2
    })
  });
  if (!response.ok) {
    let message = `Compatible API error (HTTP ${response.status})`;
    try { message = (await response.json()).error?.message || message; } catch (_) {}
    throw new Error(message);
  }
  const data = await response.json();
  const text = data.choices?.[0]?.message?.content;
  if (!text) throw new Error('The compatible API returned no message content.');
  return text;
}

async function fetchConfiguredAI(prompt) {
  if (aiProvider === 'gemini') {
    if (!geminiApiKey) throw new Error('Gemini API key is missing.');
    return fetchGeminiAPI(prompt);
  }
  if (aiProvider === 'openai-compatible') return fetchOpenAICompatibleAPI(prompt);
  if (aiProvider === 'ollama') return fetchOllamaAPI(prompt);
  throw new Error('Select an AI provider in Settings first.');
}

function capturePageForMultimodal(pageNumber) {
  const source = document.querySelector(`#page-container-${pageNumber} canvas`);
  if (!source) return null;
  try {
    const maxDimension = 1280;
    const scale = Math.min(1, maxDimension / Math.max(source.width, source.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(source.width * scale));
    canvas.height = Math.max(1, Math.round(source.height * scale));
    canvas.getContext('2d', { alpha: false }).drawImage(source, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL('image/jpeg', .82).split(',')[1];
  } catch (error) {
    console.info('Could not attach the current PDF page image', error.message);
    return null;
  }
}

function isMultimodalOllamaModel(modelName) {
  return /^(gemma3:(4b|12b|27b)|gemma3n:|gemma4:)/i.test(modelName || '');
}

async function fetchOllamaAPI(prompt, images = []) {
  const response = await ollamaFetch('/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: ollamaModel,
      messages: [
        { role: 'system', content: 'You are a precise local study assistant. Use only the supplied document context and cite page numbers.' },
        { role: 'user', content: prompt, ...(images.length ? { images } : {}) }
      ],
      stream: false,
      options: {
        temperature: 0.2,
        num_ctx: 8192
      }
    })
  });
  
  if (!response.ok) {
    let errorText = '';
    try {
      const errData = await response.json();
      errorText = errData.error || '';
    } catch (e) {}
    throw new Error(errorText || `Ollama server error (HTTP ${response.status}). Make sure Ollama is running and model '${ollamaModel}' is pulled.`);
  }
  
  const data = await response.json();
  const text = data.message?.content;
  if (!text) throw new Error("Received empty content from local Ollama model");
  
  return text;
}

function showChatLoadingBubble() {
  const container = document.getElementById('chat-messages');
  const bubble = document.createElement('div');
  bubble.className = "message assistant-message chat-loader";
  bubble.id = "chat-loading-indicator";
  bubble.innerHTML = `
    <div class="typing-dots">
      <span class="dot"></span>
      <span class="dot"></span>
      <span class="dot"></span>
    </div>
  `;
  container.appendChild(bubble);
  container.scrollTop = container.scrollHeight;
}

function removeChatLoadingBubble() {
  const loader = document.getElementById('chat-loading-indicator');
  if (loader) loader.remove();
}

// Styling classes helper injection for dots loading animation
const stylesLoader = document.createElement('style');
stylesLoader.textContent = `
  .typing-dots { display: flex; gap: 4px; padding: 4px 0; }
  .typing-dots .dot { width: 6px; height: 6px; border-radius: 50%; background-color: var(--text-secondary); animation: typeDot 1.4s infinite both; }
  .typing-dots .dot:nth-child(2) { animation-delay: .2s; }
  .typing-dots .dot:nth-child(3) { animation-delay: .4s; }
  @keyframes typeDot { 0%, 80%, 100% { transform: scale(0.6); opacity: 0.4; } 40% { transform: scale(1.1); opacity: 1; } }
  .alert-warning { border-color: rgba(245, 158, 11, 0.2) !important; background-color: rgba(245, 158, 11, 0.05) !important; }
  .alert-error { border-color: rgba(239, 68, 68, 0.2) !important; background-color: rgba(239, 68, 68, 0.05) !important; }
  .alert-success { border-color: rgba(16, 185, 129, 0.2) !important; background-color: rgba(16, 185, 129, 0.05) !important; }
  .alert-primary { border-color: rgba(99, 102, 241, 0.2) !important; background-color: rgba(99, 102, 241, 0.05) !important; }
`;
document.head.appendChild(stylesLoader);

// ==========================================================================
// Mock AI Output Generators (for out-of-the-box demo mode)
// ==========================================================================
function extractKeywords(text) {
  return text.split(/\s+/)
    .map(w => w.replace(/[^a-zA-Z]/g, ''))
    .filter(w => w.length > 5)
    .slice(0, 5);
}

function generateMockSummary(text) {
  const sentences = text.split(/[.!?]+/).map(s => s.trim()).filter(s => s.length > 20);
  if (sentences.length > 0) {
    // Return the first 2-3 sentences directly as the summary
    return sentences.slice(0, Math.min(3, sentences.length)).join('. ') + '.';
  }
  return text.substring(0, 300) + '...';
}

function generateMockKeypoints(text) {
  const sentences = text.split(/[.!?]+/).map(s => s.trim()).filter(s => s.length > 15);
  if (sentences.length > 0) {
    const bulletPoints = sentences.slice(0, Math.min(4, sentences.length))
      .map(s => `* **Key Point**: ${s}.`)
      .join('\n');
    return `### Key Takeaways\n${bulletPoints}`;
  }
  const keywords = extractKeywords(text);
  return `### Key Takeaways\n* **Core Concept**: Focuses on ${keywords.join(', ')}.\n* **Main Point**: ${text.substring(0, 150)}...`;
}

function generateMockExplanation(text) {
  const keywords = extractKeywords(text);
  const keyword = keywords[0] || 'this concept';
  
  return `### Simple Explanation
Let's break down **${keyword}** into plain English:

This refers to the process where elements cooperate or build on each other to produce a unified result. 

💡 **Analogy**:
Think of it like **baking a cake**. You have separate ingredients—flour, sugar, eggs. Individually they are simple, but when baked together under heat, they undergo a structural transition to become a cake. Similarly, *${keyword}* is about individual components combining to generate a much larger effect.`;
}

function generateMockFlashcards(text) {
  const keywords = extractKeywords(text);
  const kw1 = keywords[0] || 'Key term';
  const kw2 = keywords[1] || 'Critical parameter';
  
  return JSON.stringify([
    {
      front: `What is the significance of ${kw1} in the context of this study?`,
      back: `It acts as the primary variable for determining systemic behavior and resolving structural constraints.`
    },
    {
      front: `Explain how ${kw2} interacts with the document's central thesis.`,
      back: `It provides the quantitative baseline required to validate hypotheses and measure performance parameters.`
    },
    {
      front: "What is the primary conclusion that can be drawn from the selected text?",
      back: "That the studied elements display high sensitivity to environmental conditions and require calibration."
    }
  ]);
}

// ==========================================================================
// Flashcards Deck Manager
// ==========================================================================
function initFlashcards() {
  const cardWidget = document.getElementById('flashcard-card');
  const cardInner = document.getElementById('card-inner');
  const btnPrev = document.getElementById('btn-card-prev');
  const btnNext = document.getElementById('btn-card-next');
  const clearBtn = document.getElementById('btn-clear-flashcards');
  
  cardWidget.addEventListener('click', () => {
    cardWidget.classList.toggle('flipped');
  });
  
  btnPrev.addEventListener('click', (e) => {
    e.stopPropagation(); // Stop card flipping on click
    if (currentCardIndex > 0) {
      currentCardIndex--;
      showCard(currentCardIndex);
    }
  });
  
  btnNext.addEventListener('click', (e) => {
    e.stopPropagation();
    if (currentCardIndex < flashcards.length - 1) {
      currentCardIndex++;
      showCard(currentCardIndex);
    }
  });
  
  clearBtn.addEventListener('click', () => {
    if (confirm("Reset flashcard deck? All cards will be deleted.")) {
      flashcards = [];
      localStorage.removeItem('study_flashcards');
      updateFlashcardsUI();
      saveSessionToCloud();
    }
  });
  
  // Render cards on start
  updateFlashcardsUI();
}

function addFlashcardsToDeck(newCards) {
  // Append new cards to deck
  flashcards = [...flashcards, ...newCards];
  localStorage.setItem('study_flashcards', JSON.stringify(flashcards));
  
  currentCardIndex = flashcards.length - newCards.length; // Jump to start of new cards
  updateFlashcardsUI();
  saveSessionToCloud();
}

function updateFlashcardsUI() {
  const emptyView = document.getElementById('empty-deck-view');
  const cardWidget = document.getElementById('flashcard-card');
  const controls = document.getElementById('deck-controls');
  const countLabel = document.getElementById('flashcard-count-label');
  
  countLabel.textContent = `${flashcards.length} Flashcard${flashcards.length === 1 ? '' : 's'} Generated`;
  
  if (flashcards.length === 0) {
    emptyView.style.display = 'flex';
    cardWidget.style.display = 'none';
    controls.style.display = 'none';
  } else {
    emptyView.style.display = 'none';
    cardWidget.style.display = 'block';
    controls.style.display = 'flex';
    showCard(currentCardIndex);
  }
}

function showCard(index) {
  const cardWidget = document.getElementById('flashcard-card');
  cardWidget.classList.remove('flipped'); // Reset flip state
  
  const frontContent = document.getElementById('card-front-content');
  const backContent = document.getElementById('card-back-content');
  const indexDisplay = document.getElementById('card-index-display');
  
  const card = flashcards[index];
  frontContent.textContent = card.front;
  backContent.textContent = card.back;
  
  indexDisplay.textContent = `${index + 1} / ${flashcards.length}`;
}

// ==========================================================================
// Utilities (Throttle / Debounce)
// ==========================================================================
function throttle(func, limit) {
  let inThrottle;
  return function() {
    const args = arguments;
    const context = this;
    if (!inThrottle) {
      func.apply(context, args);
      inThrottle = true;
      setTimeout(() => inThrottle = false, limit);
    }
  };
}

// ==========================================================================
// Temporary Selection Highlight & Image Selection Extraction Helpers
// ==========================================================================

function clearTemporaryHighlight(clearSelectionState = true) {
  if (temporaryHighlight) {
    const pagesToRedraw = Object.keys(temporaryHighlight);
    temporaryHighlight = null;
    pagesToRedraw.forEach(pNumStr => {
      const pNum = parseInt(pNumStr);
      const pageContainer = document.getElementById(`page-container-${pNum}`);
      if (pageContainer) {
        const layer = pageContainer.querySelector('.highlight-overlay-layer');
        if (layer) {
          renderHighlightsOnPage(pNum, layer);
        }
      }
    });
  }
  if (clearSelectionState) {
    selectedPagesList = [];
    selectionHighlightsMap = {};
    cleanUpOffscreenPages();
  }
}

function updateTemporaryHighlight(highlightsMap) {
  // Clear any existing temporary highlights but retain selection coordinates state
  clearTemporaryHighlight(false);
  
  // Set the new temporary highlights
  temporaryHighlight = highlightsMap;
  
  // Redraw highlights on all pages in the map
  Object.keys(highlightsMap).forEach(pNumStr => {
    const pNum = parseInt(pNumStr);
    const pageContainer = document.getElementById(`page-container-${pNum}`);
    if (pageContainer) {
      const layer = pageContainer.querySelector('.highlight-overlay-layer');
      if (layer) {
        renderHighlightsOnPage(pNum, layer);
      }
    }
  });
}

function multiplyMatrices(m1, m2) {
  return [
    m1[0] * m2[0] + m1[2] * m2[1],
    m1[1] * m2[0] + m1[3] * m2[1],
    m1[0] * m2[2] + m1[2] * m2[3],
    m1[1] * m2[2] + m1[3] * m2[3],
    m1[0] * m2[4] + m1[2] * m2[5] + m1[4],
    m1[1] * m2[4] + m1[3] * m2[5] + m1[5]
  ];
}

async function getPageImages(page) {
  const opList = await page.getOperatorList();
  const viewport = page.getViewport({ scale: 1.0 });
  
  let ctm = [1, 0, 0, 1, 0, 0];
  const ctmStack = [];
  const images = [];
  
  const OPS = pdfjsLib.OPS;
  
  for (let i = 0; i < opList.fnArray.length; i++) {
    const fn = opList.fnArray[i];
    const args = opList.argsArray[i];
    
    if (fn === OPS.save) {
      ctmStack.push([...ctm]);
    } else if (fn === OPS.restore) {
      if (ctmStack.length > 0) {
        ctm = ctmStack.pop();
      }
    } else if (fn === OPS.transform) {
      ctm = multiplyMatrices(ctm, args);
    } else if (fn === OPS.paintImageXObject || fn === OPS.paintInlineImageXObject || fn === OPS.paintImageMaskXObject || (OPS.paintInlineImage && fn === OPS.paintInlineImage)) {
      // Apply viewport transformation to ctm
      const tx = multiplyMatrices(viewport.transform, ctm);
      
      // Calculate corners in scale 1.0 viewport space
      const c1 = [tx[4], tx[5]];
      const c2 = [tx[0] + tx[4], tx[1] + tx[5]];
      const c3 = [tx[2] + tx[4], tx[3] + tx[5]];
      const c4 = [tx[0] + tx[2] + tx[4], tx[1] + tx[3] + tx[5]];
      
      const left = Math.min(c1[0], c2[0], c3[0], c4[0]);
      const top = Math.min(c1[1], c2[1], c3[1], c4[1]);
      const right = Math.max(c1[0], c2[0], c3[0], c4[0]);
      const bottom = Math.max(c1[1], c2[1], c3[1], c4[1]);
      
      images.push({
        left,
        top,
        width: right - left,
        height: bottom - top
      });
    }
  }
  return images;
}

function checkSelectionContainsImage(selectionRange, pageNum) {
  const pageContainer = document.getElementById(`page-container-${pageNum}`);
  if (!pageContainer) return null;
  const canvas = pageContainer.querySelector('canvas');
  if (!canvas) return null;
  
  const canvasRect = canvas.getBoundingClientRect();
  const selectionRect = selectionRange.getBoundingClientRect();
  
  // Convert selection rect to scale 1.0 page coordinates
  const selLeft = (selectionRect.left - canvasRect.left) / pdfScale;
  const selTop = (selectionRect.top - canvasRect.top) / pdfScale;
  const selRight = selLeft + (selectionRect.width / pdfScale);
  const selBottom = selTop + (selectionRect.height / pdfScale);
  
  const pageImgs = pdfPageImages[pageNum] || [];
  for (const img of pageImgs) {
    const imgLeft = img.left;
    const imgTop = img.top;
    const imgRight = img.left + img.width;
    const imgBottom = img.top + img.height;
    
    // Check overlap
    const intersects = !(selLeft > imgRight || 
                         selRight < imgLeft || 
                         selTop > imgBottom || 
                         selBottom < imgTop);
    
    if (intersects) {
      return img;
    }
  }
  return null;
}

async function copyImageFromCanvas(pageNum, imgBounds) {
  try {
    const pageContainer = document.getElementById(`page-container-${pageNum}`);
    if (!pageContainer) throw new Error("Page container not found");
    const canvas = pageContainer.querySelector('canvas');
    if (!canvas) throw new Error("Canvas not found");
    
    const outputScale = window.devicePixelRatio || 1;
    
    const x = imgBounds.left * pdfScale * outputScale;
    const y = imgBounds.top * pdfScale * outputScale;
    const width = imgBounds.width * pdfScale * outputScale;
    const height = imgBounds.height * pdfScale * outputScale;
    
    if (width <= 0 || height <= 0) throw new Error("Invalid image dimensions");
    
    const cropCanvas = document.createElement('canvas');
    cropCanvas.width = width;
    cropCanvas.height = height;
    const cropCtx = cropCanvas.getContext('2d');
    
    cropCtx.drawImage(canvas, x, y, width, height, 0, 0, width, height);
    
    cropCanvas.toBlob(async (blob) => {
      try {
        await navigator.clipboard.write([
          new ClipboardItem({ 'image/png': blob })
        ]);
        addSystemChatMessage("📸 Image detected in selection and automatically copied to clipboard!", "success");
      } catch (err) {
        console.error("Clipboard copy failure", err);
        addSystemChatMessage(`Failed to copy image: ${err.message}`, "error");
      }
    }, 'image/png');
  } catch (e) {
    console.warn("Failed to copy image", e);
  }
}

function initImageSelectionTracker() {
  const scrollContainer = document.getElementById('pdf-scroll-container');
  if (!scrollContainer) return;
  
  const handleSelectionEnd = () => {
    setTimeout(() => {
      const selection = window.getSelection();
      if (!selection || selection.rangeCount === 0) return;
      const selectionStr = selection.toString().trim();
      if (!selectionStr) return;
      
      const range = selection.getRangeAt(0);
      const img = checkSelectionContainsImage(range, selectedTextPageNum);
      if (img) {
        copyImageFromCanvas(selectedTextPageNum, img);
      }
    }, 120);
  };
  
  scrollContainer.addEventListener('mouseup', handleSelectionEnd);
  scrollContainer.addEventListener('keyup', handleSelectionEnd);
}

function initSidebarToggle() {
  const toggleBtn = document.getElementById('btn-toggle-sidebar');
  const workspace = document.getElementById('workspace-panel');
  const divider = document.getElementById('split-divider');
  
  if (toggleBtn && workspace && divider) {
    const setSidebarState = (collapsed) => {
      workspace.classList.toggle('collapsed', collapsed);
      divider.classList.toggle('collapsed', collapsed);
      toggleBtn.classList.toggle('active', !collapsed);
      toggleBtn.setAttribute('aria-expanded', String(!collapsed));
    };

    // On compact browser windows, start with the reader unobstructed.
    setSidebarState(window.matchMedia('(max-width: 920px)').matches);

    toggleBtn.addEventListener('click', () => {
      const isCollapsed = !workspace.classList.contains('collapsed');
      setSidebarState(isCollapsed);
      
      // Trigger PDF rerender/resize when width changes
      setTimeout(() => {
        triggerPDFResize();
      }, 100);
    });

    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && window.matchMedia('(max-width: 920px)').matches) {
        setSidebarState(true);
      }
    });
  }
}

// ==========================================================================
// Cloud Synchronization Helpers (Firebase Auth & Cloud Firestore)
// ==========================================================================

// Standard Debounce Helper
function debounce(func, delay) {
  let timeoutId;
  return function(...args) {
    clearTimeout(timeoutId);
    timeoutId = setTimeout(() => {
      func.apply(this, args);
    }, delay);
  };
}

// Debounced Cloud Session Save
const saveSessionToCloud = debounce(async () => {
  // Always save locally first as a fallback/guest persistence
  localStorage.setItem('study_page_num', currentPageNum);
  localStorage.setItem('study_pdf_scale', pdfScale);
  saveActiveDocumentSession();

  if (!cloudSyncEnabled || !currentUser) {
    showSaveStatus("Saved locally");
    return;
  }
  
  try {
    const sessionDocRef = doc(db, 'users', currentUser.uid, 'data', 'session');
    const notesTextarea = document.getElementById('notes-textarea');
    const notesContent = notesTextarea ? notesTextarea.value : '';
    
    await setDoc(sessionDocRef, {
      currentPageNum: currentPageNum,
      pdfScale: pdfScale,
      activeDocumentId,
      updatedAt: new Date().toISOString()
    }, { merge: true });

    if (activeDocumentId) {
      const documentDocRef = doc(db, 'users', currentUser.uid, 'documents', activeDocumentId);
      await setDoc(documentDocRef, {
        documentId: activeDocumentId,
        fileName: activeDocumentName,
        notes: notesContent,
        chat: document.getElementById('chat-messages')?.innerHTML || initialAssistantMarkup,
        highlights,
        currentPageNum,
        pdfScale,
        outline: currentDocumentOutline,
        documentKind: currentDocumentKind,
        documentContent: activeDocumentType !== 'pdf' && activeDocumentText.length <= 700000 ? activeDocumentText : null,
        updatedAt: new Date().toISOString()
      }, { merge: true });
    }
    
    showSaveStatus("Saved & Synced to Cloud");
  } catch (err) {
    console.error("Cloud sync failed", err);
    showSaveStatus("Saved locally (cloud sync offline)");
  }
}, 1000);

async function loadActiveDocumentCloudSession() {
  if (!cloudSyncEnabled || !currentUser || !activeDocumentId) return;
  try {
    const documentDocRef = doc(db, 'users', currentUser.uid, 'documents', activeDocumentId);
    const snapshot = await getDoc(documentDocRef);
    if (!snapshot.exists()) return;
    const data = snapshot.data();
    let localSession = {};
    try { localSession = JSON.parse(localStorage.getItem(documentSessionKey(activeDocumentId)) || '{}'); } catch (_) {}
    const cloudUpdatedAt = Date.parse(data.updatedAt) || 0;
    if (Number(localSession.updatedAt || 0) >= cloudUpdatedAt) return;
    const notes = document.getElementById('notes-textarea');
    const chat = document.getElementById('chat-messages');
    if (notes) notes.value = data.notes || '';
    if (chat && data.chat) chat.innerHTML = normalizeBuddyMarkup(data.chat);
    highlights = data.highlights || {};
    currentPageNum = data.currentPageNum || currentPageNum;
    pdfScale = data.pdfScale || pdfScale;
    currentDocumentOutline = data.outline || currentDocumentOutline;
    currentDocumentKind = data.documentKind || currentDocumentKind;
    if (activeDocumentType !== 'pdf' && typeof data.documentContent === 'string') {
      activeDocumentText = data.documentContent;
      const editor = document.getElementById('text-document-editor');
      if (editor) editor.value = activeDocumentText;
      currentDocumentOutline = buildTextDocumentOutline(activeDocumentText);
      renderTextDocumentOutline(currentDocumentOutline);
      currentRagIndex = null;
      ragBuildPromise = initializeTextRag(activeDocumentText);
    } else if (currentDocumentOutline.length) {
      renderDocumentOutline(currentDocumentOutline, currentDocumentKind);
    }
    saveActiveDocumentSession();
    if (currentPageNum > 1) jumpToPage(currentPageNum);
  } catch (error) {
    console.warn('Could not restore this document workspace from cloud', error);
  }
}

// Load Cloud Session
async function loadSessionFromCloud() {
  if (!cloudSyncEnabled || !currentUser) return;
  
  try {
    const sessionDocRef = doc(db, 'users', currentUser.uid, 'data', 'session');
    const docSnap = await getDoc(sessionDocRef);
    
    if (docSnap.exists()) {
      const data = docSnap.data();
      
      // Update highlights
      if (!activeDocumentId && data.highlights) {
        highlights = data.highlights;
        localStorage.setItem('study_highlights', JSON.stringify(highlights));
        
        // Redraw highlights on active pages
        const visiblePages = getVisiblePageNumbers();
        visiblePages.forEach(num => {
          const pageContainer = document.getElementById(`page-container-${num}`);
          if (pageContainer) {
            const layer = pageContainer.querySelector('.highlight-overlay-layer');
            if (layer) {
              renderHighlightsOnPage(num, layer);
            }
          }
        });
      }
      
      // Update notes
      if (!activeDocumentId && data.notes !== undefined) {
        const notesTextarea = document.getElementById('notes-textarea');
        if (notesTextarea) {
          notesTextarea.value = data.notes;
          saveActiveDocumentSession();
        }
      }
      
      // Update flashcards
      if (data.flashcards) {
        flashcards = data.flashcards;
        localStorage.setItem('study_flashcards', JSON.stringify(flashcards));
        updateFlashcardsUI();
      }
      
      // Update zoom level
      if (data.pdfScale && data.pdfScale !== pdfScale) {
        pdfScale = data.pdfScale;
        const zoomText = document.getElementById('zoom-text');
        if (zoomText) zoomText.textContent = `${Math.round(pdfScale * 100)}%`;
        triggerPDFResize();
      }
      
      // Update reading position
      if (data.currentPageNum && data.currentPageNum !== currentPageNum) {
        if (pdfDoc) {
          setTimeout(() => {
            jumpToPage(data.currentPageNum);
          }, 500);
        } else {
          currentPageNum = data.currentPageNum;
        }
      }
      
      addSystemChatMessage("Study session successfully restored from cloud sync.", "success");
    }
  } catch (err) {
    console.error("Failed to load session from cloud", err);
    addSystemChatMessage("Could not restore session from cloud. Using local storage backup.", "warning");
  }
}

// Initialize Auth listeners and handlers
function initFirebaseAuth() {
  if (firebaseAuthInitialized) return;
  firebaseAuthInitialized = true;
  const profileBtn = document.getElementById('btn-auth-profile');
  const authDialog = document.getElementById('auth-dialog');
  const closeAuthBtn = document.getElementById('btn-close-auth');
  const googleSigninBtn = document.getElementById('btn-google-signin');
  const appleSigninBtn = document.getElementById('btn-apple-signin');
  const signoutBtn = document.getElementById('btn-auth-signout');

  const statusIcon = document.getElementById('auth-status-icon');
  const statusText = document.getElementById('auth-status-text-display');
  const avatarLarge = document.getElementById('auth-avatar-large');
  const userName = document.getElementById('auth-user-name');
  const userEmail = document.getElementById('auth-user-email');
  const cloudBadge = document.getElementById('auth-cloud-badge');

  if (profileBtn) {
    profileBtn.addEventListener('click', () => {
      authDialog.showModal();
    });
  }

  if (closeAuthBtn) {
    closeAuthBtn.addEventListener('click', () => {
      authDialog.close();
    });
  }

  // Handle outside click close fallback as per modern guidance
  if (authDialog && !('closedBy' in HTMLDialogElement.prototype)) {
    authDialog.addEventListener('click', (event) => {
      if (event.target !== authDialog) return;
      const rect = authDialog.getBoundingClientRect();
      const isDialogContent = (
        rect.top <= event.clientY &&
        event.clientY <= rect.top + rect.height &&
        rect.left <= event.clientX &&
        event.clientX <= rect.left + rect.width
      );
      if (!isDialogContent) {
        authDialog.close();
      }
    });
  }

  const signInForLocalProfile = async (provider, providerName) => {
    try {
      addSystemChatMessage(`Connecting your ${providerName} profile…`, 'primary');
      await signInWithPopup(auth, provider);
      authDialog.close();
      addSystemChatMessage(`${providerName} profile connected. Your study data remains only on this device.`, 'success');
    } catch (err) {
      console.error(`${providerName} sign in failed`, err);
      const setupHint = providerName === 'Apple' && err.code === 'auth/operation-not-allowed'
        ? ' Enable Apple as a sign-in provider in Firebase Authentication first.'
        : '';
      addSystemChatMessage(`${providerName} sign-in failed: ${err.message}.${setupHint}`, 'error');
    }
  };

  googleSigninBtn?.addEventListener('click', () => {
    const provider = new GoogleAuthProvider();
    provider.setCustomParameters({ prompt: 'select_account' });
    signInForLocalProfile(provider, 'Google');
  });

  appleSigninBtn?.addEventListener('click', () => {
    const provider = new OAuthProvider('apple.com');
    provider.addScope('email');
    provider.addScope('name');
    signInForLocalProfile(provider, 'Apple');
  });

  // Sign Out
  if (signoutBtn) {
    signoutBtn.addEventListener('click', async () => {
      try {
        addSystemChatMessage("Signing out...", "primary");
        await signOut(auth);
        authDialog.close();
      } catch (err) {
        console.error("Sign out failed", err);
        addSystemChatMessage(`Sign out failed: ${err.message}`, "error");
      }
    });
  }

  // Listen to Auth State Changes
  onAuthStateChanged(auth, async (user) => {
    if (user) {
      sessionAuthInitialized = true;
      lastKnownUid = user.uid;
      currentUser = user;

      const isAnonymous = user.isAnonymous;
      if (isAnonymous) {
        if (statusIcon) statusIcon.textContent = '⌂';
        if (statusText) statusText.textContent = 'Local';
        if (avatarLarge) avatarLarge.textContent = '⌂';
        if (userName) userName.textContent = 'Local Student';
        if (userEmail) userEmail.textContent = 'No account connected';
        if (cloudBadge) {
          cloudBadge.className = 'badge badge-active';
          cloudBadge.textContent = 'LOCAL DATA ONLY';
        }

        if (googleSigninBtn) googleSigninBtn.style.display = 'flex';
        if (appleSigninBtn) appleSigninBtn.style.display = 'flex';
        if (signoutBtn) signoutBtn.style.display = 'none';
      } else {
        const photoURL = user.photoURL;
        if (photoURL) {
          if (statusIcon) statusIcon.innerHTML = `<img src="${photoURL}" alt="avatar" style="width:18px; height:18px; border-radius:50%; vertical-align:middle; object-fit:cover;" />`;
          if (avatarLarge) avatarLarge.innerHTML = `<img src="${photoURL}" alt="avatar" style="width:64px; height:64px; border-radius:50%; object-fit:cover;" />`;
        } else {
          if (statusIcon) statusIcon.textContent = '●';
          if (avatarLarge) avatarLarge.textContent = '●';
        }

        const providerId = user.providerData?.[0]?.providerId || '';
        const providerLabel = providerId === 'apple.com' ? 'Apple' : 'Google';
        if (statusText) statusText.textContent = user.displayName || user.email || 'Student';
        if (userName) userName.textContent = user.displayName || `${providerLabel} Student`;
        if (userEmail) userEmail.textContent = user.email || `${providerLabel} profile connected`;
        if (cloudBadge) {
          cloudBadge.className = 'badge badge-active';
          cloudBadge.textContent = 'SIGNED IN · DATA LOCAL';
        }

        if (googleSigninBtn) googleSigninBtn.style.display = 'none';
        if (appleSigninBtn) appleSigninBtn.style.display = 'none';
        if (signoutBtn) signoutBtn.style.display = 'flex';
      }
    } else {
      lastKnownUid = null;
      currentUser = null;
      try {
        await signInAnonymously(auth);
      } catch (err) {
        console.error("Anonymous auth failed", err);
        if (statusText) statusText.textContent = 'Local';
        if (cloudBadge) cloudBadge.textContent = 'LOCAL DATA ONLY';
      }
    }
  });
}

// Wipes local/in-memory study state when switching to a different account
// within the same browser tab, so the new account starts from a clean
// slate instead of inheriting the previous account's data.
function resetSessionState() {
  highlights = {};
  flashcards = [];
  currentPageNum = 1;
  pdfScale = 1.2;

  localStorage.removeItem('study_highlights');
  localStorage.removeItem('study_flashcards');
  localStorage.removeItem('study_page_num');
  localStorage.removeItem('study_pdf_scale');

  const notesTextarea = document.getElementById('notes-textarea');
  if (notesTextarea) notesTextarea.value = '';
  updateFlashcardsUI();

  // Unload the current PDF and return to the welcome screen.
  if (pageObserver) {
    pageObserver.disconnect();
  }
  pdfDoc = null;
  pdfPagesCount = 0;
  isRenderingPage = {};
  pageRenderTasks = {};
  pdfPageImages = {};

  const viewerContent = document.getElementById('pdf-viewer-content');
  if (viewerContent) viewerContent.innerHTML = '';

  const scrollContainer = document.getElementById('pdf-scroll-container');
  if (scrollContainer) scrollContainer.style.display = 'none';

  const welcomeScreen = document.getElementById('welcome-screen');
  if (welcomeScreen) welcomeScreen.style.display = 'flex';
}
