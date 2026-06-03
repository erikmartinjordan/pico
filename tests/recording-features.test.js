const assert = require('assert');
const fs = require('fs');
const path = require('path');

const repoRoot = path.join(__dirname, '..');

function read(relativePath) {
  return fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');
}

const mainSource = read('src/main.js');
const preloadSource = read('src/preload.js');
const rendererSource = read('src/renderer/renderer.js');
const indexSource = read('src/renderer/index.html');
const preferencesSource = read('src/renderer/preferences.html');
const preferencesScript = read('src/renderer/preferences.js');
const stylesSource = read('src/renderer/styles.css');

assert.ok(
  preloadSource.includes('function createAutoZoomStream(sourceStream, region, options = {})'),
  'recording must expose a configurable Ken Burns autozoom stream pipeline',
);

assert.ok(
  /const enableAutoZoom = options\.autoZoom !== false/.test(preloadSource),
  'Ken Burns pipeline must honor the autozoom option',
);

assert.ok(
  /autoZoom:\s*shouldCropRegion\s*\?\s*options\?\.autoZoom !== false && source\.autoZoom !== false\s*:\s*true/.test(preloadSource),
  'region recordings must pass the saved autozoom setting into the Ken Burns stream',
);

assert.ok(
  /const autoZoomRegion = shouldCropRegion\s*\?\s*streamAlignedRegion\s*:\s*\(source\.autoZoom === false \|\| options\?\.autoZoom === false \? null : await getAutoZoomRegion\(source, mode\)\)/.test(preloadSource),
  'region recordings must always route through the canvas stream so the selected crop can be animated',
);

assert.ok(
  /zoomPipeline = createAutoZoomStream\(rawStream, autoZoomRegion, \{\s*autoZoom: shouldCropRegion \? options\?\.autoZoom !== false && source\.autoZoom !== false : true,\s*\}\)/.test(preloadSource),
  'recording startup must create the Ken Burns pipeline with autozoom enabled for region recordings unless the user turns it off',
);

assert.ok(
  /const enableAutoZoom = options\.autoZoom !== false[\s\S]*if \(enableAutoZoom\) \{[\s\S]*updateStateMachine\(now\)/.test(preloadSource),
  'Ken Burns frame loop must drive the autozoom state machine when enabled',
);

assert.ok(
  /canvas\.captureStream\(fps\)/.test(preloadSource),
  'Ken Burns rendering must be captured from the transformed canvas stream',
);

assert.ok(
  /startRecordingWithFormat\(state\.recordingSettings\.format, 'region'\)/.test(rendererSource),
  'record button must start the region recording flow by default',
);

assert.ok(
  /autoZoom:\s*mode === 'region' \? state\.recordingSettings\.autoZoom : false/.test(rendererSource),
  'renderer must pass the user autozoom setting when starting region recordings',
);

const codeSurfaces = [
  ['src/preload.js', preloadSource],
  ['src/renderer/renderer.js', rendererSource],
  ['src/renderer/index.html', indexSource],
  ['src/renderer/preferences.html', preferencesSource],
  ['src/renderer/preferences.js', preferencesScript],
];

assert.ok(
  /const TRIAL_DAYS = 30;/.test(mainSource),
  'main process must start a 30-day local trial',
);
assert.ok(
  /const LICENSE_CHECK_INTERVAL_DAYS = 7;/.test(mainSource),
  'main process must validate active licenses every 7 days',
);
assert.ok(/ipcMain\.handle\('activate-license'/.test(mainSource), 'main process must expose license activation IPC');
assert.ok(/getLicenseState: \(\) => ipcRenderer\.invoke\('get-license-state'\)/.test(preloadSource), 'preload must expose license state IPC');
assert.ok(/activateLicense:\s*async\s*\(email\)\s*=>[\s\S]*ipcRenderer\.invoke\('activate-license', email\)/.test(preloadSource), 'preload must expose license activation IPC');
assert.ok(indexSource.includes('id="license-dialog"'), 'renderer must include a license activation dialog');
assert.ok(rendererSource.includes('refreshLicenseState();'), 'renderer must check license state during startup');

assert.ok(!/pro-feature|pro-badge/.test(indexSource), 'recording UI must not keep pro/trial hooks in markup');
assert.ok(!/pro-feature|pro-badge/.test(stylesSource), 'recording UI must not keep pro/trial hooks in styles');

console.log('recording feature regression tests passed');
