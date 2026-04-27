/**
 * pico - Renderer Process
 * Canvas drawing, tools, and UI interaction
 */

// ══════════════════════════════════════════════════════════════════════════════
// App State
// ══════════════════════════════════════════════════════════════════════════════

const state = {
  // Image
  image: null,
  imageWidth: 0,
  imageHeight: 0,
  
  // View
  zoom: 1,
  panX: 0,
  panY: 0,
  
  // Tools
  currentTool: 'rect',
  currentColor: '#ef4444',
  strokeWidth: 4,
  
  // Drawing
  isDrawing: false,
  startX: 0,
  startY: 0,
  
  // History (undo/redo)
  annotations: [],
  history: [],
  historyIndex: -1,
  
  // Text input
  pendingTextPos: null,
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
  
  // Buttons
  btnCapture: $('#btn-capture'),
  btnOpen: $('#btn-open'),
  btnSave: $('#btn-save'),
  btnCopy: $('#btn-copy'),
  btnUndo: $('#btn-undo'),
  btnRedo: $('#btn-redo'),
  btnZoomIn: $('#btn-zoom-in'),
  btnZoomOut: $('#btn-zoom-out'),
  btnZoomFit: $('#btn-zoom-fit'),
  
  // Empty state buttons
  emptyCapture: $('#empty-capture'),
  emptyOpen: $('#empty-open'),
  
  // Tool buttons
  toolBtns: $$('.tool-btn'),
  colorSwatches: $$('.color-swatch'),
  strokeBtns: $$('.stroke-btn'),
  customColor: $('#custom-color'),
  colorPickerInput: $('#color-picker-input'),
  
  // Status
  statusTool: $('#status-tool'),
  statusSize: $('#status-size'),
  statusAnnotations: $('#status-annotations'),
  zoomLevel: $('#zoom-level'),
  
  // Modal
  textModal: $('#text-modal'),
  textInput: $('#text-input'),
  textCancel: $('#text-cancel'),
  textConfirm: $('#text-confirm'),
  
  // Toast
  toastContainer: $('#toast-container'),
};

// ══════════════════════════════════════════════════════════════════════════════
// Initialization
// ══════════════════════════════════════════════════════════════════════════════

function init() {
  // Set platform class
  document.body.classList.add(`platform-${window.pico.platform}`);
  
  // Get canvas context
  elements.ctx = elements.canvas.getContext('2d');
  
  // Bind event listeners
  bindToolbar();
  bindCanvas();
  bindKeyboard();
  bindIPC();
  
  // Update UI
  updateStatus();
}

// ══════════════════════════════════════════════════════════════════════════════
// Event Binding
// ══════════════════════════════════════════════════════════════════════════════

function bindToolbar() {
  // Action buttons
  elements.btnCapture.addEventListener('click', startCapture);
  elements.btnOpen.addEventListener('click', openFile);
  elements.btnSave.addEventListener('click', saveFile);
  elements.btnCopy.addEventListener('click', copyToClipboard);
  elements.btnUndo.addEventListener('click', undo);
  elements.btnRedo.addEventListener('click', redo);
  elements.btnZoomIn.addEventListener('click', () => setZoom(state.zoom * 1.25));
  elements.btnZoomOut.addEventListener('click', () => setZoom(state.zoom / 1.25));
  elements.btnZoomFit.addEventListener('click', fitToWindow);
  
  // Empty state buttons
  elements.emptyCapture.addEventListener('click', startCapture);
  elements.emptyOpen.addEventListener('click', openFile);
  
  // Tool selection
  elements.toolBtns.forEach(btn => {
    btn.addEventListener('click', () => selectTool(btn.dataset.tool));
  });
  
  // Color selection
  elements.colorSwatches.forEach(swatch => {
    swatch.addEventListener('click', () => selectColor(swatch.dataset.color));
  });
  
  // Custom color
  elements.customColor.addEventListener('click', () => {
    elements.colorPickerInput.click();
  });
  elements.colorPickerInput.addEventListener('input', (e) => {
    selectColor(e.target.value);
  });
  
  // Stroke width
  elements.strokeBtns.forEach(btn => {
    btn.addEventListener('click', () => selectStrokeWidth(parseInt(btn.dataset.width)));
  });
  
  // Text modal
  elements.textCancel.addEventListener('click', closeTextModal);
  elements.textConfirm.addEventListener('click', confirmText);
  elements.textInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') confirmText();
    if (e.key === 'Escape') closeTextModal();
  });
  $('#text-modal .modal-backdrop').addEventListener('click', closeTextModal);
}

function bindCanvas() {
  const canvas = elements.canvas;
  const container = elements.container;
  
  canvas.addEventListener('mousedown', onCanvasMouseDown);
  canvas.addEventListener('mousemove', onCanvasMouseMove);
  canvas.addEventListener('mouseup', onCanvasMouseUp);
  canvas.addEventListener('mouseleave', onCanvasMouseUp);
  
  // Zoom with wheel
  container.addEventListener('wheel', onWheel, { passive: false });
}

function bindKeyboard() {
  document.addEventListener('keydown', (e) => {
    const isMac = window.pico.platform === 'darwin';
    const cmdOrCtrl = isMac ? e.metaKey : e.ctrlKey;
    
    // Global shortcuts
    if (cmdOrCtrl && e.shiftKey && e.key.toLowerCase() === 's') {
      e.preventDefault();
      startCapture();
      return;
    }
    if (cmdOrCtrl && e.key.toLowerCase() === 'o') {
      e.preventDefault();
      openFile();
      return;
    }
    if (cmdOrCtrl && e.key.toLowerCase() === 'e') {
      e.preventDefault();
      saveFile();
      return;
    }
    if (cmdOrCtrl && e.key.toLowerCase() === 'c' && state.image) {
      e.preventDefault();
      copyToClipboard();
      return;
    }
    if (cmdOrCtrl && e.shiftKey && e.key.toLowerCase() === 'z') {
      e.preventDefault();
      redo();
      return;
    }
    if (cmdOrCtrl && e.key.toLowerCase() === 'z') {
      e.preventDefault();
      undo();
      return;
    }
    
    // Tool shortcuts (only when not in modal)
    if (elements.textModal.classList.contains('visible')) return;
    
    switch (e.key.toLowerCase()) {
      case 'r': selectTool('rect'); break;
      case 'e': selectTool('ellipse'); break;
      case 'a': selectTool('arrow'); break;
      case 'l': selectTool('line'); break;
      case 't': selectTool('text'); break;
      case 'h': selectTool('highlight'); break;
      case 'b': selectTool('blur'); break;
      case '=':
      case '+': setZoom(state.zoom * 1.25); break;
      case '-': setZoom(state.zoom / 1.25); break;
      case '0': fitToWindow(); break;
    }
  });
}

function bindIPC() {
  // Listen for capture trigger from main process
  window.pico.onTriggerCapture(() => {
    startCapture();
  });
  
  // Listen for loaded capture
  window.pico.onLoadCapture((dataUrl) => {
    loadImage(dataUrl);
  });
}


// ══════════════════════════════════════════════════════════════════════════════
// File Operations
// ══════════════════════════════════════════════════════════════════════════════

async function startCapture() {
  const result = await window.pico.startCapture();
  if (!result.success) {
    showToast('Failed to start capture', 'error');
  }
}

async function openFile() {
  const dataUrl = await window.pico.openFile();
  if (dataUrl) {
    loadImage(dataUrl);
  }
}

async function saveFile() {
  if (!state.image) return;
  
  const dataUrl = getCompositeImage();
  const result = await window.pico.saveFile(dataUrl);
  
  if (result.success) {
    showToast('Image saved successfully', 'success');
  } else {
    showToast('Failed to save image', 'error');
  }
}

async function copyToClipboard() {
  if (!state.image) return;
  
  const dataUrl = getCompositeImage();
  const result = await window.pico.copyToClipboard(dataUrl);
  
  if (result.success) {
    showToast('Copied to clipboard', 'success');
  } else {
    showToast('Failed to copy to clipboard', 'error');
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// Image Loading
// ══════════════════════════════════════════════════════════════════════════════

function loadImage(dataUrl) {
  const img = new Image();
  img.onload = () => {
    state.image = img;
    state.imageWidth = img.width;
    state.imageHeight = img.height;
    
    // Reset state
    state.annotations = [];
    state.history = [];
    state.historyIndex = -1;
    state.zoom = 1;
    
    // Setup canvas
    elements.canvas.width = img.width;
    elements.canvas.height = img.height;
    elements.canvas.classList.add('visible');
    elements.emptyState.classList.add('hidden');
    
    // Fit to window initially
    fitToWindow();
    
    // Draw
    render();
    updateStatus();
    updateToolbarState();
  };
  img.src = dataUrl;
}

// ══════════════════════════════════════════════════════════════════════════════
// Zoom & Pan
// ══════════════════════════════════════════════════════════════════════════════

function setZoom(newZoom) {
  const minZoom = 0.1;
  const maxZoom = 10;
  state.zoom = Math.max(minZoom, Math.min(maxZoom, newZoom));
  
  applyZoom();
  updateStatus();
}

function applyZoom() {
  const canvas = elements.canvas;
  canvas.style.transform = `scale(${state.zoom})`;
  canvas.style.transformOrigin = 'center center';
}

function fitToWindow() {
  if (!state.image) return;
  
  const container = elements.container;
  const padding = 40;
  const availableWidth = container.clientWidth - padding * 2;
  const availableHeight = container.clientHeight - padding * 2;
  
  const scaleX = availableWidth / state.imageWidth;
  const scaleY = availableHeight / state.imageHeight;
  
  state.zoom = Math.min(scaleX, scaleY, 1);
  applyZoom();
  updateStatus();
}

function onWheel(e) {
  if (!state.image) return;
  if (!e.ctrlKey && !e.metaKey) return;
  
  e.preventDefault();
  
  const delta = e.deltaY > 0 ? 0.9 : 1.1;
  setZoom(state.zoom * delta);
}

// ══════════════════════════════════════════════════════════════════════════════
// Tool Selection
// ══════════════════════════════════════════════════════════════════════════════

function selectTool(tool) {
  state.currentTool = tool;
  
  // Update button states
  elements.toolBtns.forEach(btn => {
    btn.classList.toggle('active', btn.dataset.tool === tool);
  });
  
  // Update cursor
  elements.container.className = 'canvas-container tool-' + tool;
  
  updateStatus();
}

function selectColor(color) {
  state.currentColor = color;
  
  // Update swatch states
  elements.colorSwatches.forEach(swatch => {
    swatch.classList.toggle('active', swatch.dataset.color === color);
  });
}

function selectStrokeWidth(width) {
  state.strokeWidth = width;
  
  elements.strokeBtns.forEach(btn => {
    btn.classList.toggle('active', parseInt(btn.dataset.width) === width);
  });
}

// ══════════════════════════════════════════════════════════════════════════════
// Canvas Drawing Events
// ══════════════════════════════════════════════════════════════════════════════

function getCanvasCoords(e) {
  const rect = elements.canvas.getBoundingClientRect();
  const scaleX = state.imageWidth / rect.width;
  const scaleY = state.imageHeight / rect.height;
  
  return {
    x: (e.clientX - rect.left) * scaleX,
    y: (e.clientY - rect.top) * scaleY,
  };
}

function onCanvasMouseDown(e) {
  if (!state.image) return;
  
  const coords = getCanvasCoords(e);
  
  if (state.currentTool === 'text') {
    state.pendingTextPos = coords;
    openTextModal();
    return;
  }
  
  state.isDrawing = true;
  state.startX = coords.x;
  state.startY = coords.y;
}

function onCanvasMouseMove(e) {
  if (!state.isDrawing || !state.image) return;
  
  const coords = getCanvasCoords(e);
  
  // Render with preview
  render();
  drawPreview(state.startX, state.startY, coords.x, coords.y);
}

function onCanvasMouseUp(e) {
  if (!state.isDrawing || !state.image) return;
  
  const coords = getCanvasCoords(e);
  state.isDrawing = false;
  
  // Don't add if too small
  const dx = Math.abs(coords.x - state.startX);
  const dy = Math.abs(coords.y - state.startY);
  if (dx < 5 && dy < 5) {
    render();
    return;
  }
  
  // Create annotation
  const annotation = createAnnotation(state.startX, state.startY, coords.x, coords.y);
  addAnnotation(annotation);
}

// ══════════════════════════════════════════════════════════════════════════════
// Annotation Creation
// ══════════════════════════════════════════════════════════════════════════════

function createAnnotation(x1, y1, x2, y2) {
  const base = {
    type: state.currentTool,
    color: state.currentColor,
    strokeWidth: state.strokeWidth,
  };
  
  switch (state.currentTool) {
    case 'rect':
    case 'ellipse':
    case 'highlight':
    case 'blur':
      return { ...base, x: Math.min(x1, x2), y: Math.min(y1, y2), 
               width: Math.abs(x2 - x1), height: Math.abs(y2 - y1) };
    case 'arrow':
    case 'line':
      return { ...base, x1, y1, x2, y2 };
    default:
      return base;
  }
}

function createTextAnnotation(x, y, text) {
  return {
    type: 'text',
    x, y,
    text,
    color: state.currentColor,
    fontSize: 24,
  };
}

// ══════════════════════════════════════════════════════════════════════════════
// History (Undo/Redo)
// ══════════════════════════════════════════════════════════════════════════════

function addAnnotation(annotation) {
  // Truncate future history
  state.history = state.history.slice(0, state.historyIndex + 1);
  
  // Add to history
  state.history.push([...state.annotations, annotation]);
  state.historyIndex = state.history.length - 1;
  state.annotations = [...state.annotations, annotation];
  
  render();
  updateStatus();
  updateToolbarState();
}

function undo() {
  if (state.historyIndex < 0) return;
  
  state.historyIndex--;
  state.annotations = state.historyIndex >= 0 
    ? [...state.history[state.historyIndex]]
    : [];
  
  render();
  updateStatus();
  updateToolbarState();
}

function redo() {
  if (state.historyIndex >= state.history.length - 1) return;
  
  state.historyIndex++;
  state.annotations = [...state.history[state.historyIndex]];
  
  render();
  updateStatus();
  updateToolbarState();
}


// ══════════════════════════════════════════════════════════════════════════════
// Rendering
// ══════════════════════════════════════════════════════════════════════════════

function render() {
  if (!state.image) return;
  
  const ctx = elements.ctx;
  const canvas = elements.canvas;
  
  // Clear and draw base image
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(state.image, 0, 0);
  
  // Draw all annotations
  state.annotations.forEach(drawAnnotation);
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
    case 'rect':
      ctx.strokeRect(Math.min(x1, x2), Math.min(y1, y2), Math.abs(x2 - x1), Math.abs(y2 - y1));
      break;
    case 'ellipse':
      drawEllipse(ctx, Math.min(x1, x2), Math.min(y1, y2), Math.abs(x2 - x1), Math.abs(y2 - y1), false);
      break;
    case 'arrow':
      drawArrow(ctx, x1, y1, x2, y2, false);
      break;
    case 'line':
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
      ctx.stroke();
      break;
    case 'highlight':
      ctx.fillStyle = state.currentColor + '40';
      ctx.setLineDash([]);
      ctx.fillRect(Math.min(x1, x2), Math.min(y1, y2), Math.abs(x2 - x1), Math.abs(y2 - y1));
      break;
    case 'blur':
      // Preview just shows outline
      ctx.strokeRect(Math.min(x1, x2), Math.min(y1, y2), Math.abs(x2 - x1), Math.abs(y2 - y1));
      break;
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
    case 'rect':
      ctx.strokeRect(ann.x, ann.y, ann.width, ann.height);
      break;
      
    case 'ellipse':
      drawEllipse(ctx, ann.x, ann.y, ann.width, ann.height, true);
      break;
      
    case 'arrow':
      drawArrow(ctx, ann.x1, ann.y1, ann.x2, ann.y2, true);
      break;
      
    case 'line':
      ctx.beginPath();
      ctx.moveTo(ann.x1, ann.y1);
      ctx.lineTo(ann.x2, ann.y2);
      ctx.stroke();
      break;
      
    case 'text':
      ctx.font = `bold ${ann.fontSize || 24}px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`;
      ctx.fillText(ann.text, ann.x, ann.y);
      break;
      
    case 'highlight':
      ctx.fillStyle = ann.color + '40';
      ctx.fillRect(ann.x, ann.y, ann.width, ann.height);
      break;
      
    case 'blur':
      applyBlur(ctx, ann.x, ann.y, ann.width, ann.height);
      break;
  }
  
  ctx.restore();
}

function drawEllipse(ctx, x, y, width, height, solid) {
  const centerX = x + width / 2;
  const centerY = y + height / 2;
  const radiusX = width / 2;
  const radiusY = height / 2;
  
  ctx.beginPath();
  ctx.ellipse(centerX, centerY, radiusX, radiusY, 0, 0, Math.PI * 2);
  ctx.stroke();
}

function drawArrow(ctx, x1, y1, x2, y2, solid) {
  const headLength = 15;
  const angle = Math.atan2(y2 - y1, x2 - x1);
  
  // Draw line
  ctx.beginPath();
  ctx.moveTo(x1, y1);
  ctx.lineTo(x2, y2);
  ctx.stroke();
  
  // Draw arrowhead
  if (solid) {
    ctx.setLineDash([]);
  }
  ctx.beginPath();
  ctx.moveTo(x2, y2);
  ctx.lineTo(
    x2 - headLength * Math.cos(angle - Math.PI / 7),
    y2 - headLength * Math.sin(angle - Math.PI / 7)
  );
  ctx.lineTo(
    x2 - headLength * Math.cos(angle + Math.PI / 7),
    y2 - headLength * Math.sin(angle + Math.PI / 7)
  );
  ctx.closePath();
  ctx.fill();
}

function applyBlur(ctx, x, y, width, height) {
  // Simple pixelation blur effect
  const pixelSize = 10;
  const imageData = ctx.getImageData(x, y, width, height);
  const data = imageData.data;
  
  for (let py = 0; py < height; py += pixelSize) {
    for (let px = 0; px < width; px += pixelSize) {
      // Get average color of pixel block
      let r = 0, g = 0, b = 0, count = 0;
      
      for (let dy = 0; dy < pixelSize && py + dy < height; dy++) {
        for (let dx = 0; dx < pixelSize && px + dx < width; dx++) {
          const i = ((py + dy) * width + (px + dx)) * 4;
          r += data[i];
          g += data[i + 1];
          b += data[i + 2];
          count++;
        }
      }
      
      r = Math.floor(r / count);
      g = Math.floor(g / count);
      b = Math.floor(b / count);
      
      // Fill block with average color
      for (let dy = 0; dy < pixelSize && py + dy < height; dy++) {
        for (let dx = 0; dx < pixelSize && px + dx < width; dx++) {
          const i = ((py + dy) * width + (px + dx)) * 4;
          data[i] = r;
          data[i + 1] = g;
          data[i + 2] = b;
        }
      }
    }
  }
  
  ctx.putImageData(imageData, x, y);
}

// ══════════════════════════════════════════════════════════════════════════════
// Composite Image Export
// ══════════════════════════════════════════════════════════════════════════════

function getCompositeImage() {
  // Create temp canvas with annotations
  const tempCanvas = document.createElement('canvas');
  tempCanvas.width = state.imageWidth;
  tempCanvas.height = state.imageHeight;
  const tempCtx = tempCanvas.getContext('2d');
  
  // Draw image
  tempCtx.drawImage(state.image, 0, 0);
  
  // Draw annotations
  const originalCtx = elements.ctx;
  elements.ctx = tempCtx;
  state.annotations.forEach(drawAnnotation);
  elements.ctx = originalCtx;
  
  return tempCanvas.toDataURL('image/png');
}

// ══════════════════════════════════════════════════════════════════════════════
// Text Modal
// ══════════════════════════════════════════════════════════════════════════════

function openTextModal() {
  elements.textModal.classList.add('visible');
  elements.textInput.value = '';
  elements.textInput.focus();
}

function closeTextModal() {
  elements.textModal.classList.remove('visible');
  state.pendingTextPos = null;
}

function confirmText() {
  const text = elements.textInput.value.trim();
  if (!text || !state.pendingTextPos) {
    closeTextModal();
    return;
  }
  
  const annotation = createTextAnnotation(state.pendingTextPos.x, state.pendingTextPos.y, text);
  addAnnotation(annotation);
  closeTextModal();
}

// ══════════════════════════════════════════════════════════════════════════════
// UI Updates
// ══════════════════════════════════════════════════════════════════════════════

function updateStatus() {
  const toolNames = {
    rect: 'Rectangle',
    ellipse: 'Ellipse',
    arrow: 'Arrow',
    line: 'Line',
    text: 'Text',
    highlight: 'Highlight',
    blur: 'Blur',
  };
  
  elements.statusTool.textContent = toolNames[state.currentTool] || state.currentTool;
  
  if (state.image) {
    elements.statusSize.textContent = `${state.imageWidth} × ${state.imageHeight}`;
  } else {
    elements.statusSize.textContent = '—';
  }
  
  const count = state.annotations.length;
  elements.statusAnnotations.textContent = `${count} annotation${count !== 1 ? 's' : ''}`;
  
  elements.zoomLevel.textContent = `${Math.round(state.zoom * 100)}%`;
}

function updateToolbarState() {
  const hasImage = !!state.image;
  
  elements.btnSave.disabled = !hasImage;
  elements.btnCopy.disabled = !hasImage;
  elements.btnUndo.disabled = state.historyIndex < 0;
  elements.btnRedo.disabled = state.historyIndex >= state.history.length - 1;
}

// ══════════════════════════════════════════════════════════════════════════════
// Toast Notifications
// ══════════════════════════════════════════════════════════════════════════════

function showToast(message, type = 'info') {
  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.textContent = message;
  
  elements.toastContainer.appendChild(toast);
  
  setTimeout(() => {
    toast.remove();
  }, 3000);
}

// ══════════════════════════════════════════════════════════════════════════════
// Initialize
// ══════════════════════════════════════════════════════════════════════════════

document.addEventListener('DOMContentLoaded', init);
