const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const preloadSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'preload.js'), 'utf8');
const rendererSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'renderer.js'), 'utf8');
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

console.log('pico proof regression tests passed');
