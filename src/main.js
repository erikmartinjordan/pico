/**
 * pico - Main Process
 * Handles window creation, screen capture, and native dialogs
 */

const { app, BrowserWindow, ipcMain, desktopCapturer, dialog, screen, globalShortcut, nativeImage, clipboard, Menu } = require('electron');
const { execSync, exec } = require('child_process');
const path = require('path');
const fs = require('fs');

let mainWindow = null;
let captureWindows = [];

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
  copyDataUrlToClipboard(orderedScreens[0]?.dataUrl);
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
    console.error('Window enumeration failed:', err.message);
  }
  return [];
}

function getWindowBoundsWindows() {
  const psScript = `
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new()
Add-Type -Language CSharp -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;
using System.Collections.Generic;

public class PicoWinEnum {
    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr lp);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
    [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
    [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr h);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
    [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr h, int attr, out RECT rect, int size);
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
    [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr h, int index);
    [DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr h, uint cmd);
    public delegate bool EnumWindowsProc(IntPtr h, IntPtr l);
    [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }

    public struct WinInfo {
        public string name;
        public int x, y, width, height;
    }

    public static WinInfo[] Enumerate() {
        var results = new List<WinInfo>();
        EnumWindows((h, l) => {
            if (!IsWindowVisible(h) || IsIconic(h)) return true;
            if (GetWindowTextLength(h) == 0) return true;
            int exStyle = GetWindowLong(h, -20);
            if ((exStyle & 0x80) != 0) return true;
            var title = new StringBuilder(512);
            GetWindowText(h, title, 512);
            var name = title.ToString();
            if (string.IsNullOrWhiteSpace(name)) return true;
            RECT r;
            int sz = Marshal.SizeOf(typeof(RECT));
            if (DwmGetWindowAttribute(h, 9, out r, sz) != 0)
                GetWindowRect(h, out r);
            int w = r.Right - r.Left, ht = r.Bottom - r.Top;
            if (w < 50 || ht < 30) return true;
            results.Add(new WinInfo { name = name, x = r.Left, y = r.Top, width = w, height = ht });
            return true;
        }, IntPtr.Zero);
        return results.ToArray();
    }
}
'@
$wins = [PicoWinEnum]::Enumerate()
if ($wins.Count -eq 0) {
    Write-Output '[]'
} else {
    $json = ConvertTo-Json -InputObject @($wins) -Compress -Depth 2
    Write-Output $json
}
`;

  const tmpFile = path.join(app.getPath('temp'), 'pico-enum-win.ps1');
  try {
    fs.writeFileSync(tmpFile, psScript, { encoding: 'utf8' });
  } catch (e) {
    console.error('[pico] Cannot write temp PS script:', e.message);
    return [];
  }

  try {
    const output = execSync(
      `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "${tmpFile}"`,
      { encoding: 'utf8', timeout: 20000, windowsHide: true }
    );
    const trimmed = output.trim();
    if (!trimmed || !trimmed.startsWith('[')) {
      console.error('[pico] PS window enum: unexpected output:', trimmed.slice(0, 300));
      return [];
    }
    const result = JSON.parse(trimmed);
    console.log(`[pico] Window enum OK: ${result.length} windows found`);
    return result;
  } catch (e) {
    console.error('[pico] PS window enum failed:', e.message);
    if (e.stderr) console.error('[pico] stderr:', e.stderr.toString().slice(0, 500));
    if (e.status != null) console.error('[pico] exit code:', e.status);
    return [];
  } finally {
    try { fs.unlinkSync(tmpFile); } catch (e) {}
  }
}

function getWindowBoundsMac() {
  // Use Python3 with Quartz (pre-installed on macOS)
  const script = `
import json
try:
    from Quartz import CGWindowListCopyWindowInfo, kCGWindowListOptionOnScreenOnly, kCGWindowListExcludeDesktopElements, kCGNullWindowID
    wl = CGWindowListCopyWindowInfo(kCGWindowListOptionOnScreenOnly | kCGWindowListExcludeDesktopElements, kCGNullWindowID)
    r = []
    for w in wl:
        b = w.get('kCGWindowBounds', {})
        if w.get('kCGWindowLayer', 0) != 0: continue
        owner = w.get('kCGWindowOwnerName', '')
        name = w.get('kCGWindowName', '')
        title = (owner + ' - ' + name) if name else owner
        width, height = int(b.get('Width', 0)), int(b.get('Height', 0))
        if width < 50 or height < 30: continue
        r.append({'name': title, 'x': int(b.get('X', 0)), 'y': int(b.get('Y', 0)), 'width': width, 'height': height})
    print(json.dumps(r))
except Exception as ex:
    import sys
    print('[]')
    print(str(ex), file=sys.stderr)
`;
  try {
    const output = execSync(`python3 -c ${JSON.stringify(script)}`, {
      encoding: 'utf8', timeout: 5000
    });
    return JSON.parse(output.trim());
  } catch (e) {
    console.error('Mac window enum error:', e.message);
    return [];
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
  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.on('closed', () => { mainWindow = null; });
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
      if (!source) throw new Error(`No source for display ${display.id}`);
      const thumbnail = source.thumbnail.resize({
        width: display.bounds.width, height: display.bounds.height, quality: 'best',
      });
      return { dataUrl: thumbnail.toDataURL(), bounds: display.bounds, scaleFactor: display.scaleFactor || 1 };
    }));
    return { type: 'multi', screens: screensData, virtualBounds: { x: minX, y: minY, width: totalWidth, height: totalHeight }, maxScale };
  } else {
    const display = displays[0];
    const source = sourceByDisplayId.get(String(display.id)) || sources[0];
    const thumbnail = source.thumbnail.resize({
      width: display.bounds.width, height: display.bounds.height, quality: 'best',
    });
    return { type: 'single', dataUrl: thumbnail.toDataURL(), bounds: display.bounds, scaleFactor: display.scaleFactor || 1 };
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
        x: display.bounds.x, y: display.bounds.y,
        width: display.bounds.width, height: display.bounds.height,
      });
      win.show();

      const screenData = captureData.type === 'multi'
        ? captureData.screens.find(s =>
            s.bounds.x === display.bounds.x && s.bounds.y === display.bounds.y &&
            s.bounds.width === display.bounds.width && s.bounds.height === display.bounds.height
          )
        : captureData;

      // Convert window bounds to display-relative coordinates.
      const displayWindowBounds = windowBounds
        .map((wb) => {
          const scale = process.platform === 'win32' ? (display.scaleFactor || 1) : 1;
          const candidates = process.platform === 'win32'
            ? [
                { x: wb.x, y: wb.y, width: wb.width, height: wb.height },
                { x: wb.x / scale, y: wb.y / scale, width: wb.width / scale, height: wb.height / scale },
              ]
            : [{ x: wb.x, y: wb.y, width: wb.width, height: wb.height }];

          const dx1 = display.bounds.x;
          const dy1 = display.bounds.y;
          const dx2 = display.bounds.x + display.bounds.width;
          const dy2 = display.bounds.y + display.bounds.height;

          const intersectArea = (r) => {
            const rx2 = r.x + r.width;
            const ry2 = r.y + r.height;
            const ix1 = Math.max(r.x, dx1);
            const iy1 = Math.max(r.y, dy1);
            const ix2 = Math.min(rx2, dx2);
            const iy2 = Math.min(ry2, dy2);
            const iw = ix2 - ix1;
            const ih = iy2 - iy1;
            if (iw <= 0 || ih <= 0) return { area: 0, rect: null };
            return {
              area: iw * ih,
              rect: { x: ix1 - dx1, y: iy1 - dy1, width: iw, height: ih },
            };
          };

          const scored = candidates
            .map((c) => intersectArea(c))
            .sort((a, b) => b.area - a.area)[0];

          if (!scored || !scored.rect || scored.area <= 0) return null;
          return { name: wb.name, ...scored.rect };
        })
        .filter(Boolean);

      win.webContents.send('capture-data', {
        mode,
        type: 'single',
        dataUrl: screenData ? screenData.dataUrl : captureData.dataUrl,
        bounds: display.bounds,
        scaleFactor: display.scaleFactor || 1,
        windowBounds: displayWindowBounds,
      });
    });

    win.on('closed', () => { captureWindows = captureWindows.filter(w => w !== win); });
    captureWindows.push(win);
  });
}

// ── IPC Handlers ────────────────────────────────────────────────────────────

ipcMain.handle('start-capture', async () => {
  // Enumerate windows BEFORE hiding (so we see what's on screen)
  const windowBounds = getVisibleWindowBounds();
  console.log(`Window capture: found ${windowBounds.length} windows`);

  if (mainWindow) mainWindow.hide();
  await new Promise(r => setTimeout(r, 200));

  try {
    const captureData = await captureAllScreens();
    // Filter out pico itself
    const filtered = windowBounds.filter(wb =>
      !wb.name.toLowerCase().includes('pico') &&
      wb.name !== 'Select Window'
    );
    console.log(`Window capture: ${filtered.length} windows after filtering`);
    createCaptureOverlays(captureData, 'window', filtered);
    return { success: true };
  } catch (err) {
    if (mainWindow) mainWindow.show();
    return { success: false, error: err.message };
  }
});

ipcMain.handle('start-capture-window', async () => {
  // Enumerate windows BEFORE hiding (so we see what's on screen)
  const windowBounds = getVisibleWindowBounds();
  console.log(`Window capture: found ${windowBounds.length} windows`);

  if (mainWindow) mainWindow.hide();
  await new Promise(r => setTimeout(r, 200));

  try {
    const captureData = await captureAllScreens();
    // Filter out pico itself
    const filtered = windowBounds.filter(wb =>
      !wb.name.toLowerCase().includes('pico') &&
      wb.name !== 'Select Window'
    );
    console.log(`Window capture: ${filtered.length} windows after filtering`);
    createCaptureOverlays(captureData, 'window', filtered);
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
      dataUrl: imageDataUrl, source: 'capture', captureMode: 'region',
    });
  }
});

ipcMain.on('capture-cancel', () => {
  captureWindows.forEach(w => { if (!w.isDestroyed()) w.close(); });
  captureWindows = [];
  if (mainWindow) mainWindow.show();
});

ipcMain.handle('open-file', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile'],
    filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp', 'bmp', 'gif'] }],
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
    filters: [{ name: 'PNG Image', extensions: ['png'] }, { name: 'JPEG Image', extensions: ['jpg'] }],
  });
  if (result.canceled || !result.filePath) return { success: false };
  try {
    const base64Data = dataUrl.replace(/^data:image\/\w+;base64,/, '');
    fs.writeFileSync(result.filePath, Buffer.from(base64Data, 'base64'));
    return { success: true, path: result.filePath };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('copy-to-clipboard', async (event, dataUrl) => {
  try {
    clipboard.writeImage(nativeImage.createFromDataURL(dataUrl));
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

ipcMain.handle('get-displays', () => screen.getAllDisplays());

// ── App Lifecycle ───────────────────────────────────────────────────────────

app.whenReady().then(() => {
  createMainWindow();
  globalShortcut.register('CommandOrControl+Shift+S', () => {
    if (mainWindow) mainWindow.webContents.send('trigger-capture');
  });
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
  });
});

app.on('window-all-closed', () => {
  globalShortcut.unregisterAll();
  if (process.platform !== 'darwin') app.quit();
});

app.on('will-quit', () => globalShortcut.unregisterAll());
