/**
 * pico - Renderer Process
 * Canvas drawing, tools, and UI interaction
 */

// ══════════════════════════════════════════════════════════════════════════════
// App State
// ══════════════════════════════════════════════════════════════════════════════

const state = {
  image: null,
  imageWidth: 0,
  imageHeight: 0,
  zoom: 1,
  currentTool: 'select',
  currentColor: '#ef4444',
  strokeWidth: 4,
  textFontSize: 24,
  textFontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
  isDrawing: false,
  startX: 0,
  startY: 0,
  annotations: [],
  history: [],
  historyIndex: -1,
  isEditingText: false,
  pendingTextPos: null,
  isDraggingText: false,
  dragTextIndex: -1,
  dragOffsetX: 0,
  dragOffsetY: 0,
  isDraggingAnnotation: false,
  dragAnnotationIndex: -1,
  dragStartX: 0,
  dragStartY: 0,
  selectedAnnotationIndex: -1,
  isResizingAnnotation: false,
  resizeHandle: null,
  pendingFullscreenPreview: false,
};

// ══════════════════════════════════════════════════════════════════════════════
// DOM Elements
// ══════════════════════════════════════════════════════════════════════════════

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

const elements = {
  canvas: $('#canvas'),
  ctx: null,
  container: $('#canvas-container'),
  emptyState: $('#empty-state'),
  btnCopy: $('#btn-copy'),
  btnUndo: $('#btn-undo'),
  btnRedo: $('#btn-redo'),
  emptyCapture: $('#empty-capture'),
  emptyOpen: $('#empty-open'),
  toolBtns: $$('.tool-btn'),
  colorSwatches: $$('.color-swatch'),
  strokeBtns: $$('.stroke-btn'),
  statusTool: $('#status-tool'),
  statusZoom: $('#status-zoom'),
  textWrapper: $('#text-input-wrapper'),
  textInput: $('#inline-text-input'),
  toastContainer: $('#toast-container'),
  textFontFamily: $('#text-font-family'),
  textFontSize: $('#text-font-size'),
  textStyleGroup: $('#text-style-group'),
  textStyleSeparator: $('#text-style-separator'),
};

function on(el, event, handler) { if (el) el.addEventListener(event, handler); }

// ══════════════════════════════════════════════════════════════════════════════
// Initialization
// ══════════════════════════════════════════════════════════════════════════════

function init() {
  document.body.classList.add(`platform-${window.pico.platform}`);
  elements.ctx = elements.canvas.getContext('2d');
  bindToolbar();
  bindCanvas();
  bindKeyboard();
  bindIPC();
  bindInlineText();
  if (elements.textFontFamily) elements.textFontFamily.value = state.textFontFamily;
  if (elements.textFontSize) elements.textFontSize.value = String(state.textFontSize);
  toggleTextStyleControls();
  updateStatus();
}

// ══════════════════════════════════════════════════════════════════════════════
// Event Binding
// ══════════════════════════════════════════════════════════════════════════════

function bindToolbar() {
  // Capture mode buttons
  on($('#btn-capture-region'), 'click', startCapture);
  on($('#btn-capture-window'), 'click', startCaptureWindow);
  on($('#btn-capture-fullscreen'), 'click', startCaptureFullscreen);
  
  on(elements.btnCopy, 'click', copyToClipboard);
  on(elements.btnUndo, 'click', undo);
  on(elements.btnRedo, 'click', redo);
  
  elements.emptyCapture.addEventListener('click', startCapture);
  elements.emptyOpen.addEventListener('click', openFile);
  
  elements.toolBtns.forEach(btn => {
    btn.addEventListener('click', () => selectTool(btn.dataset.tool));
  });
  elements.colorSwatches.forEach(swatch => {
    swatch.addEventListener('click', () => selectColor(swatch.dataset.color));
  });
  elements.strokeBtns.forEach(btn => {
    btn.addEventListener('click', () => selectStrokeWidth(parseInt(btn.dataset.width)));
  });
  on(elements.textFontFamily, 'change', () => selectTextFontFamily(elements.textFontFamily.value));
  on(elements.textFontSize, 'change', () => selectTextFontSize(parseInt(elements.textFontSize.value)));
}

function bindCanvas() {
  elements.canvas.addEventListener('mousedown', onCanvasMouseDown);
  document.addEventListener('mousemove', onCanvasMouseMove);
  document.addEventListener('mouseup', onCanvasMouseUp);
  elements.canvas.addEventListener('mouseleave', onCanvasMouseUp);
  elements.container.addEventListener('wheel', onWheel, { passive: false });
}

function bindKeyboard() {
  document.addEventListener('keydown', (e) => {
    if (state.isEditingText) return;
    const isMac = window.pico.platform === 'darwin';
    const cmdOrCtrl = isMac ? e.metaKey : e.ctrlKey;
    
    if (cmdOrCtrl && e.shiftKey && e.key.toLowerCase() === 's') { e.preventDefault(); startCapture(); return; }
    if (cmdOrCtrl && e.key.toLowerCase() === 'o') { e.preventDefault(); openFile(); return; }
    if (cmdOrCtrl && e.key.toLowerCase() === 'e') { e.preventDefault(); saveFile(); return; }
    if (cmdOrCtrl && e.key.toLowerCase() === 'c' && state.image) { e.preventDefault(); copyToClipboard(); return; }
    if (cmdOrCtrl && e.shiftKey && e.key.toLowerCase() === 'z') { e.preventDefault(); redo(); return; }
    if (cmdOrCtrl && e.key.toLowerCase() === 'z') { e.preventDefault(); undo(); return; }
    if ((e.key === 'Delete' || e.key === 'Backspace' || e.key === 'Del' || e.key === 'Suppr') && state.currentTool === 'select') {
      if (state.selectedAnnotationIndex >= 0) {
        e.preventDefault();
        deleteSelectedAnnotation();
      }
      return;
    }
    
    switch (e.key.toLowerCase()) {
      case 'r': selectTool('rect'); break;
      case 'e': selectTool('ellipse'); break;
      case 'a': selectTool('arrow'); break;
      case 'l': selectTool('line'); break;
      case 't': selectTool('text'); break;
      case '=': case '+': setZoom(state.zoom * 1.25); break;
      case '-': setZoom(state.zoom / 1.25); break;
      case '0': fitToWindow(); break;
    }
  });
}

function bindIPC() {
  window.pico.onTriggerCapture(() => startCapture());
  window.pico.onLoadCapture((payload) => {
    const capturePayload = typeof payload === 'string' ? { dataUrl: payload } : payload;
    loadImage(capturePayload?.dataUrl, {
      showPreview: capturePayload?.source === 'capture',
      captureMode: capturePayload?.captureMode || 'region',
      autoSelectRect: capturePayload?.source === 'capture',
    });
  });
  window.pico.onLoadCaptureData((captureData) => loadCaptureData(captureData, { autoSelectRect: true }));
}

function bindInlineText() {
  elements.textInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); commitInlineText(); }
    if (e.key === 'Escape') { cancelInlineText(); }
  });
  elements.textInput.addEventListener('input', autoResizeTextInput);

  document.addEventListener('mousedown', (e) => {
    if (!state.isEditingText) return;
    if (elements.textWrapper.contains(e.target)) return;
    commitInlineText();
  });

}

// ══════════════════════════════════════════════════════════════════════════════
// File Operations
// ══════════════════════════════════════════════════════════════════════════════

async function startCapture() {
  const result = await window.pico.startCapture();
  if (!result.success) showToast('Failed to start capture', 'error');
}

async function startCaptureWindow() {
  const result = await window.pico.startCaptureWindow();
  if (!result.success) showToast('Failed to capture window', 'error');
}

async function startCaptureFullscreen() {
  state.pendingFullscreenPreview = true;
  const result = await window.pico.startCaptureFullscreen();
  if (!result.success) {
    state.pendingFullscreenPreview = false;
    showToast('Failed to capture screen', 'error');
  }
}

async function openFile() {
  const dataUrl = await window.pico.openFile();
  if (dataUrl) loadImage(dataUrl);
}

async function saveFile() {
  if (!state.image) return;
  const dataUrl = getCompositeImage();
  const result = await window.pico.saveFile(dataUrl);
  if (result.success) showToast('Image saved successfully', 'success');
  else showToast('Failed to save image', 'error');
}

async function copyToClipboard() {
  if (!state.image) return;
  const dataUrl = getCompositeImage();
  const result = await window.pico.copyToClipboard(dataUrl);
  if (result.success) showToast('Copied to clipboard', 'success');
  else showToast('Failed to copy to clipboard', 'error');
}

// ══════════════════════════════════════════════════════════════════════════════
// Image Loading
// ══════════════════════════════════════════════════════════════════════════════

async function loadCaptureData(captureData, options = {}) {
  if (captureData.type === 'single') {
    loadImage(captureData.dataUrl, options);
    return;
  }
  const canvas = document.createElement('canvas');
  canvas.width = captureData.virtualBounds.width;
  canvas.height = captureData.virtualBounds.height;
  const ctx = canvas.getContext('2d');
  for (const screen of captureData.screens) {
    const img = await new Promise((resolve) => { const i = new Image(); i.onload = () => resolve(i); i.src = screen.dataUrl; });
    const dx = screen.bounds.x - captureData.virtualBounds.x;
    const dy = screen.bounds.y - captureData.virtualBounds.y;
    ctx.drawImage(img, dx, dy, screen.bounds.width, screen.bounds.height);
  }
  loadImage(canvas.toDataURL('image/png'), options);
}

function loadImage(dataUrl, options = {}) {
  const img = new Image();
  img.onload = () => {
    state.image = img;
    state.imageWidth = img.width;
    state.imageHeight = img.height;
    state.annotations = [];
    state.history = [];
    state.historyIndex = -1;
    state.zoom = 1;
    elements.canvas.width = img.width;
    elements.canvas.height = img.height;
    elements.canvas.classList.add('visible');
    elements.emptyState.classList.add('hidden');
    fitToWindow();
    render();
    updateStatus();
    updateToolbarState();
    if (options.autoSelectRect) selectTool('rect');
    if (options.showPreview || state.pendingFullscreenPreview) {
      showCapturePreview(dataUrl, options.captureMode || 'fullscreen');
      state.pendingFullscreenPreview = false;
    }
  };
  img.src = dataUrl;
}

// ══════════════════════════════════════════════════════════════════════════════
// Zoom & Pan
// ══════════════════════════════════════════════════════════════════════════════

function setZoom(newZoom) {
  state.zoom = Math.max(0.1, Math.min(10, newZoom));
  applyZoom();
  updateStatus();
}

function applyZoom() {
  elements.canvas.style.transform = `scale(${state.zoom})`;
  elements.canvas.style.transformOrigin = 'center center';
}

function fitToWindow() {
  if (!state.image) return;
  const container = elements.container;
  const padding = 40;
  const scaleX = (container.clientWidth - padding * 2) / state.imageWidth;
  const scaleY = (container.clientHeight - padding * 2) / state.imageHeight;
  state.zoom = Math.min(scaleX, scaleY, 1);
  applyZoom();
  updateStatus();
}

function onWheel(e) {
  if (!state.image || (!e.ctrlKey && !e.metaKey)) return;
  e.preventDefault();
  setZoom(state.zoom * (e.deltaY > 0 ? 0.9 : 1.1));
}

// ══════════════════════════════════════════════════════════════════════════════
// Tool Selection
// ══════════════════════════════════════════════════════════════════════════════

function selectTool(tool) {
  if (state.isEditingText) commitInlineText();
  state.currentTool = tool;
  elements.toolBtns.forEach(btn => btn.classList.toggle('active', btn.dataset.tool === tool));
  elements.container.className = 'canvas-container tool-' + tool;
  elements.canvas.style.cursor = tool === 'text' ? 'text' : (tool === 'select' ? 'default' : 'crosshair');
  toggleTextStyleControls();
  updateStatus();
}

function selectColor(color) {
  state.currentColor = color;
  elements.colorSwatches.forEach(s => s.classList.toggle('active', s.dataset.color === color));
  if (state.isEditingText) elements.textInput.style.color = color;
}

function selectStrokeWidth(width) {
  state.strokeWidth = width;
  elements.strokeBtns.forEach(btn => btn.classList.toggle('active', parseInt(btn.dataset.width) === width));
}

function selectTextFontSize(size) {
  state.textFontSize = size;
  if (state.isEditingText) {
    elements.textInput.style.fontSize = Math.round(size * state.zoom) + 'px';
    autoResizeTextInput();
  }
}

function selectTextFontFamily(family) {
  state.textFontFamily = family;
  if (state.isEditingText) elements.textInput.style.fontFamily = family;
}

function toggleTextStyleControls() {
  const visible = state.currentTool === 'text';
  elements.textStyleGroup?.classList.toggle('text-style-hidden', !visible);
  elements.textStyleSeparator?.classList.toggle('text-style-hidden', !visible);
}

// ══════════════════════════════════════════════════════════════════════════════
// Canvas Drawing Events
// ══════════════════════════════════════════════════════════════════════════════

function getCanvasCoords(e) {
  const rect = elements.canvas.getBoundingClientRect();
  return {
    x: (e.clientX - rect.left) * (state.imageWidth / rect.width),
    y: (e.clientY - rect.top) * (state.imageHeight / rect.height),
  };
}

function getScreenCoordsFromCanvas(canvasX, canvasY) {
  const rect = elements.canvas.getBoundingClientRect();
  return {
    x: rect.left + canvasX * (rect.width / state.imageWidth),
    y: rect.top + canvasY * (rect.height / state.imageHeight),
  };
}

function findTextAnnotationAt(coords) {
  const ctx = elements.ctx;
  for (let i = state.annotations.length - 1; i >= 0; i--) {
    const ann = state.annotations[i];
    if (ann.type !== 'text') continue;
    const fontSize = ann.fontSize || 24;
    const fontFamily = ann.fontFamily || '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
    ctx.font = `bold ${fontSize}px ${fontFamily}`;
    const lines = ann.text.split('\n');
    const lineHeight = fontSize * 1.2;
    const maxWidth = Math.max(...lines.map((line) => ctx.measureText(line).width), 0);
    const boxHeight = lineHeight * Math.max(lines.length, 1);
    if (coords.x >= ann.x - 5 && coords.x <= ann.x + maxWidth + 5 &&
        coords.y >= ann.y - lineHeight && coords.y <= ann.y + boxHeight) {
      return i;
    }
  }
  return -1;
}


function findAnnotationAt(coords) {
  for (let i = state.annotations.length - 1; i >= 0; i--) {
    const a = state.annotations[i];
    if (a.type === 'text' && findTextAnnotationAt(coords) === i) return i;
    if (a.type === 'rect' || a.type === 'highlight' || a.type === 'blur' || a.type === 'ellipse') {
      if (coords.x >= a.x && coords.x <= a.x + a.width && coords.y >= a.y && coords.y <= a.y + a.height) return i;
    }
    if (a.type === 'line' || a.type === 'arrow') {
      const dx = a.x2 - a.x1, dy = a.y2 - a.y1;
      const len2 = dx*dx + dy*dy || 1;
      const t = Math.max(0, Math.min(1, ((coords.x-a.x1)*dx + (coords.y-a.y1)*dy)/len2));
      const px = a.x1 + t*dx, py = a.y1 + t*dy;
      if (Math.hypot(coords.x-px, coords.y-py) <= 8) return i;
    }
  }
  return -1;
}

function moveAnnotation(annotation, dx, dy) {
  if ('x' in annotation) annotation.x += dx;
  if ('y' in annotation) annotation.y += dy;
  if ('x1' in annotation) { annotation.x1 += dx; annotation.x2 += dx; }
  if ('y1' in annotation) { annotation.y1 += dy; annotation.y2 += dy; }
}

function onCanvasMouseDown(e) {
  if (!state.image) return;
  if (state.isEditingText) { commitInlineText(); return; }
  
  const coords = getCanvasCoords(e);

  if (state.currentTool === 'select') {
    const handle = findResizeHandleAt(coords);
    if (handle) {
      state.isResizingAnnotation = true;
      state.resizeHandle = handle;
      state.dragStartX = coords.x;
      state.dragStartY = coords.y;
      elements.canvas.style.cursor = handle.cursor;
      return;
    }

    const idx = findAnnotationAt(coords);
    state.selectedAnnotationIndex = idx;
    if (idx >= 0) {
      state.isDraggingAnnotation = true;
      state.dragAnnotationIndex = idx;
      state.dragStartX = coords.x;
      state.dragStartY = coords.y;
      elements.canvas.style.cursor = 'grabbing';
    }
    render();
    return;
  }
  
  if (state.currentTool === 'text') {
    const textIdx = findTextAnnotationAt(coords);
    if (textIdx >= 0) {
      state.isDraggingText = true;
      state.dragTextIndex = textIdx;
      state.dragOffsetX = coords.x - state.annotations[textIdx].x;
      state.dragOffsetY = coords.y - state.annotations[textIdx].y;
      elements.canvas.style.cursor = 'grabbing';
      return;
    }
    openInlineText(coords);
    e.stopPropagation();
    return;
  }
  
  state.isDrawing = true;
  state.startX = coords.x;
  state.startY = coords.y;
}

function onCanvasMouseMove(e) {
  if (!state.image) return;
  
  if (state.isDraggingAnnotation) {
    const coords = getCanvasCoords(e);
    const dx = coords.x - state.dragStartX;
    const dy = coords.y - state.dragStartY;
    state.dragStartX = coords.x;
    state.dragStartY = coords.y;
    moveAnnotation(state.annotations[state.dragAnnotationIndex], dx, dy);
    render();
    return;
  }
  if (state.isResizingAnnotation) {
    const coords = getCanvasCoords(e);
    resizeSelectedAnnotation(coords);
    render();
    return;
  }
  if (state.isDraggingText) {
    const coords = getCanvasCoords(e);
    state.annotations[state.dragTextIndex].x = coords.x - state.dragOffsetX;
    state.annotations[state.dragTextIndex].y = coords.y - state.dragOffsetY;
    render();
    return;
  }
  
  if (state.currentTool === 'select' && !state.isDrawing && !state.isDraggingAnnotation) {
    const coords = getCanvasCoords(e);
    const handle = findResizeHandleAt(coords);
    if (handle) elements.canvas.style.cursor = handle.cursor;
    else elements.canvas.style.cursor = findAnnotationAt(coords) >= 0 ? 'grab' : 'default';
  }

  if (state.currentTool === 'text' && !state.isDrawing) {
    const coords = getCanvasCoords(e);
    elements.canvas.style.cursor = findTextAnnotationAt(coords) >= 0 ? 'grab' : 'text';
  }
  
  if (!state.isDrawing) return;
  const coords = getCanvasCoords(e);
  render();
  drawPreview(state.startX, state.startY, coords.x, coords.y);
}

function onCanvasMouseUp(e) {
  if (state.isDraggingAnnotation) {
    state.isDraggingAnnotation = false;
    state.dragAnnotationIndex = -1;
    elements.canvas.style.cursor = state.currentTool === 'select' ? 'default' : elements.canvas.style.cursor;
    state.history = state.history.slice(0, state.historyIndex + 1);
    state.history.push([...state.annotations.map(a => ({...a}))]);
    state.historyIndex = state.history.length - 1;
    updateToolbarState();
    render();
    return;
  }
  if (state.isResizingAnnotation) {
    state.isResizingAnnotation = false;
    state.resizeHandle = null;
    state.history = state.history.slice(0, state.historyIndex + 1);
    state.history.push([...state.annotations.map(a => ({...a}))]);
    state.historyIndex = state.history.length - 1;
    updateToolbarState();
    elements.canvas.style.cursor = 'default';
    render();
    return;
  }
  if (state.isDraggingText) {
    state.isDraggingText = false;
    elements.canvas.style.cursor = 'text';
    state.history = state.history.slice(0, state.historyIndex + 1);
    state.history.push([...state.annotations.map(a => ({...a}))]);
    state.historyIndex = state.history.length - 1;
    updateToolbarState();
    elements.canvas.style.cursor = state.currentTool === 'select' ? 'default' : elements.canvas.style.cursor;
    return;
  }
  
  if (!state.isDrawing || !state.image) return;
  const coords = getCanvasCoords(e);
  state.isDrawing = false;
  
  if (Math.abs(coords.x - state.startX) < 5 && Math.abs(coords.y - state.startY) < 5) {
    render();
    return;
  }
  
  addAnnotation(createAnnotation(state.startX, state.startY, coords.x, coords.y));
}

// ══════════════════════════════════════════════════════════════════════════════
// Inline Text Editing
// ══════════════════════════════════════════════════════════════════════════════

function openInlineText(coords) {
  state.isEditingText = true;
  state.pendingTextPos = coords;
  
  // Position relative to container (wrapper is position:absolute inside container)
  const canvasRect = elements.canvas.getBoundingClientRect();
  const containerRect = elements.container.getBoundingClientRect();
  const scaleX = canvasRect.width / state.imageWidth;
  const scaleY = canvasRect.height / state.imageHeight;
  
  const x = canvasRect.left + coords.x * scaleX - containerRect.left + elements.container.scrollLeft;
  const y = canvasRect.top + coords.y * scaleY - containerRect.top + elements.container.scrollTop;
  
  const wrapper = elements.textWrapper;
  wrapper.style.left = x + 'px';
  wrapper.style.top = y + 'px';
  wrapper.classList.add('visible');
  
  const input = elements.textInput;
  input.value = '';
  input.style.color = state.currentColor;
  input.style.fontSize = Math.round(state.textFontSize * state.zoom) + 'px';
  input.style.fontFamily = state.textFontFamily;
  setTimeout(() => input.focus(), 0);
  autoResizeTextInput();
}

function commitInlineText() {
  const text = elements.textInput.value.trim();
  state.isEditingText = false;
  elements.textWrapper.classList.remove('visible');
  
  if (text && state.pendingTextPos) {
    addAnnotation({
      type: 'text',
      x: state.pendingTextPos.x,
      y: state.pendingTextPos.y,
      text,
      color: state.currentColor,
      fontSize: state.textFontSize,
      fontFamily: state.textFontFamily,
    });
  }
  state.pendingTextPos = null;
}

function cancelInlineText() {
  state.isEditingText = false;
  elements.textWrapper.classList.remove('visible');
  state.pendingTextPos = null;
}

function autoResizeTextInput() {
  const input = elements.textInput;
  input.style.height = 'auto';
  input.style.height = input.scrollHeight + 'px';
  input.style.width = Math.max(120, input.scrollWidth + 20) + 'px';
}

// ══════════════════════════════════════════════════════════════════════════════
// Annotation Creation & History
// ══════════════════════════════════════════════════════════════════════════════

function createAnnotation(x1, y1, x2, y2) {
  const base = { type: state.currentTool, color: state.currentColor, strokeWidth: state.strokeWidth };
  switch (state.currentTool) {
    case 'rect': case 'ellipse': case 'highlight': case 'blur':
      return { ...base, x: Math.min(x1, x2), y: Math.min(y1, y2), width: Math.abs(x2 - x1), height: Math.abs(y2 - y1) };
    case 'arrow': case 'line':
      return { ...base, x1, y1, x2, y2 };
    default: return base;
  }
}

function addAnnotation(annotation) {
  state.history = state.history.slice(0, state.historyIndex + 1);
  state.history.push([...state.annotations, annotation]);
  state.historyIndex = state.history.length - 1;
  state.annotations = [...state.annotations, annotation];
  state.selectedAnnotationIndex = state.annotations.length - 1;
  render();
  updateStatus();
  updateToolbarState();
}

function undo() {
  if (state.historyIndex < 0) return;
  state.historyIndex--;
  state.annotations = state.historyIndex >= 0 ? [...state.history[state.historyIndex].map(a => ({...a}))] : [];
  if (state.selectedAnnotationIndex >= state.annotations.length) state.selectedAnnotationIndex = -1;
  render(); updateStatus(); updateToolbarState();
}

function redo() {
  if (state.historyIndex >= state.history.length - 1) return;
  state.historyIndex++;
  state.annotations = [...state.history[state.historyIndex].map(a => ({...a}))];
  if (state.selectedAnnotationIndex >= state.annotations.length) state.selectedAnnotationIndex = -1;
  render(); updateStatus(); updateToolbarState();
}

// ══════════════════════════════════════════════════════════════════════════════
// Rendering
// ══════════════════════════════════════════════════════════════════════════════

function render() {
  if (!state.image) return;
  const ctx = elements.ctx;
  ctx.clearRect(0, 0, elements.canvas.width, elements.canvas.height);
  ctx.drawImage(state.image, 0, 0);
  state.annotations.forEach(drawAnnotation);
  drawSelectionHandles();
}

function drawPreview(x1, y1, x2, y2) {
  const ctx = elements.ctx;
  ctx.save();
  ctx.strokeStyle = state.currentColor;
  ctx.lineWidth = state.strokeWidth;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.setLineDash([5, 5]);
  switch (state.currentTool) {
    case 'rect': ctx.strokeRect(Math.min(x1, x2), Math.min(y1, y2), Math.abs(x2 - x1), Math.abs(y2 - y1)); break;
    case 'ellipse': drawEllipse(ctx, Math.min(x1, x2), Math.min(y1, y2), Math.abs(x2 - x1), Math.abs(y2 - y1)); break;
    case 'arrow': drawArrow(ctx, x1, y1, x2, y2, false); break;
    case 'line': ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke(); break;
    case 'highlight': ctx.fillStyle = state.currentColor + '40'; ctx.setLineDash([]); ctx.fillRect(Math.min(x1, x2), Math.min(y1, y2), Math.abs(x2 - x1), Math.abs(y2 - y1)); break;
    case 'blur': ctx.strokeRect(Math.min(x1, x2), Math.min(y1, y2), Math.abs(x2 - x1), Math.abs(y2 - y1)); break;
  }
  ctx.restore();
}

function drawAnnotation(ann) {
  const ctx = elements.ctx;
  ctx.save();
  ctx.strokeStyle = ann.color;
  ctx.fillStyle = ann.color;
  ctx.lineWidth = ann.strokeWidth || 4;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  switch (ann.type) {
    case 'rect': ctx.strokeRect(ann.x, ann.y, ann.width, ann.height); break;
    case 'ellipse': drawEllipse(ctx, ann.x, ann.y, ann.width, ann.height); break;
    case 'arrow': drawArrow(ctx, ann.x1, ann.y1, ann.x2, ann.y2, true); break;
    case 'line': ctx.beginPath(); ctx.moveTo(ann.x1, ann.y1); ctx.lineTo(ann.x2, ann.y2); ctx.stroke(); break;
    case 'text':
      ctx.font = `bold ${ann.fontSize || 24}px ${ann.fontFamily || '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'}`;
      ann.text.split('\n').forEach((line, i) => {
        ctx.fillText(line, ann.x, ann.y + i * ((ann.fontSize || 24) * 1.2));
      });
      break;
    case 'highlight': ctx.fillStyle = ann.color + '40'; ctx.fillRect(ann.x, ann.y, ann.width, ann.height); break;
    case 'blur': applyBlur(ctx, ann.x, ann.y, ann.width, ann.height); break;
  }
  ctx.restore();
}

function drawEllipse(ctx, x, y, width, height) {
  ctx.beginPath();
  ctx.ellipse(x + width / 2, y + height / 2, width / 2, height / 2, 0, 0, Math.PI * 2);
  ctx.stroke();
}

function drawArrow(ctx, x1, y1, x2, y2, solid) {
  // Scale arrowhead with stroke width so it's visible at all sizes
  const headLength = Math.max(15, (ctx.lineWidth || 4) * 3);
  const angle = Math.atan2(y2 - y1, x2 - x1);
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x2, y2);
  ctx.stroke();
  if (solid) ctx.setLineDash([]);
  ctx.beginPath();
  ctx.moveTo(x2, y2);
  ctx.lineTo(x2 - headLength * Math.cos(angle - Math.PI / 6), y2 - headLength * Math.sin(angle - Math.PI / 6));
  ctx.lineTo(x2 - headLength * Math.cos(angle + Math.PI / 6), y2 - headLength * Math.sin(angle + Math.PI / 6));
  ctx.closePath();
  ctx.fill();
}

function applyBlur(ctx, x, y, width, height) {
  const pixelSize = 10;
  const imageData = ctx.getImageData(x, y, width, height);
  const data = imageData.data;
  for (let py = 0; py < height; py += pixelSize) {
    for (let px = 0; px < width; px += pixelSize) {
      let r = 0, g = 0, b = 0, count = 0;
      for (let dy = 0; dy < pixelSize && py + dy < height; dy++) {
        for (let dx = 0; dx < pixelSize && px + dx < width; dx++) {
          const i = ((py + dy) * width + (px + dx)) * 4;
          r += data[i]; g += data[i + 1]; b += data[i + 2]; count++;
        }
      }
      r = Math.floor(r / count); g = Math.floor(g / count); b = Math.floor(b / count);
      for (let dy = 0; dy < pixelSize && py + dy < height; dy++) {
        for (let dx = 0; dx < pixelSize && px + dx < width; dx++) {
          const i = ((py + dy) * width + (px + dx)) * 4;
          data[i] = r; data[i + 1] = g; data[i + 2] = b;
        }
      }
    }
  }
  ctx.putImageData(imageData, x, y);
}

function deleteSelectedAnnotation() {
  if (state.selectedAnnotationIndex < 0) return;
  state.annotations.splice(state.selectedAnnotationIndex, 1);
  state.selectedAnnotationIndex = -1;
  state.history = state.history.slice(0, state.historyIndex + 1);
  state.history.push([...state.annotations.map(a => ({...a}))]);
  state.historyIndex = state.history.length - 1;
  render();
  updateToolbarState();
}

function getAnnotationBounds(annotation) {
  if (!annotation) return null;
  if (annotation.type === 'rect' || annotation.type === 'ellipse' || annotation.type === 'highlight' || annotation.type === 'blur') {
    return { x: annotation.x, y: annotation.y, width: annotation.width, height: annotation.height, type: 'box' };
  }
  if (annotation.type === 'line' || annotation.type === 'arrow') {
    return {
      x: Math.min(annotation.x1, annotation.x2),
      y: Math.min(annotation.y1, annotation.y2),
      width: Math.abs(annotation.x2 - annotation.x1),
      height: Math.abs(annotation.y2 - annotation.y1),
      type: 'line',
      x1: annotation.x1, y1: annotation.y1, x2: annotation.x2, y2: annotation.y2,
    };
  }
  return null;
}

function findResizeHandleAt(coords) {
  if (state.selectedAnnotationIndex < 0) return null;
  const ann = state.annotations[state.selectedAnnotationIndex];
  const bounds = getAnnotationBounds(ann);
  if (!bounds) return null;
  const size = 10;

  if (bounds.type === 'line') {
    if (Math.hypot(coords.x - bounds.x1, coords.y - bounds.y1) <= size) return { kind: 'line-start', cursor: 'pointer' };
    if (Math.hypot(coords.x - bounds.x2, coords.y - bounds.y2) <= size) return { kind: 'line-end', cursor: 'pointer' };
    return null;
  }

  const handles = [
    { kind: 'nw', x: bounds.x, y: bounds.y, cursor: 'nwse-resize' },
    { kind: 'ne', x: bounds.x + bounds.width, y: bounds.y, cursor: 'nesw-resize' },
    { kind: 'sw', x: bounds.x, y: bounds.y + bounds.height, cursor: 'nesw-resize' },
    { kind: 'se', x: bounds.x + bounds.width, y: bounds.y + bounds.height, cursor: 'nwse-resize' },
  ];
  return handles.find(h => Math.abs(coords.x - h.x) <= size && Math.abs(coords.y - h.y) <= size) || null;
}

function resizeSelectedAnnotation(coords) {
  const ann = state.annotations[state.selectedAnnotationIndex];
  if (!ann || !state.resizeHandle) return;
  if (ann.type === 'line' || ann.type === 'arrow') {
    if (state.resizeHandle.kind === 'line-start') { ann.x1 = coords.x; ann.y1 = coords.y; }
    if (state.resizeHandle.kind === 'line-end') { ann.x2 = coords.x; ann.y2 = coords.y; }
    return;
  }
  const x1 = ann.x;
  const y1 = ann.y;
  const x2 = ann.x + ann.width;
  const y2 = ann.y + ann.height;
  let nx1 = x1, ny1 = y1, nx2 = x2, ny2 = y2;
  if (state.resizeHandle.kind.includes('n')) ny1 = coords.y;
  if (state.resizeHandle.kind.includes('s')) ny2 = coords.y;
  if (state.resizeHandle.kind.includes('w')) nx1 = coords.x;
  if (state.resizeHandle.kind.includes('e')) nx2 = coords.x;
  ann.x = Math.min(nx1, nx2);
  ann.y = Math.min(ny1, ny2);
  ann.width = Math.max(1, Math.abs(nx2 - nx1));
  ann.height = Math.max(1, Math.abs(ny2 - ny1));
}

function drawSelectionHandles() {
  if (state.currentTool !== 'select' || state.selectedAnnotationIndex < 0) return;
  const ann = state.annotations[state.selectedAnnotationIndex];
  const bounds = getAnnotationBounds(ann);
  if (!bounds) return;
  const ctx = elements.ctx;
  ctx.save();
  ctx.strokeStyle = '#3b82f6';
  ctx.fillStyle = '#ffffff';
  ctx.lineWidth = 2;

  if (bounds.type === 'line') {
    drawHandle(bounds.x1, bounds.y1);
    drawHandle(bounds.x2, bounds.y2);
  } else {
    ctx.setLineDash([5, 4]);
    ctx.strokeRect(bounds.x, bounds.y, bounds.width, bounds.height);
    ctx.setLineDash([]);
    drawHandle(bounds.x, bounds.y);
    drawHandle(bounds.x + bounds.width, bounds.y);
    drawHandle(bounds.x, bounds.y + bounds.height);
    drawHandle(bounds.x + bounds.width, bounds.y + bounds.height);
  }

  ctx.restore();

  function drawHandle(x, y) {
    const s = 8;
    ctx.beginPath();
    ctx.rect(x - s / 2, y - s / 2, s, s);
    ctx.fill();
    ctx.stroke();
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// Composite & UI
// ══════════════════════════════════════════════════════════════════════════════

function getCompositeImage() {
  const tempCanvas = document.createElement('canvas');
  tempCanvas.width = state.imageWidth;
  tempCanvas.height = state.imageHeight;
  const tempCtx = tempCanvas.getContext('2d');
  tempCtx.drawImage(state.image, 0, 0);
  const orig = elements.ctx;
  elements.ctx = tempCtx;
  state.annotations.forEach(drawAnnotation);
  elements.ctx = orig;
  return tempCanvas.toDataURL('image/png');
}

function updateStatus() {
  const names = { select: 'Select', rect: 'Rectangle', ellipse: 'Ellipse', arrow: 'Arrow', line: 'Line', text: 'Text', highlight: 'Highlight', blur: 'Blur' };
  elements.statusTool.textContent = names[state.currentTool] || state.currentTool;
  elements.statusZoom.textContent = `${Math.round(state.zoom * 100)}%`;
}

function updateToolbarState() {
  elements.btnCopy.disabled = !state.image;
  elements.btnUndo.disabled = state.historyIndex < 0;
  elements.btnRedo.disabled = state.historyIndex >= state.history.length - 1;
}


function playCaptureChime() {
  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextClass) return;
  const ctx = new AudioContextClass();
  const now = ctx.currentTime;
  const notes = [659.25, 783.99, 1046.5];
  notes.forEach((frequency, index) => {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(frequency, now);
    gain.gain.setValueAtTime(0.0001, now);
    const start = now + index * 0.08;
    const end = start + 0.23;
    gain.gain.exponentialRampToValueAtTime(0.08, start + 0.03);
    gain.gain.exponentialRampToValueAtTime(0.0001, end);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(start);
    osc.stop(end);
  });
  setTimeout(() => ctx.close().catch(() => {}), 700);
}

function showCapturePreview(dataUrl, captureMode = 'region') {
  const preview = document.getElementById('capture-preview');
  const image = document.getElementById('capture-preview-image');
  const mode = document.getElementById('capture-preview-mode');
  if (!preview || !image || !mode) return;
  image.src = dataUrl;
  mode.textContent = `${captureMode.charAt(0).toUpperCase()}${captureMode.slice(1)} capture ready`;
  preview.classList.add('visible');
  playCaptureChime();
  window.clearTimeout(showCapturePreview.timeoutId);
  showCapturePreview.timeoutId = window.setTimeout(() => {
    preview.classList.remove('visible');
  }, 2300);
}

function showToast(message, type = 'info') {
  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.textContent = message;
  elements.toastContainer.appendChild(toast);
  setTimeout(() => toast.remove(), 3000);
}

document.addEventListener('DOMContentLoaded', init);
