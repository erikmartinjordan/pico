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

  const zoomLevel = clamp(1.35 + ((srcRegion.width - 1280) / 5120), 1.35, 1.65);
  const regionCenterX = srcRegion.x + srcRegion.width / 2;
  const regionCenterY = srcRegion.y + srcRegion.height / 2;

  // --- Cinematic Auto-Zoom Tuning ---
  const IDLE_ZOOM_IN_DELAY_MS = 800;  // Time stationary before zooming in on an element
  const IDLE_ZOOM_OUT_DELAY_MS = 2500; // Time stationary before drifting back to full screen
  const LARGE_MOVE_THRESHOLD = 180 * scaleFactor; // Distance traveled to trigger a zoom-out reset

  // Easing speeds (Lower = smoother/slower, Higher = snappier)
  const ZOOM_SPEED = 3.2;
  const PAN_SPEED = 3.8;

  // States: 'FULL_SCREEN', 'ZOOMED_FOLLOW', 'ZOOMED_STILL'
  let zoomState = 'FULL_SCREEN';

  let camera = { x: regionCenterX, y: regionCenterY, zoom: 1 };
  let targetCamera = { x: regionCenterX, y: regionCenterY, zoom: 1 };
  let cursor = { x: regionCenterX, y: regionCenterY };
  let lastAnchor = { x: regionCenterX, y: regionCenterY };

  let lastMoveTime = performance.now();
  let lastFrameTime = performance.now();
  let rafId = null;
  let pollTimer = null;
  let stopped = false;
  let cursorPollInFlight = false;

  function expEase(current, target, speed, dt) {
    return current + (target - current) * (1 - Math.exp(-speed * dt));
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

      const totalDistanceMoved = Math.hypot(px - cursor.x, py - cursor.y);

      // If mouse is moving actively, update timers
      if (totalDistanceMoved > 2 * scaleFactor) {
        lastMoveTime = performance.now();

        // If we are zoomed in, but user drags mouse a long distance away, break lock and zoom out
        if (zoomState === 'ZOOMED_STILL' || zoomState === 'ZOOMED_FOLLOW') {
          const distFromAnchor = Math.hypot(px - lastAnchor.x, py - lastAnchor.y);
          if (distFromAnchor > LARGE_MOVE_THRESHOLD) {
            zoomState = 'ZOOMED_FOLLOW';
          }
        }
      }

      cursor.x = clamp(px, srcRegion.x, srcRegion.x + srcRegion.width);
      cursor.y = clamp(py, srcRegion.y, srcRegion.y + srcRegion.height);
    } catch (e) {
      // Catch isolated IPC glitches safely
    } finally {
      cursorPollInFlight = false;
    }
  }

  function updateStateMachine(now) {
    const timeSinceMove = now - lastMoveTime;

    if (timeSinceMove > IDLE_ZOOM_IN_DELAY_MS) {
      // User stopped moving cursor. Anchor here and zoom in.
      if (zoomState === 'FULL_SCREEN' || zoomState === 'ZOOMED_FOLLOW') {
        zoomState = 'ZOOMED_STILL';
        lastAnchor.x = cursor.x;
        lastAnchor.y = cursor.y;
      }
    }

    // If completely idle on an element for a long time, drift back out to show full desktop context
    if (timeSinceMove > IDLE_ZOOM_OUT_DELAY_MS && zoomState === 'ZOOMED_STILL') {
      zoomState = 'FULL_SCREEN';
    }

    // Assign camera targets based on current state
    if (zoomState === 'ZOOMED_STILL') {
      targetCamera.zoom = zoomLevel;
      targetCamera.x = lastAnchor.x;
      targetCamera.y = lastAnchor.y;
    } else if (zoomState === 'ZOOMED_FOLLOW') {
      // Smoothly track cursor while staying partially zoomed in to avoid snappy context switching
      targetCamera.zoom = zoomLevel - 0.15;
      targetCamera.x = cursor.x;
      targetCamera.y = cursor.y;
    } else {
      // Return to full presentation view
      targetCamera.zoom = 1;
      targetCamera.x = regionCenterX;
      targetCamera.y = regionCenterY;
    }
  }

  function draw(now = performance.now()) {
    if (stopped) return;

    const dt = Math.min(0.1, (now - lastFrameTime) / 1000);
    lastFrameTime = now;

    updateStateMachine(now);

    // Dynamic easing speeds based on how far we are from target (smoothes out stops)
    camera.zoom = expEase(camera.zoom, targetCamera.zoom, ZOOM_SPEED, dt);
    camera.x = expEase(camera.x, targetCamera.x, PAN_SPEED, dt);
    camera.y = expEase(camera.y, targetCamera.y, PAN_SPEED, dt);

    const cropW = srcRegion.width / camera.zoom;
    const cropH = srcRegion.height / camera.zoom;

    // Strict safety boundaries to eliminate black gaps at video edges
    const minCenterX = srcRegion.x + cropW / 2;
    const maxCenterX = srcRegion.x + srcRegion.width - cropW / 2;
    const minCenterY = srcRegion.y + cropH / 2;
    const maxCenterY = srcRegion.y + srcRegion.height - cropH / 2;

    const safeCenterX = clamp(camera.x, minCenterX, maxCenterX);
    const safeCenterY = clamp(camera.y, minCenterY, maxCenterY);

    const sx = safeCenterX - cropW / 2;
    const sy = safeCenterY - cropH / 2;

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
    pollTimer = setInterval(pollCursor, 33); // 30Hz background coordinate capture
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
