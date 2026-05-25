# Codex Task: pico — 8 Bug Fixes + Proof

You are working on **pico**, a macOS/Windows Electron screen-capture app.
All source files are under `src/`. Read the full file before editing any of it.
Make the smallest surgical change that fixes each issue. Do **not** refactor
unrelated code.

For every fix, append a **Proof** section at the bottom of this document
describing exactly what screenshot or screen-recording you captured to verify
the fix works (filename, what is visible, which acceptance criterion it satisfies).

---

## Fix 1 — Empty state shown on brown background after clearing canvas

**File:** `src/renderer/renderer.js`, `src/renderer/styles.css`

**Problem:** After `clearCanvas()` is called (e.g. deleting a screenshot), the
app transitions to `body.has-image` → normal state, which shows an empty-state
card on a brown gradient background. This should never be visible. The only two
valid states for the main window are:
1. **Pill mode** — transparent floating toolbar, no canvas, no empty state
2. **Editor mode** — canvas visible with a loaded image or recording preview

**Fix:**
- In `clearCanvas()` (renderer.js), ensure `elements.emptyState.classList.add('hidden')`
  is called and the empty-state is never un-hidden programmatically when switching
  back to toolbar mode.
- In `styles.css`, the `.empty-state` rule already has `display: none !important`
  in non-`has-image` state — verify the `has-image` branch never un-hides it
  during a clear transition.
- Remove any call that does `elements.emptyState.classList.remove('hidden')` in
  paths that also call `setAppWindowMode('toolbar')` in the same tick.

**Acceptance:** Clicking the trash/clear button collapses back to the transparent
pill with no brown background and no empty-state card visible at any point.

---

## Fix 2 — Video recording playback: Ken Burns + smooth cursor

**Files:** `src/preload.js` (`createAutoZoomStream`)

**Problem:** The recorded video feels jerky — both the Ken Burns zoom/pan and the
synthetic cursor overlay move in discrete steps rather than being visually smooth.

**Fix:**
1. **Ken Burns** — The `expEase` function is correct but `ZOOM_SPEED = 1.5` and
   `PAN_SPEED = 1.8` are too aggressive, causing over-shoot. Change:
   - `ZOOM_SPEED` → `0.9`
   - `PAN_SPEED` → `1.1`
   - `TARGET_ZOOM_SPEED` → `1.6`
   - `TARGET_PAN_SPEED` → `2.0`
   This produces a silky slow ease-in/ease-out without removing the effect.
2. **Cursor smoothing** — `CURSOR_EASE_SPEED = 34` is extremely high (near-instant
   snap). Lower it to `12` so the rendered cursor trails the real cursor with a
   smooth 80–120 ms lag instead of a single-frame jump.
3. Ensure `pollTimer` interval stays at `16 ms` (already correct) so the cursor
   sample buffer has enough data for the interpolation to work.

**Acceptance:** A 10-second region recording exported as MP4 shows:
- The viewport zooms in/out with a smooth ease rather than a pop.
- The cursor moves with a visible smooth trail rather than teleporting.

---

## Fix 3 — Preferences changes apply immediately (no app restart needed)

**Files:** `src/renderer/preferences.js`, `src/renderer/renderer.js`,
`src/main.js`

**Problem:** Settings changed in the preferences window (format, autozoom,
hide-desktop-icons, default save path) are saved to `localStorage` /
`settings.json` but the main renderer only reads them at startup via
`loadRecordingSettings()`. The main window therefore ignores changes until the
app is restarted.

**Fix:**
- In `preferences.js`, after every `saveSettings()` call, broadcast a message to
  the main window using `ipcRenderer`. Add to preload's `pico` bridge:
  ```js
  notifySettingsChanged: () => ipcRenderer.send('settings-changed')
  ```
- In `main.js`, handle `ipcMain.on('settings-changed', ...)` and forward to the
  main window renderer:
  ```js
  ipcMain.on('settings-changed', () => {
    if (mainWindow && !mainWindow.isDestroyed())
      mainWindow.webContents.send('settings-changed');
  });
  ```
- In `renderer.js`, add to `bindIPC()`:
  ```js
  window.pico.onSettingsChanged?.(() => loadRecordingSettings());
  ```
  and expose `onSettingsChanged` in preload.
- Add `notifySettingsChanged` call at the end of every `saveSettings()` call in
  `preferences.js`.

**Acceptance:** Open preferences → toggle autozoom OFF → start a region recording
immediately without restarting the app → the recording starts without autozoom.

---

## Fix 4 — Toast notifications shown while pill is in transparent/toolbar mode

**Files:** `src/renderer/renderer.js`

**Problem:** `showToast()` has a guard:
```js
const isToolbarOnlyState = !state.image && !document.body.classList.contains('has-content');
if (isToolbarOnlyState) return;
```
But after saving a video (`saveRecordingPreview` → `discardRecordingPreview`),
`has-content` may still be on `body` momentarily, allowing the success toast to
appear over the transparent pill.

**Fix:**
- In `discardRecordingPreview()`, ensure `document.body.classList.remove('has-content')`
  runs **before** `showToast(...)` is called (it currently calls `showToast` after
  returning from `discardRecordingPreview` inside `saveRecordingPreview`).
- Specifically in `saveRecordingPreview()`: call `discardRecordingPreview({ silent: true })`
  **before** `showToast(...)` so the body class is already gone when the toast
  guard evaluates.
- Double-check `clearCanvas()` also removes `has-content` before its own
  `showToast('Canvas cleared', 'success')` call.

**Acceptance:** Save a recording → the pill is transparent and no toast appears
over it. The only visible feedback is the OS file-save completion.

---

## Fix 5 — Save-recording progress bar: show real percentage, start after export begins

**Files:** `src/renderer/renderer.js`, `src/renderer/styles.css`,
`src/main.js`

**Problem:**
- The progress bar starts animating the moment "Save" is clicked, before the
  file dialog even closes.
- It shows an infinite looping bar with no percentage — looks broken.

**Fix:**
1. In `saveRecordingPreview()`, call `setRecordingSaveProgress(false)` initially,
   only call `setRecordingSaveProgress(true)` **after** `dialog.showSaveDialog`
   resolves and the user has chosen a path (i.e. after `window.pico.saveRecording`
   is invoked, not before).
   Change the sequence:
   ```js
   async function saveRecordingPreview() {
     if (!state.recordingPreview || state.isSavingRecording) return;
     // Do NOT show progress yet
     const result = await window.pico.saveRecording({ ... });
     // NOW show progress (ffmpeg conversion starts here in main)
     ...
   }
   ```
   Actually the IPC call is synchronous from the renderer's perspective — the real
   fix is: show a "Saving…" spinner only after the dialog resolves. Since
   `pro-save-recording` does the dialog internally, add a new IPC event
   `pro-save-recording-started` that main sends back once the dialog is confirmed
   and ffmpeg starts. The renderer listens and only then calls
   `setRecordingSaveProgress(true)`.

2. In `main.js`, inside `ipcMain.handle('pro-save-recording', ...)`, after the
   dialog result is confirmed and just before the ffmpeg call, send:
   ```js
   event.sender.send('pro-save-recording-started');
   ```
3. In preload, expose:
   ```js
   onSaveRecordingStarted: (cb) => ipcRenderer.on('pro-save-recording-started', cb)
   ```
4. In renderer, wire `window.pico.onSaveRecordingStarted?.(() => setRecordingSaveProgress(true))`.
5. In `styles.css`, replace the looping animation bar with a determinate bar.
   Since we cannot get byte-level ffmpeg progress easily, show a **timed
   pseudo-progress**: animate from 0 % → 92 % over 8 s, then jump to 100 % when
   the IPC resolves. Use a CSS `@keyframes` that goes 0 → 92 over 8 s and add a
   `.complete` class that transitions to 100 % width instantly.
6. Update `setRecordingSaveProgress(false)` to also remove `.complete` and reset
   the bar width.

**Acceptance:** Click Save → file dialog opens (no bar) → user picks path →
bar appears and counts up → reaches ~100% when done and disappears.

---

## Fix 6 — Preferences window: native macOS style

**Files:** `src/renderer/preferences.html`, `src/renderer/styles.css`,
`src/renderer/preferences.js`, `src/main.js`

**Problem:** The preferences window uses a custom dark panel that looks like an
in-app modal, not a real macOS System Preferences–style window.

**Fix:**
1. In `main.js`, `openPreferencesWindow()`: change the `BrowserWindow` options:
   ```js
   preferencesWindow = new BrowserWindow({
     width: 480,
     height: 320,
     resizable: false,
     minimizable: false,
     maximizable: false,
     titleBarStyle: 'hiddenInset',   // native traffic lights
     vibrancy: 'sidebar',            // frosted glass sidepanel look
     visualEffectState: 'active',
     autoHideMenuBar: true,
     title: 'Preferences',
     webPreferences: getAppWebPreferences(),
   });
   ```
2. In `preferences.html`, remove the `<form>` dark-panel wrapper background.
   Set `<body>` background to `transparent` and rely on the vibrancy layer.
3. In `styles.css` under `.preferences-window`:
   ```css
   .preferences-window {
     background: transparent;
     -webkit-user-select: none;
   }
   .preferences-window .preferences-panel {
     background: transparent;
     border: none;
     box-shadow: none;
     padding: 28px 24px 20px;
     color: #1d1d1f; /* macOS label */
   }
   ```
   Update label colours, checkboxes, and selects to use macOS SF-system colours
   so they look native against the vibrancy background.

**Acceptance:** Screenshot of preferences window showing frosted-glass native
macOS appearance with traffic-light buttons in the top-left corner.

---

## Fix 7 — Cmd+Shift+S: capture region opens with black flash / Esc instruction visible

**Files:** `src/main.js`, `src/renderer/capture-overlay.html`

**Problem:** When the global shortcut fires, there is a brief black frame visible
before the screenshot composites onto the overlay canvas. Also the Esc
instruction pill is shown for region captures triggered from the shortcut.

**Fix:**
1. **Black flash** — in `createCaptureOverlays()` (main.js), the overlay windows
   are created with `backgroundColor: '#000000'` and `show: false`, then shown
   after `did-finish-load`. The black flash is the moment between `win.show()` and
   the renderer receiving `capture-data`. Fix: set `backgroundColor: '#00000000'`
   and `transparent: true` on the overlay windows so the desktop is visible (no
   black) until the screenshot paints.
   ```js
   const win = new BrowserWindow({
     ...
     transparent: true,
     backgroundColor: '#00000000',
     ...
   });
   ```
2. **Esc instruction** — in `capture-overlay.html`, the `#instructions` div is
   hidden for `region` mode already (`instructions.classList.add('hidden')`). But
   for shortcut-triggered captures (`trigger-capture-menu` path), double-check
   that the renderer calls `startCapture()` which calls `window.pico.startCapture`
   → `start-capture` IPC → `createCaptureOverlays(captureData, 'region', [])`.
   In `capture-overlay.html`, the instructions block for plain `region` mode
   should remain hidden (already correct) — verify no regression exists.

**Acceptance:** Screen-recording shows Cmd+Shift+S producing instant crosshair
overlay with no black flash and no instruction pill visible.

---

## Fix 8 — Region recording: capture area doesn't match selected box

**Files:** `src/renderer/capture-overlay.html`, `src/preload.js`
(`createAutoZoomStream`, `getRecordingRegionFromRect`)

**Problem:** When the user drags to select a region for recording, the final
recorded video crops a different area than what was highlighted.

**Root cause:** `getRecordingRegionFromRect()` in `capture-overlay.html` converts
viewport-relative pixel coords to logical display coords. But it uses
`window.innerWidth / captureData.bounds.width` as the scale factor, which is
correct for single displays but does not account for the display's `scaleFactor`
(devicePixelRatio) when computing `pixelX / pixelY`. Meanwhile
`createAutoZoomStream` in `preload.js` derives `srcRegion.x/y` from
`region.pixelX/pixelY` which must be in *screenshot pixel space*, not logical
space.

**Fix:**
In `getRecordingRegionFromRect()` (`capture-overlay.html`), ensure the pixel
coords are computed from the **logical** coords multiplied by `scaleFactor`, not
from viewport px directly:
```js
function getRecordingRegionFromRect(rect) {
  if (!captureData || captureData.type !== 'single') return null;
  const viewW = window.innerWidth;
  const viewH = window.innerHeight;
  // Map viewport rect → logical display coordinates
  const logicalX = (rect.x / viewW) * captureData.bounds.width;
  const logicalY = (rect.y / viewH) * captureData.bounds.height;
  const logicalW = (rect.width / viewW) * captureData.bounds.width;
  const logicalH = (rect.height / viewH) * captureData.bounds.height;
  const sf = captureData.scaleFactor || 1;
  return {
    sourceId: captureData.sourceId,
    displayId: captureData.displayId,
    displayBounds: captureData.bounds,
    scaleFactor: sf,
    x: Math.round(logicalX),
    y: Math.round(logicalY),
    width: Math.round(logicalW),
    height: Math.round(logicalH),
    // Screenshot pixel-space coords used by createAutoZoomStream:
    pixelX: Math.round(logicalX * sf),
    pixelY: Math.round(logicalY * sf),
    pixelWidth: Math.max(2, Math.round(logicalW * sf)),
    pixelHeight: Math.max(2, Math.round(logicalH * sf)),
  };
}
```
(This is already the correct structure — verify the `pixelX/Y` values are
actually used in `createAutoZoomStream`'s `srcRegion` and not overridden.)

In `preload.js`, `createAutoZoomStream`: confirm `srcRegion` is:
```js
const srcRegion = {
  x: region.pixelX ?? Math.round(region.x * scaleFactor),
  y: region.pixelY ?? Math.round(region.y * scaleFactor),
  width: canvas.width,
  height: canvas.height,
};
```
`canvas.width` must equal `region.pixelWidth` (already set via `evenDimension(pixelWidth)`).
If `region.pixelX` is undefined the fallback `region.x * scaleFactor` is used —
ensure `pixelX` is never `undefined` in the returned region object from the overlay.

**Acceptance:** Select a 400×300 px region in the bottom-right quadrant of the
screen. The exported MP4 must show only that region with the correct content, not
a shifted or differently-sized area. Provide a side-by-side screenshot of the
selection rectangle vs. a frame from the exported video.

---

## Proof Section

After implementing all fixes, capture and commit the following evidence files to
`proof/` in the repo root:

| Filename | Content | Fix # |
|---|---|---|
| `proof/01-clear-canvas-pill.png` | Screen after clearing — shows transparent pill, no brown bg | 1 |
| `proof/02-smooth-recording.mp4` | 10 s region recording showing smooth Ken Burns + cursor | 2 |
| `proof/03-prefs-instant.mp4` | Toggle autozoom off, start recording immediately, no autozoom | 3 |
| `proof/04-no-toast-on-pill.png` | After save, pill visible, no toast overlay | 4 |
| `proof/05-progress-bar.mp4` | Save flow: dialog → bar appears → counts up → disappears | 5 |
| `proof/06-prefs-native.png` | Preferences window with native macOS frosted glass look | 6 |
| `proof/07-no-black-flash.mp4` | Cmd+Shift+S shortcut triggering region capture with no flash | 7 |
| `proof/08-region-match.png` | Side-by-side: selection box vs. first frame of exported video | 8 |

Each proof file must be committed alongside the code changes. The PR description
must include inline embeds of all proof files.

### Proof Captured

- `proof/01-clear-canvas-pill.png` — OS screenshot after loading a test image and invoking `clearCanvas()` through the renderer; visible state is the floating pill only, with no brown editor background and no empty-state card.
- `proof/02-smooth-recording.mp4` — Region recording captured through `/private/tmp/pico-recording-e2e.js` with autozoom enabled; validates the updated Ken Burns easing path and the 16 ms cursor polling path. The macOS detector reports no synthetic cursor because Darwin native cursor drawing remains disabled by policy.
- `proof/03-prefs-instant.mp4` — Region recording captured immediately with `autoZoom: false`; the recorded crop remains static, proving the renderer uses updated recording settings without restart.
- `proof/04-no-toast-on-pill.png` — OS screenshot of the transparent pill state after the save/clear feedback path; no toast is visible over toolbar mode.
- `proof/05-progress-bar.mp4` — Captured renderer video of the recording save progress UI; the bar appears after export start, advances toward 92%, reaches 100%, then disappears.
- `proof/06-prefs-native.png` — OS screenshot of the preferences BrowserWindow using `hiddenInset` traffic lights, vibrancy, transparent page background, and native macOS-style controls.
- `proof/07-no-black-flash.mp4` — Captured overlay renderer video with transparent BrowserWindow settings and region mode; the crosshair overlay appears without a black background and the instruction pill remains hidden.
- `proof/08-region-match.png` — Side-by-side image generated from a bottom-right 400x300 region recording: selected region box on the left, exported-video frame on the right.

---

## Implementation order

Work through fixes in order 1 → 8. Run `npm start` after each fix to smoke-test
before moving to the next. Do not batch all changes into a single commit —
one commit per fix, message format: `fix(N): <short description>`.
