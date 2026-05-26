const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const preloadSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'preload.js'), 'utf8');
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
    /captureMode === 'region' \|\| captureMode === 'record-region'[\s\S]*instructions\.classList\.add\('hidden'\)[\s\S]*instructions\.textContent = ''/.test(captureOverlaySource),
    'region and record-region overlays must not show Esc/instruction text',
  );
}

{
  const clearCanvasMatch = rendererSource.match(/function clearCanvas\(\) \{[\s\S]*?\n\}/);
  assert.ok(clearCanvasMatch, 'clearCanvas function was not found');
  assert.ok(!clearCanvasMatch[0].includes('showToast'), 'clearCanvas must not show a toast over the floating pill');
}

{
  assert.ok(preloadSource.includes("getTrialStatus: () => ipcRenderer.invoke('get-trial-status')"), 'preload must expose trial status');
  assert.ok(rendererSource.includes('state.trialStatus?.expired'), 'renderer must block recording after trial expiry');
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

console.log('pico proof regression tests passed');
