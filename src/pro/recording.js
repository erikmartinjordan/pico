/**
 * Pro screen recording conversion helpers.
 */

const path = require('path');
const fs = require('fs');
const { app } = require('electron');
const { execFile } = require('child_process');
const { resolveBundledBinary } = require('./media-binaries');

function recordingsDir() {
  const dir = path.join(app.getPath('videos'), 'pico');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function ensureOutputDir(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function tempRecordingPath(extension) {
  return path.join(app.getPath('temp'), `pico-recording-${Date.now()}-${Math.random().toString(36).slice(2)}.${extension}`);
}

function runBinary(binary, args) {
  return new Promise((resolve, reject) => {
    execFile(binary, args, { windowsHide: true }, (error, stdout, stderr) => {
      if (error) {
        error.message = `${error.message}\n${stderr || stdout || ''}`.trim();
        reject(error);
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

function saveWebmFallback(webmPath, requestedOutputPath = null) {
  const webmOutputPath = requestedOutputPath
    ? requestedOutputPath.replace(/\.[^.]+$/i, '.webm')
    : path.join(recordingsDir(), `recording-${Date.now()}.webm`);
  ensureOutputDir(webmOutputPath);
  fs.copyFileSync(webmPath, webmOutputPath);
  return webmOutputPath;
}

async function convertWebmToMp4(webmPath, requestedOutputPath = null) {
  const ffmpeg = resolveBundledBinary('ffmpeg');
  const mp4Path = requestedOutputPath || path.join(recordingsDir(), `recording-${Date.now()}.mp4`);
  ensureOutputDir(mp4Path);
  await runBinary(ffmpeg, [
    '-y',
    '-fflags', '+genpts',
    '-i', webmPath,
    '-map', '0:v:0',
    '-map', '0:a?',
    '-vf', 'fps=30,scale=trunc(iw/2)*2:trunc(ih/2)*2:flags=lanczos,format=yuv420p',
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-profile:v', 'main',
    '-crf', '23',
    '-c:a', 'aac',
    '-b:a', '160k',
    '-movflags', '+faststart',
    '-shortest',
    mp4Path,
  ]);
  return mp4Path;
}

async function convertMp4ToGif(mp4Path, requestedOutputPath = null) {
  const gifski = resolveBundledBinary('gifski');
  const gifPath = requestedOutputPath || mp4Path.replace(/\.mp4$/i, '.gif');
  ensureOutputDir(gifPath);
  const frameDir = path.join(app.getPath('temp'), `pico-gif-frames-${Date.now()}`);
  fs.mkdirSync(frameDir, { recursive: true });
  try {
    const ffmpeg = resolveBundledBinary('ffmpeg');
    const framePattern = path.join(frameDir, 'frame-%06d.png');
    await runBinary(ffmpeg, ['-y', '-i', mp4Path, '-vf', 'fps=12,scale=960:-1:flags=lanczos', framePattern]);
    const frames = fs.readdirSync(frameDir)
      .filter((name) => name.endsWith('.png'))
      .sort()
      .map((name) => path.join(frameDir, name));
    await runBinary(gifski, ['--fps', '12', '--quality', '85', '--output', gifPath, ...frames]);
    return gifPath;
  } finally {
    fs.rmSync(frameDir, { recursive: true, force: true });
  }
}

module.exports = { tempRecordingPath, saveWebmFallback, convertWebmToMp4, convertMp4ToGif };
