import './style.css';
import { 
  auth, 
  db, 
  signInAnonymously, 
  GoogleAuthProvider, 
  signInWithPopup, 
  signOut, 
  onAuthStateChanged,
  doc,
  setDoc,
  getDoc
} from './firebase.js';

// PDF.js global setup
const pdfjsLib = window.pdfjsLib;

// Application State
let pdfDoc = null;
let pdfScale = parseFloat(localStorage.getItem('study_pdf_scale') || '1.2');
let currentPageNum = parseInt(localStorage.getItem('study_page_num') || '1');
let pdfPagesCount = 0;
let isRenderingPage = {};
let pageRenderTasks = {};
let notesFileHandle = null;
let geminiApiKey = localStorage.getItem('study_gemini_api_key') || '';
let aiProvider = localStorage.getItem('study_ai_provider') || 'demo';
let ollamaUrl = localStorage.getItem('study_ollama_url') || 'http://localhost:11434';
let ollamaModel = localStorage.getItem('study_ollama_model') || 'gemma';
let flashcards = JSON.parse(localStorage.getItem('study_flashcards') || '[]');
let currentCardIndex = 0;
let selectedText = '';
let selectedTextPageNum = 1;
let selectionHighlightsMap = {};
let selectedPagesList = [];
let highlights = JSON.parse(localStorage.getItem('study_highlights') || '{}');
let temporaryHighlight = null;
let pdfPageImages = {};
let currentUser = null;
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
const DB_VERSION = 1;
const STORE_NAME = 'pdf_store';

function openDB() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME);
      }
    };
    request.onsuccess = (e) => resolve(e.target.result);
    request.onerror = (e) => reject(e.target.error);
  });
}

async function savePdfToIndexedDB(arrayBuffer, fileName) {
  try {
    const db = await openDB();
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    store.put({ arrayBuffer, fileName }, 'active_pdf');
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
    const request = store.get('active_pdf');
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
    }
  } catch (err) {
    console.error("Failed to restore PDF from IndexedDB", err);
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
          
          // Trigger autosave/sync
          localStorage.setItem('study_notes', notesTextarea.value);
          saveSessionToCloud();
          
          // Switch to Notes tab
          const notesTabBtn = document.getElementById('tab-btn-notes');
          if (notesTabBtn) {
            notesTabBtn.click();
          }
          addSystemChatMessage("Appended captured image directly to your study notes workspace.", "success");
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
  initResizer();
  initTabs();
  initSettings();
  initUploads();
  initPdfControls();
  initFloatingToolbar();
  initNotesEditor();
  initFlashcards();
  initImageSelectionTracker();
  initSidebarToggle();
  initCaptureMode();
  
  // Try loading API status
  updateApiStatusDisplay();
  
  // Restore PDF from IndexedDB if it exists
  restorePersistedPdf();
  
  // Initialize Firebase Auth
  initFirebaseAuth();
});

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
      
      tabButtons.forEach(b => b.classList.remove('active'));
      tabPanes.forEach(p => p.classList.remove('active'));
      
      btn.classList.add('active');
      document.getElementById(targetTab).classList.add('active');
    });
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
  const groupOllama = document.getElementById('settings-group-ollama');
  
  const inputKey = document.getElementById('gemini-api-key');
  const inputOllamaUrl = document.getElementById('ollama-url');
  const selectOllamaModel = document.getElementById('ollama-model-select');
  const btnScan = document.getElementById('btn-refresh-models');
  const statusOllama = document.getElementById('ollama-status-text');
  
  function toggleSettingsGroups() {
    const val = providerSelect.value;
    groupGemini.style.display = val === 'gemini' ? 'flex' : 'none';
    groupOllama.style.display = val === 'ollama' ? 'flex' : 'none';
  }
  
  providerSelect.addEventListener('change', toggleSettingsGroups);
  
  btnOpen.addEventListener('click', () => {
    providerSelect.value = aiProvider;
    inputKey.value = geminiApiKey;
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
    
    toggleSettingsGroups();
    updateApiStatusDisplay();
    dialog.showModal();
  });
  
  btnClose.addEventListener('click', () => {
    dialog.close();
  });
  
  btnScan.addEventListener('click', async () => {
    statusOllama.textContent = "Scanning local models...";
    statusOllama.style.color = "var(--text-secondary)";
    
    try {
      const response = await fetch('/api/ollama/api/tags');
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
        statusOllama.textContent = `Successfully detected ${models.length} model(s).`;
        statusOllama.style.color = "var(--accent-emerald)";
      }
    } catch (err) {
      console.warn("Ollama scan failed", err);
      statusOllama.textContent = "Server offline. Ensure Ollama is running locally.";
      statusOllama.style.color = "var(--accent-rose)";
    }
  });
  
  btnSave.addEventListener('click', () => {
    aiProvider = providerSelect.value;
    geminiApiKey = inputKey.value.trim();
    ollamaUrl = inputOllamaUrl.value.trim();
    ollamaModel = selectOllamaModel.value;
    
    localStorage.setItem('study_ai_provider', aiProvider);
    localStorage.setItem('study_gemini_api_key', geminiApiKey);
    localStorage.setItem('study_ollama_url', ollamaUrl);
    localStorage.setItem('study_ollama_model', ollamaModel);
    
    updateApiStatusDisplay();
    dialog.close();
    
    let msg = "AI settings saved. ";
    if (aiProvider === 'demo') msg += "Using simulated Demo Mode.";
    else if (aiProvider === 'gemini') msg += "Using Gemini Cloud API.";
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
function initUploads() {
  const headerUpload = document.getElementById('pdf-upload');
  const welcomeUpload = document.getElementById('pdf-upload-welcome');
  const sampleBtn = document.getElementById('btn-load-sample');
  
  const handleFile = (e) => {
    const file = e.target.files[0];
    if (file && file.type === 'application/pdf') {
      loadLocalPdfFile(file);
    }
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
        const typedarray = new Uint8Array(arrayBuffer);
        loadPdfDoc(typedarray);
        await savePdfToIndexedDB(arrayBuffer, 'sample.pdf');
      })
      .catch(err => {
        console.error("Failed to load sample", err);
        addSystemChatMessage("Failed to fetch sample PDF from server. Attempting standard load...", "warning");
        loadPdfDoc(sampleUrl);
      });
  });
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
    
    addSystemChatMessage(`Successfully loaded <strong>${pdfPagesCount}</strong> pages. Rendering workspace...`, "success");
    
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
    
  } catch (err) {
    console.error("PDF load failure", err);
    addSystemChatMessage(`Error loading PDF document: ${err.message}`, "error");
    // Show welcome screen again
    document.getElementById('welcome-screen').style.display = 'flex';
    document.getElementById('pdf-scroll-container').style.display = 'none';
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
      
      // Position and show toolbar
      const resultSec = document.getElementById('toolbar-result-section');
      if (resultSec && resultSec.style.display === 'none') {
        try {
          const rect = getRangeBoundingClientRect(cachedSelectionRange);
          positionToolbar(rect);
        } catch (err) {
          console.warn("[StudyBuddy] Error positioning toolbar:", err);
        }
      }
    }, 150);
  };
  
  document.addEventListener('mouseup', handleSelectionEnd);
  document.addEventListener('keyup', handleSelectionEnd);
  
  function positionToolbar(selectionRect) {
    const toolbarWidth = 390; // Expanded width for highlights & format actions
    const toolbarHeight = 110;
    
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
  const connectBtn = document.getElementById('btn-connect-file');
  const disconnectBtn = document.getElementById('btn-disconnect-file');
  const notesTextarea = document.getElementById('notes-textarea');
  const exportBtn = document.getElementById('btn-export-txt');
  const clearBtn = document.getElementById('editor-btn-clear');
  
  const writeBtn = document.getElementById('editor-btn-write');
  const previewBtn = document.getElementById('editor-btn-preview');
  const previewDiv = document.getElementById('notes-preview');
  
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
      
      const text = notesTextarea.value;
      previewDiv.innerHTML = convertMarkdownToHtml(text) || '<p style="color:var(--text-muted); font-style:italic;">No notes written yet...</p>';
    });
  }
  
  // Load saved notes backup on load
  const backup = localStorage.getItem('study_notes');
  if (backup) {
    notesTextarea.value = backup;
  }
  
  connectBtn.addEventListener('click', connectNotesFile);
  disconnectBtn.addEventListener('click', disconnectNotesFile);
  
  // Note Text Change Autosave
  notesTextarea.addEventListener('input', () => {
    localStorage.setItem('study_notes', notesTextarea.value);
    showSaveStatus("Saved locally");
    saveSessionToCloud();
  });
  
  // Formatting helper buttons
  document.getElementById('editor-btn-bold').addEventListener('click', () => insertFormat('**'));
  document.getElementById('editor-btn-italic').addEventListener('click', () => insertFormat('*'));
  document.getElementById('editor-btn-header').addEventListener('click', () => insertFormat('\n# '));
  
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
    localStorage.setItem('study_notes', notesTextarea.value);
  }
  
  clearBtn.addEventListener('click', () => {
    if (confirm("Are you sure you want to clear your study workspace notes? This will clear local memory, though connected file content on disk remains unchanged.")) {
      notesTextarea.value = '';
      localStorage.removeItem('study_notes');
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
      const blob = new Blob(['\ufeff' + htmlContent], { type: 'application/msword' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'study_notes.doc';
      a.click();
    });
  }
  
  const exportPdfBtn = document.getElementById('btn-export-pdf');
  if (exportPdfBtn) {
    exportPdfBtn.addEventListener('click', () => {
      const text = notesTextarea.value;
      const htmlContent = convertMarkdownToHtml(text);
      const printWindow = window.open('', '_blank', 'width=800,height=600');
      if (printWindow) {
        printWindow.document.write(`
          <html>
            <head>
              <title>Study Notes - Export</title>
              <style>
                body {
                  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
                  line-height: 1.6;
                  color: #333;
                  padding: 40px;
                  max-width: 800px;
                  margin: 0 auto;
                }
                h1 {
                  color: #111;
                  border-bottom: 2px solid #eee;
                  padding-bottom: 10px;
                  font-size: 28px;
                  margin-bottom: 20px;
                }
                h2 {
                  color: #222;
                  margin-top: 30px;
                  font-size: 22px;
                  margin-bottom: 15px;
                }
                h3 {
                  color: #444;
                  margin-top: 20px;
                  font-size: 18px;
                  margin-bottom: 10px;
                }
                p {
                  margin: 0 0 1.2em;
                }
                code {
                  background-color: #f4f4f4;
                  padding: 2px 6px;
                  border-radius: 4px;
                  font-family: Menlo, Monaco, Consolas, monospace;
                  font-size: 0.9em;
                }
                pre {
                  background-color: #f4f4f4;
                  padding: 15px;
                  border-radius: 6px;
                  overflow-x: auto;
                  margin: 0 0 1.5em;
                }
                pre code {
                  padding: 0;
                  background-color: transparent;
                }
                ul, ol {
                  margin: 0 0 1.5em;
                  padding-left: 20px;
                }
                li {
                  margin-bottom: 5px;
                }
                strong {
                  font-weight: 600;
                }
                @media print {
                  body {
                    padding: 20px;
                  }
                  @page {
                    margin: 2cm;
                  }
                }
              </style>
            </head>
            <body>
              ${htmlContent}
              <script>
                window.onload = function() {
                  window.print();
                  setTimeout(function() {
                    window.close();
                  }, 500);
                };
              </script>
            </body>
          </html>
        `);
        printWindow.document.close();
      }
    });
  }
  
  // File system API check
  if (typeof window.showOpenFilePicker !== 'function') {
    connectBtn.style.display = 'none';
    document.getElementById('file-status-text').textContent = "Real Sync Unsupported";
    document.getElementById('file-path-text').textContent = "Use standard export button below.";
  }
}

async function connectNotesFile() {
  try {
    const [handle] = await window.showOpenFilePicker({
      types: [{
        description: 'Text Files',
        accept: { 'text/plain': ['.txt', '.md'] }
      }],
      multiple: false
    });
    notesFileHandle = handle;
    
    const file = await notesFileHandle.getFile();
    updateFileConnectionStatus(true, file.name);
    addSystemChatMessage(`Connected successfully. Notes will write directly to: <strong>${file.name}</strong>`, "success");
    
    // Populate notes from disk if editor is empty
    const fileText = await file.text();
    const editor = document.getElementById('notes-textarea');
    if (!editor.value.trim() && fileText.trim()) {
      editor.value = fileText;
      localStorage.setItem('study_notes', fileText);
    }
  } catch (err) {
    if (err.name !== 'AbortError') {
      console.error(err);
      addSystemChatMessage(`Local note file connection failed: ${err.message}`, "error");
    }
  }
}

function disconnectNotesFile() {
  notesFileHandle = null;
  updateFileConnectionStatus(false);
  addSystemChatMessage("Disconnected note file sync.", "primary");
}

function updateFileConnectionStatus(isConnected, name = '') {
  const dot = document.getElementById('file-status-dot');
  const label = document.getElementById('file-status-text');
  const pathText = document.getElementById('file-path-text');
  const connectBtn = document.getElementById('btn-connect-file');
  const disconnectBtn = document.getElementById('btn-disconnect-file');
  
  if (isConnected) {
    dot.className = "status-dot connected";
    label.textContent = "SYNC ACTIVE";
    pathText.textContent = name;
    connectBtn.style.display = 'none';
    disconnectBtn.style.display = 'block';
  } else {
    dot.className = "status-dot disconnected";
    label.textContent = "DISCONNECTED";
    pathText.textContent = "No local file selected";
    connectBtn.style.display = 'block';
    disconnectBtn.style.display = 'none';
  }
}

async function appendToLocalFile(text, pageNum = '') {
  const editor = document.getElementById('notes-textarea');
  
  // Clean append: double newline if editor contains notes, otherwise empty prefix
  const prefix = editor.value ? "\n\n" : "";
  const fullNote = prefix + text;
  
  // 1. Update text area locally
  editor.value += fullNote;
  editor.scrollTop = editor.scrollHeight;
  localStorage.setItem('study_notes', editor.value);
  saveSessionToCloud();
  
  // 2. Try writing to connected file
  if (notesFileHandle) {
    try {
      // Request write handle
      const options = { mode: 'readwrite' };
      if (await notesFileHandle.queryPermission(options) !== 'granted') {
        if (await notesFileHandle.requestPermission(options) !== 'granted') {
          throw new Error('Write permissions denied');
        }
      }
      
      const file = await notesFileHandle.getFile();
      const existingText = await file.text();
      
      const writable = await notesFileHandle.createWritable({ keepExistingData: true });
      await writable.write(existingText + fullNote);
      await writable.close();
      
      showSaveStatus("Saved & Synced to File");
    } catch (err) {
      console.error(err);
      addSystemChatMessage(`Error writing notes to disk: ${err.message}. Saving locally in browser context.`, "error");
      showSaveStatus("Saved browser only");
    }
  } else {
    showSaveStatus("Saved locally");
    
    // Alert user that file is not connected
    if (typeof window.showOpenFilePicker === 'function') {
      addSystemChatMessage("Note appended to workspace, but no local file is connected. Click 'Connect File' in the Notes tab to sync.", "warning");
    }
  }
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
}

function addSystemChatMessage(text, type = 'system') {
  const container = document.getElementById('chat-messages');
  const bubble = document.createElement('div');
  bubble.className = `message system-message alert-${type}`;
  bubble.innerHTML = text;
  
  container.appendChild(bubble);
  container.scrollTop = container.scrollHeight;
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
    const context = selectedText || await extractPageText(currentPageNum);
    const enrichedPrompt = context 
      ? `You are a helpful study assistant. Answer the user's question. Context from page ${currentPageNum} of the PDF:\n"${context}"\n\nUser Question:\n${prompt}`
      : prompt;
      
    if (aiProvider === 'gemini') {
      if (!geminiApiKey) throw new Error("Gemini API Key is missing. Go to settings (top-right) to add it.");
      resultText = await fetchGeminiAPI(enrichedPrompt);
    } else if (aiProvider === 'ollama') {
      resultText = await fetchOllamaAPI(enrichedPrompt);
    } else {
      await new Promise(r => setTimeout(r, 1000));
      resultText = `Simulated Assistant Answer:\n\nTo answer this question, you need to connect your real Google Gemini API Key or set up a local Ollama model in the Settings modal (top-right). Since you are in Demo Mode, here's a study tip: Highlight relevant definitions in the text first, then ask questions about them!`;
    }
    
    removeChatLoadingBubble();
    addChatMessage('assistant', resultText);
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

async function fetchOllamaAPI(prompt) {
  const url = '/api/ollama/api/chat';
  
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: ollamaModel,
      messages: [
        { role: 'user', content: prompt }
      ],
      stream: false
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

function convertMarkdownToHtml(markdown) {
  let html = markdown
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '<img src="$2" alt="$1" style="max-width:100%; border-radius:8px; margin:10px 0; box-shadow:0 4px 12px rgba(0,0,0,0.15); display:block;" />')
    .replace(/^# (.*$)/gim, '<h1>$1</h1>')
    .replace(/^## (.*$)/gim, '<h2>$1</h2>')
    .replace(/^### (.*$)/gim, '<h3>$1</h3>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*]+)\*/g, '<em>$1</em>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/^\* (.*$)/gim, '<li>$1</li>')
    .replace(/^\- (.*$)/gim, '<li>$1</li>');
    
  return html.split('\n').map(line => {
    if (line.trim().startsWith('<h') || line.trim().startsWith('<li') || line.trim().startsWith('<ul') || line.trim().startsWith('<ol')) {
      return line;
    }
    return line.trim() ? `<p>${line}</p>` : '';
  }).join('\n');
}

function initSidebarToggle() {
  const toggleBtn = document.getElementById('btn-toggle-sidebar');
  const workspace = document.getElementById('workspace-panel');
  const divider = document.getElementById('split-divider');
  
  if (toggleBtn && workspace && divider) {
    toggleBtn.addEventListener('click', () => {
      const isCollapsed = workspace.classList.toggle('collapsed');
      divider.classList.toggle('collapsed');
      toggleBtn.classList.toggle('active');
      
      // Trigger PDF rerender/resize when width changes
      setTimeout(() => {
        triggerPDFResize();
      }, 100);
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

  if (!currentUser) {
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
      notes: notesContent,
      highlights: highlights,
      flashcards: flashcards,
      updatedAt: new Date().toISOString()
    }, { merge: true });
    
    showSaveStatus("Saved & Synced to Cloud");
  } catch (err) {
    console.error("Cloud sync failed", err);
    showSaveStatus("Saved locally (cloud sync offline)");
  }
}, 1000);

// Load Cloud Session
async function loadSessionFromCloud() {
  if (!currentUser) return;
  
  try {
    const sessionDocRef = doc(db, 'users', currentUser.uid, 'data', 'session');
    const docSnap = await getDoc(sessionDocRef);
    
    if (docSnap.exists()) {
      const data = docSnap.data();
      
      // Update highlights
      if (data.highlights) {
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
      if (data.notes !== undefined) {
        const notesTextarea = document.getElementById('notes-textarea');
        if (notesTextarea) {
          notesTextarea.value = data.notes;
          localStorage.setItem('study_notes', data.notes);
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
  const profileBtn = document.getElementById('btn-auth-profile');
  const authDialog = document.getElementById('auth-dialog');
  const closeAuthBtn = document.getElementById('btn-close-auth');
  const googleSigninBtn = document.getElementById('btn-google-signin');
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

  // Google Sign-In
  if (googleSigninBtn) {
    googleSigninBtn.addEventListener('click', async () => {
      const provider = new GoogleAuthProvider();
      try {
        addSystemChatMessage("Signing in with Google...", "primary");
        await signInWithPopup(auth, provider);
        authDialog.close();
      } catch (err) {
        console.error("Google sign in failed", err);
        addSystemChatMessage(`Google Sign-In failed: ${err.message}`, "error");
      }
    });
  }

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
      currentUser = user;
      
      const isAnonymous = user.isAnonymous;
      if (isAnonymous) {
        if (statusIcon) statusIcon.textContent = "👤";
        if (statusText) statusText.textContent = "Guest Session";
        if (avatarLarge) avatarLarge.textContent = "👤";
        if (userName) userName.textContent = "Guest Student";
        if (userEmail) userEmail.textContent = "Anonymous Guest Session";
        if (cloudBadge) {
          cloudBadge.className = "badge badge-demo";
          cloudBadge.textContent = "Local Temp Storage";
        }
        
        if (googleSigninBtn) googleSigninBtn.style.display = "flex";
        if (signoutBtn) signoutBtn.style.display = "none";
      } else {
        const photoURL = user.photoURL;
        if (photoURL) {
          if (statusIcon) statusIcon.innerHTML = `<img src="${photoURL}" alt="avatar" style="width:18px; height:18px; border-radius:50%; vertical-align:middle; object-fit:cover;" />`;
          if (avatarLarge) avatarLarge.innerHTML = `<img src="${photoURL}" alt="avatar" style="width:64px; height:64px; border-radius:50%; object-fit:cover;" />`;
        } else {
          if (statusIcon) statusIcon.textContent = "🎓";
          if (avatarLarge) avatarLarge.textContent = "🎓";
        }
        
        if (statusText) statusText.textContent = user.displayName || user.email || "Student";
        if (userName) userName.textContent = user.displayName || "Google Student";
        if (userEmail) userEmail.textContent = user.email || "Google Account Connected";
        if (cloudBadge) {
          cloudBadge.className = "badge badge-active";
          cloudBadge.textContent = "Cloud Sync Active";
        }
        
        if (googleSigninBtn) googleSigninBtn.style.display = "none";
        if (signoutBtn) signoutBtn.style.display = "flex";
      }

      await loadSessionFromCloud();
      
    } else {
      currentUser = null;
      try {
        await signInAnonymously(auth);
      } catch (err) {
        console.error("Anonymous auth failed", err);
        addSystemChatMessage("Cloud Sync authentication offline. Using local backup storage.", "warning");
      }
    }
  });
}
