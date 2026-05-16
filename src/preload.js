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

function createAutoZoomStream(sourceStream, region) {
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
  const zoomLevel = clamp(1.35 + ((srcRegion.width - 1280) / 5120), 1.35, 1.8);
  const cursorPollIntervalMs = 80;
  const stillMovementThresholdPx = 8;
  const stillFrameThreshold = 6;
  const activeFrameThreshold = 2;
  const zoomLerp = 0.07;
  const centerLerp = 0.12;
  const regionCenterX = srcRegion.x + srcRegion.width / 2;
  const regionCenterY = srcRegion.y + srcRegion.height / 2;
  let currentZoom = 1;
  let targetZoom = 1;
  let currentCenterX = regionCenterX;
  let currentCenterY = regionCenterY;
  let targetCenterX = currentCenterX;
  let targetCenterY = currentCenterY;
  let lastCursorX = null;
  let lastCursorY = null;
  let stillFrames = 0;
  let dwellZoomedOut = false;
  let activeFrames = 0;
  let smoothedMovement = 0;
  let rafId = null;
  let stopped = false;
  let lastCursorPoll = 0;
  let cursorPollInFlight = false;

  async function updateCursorTarget(now) {
    if (cursorPollInFlight || now - lastCursorPoll < cursorPollIntervalMs) return;
    lastCursorPoll = now;
    cursorPollInFlight = true;
    try {
      const cursor = await getCursorScreenPoint();
      const relLogicalX = cursor.x - displayBounds.x - region.x;
      const relLogicalY = cursor.y - displayBounds.y - region.y;
      const cursorPixelX = srcRegion.x + relLogicalX * pixelScaleX;
      const cursorPixelY = srcRegion.y + relLogicalY * pixelScaleY;

      targetCenterX = cursorPixelX;
      targetCenterY = cursorPixelY;

      if (lastCursorX === null || lastCursorY === null) {
        lastCursorX = cursorPixelX;
        lastCursorY = cursorPixelY;
        targetZoom = 1;
        return;
      }

      const movement = Math.hypot(cursorPixelX - lastCursorX, cursorPixelY - lastCursorY);
      smoothedMovement = smoothedMovement * 0.6 + movement * 0.4;
      lastCursorX = cursorPixelX;
      lastCursorY = cursorPixelY;

      if (smoothedMovement > stillMovementThresholdPx) {
        stillFrames = 0;
        dwellZoomedOut = false;
        activeFrames += 1;
        if (activeFrames >= activeFrameThreshold) targetZoom = 1;
      } else {
        activeFrames = 0;
        stillFrames += 1;
        if (!dwellZoomedOut && stillFrames >= stillFrameThreshold + 40) {
          targetZoom = 1;
          dwellZoomedOut = true;
        } else if (!dwellZoomedOut && stillFrames >= stillFrameThreshold) {
          targetZoom = zoomLevel;
        }
      }
    } catch (error) {
      targetZoom = 1;
      stillFrames = 0;
      activeFrames = 0;
      smoothedMovement = 0;
      lastCursorX = null;
      lastCursorY = null;
    } finally {
      cursorPollInFlight = false;
    }
  }

  function draw(now = performance.now()) {
    if (stopped) return;
    updateCursorTarget(now);

    currentZoom += (targetZoom - currentZoom) * zoomLerp;
    const followCenterX = currentZoom > 1.01 ? targetCenterX : regionCenterX;
    const followCenterY = currentZoom > 1.01 ? targetCenterY : regionCenterY;
    currentCenterX += (followCenterX - currentCenterX) * centerLerp;
    currentCenterY += (followCenterY - currentCenterY) * centerLerp;

    const cropW = srcRegion.width / currentZoom;
    const cropH = srcRegion.height / currentZoom;
    const minX = srcRegion.x;
    const minY = srcRegion.y;
    const maxX = srcRegion.x + srcRegion.width - cropW;
    const maxY = srcRegion.y + srcRegion.height - cropH;
    const sx = clamp(currentCenterX - cropW / 2, minX, maxX);
    const sy = clamp(currentCenterY - cropH / 2, minY, maxY);

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
    if (rafId) cancelAnimationFrame(rafId);
  };

  const ready = video.play().then(() => {
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
  });
  if (!source) throw new Error('Recording canceled');
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error('Screen recording is unavailable because media capture APIs are not available.');
  }
  if (typeof MediaRecorder === 'undefined') {
    throw new Error('Screen recording is unavailable because MediaRecorder is not available.');
  }

  let systemAudio = true;
  let rawStream = null;
  try {
    rawStream = await getDesktopStream(source.id, true);
  } catch (audioError) {
    systemAudio = false;
    rawStream = await getDesktopStream(source.id, false);
  }

  let zoomPipeline = null;
  const autoZoomRegion = source.autoZoom === false || options?.autoZoom === false ? null : await getAutoZoomRegion(source, mode);
  if (autoZoomRegion) {
    zoomPipeline = createAutoZoomStream(rawStream, autoZoomRegion);
    proRecordingStream = await zoomPipeline.ready;
    proRecordingRawStream = rawStream;
    proRecordingZoomStop = zoomPipeline.stop;
  } else {
    proRecordingStream = rawStream;
    proRecordingRawStream = null;
    proRecordingZoomStop = null;
  }

  const mimeType = getRecordingMimeType();
  proRecordingChunks = [];
  proRecorder = new MediaRecorder(proRecordingStream, { mimeType });
  proRecorder.ondataavailable = (event) => {
    if (event.data && event.data.size > 0) proRecordingChunks.push(event.data);
  };
  proRecorder.start(1000);
  ipcRenderer.invoke('pro-recording-indicator-show', { region: source.mode === 'region' ? source.region : null }).catch(() => {});
  return { success: true, pro: true, source, systemAudio, mimeType };
}

function stopRecording(options = {}) {
  return new Promise((resolve, reject) => {
    if (!proRecorder || proRecorder.state === 'inactive') {
      reject(new Error('No screen recording is in progress'));
      return;
    }

    const shouldExportGif = options === true || Boolean(options?.gif);
    proRecorder.onerror = (event) => reject(event.error || new Error('Screen recording failed'));
    proRecorder.onstop = async () => {
      try {
        const blob = new Blob(proRecordingChunks, { type: proRecorder.mimeType || 'video/webm' });
        if (blob.size === 0) {
          throw new Error('Recording did not capture any video data. Please try again.');
        }
        const arrayBuffer = await blob.arrayBuffer();
        await ipcRenderer.invoke('pro-recording-indicator-hide');
        const result = await ipcRenderer.invoke('pro-save-recording', {
          data: new Uint8Array(arrayBuffer),
          gif: shouldExportGif,
          format: options?.format || proRecordingFormat,
        });
        resolve(result);
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

  // File operations
  openFile: () => ipcRenderer.invoke('open-file'),
  saveFile: (dataUrl) => ipcRenderer.invoke('save-file', dataUrl),
  copyToClipboard: (dataUrl) => ipcRenderer.invoke('copy-to-clipboard', dataUrl),
  readClipboardImage: () => ipcRenderer.invoke('read-clipboard-image'),
  
  // Display info
  getDisplays: () => ipcRenderer.invoke('get-displays'),
  
  // Platform info
  platform: process.platform,
});
