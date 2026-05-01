/**
 * pico - Main Process
 * Handles window creation, screen capture, and native dialogs
 */

const { app, BrowserWindow, ipcMain, desktopCapturer, dialog, screen, globalShortcut, nativeImage, clipboard } = require('electron');
const path = require('path');
const fs = require('fs');

let mainWindow = null;
let captureWindows = [];

// ── Window Creation ─────────────────────────────────────────────────────────

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#0a0a0b',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    frame: process.platform !== 'darwin',
    trafficLightPosition: { x: 16, y: 16 },
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
    icon: path.join(__dirname, 'assets', 'icons', 'icon.png'),
    show: false,
  });

  mainWindow.loadFile(path.join(__dirname, 'index.html'));

  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// ── Screen Capture ──────────────────────────────────────────────────────────

async function captureAllScreens() {
  const displays = screen.getAllDisplays();
  
  // Calculate virtual screen bounds (union of all displays)
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  displays.forEach(d => {
    minX = Math.min(minX, d.bounds.x);
    minY = Math.min(minY, d.bounds.y);
    maxX = Math.max(maxX, d.bounds.x + d.bounds.width);
    maxY = Math.max(maxY, d.bounds.y + d.bounds.height);
  });
  
  const totalWidth = maxX - minX;
  const totalHeight = maxY - minY;

  try {
    // Use max scale factor across all displays so every screen is captured at native resolution
    const maxScale = Math.max(...displays.map(d => d.scaleFactor || 1));
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: {
        width: Math.round(totalWidth * maxScale),
        height: Math.round(totalHeight * maxScale),
      },
    });

    const sourceByDisplayId = new Map();
    for (const source of sources) {
      if (source.display_id) sourceByDisplayId.set(String(source.display_id), source);
    }

    // If multiple displays, composite exact source->display matches.
    if (displays.length > 1) {
      const screensData = await Promise.all(displays.map(async (display) => {
        const source = sourceByDisplayId.get(String(display.id));
        if (!source) {
          throw new Error(`No screen source found for display ${display.id}`);
        }

        const nativeWidth = Math.round(display.bounds.width * (display.scaleFactor || 1));
        const nativeHeight = Math.round(display.bounds.height * (display.scaleFactor || 1));
        const thumbnail = source.thumbnail.resize({
          width: nativeWidth,
          height: nativeHeight,
          quality: 'best',
        });

        return {
          dataUrl: thumbnail.toDataURL(),
          bounds: display.bounds,
          scaleFactor: display.scaleFactor || 1,
          nativeWidth,
          nativeHeight,
        };
      }));
      
      return {
        type: 'multi',
        screens: screensData,
        virtualBounds: { x: minX, y: minY, width: totalWidth, height: totalHeight },
      };
    } else {
      const display = displays[0];
      const source = sourceByDisplayId.get(String(display.id)) || sources[0];
      const nativeWidth = Math.round(display.bounds.width * (display.scaleFactor || 1));
      const nativeHeight = Math.round(display.bounds.height * (display.scaleFactor || 1));
      const thumbnail = source.thumbnail.resize({
        width: nativeWidth,
        height: nativeHeight,
        quality: 'best',
      });

      // Single screen
      return {
        type: 'single',
        dataUrl: thumbnail.toDataURL(),
        bounds: display.bounds,
        scaleFactor: display.scaleFactor || 1,
      };
    }
  } catch (err) {
    console.error('Screen capture failed:', err);
    throw err;
  }
}

function createCaptureOverlays(captureData) {
  const displays = screen.getAllDisplays();

  displays.forEach((display) => {
    const win = new BrowserWindow({
      x: display.bounds.x,
      y: display.bounds.y,
      width: display.bounds.width,
      height: display.bounds.height,
      frame: false,
      transparent: false,
      backgroundColor: '#000000',
      hasShadow: false,
      skipTaskbar: true,
      resizable: false,
      movable: false,
      fullscreenable: true,
      enableLargerThanScreen: true,
      show: false,
      webPreferences: {
        preload: path.join(__dirname, 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });

    win.setAlwaysOnTop(true, 'screen-saver');
    win.loadFile(path.join(__dirname, 'capture-overlay.html'));

    win.webContents.once('did-finish-load', () => {
      win.setBounds({
        x: display.bounds.x,
        y: display.bounds.y,
        width: display.bounds.width,
        height: display.bounds.height,
      });
      win.show();

      // Send this display's specific screen data
      const screenData = captureData.type === 'multi'
        ? captureData.screens.find(s =>
            s.bounds.x === display.bounds.x &&
            s.bounds.y === display.bounds.y &&
            s.bounds.width === display.bounds.width &&
            s.bounds.height === display.bounds.height
          )
        : captureData;

      win.webContents.send('capture-data', {
        type: 'single',
        dataUrl: screenData ? screenData.dataUrl : captureData.dataUrl,
        bounds: display.bounds,
        scaleFactor: display.scaleFactor || 1,
      });
    });

    win.on('closed', () => {
      captureWindows = captureWindows.filter(w => w !== win);
    });

    captureWindows.push(win);
  });
}

// ── IPC Handlers ────────────────────────────────────────────────────────────

ipcMain.handle('start-capture', async () => {
  if (mainWindow) mainWindow.hide();
  
  // Small delay to ensure window is hidden
  await new Promise(r => setTimeout(r, 200));
  
  try {
    const captureData = await captureAllScreens();
    createCaptureOverlays(captureData);
    return { success: true };
  } catch (err) {
    if (mainWindow) mainWindow.show();
    return { success: false, error: err.message };
  }
});

ipcMain.handle('start-capture-window', async () => {
  if (mainWindow) mainWindow.hide();
  await new Promise(r => setTimeout(r, 200));
  
  try {
    const sources = await desktopCapturer.getSources({
      types: ['window'],
      thumbnailSize: { width: 3840, height: 2160 },
      fetchWindowIcons: false,
    });
    
    // Get the first non-pico window
    const source = sources.find(s => !s.name.includes('pico')) || sources[0];
    if (!source) {
      if (mainWindow) mainWindow.show();
      return { success: false, error: 'No window found' };
    }
    
    const dataUrl = source.thumbnail.toDataURL();
    if (mainWindow) {
      mainWindow.show();
      mainWindow.webContents.send('load-capture', dataUrl);
    }
    return { success: true };
  } catch (err) {
    if (mainWindow) mainWindow.show();
    return { success: false, error: err.message };
  }
});

ipcMain.handle('start-capture-fullscreen', async () => {
  if (mainWindow) mainWindow.hide();
  await new Promise(r => setTimeout(r, 200));
  
  try {
    const displays = screen.getAllDisplays();
    const maxScale = Math.max(...displays.map(d => d.scaleFactor || 1));
    
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    displays.forEach(d => {
      minX = Math.min(minX, d.bounds.x);
      minY = Math.min(minY, d.bounds.y);
      maxX = Math.max(maxX, d.bounds.x + d.bounds.width);
      maxY = Math.max(maxY, d.bounds.y + d.bounds.height);
    });
    const totalWidth = maxX - minX;
    const totalHeight = maxY - minY;
    
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: {
        width: Math.round(totalWidth * maxScale),
        height: Math.round(totalHeight * maxScale),
      },
    });
    
    const sourceByDisplayId = new Map();
    for (const source of sources) {
      if (source.display_id) sourceByDisplayId.set(String(source.display_id), source);
    }
    
    // Capture the primary display at native resolution
    const primary = screen.getPrimaryDisplay();
    const source = sourceByDisplayId.get(String(primary.id)) || sources[0];
    const nativeWidth = Math.round(primary.bounds.width * (primary.scaleFactor || 1));
    const nativeHeight = Math.round(primary.bounds.height * (primary.scaleFactor || 1));
    const thumbnail = source.thumbnail.resize({ width: nativeWidth, height: nativeHeight, quality: 'best' });
    const dataUrl = thumbnail.toDataURL();
    
    if (mainWindow) {
      mainWindow.show();
      mainWindow.webContents.send('load-capture', dataUrl);
    }
    return { success: true };
  } catch (err) {
    if (mainWindow) mainWindow.show();
    return { success: false, error: err.message };
  }
});

ipcMain.on('capture-complete', (event, imageDataUrl) => {
  captureWindows.forEach(w => { if (!w.isDestroyed()) w.close(); });
  captureWindows = [];
  if (mainWindow) {
    mainWindow.show();
    mainWindow.webContents.send('load-capture', imageDataUrl);
  }
});

ipcMain.on('capture-cancel', () => {
  captureWindows.forEach(w => { if (!w.isDestroyed()) w.close(); });
  captureWindows = [];
  if (mainWindow) {
    mainWindow.show();
  }
});

ipcMain.handle('open-file', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile'],
    filters: [
      { name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp', 'bmp', 'gif'] },
    ],
  });
  
  if (result.canceled || !result.filePaths[0]) {
    return null;
  }
  
  const filePath = result.filePaths[0];
  const buffer = fs.readFileSync(filePath);
  const ext = path.extname(filePath).toLowerCase().slice(1);
  const mime = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', bmp: 'image/bmp', gif: 'image/gif' }[ext] || 'image/png';
  
  return `data:${mime};base64,${buffer.toString('base64')}`;
});

ipcMain.handle('save-file', async (event, dataUrl) => {
  const result = await dialog.showSaveDialog(mainWindow, {
    defaultPath: `screenshot-${Date.now()}.png`,
    filters: [
      { name: 'PNG Image', extensions: ['png'] },
      { name: 'JPEG Image', extensions: ['jpg'] },
    ],
  });
  
  if (result.canceled || !result.filePath) {
    return { success: false };
  }
  
  try {
    const base64Data = dataUrl.replace(/^data:image\/\w+;base64,/, '');
    const buffer = Buffer.from(base64Data, 'base64');
    fs.writeFileSync(result.filePath, buffer);
    return { success: true, path: result.filePath };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('copy-to-clipboard', async (event, dataUrl) => {
  try {
    const image = nativeImage.createFromDataURL(dataUrl);
    clipboard.writeImage(image);
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('get-displays', () => {
  return screen.getAllDisplays();
});

// ── App Lifecycle ───────────────────────────────────────────────────────────

app.whenReady().then(() => {
  createMainWindow();

  // Register global shortcut for capture
  globalShortcut.register('CommandOrControl+Shift+S', () => {
    if (mainWindow) {
      mainWindow.webContents.send('trigger-capture');
    }
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow();
    }
  });
});

app.on('window-all-closed', () => {
  globalShortcut.unregisterAll();
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
});
