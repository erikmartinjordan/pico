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

function saveWebmFallback(webmPath) {
  const webmOutputPath = path.join(recordingsDir(), `recording-${Date.now()}.webm`);
  fs.copyFileSync(webmPath, webmOutputPath);
  return webmOutputPath;
}

async function convertWebmToMp4(webmPath) {
  const ffmpeg = resolveBundledBinary('ffmpeg');
  const mp4Path = path.join(recordingsDir(), `recording-${Date.now()}.mp4`);
  await runBinary(ffmpeg, [
    '-y',
    '-i', webmPath,
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-pix_fmt', 'yuv420p',
    '-c:a', 'aac',
    '-movflags', '+faststart',
    mp4Path,
  ]);
  return mp4Path;
}

async function convertMp4ToGif(mp4Path) {
  const gifski = resolveBundledBinary('gifski');
  const gifPath = mp4Path.replace(/\.mp4$/i, '.gif');
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
