/**
 * pico - Main Process
 * Handles window creation, screen capture, and native dialogs
 */

const { app, BrowserWindow, ipcMain, desktopCapturer, dialog, screen, globalShortcut, nativeImage, clipboard, Menu } = require('electron');
const { execSync, exec } = require('child_process');
const path = require('path');
const fs = require('fs');
const { tempRecordingPath, saveWebmFallback, convertWebmToMp4, convertMp4ToGif } = require('./pro/recording');

let mainWindow = null;
let captureWindows = [];
let windowPickerWindow = null;
let windowPickerSources = [];
let recordingIndicatorWindow = null;
let recordingSourceSelection = null;

async function getDefaultRecordingSource() {
  const primaryDisplay = screen.getPrimaryDisplay();
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: { width: 1, height: 1 },
  });
  return sources.find((source) => String(source.display_id) === String(primaryDisplay.id)) || sources[0];
}



function isPicoWindowSource(source) {
  const id = String(source?.id || '');
  const name = String(source?.name || '').toLowerCase();
  return id.startsWith('window:') && name.includes('pico');
}

function toPickerSource(source) {
  const id = String(source?.id || '');
  const type = id.startsWith('screen:') ? 'screen' : 'window';
  const thumbnail = source?.thumbnail && !source.thumbnail.isEmpty()
    ? source.thumbnail.toDataURL()
    : '';
  return { id: source.id, name: source.name, type, thumbnail };
}

async function getDesktopSourcesForPicker(types = ['window']) {
  return desktopCapturer.getSources({
    types,
    thumbnailSize: { width: 1920, height: 1200 },
    fetchWindowIcons: false,
  });
}

async function getWindowSourcesForPicker() {
  const windowSources = (await getDesktopSourcesForPicker(['window']))
    .filter((source) => source && source.name && !isPicoWindowSource(source));

  let pickerSources = windowSources;
  let fallbackReason = '';

  if (pickerSources.length === 0) {
    // Some Windows/GPU combinations can fail to enumerate individual window
    // sources even though screen capture still works. Keep recording usable by
    // falling back to capturable screens instead of showing an empty picker.
    const screenSources = (await getDesktopSourcesForPicker(['screen']))
      .filter((source) => source && source.name);
    pickerSources = screenSources;
    fallbackReason = screenSources.length > 0
      ? 'No capturable windows were found. Select a screen to record instead.'
      : 'No capturable windows or screens were found.';
  }

  // Store full NativeImage references for later use on selection.
  windowPickerSources = pickerSources;
  return { sources: pickerSources.map(toPickerSource), fallbackReason };
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
  windowPickerWindow.on('closed', () => {
    windowPickerWindow = null;
    if (!recordingSourceSelection && mainWindow) mainWindow.show();
  });

  windowPickerWindow.webContents.once('did-finish-load', async () => {
    const payload = await getWindowSourcesForPicker();
    windowPickerWindow?.webContents.send('window-sources', payload);
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


function showRecordingIndicator() {
  if (recordingIndicatorWindow && !recordingIndicatorWindow.isDestroyed()) {
    recordingIndicatorWindow.showInactive();
    return;
  }

  const primaryDisplay = screen.getPrimaryDisplay();
  const { bounds, workArea } = primaryDisplay;
  const controlWidth = 276;
  const controlHeight = 54;
  recordingIndicatorWindow = new BrowserWindow({
    width: bounds.width,
    height: bounds.height,
    x: bounds.x,
    y: bounds.y,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    focusable: true,
    hasShadow: false,
    autoHideMenuBar: true,
    type: process.platform === 'darwin' ? 'panel' : undefined,
    webPreferences: {
      contextIsolation: false,
      nodeIntegration: true,
      sandbox: false,
    },
  });

  recordingIndicatorWindow.setAlwaysOnTop(true, 'screen-saver');
  recordingIndicatorWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  recordingIndicatorWindow.setContentProtection(true);
  recordingIndicatorWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(`
    <!DOCTYPE html>
    <html>
      <head>
        <style>
          * { box-sizing: border-box; }
          body {
            margin: 0;
            width: 100vw;
            height: 100vh;
            overflow: hidden;
            background: transparent;
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
            user-select: none;
          }
          .recording-glow {
            position: fixed;
            inset: 7px;
            border: 3px solid rgba(239, 68, 68, 0.95);
            border-radius: 18px;
            box-shadow:
              inset 0 0 20px rgba(248, 113, 113, 0.78),
              inset 0 0 44px rgba(220, 38, 38, 0.35),
              0 0 26px rgba(239, 68, 68, 0.82),
              0 0 62px rgba(127, 29, 29, 0.62);
            animation: glowPulse 1.25s ease-in-out infinite;
            pointer-events: none;
          }
          .recording-controls {
            position: fixed;
            left: ${Math.round(workArea.x - bounds.x + (workArea.width - controlWidth) / 2)}px;
            bottom: ${Math.max(12, Math.round(bounds.y + bounds.height - workArea.y - workArea.height + 16))}px;
            width: ${controlWidth}px;
            height: ${controlHeight}px;
            display: flex;
            align-items: center;
            justify-content: space-between;
            gap: 12px;
            padding: 8px 10px 8px 14px;
            border: 1px solid rgba(248, 113, 113, 0.45);
            border-radius: 999px;
            background: rgba(20, 20, 24, 0.90);
            color: #fee2e2;
            box-shadow: 0 18px 42px rgba(0,0,0,0.38), 0 0 24px rgba(239,68,68,0.35);
            backdrop-filter: blur(18px);
            pointer-events: auto;
          }
          .status { display: flex; align-items: center; gap: 9px; font-size: 13px; font-weight: 800; }
          .dot { width: 10px; height: 10px; border-radius: 50%; background: #ef4444; box-shadow: 0 0 0 0 rgba(248, 113, 113, 0.85); animation: dotPulse 1.1s ease-out infinite; }
          button {
            border: 0;
            border-radius: 999px;
            padding: 10px 16px;
            background: linear-gradient(135deg, #ef4444, #b91c1c);
            color: white;
            font-size: 13px;
            font-weight: 900;
            cursor: pointer;
          }
          button:hover { filter: brightness(1.08); }
          @keyframes glowPulse { 0%, 100% { opacity: 0.72; } 50% { opacity: 1; } }
          @keyframes dotPulse { 0% { box-shadow: 0 0 0 0 rgba(248, 113, 113, 0.85); } 80%, 100% { box-shadow: 0 0 0 10px rgba(248, 113, 113, 0); } }
        </style>
      </head>
      <body>
        <div class="recording-glow"></div>
        <div class="recording-controls">
          <div class="status"><span class="dot"></span><span>Recording</span></div>
          <button id="stop">Stop</button>
        </div>
        <script>
          const { ipcRenderer } = require('electron');
          const stop = document.getElementById('stop');
          stop.addEventListener('click', () => ipcRenderer.send('pro-recording-stop-clicked'));
        </script>
      </body>
    </html>
  `)}`);
  recordingIndicatorWindow.on('closed', () => { recordingIndicatorWindow = null; });
}
function hideRecordingIndicator() {
  if (recordingIndicatorWindow && !recordingIndicatorWindow.isDestroyed()) {
    recordingIndicatorWindow.close();
  }
  recordingIndicatorWindow = null;
}

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
    windowPickerSources = windowSources.filter(s => s && s.name && !isPicoWindowSource(s));
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
    // Use cached sources first (reliable), fall back to re-fetch. For recording,
    // a valid source id is enough; thumbnails are only required for screenshot
    // capture after the picker selection.
    let selected = windowPickerSources.find((s) => s.id === sourceId);
    if (!selected) {
      const sourceTypes = String(sourceId).startsWith('screen:') ? ['screen'] : ['window'];
      const freshSources = await getDesktopSourcesForPicker(sourceTypes);
      selected = freshSources.find((s) => s.id === sourceId);
    }
    if (!selected) {
      if (windowPickerWindow && !windowPickerWindow.isDestroyed()) windowPickerWindow.close();
      windowPickerSources = [];
      recordingSourceSelection?.resolve(null);
      recordingSourceSelection = null;
      if (mainWindow) mainWindow.show();
      return;
    }
    if (windowPickerWindow && !windowPickerWindow.isDestroyed()) windowPickerWindow.close();
    windowPickerSources = [];

    if (recordingSourceSelection) {
      recordingSourceSelection.resolve({ id: selected.id, name: selected.name });
      recordingSourceSelection = null;
      return;
    }

    if (!selected.thumbnail || selected.thumbnail.isEmpty()) {
      if (mainWindow) mainWindow.show();
      return;
    }

    const dataUrl = selected.thumbnail.toDataURL();
    copyDataUrlToClipboard(dataUrl);
    if (mainWindow) {
      mainWindow.show();
      mainWindow.webContents.send('load-capture', { dataUrl, source: 'capture', captureMode: 'window' });
    }
  } catch (err) {
    if (windowPickerWindow && !windowPickerWindow.isDestroyed()) windowPickerWindow.close();
    windowPickerSources = [];
    recordingSourceSelection?.reject(err);
    recordingSourceSelection = null;
    if (mainWindow) mainWindow.show();
  }
});

ipcMain.on('window-source-cancel', () => {
  if (windowPickerWindow && !windowPickerWindow.isDestroyed()) windowPickerWindow.close();
  windowPickerSources = [];
  recordingSourceSelection?.resolve(null);
  recordingSourceSelection = null;
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


ipcMain.handle('pro-recording-indicator-show', async () => {
  showRecordingIndicator();
  return { success: true };
});

ipcMain.handle('pro-recording-indicator-hide', async () => {
  hideRecordingIndicator();
  return { success: true };
});

function chooseRecordingWindowSource() {
  if (recordingSourceSelection) return recordingSourceSelection.promise;

  const promise = new Promise(async (resolve, reject) => {
    recordingSourceSelection = { resolve, reject, promise: null };
    try {
      if (mainWindow) mainWindow.hide();
      const opened = await openWindowPickerFallback();
      if (!opened?.success) throw new Error('Unable to open the window picker');
    } catch (error) {
      recordingSourceSelection = null;
      reject(error);
    }
  });
  recordingSourceSelection.promise = promise;
  return promise;
}

ipcMain.handle('pro-recording-source', async () => {
  const source = await chooseRecordingWindowSource();
  if (!source) return null;
  return { id: source.id, name: source.name };
});

ipcMain.handle('pro-save-recording', async (event, payload) => {
  const data = payload?.data;
  if (!data) throw new Error('Recording payload is empty');

  const format = payload?.format === 'gif' || payload?.gif ? 'gif' : 'mp4';
  const extension = format === 'gif' ? 'gif' : 'mp4';
  const saveResult = await dialog.showSaveDialog(mainWindow, {
    title: 'Save screen recording',
    defaultPath: path.join(app.getPath('videos'), `pico-recording-${Date.now()}.${extension}`),
    buttonLabel: 'Save Recording',
    filters: format === 'gif'
      ? [{ name: 'GIF Animation', extensions: ['gif'] }]
      : [{ name: 'MP4 Video', extensions: ['mp4'] }],
  });
  if (saveResult.canceled || !saveResult.filePath) return { canceled: true };

  const webmPath = tempRecordingPath('webm');
  const bytes = Buffer.isBuffer(data) ? data : Buffer.from(data);
  fs.writeFileSync(webmPath, bytes);

  try {
    let mp4Path = saveResult.filePath;
    if (format === 'gif') mp4Path = tempRecordingPath('mp4');

    let mp4;
    try {
      mp4 = await convertWebmToMp4(webmPath, mp4Path);
    } catch (conversionError) {
      const webm = saveWebmFallback(webmPath, saveResult.filePath);
      return {
        webm,
        warning: `${format.toUpperCase()} conversion skipped: ${conversionError.message}`.slice(0, 240),
      };
    }

    if (format === 'gif') {
      try {
        return { gif: await convertMp4ToGif(mp4, saveResult.filePath) };
      } finally {
        fs.rmSync(mp4, { force: true });
      }
    }

    return { mp4 };
  } finally {
    fs.rmSync(webmPath, { force: true });
  }
});


ipcMain.on('pro-recording-stop-clicked', () => {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('pro-recording-stop-requested');
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
