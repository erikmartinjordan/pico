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

  const zoomLevel = clamp(1.22 + ((srcRegion.width - 1280) / 8192), 1.18, 1.32);

  const IDLE_ZOOM_IN_DELAY_MS      = 1400;
  const IDLE_ZOOM_OUT_DELAY_MS     = 2800;
  const LARGE_MOVE_THRESHOLD       = 160 * scaleFactor;
  const FAST_MOVE_THRESHOLD_PX_S   = 600 * scaleFactor;
  const FAST_MOVE_COOLDOWN_MS      = 1600;
  const ZOOM_SPEED                 = 0.7;
  const PAN_SPEED                  = 0.9;
  const TARGET_PAN_SPEED           = 1.8;
  const TARGET_ZOOM_SPEED          = 1.4;
  const regionCenterX = srcRegion.x + srcRegion.width / 2;
  const regionCenterY = srcRegion.y + srcRegion.height / 2;

  // States: 'FULL_SCREEN', 'ZOOMED_FOLLOW', 'ZOOMED_STILL'
  let zoomState = 'FULL_SCREEN';

  let camera = { x: regionCenterX, y: regionCenterY, zoom: 1 };
  let targetCamera = { x: regionCenterX, y: regionCenterY, zoom: 1 };
  let smoothedTarget = { x: regionCenterX, y: regionCenterY, zoom: 1 };
  let cursor = { x: regionCenterX, y: regionCenterY };
  let lastAnchor = { x: regionCenterX, y: regionCenterY };

  let lastFastMoveTime   = -Infinity;
  let prevCursorPx       = null;
  let prevPollTime       = null;
  let cursorSpeedEMA     = 0;
  const EMA_ALPHA        = 0.18;

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
      const pt  = await getCursorScreenPoint();
      const now = performance.now();

      const relLogicalX = pt.x - displayBounds.x - region.x;
      const relLogicalY = pt.y - displayBounds.y - region.y;
      const px = srcRegion.x + relLogicalX * pixelScaleX;
      const py = srcRegion.y + relLogicalY * pixelScaleY;

      if (prevCursorPx && prevPollTime) {
        const dtSec        = Math.max(0.001, (now - prevPollTime) / 1000);
        const dist         = Math.hypot(px - prevCursorPx.x, py - prevCursorPx.y);
        const instantSpeed = dist / dtSec;
        cursorSpeedEMA     = EMA_ALPHA * instantSpeed + (1 - EMA_ALPHA) * cursorSpeedEMA;
      }
      prevCursorPx = { x: px, y: py };
      prevPollTime = now;

      const totalDistanceMoved = Math.hypot(px - cursor.x, py - cursor.y);

      if (totalDistanceMoved > 8 * scaleFactor) {
        lastMoveTime = now;

        if (cursorSpeedEMA > FAST_MOVE_THRESHOLD_PX_S) {
          zoomState        = 'FULL_SCREEN';
          lastFastMoveTime = now;
        } else if (zoomState === 'ZOOMED_STILL' || zoomState === 'ZOOMED_FOLLOW') {
          const distFromAnchor = Math.hypot(px - lastAnchor.x, py - lastAnchor.y);
          if (distFromAnchor > LARGE_MOVE_THRESHOLD) {
            zoomState = 'ZOOMED_FOLLOW';
          }
        }
      }

      cursor.x = clamp(px, srcRegion.x, srcRegion.x + srcRegion.width);
      cursor.y = clamp(py, srcRegion.y, srcRegion.y + srcRegion.height);
    } catch {
      // ignore isolated IPC glitches
    } finally {
      cursorPollInFlight = false;
    }
  }

  function updateStateMachine(now) {
    const timeSinceMove     = now - lastMoveTime;
    const timeSinceFastMove = now - lastFastMoveTime;
    const inCooldown        = timeSinceFastMove < FAST_MOVE_COOLDOWN_MS;

    if (!inCooldown && timeSinceMove > IDLE_ZOOM_IN_DELAY_MS) {
      if (zoomState === 'FULL_SCREEN' || zoomState === 'ZOOMED_FOLLOW') {
        zoomState    = 'ZOOMED_STILL';
        lastAnchor.x = cursor.x;
        lastAnchor.y = cursor.y;
      }
    }

    if (timeSinceMove > IDLE_ZOOM_OUT_DELAY_MS && zoomState === 'ZOOMED_STILL') {
      zoomState = 'FULL_SCREEN';
    }

    if (zoomState === 'ZOOMED_STILL') {
      targetCamera.zoom = zoomLevel;
      targetCamera.x    = lastAnchor.x * 0.65 + cursor.x * 0.35;
      targetCamera.y    = lastAnchor.y * 0.65 + cursor.y * 0.35;
    } else if (zoomState === 'ZOOMED_FOLLOW') {
      targetCamera.zoom = zoomLevel * 0.78;
      targetCamera.x    = cursor.x;
      targetCamera.y    = cursor.y;
    } else {
      targetCamera.zoom = 1;
      targetCamera.x    = regionCenterX;
      targetCamera.y    = regionCenterY;
    }
  }

  function draw(now = performance.now()) {
    if (stopped) return;

    const dt = Math.min(0.1, (now - lastFrameTime) / 1000);
    lastFrameTime = now;

    if (enableAutoZoom) {
      updateStateMachine(now);

      smoothedTarget.zoom = expEase(smoothedTarget.zoom, targetCamera.zoom, TARGET_ZOOM_SPEED, dt);
      smoothedTarget.x = expEase(smoothedTarget.x, targetCamera.x, TARGET_PAN_SPEED, dt);
      smoothedTarget.y = expEase(smoothedTarget.y, targetCamera.y, TARGET_PAN_SPEED, dt);

      camera.zoom = expEase(camera.zoom, smoothedTarget.zoom, ZOOM_SPEED, dt);
      camera.x = expEase(camera.x, smoothedTarget.x, PAN_SPEED, dt);
      camera.y = expEase(camera.y, smoothedTarget.y, PAN_SPEED, dt);
    } else {
      targetCamera = { x: regionCenterX, y: regionCenterY, zoom: 1 };
      smoothedTarget = { ...targetCamera };
      camera = { ...targetCamera };
    }

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
    if (enableAutoZoom) {
      pollTimer = setInterval(pollCursor, 16); // 60 Hz
    }
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
