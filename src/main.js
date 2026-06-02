import './style.css';

// PDF.js global setup
const pdfjsLib = window.pdfjsLib;

// Application State
let pdfDoc = null;
let pdfScale = 1.2;
let currentPageNum = 1;
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
let highlights = JSON.parse(localStorage.getItem('study_highlights') || '{}');
let temporaryHighlight = null;
let pdfPageImages = {};

// Intersection Observer for PDF lazy rendering and scroll tracking
let pageObserver = null;

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
  
  // Try loading API status
  updateApiStatusDisplay();
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
    
    loadPdfDoc(sampleUrl);
  });
}

function loadLocalPdfFile(file) {
  // Clear and hide welcome
  document.getElementById('welcome-screen').style.display = 'none';
  const scrollContainer = document.getElementById('pdf-scroll-container');
  scrollContainer.style.display = 'flex';
  
  addSystemChatMessage(`Loading PDF: <strong>${file.name}</strong>...`, "primary");
  
  const fileReader = new FileReader();
  fileReader.onload = function() {
    const typedarray = new Uint8Array(this.result);
    loadPdfDoc(typedarray);
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
  if (temporaryHighlight && temporaryHighlight.pageNum === pageNum) {
    temporaryHighlight.rects.forEach(r => {
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
  
  // Selection change monitor
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
    
    // Check if selection is located inside any active textLayer node
    let node = selection.anchorNode;
    let isInsidePdf = false;
    let pageNum = 1;
    
    while (node) {
      if (node.classList && node.classList.contains('pdf-page-container')) {
        isInsidePdf = true;
        pageNum = parseInt(node.getAttribute('data-page'));
        break;
      }
      node = node.parentNode;
    }
    
    if (!isInsidePdf) {
      const resultSec = document.getElementById('toolbar-result-section');
      if (resultSec && resultSec.style.display === 'none') {
        clearTemporaryHighlight();
        toolbar.style.display = 'none';
        collapseToolbarResult();
      }
      return;
    }
    
    cachedSelectionRange = selection.getRangeAt(0).cloneRange();
    selectedText = selectionStr;
    selectedTextPageNum = pageNum;
    
    // Render the temporary visual highlight overlay
    updateTemporaryHighlight(selection, pageNum);
    
    // Position toolbar above bounds (only if not already showing expanded results)
    const resultSec = document.getElementById('toolbar-result-section');
    if (resultSec && resultSec.style.display === 'none') {
      try {
        const rect = cachedSelectionRange.getBoundingClientRect();
        positionToolbar(rect);
      } catch (e) {}
    }
  }, 150));
  
  function positionToolbar(selectionRect) {
    const toolbarWidth = 280; // Compact width for the dropdown toolbar
    const toolbarHeight = 82;
    
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
    // DO NOT prevent default if clicking the input text box, inside the dropdown, or inside the result panel text
    if (e.target.id === 'toolbar-cmd-input' || e.target.tagName === 'INPUT' || e.target.closest('#toolbar-actions-dropdown') || e.target.closest('#toolbar-result-section')) {
      return; 
    }
    e.preventDefault();
  });
  
  // Dropdown open/close toggle
  const dropdownTrigger = document.getElementById('btn-dropdown-trigger');
  const dropdownMenu = document.getElementById('dropdown-menu-list');
  
  dropdownTrigger.addEventListener('click', (e) => {
    e.stopPropagation();
    const isShowing = dropdownMenu.style.display === 'flex';
    dropdownMenu.style.display = isShowing ? 'none' : 'flex';
  });
  
  // Close dropdown on click outside
  document.addEventListener('click', (e) => {
    if (!e.target.closest('#toolbar-actions-dropdown')) {
      dropdownMenu.style.display = 'none';
    }
  });
  
  // Action Handlers: Highlights
  document.querySelectorAll('.btn-highlight').forEach(btn => {
    btn.addEventListener('click', () => {
      const color = btn.getAttribute('data-color');
      applyHighlight(color);
      clearTemporaryHighlight();
      toolbar.style.display = 'none';
      collapseToolbarResult();
      dropdownMenu.style.display = 'none';
    });
  });
  
  // Dropdown Action Handlers: Add to Notes
  document.getElementById('dropdown-action-note').addEventListener('click', () => {
    appendToLocalFile(selectedText, selectedTextPageNum);
    clearTemporaryHighlight();
    window.getSelection().removeAllRanges();
    toolbar.style.display = 'none';
    collapseToolbarResult();
    dropdownMenu.style.display = 'none';
  });
  
  // Dropdown Action Handlers: Copy Selection as Image
  document.getElementById('dropdown-action-image').addEventListener('click', () => {
    copySelectedAreaAsImage();
    dropdownMenu.style.display = 'none';
  });
  
  // Dropdown Action Handlers: AI Quick Summarize
  document.getElementById('dropdown-action-summarize').addEventListener('click', () => {
    runInlineAICommand(`/summarize`, selectedText);
    dropdownMenu.style.display = 'none';
  });
  
  // Dropdown Action Handlers: AI Key Takeaways
  document.getElementById('dropdown-action-keypoints').addEventListener('click', () => {
    runInlineAICommand(`/keypoints`, selectedText);
    dropdownMenu.style.display = 'none';
  });
  
  // Dropdown Action Handlers: AI Explain Concept
  document.getElementById('dropdown-action-explain').addEventListener('click', () => {
    runInlineAICommand(`/explain`, selectedText);
    dropdownMenu.style.display = 'none';
  });
  
  // Dropdown Action Handlers: AI Make Flashcards
  document.getElementById('dropdown-action-flashcard').addEventListener('click', () => {
    runInlineAICommand(`/flashcard`, selectedText);
    dropdownMenu.style.display = 'none';
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
    const content = document.getElementById('toolbar-result-content').innerText;
    if (content) {
      appendToLocalFile(content, selectedTextPageNum);
      addSystemChatMessage("Summary appended directly to notes workspace.", "success");
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
      systemPrompt = `Summarize the following text concisely in a single paragraph. Do not use bullet points or lists:\n\n${targetText}`;
      fallbackMessage = generateMockSummary(targetText);
      break;
    case '/keypoints':
      systemPrompt = `Analyze the following text and extract the key definitions, concepts, and takeaways as a bulleted list:\n\n${targetText}`;
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
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) return;
  
  const range = selection.getRangeAt(0);
  const pageContainer = document.getElementById(`page-container-${selectedTextPageNum}`);
  if (!pageContainer) return;
  
  const textLayer = pageContainer.querySelector('.textLayer');
  if (!textLayer) return;
  
  const spans = textLayer.querySelectorAll('span');
  const pageRect = pageContainer.getBoundingClientRect();
  const scale = pdfScale;
  const relativeRects = [];
  
  spans.forEach(span => {
    if (selection.containsNode(span, true)) {
      // Find the intersection range
      const spanRange = document.createRange();
      spanRange.selectNodeContents(span);
      
      let startNode = range.startContainer;
      let startOffset = range.startOffset;
      let endNode = range.endContainer;
      let endOffset = range.endOffset;
      
      // If the selection starts inside this span, adjust start
      if (span.contains(startNode) || span === startNode) {
        if (startNode.nodeType === Node.TEXT_NODE) {
          spanRange.setStart(startNode, startOffset);
        } else {
          spanRange.setStart(span, 0);
        }
      }
      
      // If the selection ends inside this span, adjust end
      if (span.contains(endNode) || span === endNode) {
        if (endNode.nodeType === Node.TEXT_NODE) {
          spanRange.setEnd(endNode, endOffset);
        } else {
          spanRange.setEnd(span, span.childNodes.length);
        }
      }
      
      const rects = spanRange.getClientRects();
      for (const r of rects) {
        // Collect only valid, non-collapsed rects
        if (r.width > 0 && r.height > 0) {
          relativeRects.push({
            left: (r.left - pageRect.left) / scale,
            top: (r.top - pageRect.top) / scale,
            width: r.width / scale,
            height: r.height / scale
          });
        }
      }
    }
  });
  
  // Fallback in case span intersection didn't find anything
  if (relativeRects.length === 0) {
    const clientRects = range.getClientRects();
    for (const r of clientRects) {
      if (r.width > 0 && r.height > 0 && r.height < 60) { // filter out overly tall container boxes
        relativeRects.push({
          left: (r.left - pageRect.left) / scale,
          top: (r.top - pageRect.top) / scale,
          width: r.width / scale,
          height: r.height / scale
        });
      }
    }
  }
  
  if (relativeRects.length === 0) return;
  
  // Init page structure if empty
  if (!highlights[selectedTextPageNum]) {
    highlights[selectedTextPageNum] = [];
  }
  
  // Save highlight
  highlights[selectedTextPageNum].push({
    text: selectedText,
    color: color,
    rects: relativeRects
  });
  
  // Persist highlights
  localStorage.setItem('study_highlights', JSON.stringify(highlights));
  
  // Force redraw highlight layer
  const layer = pageContainer.querySelector('.highlight-overlay-layer');
  if (layer) {
    renderHighlightsOnPage(selectedTextPageNum, layer);
  }
  
  // Clean window selection visual overlays
  selection.removeAllRanges();
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
      systemPrompt = `Summarize the following text concisely in a single paragraph. Do not use bullet points or lists:\n\n${targetText}`;
      fallbackMessage = generateMockSummary(targetText);
      break;
    case '/keypoints':
      systemPrompt = `Analyze the following text and extract the key definitions, concepts, and takeaways as a bulleted list:\n\n${targetText}`;
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
  const keywords = extractKeywords(text);
  const cleanText = text.substring(0, 120);
  
  return `This selection relates to ${keywords[0] || 'research'} and ${keywords[1] || 'methodology'}. It describes: "${cleanText}...". The main takeaway is that understanding these elements is essential for verifying theoretical frameworks and optimizing system parameters.`;
}

function generateMockKeypoints(text) {
  const keywords = extractKeywords(text);
  const cleanText = text.substring(0, 120);
  
  return `### Key Takeaways
* **Core Context**: Focuses on *${keywords[0] || 'research'}* and *${keywords[1] || 'methodology'}*.
* **Primary Insight**: The excerpt discusses: "${cleanText}..."
* **Key Takeaway**: Understanding these elements is essential for verifying theoretical frameworks and validating systems.`;
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

function clearTemporaryHighlight() {
  if (temporaryHighlight) {
    const prevPageNum = temporaryHighlight.pageNum;
    temporaryHighlight = null;
    const pageContainer = document.getElementById(`page-container-${prevPageNum}`);
    if (pageContainer) {
      const layer = pageContainer.querySelector('.highlight-overlay-layer');
      if (layer) {
        renderHighlightsOnPage(prevPageNum, layer);
      }
    }
  }
}

function updateTemporaryHighlight(selection, pageNum) {
  if (temporaryHighlight && temporaryHighlight.pageNum !== pageNum) {
    clearTemporaryHighlight();
  }
  
  if (selection.rangeCount === 0) return;
  const range = selection.getRangeAt(0);
  const pageContainer = document.getElementById(`page-container-${pageNum}`);
  if (!pageContainer) return;
  
  const textLayer = pageContainer.querySelector('.textLayer');
  if (!textLayer) return;
  
  const spans = textLayer.querySelectorAll('span');
  const pageRect = pageContainer.getBoundingClientRect();
  const scale = pdfScale;
  const relativeRects = [];
  
  spans.forEach(span => {
    if (selection.containsNode(span, true)) {
      const spanRange = document.createRange();
      spanRange.selectNodeContents(span);
      
      let startNode = range.startContainer;
      let startOffset = range.startOffset;
      let endNode = range.endContainer;
      let endOffset = range.endOffset;
      
      if (span.contains(startNode) || span === startNode) {
        if (startNode.nodeType === Node.TEXT_NODE) {
          spanRange.setStart(startNode, startOffset);
        } else {
          spanRange.setStart(span, 0);
        }
      }
      
      if (span.contains(endNode) || span === endNode) {
        if (endNode.nodeType === Node.TEXT_NODE) {
          spanRange.setEnd(endNode, endOffset);
        } else {
          spanRange.setEnd(span, span.childNodes.length);
        }
      }
      
      const rects = spanRange.getClientRects();
      for (const r of rects) {
        if (r.width > 0 && r.height > 0) {
          relativeRects.push({
            left: (r.left - pageRect.left) / scale,
            top: (r.top - pageRect.top) / scale,
            width: r.width / scale,
            height: r.height / scale
          });
        }
      }
    }
  });
  
  if (relativeRects.length === 0) {
    const clientRects = range.getClientRects();
    for (const r of clientRects) {
      if (r.width > 0 && r.height > 0 && r.height < 60) {
        relativeRects.push({
          left: (r.left - pageRect.left) / scale,
          top: (r.top - pageRect.top) / scale,
          width: r.width / scale,
          height: r.height / scale
        });
      }
    }
  }
  
  temporaryHighlight = {
    pageNum: pageNum,
    rects: relativeRects
  };
  
  const layer = pageContainer.querySelector('.highlight-overlay-layer');
  if (layer) {
    renderHighlightsOnPage(pageNum, layer);
  }
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
