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

assert.ok(!/getTrialStatus|get-trial-status|trialStatus|TRIAL_DAYS|30-day trial|expired/i.test(mainSource), 'main process must not contain trial feature logic');
assert.ok(
  !/trial/i.test(mainSource.replace(/trialStartedAt/g, '')),
  'main process may only mention the legacy trialStartedAt key while stripping it from persisted settings',
);
assert.ok(
  /hasOwnProperty\.call\(rawSettings, 'trialStartedAt'\)[\s\S]*fs\.writeFileSync\(settingsPath\(\), JSON\.stringify\(settings, null, 2\)\)/.test(mainSource),
  'settings reads must migrate old installs by removing the legacy trialStartedAt field',
);

for (const [file, source] of codeSurfaces) {
  assert.ok(!/trial|getTrialStatus|get-trial-status|trialStatus|trialStartedAt|TRIAL_DAYS|30-day trial/i.test(source), `${file} must not contain trial feature logic or copy`);
}

assert.ok(!/pro-feature|pro-badge/.test(indexSource), 'recording UI must not keep pro/trial hooks in markup');
assert.ok(!/pro-feature|pro-badge/.test(stylesSource), 'recording UI must not keep pro/trial hooks in styles');

console.log('recording feature regression tests passed');
