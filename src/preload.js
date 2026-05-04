/**
 * pico - Preload Script
 * Secure bridge between main and renderer processes
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('pico', {
  // Screen capture
  startCapture: () => ipcRenderer.invoke('start-capture'),
  startCaptureWindow: () => ipcRenderer.invoke('start-capture-window'),
  startCaptureFullscreen: () => ipcRenderer.invoke('start-capture-fullscreen'),
  onLoadCapture: (callback) => ipcRenderer.on('load-capture', (_, data) => callback(data)),
  onTriggerCapture: (callback) => ipcRenderer.on('trigger-capture', () => callback()),
  onLoadCaptureData: (callback) => ipcRenderer.on('load-capture-data', (_, data) => callback(data)),

  // Capture overlay communication
  onCaptureData: (callback) => ipcRenderer.on('capture-data', (_, data) => callback(data)),
  captureComplete: (imageDataUrl) => ipcRenderer.send('capture-complete', imageDataUrl),
  captureCancel: () => ipcRenderer.send('capture-cancel'),
  captureWindowHover: (bounds) => ipcRenderer.send('capture-window-hover', bounds),
  onCaptureWindowHover: (callback) => ipcRenderer.on('capture-window-hover', (_, bounds) => callback(bounds)),
  
  // Window picker
  onWindowSources: (callback) => ipcRenderer.on('window-sources', (_, sources) => callback(sources)),
  selectWindowSource: (sourceId) => ipcRenderer.send('window-picker-select', sourceId),
  cancelWindowSource: () => ipcRenderer.send('window-picker-cancel'),

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
