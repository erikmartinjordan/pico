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
    '-i', webmPath,
    '-map', '0:v:0',
    '-map', '0:a?',
    '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2,setsar=1',
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-crf', '18',
    '-pix_fmt', 'yuv420p',
    '-c:a', 'aac',
    '-b:a', '160k',
    '-movflags', '+faststart',
    mp4Path,
  ]);
  return mp4Path;
}

async function convertMp4ToGif(mp4Path, requestedOutputPath = null) {
  const ffmpeg = resolveBundledBinary('ffmpeg');
  const gifPath = requestedOutputPath || mp4Path.replace(/\.mp4$/i, '.gif');
  ensureOutputDir(gifPath);
  const palettePath = tempRecordingPath('png');
  const gifFilter = 'fps=18,scale=min(1280\\,iw):-2:flags=lanczos';
  try {
    await runBinary(ffmpeg, [
      '-y',
      '-i', mp4Path,
      '-vf', `${gifFilter},palettegen=stats_mode=diff`,
      '-frames:v', '1',
      '-update', '1',
      palettePath,
    ]);
    await runBinary(ffmpeg, [
      '-y',
      '-i', mp4Path,
      '-i', palettePath,
      '-lavfi', `${gifFilter} [x]; [x][1:v] paletteuse=dither=sierra2_4a:diff_mode=rectangle`,
      '-loop', '0',
      gifPath,
    ]);
    return gifPath;
  } finally {
    fs.rmSync(palettePath, { force: true });
  }
}

module.exports = { tempRecordingPath, saveWebmFallback, convertWebmToMp4, convertMp4ToGif };
