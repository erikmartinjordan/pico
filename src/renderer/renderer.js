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
  currentColor: '#f97316',
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
  windowContainerApplied: false,
  containerGradient: 'none',
  originalImageBeforeContainer: null,
  // Crop state
  cropActive: false,
  cropX: 0,
  cropY: 0,
  cropW: 0,
  cropH: 0,
  cropDragging: null, // which handle or 'move'
  cropDragStartX: 0,
  cropDragStartY: 0,
  cropOrigRect: null,
  isRecording: false,
  recordingFormat: 'mp4',
  recordingMode: 'region',
  isSavingRecording: false,
  recordingSettings: { format: 'mp4', autoZoom: true },
  captureSettings: { hideDesktopIcons: true },
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
  btnCrop: $('#btn-crop'),
  btnUndo: $('#btn-undo'),
  btnRedo: $('#btn-redo'),
  btnClear: $('#btn-clear'),
  btnRecordScreen: $('#btn-record-screen'),
  recordingFormatMenu: $('#recording-format-menu'),
  recordingSaveProgress: $('#recording-save-progress'),
  preferencesDialog: $('#preferences-dialog'),
  recordingFormatSetting: $('#recording-format-setting'),
  recordingAutozoomSetting: $('#recording-autozoom-setting'),
  hideDesktopIconsSetting: $('#hide-desktop-icons-setting'),
  btnCaptureRegion: $('#btn-capture-region'),
  btnCaptureWindow: $('#btn-capture-window'),
  btnCaptureFullscreen: $('#btn-capture-fullscreen'),
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
  tooltip: $('#app-tooltip'),
  textFontFamily: $('#text-font-family'),
  textFontSize: $('#text-font-size'),
  textStyleGroup: $('#text-style-group'),
  textStyleSeparator: $('#text-style-separator'),
  cropOverlay: $('#crop-overlay'),
  cropBox: $('#crop-box'),
  cropHint: $('#crop-hint'),
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
  bindContextMenu();
  bindPaste();
  bindCrop();
  bindTooltips();
  if (elements.textFontFamily) elements.textFontFamily.value = state.textFontFamily;
  if (elements.textFontSize) elements.textFontSize.value = String(state.textFontSize);
  loadRecordingSettings();
  toggleTextStyleControls();
  updateStatus();
}

// ══════════════════════════════════════════════════════════════════════════════
// Event Binding
// ══════════════════════════════════════════════════════════════════════════════

function setCaptureModeButton(mode = 'region') {
  const selected = mode === 'window'
    ? elements.btnCaptureWindow
    : mode === 'fullscreen'
      ? elements.btnCaptureFullscreen
      : elements.btnCaptureRegion;
  [elements.btnCaptureRegion, elements.btnCaptureWindow, elements.btnCaptureFullscreen].forEach((btn) => {
    if (!btn) return;
    btn.classList.toggle('active', btn === selected);
  });
}

function bindToolbar() {
  on(elements.btnCaptureRegion, 'click', () => { setCaptureModeButton('region'); startCapture(); });
  on(elements.btnCaptureWindow, 'click', () => { setCaptureModeButton('window'); startCaptureWindow(); });
  on(elements.btnCaptureFullscreen, 'click', () => { setCaptureModeButton('fullscreen'); startCaptureFullscreen(); });
  on(elements.btnRecordScreen, 'click', onRecordButtonClick);
  on(elements.recordingFormatSetting, 'change', () => {
    state.recordingSettings.format = elements.recordingFormatSetting.value === 'gif' ? 'gif' : 'mp4';
    saveRecordingSettings();
  });
  on(elements.recordingAutozoomSetting, 'change', () => {
    state.recordingSettings.autoZoom = Boolean(elements.recordingAutozoomSetting.checked);
    saveRecordingSettings();
  });
  on(elements.hideDesktopIconsSetting, 'change', () => {
    state.captureSettings.hideDesktopIcons = Boolean(elements.hideDesktopIconsSetting.checked);
    saveRecordingSettings();
  });
  elements.recordingFormatMenu?.querySelectorAll('[data-format]').forEach((button) => {
    button.addEventListener('click', () => startRecordingWithFormat(button.dataset.format, button.dataset.mode));
  });
  document.addEventListener('click', (event) => {
    if (!elements.recordingFormatMenu?.classList.contains('visible')) return;
    if (elements.recordingFormatMenu.contains(event.target) || elements.btnRecordScreen?.contains(event.target)) return;
    hideRecordingFormatMenu();
  });
  
  on(elements.btnCopy, 'click', copyToClipboard);
  on(elements.btnCrop, 'click', toggleCrop);
  on(elements.btnUndo, 'click', undo);
  on(elements.btnRedo, 'click', redo);
  on(elements.btnClear, 'click', clearCanvas);

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


function bindTooltips() {
  const tooltip = elements.tooltip;
  if (!tooltip) return;

  const hide = () => {
    tooltip.classList.remove('visible');
    tooltip.setAttribute('aria-hidden', 'true');
  };

  const show = (event) => {
    const target = event.currentTarget;
    const text = target?.dataset?.tooltip;
    if (!text) return;
    tooltip.textContent = text;
    tooltip.classList.add('visible');
    tooltip.setAttribute('aria-hidden', 'false');

    const rect = target.getBoundingClientRect();
    const tooltipRect = tooltip.getBoundingClientRect();
    const x = Math.max(8, Math.min(window.innerWidth - tooltipRect.width - 8, rect.left + (rect.width - tooltipRect.width) / 2));
    const y = Math.max(8, rect.bottom + 10);
    tooltip.style.left = `${x}px`;
    tooltip.style.top = `${y}px`;
  };

  document.querySelectorAll('[data-tooltip]').forEach((node) => {
    node.addEventListener('mouseenter', show);
    node.addEventListener('mouseleave', hide);
    node.addEventListener('blur', hide);
  });
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

    // Crop mode keyboard shortcuts
    if (state.cropActive) {
      if (e.key === 'Enter') { e.preventDefault(); applyCrop(); return; }
      if (e.key === 'Escape') { e.preventDefault(); cancelCrop(); return; }
      return; // Block other shortcuts while cropping
    }
    
    if (cmdOrCtrl && e.shiftKey && e.key.toLowerCase() === 's') { e.preventDefault(); startCapture(); return; }
    if (cmdOrCtrl && e.key.toLowerCase() === 'o') { e.preventDefault(); openFile(); return; }
    if (cmdOrCtrl && e.key.toLowerCase() === 'e') { e.preventDefault(); saveFile(); return; }
    if (cmdOrCtrl && e.key.toLowerCase() === 'c' && state.image) { e.preventDefault(); copyToClipboard(); return; }
    if (cmdOrCtrl && e.key.toLowerCase() === 'v') { e.preventDefault(); pasteFromClipboard(); return; }
    if (cmdOrCtrl && e.shiftKey && e.key.toLowerCase() === 'z') { e.preventDefault(); redo(); return; }
    if (cmdOrCtrl && e.key.toLowerCase() === 'z') { e.preventDefault(); undo(); return; }
    if (e.key === 'Delete' || e.key === 'Backspace' || e.key === 'Del' || e.key === 'Suppr') {
      const selected = state.annotations[state.selectedAnnotationIndex];
      const canDelete = state.selectedAnnotationIndex >= 0 && (state.currentTool === 'select' || selected?.type === 'text');
      if (canDelete) {
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
      case 'w': applyWindowContainer(); break;
    }
  });
}

function bindIPC() {
  window.pico.onTriggerCapture(() => {
    console.log('[pico][renderer] received trigger-capture');
    startCapture();
  });
  window.pico.onTriggerCaptureMenu(() => {
    console.log('[pico][renderer] received trigger-capture-menu');
    setCaptureModeButton('region');
    showWindow();
    document.dispatchEvent(new CustomEvent('pico:show-capture-menu'));
  });
  window.pico.onTriggerCaptureWindow(() => startCaptureWindow());
  window.pico.onTriggerCaptureFullscreen(() => startCaptureFullscreen());
  window.pico.onShortcutCaptureReady(() => {
    setCaptureModeButton('region');
    showWindow();
  });
  window.pico.onOpenPreferences(() => openPreferences());
  window.pico.onLoadCapture((payload) => {
    const capturePayload = typeof payload === 'string' ? { dataUrl: payload } : payload;
    loadImage(capturePayload?.dataUrl, {
      showPreview: capturePayload?.source === 'capture',
      captureMode: capturePayload?.captureMode || 'region',
      autoSelectRect: capturePayload?.source === 'capture',
    });
  });
  window.pico.onLoadCaptureData((captureData) => loadCaptureData(captureData, { autoSelectRect: true }));
  window.pico.onRecordingStopRequested(() => {
    if (state.isRecording) toggleRecording();
  });
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

function bindPaste() {
  document.addEventListener('paste', async (e) => {
    if (state.isEditingText) return;
    
    const items = e.clipboardData?.items;
    if (!items) return;
    
    for (const item of items) {
      if (item.type.startsWith('image/')) {
        e.preventDefault();
        const blob = item.getAsFile();
        if (blob) {
          const reader = new FileReader();
          reader.onload = () => {
            loadImage(reader.result);
            showToast('Image pasted from clipboard', 'success');
          };
          reader.readAsDataURL(blob);
        }
        return;
      }
    }
  });
}

// ══════════════════════════════════════════════════════════════════════════════
// Crop Tool (Handle-based)
// ══════════════════════════════════════════════════════════════════════════════

function bindCrop() {
  // Handle dragging on crop handles and crop box
  const handles = elements.cropBox.querySelectorAll('.crop-handle');
  handles.forEach(handle => {
    handle.addEventListener('mousedown', (e) => {
      e.stopPropagation();
      e.preventDefault();
      state.cropDragging = handle.dataset.handle;
      state.cropDragStartX = e.clientX;
      state.cropDragStartY = e.clientY;
      state.cropOrigRect = { x: state.cropX, y: state.cropY, w: state.cropW, h: state.cropH };
    });
  });

  // Drag to move the entire crop box
  elements.cropBox.addEventListener('mousedown', (e) => {
    if (e.target.classList.contains('crop-handle')) return;
    e.preventDefault();
    state.cropDragging = 'move';
    state.cropDragStartX = e.clientX;
    state.cropDragStartY = e.clientY;
    state.cropOrigRect = { x: state.cropX, y: state.cropY, w: state.cropW, h: state.cropH };
  });

  // Double-click on crop box to apply
  elements.cropBox.addEventListener('dblclick', (e) => {
    e.preventDefault();
    applyCrop();
  });

  document.addEventListener('mousemove', onCropMouseMove);
  document.addEventListener('mouseup', onCropMouseUp);
}

function toggleCrop() {
  if (state.cropActive) {
    cancelCrop();
  } else {
    startCrop();
  }
}

function startCrop() {
  if (!state.image) return;
  state.cropActive = true;
  // Select the full image
  state.cropX = 0;
  state.cropY = 0;
  state.cropW = state.imageWidth;
  state.cropH = state.imageHeight;
  elements.cropOverlay.classList.add('active');
  elements.btnCrop.classList.add('active');
  updateCropUI();
}

function cancelCrop() {
  state.cropActive = false;
  state.cropDragging = null;
  elements.cropOverlay.classList.remove('active');
  elements.btnCrop.classList.remove('active');
}

function applyCrop() {
  if (!state.cropActive || !state.image) return;

  const x = Math.max(0, Math.round(state.cropX));
  const y = Math.max(0, Math.round(state.cropY));
  const w = Math.min(Math.round(state.cropW), state.imageWidth - x);
  const h = Math.min(Math.round(state.cropH), state.imageHeight - y);

  if (w < 5 || h < 5) {
    showToast('Crop area too small', 'error');
    cancelCrop();
    return;
  }

  // Composite image + annotations, then crop
  const compositeDataUrl = getCompositeImage();
  const compositeImg = new Image();
  compositeImg.onload = () => {
    const tempCanvas = document.createElement('canvas');
    tempCanvas.width = w;
    tempCanvas.height = h;
    const tempCtx = tempCanvas.getContext('2d');
    tempCtx.drawImage(compositeImg, x, y, w, h, 0, 0, w, h);
    
    const croppedDataUrl = tempCanvas.toDataURL('image/png');
    state.annotations = [];
    state.history = [];
    state.historyIndex = -1;
    state.selectedAnnotationIndex = -1;
    state.windowContainerApplied = false;
    state.originalImageBeforeContainer = null;
    cancelCrop();
    loadImage(croppedDataUrl);
    showToast('Image cropped', 'success');
  };
  compositeImg.src = compositeDataUrl;
}

function onCropMouseMove(e) {
  if (!state.cropDragging || !state.cropActive) return;

  const canvasRect = elements.canvas.getBoundingClientRect();
  const dx = e.clientX - state.cropDragStartX;
  const dy = e.clientY - state.cropDragStartY;
  
  // Convert pixel delta to image coordinate delta
  const scaleX = state.imageWidth / canvasRect.width;
  const scaleY = state.imageHeight / canvasRect.height;
  const imgDx = dx * scaleX;
  const imgDy = dy * scaleY;

  const orig = state.cropOrigRect;
  const minSize = 20;

  if (state.cropDragging === 'move') {
    state.cropX = Math.max(0, Math.min(state.imageWidth - orig.w, orig.x + imgDx));
    state.cropY = Math.max(0, Math.min(state.imageHeight - orig.h, orig.y + imgDy));
  } else {
    let nx = orig.x, ny = orig.y, nw = orig.w, nh = orig.h;

    if (state.cropDragging.includes('w')) {
      const newX = Math.max(0, Math.min(orig.x + orig.w - minSize, orig.x + imgDx));
      nw = orig.w + (orig.x - newX);
      nx = newX;
    }
    if (state.cropDragging.includes('e')) {
      nw = Math.max(minSize, Math.min(state.imageWidth - orig.x, orig.w + imgDx));
    }
    if (state.cropDragging.includes('n')) {
      const newY = Math.max(0, Math.min(orig.y + orig.h - minSize, orig.y + imgDy));
      nh = orig.h + (orig.y - newY);
      ny = newY;
    }
    if (state.cropDragging.includes('s')) {
      nh = Math.max(minSize, Math.min(state.imageHeight - orig.y, orig.h + imgDy));
    }

    state.cropX = nx;
    state.cropY = ny;
    state.cropW = nw;
    state.cropH = nh;
  }

  updateCropUI();
}

function onCropMouseUp() {
  state.cropDragging = null;
  state.cropOrigRect = null;
}

function updateCropUI() {
  if (!state.cropActive) return;

  const canvasRect = elements.canvas.getBoundingClientRect();
  const containerRect = elements.container.getBoundingClientRect();
  
  // Convert image coords to screen coords
  const scaleX = canvasRect.width / state.imageWidth;
  const scaleY = canvasRect.height / state.imageHeight;
  
  const left = canvasRect.left - containerRect.left + state.cropX * scaleX;
  const top = canvasRect.top - containerRect.top + state.cropY * scaleY;
  const width = state.cropW * scaleX;
  const height = state.cropH * scaleY;

  elements.cropBox.style.left = left + 'px';
  elements.cropBox.style.top = top + 'px';
  elements.cropBox.style.width = width + 'px';
  elements.cropBox.style.height = height + 'px';

  // Position hint below the crop box
  if (elements.cropHint) {
    elements.cropHint.style.left = (left + width / 2) + 'px';
    elements.cropHint.style.top = (top + height + 12) + 'px';
  }

  // Update mask (dark area outside crop)
  const mask = document.getElementById('crop-mask');
  mask.style.clipPath = `polygon(
    0% 0%, 100% 0%, 100% 100%, 0% 100%, 0% 0%,
    ${left}px ${top}px, ${left}px ${top + height}px, ${left + width}px ${top + height}px, ${left + width}px ${top}px, ${left}px ${top}px
  )`;
}

// ══════════════════════════════════════════════════════════════════════════════
// File Operations
// ══════════════════════════════════════════════════════════════════════════════


function showRecordingFormatMenu() {
  elements.recordingFormatMenu?.classList.add('visible');
}

function hideRecordingFormatMenu() {
  elements.recordingFormatMenu?.classList.remove('visible');
}

function setRecordingSaveProgress(visible) {
  state.isSavingRecording = Boolean(visible);
  elements.recordingSaveProgress?.classList.toggle('visible', state.isSavingRecording);
  elements.recordingSaveProgress?.setAttribute('aria-hidden', state.isSavingRecording ? 'false' : 'true');
}

function onRecordButtonClick(event) {
  if (state.isRecording) {
    toggleRecording(event);
    return;
  }
  event?.stopPropagation();
  startRecordingWithFormat(state.recordingSettings.format, 'region');
}

async function startRecordingWithFormat(format = 'mp4', mode = 'region') {
  hideRecordingFormatMenu();
  try {
    const started = await window.pico.startRecording({ format, mode, autoZoom: mode === 'region' ? state.recordingSettings.autoZoom : false });
    state.isRecording = true;
    state.recordingFormat = format;
    state.recordingMode = mode;
    setRecordingIndicator(true);
    const targetLabel = mode === 'region' ? 'selected region with autozoom' : (started.source?.name || 'window');
    showToast(started.systemAudio ? `Recording ${targetLabel} as ${format.toUpperCase()}` : `Recording ${targetLabel} as ${format.toUpperCase()} without system audio`, started.systemAudio ? 'success' : 'info');
  } catch (err) {
    state.isRecording = false;
    setRecordingSaveProgress(false);
    setRecordingIndicator(false);
    if (err.message === 'Recording canceled') {
      showToast('Recording canceled', 'info');
      return;
    }
    showToast(`Recording failed: ${err.message}`, 'error');
  }
}

function loadRecordingSettings() {
  try {
    const raw = localStorage.getItem('pico-recording-settings');
    if (raw) {
      const parsed = JSON.parse(raw);
      state.recordingSettings.format = parsed?.format === 'gif' ? 'gif' : 'mp4';
      state.recordingSettings.autoZoom = parsed?.autoZoom !== false;
      state.captureSettings.hideDesktopIcons = parsed?.hideDesktopIcons !== false;
    }
  } catch (_) {}
  if (elements.recordingFormatSetting) elements.recordingFormatSetting.value = state.recordingSettings.format;
  if (elements.recordingAutozoomSetting) elements.recordingAutozoomSetting.checked = state.recordingSettings.autoZoom;
  if (elements.hideDesktopIconsSetting) elements.hideDesktopIconsSetting.checked = state.captureSettings.hideDesktopIcons;
}

function saveRecordingSettings() {
  localStorage.setItem('pico-recording-settings', JSON.stringify({
    ...state.recordingSettings,
    hideDesktopIcons: state.captureSettings.hideDesktopIcons,
  }));
}


function openPreferences() {
  if (!elements.preferencesDialog) return;
  elements.preferencesDialog.showModal();
}

function showWindow() {
  window.focus();
}

async function toggleRecording(event) {
  try {
    if (!state.isRecording) {
      showRecordingFormatMenu();
      return;
    }

    setRecordingSaveProgress(true);
    showToast('Finalizing recording…', 'info');
    const result = await window.pico.stopRecording({ format: state.recordingFormat || (event?.shiftKey ? 'gif' : 'mp4') });
    state.isRecording = false;
    setRecordingIndicator(false);
    if (result.canceled) {
      showToast('Recording discarded', 'info');
      return;
    }
    const savedPath = result.gif || result.mp4 || result.webm;
    const warning = result.warning ? ` (${result.warning})` : '';
    showToast(`Saved recording: ${savedPath}${warning}`, result.warning ? 'info' : 'success');
  } catch (err) {
    state.isRecording = false;
    setRecordingIndicator(false);
    showToast(`Recording failed: ${err.message}`, 'error');
  } finally {
    setRecordingSaveProgress(false);
  }
}

async function startCapture() {
  if (state.cropActive) cancelCrop();
  const result = await window.pico.startCapture({ hideDesktopIcons: state.captureSettings.hideDesktopIcons });
  if (!result.success) showToast(result.error || 'Failed to start capture', 'error');
}

async function startCaptureWindow() {
  if (state.cropActive) cancelCrop();
  const result = await window.pico.startCaptureWindow({ hideDesktopIcons: state.captureSettings.hideDesktopIcons });
  if (!result.success) showToast(result.error || 'Failed to capture window', 'error');
}

async function startCaptureFullscreen() {
  if (state.cropActive) cancelCrop();
  state.pendingFullscreenPreview = true;
  const result = await window.pico.startCaptureFullscreen({ hideDesktopIcons: state.captureSettings.hideDesktopIcons });
  if (!result.success) {
    state.pendingFullscreenPreview = false;
    showToast(result.error || 'Failed to capture screen', 'error');
  }
}

async function openFile() {
  if (state.cropActive) cancelCrop();
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

async function pasteFromClipboard() {
  try {
    const dataUrl = await window.pico.readClipboardImage();
    if (dataUrl) {
      if (state.cropActive) cancelCrop();
      loadImage(dataUrl);
      showToast('Image pasted from clipboard', 'success');
    } else {
      showToast('No image in clipboard', 'info');
    }
  } catch (err) {
    showToast('Failed to paste from clipboard', 'error');
  }
}

function clearCanvas() {
  if (!state.image) return;
  if (state.cropActive) cancelCrop();
  state.image = null;
  state.imageWidth = 0;
  state.imageHeight = 0;
  state.annotations = [];
  state.history = [];
  state.historyIndex = -1;
  state.selectedAnnotationIndex = -1;
  state.windowContainerApplied = false;
  state.originalImageBeforeContainer = null;
  elements.canvas.classList.remove('visible');
  elements.emptyState.classList.remove('hidden');
  elements.ctx.clearRect(0, 0, elements.canvas.width, elements.canvas.height);
  updateStatus();
  updateToolbarState();
  showToast('Canvas cleared', 'success');
}

// ══════════════════════════════════════════════════════════════════════════════
// Image Loading
// ══════════════════════════════════════════════════════════════════════════════

async function loadCaptureData(captureData, options = {}) {
  if (captureData.type === 'single') {
    loadImage(captureData.dataUrl, options);
    return;
  }
  // Sort screens left-to-right and align at the top edge. Use each display's
  // actual bitmap size so fullscreen capture stays sharp on Retina/HiDPI Macs
  // instead of being downscaled to logical display bounds.
  const sorted = [...captureData.screens].sort((a, b) => a.bounds.x - b.bounds.x);
  const images = await Promise.all(sorted.map((screen) => new Promise((resolve) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.src = screen.dataUrl;
  })));
  const pixelWidthFor = (screen, image) => screen.pixelSize?.width || image.naturalWidth || image.width || screen.bounds.width;
  const pixelHeightFor = (screen, image) => screen.pixelSize?.height || image.naturalHeight || image.height || screen.bounds.height;
  const totalWidth = sorted.reduce((sum, screen, index) => sum + pixelWidthFor(screen, images[index]), 0);
  const maxHeight = Math.max(...sorted.map((screen, index) => pixelHeightFor(screen, images[index])));
  const canvas = document.createElement('canvas');
  canvas.width = totalWidth;
  canvas.height = maxHeight;
  const ctx = canvas.getContext('2d');
  let offsetX = 0;
  sorted.forEach((screen, index) => {
    const image = images[index];
    const width = pixelWidthFor(screen, image);
    const height = pixelHeightFor(screen, image);
    ctx.drawImage(image, offsetX, 0, width, height);
    offsetX += width;
  });
  loadImage(canvas.toDataURL('image/png'), options);
}

function loadImage(dataUrl, options = {}) {
  const img = new Image();
  img.onload = () => {
    state.image = img;
    state.imageWidth = img.width;
    state.imageHeight = img.height;
    if (!state.windowContainerApplied) state.originalImageBeforeContainer = null;
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
  if (state.cropActive) updateCropUI();
}

function applyZoom() {
  elements.canvas.style.width = (state.imageWidth * state.zoom) + 'px';
  elements.canvas.style.height = (state.imageHeight * state.zoom) + 'px';
}

function fitToWindow() {
  if (!state.image) return;
  const container = elements.container;
  const padding = 40;
  const availW = container.clientWidth - padding * 2;
  const availH = container.clientHeight - padding * 2;
  // If container hasn't laid out yet, retry on next frame
  if (availW <= 0 || availH <= 0) {
    requestAnimationFrame(() => fitToWindow());
    return;
  }
  const scaleX = availW / state.imageWidth;
  const scaleY = availH / state.imageHeight;
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
  if (state.cropActive) cancelCrop();
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

  if (state.currentTool === 'select' && state.selectedAnnotationIndex >= 0) {
    const selected = state.annotations[state.selectedAnnotationIndex];
    if (selected) {
      selected.color = color;
      state.history = state.history.slice(0, state.historyIndex + 1);
      state.history.push([...state.annotations.map(a => ({ ...a }))]);
      state.historyIndex = state.history.length - 1;
      render();
      updateToolbarState();
    }
  }
}

function selectStrokeWidth(width) {
  state.strokeWidth = width;
  elements.strokeBtns.forEach(btn => btn.classList.toggle('active', parseInt(btn.dataset.width) === width));
}

function selectTextFontSize(size) {
  if (!Number.isFinite(size) || size <= 0) return;
  state.textFontSize = size;
  if (state.currentTool === 'select' && state.selectedAnnotationIndex >= 0) {
    const selected = state.annotations[state.selectedAnnotationIndex];
    if (selected?.type === 'text') {
      selected.fontSize = size;
      state.history = state.history.slice(0, state.historyIndex + 1);
      state.history.push([...state.annotations.map(a => ({ ...a }))]);
      state.historyIndex = state.history.length - 1;
      render();
      updateToolbarState();
    }
  }
  if (state.isEditingText) {
    elements.textInput.style.fontSize = Math.round(size * state.zoom) + 'px';
    autoResizeTextInput();
  }
}

function selectTextFontFamily(family) {
  state.textFontFamily = family;
  if (state.currentTool === 'select' && state.selectedAnnotationIndex >= 0) {
    const selected = state.annotations[state.selectedAnnotationIndex];
    if (selected?.type === 'text') {
      selected.fontFamily = family;
      state.history = state.history.slice(0, state.historyIndex + 1);
      state.history.push([...state.annotations.map(a => ({ ...a }))]);
      state.historyIndex = state.history.length - 1;
      render();
      updateToolbarState();
    }
  }
  if (state.isEditingText) elements.textInput.style.fontFamily = family;
}

function getTextBounds(annotation) {
  const ctx = elements.ctx;
  const fontSize = annotation.fontSize || 24;
  const fontFamily = annotation.fontFamily || '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
  const lines = annotation.text.split('\n');
  const lineHeight = fontSize * 1.2;
  ctx.save();
  ctx.font = `bold ${fontSize}px ${fontFamily}`;
  const maxWidth = Math.max(...lines.map((line) => ctx.measureText(line).width), 0);
  ctx.restore();
  return {
    x: annotation.x,
    y: annotation.y - lineHeight,
    width: Math.max(1, maxWidth),
    height: Math.max(1, lineHeight * Math.max(lines.length, 1)),
    lineHeight,
  };
}

function toggleTextStyleControls() {
  const selected = state.annotations[state.selectedAnnotationIndex];
  const visible = state.currentTool === 'text' || (state.currentTool === 'select' && selected?.type === 'text');
  elements.textStyleGroup?.classList.toggle('text-style-hidden', !visible);
  elements.textStyleSeparator?.classList.toggle('text-style-hidden', !visible);

  if (visible && selected?.type === 'text') {
    if (elements.textFontFamily) elements.textFontFamily.value = selected.fontFamily || state.textFontFamily;
    if (elements.textFontSize) elements.textFontSize.value = String(selected.fontSize || state.textFontSize);
  }
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

function findTextAnnotationAt(coords) {
  for (let i = state.annotations.length - 1; i >= 0; i--) {
    const ann = state.annotations[i];
    if (ann.type !== 'text') continue;
    const bounds = getTextBounds(ann);
    if (coords.x >= bounds.x - 5 && coords.x <= bounds.x + bounds.width + 5 &&
        coords.y >= bounds.y && coords.y <= bounds.y + bounds.height) {
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
  if (!state.image || state.cropActive) return;
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
      state.selectedAnnotationIndex = textIdx;
      state.isDraggingText = true;
      state.dragTextIndex = textIdx;
      state.dragOffsetX = coords.x - state.annotations[textIdx].x;
      state.dragOffsetY = coords.y - state.annotations[textIdx].y;
      elements.canvas.style.cursor = 'grabbing';
      render();
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
  if (!state.image || state.cropActive) return;
  
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
  if (state.cropActive) cancelCrop();
  if (state.historyIndex < 0) return;
  state.historyIndex--;
  state.annotations = state.historyIndex >= 0 ? [...state.history[state.historyIndex].map(a => ({...a}))] : [];
  if (state.selectedAnnotationIndex >= state.annotations.length) state.selectedAnnotationIndex = -1;
  render(); updateStatus(); updateToolbarState();
}

function redo() {
  if (state.cropActive) cancelCrop();
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
  if (annotation.type === 'text') {
    const bounds = getTextBounds(annotation);
    return { ...bounds, type: 'box' };
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
  const bounds = ann.type === 'text' ? getTextBounds(ann) : { x: ann.x, y: ann.y, width: ann.width, height: ann.height };
  const x1 = bounds.x, y1 = bounds.y, x2 = bounds.x + bounds.width, y2 = bounds.y + bounds.height;
  let nx1 = x1, ny1 = y1, nx2 = x2, ny2 = y2;
  if (state.resizeHandle.kind.includes('n')) ny1 = coords.y;
  if (state.resizeHandle.kind.includes('s')) ny2 = coords.y;
  if (state.resizeHandle.kind.includes('w')) nx1 = coords.x;
  if (state.resizeHandle.kind.includes('e')) nx2 = coords.x;
  ann.x = Math.min(nx1, nx2);
  ann.y = Math.min(ny1, ny2);
  ann.width = Math.max(1, Math.abs(nx2 - nx1));
  ann.height = Math.max(1, Math.abs(ny2 - ny1));

  if (ann.type === 'text') {
    const currentBounds = getTextBounds(ann);
    const scaleY = ann.height / Math.max(1, currentBounds.height);
    ann.fontSize = Math.max(8, Math.round((ann.fontSize || 24) * scaleY));
    ann.x = Math.min(nx1, nx2);
    ann.y = Math.min(ny1, ny2) + (ann.fontSize * 1.2);
    delete ann.width;
    delete ann.height;
  }
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
  elements.statusTool.textContent = state.cropActive ? 'Crop' : (names[state.currentTool] || state.currentTool);
  elements.statusZoom.textContent = `${Math.round(state.zoom * 100)}%`;
}

function setRecordingIndicator(isRecording) {
  elements.btnRecordScreen?.classList.toggle('recording', isRecording);
  if (elements.btnRecordScreen) {
    elements.btnRecordScreen.title = isRecording ? 'Stop recording and choose save location' : 'Record screen video';
    elements.btnRecordScreen.setAttribute('aria-pressed', String(isRecording));
  }
}

function updateToolbarState() {
  elements.btnCopy.disabled = !state.image;
  elements.btnCrop.disabled = !state.image;
  elements.btnUndo.disabled = state.historyIndex < 0;
  elements.btnRedo.disabled = state.historyIndex >= state.history.length - 1;
  elements.btnClear.disabled = !state.image;
  setRecordingIndicator(state.isRecording);
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


// ══════════════════════════════════════════════════════════════════════════════
// Window Container (macOS-style chrome) — Toggle on/off
// ══════════════════════════════════════════════════════════════════════════════

function applyWindowContainer() {
  if (!state.image) return;

  if (state.windowContainerApplied && state.originalImageBeforeContainer) {
    state.windowContainerApplied = false;
    state.annotations = [];
    state.history = [];
    state.historyIndex = -1;
    state.selectedAnnotationIndex = -1;
    const btn = document.getElementById('btn-window-container');
    if (btn) btn.classList.remove('active');
    loadImage(state.originalImageBeforeContainer);
    showToast('Window container removed', 'success');
    return;
  }

  const titleBarHeight = 48;
  const cornerRadius = 12;
  const padding = 40;
  const shadowBlur = 30;
  const shadowColor = 'rgba(0, 0, 0, 0.5)';
  const titleBarColor = '#2a2a2e';
  const windowBgColor = '#1c1c1e';

  const gradients = {
    none: null,
    sunset: ['#f97316', '#ec4899'],
    ocean: ['#06b6d4', '#3b82f6'],
    forest: ['#22c55e', '#14b8a6'],
    purple: ['#8b5cf6', '#ec4899'],
    midnight: ['#1e1b4b', '#312e81'],
    warm: ['#fbbf24', '#f97316'],
  };

  const lights = [
    { color: '#ff5f57', x: 20 },
    { color: '#febc2e', x: 40 },
    { color: '#28c840', x: 60 },
  ];
  const lightRadius = 6;

  const compositeDataUrl = getCompositeImage();
  state.originalImageBeforeContainer = compositeDataUrl;

  const compositeImg = new Image();
  compositeImg.onload = () => {
    const imgW = compositeImg.width;
    const imgH = compositeImg.height;

    const windowW = imgW;
    const windowH = imgH + titleBarHeight;
    const canvasW = windowW + padding * 2;
    const canvasH = windowH + padding * 2;

    const tempCanvas = document.createElement('canvas');
    tempCanvas.width = canvasW;
    tempCanvas.height = canvasH;
    const ctx = tempCanvas.getContext('2d');

    const gradientColors = gradients[state.containerGradient || 'none'];
    if (gradientColors) {
      const grad = ctx.createLinearGradient(0, 0, canvasW, canvasH);
      grad.addColorStop(0, gradientColors[0]);
      grad.addColorStop(1, gradientColors[1]);
      ctx.fillStyle = grad;
    } else {
      ctx.fillStyle = '#09090b';
    }
    ctx.fillRect(0, 0, canvasW, canvasH);

    ctx.save();
    ctx.shadowColor = shadowColor;
    ctx.shadowBlur = shadowBlur;
    ctx.shadowOffsetX = 0;
    ctx.shadowOffsetY = 8;
    ctx.beginPath();
    roundRect(ctx, padding, padding, windowW, windowH, cornerRadius);
    ctx.fillStyle = windowBgColor;
    ctx.fill();
    ctx.restore();

    ctx.save();
    ctx.beginPath();
    roundRect(ctx, padding, padding, windowW, windowH, cornerRadius);
    ctx.clip();

    ctx.fillStyle = titleBarColor;
    ctx.fillRect(padding, padding, windowW, titleBarHeight);

    ctx.strokeStyle = 'rgba(255, 255, 255, 0.06)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(padding, padding + titleBarHeight);
    ctx.lineTo(padding + windowW, padding + titleBarHeight);
    ctx.stroke();

    const lightY = padding + titleBarHeight / 2;
    lights.forEach(light => {
      ctx.beginPath();
      ctx.arc(padding + light.x, lightY, lightRadius, 0, Math.PI * 2);
      ctx.fillStyle = light.color;
      ctx.fill();
    });

    ctx.drawImage(compositeImg, padding, padding + titleBarHeight, imgW, imgH);
    ctx.restore();

    const resultDataUrl = tempCanvas.toDataURL('image/png');
    state.annotations = [];
    state.history = [];
    state.historyIndex = -1;
    state.selectedAnnotationIndex = -1;
    state.windowContainerApplied = true;
    const btn = document.getElementById('btn-window-container');
    if (btn) btn.classList.add('active');
    loadImage(resultDataUrl);
    showToast('Window container applied', 'success');
  };
  compositeImg.src = compositeDataUrl;
}

function roundRect(ctx, x, y, width, height, radius) {
  ctx.moveTo(x + radius, y);
  ctx.lineTo(x + width - radius, y);
  ctx.arcTo(x + width, y, x + width, y + radius, radius);
  ctx.lineTo(x + width, y + height - radius);
  ctx.arcTo(x + width, y + height, x + width - radius, y + height, radius);
  ctx.lineTo(x + radius, y + height);
  ctx.arcTo(x, y + height, x, y + height - radius, radius);
  ctx.lineTo(x, y + radius);
  ctx.arcTo(x, y, x + radius, y, radius);
  ctx.closePath();
}


function bindContextMenu() {
  const menu = document.getElementById('context-menu');
  const ctxContainer = document.getElementById('ctx-window-container');
  const ctxSavePng = document.getElementById('ctx-save-png');
  const ctxCopy = document.getElementById('ctx-copy');
  const gradientSwatches = document.querySelectorAll('.gradient-swatch');

  elements.container.addEventListener('contextmenu', (e) => {
    if (!state.image || state.cropActive) return;
    e.preventDefault();

    menu.style.left = e.clientX + 'px';
    menu.style.top = e.clientY + 'px';
    menu.classList.add('visible');

    ctxContainer.classList.toggle('active', state.windowContainerApplied);

    gradientSwatches.forEach(s => {
      s.classList.toggle('active', s.dataset.gradient === (state.containerGradient || 'none'));
    });

    requestAnimationFrame(() => {
      const rect = menu.getBoundingClientRect();
      if (rect.right > window.innerWidth) {
        menu.style.left = (window.innerWidth - rect.width - 8) + 'px';
      }
      if (rect.bottom > window.innerHeight) {
        menu.style.top = (window.innerHeight - rect.height - 8) + 'px';
      }
    });
  });

  document.addEventListener('mousedown', (e) => {
    if (!menu.contains(e.target)) {
      menu.classList.remove('visible');
    }
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') menu.classList.remove('visible');
  });

  ctxContainer.addEventListener('click', () => {
    menu.classList.remove('visible');
    applyWindowContainer();
  });

  ctxCopy.addEventListener('click', () => {
    menu.classList.remove('visible');
    copyToClipboard();
  });

  ctxSavePng.addEventListener('click', () => {
    menu.classList.remove('visible');
    saveFile();
  });

  gradientSwatches.forEach(swatch => {
    swatch.addEventListener('click', () => {
      const gradient = swatch.dataset.gradient;
      state.containerGradient = gradient;
      gradientSwatches.forEach(s => s.classList.remove('active'));
      swatch.classList.add('active');

      if (state.windowContainerApplied && state.originalImageBeforeContainer) {
        state.windowContainerApplied = false;
        const originalImg = state.originalImageBeforeContainer;
        const tempImg = new Image();
        tempImg.onload = () => {
          state.image = tempImg;
          state.imageWidth = tempImg.width;
          state.imageHeight = tempImg.height;
          state.annotations = [];
          state.history = [];
          state.historyIndex = -1;
          state.originalImageBeforeContainer = originalImg;
          applyWindowContainer();
        };
        tempImg.src = originalImg;
      }
      menu.classList.remove('visible');
    });
  });
}

document.addEventListener('DOMContentLoaded', init);
