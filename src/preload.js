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
  const cursorPollIntervalMs = 33;
  const velocityEase = 0.22;
  const zoomInVelocityPxPerSecond = 70 * scaleFactor;
  const zoomOutVelocityPxPerSecond = 260 * scaleFactor;
  const zoomInDelayMs = 260;
  const zoomOutHoldMs = 180;
  const centerLeadMs = 85;
  const regionCenterX = srcRegion.x + srcRegion.width / 2;
  const regionCenterY = srcRegion.y + srcRegion.height / 2;
  const camera = {
    x: regionCenterX,
    y: regionCenterY,
    zoom: 1,
    vx: 0,
    vy: 0,
    vz: 0,
  };
  const cursorState = {
    x: regionCenterX,
    y: regionCenterY,
    vx: 0,
    vy: 0,
    speed: 0,
    lastX: null,
    lastY: null,
    lastSampleAt: 0,
    lastMotionAt: performance.now(),
    quietSince: performance.now(),
    targetZoom: 1,
  };
  let rafId = null;
  let pollTimer = null;
  let stopped = false;
  let cursorPollInFlight = false;
  let lastFrameAt = performance.now();

  function springTo(current, target, velocity, frequency, damping, dt) {
    const angularFrequency = frequency * Math.PI * 2;
    const acceleration = (target - current) * angularFrequency * angularFrequency
      - velocity * (2 * damping * angularFrequency);
    const nextVelocity = velocity + acceleration * dt;
    return {
      value: current + nextVelocity * dt,
      velocity: nextVelocity,
    };
  }

  function softClamp(value, min, max, padding) {
    if (max <= min) return (min + max) / 2;
    const safePadding = Math.max(1, Math.min(padding, (max - min) / 2));
    const lower = min + safePadding;
    const upper = max - safePadding;
    if (value < lower) {
      const distance = Math.max(0, lower - value);
      return lower - safePadding * (1 - Math.exp(-distance / safePadding));
    }
    if (value > upper) {
      const distance = Math.max(0, value - upper);
      return upper + safePadding * (1 - Math.exp(-distance / safePadding));
    }
    return value;
  }

  function screenPointToSourcePixel(cursor) {
    const relLogicalX = cursor.x - displayBounds.x - region.x;
    const relLogicalY = cursor.y - displayBounds.y - region.y;
    return {
      x: srcRegion.x + relLogicalX * pixelScaleX,
      y: srcRegion.y + relLogicalY * pixelScaleY,
    };
  }

  function updateZoomIntent(now) {
    if (cursorState.speed > zoomOutVelocityPxPerSecond) {
      cursorState.lastMotionAt = now;
      cursorState.quietSince = now;
      cursorState.targetZoom = 1;
      return;
    }

    if (cursorState.speed > zoomInVelocityPxPerSecond) {
      cursorState.quietSince = now;
      if (now - cursorState.lastMotionAt < zoomOutHoldMs) cursorState.targetZoom = 1;
      return;
    }

    if (now - cursorState.quietSince > zoomInDelayMs && now - cursorState.lastMotionAt > zoomOutHoldMs) {
      cursorState.targetZoom = zoomLevel;
    }
  }

  async function pollCursor() {
    if (stopped || cursorPollInFlight) return;
    cursorPollInFlight = true;
    try {
      const cursor = await getCursorScreenPoint();
      const now = performance.now();
      const point = screenPointToSourcePixel(cursor);
      const x = clamp(point.x, srcRegion.x, srcRegion.x + srcRegion.width);
      const y = clamp(point.y, srcRegion.y, srcRegion.y + srcRegion.height);

      if (cursorState.lastX !== null && cursorState.lastY !== null && cursorState.lastSampleAt > 0) {
        const dt = Math.max(0.001, (now - cursorState.lastSampleAt) / 1000);
        const instantVx = (x - cursorState.lastX) / dt;
        const instantVy = (y - cursorState.lastY) / dt;
        const instantSpeed = Math.hypot(instantVx, instantVy);
        cursorState.vx = cursorState.vx * (1 - velocityEase) + instantVx * velocityEase;
        cursorState.vy = cursorState.vy * (1 - velocityEase) + instantVy * velocityEase;
        cursorState.speed = cursorState.speed * (1 - velocityEase) + instantSpeed * velocityEase;
      }

      cursorState.x = x;
      cursorState.y = y;
      cursorState.lastX = x;
      cursorState.lastY = y;
      cursorState.lastSampleAt = now;
      updateZoomIntent(now);
    } catch (error) {
      cursorState.targetZoom = 1;
      cursorState.speed = 0;
      cursorState.vx = 0;
      cursorState.vy = 0;
      cursorState.lastX = null;
      cursorState.lastY = null;
      cursorState.lastSampleAt = 0;
      cursorState.lastMotionAt = performance.now();
      cursorState.quietSince = cursorState.lastMotionAt;
    } finally {
      cursorPollInFlight = false;
    }
  }

  function startCursorPolling() {
    pollCursor();
    pollTimer = setInterval(pollCursor, cursorPollIntervalMs);
  }

  function draw(now = performance.now()) {
    if (stopped) return;
    const dt = Math.min(0.05, Math.max(0.001, (now - lastFrameAt) / 1000));
    lastFrameAt = now;
    updateZoomIntent(now);

    const predictedCursorX = cursorState.x + cursorState.vx * (centerLeadMs / 1000);
    const predictedCursorY = cursorState.y + cursorState.vy * (centerLeadMs / 1000);
    const desiredZoom = cursorState.targetZoom;
    const zoomSpring = springTo(camera.zoom, desiredZoom, camera.vz, 2.1, 0.86, dt);
    camera.zoom = clamp(zoomSpring.value, 1, zoomLevel + 0.08);
    camera.vz = zoomSpring.velocity;

    const cropW = srcRegion.width / camera.zoom;
    const cropH = srcRegion.height / camera.zoom;
    const minCenterX = srcRegion.x + cropW / 2;
    const minCenterY = srcRegion.y + cropH / 2;
    const maxCenterX = srcRegion.x + srcRegion.width - cropW / 2;
    const maxCenterY = srcRegion.y + srcRegion.height - cropH / 2;
    const edgePaddingX = Math.min(cropW * 0.18, srcRegion.width * 0.12);
    const edgePaddingY = Math.min(cropH * 0.18, srcRegion.height * 0.12);
    const focusX = camera.zoom > 1.01 ? predictedCursorX : regionCenterX;
    const focusY = camera.zoom > 1.01 ? predictedCursorY : regionCenterY;
    const desiredCenterX = softClamp(focusX, minCenterX, maxCenterX, edgePaddingX);
    const desiredCenterY = softClamp(focusY, minCenterY, maxCenterY, edgePaddingY);
    const centerSpringX = springTo(camera.x, desiredCenterX, camera.vx, 2.7, 0.9, dt);
    const centerSpringY = springTo(camera.y, desiredCenterY, camera.vy, 2.7, 0.9, dt);
    camera.x = centerSpringX.value;
    camera.y = centerSpringY.value;
    camera.vx = centerSpringX.velocity;
    camera.vy = centerSpringY.velocity;

    const sx = clamp(camera.x - cropW / 2, srcRegion.x, srcRegion.x + srcRegion.width - cropW);
    const sy = clamp(camera.y - cropH / 2, srcRegion.y, srcRegion.y + srcRegion.height - cropH);

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
    lastFrameAt = performance.now();
    startCursorPolling();
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
