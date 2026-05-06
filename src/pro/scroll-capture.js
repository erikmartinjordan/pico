/**
 * Pro scrolling capture pipeline.
 *
 * Captures a desktopCapturer window source repeatedly while nudging the focused
 * scrollable surface down. Frames are stitched with a 20px overlap and a light
 * diff check to avoid visible duplicated seams.
 */

const { desktopCapturer } = require('electron');
const { execFile } = require('child_process');

const OVERLAP_PX = 20;
const MAX_FRAMES = 80;
const SCROLL_DELAY_MS = 180;
const MIN_FRAME_ADVANCE_PX = 60;
const DIFF_SAMPLE_STEP = 8;
const DEFAULT_CAPTURE_SIZE = { width: 1920, height: 1600 };

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function captureWindowFrame(windowId) {
  const sources = await desktopCapturer.getSources({
    types: ['window'],
    thumbnailSize: DEFAULT_CAPTURE_SIZE,
    fetchWindowIcons: false,
  });
  const source = sources.find((item) => item.id === windowId);
  if (!source || source.thumbnail.isEmpty()) {
    throw new Error(`Window source not found for id ${windowId}`);
  }
  return { image: source.thumbnail, source };
}

function imageToRgba(image) {
  const size = image.getSize();
  return { size, pixels: image.toBitmap() };
}

function rowDiff(a, b, rowA, rowB) {
  const width = Math.min(a.size.width, b.size.width);
  let diff = 0;
  let samples = 0;
  for (let x = 0; x < width; x += DIFF_SAMPLE_STEP) {
    const ai = ((rowA * a.size.width) + x) * 4;
    const bi = ((rowB * b.size.width) + x) * 4;
    diff += Math.abs(a.pixels[ai] - b.pixels[bi]);
    diff += Math.abs(a.pixels[ai + 1] - b.pixels[bi + 1]);
    diff += Math.abs(a.pixels[ai + 2] - b.pixels[bi + 2]);
    samples += 3;
  }
  return samples ? diff / samples : Infinity;
}

function findBestOverlap(previous, current) {
  const prev = imageToRgba(previous);
  const curr = imageToRgba(current);
  const prevHeight = prev.size.height;
  const currHeight = curr.size.height;
  const minOverlap = Math.max(1, OVERLAP_PX - 10);
  const maxOverlap = Math.min(currHeight - 1, OVERLAP_PX + 80);

  let best = OVERLAP_PX;
  let bestScore = Infinity;
  for (let overlap = minOverlap; overlap <= maxOverlap; overlap += 2) {
    let score = 0;
    let rows = 0;
    const rowsToCheck = Math.min(overlap, OVERLAP_PX);
    for (let y = 0; y < rowsToCheck; y += 4) {
      score += rowDiff(prev, curr, prevHeight - overlap + y, y);
      rows += 1;
    }
    const avg = rows ? score / rows : Infinity;
    if (avg < bestScore) {
      bestScore = avg;
      best = overlap;
    }
  }

  return { overlap: best, score: bestScore };
}

function isDuplicateFrame(previous, current) {
  const prev = imageToRgba(previous);
  const curr = imageToRgba(current);
  const height = Math.min(prev.size.height, curr.size.height);
  const sampleRows = Math.min(80, height);
  let score = 0;
  let rows = 0;
  for (let y = 0; y < sampleRows; y += 8) {
    score += rowDiff(prev, curr, y, y);
    rows += 1;
  }
  return rows > 0 && (score / rows) < 1.5;
}

async function stitchFrames(frames) {
  if (frames.length === 0) throw new Error('No frames captured');
  if (frames.length === 1) return frames[0].toPNG();

  const parts = [];
  let totalHeight = 0;
  const width = Math.max(...frames.map((frame) => frame.getSize().width));

  frames.forEach((frame, index) => {
    const size = frame.getSize();
    if (index === 0) {
      parts.push({ image: frame, sourceY: 0, height: size.height });
      totalHeight += size.height;
      return;
    }

    const seam = findBestOverlap(frames[index - 1], frame);
    const overlap = Number.isFinite(seam.score) && seam.score < 28 ? seam.overlap : OVERLAP_PX;
    const sourceY = Math.min(overlap, size.height - 1);
    const height = Math.max(1, size.height - sourceY);
    parts.push({ image: frame, sourceY, height });
    totalHeight += height;
  });

  // NativeImage cannot draw, so defer final composition to the main-process
  // offscreen canvas helper. The caller consumes PNG bytes.
  return composeWithCanvas(parts, width, totalHeight);
}

async function composeWithCanvas(parts, width, height) {
  // Use pure PNG buffers when only one crop is required; otherwise defer actual
  // composition to the main process helper injected at runtime.
  if (!global.picoComposeImageParts) {
    throw new Error('Scrolling capture compositor is not initialized');
  }
  return global.picoComposeImageParts(parts, width, height);
}

function runCommand(command, args) {
  return new Promise((resolve) => {
    execFile(command, args, { timeout: 1500, windowsHide: true }, () => resolve());
  });
}

async function sendScrollNudge(bounds) {
  const center = bounds ? {
    x: Math.round(bounds.x + bounds.width / 2),
    y: Math.round(bounds.y + Math.min(bounds.height - 12, Math.max(24, bounds.height / 2))),
  } : null;
  if (process.platform === 'darwin') {
    if (center) {
      await runCommand('osascript', ['-e', `tell application "System Events" to click at {${center.x}, ${center.y}}`]);
    }
    await runCommand('osascript', ['-e', 'tell application "System Events" to key code 121']);
    await runCommand('osascript', ['-e', 'tell application "System Events" to key code 121']);
    return;
  }

  if (process.platform === 'win32') {
    const focusScript = center ? `
      Add-Type -AssemblyName System.Windows.Forms;
      Add-Type -TypeDefinition '[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y); [System.Runtime.InteropServices.DllImport("user32.dll")] public static extern void mouse_event(int flags, int dx, int dy, int data, int extra);' -Name NativeMouse -Namespace Pico;
      [Pico.NativeMouse]::SetCursorPos(${center.x}, ${center.y}) | Out-Null;
      [Pico.NativeMouse]::mouse_event(0x0002,0,0,0,0); [Pico.NativeMouse]::mouse_event(0x0004,0,0,0,0);
    ` : '';
    await runCommand('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      `${focusScript}$wshell = New-Object -ComObject wscript.shell; $wshell.SendKeys("{PGDN}")`]);
    return;
  }

  if (center) {
    await runCommand('xdotool', ['mousemove', String(center.x), String(center.y), 'click', '1']);
  }
  await runCommand('xdotool', ['key', 'Page_Down']);
}

async function scrollCapture(windowId, options = {}) {
  if (!windowId || typeof windowId !== 'string') {
    throw new Error('scrollCapture(windowId) requires a desktopCapturer window id');
  }

  const frames = [];
  let stalledFrames = 0;
  for (let index = 0; index < MAX_FRAMES; index += 1) {
    const frameCapture = await captureWindowFrame(windowId);
    const frame = frameCapture.image;
    const previous = frames[frames.length - 1];
    if (!previous || !isDuplicateFrame(previous, frame)) {
      frames.push(frame);
      stalledFrames = 0;
    } else {
      stalledFrames += 1;
    }

    if (stalledFrames >= 2 || frame.getSize().height < MIN_FRAME_ADVANCE_PX) break;
    await sendScrollNudge(options.bounds);
    await delay(SCROLL_DELAY_MS);
  }

  return stitchFrames(frames);
}

module.exports = { OVERLAP_PX, scrollCapture, stitchFrames, findBestOverlap };
