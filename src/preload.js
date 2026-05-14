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

function getRecordingMimeType(includeAudio = false) {
  const codecPairs = includeAudio
    ? ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus']
    : ['video/webm;codecs=vp9', 'video/webm;codecs=vp8'];
  for (const mimeType of codecPairs) {
    if (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(mimeType)) return mimeType;
  }
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

function waitForVideoMetadata(video) {
  if (video.readyState >= HTMLMediaElement.HAVE_METADATA && video.videoWidth && video.videoHeight) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    video.addEventListener('loadedmetadata', () => resolve(), { once: true });
  });
}

function createAutoZoomStream(sourceStream, region) {
  const video = document.createElement('video');
  video.muted = true;
  video.srcObject = sourceStream;
  video.playsInline = true;

  const scaleFactor = region.scaleFactor || 1;
  const displayBounds = region.displayBounds || { x: 0, y: 0, width: region.width, height: region.height };
  const outputWidth = Math.max(2, region.pixelWidth || Math.round(region.width * scaleFactor));
  const outputHeight = Math.max(2, region.pixelHeight || Math.round(region.height * scaleFactor));
  const canvas = document.createElement('canvas');
  canvas.width = outputWidth;
  canvas.height = outputHeight;
  const ctx = canvas.getContext('2d', { alpha: false });
  const fps = 60;
  const zoomLevel = 1.58;
  const cursorPollMs = 1000 / 60;
  const zoomInMs = 520;
  const zoomOutMs = 720;
  const panMs = 620;
  const targetMs = 240;

  let srcRegion = {
    x: region.pixelX ?? Math.round(region.x * scaleFactor),
    y: region.pixelY ?? Math.round(region.y * scaleFactor),
    width: outputWidth,
    height: outputHeight,
  };
  let currentZoom = 1;
  let targetZoom = 1;
  let currentCenterX = srcRegion.x + srcRegion.width / 2;
  let currentCenterY = srcRegion.y + srcRegion.height / 2;
  let targetCenterX = currentCenterX;
  let targetCenterY = currentCenterY;
  let smoothedTargetCenterX = targetCenterX;
  let smoothedTargetCenterY = targetCenterY;
  let rafId = null;
  let stopped = false;
  let lastCursorPoll = 0;
  let lastFrameTime = 0;
  let cursorRequestPending = false;

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  function easeFactor(deltaMs, durationMs) {
    return 1 - Math.exp(-Math.max(0, deltaMs) / Math.max(1, durationMs));
  }

  function updateSourceRegionFromVideo() {
    if (!video.videoWidth || !video.videoHeight || !displayBounds.width || !displayBounds.height) return;
    const sourceScaleX = video.videoWidth / displayBounds.width;
    const sourceScaleY = video.videoHeight / displayBounds.height;
    srcRegion = {
      x: Math.round(region.x * sourceScaleX),
      y: Math.round(region.y * sourceScaleY),
      width: Math.max(2, Math.round(region.width * sourceScaleX)),
      height: Math.max(2, Math.round(region.height * sourceScaleY)),
    };
    currentCenterX = srcRegion.x + srcRegion.width / 2;
    currentCenterY = srcRegion.y + srcRegion.height / 2;
    targetCenterX = currentCenterX;
    targetCenterY = currentCenterY;
    smoothedTargetCenterX = currentCenterX;
    smoothedTargetCenterY = currentCenterY;
  }

  async function updateCursorTarget(now) {
    if (cursorRequestPending || now - lastCursorPoll < cursorPollMs) return;
    lastCursorPoll = now;
    cursorRequestPending = true;
    try {
      const cursor = await getCursorScreenPoint();
      const relLogicalX = cursor.x - displayBounds.x - region.x;
      const relLogicalY = cursor.y - displayBounds.y - region.y;
      const inside = relLogicalX >= 0 && relLogicalY >= 0 && relLogicalX <= region.width && relLogicalY <= region.height;
      targetZoom = inside ? zoomLevel : 1;
      if (inside) {
        const sourceScaleX = srcRegion.width / region.width;
        const sourceScaleY = srcRegion.height / region.height;
        targetCenterX = srcRegion.x + relLogicalX * sourceScaleX;
        targetCenterY = srcRegion.y + relLogicalY * sourceScaleY;
      } else {
        targetCenterX = srcRegion.x + srcRegion.width / 2;
        targetCenterY = srcRegion.y + srcRegion.height / 2;
      }
    } catch (error) {
      targetZoom = 1;
    } finally {
      cursorRequestPending = false;
    }
  }

  function draw(now = performance.now()) {
    if (stopped) return;
    const deltaMs = lastFrameTime ? Math.min(80, now - lastFrameTime) : 16.7;
    lastFrameTime = now;
    updateCursorTarget(now);

    const targetAlpha = easeFactor(deltaMs, targetMs);
    smoothedTargetCenterX += (targetCenterX - smoothedTargetCenterX) * targetAlpha;
    smoothedTargetCenterY += (targetCenterY - smoothedTargetCenterY) * targetAlpha;

    const zoomAlpha = easeFactor(deltaMs, targetZoom > currentZoom ? zoomInMs : zoomOutMs);
    const panAlpha = easeFactor(deltaMs, panMs);
    currentZoom += (targetZoom - currentZoom) * zoomAlpha;
    currentCenterX += (smoothedTargetCenterX - currentCenterX) * panAlpha;
    currentCenterY += (smoothedTargetCenterY - currentCenterY) * panAlpha;

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

      if (currentZoom > 1.04) {
        const glow = Math.min(0.20, (currentZoom - 1) * 0.12);
        ctx.save();
        ctx.strokeStyle = `rgba(249, 115, 22, ${glow})`;
        ctx.lineWidth = Math.max(2, Math.round(Math.min(canvas.width, canvas.height) * 0.004));
        ctx.strokeRect(ctx.lineWidth / 2, ctx.lineWidth / 2, canvas.width - ctx.lineWidth, canvas.height - ctx.lineWidth);
        ctx.restore();
      }
    }
    rafId = requestAnimationFrame(draw);
  }

  const canvasStream = canvas.captureStream(fps);
  sourceStream.getAudioTracks().forEach((track) => canvasStream.addTrack(track));
  const stop = () => {
    stopped = true;
    if (rafId) cancelAnimationFrame(rafId);
  };

  const ready = video.play().then(() => waitForVideoMetadata(video)).then(() => {
    updateSourceRegionFromVideo();
    draw();
    return canvasStream;
  });

  return { stream: canvasStream, ready, stop };
}

async function startRecording(options = {}) {
  if (proRecorder && proRecorder.state !== 'inactive') {
    throw new Error('A screen recording is already in progress');
  }

  proRecordingFormat = options?.format === 'gif' ? 'gif' : 'mp4';
  const mode = options?.mode === 'region' ? 'region' : 'window';
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
  if (source.mode === 'region' && source.region) {
    zoomPipeline = createAutoZoomStream(rawStream, source.region);
    proRecordingStream = await zoomPipeline.ready;
    proRecordingRawStream = rawStream;
    proRecordingZoomStop = zoomPipeline.stop;
  } else {
    proRecordingStream = rawStream;
    proRecordingRawStream = null;
    proRecordingZoomStop = null;
  }

  const mimeType = getRecordingMimeType(proRecordingStream.getAudioTracks().length > 0);
  proRecordingChunks = [];
  const recorderOptions = {
    mimeType,
    videoBitsPerSecond: 12_000_000,
  };
  if (proRecordingStream.getAudioTracks().length > 0) recorderOptions.audioBitsPerSecond = 160_000;
  proRecorder = new MediaRecorder(proRecordingStream, recorderOptions);
  proRecorder.ondataavailable = (event) => {
    if (event.data && event.data.size > 0) proRecordingChunks.push(event.data);
  };
  proRecorder.start(1000);
  ipcRenderer.invoke('pro-recording-indicator-show').catch(() => {});
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
    try {
      proRecorder.requestData();
    } catch (error) {}
    proRecorder.stop();
  });
}

contextBridge.exposeInMainWorld('pico', {
  // Screen capture
  startCapture: () => ipcRenderer.invoke('start-capture'),
  startCaptureWindow: () => ipcRenderer.invoke('start-capture-window'),
  startCaptureFullscreen: () => ipcRenderer.invoke('start-capture-fullscreen'),
  onLoadCapture: (callback) => ipcRenderer.on('load-capture', (_, data) => callback(data)),
  onTriggerCapture: (callback) => ipcRenderer.on('trigger-capture', () => callback()),
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
