const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const preloadSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'preload.js'), 'utf8');
const mainSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'main.js'), 'utf8');
const rendererSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'renderer.js'), 'utf8');
const stylesSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'styles.css'), 'utf8');
const indexSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'index.html'), 'utf8');
const captureOverlaySource = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'capture-overlay.html'), 'utf8');
const policyStart = preloadSource.indexOf('const streamCursorModes');
const policyEnd = preloadSource.indexOf('function getRecordingMimeType');
const helperStart = preloadSource.indexOf('// Cursor smoothing helpers');
const helperEnd = preloadSource.indexOf('// End cursor smoothing helpers.');
assert.ok(policyStart >= 0 && policyEnd > policyStart, 'preload stream cursor policy helpers were not found');
assert.ok(helperStart >= 0 && helperEnd > helperStart, 'preload cursor smoothing helpers were not found');

function loadPreloadHelpers(platform = 'linux') {
  const sandbox = { module: { exports: {} }, Math, Number, WeakMap, process: { platform } };
  vm.runInNewContext(`
    ${preloadSource.slice(policyStart, policyEnd)}
    ${preloadSource.slice(helperStart, helperEnd)}
    module.exports = { createCursorSmoother, markStreamCursorMode, shouldDrawSyntheticCursor };
  `, sandbox);
  return sandbox.module.exports;
}

const { createCursorSmoother, markStreamCursorMode, shouldDrawSyntheticCursor } = loadPreloadHelpers('linux');

function nearlyEqual(actual, expected, epsilon = 0.001) {
  assert.ok(Math.abs(actual - expected) <= epsilon, `${actual} was not within ${epsilon} of ${expected}`);
}

function createStreamWithCursorSetting(cursor) {
  return {
    getVideoTracks() {
      return [{
        getSettings() {
          return cursor ? { cursor } : {};
        },
      }];
    },
  };
}

{
  const stream = createStreamWithCursorSetting('');
  markStreamCursorMode(stream, 'synthetic');
  assert.strictEqual(shouldDrawSyntheticCursor(stream), true);
}

{
  const stream = createStreamWithCursorSetting('never');
  markStreamCursorMode(stream, 'native');
  assert.strictEqual(shouldDrawSyntheticCursor(stream), true);
}

{
  const stream = createStreamWithCursorSetting('always');
  markStreamCursorMode(stream, 'synthetic');
  assert.strictEqual(shouldDrawSyntheticCursor(stream), true);
}

{
  const stream = createStreamWithCursorSetting('');
  markStreamCursorMode(stream, 'native');
  assert.strictEqual(shouldDrawSyntheticCursor(stream), false);
}

{
  const darwinHelpers = loadPreloadHelpers('darwin');
  const stream = createStreamWithCursorSetting('');
  darwinHelpers.markStreamCursorMode(stream, 'synthetic');
  assert.strictEqual(darwinHelpers.shouldDrawSyntheticCursor(stream), false);
}

{
  const darwinHelpers = loadPreloadHelpers('darwin');
  const stream = createStreamWithCursorSetting('');
  darwinHelpers.markStreamCursorMode(stream, 'native');
  assert.strictEqual(darwinHelpers.shouldDrawSyntheticCursor(stream), false);
}

{
  const smoother = createCursorSmoother({ renderDelayMs: 0, easeSpeed: 1000 });
  smoother.pushSample({ x: 0, y: 0, visible: true, time: 0 });
  smoother.pushSample({ x: 100, y: 50, visible: true, time: 100 });

  const sample = smoother.getSampleForFrame(50);
  nearlyEqual(sample.x, 50);
  nearlyEqual(sample.y, 25);
  assert.strictEqual(sample.visible, true);
}

{
  const smoother = createCursorSmoother({ renderDelayMs: 35, easeSpeed: 1000 });
  smoother.pushSample({ x: 10, y: 20, visible: true, time: 0 });
  smoother.pushSample({ x: 110, y: 120, visible: true, time: 100 });

  const sample = smoother.getSampleForFrame(85);
  nearlyEqual(sample.x, 60);
  nearlyEqual(sample.y, 70);
}

{
  const smoother = createCursorSmoother({ renderDelayMs: 0, snapDistance: 500, easeSpeed: 12 });
  smoother.pushSample({ x: 0, y: 0, visible: true, time: 0 });
  const first = smoother.update(0, 1 / 60);
  nearlyEqual(first.x, 0);
  nearlyEqual(first.y, 0);
  assert.strictEqual(first.visible, true);

  smoother.pushSample({ x: 60, y: 0, visible: true, time: 16 });
  const second = smoother.update(16, 1 / 60);
  assert.ok(second.x > 0, 'cursor should move toward the new sample');
  assert.ok(second.x < 60, 'cursor should ease instead of jumping for short moves');
  assert.strictEqual(second.visible, true);
}

{
  const smoother = createCursorSmoother({ renderDelayMs: 0, maxSampleAgeMs: 100 });
  smoother.pushSample({ x: 5, y: 10, visible: true, time: 0 });
  assert.strictEqual(smoother.update(50, 1 / 60).visible, true);
  assert.strictEqual(smoother.update(150, 1 / 60).visible, false);
}

{
  const smoother = createCursorSmoother({ renderDelayMs: 0, sampleLimit: 3 });
  for (let index = 0; index < 6; index += 1) {
    smoother.pushSample({ x: index, y: index, visible: true, time: index });
  }
  assert.deepStrictEqual(Array.from(smoother.samples, (sample) => sample.x), [3, 4, 5]);
}

{
  assert.ok(
    captureOverlaySource.includes('<div id="instructions" class="hidden"></div>'),
    'capture overlay instructions must be hidden before capture data arrives to avoid shortcut text flash',
  );
  assert.ok(
    /captureMode === 'region' \|\| captureMode === 'record-select'[\s\S]*instructions\.classList\.add\('hidden'\)[\s\S]*instructions\.textContent = ''/.test(captureOverlaySource),
    'region and record-select overlays must not show Esc/instruction text',
  );
  assert.ok(
    /#selection\s*\{[\s\S]*outline:\s*2px solid #f07d20;[\s\S]*background:\s*transparent;/.test(captureOverlaySource),
    'selection chrome must render outside the selected content so overlay crops match recording pixels',
  );
  assert.ok(
    /region\.initialFrameDataUrl = dataUrl;[\s\S]*recordingRegionComplete\(region\)/.test(captureOverlaySource),
    'record-select completion must include a selected screenshot seed for first-frame alignment',
  );
  assert.ok(
    mainSource.includes("createCaptureOverlays(captureData, 'record-select', [])"),
    'region recording must use the temporary record-select overlay before recording starts',
  );
  assert.ok(
    mainSource.includes("const isRecordingSelector = isDarwinCaptureOverlay && mode === 'record-select'"),
    'record-select overlays must use the active recording selector presentation on macOS',
  );
  assert.ok(
    /focusable:\s*isRecordingSelector \? true : !isDarwinCaptureOverlay,[\s\S]*acceptFirstMouse:\s*true/.test(mainSource),
    'record-select overlays must be focusable mouse surfaces without focusing Orange Fuji',
  );
  assert.ok(
    /videoBitsPerSecond:\s*50_000_000/.test(preloadSource),
    'screen recorder must request a high video bitrate to preserve screen-detail alignment checks',
  );
  assert.ok(
    /autoZoom:\s*shouldCropRegion\s*\?\s*options\?\.autoZoom !== false && source\.autoZoom !== false\s*:\s*true/.test(preloadSource),
    'region recording must pass the user autozoom setting into the Ken Burns pipeline',
  );
  assert.ok(
    !mainSource.includes("type: process.platform === 'darwin' ? 'panel' : undefined"),
    'recording indicator windows must not use macOS panel type because it emits NSWindow nonactivating panel errors',
  );
  assert.ok(
    !/focusable:\s*false/.test(mainSource),
    'recording overlay windows must not request non-focusable macOS windows because they can become nonactivating panels',
  );
  assert.ok(
    /show:\s*false,[\s\S]*overlayWindow\.showInactive\(\)/.test(mainSource),
    'recording overlay windows should be shown without activation instead of using nonactivating panel styles',
  );
  assert.ok(
    /const shouldShowRegionOverlay = Boolean\(lastRecordingRegion\);/.test(mainSource),
    'region recordings must keep a visible recording overlay on every platform',
  );
  assert.ok(
    /const overlayWindow = new BrowserWindow\(\{[\s\S]*backgroundColor: '#00000000'[\s\S]*fullscreenable: true[\s\S]*enableLargerThanScreen: true/.test(mainSource),
    'recording overlay window must match capture overlay screen coverage so macOS does not offset it below the menu bar',
  );
  assert.ok(
    /overlayWindow\.webContents\.once\('did-finish-load'[\s\S]*overlayWindow\.setBounds\(\{[\s\S]*x: bounds\.x,[\s\S]*y: bounds\.y,[\s\S]*width: bounds\.width,[\s\S]*height: bounds\.height/.test(mainSource),
    'recording overlay must re-apply exact display bounds after load before becoming visible',
  );
  assert.ok(
    /const dimBlocks = regionOnDisplay \?[\s\S]*recording-dim[\s\S]*width:\$\{regionOnDisplay\.left\}px[\s\S]*width:\$\{regionOnDisplay\.right\}px/.test(mainSource),
    'recording overlay must illuminate the selected region by dimming only the outside bands',
  );
  assert.ok(
    !/recording-frame|recording-glow|outline:\s*2px solid rgba\(249, 115, 22/.test(mainSource),
    'recording overlay must not draw orange borders that can misalign or leak into the captured video',
  );
  const recordingDimCss = mainSource.match(/\.recording-dim\s*\{[\s\S]*?\}/)?.[0] || '';
  assert.ok(recordingDimCss && !recordingDimCss.includes('backdrop-filter'), 'recording overlay dim bands must not blur because blur can bleed into the illuminated capture region');
  assert.ok(
    /region: source\.mode === 'region' \? \(streamAlignedRegion \|\| source\.region\) : null/.test(preloadSource),
    'recording overlay must use the same stream-aligned region as the capture crop',
  );
  assert.ok(
    /dialog\.showSaveDialog\(mainWindow,[\s\S]*Save screen recording/.test(mainSource),
    'recording save must show the native save dialog when no default save directory is configured',
  );
  assert.ok(
    /setWindowMode: \(mode, options = \{\}\) => ipcRenderer\.invoke\('window-set-mode', mode, options\)/.test(preloadSource),
    'window mode changes must support forcing the hidden recording window visible for preview',
  );
  assert.ok(
    /setAppWindowMode\('editor', \{ show: true \}\)/.test(rendererSource),
    'recording preview must reopen the app in editor mode instead of leaving the window hidden',
  );
  assert.ok(
    /discardRecordingPreview\(\{ silent: true, keepWindowMode: true \}\)/.test(rendererSource),
    'recording preview replacement must not race the window back to toolbar mode',
  );
  assert.ok(
    !rendererSource.slice(
      rendererSource.indexOf('async function saveRecordingPreview()'),
      rendererSource.indexOf('function setRecordingPreviewFormat'),
    ).includes('discardRecordingPreview'),
    'saving a recording must keep the preview visible and steady in editor mode',
  );
  assert.ok(
    /function applyEditorWindowMode[\s\S]*mainWindow\.setContentProtection\(false\)/.test(mainSource),
    'returning to editor mode must remove recording content protection so preview and dialogs are visible',
  );
  assert.ok(
    /function applyToolbarWindowMode[\s\S]*mainWindow\.setContentProtection\(false\)/.test(mainSource),
    'returning to toolbar mode must remove recording content protection',
  );
}

{
  const clearCanvasMatch = rendererSource.match(/function clearCanvas\(\) \{[\s\S]*?\n\}/);
  assert.ok(clearCanvasMatch, 'clearCanvas function was not found');
  assert.ok(!clearCanvasMatch[0].includes('showToast'), 'clearCanvas must not show a toast over the floating pill');
}

{
  assert.ok(mainSource.includes('const TRIAL_DAYS = 30;'), 'main process must keep the 30-day trial configuration');
  assert.ok(mainSource.includes('const LICENSE_CHECK_INTERVAL_DAYS = 7;'), 'main process must keep the 7-day license validation interval');
  assert.ok(mainSource.includes("ipcMain.handle('activate-license'"), 'main process must expose license activation IPC');
  assert.ok(preloadSource.includes("getLicenseState: () => ipcRenderer.invoke('get-license-state')"), 'preload must expose license state');
  assert.ok(/activateLicense:\s*async\s*\(email\)\s*=>[\s\S]*ipcRenderer\.invoke\('activate-license', email\)/.test(preloadSource), 'preload must expose license activation');
  assert.ok(indexSource.includes('id="license-dialog"'), 'renderer markup must include the license dialog');
  assert.ok(rendererSource.includes('refreshLicenseState();'), 'renderer must check trial/license state on startup');
  assert.ok(!indexSource.includes('pro-feature'), 'recording button must not keep old pro feature styling hooks');
  assert.ok(!stylesSource.includes('pro-feature'), 'styles must not keep old pro feature hooks');
  assert.ok(!stylesSource.includes('pro-badge'), 'styles must not keep old pro badges');
}

{
  assert.ok(
    preloadSource.includes("onToolbarOpenRequested: (callback) => ipcRenderer.on('toolbar-open-requested'"),
    'preload must expose the menu-only toolbar restore event',
  );
  assert.ok(rendererSource.includes('const inactivityDelay = 2500'), 'toolbar auto-hide delay must be 2.5 seconds');
  assert.ok(rendererSource.includes("toolbar.classList.add('auto-hidden')"), 'toolbar must use the auto-hidden animation state');
  assert.ok(rendererSource.includes('const finishDragging = () =>'), 'toolbar drag completion must be shared across release paths');
  assert.ok(rendererSource.includes("window.addEventListener(eventName, finishDragging, true)"), 'toolbar drag completion must survive native window drags');
  assert.ok(
    /if \(dragging\) \{\s*scheduleAutoHide\(\);\s*return;\s*\}/.test(rendererSource),
    'toolbar auto-hide must reschedule while an active drag is still in progress',
  );
  assert.ok(rendererSource.includes('const hideAfterAnimationMs = 340'), 'toolbar hide delay must match the pill disappear animation');
  assert.ok(!rendererSource.includes('past-threshold'), 'manual drag-threshold hide behavior must be removed');
  assert.ok(/\.toolbar\.dragging\s*\{[\s\S]*?cursor: all-scroll;/.test(stylesSource), 'all-scroll cursor must be scoped to explicit toolbar drags');
  assert.ok(
    /\.toolbar\.auto-hidden\s*\{[\s\S]*?opacity: 0;[\s\S]*?transform: translateX\(-50%\) translateY\(-6px\) scale\(0\.97\);[\s\S]*?pointer-events: none;[\s\S]*?\}/.test(stylesSource),
    'toolbar hide animation must mirror the appearing pill transform',
  );
  assert.ok(!/\.toolbar\.auto-hidden\s*\{[\s\S]*?filter:/.test(stylesSource), 'toolbar hide animation must not use the old blur/shrink treatment');
  assert.ok(!/\.toolbar:active\s*\{[\s\S]*?cursor: all-scroll;/.test(stylesSource), 'toolbar active state must not show all-scroll on button presses');
}

{
  assert.ok(rendererSource.includes('currentTool: null'), 'editor must not default to a selected annotation tool');
  assert.ok(rendererSource.includes('clearToolSelection();'), 'loading an image must clear toolbar tool selection');
  assert.ok(!rendererSource.includes('autoSelectRect'), 'captured images must not auto-select the rectangle tool');
  assert.ok(rendererSource.includes("state.selectedAnnotationIndex = -1;\n  render();\n  updateStatus();"), 'new annotations must not stay selected after drawing');
  assert.ok(
    /function selectColor\(color\) \{[\s\S]*?if \(state\.selectedAnnotationIndex >= 0\)/.test(rendererSource),
    'color changes must apply to the selected annotation regardless of the active tool',
  );
  assert.ok(!indexSource.includes('id="stroke-current" data-tooltip='), 'line weight control must not show the app tooltip');
  assert.ok(indexSource.includes('<span class="status-tool" id="status-tool">Ready</span>'), 'status bar must not start on Rectangle');
  assert.ok(/\.toolbar-btn\s*\{[\s\S]*?width: 36px;[\s\S]*?height: 36px;/.test(stylesSource), 'editor toolbar buttons must match the main pillbar size');
  assert.ok(/\.toolbar-btn svg\s*\{\s*width: 18px;\s*height: 18px;\s*\}/.test(stylesSource), 'editor toolbar icons must match the main pillbar icon size');
  assert.ok(/\.color-swatch\s*\{[\s\S]*?-webkit-app-region: no-drag;/.test(stylesSource), 'color swatches must be clickable inside the draggable toolbar');
}

console.log('Orange Fuji proof regression tests passed');
