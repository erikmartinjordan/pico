/**
 * pico - Main Process
 * Handles window creation, screen capture, and native dialogs
 */

const { app, BrowserWindow, ipcMain, desktopCapturer, dialog, screen, globalShortcut, nativeImage, clipboard, Menu } = require('electron');
const { execSync, exec } = require('child_process');
const path = require('path');
const fs = require('fs');
const { scrollCapture } = require('./pro/scroll-capture');
const { tempRecordingPath, saveWebmFallback, convertWebmToMp4, convertMp4ToGif } = require('./pro/recording');

let mainWindow = null;
let captureWindows = [];
let windowPickerWindow = null;
let windowPickerSources = [];

async function composeImageParts(parts, width, height) {
  const compositor = new BrowserWindow({
    width: 1,
    height: 1,
    show: false,
    webPreferences: {
      offscreen: true,
      contextIsolation: false,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  try {
    await compositor.loadURL('data:text/html,<html><body></body></html>');
    const payload = parts.map((part) => ({
      dataUrl: part.image.toDataURL(),
      sourceY: part.sourceY,
      height: part.height,
    }));
    const dataUrl = await compositor.webContents.executeJavaScript(`
      (async () => {
        const parts = ${JSON.stringify(payload)};
        const canvas = document.createElement('canvas');
        canvas.width = ${Math.max(1, Math.round(width))};
        canvas.height = ${Math.max(1, Math.round(height))};
        const ctx = canvas.getContext('2d');
        let y = 0;
        for (const part of parts) {
          const img = new Image();
          img.src = part.dataUrl;
          await img.decode();
          ctx.drawImage(img, 0, part.sourceY, img.naturalWidth, part.height, 0, y, img.naturalWidth, part.height);
          y += part.height;
        }
        return canvas.toDataURL('image/png');
      })()
    `);
    return Buffer.from(dataUrl.replace(/^data:image\/png;base64,/, ''), 'base64');
  } finally {
    if (!compositor.isDestroyed()) compositor.destroy();
  }
}

global.picoComposeImageParts = composeImageParts;

async function getDefaultRecordingSource() {
  const primaryDisplay = screen.getPrimaryDisplay();
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: { width: 1, height: 1 },
  });
  return sources.find((source) => String(source.display_id) === String(primaryDisplay.id)) || sources[0];
}


function findBoundsForSource(source, boundsList) {
  if (!source || !Array.isArray(boundsList)) return null;
  const normalized = source.name.toLowerCase();
  return boundsList.find((bounds) => bounds.name === source.name) ||
    boundsList.find((bounds) => normalized.includes(bounds.name.toLowerCase()) || bounds.name.toLowerCase().includes(normalized)) ||
    null;
}

async function getProWindowSources() {
  const sources = await desktopCapturer.getSources({
    types: ['window'],
    thumbnailSize: { width: 480, height: 300 },
    fetchWindowIcons: false,
  });
  const boundsList = getVisibleWindowBounds();
  return sources
    .filter((source) => source && source.id && source.name && !source.name.toLowerCase().includes('pico'))
    .map((source) => ({
      id: source.id,
      name: source.name,
      thumbnail: source.thumbnail?.isEmpty() ? null : source.thumbnail.toDataURL(),
      bounds: findBoundsForSource(source, boundsList),
    }));
}

async function getWindowSourcesForPicker() {
  const sources = await desktopCapturer.getSources({
    types: ['window'],
    thumbnailSize: { width: 1920, height: 1200 },
    fetchWindowIcons: false,
  });
  const filtered = sources.filter((source) => source && source.name && !source.name.toLowerCase().includes('pico'));
  // Store full NativeImage references for later use on selection
  windowPickerSources = filtered;
  return filtered.map((source) => ({ id: source.id, name: source.name, thumbnail: source.thumbnail.toDataURL() }));
}

async function openWindowPickerFallback() {
  if (windowPickerWindow && !windowPickerWindow.isDestroyed()) {
    windowPickerWindow.focus();
    return { success: true, fallback: true };
  }

  windowPickerWindow = new BrowserWindow({
    width: 1100,
    height: 720,
    autoHideMenuBar: true,
    title: 'Select Window',
    resizable: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  windowPickerWindow.loadFile(path.join(__dirname, 'window-picker.html'));
  windowPickerWindow.on('closed', () => { windowPickerWindow = null; if (mainWindow) mainWindow.show(); });

  windowPickerWindow.webContents.once('did-finish-load', async () => {
    const sources = await getWindowSourcesForPicker();
    windowPickerWindow?.webContents.send('window-sources', sources);
  });

  return { success: true, fallback: true };
}


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
  // Use UIAutomation .NET assembly (pre-compiled, no CSC needed) with fallback to P/Invoke.
  // UIAutomation is much more reliable in packaged Electron apps where inline C# compilation
  // can be blocked by antivirus or restricted execution contexts.
  const psScript = `
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new()
try {
  Add-Type -AssemblyName UIAutomationClient
  Add-Type -AssemblyName UIAutomationTypes

  $root = [System.Windows.Automation.AutomationElement]::RootElement
  $cond = New-Object System.Windows.Automation.PropertyCondition(
    [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
    [System.Windows.Automation.ControlType]::Window
  )
  $windows = $root.FindAll([System.Windows.Automation.TreeScope]::Children, $cond)

  $results = @()
  foreach ($w in $windows) {
    try {
      if (-not $w.Current.IsOffscreen) {
        $rect = $w.Current.BoundingRectangle
        $name = $w.Current.Name
        if ([string]::IsNullOrWhiteSpace($name)) { continue }
        if ($rect.Width -lt 50 -or $rect.Height -lt 30) { continue }
        if ($rect.IsEmpty) { continue }
        $results += @{
          name = $name
          x = [int]$rect.X
          y = [int]$rect.Y
          width = [int]$rect.Width
          height = [int]$rect.Height
        }
      }
    } catch { continue }
  }

  if ($results.Count -eq 0) {
    Write-Output '[]'
  } else {
    $json = ConvertTo-Json -InputObject @($results) -Compress -Depth 2
    Write-Output $json
  }
} catch {
  Write-Error $_.Exception.Message
  Write-Output '[]'
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
      { encoding: 'utf8', timeout: 15000, windowsHide: true }
    );
    const trimmed = output.trim();
    if (!trimmed || !trimmed.startsWith('[')) {
      console.error('[pico] PS window enum: unexpected output:', trimmed.slice(0, 300));
      return [];
    }
    const result = JSON.parse(trimmed);
    // Windows 10/11: UIAutomation BoundingRectangle includes invisible DWM frame
    // and has asymmetric vertical chrome (title bar + drop shadow) that changes with theme/DPI.
    // Keep this as a single calibration block so we can tune capture alignment
    // without touching the rest of the capture pipeline.
    // No frame inset - use bounds as-is. The highlight will be slightly larger
    // than the visible window, giving a comfortable margin around it.
    const corrected = result;
    console.log(`[pico] UIAutomation window enum OK: ${corrected.length} windows found`);
    return corrected;
  } catch (e) {
    console.error('[pico] PS window enum failed:', e.message);
    if (e.stderr) console.error('[pico] stderr:', e.stderr.toString().slice(0, 500));
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

      // Convert window bounds to display-relative logical coordinates.
      // Electron's display.bounds is always in logical CSS pixels.
      // On Windows, DwmGetWindowAttribute returns physical pixels, so divide by scaleFactor first.
      // On macOS, Quartz CGWindowBounds are already in logical points, so use as-is.
      const displayWindowBounds = windowBounds
        .map((wb) => {
          // UIAutomation BoundingRectangle returns logical pixels (DIPs) that match
          // Electron's display.bounds coordinate space. Use directly without scaling.
          const dx1 = display.bounds.x;
          const dy1 = display.bounds.y;
          const dx2 = display.bounds.x + display.bounds.width;
          const dy2 = display.bounds.y + display.bounds.height;

          // Clip to this display and convert to display-relative coords
          const ix1 = Math.max(wb.x, dx1);
          const iy1 = Math.max(wb.y, dy1);
          const ix2 = Math.min(wb.x + wb.width, dx2);
          const iy2 = Math.min(wb.y + wb.height, dy2);
          if (ix2 - ix1 <= 0 || iy2 - iy1 <= 0) return null;

          return { name: wb.name, x: ix1 - dx1, y: iy1 - dy1, width: ix2 - ix1, height: iy2 - iy1 };
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
  if (mainWindow) mainWindow.hide();
  await new Promise(r => setTimeout(r, 200));

  try {
    const captureData = await captureAllScreens();
    createCaptureOverlays(captureData, 'region', []);
    return { success: true };
  } catch (err) {
    if (mainWindow) mainWindow.show();
    return { success: false, error: err.message };
  }
});

ipcMain.handle('start-capture-window', async () => {
  if (mainWindow) mainWindow.hide();
  await new Promise(r => setTimeout(r, 80));
  try {
    const captureData = await captureAllScreens();
    const winBounds = getVisibleWindowBounds();
    // Also fetch desktopCapturer window sources for reliable capture on click.
    // The overlay uses bounds for highlighting, but the actual capture uses the source thumbnail.
    const windowSources = await desktopCapturer.getSources({
      types: ['window'],
      thumbnailSize: { width: 1920, height: 1200 },
      fetchWindowIcons: false,
    });
    windowPickerSources = windowSources.filter(s => s && s.name && !s.name.toLowerCase().includes('pico'));
    createCaptureOverlays(captureData, 'window', winBounds);
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

ipcMain.on('window-overlay-select', async (event, windowName) => {
  // Use desktopCapturer to get a pixel-perfect capture of the selected window.
  // This avoids the frame inset guessing entirely.
  captureWindows.forEach(w => { if (!w.isDestroyed()) w.close(); });
  captureWindows = [];

  try {
    // Find matching source by name (best match)
    let selected = windowPickerSources.find(s => s.name === windowName);
    if (!selected) {
      // Fuzzy match: find source whose name contains the window name or vice versa
      selected = windowPickerSources.find(s =>
        s.name.includes(windowName) || windowName.includes(s.name)
      );
    }
    if (!selected) {
      // Re-fetch fresh sources as fallback
      const fresh = await desktopCapturer.getSources({ types: ['window'], thumbnailSize: { width: 1920, height: 1200 } });
      selected = fresh.find(s => s.name === windowName) ||
                 fresh.find(s => s.name.includes(windowName) || windowName.includes(s.name));
    }

    if (selected && !selected.thumbnail.isEmpty()) {
      const dataUrl = selected.thumbnail.toDataURL();
      windowPickerSources = [];
      copyDataUrlToClipboard(dataUrl);
      if (mainWindow) {
        mainWindow.show();
        mainWindow.webContents.send('load-capture', { dataUrl, source: 'capture', captureMode: 'window' });
      }
      return;
    }
  } catch (err) {
    console.error('[pico] window-overlay-select error:', err.message);
  }

  // Fallback: if no matching source found, just show main window
  windowPickerSources = [];
  if (mainWindow) mainWindow.show();
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


ipcMain.on('window-source-select', async (event, sourceId) => {
  try {
    // Use cached sources first (reliable), fall back to re-fetch
    let selected = windowPickerSources.find((s) => s.id === sourceId);
    if (!selected || selected.thumbnail.isEmpty()) {
      const freshSources = await desktopCapturer.getSources({ types: ['window'], thumbnailSize: { width: 1920, height: 1200 } });
      selected = freshSources.find((s) => s.id === sourceId);
    }
    if (!selected || selected.thumbnail.isEmpty()) {
      if (windowPickerWindow && !windowPickerWindow.isDestroyed()) windowPickerWindow.close();
      if (mainWindow) mainWindow.show();
      return;
    }
    const dataUrl = selected.thumbnail.toDataURL();
    if (windowPickerWindow && !windowPickerWindow.isDestroyed()) windowPickerWindow.close();
    windowPickerSources = [];
    copyDataUrlToClipboard(dataUrl);
    if (mainWindow) {
      mainWindow.show();
      mainWindow.webContents.send('load-capture', { dataUrl, source: 'capture', captureMode: 'window' });
    }
  } catch (err) {
    if (windowPickerWindow && !windowPickerWindow.isDestroyed()) windowPickerWindow.close();
    windowPickerSources = [];
    if (mainWindow) mainWindow.show();
  }
});

ipcMain.on('window-source-cancel', () => {
  if (windowPickerWindow && !windowPickerWindow.isDestroyed()) windowPickerWindow.close();
  windowPickerSources = [];
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


ipcMain.handle('pro-window-sources', async () => getProWindowSources());

ipcMain.handle('pro-scroll-capture', async (event, windowId) => {
  const sources = await getProWindowSources();
  const selected = sources.find((source) => source.id === windowId);
  const buffer = await scrollCapture(windowId, { bounds: selected?.bounds || null });
  return buffer;
});

ipcMain.handle('pro-recording-source', async () => {
  const source = await getDefaultRecordingSource();
  if (!source) throw new Error('No screen source available for recording');
  return { id: source.id, name: source.name };
});

ipcMain.handle('pro-save-recording', async (event, payload) => {
  const data = payload?.data;
  if (!data) throw new Error('Recording payload is empty');
  const webmPath = tempRecordingPath('webm');
  const bytes = Buffer.isBuffer(data) ? data : Buffer.from(data);
  fs.writeFileSync(webmPath, bytes);

  try {
    let mp4;
    try {
      mp4 = await convertWebmToMp4(webmPath);
    } catch (conversionError) {
      const webm = saveWebmFallback(webmPath);
      return {
        mp4: webm,
        warning: `MP4 conversion skipped: ${conversionError.message}`.slice(0, 240),
      };
    }

    const result = { mp4 };
    if (payload?.gif) {
      try {
        result.gif = await convertMp4ToGif(mp4);
      } catch (gifError) {
        result.warning = `GIF export skipped: ${gifError.message}`.slice(0, 240);
      }
    }
    return result;
  } finally {
    fs.rmSync(webmPath, { force: true });
  }
});

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
