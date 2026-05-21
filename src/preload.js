/**
 * pico - Preload Script
 * Secure bridge between main and renderer processes
 */

const { contextBridge, ipcRenderer } = require('electron');

let proRecorder = null;
let proRecordingStream = null;
let proRecordingChunks = [];
let proRecordingFormat = 'mp4';
let proRecordingRawStream = null;
let proRecordingZoomStop = null;

function getRecordingMimeType() {
  const preferred = 'video/webm;codecs=vp9';
  if (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(preferred)) return preferred;
  const fallback = 'video/webm;codecs=vp8';
  if (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(fallback)) return fallback;
  return 'video/webm';
}

function attachRecordingPreviewStream(previewVideoId, stream) {
  if (!previewVideoId || !stream) return;
  const video = document.getElementById(previewVideoId);
  if (!video) return;
  video.pause();
  video.removeAttribute('src');
  video.srcObject = stream;
  video.muted = true;
  video.playsInline = true;
  video.play().catch(() => {});
}

async function getCursorScreenPoint() {
  return ipcRenderer.invoke('get-cursor-screen-point');
}

async function getDesktopStream(sourceId, includeAudio) {
  const video = {
    mandatory: {
      chromeMediaSource: 'desktop',
      chromeMediaSourceId: sourceId,
    },
  };
  const audio = includeAudio ? {
    mandatory: {
      chromeMediaSource: 'desktop',
    },
  } : false;

  return navigator.mediaDevices.getUserMedia({ audio, video });
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function createAutoZoomStream(sourceStream, region, options = {}) {
  const video = document.createElement('video');
  video.muted = true;
  video.srcObject = sourceStream;
  video.playsInline = true;

  const canvas = document.createElement('canvas');
  const evenDimension = (value) => {
    const rounded = Math.max(2, Math.round(value || 2));
    return rounded % 2 === 0 ? rounded : rounded - 1;
  };
  const scaleFactor = region.scaleFactor || 1;
  const pixelWidth = region.pixelWidth || Math.round(region.width * scaleFactor);
  const pixelHeight = region.pixelHeight || Math.round(region.height * scaleFactor);
  canvas.width = evenDimension(pixelWidth);
  canvas.height = evenDimension(pixelHeight);
  const ctx = canvas.getContext('2d', { alpha: false });

  const srcRegion = {
    x: region.pixelX ?? Math.round(region.x * scaleFactor),
    y: region.pixelY ?? Math.round(region.y * scaleFactor),
    width: canvas.width,
    height: canvas.height,
  };

  const displayBounds = region.displayBounds || { x: 0, y: 0, width: region.width, height: region.height };
  const pixelScaleX = region.width > 0 ? srcRegion.width / region.width : scaleFactor;
  const pixelScaleY = region.height > 0 ? srcRegion.height / region.height : scaleFactor;
  const fps = 60;
  const enableAutoZoom = options.autoZoom !== false;

  const ZOOM_MIN = 1;
  const ZOOM_MAX = clamp(1.7 + ((srcRegion.width - 1920) / 7680), 1.55, 2.0);
  const zoomFocus = clamp(1.45 + ((srcRegion.width - 1280) / 5120), 1.35, ZOOM_MAX);
  const regionCenterX = srcRegion.x + srcRegion.width / 2;
  const regionCenterY = srcRegion.y + srcRegion.height / 2;

  // Viewport budgeting / safe-zone and edge breathing room.
  const uiInsets = {
    left: clamp(Number(options.uiInsetLeft ?? 0), 0, 0.3),
    right: clamp(Number(options.uiInsetRight ?? 0), 0, 0.3),
    top: clamp(Number(options.uiInsetTop ?? 0), 0, 0.3),
    bottom: clamp(Number(options.uiInsetBottom ?? 0), 0, 0.3),
  };
  const proportionalPadding = clamp(Number(options.paddingRatio ?? 0.14), 0.1, 0.2);

  const IDLE_ZOOM_IN_DELAY_MS = 550;
  const IDLE_ZOOM_OUT_DELAY_MS = 1900;

  let camera = { x: regionCenterX, y: regionCenterY, zoom: 1 };
  let targetCamera = { x: regionCenterX, y: regionCenterY, zoom: 1 };
  let cursor = { x: regionCenterX, y: regionCenterY };
  let anchor = { x: regionCenterX, y: regionCenterY };

  let lastMoveTime = performance.now();
  let lastFrameTime = performance.now();
  let rafId = null;
  let pollTimer = null;
  let stopped = false;
  let cursorPollInFlight = false;

  function logDuration(distancePx, minMs = 120, maxMs = 620, k = 90) {
    const d = Math.max(0, distancePx);
    return clamp(minMs + k * Math.log1p(d), minMs, maxMs);
  }

  async function pollCursor() {
    if (stopped || cursorPollInFlight) return;
    cursorPollInFlight = true;
    try {
      const pt = await getCursorScreenPoint();
      const relLogicalX = pt.x - displayBounds.x - region.x;
      const relLogicalY = pt.y - displayBounds.y - region.y;
      const px = srcRegion.x + relLogicalX * pixelScaleX;
      const py = srcRegion.y + relLogicalY * pixelScaleY;

      const moved = Math.hypot(px - cursor.x, py - cursor.y);
      if (moved > 6 * scaleFactor) {
        lastMoveTime = performance.now();
        anchor.x = px;
        anchor.y = py;
      }

      cursor.x = clamp(px, srcRegion.x, srcRegion.x + srcRegion.width);
      cursor.y = clamp(py, srcRegion.y, srcRegion.y + srcRegion.height);
    } catch (e) {
      // ignore transient cursor polling failures
    } finally {
      cursorPollInFlight = false;
    }
  }

  function updateTargets(now) {
    const idleMs = now - lastMoveTime;
    if (idleMs > IDLE_ZOOM_OUT_DELAY_MS) {
      targetCamera.zoom = ZOOM_MIN;
      targetCamera.x = regionCenterX;
      targetCamera.y = regionCenterY;
      return;
    }

    if (idleMs > IDLE_ZOOM_IN_DELAY_MS) {
      targetCamera.zoom = zoomFocus;
      targetCamera.x = anchor.x;
      targetCamera.y = anchor.y;
      return;
    }

    targetCamera.zoom = 1.08;
    targetCamera.x = cursor.x;
    targetCamera.y = cursor.y;
  }

  function stepCamera(dtSec) {
    const dist = Math.hypot(targetCamera.x - camera.x, targetCamera.y - camera.y);
    const panDurationMs = logDuration(dist, 90, 520, 84);
    const zoomDurationMs = logDuration(Math.abs(targetCamera.zoom - camera.zoom) * srcRegion.width, 110, 540, 75);
    const panAlpha = 1 - Math.exp(-dtSec / Math.max(0.001, panDurationMs / 1000));
    const zoomAlpha = 1 - Math.exp(-dtSec / Math.max(0.001, zoomDurationMs / 1000));

    camera.x += (targetCamera.x - camera.x) * panAlpha;
    camera.y += (targetCamera.y - camera.y) * panAlpha;
    camera.zoom += (targetCamera.zoom - camera.zoom) * zoomAlpha;
    camera.zoom = clamp(camera.zoom, ZOOM_MIN, ZOOM_MAX);
  }

  function draw(now = performance.now()) {
    if (stopped) return;

    const dt = Math.min(0.1, (now - lastFrameTime) / 1000);
    lastFrameTime = now;

    if (enableAutoZoom) {
      updateTargets(now);
      stepCamera(dt);
    } else {
      camera = { x: regionCenterX, y: regionCenterY, zoom: 1 };
      targetCamera = { ...camera };
    }

    const cropW = srcRegion.width / camera.zoom;
    const cropH = srcRegion.height / camera.zoom;
    const paddingX = cropW * proportionalPadding;
    const paddingY = cropH * proportionalPadding;

    const safeCenterX = regionCenterX + cropW * ((uiInsets.left - uiInsets.right) * 0.5);
    const safeCenterY = regionCenterY + cropH * ((uiInsets.top - uiInsets.bottom) * 0.5);

    const minCenterX = srcRegion.x + cropW / 2 + paddingX;
    const maxCenterX = srcRegion.x + srcRegion.width - cropW / 2 - paddingX;
    const minCenterY = srcRegion.y + cropH / 2 + paddingY;
    const maxCenterY = srcRegion.y + srcRegion.height - cropH / 2 - paddingY;

    const centerX = clamp(camera.x + (safeCenterX - regionCenterX), minCenterX, maxCenterX);
    const centerY = clamp(camera.y + (safeCenterY - regionCenterY), minCenterY, maxCenterY);

    const sx = centerX - cropW / 2;
    const sy = centerY - cropH / 2;

    ctx.fillStyle = '#09090b';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(video, sx, sy, cropW, cropH, 0, 0, canvas.width, canvas.height);
    }

    rafId = requestAnimationFrame(draw);
  }

  const canvasStream = canvas.captureStream(fps);
  sourceStream.getAudioTracks().forEach((track) => canvasStream.addTrack(track));

  const stop = () => {
    stopped = true;
    if (pollTimer) clearInterval(pollTimer);
    if (rafId) cancelAnimationFrame(rafId);
  };

  const ready = video.play().then(() => {
    lastFrameTime = performance.now();
    if (enableAutoZoom) pollTimer = setInterval(pollCursor, 33);
    draw();
    return canvasStream;
  });

  return { stream: canvasStream, ready, stop };
}

function getDisplayBounds(candidate = {}) {
  return candidate.bounds || candidate.displayBounds || null;
}

function deriveFullscreenRegionFromSource(source = {}, displays = []) {
  const sourceDisplayId = source.displayId ?? source.display_id ?? source.display?.id;
  const sourceDisplay = source.display || source.screen || null;
  const matchedDisplay = sourceDisplay || displays.find((display) => {
    if (sourceDisplayId === undefined || sourceDisplayId === null) return false;
    return String(display.id) === String(sourceDisplayId);
  }) || (displays.length === 1 ? displays[0] : null);
  const bounds = getDisplayBounds(source) || getDisplayBounds(matchedDisplay) || source.region?.displayBounds || null;
  if (!bounds) return null;

  const scaleFactor = source.scaleFactor || matchedDisplay?.scaleFactor || source.region?.scaleFactor || 1;
  const pixelSize = source.pixelSize || source.nativeSize || matchedDisplay?.pixelSize || {};
  const pixelWidth = source.pixelWidth || pixelSize.width || Math.round(bounds.width * scaleFactor);
  const pixelHeight = source.pixelHeight || pixelSize.height || Math.round(bounds.height * scaleFactor);

  return {
    x: 0,
    y: 0,
    width: bounds.width,
    height: bounds.height,
    displayBounds: bounds,
    scaleFactor,
    pixelX: 0,
    pixelY: 0,
    pixelWidth,
    pixelHeight,
  };
}

async function getAutoZoomRegion(source = {}, requestedMode = source.mode) {
  const sourceMode = requestedMode || source.mode;
  if (sourceMode === 'region' && source.region) return source.region;
  if (sourceMode !== 'fullscreen') return null;

  let sourceRegion = deriveFullscreenRegionFromSource(source);
  if (!sourceRegion) {
    try {
      const displays = await ipcRenderer.invoke('get-displays');
      sourceRegion = deriveFullscreenRegionFromSource(source, Array.isArray(displays) ? displays : []);
    } catch (error) {
      sourceRegion = null;
    }
  }

  const autoZoomRegion = sourceRegion;
  console.log('[pico] autoZoomRegion', sourceMode, JSON.stringify(autoZoomRegion));
  if (sourceRegion) return sourceRegion;

  console.warn('[pico] autoZoom: could not derive fullscreen region from source', JSON.stringify(source));
  return null;
}

async function startRecording(options = {}) {
  if (proRecorder && proRecorder.state !== 'inactive') {
    throw new Error('A screen recording is already in progress');
  }

  proRecordingFormat = options?.format === 'gif' ? 'gif' : 'mp4';
  const mode = options?.mode === 'region' ? 'region' : options?.mode === 'fullscreen' ? 'fullscreen' : 'window';
  const source = await ipcRenderer.invoke('pro-recording-source', {
    mode,
    autoZoom: options?.autoZoom !== false,
    hideDesktopIcons: options?.hideDesktopIcons !== false,
    inlinePreview: Boolean(options?.previewVideoId),
  });
  if (!source) throw new Error('Recording canceled');
  let systemAudio = true;
  let rawStream = null;
  try {
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error('Screen recording is unavailable because media capture APIs are not available.');
    }
    if (typeof MediaRecorder === 'undefined') {
      throw new Error('Screen recording is unavailable because MediaRecorder is not available.');
    }

    await ipcRenderer.invoke('pro-recording-prepare', {
      mode: source.mode || mode,
      region: source.mode === 'region' ? source.region : null,
    });

    try {
      rawStream = await getDesktopStream(source.id, true);
    } catch (audioError) {
      systemAudio = false;
      rawStream = await getDesktopStream(source.id, false);
    }

    let zoomPipeline = null;
    const shouldCropRegion = mode === 'region' && source.region;
    const autoZoomRegion = shouldCropRegion
      ? source.region
      : (source.autoZoom === false || options?.autoZoom === false ? null : await getAutoZoomRegion(source, mode));
    if (autoZoomRegion) {
      zoomPipeline = createAutoZoomStream(rawStream, autoZoomRegion, {
        autoZoom: shouldCropRegion ? options?.autoZoom !== false && source.autoZoom !== false : true,
      });
      proRecordingStream = await zoomPipeline.ready;
      proRecordingRawStream = rawStream;
      proRecordingZoomStop = zoomPipeline.stop;
    } else {
      proRecordingStream = rawStream;
      proRecordingRawStream = null;
      proRecordingZoomStop = null;
    }

    attachRecordingPreviewStream(null, proRecordingStream);

    const mimeType = getRecordingMimeType();
    proRecordingChunks = [];
    proRecorder = new MediaRecorder(proRecordingStream, { mimeType });
    proRecorder.ondataavailable = (event) => {
      if (event.data && event.data.size > 0) proRecordingChunks.push(event.data);
    };
    proRecorder.start(1000);
    ipcRenderer.invoke('pro-recording-indicator-show', {
      region: source.mode === 'region' ? source.region : null,
      inlinePreview: Boolean(options?.previewVideoId),
    }).catch(() => {});
    return { success: true, pro: true, source, systemAudio, mimeType };
  } catch (error) {
    proRecordingZoomStop?.();
    rawStream?.getTracks().forEach((track) => track.stop());
    proRecordingStream?.getTracks().forEach((track) => track.stop());
    proRecordingStream = null;
    proRecordingRawStream = null;
    proRecordingZoomStop = null;
    proRecorder = null;
    proRecordingChunks = [];
    ipcRenderer.invoke('pro-recording-indicator-hide').catch(() => {});
    throw error;
  }
}
function stopRecording(options = {}) {
  return new Promise((resolve, reject) => {
    if (!proRecorder || proRecorder.state === 'inactive') {
      reject(new Error('No screen recording is in progress'));
      return;
    }

    const shouldExportGif = options === true || options?.format === 'gif' || Boolean(options?.gif);
    proRecorder.onerror = (event) => reject(event.error || new Error('Screen recording failed'));
    proRecorder.onstop = async () => {
      try {
        const blob = new Blob(proRecordingChunks, { type: proRecorder.mimeType || 'video/webm' });
        if (blob.size === 0) {
          throw new Error('Recording did not capture any video data. Please try again.');
        }
        const arrayBuffer = await blob.arrayBuffer();
        await ipcRenderer.invoke('pro-recording-indicator-hide');
        resolve({
          preview: true,
          data: new Uint8Array(arrayBuffer),
          mimeType: blob.type || proRecorder.mimeType || 'video/webm',
          gif: shouldExportGif,
          format: options?.format || proRecordingFormat,
        });
      } catch (error) {
        reject(error);
      } finally {
        ipcRenderer.invoke('pro-recording-indicator-hide').catch(() => {});
        proRecordingZoomStop?.();
        proRecordingRawStream?.getTracks().forEach((track) => track.stop());
        proRecordingStream?.getTracks().forEach((track) => track.stop());
        proRecordingStream = null;
        proRecordingRawStream = null;
        proRecordingZoomStop = null;
        proRecorder = null;
        proRecordingChunks = [];
      }
    };
    if (proRecorder.state === 'recording' && typeof proRecorder.requestData === 'function') {
      proRecorder.requestData();
    }
    proRecorder.stop();
  });
}

contextBridge.exposeInMainWorld('pico', {
  // Screen capture
  startCapture: (options = {}) => ipcRenderer.invoke('start-capture', options),
  startCaptureWindow: (options = {}) => ipcRenderer.invoke('start-capture-window', options),
  startCaptureFullscreen: (options = {}) => ipcRenderer.invoke('start-capture-fullscreen', options),
  onLoadCapture: (callback) => ipcRenderer.on('load-capture', (_, data) => callback(data)),
  onTriggerCapture: (callback) => ipcRenderer.on('trigger-capture', () => callback()),
  onTriggerCaptureMenu: (callback) => ipcRenderer.on('trigger-capture-menu', () => callback()),
  onTriggerCaptureWindow: (callback) => ipcRenderer.on('trigger-capture-window', () => callback()),
  onTriggerRecordScreen: (callback) => ipcRenderer.on('trigger-record-screen', () => callback()),
  onTriggerCaptureFullscreen: (callback) => ipcRenderer.on('trigger-capture-fullscreen', () => callback()),
  onShortcutCaptureReady: (callback) => ipcRenderer.on('trigger-shortcut-capture-ready', () => callback()),
  onOpenPreferences: (callback) => ipcRenderer.on('open-preferences', () => callback()),
  onLoadCaptureData: (callback) => ipcRenderer.on('load-capture-data', (_, data) => callback(data)),
  onRecordingStopRequested: (callback) => ipcRenderer.on('pro-recording-stop-requested', () => callback()),

  // Capture overlay communication
  onCaptureData: (callback) => ipcRenderer.on('capture-data', (_, data) => callback(data)),
  captureComplete: (imageDataUrl) => ipcRenderer.send('capture-complete', imageDataUrl),
  selectWindowByName: (name) => ipcRenderer.send('window-overlay-select', name),
  captureCancel: () => ipcRenderer.send('capture-cancel'),
  recordingRegionComplete: (region) => ipcRenderer.send('recording-region-complete', region),

  // Window picker fallback
  onWindowSources: (callback) => ipcRenderer.on('window-sources', (_, data) => callback(data)),
  selectWindowSource: (sourceId) => ipcRenderer.send('window-source-select', sourceId),
  cancelWindowSource: () => ipcRenderer.send('window-source-cancel'),

  // Pro capture/recording features
  startRecording,
  stopRecording,
  saveRecording: (payload) => ipcRenderer.invoke('pro-save-recording', payload),

  // File operations
  openFile: () => ipcRenderer.invoke('open-file'),
  saveFile: (dataUrl) => ipcRenderer.invoke('save-file', dataUrl),
  getSettings: () => ipcRenderer.invoke('get-settings'),
  saveSettings: (settings) => ipcRenderer.invoke('save-settings', settings),
  chooseDefaultSavePath: (currentPath) => ipcRenderer.invoke('choose-default-save-path', currentPath),
  copyToClipboard: (dataUrl) => ipcRenderer.invoke('copy-to-clipboard', dataUrl),
  readClipboardImage: () => ipcRenderer.invoke('read-clipboard-image'),

  // Window controls
  closeWindow: () => ipcRenderer.invoke('window-close'),
  minimizeWindow: () => ipcRenderer.invoke('window-minimize'),
  setWindowMode: (mode) => ipcRenderer.invoke('window-set-mode', mode),
  toggleMaximizeWindow: () => ipcRenderer.invoke('window-toggle-maximize'),

  // Display info
  getDisplays: () => ipcRenderer.invoke('get-displays'),

  // Platform info
  platform: process.platform,
});
