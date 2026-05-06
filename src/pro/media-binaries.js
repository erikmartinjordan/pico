/**
 * Helpers for resolving bundled Pro media binaries.
 *
 * Packaged builds should place executables under one of these resource paths:
 *   - resources/bin/ffmpeg(.exe)
 *   - resources/bin/gifski(.exe)
 *   - src/bin/ffmpeg(.exe) during development
 *   - src/bin/gifski(.exe) during development
 */

const path = require('path');
const fs = require('fs');
const { app } = require('electron');

const isWindows = process.platform === 'win32';
const extension = isWindows ? '.exe' : '';

function candidatePaths(name) {
  const executable = `${name}${extension}`;
  const resourcePath = process.resourcesPath || '';
  const appPath = app.getAppPath();

  return [
    path.join(resourcePath, 'bin', executable),
    path.join(resourcePath, 'app.asar.unpacked', 'bin', executable),
    path.join(resourcePath, 'app.asar.unpacked', 'src', 'bin', executable),
    path.join(appPath, 'bin', executable),
    path.join(appPath, 'src', 'bin', executable),
    path.join(__dirname, '..', 'bin', executable),
  ];
}

function resolveBundledBinary(name) {
  const found = candidatePaths(name).find((candidate) => {
    try {
      return fs.existsSync(candidate) && fs.statSync(candidate).isFile();
    } catch (err) {
      return false;
    }
  });

  if (!found) {
    throw new Error(`${name} binary not found. Bundle ${name}${extension} in resources/bin or src/bin.`);
  }

  return found;
}

module.exports = { resolveBundledBinary };
