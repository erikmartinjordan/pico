/**
 * pico - Preload Script
 * Secure bridge between main and renderer processes
 */

const { contextBridge, ipcRenderer } = require('electron');

let proRecorder = null;
let proRecordingStream = null;
let proRecordingChunks = [];

async function startRecording() {
  if (proRecorder && proRecorder.state !== 'inactive') {
    throw new Error('A screen recording is already in progress');
  }

  const source = await ipcRenderer.invoke('pro-recording-source');
  const constraints = {
    audio: {
      mandatory: {
        chromeMediaSource: 'desktop',
      },
    },
    video: {
      mandatory: {
        chromeMediaSource: 'desktop',
        chromeMediaSourceId: source.id,
      },
    },
  };

  proRecordingStream = await navigator.mediaDevices.getUserMedia(constraints);
  const mimeType = 'video/webm;codecs=vp9';
  if (!MediaRecorder.isTypeSupported(mimeType)) {
    proRecordingStream.getTracks().forEach((track) => track.stop());
    proRecordingStream = null;
    throw new Error(`${mimeType} is not supported on this system`);
  }

  proRecordingChunks = [];
  proRecorder = new MediaRecorder(proRecordingStream, { mimeType });
  proRecorder.ondataavailable = (event) => {
    if (event.data && event.data.size > 0) proRecordingChunks.push(event.data);
  };
  proRecorder.start(1000);
  return { success: true, pro: true, source };
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
        const blob = new Blob(proRecordingChunks, { type: 'video/webm;codecs=vp9' });
        const arrayBuffer = await blob.arrayBuffer();
        const result = await ipcRenderer.invoke('pro-save-recording', {
          data: new Uint8Array(arrayBuffer),
          gif: shouldExportGif,
        });
        resolve(result);
      } catch (error) {
        reject(error);
      } finally {
        proRecordingStream?.getTracks().forEach((track) => track.stop());
        proRecordingStream = null;
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
  scrollCapture: (windowId) => ipcRenderer.invoke('pro-scroll-capture', windowId),
  onLoadCapture: (callback) => ipcRenderer.on('load-capture', (_, data) => callback(data)),
  onTriggerCapture: (callback) => ipcRenderer.on('trigger-capture', () => callback()),
  onLoadCaptureData: (callback) => ipcRenderer.on('load-capture-data', (_, data) => callback(data)),

  // Capture overlay communication
  onCaptureData: (callback) => ipcRenderer.on('capture-data', (_, data) => callback(data)),
  captureComplete: (imageDataUrl) => ipcRenderer.send('capture-complete', imageDataUrl),
  selectWindowByName: (name) => ipcRenderer.send('window-overlay-select', name),
  captureCancel: () => ipcRenderer.send('capture-cancel'),

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
