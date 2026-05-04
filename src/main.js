/**
 * pico - Main Process
 * Handles window creation, screen capture, and native dialogs
 */

const { app, BrowserWindow, ipcMain, desktopCapturer, dialog, screen, globalShortcut, nativeImage, clipboard, Menu } = require('electron');
const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

let mainWindow = null;
let captureWindows = [];
let windowPicker = null;
let pendingWindowSources = [];

function copyDataUrlToClipboard(dataUrl) {
  if (!dataUrl) return;
  const image = nativeImage.createFromDataURL(dataUrl);
  clipboard.writeImage(image);
}

function copyCaptureDataToClipboard(captureData) {
  if (!captureData) return;
  if (captureData.type === 'single') {
    copyDataUrlToClipboard(captureData.dataUrl);
    return;
  }

  const orderedScreens = [...(captureData.screens || [])].sort((a, b) => {
    if (a.bounds.y !== b.bounds.y) return a.bounds.y - b.bounds.y;
    return a.bounds.x - b.bounds.x;
  });
  const dataUrl = orderedScreens[0]?.dataUrl;
  copyDataUrlToClipboard(dataUrl);
}

// ── Window Bounds Enumeration ───────────────────────────────────────────────

function getVisibleWindowBounds() {
  try {
    if (process.platform === 'win32') {
      return getWindowBoundsWindows();
    } else if (process.platform === 'darwin') {
      return getWindowBoundsMac();
    }
  } catch (err) {
    console.error('Failed to get window bounds:', err.message);
  }
  return [];
}

function getWindowBoundsWindows() {
  const psScript = `
[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new()
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
using System.Text;
using System.Collections.Generic;
public class WinEnum {
    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr lp);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
    [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, ref RECT r);
    [DllImport("user32.dll", CharSet=CharSet.Auto)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
    [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr h, int a, ref RECT r, int sz);
    public delegate bool EnumWindowsProc(IntPtr h, IntPtr l);
    [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
    public static string Run() {
        var list = new List<string>();
        EnumWindows((h, l) => {
            if (!IsWindowVisible(h) || IsIconic(h)) return true;
            var sb = new StringBuilder(256);
            GetWindowText(h, sb, 256);
            var name = sb.ToString();
            if (string.IsNullOrWhiteSpace(name)) return true;
            var r = new RECT();
            var dr = new RECT();
            int sz = Marshal.SizeOf(typeof(RECT));
            if (DwmGetWindowAttribute(h, 9, ref dr, sz) == 0) r = dr;
            else GetWindowRect(h, ref r);
            int w = r.Right - r.Left, ht = r.Bottom - r.Top;
            if (w < 100 || ht < 50) return true;
            name = name.Replace("\\","\\\\").Replace("\"","\\\"");
            list.Add("{\"name\":\""+name+"\",\"x\":"+r.Left+",\"y\":"+r.Top+",\"width\":"+w+",\"height\":"+ht+"}");
            return true;
        }, IntPtr.Zero);
        return "[" + string.Join(",", list) + "]";
    }
}
"@
[WinEnum]::Run()
`;
  const tmpFile = path.join(app.getPath('temp'), 'pico-windows.ps1');
  fs.writeFileSync(tmpFile, psScript, 'utf8');
  try {
    const output = execSync(`powershell -ExecutionPolicy Bypass -File "${tmpFile}"`, {
      encoding: 'utf8',
      timeout: 3000,
      windowsHide: true,
    });
    const cleaned = output.trim();
    if (!cleaned.startsWith('[')) return [];
    return JSON.parse(cleaned);
  } finally {
    try { fs.unlinkSync(tmpFile); } catch (e) {}
  }
}

function getWindowBoundsMac() {
  const pyScript = `
import json
try:
    from Quartz import CGWindowListCopyWindowInfo, kCGWindowListOptionOnScreenOnly, kCGWindowListExcludeDesktopElements, kCGNullWindowID
    windows = CGWindowListCopyWindowInfo(kCGWindowListOptionOnScreenOnly | kCGWindowListExcludeDesktopElements, kCGNullWindowID)
    result = []
    for w in windows:
        bounds = w.get('kCGWindowBounds', {})
        layer = w.get('kCGWindowLayer', 0)
        if layer != 0:
            continue
        owner = w.get('kCGWindowOwnerName', '')
        name = w.get('kCGWindowName', '')
        title = (owner + ' - ' + name) if name else owner
        width = int(bounds.get('Width', 0))
        height = int(bounds.get('Height', 0))
        if width < 100 or height < 50:
            continue
        result.append({'name': title, 'x': int(bounds.get('X', 0)), 'y': int(bounds.get('Y', 0)), 'width': width, 'height': height})
    print(json.dumps(result))
except Exception as e:
    print('[]')
`;
  const tmpFile = path.join(app.getPath('temp'), 'pico-windows.py');
  fs.writeFileSync(tmpFile, pyScript, 'utf8');
  try {
    const output = execSync(`python3 "${tmpFile}"`, { encoding: 'utf8', timeout: 3000 });
    return JSON.parse(output.trim());
  } finally {
    try { fs.unlinkSync(tmpFile); } catch (e) {}
  }
}

// ── Window Creation ─────────────────────────────────────────────────────────

function createMainWindow() {
  Menu.setApplicationMenu(null);

  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#0a0a0b',
    autoHideMenuBar: true,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    frame: process.platform !== 'darwin',
    trafficLightPosition: { x: 16, y: 16 },
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
    icon: path.join(__dirname, 'assets', 'icons', 'icon_512x512.png'),
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

    if (displays.length > 1) {
      const screensData = await Promise.all(displays.map(async (display) => {
        const source = sourceByDisplayId.get(String(display.id));
        if (!source) {
          throw new Error(`No screen source found for display ${display.id}`);
        }

        const thumbnail = source.thumbnail.resize({
          width: display.bounds.width,
          height: display.bounds.height,
          quality: 'best',
        });

        return {
          dataUrl: thumbnail.toDataURL(),
          bounds: display.bounds,
          scaleFactor: display.scaleFactor || 1,
        };
      }));
      
      return {
        type: 'multi',
        screens: screensData,
        virtualBounds: { x: minX, y: minY, width: totalWidth, height: totalHeight },
        maxScale,
      };
    } else {
      const display = displays[0];
      const source = sourceByDisplayId.get(String(display.id)) || sources[0];
      const thumbnail = source.thumbnail.resize({
        width: display.bounds.width,
        height: display.bounds.height,
        quality: 'best',
      });

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

function createCaptureOverlays(captureData, mode = 'region', windowBounds = []) {
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

      const screenData = captureData.type === 'multi'
        ? captureData.screens.find(s =>
            s.bounds.x === display.bounds.x &&
            s.bounds.y === display.bounds.y &&
            s.bounds.width === display.bounds.width &&
            s.bounds.height === display.bounds.height
          )
        : captureData;

      // Filter window bounds to those visible on this display
      const displayWindowBounds = windowBounds.filter(wb => {
        const wx2 = wb.x + wb.width;
        const wy2 = wb.y + wb.height;
        const dx2 = display.bounds.x + display.bounds.width;
        const dy2 = display.bounds.y + display.bounds.height;
        return wb.x < dx2 && wx2 > display.bounds.x && wb.y < dy2 && wy2 > display.bounds.y;
      }).map(wb => ({
        ...wb,
        // Convert to coordinates relative to this display
        x: wb.x - display.bounds.x,
        y: wb.y - display.bounds.y,
      }));

      win.webContents.send('capture-data', {
        mode,
        type: 'single',
        dataUrl: screenData ? screenData.dataUrl : captureData.dataUrl,
        bounds: display.bounds,
        scaleFactor: display.scaleFactor || 1,
        windowBounds: displayWindowBounds,
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
  // Get window bounds BEFORE hiding the main window
  const windowBounds = getVisibleWindowBounds();
  
  if (mainWindow) mainWindow.hide();
  await new Promise(r => setTimeout(r, 200));

  try {
    const captureData = await captureAllScreens();
    // Filter out pico's own window from bounds
    const filteredBounds = windowBounds.filter(wb => wb.name !== 'pico' && !wb.name.includes('pico'));
    createCaptureOverlays(captureData, 'window', filteredBounds);
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
    const captureData = await captureAllScreens();
    copyCaptureDataToClipboard(captureData);
    if (mainWindow) {
      mainWindow.show();
      mainWindow.webContents.send('load-capture-data', captureData);
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
  copyDataUrlToClipboard(imageDataUrl);
  if (mainWindow) {
    mainWindow.show();
    mainWindow.webContents.send('load-capture', {
      dataUrl: imageDataUrl,
      source: 'capture',
      captureMode: 'region',
    });
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
  
  if (result.canceled || !result.filePaths[0]) return null;
  
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
  
  if (result.canceled || !result.filePath) return { success: false };
  
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

ipcMain.handle('read-clipboard-image', async () => {
  try {
    const image = clipboard.readImage();
    if (image.isEmpty()) return null;
    return image.toDataURL();
  } catch (err) {
    return null;
  }
});

ipcMain.handle('get-displays', () => {
  return screen.getAllDisplays();
});

// ── App Lifecycle ───────────────────────────────────────────────────────────

app.whenReady().then(() => {
  createMainWindow();

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
