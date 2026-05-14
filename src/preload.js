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
      minWidth: 1,
      minHeight: 1,
      maxWidth: 16384,
      maxHeight: 16384,
      maxFrameRate: 60,
    },
  };
  const audio = includeAudio ? {
    mandatory: {
      chromeMediaSource: 'desktop',
    },
  } : false;

  return navigator.mediaDevices.getUserMedia({ audio, video });
}


function createAutoZoomStream(sourceStream, region) {
  const video = document.createElement('video');
  video.muted = true;
  video.srcObject = sourceStream;
  video.playsInline = true;

  const displayBounds = region.displayBounds || { x: 0, y: 0, width: region.width, height: region.height };
  const fps = 60;
  const zoomLevel = 1.65;
  let canvas = null;
  let ctx = null;
  let canvasStream = null;
  let srcRegion = null;
  let mediaScaleX = 1;
  let mediaScaleY = 1;
  let currentZoom = 1;
  let targetZoom = 1;
  let currentCenterX = 0;
  let currentCenterY = 0;
  let targetCenterX = 0;
  let targetCenterY = 0;
  let rafId = null;
  let stopped = false;
  let lastCursorPoll = 0;
  let cursorPollPending = false;

  function evenDimension(value) {
    return Math.max(2, Math.floor(value / 2) * 2);
  }

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  function buildGeometry() {
    const videoWidth = video.videoWidth || sourceStream.getVideoTracks()[0]?.getSettings?.().width || region.pixelWidth || region.width;
    const videoHeight = video.videoHeight || sourceStream.getVideoTracks()[0]?.getSettings?.().height || region.pixelHeight || region.height;
    mediaScaleX = videoWidth / Math.max(1, displayBounds.width || region.width);
    mediaScaleY = videoHeight / Math.max(1, displayBounds.height || region.height);

    const rawX = region.x * mediaScaleX;
    const rawY = region.y * mediaScaleY;
    const rawW = region.width * mediaScaleX;
    const rawH = region.height * mediaScaleY;
    const x = clamp(Math.round(rawX), 0, Math.max(0, videoWidth - 2));
    const y = clamp(Math.round(rawY), 0, Math.max(0, videoHeight - 2));
    const width = Math.max(2, Math.min(Math.round(rawW), videoWidth - x));
    const height = Math.max(2, Math.min(Math.round(rawH), videoHeight - y));

    srcRegion = { x, y, width, height };
    canvas = document.createElement('canvas');
    canvas.width = evenDimension(width);
    canvas.height = evenDimension(height);
    ctx = canvas.getContext('2d', { alpha: false });
    currentCenterX = targetCenterX = srcRegion.x + srcRegion.width / 2;
    currentCenterY = targetCenterY = srcRegion.y + srcRegion.height / 2;
  }

  async function updateCursorTarget(now) {
    if (cursorPollPending || now - lastCursorPoll < 80) return;
    lastCursorPoll = now;
    cursorPollPending = true;
    try {
      const cursor = await getCursorScreenPoint();
      const relLogicalX = cursor.x - displayBounds.x - region.x;
      const relLogicalY = cursor.y - displayBounds.y - region.y;
      const inside = relLogicalX >= 0 && relLogicalY >= 0 && relLogicalX <= region.width && relLogicalY <= region.height;
      targetZoom = inside ? zoomLevel : 1;
      if (inside) {
        targetCenterX = srcRegion.x + relLogicalX * mediaScaleX;
        targetCenterY = srcRegion.y + relLogicalY * mediaScaleY;
      } else {
        targetCenterX = srcRegion.x + srcRegion.width / 2;
        targetCenterY = srcRegion.y + srcRegion.height / 2;
      }
    } catch (error) {
      targetZoom = 1;
    } finally {
      cursorPollPending = false;
    }
  }

  function draw(now = performance.now()) {
    if (stopped || !ctx || !srcRegion) return;
    updateCursorTarget(now);

    currentZoom += (targetZoom - currentZoom) * 0.08;
    currentCenterX += (targetCenterX - currentCenterX) * 0.10;
    currentCenterY += (targetCenterY - currentCenterY) * 0.10;

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
        const glow = Math.min(0.28, (currentZoom - 1) * 0.18);
        ctx.save();
        ctx.strokeStyle = `rgba(249, 115, 22, ${glow})`;
        ctx.lineWidth = Math.max(3, Math.round(Math.min(canvas.width, canvas.height) * 0.006));
        ctx.strokeRect(ctx.lineWidth / 2, ctx.lineWidth / 2, canvas.width - ctx.lineWidth, canvas.height - ctx.lineWidth);
        ctx.restore();
      }
    }
    rafId = requestAnimationFrame(draw);
  }

  const stop = () => {
    stopped = true;
    if (rafId) cancelAnimationFrame(rafId);
  };

  const ready = video.play().then(() => {
    buildGeometry();
    canvasStream = canvas.captureStream(fps);
    sourceStream.getAudioTracks().forEach((track) => canvasStream.addTrack(track));
    draw();
    return canvasStream;
  });

  return { ready, stop };
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

  const mimeType = getRecordingMimeType();
  proRecordingChunks = [];
  proRecorder = new MediaRecorder(proRecordingStream, { mimeType });
  proRecorder.ondataavailable = (event) => {
    if (event.data && event.data.size > 0) proRecordingChunks.push(event.data);
  };
  proRecorder.start(1000);
  ipcRenderer.invoke('pro-recording-indicator-show', { keepRendererAlive: source.mode === 'region' }).catch(() => {});
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
