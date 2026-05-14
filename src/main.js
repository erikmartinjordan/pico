/**
 * pico - Main Process
 * Handles window creation, screen capture, and native dialogs
 */

const { app, BrowserWindow, ipcMain, desktopCapturer, dialog, screen, globalShortcut, nativeImage, clipboard, Menu, shell, systemPreferences } = require('electron');
const { execSync, exec, execFile } = require('child_process');
const path = require('path');
const fs = require('fs');
const { tempRecordingPath, convertWebmToMp4, convertMp4ToGif } = require('./pro/recording');

let mainWindow = null;
let captureWindows = [];
let windowPickerWindow = null;
let windowPickerSources = [];
let recordingIndicatorWindows = [];
let recordingSourceSelection = null;
let recordingRegionSelection = null;
let lastRecordingSourceId = null;
let lastRecordingRegion = null;


function getMacScreenRecordingStatus() {
  if (process.platform !== 'darwin') return 'granted';
  try {
    return systemPreferences.getMediaAccessStatus('screen');
  } catch (err) {
    console.error('[pico] macOS screen recording permission check failed:', err.message);
    return 'unknown';
  }
}

async function openMacScreenRecordingSettings() {
  if (process.platform !== 'darwin') return;
  await shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture');
}

async function explainMacScreenRecordingPermission() {
  if (process.platform !== 'darwin') return;
  const result = await dialog.showMessageBox(mainWindow, {
    type: 'warning',
    buttons: ['Open System Settings', 'Not Now'],
    defaultId: 0,
    cancelId: 1,
    title: 'Screen Recording permission required',
    message: 'pico needs macOS Screen Recording permission to capture the screen.',
    detail: 'Open System Settings → Privacy & Security → Screen & System Audio Recording, enable pico, then quit and reopen the app before trying again.',
  });
  if (result.response === 0) await openMacScreenRecordingSettings();
}

async function ensureMacScreenRecordingPermission() {
  if (process.platform !== 'darwin') return true;
  const status = getMacScreenRecordingStatus();
  if (status === 'granted') return true;

  // Let a first capture attempt trigger Apple's TCC prompt when macOS still has
  // not made a decision. For explicit denials, fail fast with useful guidance.
  if (status === 'not-determined' || status === 'unknown') return true;

  await explainMacScreenRecordingPermission();
  return false;
}

async function getDefaultRecordingSource() {
  const primaryDisplay = screen.getPrimaryDisplay();
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: { width: 1, height: 1 },
  });
  return sources.find((source) => String(source.display_id) === String(primaryDisplay.id)) || sources[0];
}



function nativeMacWindowCapturePath() {
  return path.join(app.getPath('temp'), `pico-window-${process.pid}-${Date.now()}.png`);
}

function runNativeMacWindowCapture(filePath) {
  return new Promise((resolve, reject) => {
    execFile('/usr/sbin/screencapture', ['-i', '-w', '-x', '-t', 'png', filePath], (error, stdout, stderr) => {
      if (error) {
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

function readImageFileAsDataUrl(filePath) {
  const buffer = fs.readFileSync(filePath);
  return `data:image/png;base64,${buffer.toString('base64')}`;
}

async function captureNativeMacWindow() {
  if (process.platform !== 'darwin') return null;
  const filePath = nativeMacWindowCapturePath();
  try {
    await runNativeMacWindowCapture(filePath);
    if (!fs.existsSync(filePath) || fs.statSync(filePath).size === 0) {
      return { success: true, canceled: true };
    }
    const dataUrl = readImageFileAsDataUrl(filePath);
    copyDataUrlToClipboard(dataUrl);
    if (mainWindow) {
      mainWindow.show();
      mainWindow.focus();
      mainWindow.webContents.send('load-capture', {
        dataUrl,
        source: 'capture',
        captureMode: 'window',
      });
    }
    return { success: true };
  } catch (err) {
    if (!fs.existsSync(filePath) || fs.statSync(filePath).size === 0) {
      return { success: true, canceled: true };
    }
    console.error('[pico] native macOS window capture failed:', err.message, err.stderr || '');
    throw err;
  } finally {
    try { fs.unlinkSync(filePath); } catch (e) {}
    if (mainWindow && !mainWindow.isVisible()) mainWindow.show();
  }
}

function getHighQualityThumbnailSize(minWidth = 1920, minHeight = 1200) {
  const displays = screen.getAllDisplays();
  if (!displays.length) return { width: minWidth, height: minHeight };
  const maxScale = Math.max(...displays.map((display) => display.scaleFactor || 1));
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const display of displays) {
    minX = Math.min(minX, display.bounds.x);
    minY = Math.min(minY, display.bounds.y);
    maxX = Math.max(maxX, display.bounds.x + display.bounds.width);
    maxY = Math.max(maxY, display.bounds.y + display.bounds.height);
  }
  return {
    width: Math.max(minWidth, Math.ceil((maxX - minX) * maxScale)),
    height: Math.max(minHeight, Math.ceil((maxY - minY) * maxScale)),
  };
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
    thumbnailSize: getHighQualityThumbnailSize(),
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

  windowPickerWindow.loadFile(path.join(__dirname, 'renderer', 'window-picker.html'));
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
        $handle = [int64]$w.Current.NativeWindowHandle
        $pid = [int]$w.Current.ProcessId
        $sourceIds = @()
        if ($handle -gt 0 -and $pid -gt 0) { $sourceIds += "window:$($handle):$($pid)" }
        if ($handle -gt 0) { $sourceIds += "window:$($handle):0" }
        $results += @{
          name = $name
          x = [int]$rect.X
          y = [int]$rect.Y
          width = [int]$rect.Width
          height = [int]$rect.Height
          windowId = $handle
          processId = $pid
          sourceIds = $sourceIds
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
  // Prefer Quartz CGWindow metadata because it matches desktopCapturer window ids.
  // Run a Python 2/3 compatible script so the legacy Intel build works on older
  // macOS installs that still expose PyObjC through /usr/bin/python, while new
  // Apple Silicon Macs can use python3 when available.
  const script = `
import json
import sys
try:
    from Quartz import CGWindowListCopyWindowInfo, kCGWindowListOptionOnScreenOnly, kCGWindowListExcludeDesktopElements, kCGNullWindowID
    wl = CGWindowListCopyWindowInfo(kCGWindowListOptionOnScreenOnly | kCGWindowListExcludeDesktopElements, kCGNullWindowID)
    r = []
    for w in wl:
        b = w.get('kCGWindowBounds', {})
        if w.get('kCGWindowLayer', 0) != 0: continue
        owner = w.get('kCGWindowOwnerName', '') or ''
        name = w.get('kCGWindowName', '') or ''
        title = (owner + ' - ' + name) if name else owner
        width, height = int(b.get('Width', 0)), int(b.get('Height', 0))
        window_id = int(w.get('kCGWindowNumber', 0) or 0)
        owner_pid = int(w.get('kCGWindowOwnerPID', 0) or 0)
        if width < 50 or height < 30: continue
        if window_id <= 0: continue
        source_ids = ['window:%s:0' % window_id]
        if owner_pid > 0:
            source_ids.append('window:%s:%s' % (window_id, owner_pid))
        r.append({
            'name': title,
            'owner': owner,
            'title': name,
            'x': int(b.get('X', 0)),
            'y': int(b.get('Y', 0)),
            'width': width,
            'height': height,
            'windowId': window_id,
            'processId': owner_pid,
            'sourceIds': source_ids,
        })
    sys.stdout.write(json.dumps(r))
except Exception as ex:
    sys.stdout.write('[]')
    sys.stderr.write(str(ex))
`;
  const interpreters = ['python3', '/usr/bin/python3', '/usr/bin/python'];
  for (const interpreter of interpreters) {
    try {
      const output = execSync(`${interpreter} -c ${JSON.stringify(script)}`, {
        encoding: 'utf8', timeout: 5000
      });
      const parsed = JSON.parse(output.trim() || '[]');
      if (parsed.length > 0) return parsed;
    } catch (e) {
      console.error(`Mac window enum error via ${interpreter}:`, e.message);
    }
  }
  return [];
}

function normalizeWindowName(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[\u2013\u2014]/g, '-')
    .replace(/\s+/g, ' ')
    .trim();
}

function getDesktopCapturerWindowKey(source) {
  const match = String(source?.id || '').match(/^window:(\d+):/);
  return match ? match[1] : null;
}

function sourceNameMatchesWindow(sourceName, win) {
  const source = normalizeWindowName(sourceName);
  const full = normalizeWindowName(win.name);
  const owner = normalizeWindowName(win.owner);
  const title = normalizeWindowName(win.title);
  if (!source) return false;
  return source === full ||
    (title && source === title) ||
    (owner && source === owner) ||
    (title && source.includes(title)) ||
    (full && full.includes(source));
}

function attachCapturerSourcesToWindowBounds(windowBounds, capturerSources) {
  const sources = (capturerSources || []).filter((source) => source && source.id && source.name && !isPicoWindowSource(source));
  if (sources.length === 0) return windowBounds;

  return windowBounds.map((win) => {
    const sourceIds = Array.isArray(win.sourceIds) ? win.sourceIds : [win.sourceIds].filter(Boolean);
    const candidateIds = new Set(sourceIds.map(String));
    let source = sources.find((item) => candidateIds.has(String(item.id)));

    if (!source && win.windowId) {
      const windowId = String(win.windowId);
      source = sources.find((item) => getDesktopCapturerWindowKey(item) === windowId);
    }

    if (!source) {
      source = sources.find((item) => sourceNameMatchesWindow(item.name, win));
    }

    return source
      ? { ...win, sourceId: source.id, sourceName: source.name }
      : win;
  });
}

// ── Window Creation ─────────────────────────────────────────────────────────


function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function showRecordingIndicator() {
  if (recordingIndicatorWindows.length > 0) {
    recordingIndicatorWindows.forEach(w => { if (!w.isDestroyed()) w.showInactive(); });
    return;
  }

  // Determine which display should show the stop controls
  let targetDisplay = screen.getPrimaryDisplay();
  if (lastRecordingRegion?.displayId) {
    const allDisplays = screen.getAllDisplays();
    const matched = allDisplays.find(d => String(d.id) === String(lastRecordingRegion.displayId));
    if (matched) targetDisplay = matched;
  } else if (lastRecordingSourceId) {
    const sourceIdStr = String(lastRecordingSourceId);
    if (sourceIdStr.startsWith('screen:')) {
      const parts = sourceIdStr.split(':');
      const displayId = parts[1];
      const allDisplays = screen.getAllDisplays();
      const matched = allDisplays.find(d => String(d.id) === displayId);
      if (matched) targetDisplay = matched;
    } else {
      const cursorPoint = screen.getCursorScreenPoint();
      targetDisplay = screen.getDisplayNearestPoint(cursorPoint);
    }
  }

  const controlWidth = 276;
  const controlHeight = 54;
  const allDisplays = screen.getAllDisplays();

  for (const display of allDisplays) {
    const { bounds, workArea } = display;
    const isTarget = display.id === targetDisplay.id;

    const indicatorWindow = new BrowserWindow({
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
      focusable: isTarget,
      hasShadow: false,
      autoHideMenuBar: true,
      type: process.platform === 'darwin' ? 'panel' : undefined,
      webPreferences: {
        contextIsolation: false,
        nodeIntegration: true,
        sandbox: false,
      },
    });

    indicatorWindow.setAlwaysOnTop(true, 'screen-saver');
    indicatorWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    indicatorWindow.setContentProtection(true);

    const controlsLeft = Math.round(workArea.x - bounds.x + (workArea.width - controlWidth) / 2);
    const controlsBottom = Math.max(12, Math.round(bounds.y + bounds.height - workArea.y - workArea.height + 16));
    const regionOnDisplay = lastRecordingRegion && String(lastRecordingRegion.displayId) === String(display.id)
      ? {
          left: Math.max(0, Math.round(lastRecordingRegion.x)),
          top: Math.max(0, Math.round(lastRecordingRegion.y)),
          width: Math.max(1, Math.round(lastRecordingRegion.width)),
          height: Math.max(1, Math.round(lastRecordingRegion.height)),
        }
      : null;
    if (regionOnDisplay) {
      regionOnDisplay.right = Math.max(0, bounds.width - regionOnDisplay.left - regionOnDisplay.width);
      regionOnDisplay.bottom = Math.max(0, bounds.height - regionOnDisplay.top - regionOnDisplay.height);
    }
    const dimOpacity = 'rgba(0, 0, 0, 0.52)';
    const dimBlocks = regionOnDisplay ? `
          <div class="recording-dim" style="left:0;top:0;width:100%;height:${regionOnDisplay.top}px"></div>
          <div class="recording-dim" style="left:0;top:${regionOnDisplay.top}px;width:${regionOnDisplay.left}px;height:${regionOnDisplay.height}px"></div>
          <div class="recording-dim" style="right:0;top:${regionOnDisplay.top}px;width:${regionOnDisplay.right}px;height:${regionOnDisplay.height}px"></div>
          <div class="recording-dim" style="left:0;bottom:0;width:100%;height:${regionOnDisplay.bottom}px"></div>`
      : (lastRecordingRegion ? '<div class="recording-dim full"></div>' : '');
    const glowStyle = regionOnDisplay
      ? `left:${regionOnDisplay.left}px;top:${regionOnDisplay.top}px;width:${regionOnDisplay.width}px;height:${regionOnDisplay.height}px;border-radius:14px;`
      : 'inset:0;border-radius:0;';
    const statusText = lastRecordingRegion ? 'Recording region' : 'Recording';

    indicatorWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(`
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
          .recording-dim {
            position: fixed;
            background: ${dimOpacity};
            backdrop-filter: blur(1px);
            pointer-events: none;
          }
          .recording-dim.full { inset: 0; }
          .recording-glow {
            position: fixed;
            ${glowStyle}
            border: 3px solid rgba(239, 68, 68, 0.96);
            box-shadow:
              inset 0 0 30px rgba(248, 113, 113, 0.6),
              inset 0 0 60px rgba(220, 38, 38, 0.25),
              0 0 20px rgba(239, 68, 68, 0.7);
            animation: glowPulse 1.25s ease-in-out infinite;
            pointer-events: none;
          }
          .recording-controls {
            position: fixed;
            left: ${controlsLeft}px;
            bottom: ${controlsBottom}px;
            width: ${controlWidth}px;
            height: ${controlHeight}px;
            display: ${isTarget ? 'flex' : 'none'};
            align-items: center;
            justify-content: space-between;
            gap: 12px;
            padding: 8px 12px 8px 14px;
            border: 1px solid rgba(255, 255, 255, 0.10);
            border-radius: 12px;
            background: rgba(14, 14, 17, 0.92);
            color: #f5f0eb;
            box-shadow: 0 8px 32px rgba(0,0,0,0.6), 0 1px 0 rgba(255,255,255,0.04) inset;
            backdrop-filter: blur(20px);
            pointer-events: auto;
          }
          .status { display: flex; align-items: center; gap: 9px; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 11px; font-weight: 700; letter-spacing: 0.04em; color: rgba(255,255,255,0.7); }
          .dot { width: 10px; height: 10px; border-radius: 50%; background: #ef4444; box-shadow: 0 0 0 0 rgba(248, 113, 113, 0.85); animation: dotPulse 1.1s ease-out infinite; }
          button {
            border: 1px solid rgba(255, 255, 255, 0.12);
            border-radius: 8px;
            padding: 8px 14px;
            background: rgba(30, 31, 36, 0.95);
            color: #fecaca;
            font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
            font-size: 11px;
            font-weight: 700;
            letter-spacing: 0.04em;
            cursor: pointer;
            transition: background 0.12s, border-color 0.12s;
            display: flex;
            align-items: center;
            gap: 6px;
          }
          button::before {
            content: '';
            width: 8px;
            height: 8px;
            border-radius: 2px;
            background: #ef4444;
            flex-shrink: 0;
          }
          button:hover {
            background: rgba(239, 68, 68, 0.15);
            border-color: rgba(239, 68, 68, 0.5);
          }
          @keyframes glowPulse { 0%, 100% { opacity: 0.78; } 50% { opacity: 1; } }
          @keyframes dotPulse { 0% { box-shadow: 0 0 0 0 rgba(248, 113, 113, 0.85); } 80%, 100% { box-shadow: 0 0 0 10px rgba(248, 113, 113, 0); } }
        </style>
      </head>
      <body>
        ${dimBlocks}
        <div class="recording-glow"></div>
        <div class="recording-controls">
          <div class="status"><span class="dot"></span><span>${escapeHtml(statusText)}</span></div>
          <button id="stop">Stop</button>
        </div>
        <script>
          const { ipcRenderer } = require('electron');
          const stop = document.getElementById('stop');
          if (stop) stop.addEventListener('click', () => ipcRenderer.send('pro-recording-stop-clicked'));
        </script>
      </body>
    </html>
  `)}`);

    indicatorWindow.on('closed', () => {
      recordingIndicatorWindows = recordingIndicatorWindows.filter(w => w !== indicatorWindow);
    });

    recordingIndicatorWindows.push(indicatorWindow);
  }

  // Minimize pico main window so user can navigate other apps while recording
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.minimize();
  }
}

function hideRecordingIndicator() {
  for (const w of recordingIndicatorWindows) {
    if (!w.isDestroyed()) w.close();
  }
  recordingIndicatorWindows = [];
  lastRecordingSourceId = null;
  lastRecordingRegion = null;

  // Restore pico main window when recording ends
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.restore();
    mainWindow.show();
  }
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
    icon: path.join(__dirname, 'assets', 'icons', 'linux', 'icons', '512x512.png'),
    show: false,
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.on('closed', () => { mainWindow = null; });
}

// ── Screen Capture ──────────────────────────────────────────────────────────

function getNativeImagePixelSize(image) {
  if (!image || image.isEmpty()) return { width: 0, height: 0 };
  const bitmapSize = typeof image.getBitmapSize === 'function' ? image.getBitmapSize() : null;
  const size = bitmapSize && bitmapSize.width > 0 && bitmapSize.height > 0
    ? bitmapSize
    : image.getSize();
  return { width: Math.round(size.width), height: Math.round(size.height) };
}

function getSourceForDisplay(sourceByDisplayId, sources, display, index) {
  return sourceByDisplayId.get(String(display.id)) || sources[index] || sources[0];
}

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
  const maxDisplayWidth = Math.max(...displays.map(d => d.bounds.width * (d.scaleFactor || 1)));
  const maxDisplayHeight = Math.max(...displays.map(d => d.bounds.height * (d.scaleFactor || 1)));

  // Request a thumbnail large enough for the largest physical display and then
  // keep Electron's returned bitmap size. Resizing to logical bounds breaks
  // Retina/HiDPI captures on modern Macs, while this remains compatible with
  // the legacy x64 macOS build where getBitmapSize may not exist.
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: {
      width: Math.ceil(maxDisplayWidth),
      height: Math.ceil(maxDisplayHeight),
    },
  });

  if (sources.length === 0 || sources.every((source) => !source.thumbnail || source.thumbnail.isEmpty())) {
    if (process.platform === 'darwin') await explainMacScreenRecordingPermission();
    throw new Error('No capturable screen sources were returned.');
  }

  const sourceByDisplayId = new Map();
  for (const source of sources) {
    if (source.display_id) sourceByDisplayId.set(String(source.display_id), source);
  }

  const screensData = displays.map((display, index) => {
    const source = getSourceForDisplay(sourceByDisplayId, sources, display, index);
    if (!source || !source.thumbnail || source.thumbnail.isEmpty()) {
      throw new Error(`No source for display ${display.id}`);
    }
    const pixelSize = getNativeImagePixelSize(source.thumbnail);
    const scaleFactor = pixelSize.width > 0 && display.bounds.width > 0
      ? pixelSize.width / display.bounds.width
      : (display.scaleFactor || 1);
    return {
      dataUrl: source.thumbnail.toDataURL(),
      sourceId: source.id,
      bounds: display.bounds,
      scaleFactor,
      pixelSize,
      displayId: display.id,
    };
  });

  if (displays.length > 1) {
    return {
      type: 'multi',
      screens: screensData,
      virtualBounds: { x: minX, y: minY, width: totalWidth, height: totalHeight },
      maxScale,
    };
  }

  const screenData = screensData[0];
  return {
    type: 'single',
    dataUrl: screenData.dataUrl,
    sourceId: screenData.sourceId,
    bounds: screenData.bounds,
    scaleFactor: screenData.scaleFactor,
    pixelSize: screenData.pixelSize,
    displayId: screenData.displayId,
  };
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
    win.loadFile(path.join(__dirname, 'renderer', 'capture-overlay.html'));

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

          return {
            ...wb,
            x: ix1 - dx1,
            y: iy1 - dy1,
            width: ix2 - ix1,
            height: iy2 - iy1,
          };
        })
        .filter(Boolean);

      win.webContents.send('capture-data', {
        mode,
        type: 'single',
        dataUrl: screenData ? screenData.dataUrl : captureData.dataUrl,
        bounds: display.bounds,
        scaleFactor: screenData?.scaleFactor || display.scaleFactor || 1,
        pixelSize: screenData?.pixelSize,
        displayId: screenData?.displayId || display.id,
        sourceId: screenData?.sourceId,
        windowBounds: displayWindowBounds,
        platform: process.platform,
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
    if (!await ensureMacScreenRecordingPermission()) {
      if (mainWindow) mainWindow.show();
      return { success: false, error: 'Screen Recording permission is required.' };
    }
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
  await new Promise(r => setTimeout(r, process.platform === 'darwin' ? 180 : 80));
  try {
    if (process.platform === 'darwin') {
      return await captureNativeMacWindow();
    }

    const captureData = await captureAllScreens();
    // Fetch capturer sources before showing the overlay. Native source ids let the
    // overlay select the exact window on macOS/Windows instead of relying on names.
    const windowSources = await desktopCapturer.getSources({
      types: ['window'],
      thumbnailSize: getHighQualityThumbnailSize(),
      fetchWindowIcons: false,
    });
    windowPickerSources = windowSources.filter(s => s && s.name && !isPicoWindowSource(s));

    const winBounds = attachCapturerSourcesToWindowBounds(getVisibleWindowBounds(), windowPickerSources)
      .filter((win) => win.sourceId || process.platform !== 'darwin');

    if (winBounds.length === 0) {
      return openWindowPickerFallback();
    }

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
    if (!await ensureMacScreenRecordingPermission()) {
      if (mainWindow) mainWindow.show();
      return { success: false, error: 'Screen Recording permission is required.' };
    }
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
      const fresh = await desktopCapturer.getSources({ types: ['window'], thumbnailSize: getHighQualityThumbnailSize() });
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
  if (recordingRegionSelection) {
    recordingRegionSelection.resolve(null);
    recordingRegionSelection = null;
    if (mainWindow) mainWindow.show();
    return;
  }
  if (mainWindow) mainWindow.show();
});

ipcMain.on('recording-region-complete', (event, region) => {
  captureWindows.forEach(w => { if (!w.isDestroyed()) w.close(); });
  captureWindows = [];
  if (recordingRegionSelection) {
    recordingRegionSelection.resolve(region);
    recordingRegionSelection = null;
  }
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
ipcMain.handle('get-cursor-screen-point', () => screen.getCursorScreenPoint());


ipcMain.handle('pro-recording-indicator-show', async (event, payload = {}) => {
  if (payload?.region) lastRecordingRegion = payload.region;
  showRecordingIndicator();
  return { success: true };
});

ipcMain.handle('pro-recording-indicator-hide', async () => {
  hideRecordingIndicator();
  return { success: true };
});

async function chooseRecordingRegionSource() {
  if (recordingRegionSelection) return recordingRegionSelection.promise;

  const promise = new Promise(async (resolve, reject) => {
    recordingRegionSelection = { resolve, reject, promise: null };
    try {
      if (mainWindow) mainWindow.hide();
      await new Promise(r => setTimeout(r, 200));
      if (!await ensureMacScreenRecordingPermission()) {
        throw new Error('Screen Recording permission is required.');
      }
      const captureData = await captureAllScreens();
      createCaptureOverlays(captureData, 'record-region', []);
    } catch (error) {
      recordingRegionSelection = null;
      if (mainWindow) mainWindow.show();
      reject(error);
    }
  });
  recordingRegionSelection.promise = promise;
  return promise;
}

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

ipcMain.handle('pro-recording-source', async (event, options = {}) => {
  if (!await ensureMacScreenRecordingPermission()) {
    throw new Error('Screen Recording permission is required.');
  }

  if (options?.mode === 'region') {
    const region = await chooseRecordingRegionSource();
    if (!region) return null;
    lastRecordingSourceId = region.sourceId;
    lastRecordingRegion = region;
    return {
      id: region.sourceId,
      name: 'Selected region',
      mode: 'region',
      region,
      autoZoom: options.autoZoom !== false,
    };
  }

  const source = await chooseRecordingWindowSource();
  if (!source) return null;
  lastRecordingSourceId = source.id;
  lastRecordingRegion = null;
  return { id: source.id, name: source.name, mode: 'window' };
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
      fs.rmSync(mp4Path, { force: true });
      if (format === 'mp4') fs.rmSync(saveResult.filePath, { force: true });
      // Save as webm so the recording is not lost, but inform the user clearly
      const webmOutputPath = saveResult.filePath.replace(/\.[^.]+$/i, '.webm');
      fs.mkdirSync(path.dirname(webmOutputPath), { recursive: true });
      fs.copyFileSync(webmPath, webmOutputPath);
      return {
        webm: webmOutputPath,
        warning: `Saved as .webm (bundled ffmpeg/gifski conversion tools are unavailable for ${format.toUpperCase()} export).`,
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
