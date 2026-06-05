/**
 * Orange Fuji - Main Process
 * Handles window creation, screen capture, and native dialogs
 */

const { app, BrowserWindow, ipcMain, desktopCapturer, dialog, screen, globalShortcut, nativeImage, clipboard, Menu, Tray, shell, systemPreferences, session } = require('electron');
const { execSync, execFile } = require('child_process');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const https = require('https');
const { tempRecordingPath, convertWebmToMp4, convertMp4ToGif } = require('./pro/recording');
let autoUpdater = null;
try {
  ({ autoUpdater } = require('electron-updater'));
} catch (error) {
  console.warn('[orange-fuji][updater] electron-updater unavailable:', error.message);
}

if (process.platform === 'darwin') {
  app.commandLine.appendSwitch('log-level', '3');
}

let mainWindow = null;
let captureWindows = [];
let windowPickerWindow = null;
let windowPickerSources = [];
let recordingIndicatorWindows = [];
let recordingSourceSelection = null;
let recordingRegionSelection = null;
let lastRecordingSourceId = null;
let lastRecordingRegion = null;
let recordingDisplayMediaSourceId = null;
let recordingInProgress = false;
let recordingReturnAppPath = '';
let tray = null;
let desktopIconsHidden = false;
let desktopIconsVisibleBeforeRecording = true;
let preferencesWindow = null;
let aboutWindow = null;
let previewToastWindow = null;
let pendingPreviewToastPayload = null;
let mainWindowMode = 'toolbar';
let lastEditorBounds = null;
let lastToolbarBounds = null;
let updateCheckInProgress = false;

const TOOLBAR_WINDOW_SIZE = { width: 260, height: 110 };
const TOOLBAR_MIN_SIZE = { width: 200, height: 110 };
const EDITOR_DEFAULT_SIZE = { width: 1200, height: 800 };
const EDITOR_MIN_SIZE = { width: 900, height: 600 };

const SETTINGS_FILE = 'settings.json';
const PRODUCT_NAME = 'Orange Fuji';
const TRIAL_DAYS = 30;
const LICENSE_CHECK_INTERVAL_DAYS = 7;
const licenseConfig = require('./license-config');
const BUY_LICENSE_URL = licenseConfig.buyLicenseUrl;
const LICENSE_API_BASE_URL = licenseConfig.licenseApiBaseUrl;
const SUPABASE_PUBLISHABLE_KEY = licenseConfig.supabasePublishableKey;
// Keep the original userData directory so existing settings survive the rename.
const LEGACY_USER_DATA_NAME = 'pico';
const DEFAULT_SETTINGS = {
  defaultSavePath: '',
  hideDesktopIcons: true,
  captureOrangeFuji: false,
  trialStartedAt: '',
  deviceId: '',
  licenseEmail: '',
  licenseStatus: '',
  licenseActivationId: '',
  licenseLastValidatedAt: '',
};
const updateState = {
  status: 'idle',
  supported: false,
  currentVersion: '',
  availableVersion: '',
  message: 'Up to date',
  progress: null,
  error: '',
};

function applyLegacyUserDataPath() {
  try {
    app.setName(PRODUCT_NAME);
    app.setPath('userData', path.join(app.getPath('appData'), LEGACY_USER_DATA_NAME));
  } catch (error) {
    console.error('[orange-fuji] failed to set legacy user data path:', error.message);
  }
}

function settingsPath() {
  return path.join(app.getPath('userData'), SETTINGS_FILE);
}

function normalizeSettings(candidate = {}) {
  return {
    defaultSavePath: typeof candidate.defaultSavePath === 'string' ? candidate.defaultSavePath : DEFAULT_SETTINGS.defaultSavePath,
    hideDesktopIcons: typeof candidate.hideDesktopIcons === 'boolean' ? candidate.hideDesktopIcons : DEFAULT_SETTINGS.hideDesktopIcons,
    captureOrangeFuji: typeof candidate.captureOrangeFuji === 'boolean' ? candidate.captureOrangeFuji : DEFAULT_SETTINGS.captureOrangeFuji,
    trialStartedAt: typeof candidate.trialStartedAt === 'string' ? candidate.trialStartedAt : DEFAULT_SETTINGS.trialStartedAt,
    deviceId: typeof candidate.deviceId === 'string' ? candidate.deviceId : DEFAULT_SETTINGS.deviceId,
    licenseEmail: typeof candidate.licenseEmail === 'string' ? candidate.licenseEmail : DEFAULT_SETTINGS.licenseEmail,
    licenseStatus: typeof candidate.licenseStatus === 'string' ? candidate.licenseStatus : DEFAULT_SETTINGS.licenseStatus,
    licenseActivationId: typeof candidate.licenseActivationId === 'string' ? candidate.licenseActivationId : DEFAULT_SETTINGS.licenseActivationId,
    licenseLastValidatedAt: typeof candidate.licenseLastValidatedAt === 'string' ? candidate.licenseLastValidatedAt : DEFAULT_SETTINGS.licenseLastValidatedAt,
  };
}

function readSettings() {
  try {
    if (!fs.existsSync(settingsPath())) return { ...DEFAULT_SETTINGS };
    const rawSettings = JSON.parse(fs.readFileSync(settingsPath(), 'utf8'));
    const settings = normalizeSettings(rawSettings);
    return settings;
  } catch (error) {
    console.error('[orange-fuji] failed to read settings:', error.message);
    return { ...DEFAULT_SETTINGS };
  }
}

function writeSettings(nextSettings = {}) {
  const settings = normalizeSettings({ ...readSettings(), ...nextSettings });
  fs.mkdirSync(path.dirname(settingsPath()), { recursive: true });
  fs.writeFileSync(settingsPath(), JSON.stringify(settings, null, 2));
  return settings;
}

function nowIso() {
  return new Date().toISOString();
}

function addDays(date, days) {
  return new Date(date.getTime() + days * 24 * 60 * 60 * 1000);
}

function parseDate(value) {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}

function ensureLocalLicenseSettings() {
  const settings = readSettings();
  const next = {};
  if (!settings.trialStartedAt) next.trialStartedAt = nowIso();
  if (!settings.deviceId) next.deviceId = crypto.randomUUID();
  return Object.keys(next).length ? writeSettings(next) : settings;
}

function trialStateFromSettings(settings) {
  const startedAt = parseDate(settings.trialStartedAt) || new Date();
  const expiresAt = addDays(startedAt, TRIAL_DAYS);
  const now = new Date();
  const remainingMs = expiresAt.getTime() - now.getTime();
  return {
    startedAt: startedAt.toISOString(),
    expiresAt: expiresAt.toISOString(),
    daysRemaining: Math.max(0, Math.ceil(remainingMs / (24 * 60 * 60 * 1000))),
    expired: remainingMs <= 0,
  };
}

function shouldValidateLicense(settings) {
  if (settings.licenseStatus !== 'active' || !settings.licenseEmail) return false;
  const lastValidatedAt = parseDate(settings.licenseLastValidatedAt);
  if (!lastValidatedAt) return true;
  return Date.now() - lastValidatedAt.getTime() >= LICENSE_CHECK_INTERVAL_DAYS * 24 * 60 * 60 * 1000;
}

async function callLicenseApi(endpoint, payload) {
  const { statusCode, data } = await postJson(`${LICENSE_API_BASE_URL}/${endpoint}`, payload);
  if (statusCode < 200 || statusCode >= 300 || data.ok === false) {
    const error = new Error(data.error || `license_${endpoint}_failed`);
    error.status = statusCode;
    throw error;
  }
  return data;
}

function postJson(url, payload) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const request = https.request(url, {
      method: 'POST',
      headers: {
        apikey: SUPABASE_PUBLISHABLE_KEY,
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body),
      },
    }, (response) => {
      let raw = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { raw += chunk; });
      response.on('end', () => {
        let data = {};
        try { data = raw ? JSON.parse(raw) : {}; } catch (_) {}
        resolve({ statusCode: response.statusCode || 0, data });
      });
    });
    request.on('error', reject);
    request.write(body);
    request.end();
  });
}

async function validateLicenseIfNeeded(settings) {
  if (!shouldValidateLicense(settings)) return settings;
  try {
    const result = await callLicenseApi('validate-license', {
      email: settings.licenseEmail,
      deviceId: settings.deviceId,
      appVersion: app.getVersion(),
    });
    return writeSettings({
      licenseStatus: result.status || 'active',
      licenseActivationId: result.activationId || settings.licenseActivationId,
      licenseLastValidatedAt: result.validatedAt || nowIso(),
    });
  } catch (error) {
    console.error('[orange-fuji][license] validation failed:', error.message);
    return settings;
  }
}

async function getLicenseState() {
  let settings = ensureLocalLicenseSettings();
  settings = await validateLicenseIfNeeded(settings);
  const trial = trialStateFromSettings(settings);
  const licensed = settings.licenseStatus === 'active';
  return {
    trial,
    licensed,
    email: settings.licenseEmail,
    status: licensed ? 'licensed' : (trial.expired ? 'trial-expired' : 'trial-active'),
    buyUrl: BUY_LICENSE_URL,
    checkIntervalDays: LICENSE_CHECK_INTERVAL_DAYS,
  };
}

async function activateLicense(email) {
  const settings = ensureLocalLicenseSettings();
  const normalizedEmail = String(email || '').trim().toLowerCase();
  if (!normalizedEmail) throw new Error('Email is required.');

  let result;
  try {
    result = await callLicenseApi('activate-license', {
      email: normalizedEmail,
      deviceId: settings.deviceId,
      appVersion: app.getVersion(),
    });
  } catch (error) {
    throw new Error(readableLicenseError(error.message));
  }

  writeSettings({
    licenseEmail: normalizedEmail,
    licenseStatus: result.status || 'active',
    licenseActivationId: result.activationId || settings.deviceId,
    licenseLastValidatedAt: result.validatedAt || nowIso(),
  });

  return getLicenseState();
}

function readableLicenseError(message = '') {
  if (message.includes('license_not_found')) {
    return 'We could not find a license for this email. Use the same email you entered at checkout, or buy a license first.';
  }
  if (message.includes('activation_limit_reached')) {
    return 'This license is already active on 2 devices.';
  }
  if (message.includes('email_required')) {
    return 'Enter the email you used at checkout.';
  }
  return message || 'Activation failed. Please try again.';
}

async function hasUsageEntitlement() {
  const state = await getLicenseState();
  return state.licensed || !state.trial.expired;
}

function configuredDefaultSaveDirectory() {
  const settings = readSettings();
  if (settings.defaultSavePath && fs.existsSync(settings.defaultSavePath)) return settings.defaultSavePath;
  return '';
}

function defaultSaveDirectory(fallbackName) {
  return configuredDefaultSaveDirectory() || app.getPath(fallbackName);
}

function defaultSavePath(fallbackName, filename) {
  return path.join(defaultSaveDirectory(fallbackName), filename);
}

function sourceTypesForRecordingSourceId(sourceId) {
  const sourceIdStr = String(sourceId || '');
  if (sourceIdStr.startsWith('window:')) return ['window', 'screen'];
  if (sourceIdStr.startsWith('screen:')) return ['screen', 'window'];
  return ['screen', 'window'];
}

async function findDesktopCapturerSource(sourceId) {
  if (!sourceId) return null;
  const sources = await desktopCapturer.getSources({
    types: sourceTypesForRecordingSourceId(sourceId),
    thumbnailSize: { width: 0, height: 0 },
    fetchWindowIcons: false,
  });
  return sources.find((source) => String(source.id) === String(sourceId)) || null;
}

function setupRecordingDisplayMediaHandler() {
  session.defaultSession.setDisplayMediaRequestHandler(async (request, callback) => {
    try {
      const requestedSourceId = recordingDisplayMediaSourceId || lastRecordingSourceId;
      const source = await findDesktopCapturerSource(requestedSourceId);
      if (!source) {
        console.error('[orange-fuji][recording] display media source unavailable:', requestedSourceId);
        callback({});
        return;
      }

      const streams = { video: source };
      if (request.audioRequested && process.platform === 'win32') streams.audio = 'loopback';
      callback(streams);
    } catch (error) {
      console.error('[orange-fuji][recording] display media handler failed:', error.message);
      callback({});
    }
  }, { useSystemPicker: false });
}

function getAppWebPreferences() {
  return {
    preload: path.join(__dirname, 'preload.js'),
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: true,
  };
}

function cloneUpdateState() {
  return {
    ...updateState,
    currentVersion: app.getVersion(),
  };
}

function isUpdaterSupported() {
  if (!autoUpdater || !app.isPackaged) return false;
  if (process.platform === 'win32') return false;
  return process.platform === 'darwin' || process.platform === 'linux';
}

function setUpdateState(nextState = {}) {
  Object.assign(updateState, nextState, {
    supported: isUpdaterSupported(),
    currentVersion: app.getVersion(),
  });
  if (nextState.status !== 'downloading') updateState.progress = nextState.progress ?? updateState.progress;
  const payload = cloneUpdateState();
  for (const win of [mainWindow, preferencesWindow, aboutWindow]) {
    if (win && !win.isDestroyed()) win.webContents.send('app-update-state', payload);
  }
  return payload;
}

function setupAutoUpdater() {
  setUpdateState({
    supported: isUpdaterSupported(),
    status: 'idle',
    message: 'Up to date',
  });
  if (!isUpdaterSupported()) return;

  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on('checking-for-update', () => {
    setUpdateState({ status: 'checking', message: 'Checking for updates...', error: '', progress: null });
  });
  autoUpdater.on('update-available', (info) => {
    setUpdateState({
      status: 'available',
      availableVersion: info?.version || '',
      message: info?.version ? `Version ${info.version} available` : 'Update available',
      progress: null,
    });
  });
  autoUpdater.on('update-not-available', () => {
    setUpdateState({ status: 'idle', availableVersion: '', message: 'Up to date', progress: null });
  });
  autoUpdater.on('download-progress', (progress) => {
    setUpdateState({
      status: 'downloading',
      message: 'Downloading update...',
      progress: {
        percent: Math.max(0, Math.min(100, Number(progress?.percent) || 0)),
        transferred: Number(progress?.transferred) || 0,
        total: Number(progress?.total) || 0,
      },
    });
  });
  autoUpdater.on('update-downloaded', (info) => {
    setUpdateState({
      status: 'downloaded',
      availableVersion: info?.version || updateState.availableVersion,
      message: updateState.availableVersion ? `Version ${updateState.availableVersion} ready` : 'Update ready',
      progress: null,
    });
  });
  autoUpdater.on('error', (error) => {
    setUpdateState({
      status: 'error',
      message: 'Update check failed.',
      error: error?.message || 'Update check failed.',
      progress: null,
    });
  });

  setTimeout(() => {
    checkForAppUpdates({ silent: true }).catch((error) => {
      console.error('[orange-fuji][updater] startup check failed:', error.message);
    });
  }, 4000);
}

async function checkForAppUpdates(options = {}) {
  if (!isUpdaterSupported()) {
    return setUpdateState({ status: 'unsupported', message: 'Up to date', progress: null });
  }
  if (updateCheckInProgress) return cloneUpdateState();
  updateCheckInProgress = true;
  try {
    const result = await autoUpdater.checkForUpdates();
    if (!result?.updateInfo && !options.silent) {
      setUpdateState({ status: 'idle', message: 'Up to date', progress: null });
    }
    return cloneUpdateState();
  } catch (error) {
    return setUpdateState({
      status: 'error',
      message: 'Update check failed.',
      error: error?.message || 'Update check failed.',
      progress: null,
    });
  } finally {
    updateCheckInProgress = false;
  }
}

async function downloadAppUpdate() {
  if (!isUpdaterSupported()) {
    return setUpdateState({ status: 'unsupported', message: 'Up to date', progress: null });
  }
  if (updateState.status !== 'available') return cloneUpdateState();
  setUpdateState({ status: 'downloading', message: 'Downloading update...', progress: { percent: 0, transferred: 0, total: 0 } });
  try {
    await autoUpdater.downloadUpdate();
    return cloneUpdateState();
  } catch (error) {
    return setUpdateState({
      status: 'error',
      message: 'Update download failed.',
      error: error?.message || 'Update download failed.',
      progress: null,
    });
  }
}

function installDownloadedAppUpdate() {
  if (!isUpdaterSupported()) {
    return setUpdateState({ status: 'unsupported', message: 'Up to date', progress: null });
  }
  if (updateState.status !== 'downloaded') return cloneUpdateState();
  setUpdateState({ status: 'installing', message: 'Installing update...' });
  autoUpdater.quitAndInstall(false, true);
  return cloneUpdateState();
}

function centeredBounds(size, display = screen.getPrimaryDisplay()) {
  const { workArea } = display;
  return {
    width: Math.min(size.width, workArea.width),
    height: Math.min(size.height, workArea.height),
    x: Math.round(workArea.x + (workArea.width - Math.min(size.width, workArea.width)) / 2),
    y: Math.round(workArea.y + (workArea.height - Math.min(size.height, workArea.height)) / 2),
  };
}

function getToolbarWindowBounds() {
  if (lastToolbarBounds) return constrainToolbarBoundsToWorkArea(lastToolbarBounds);
  const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()) || screen.getPrimaryDisplay();
  const { workArea } = display;
  return {
    width: TOOLBAR_WINDOW_SIZE.width,
    height: TOOLBAR_WINDOW_SIZE.height,
    x: Math.round(workArea.x + (workArea.width - TOOLBAR_WINDOW_SIZE.width) / 2),
    y: Math.round(workArea.y + 12),
  };
}

function constrainToolbarBoundsToWorkArea(bounds) {
  const center = {
    x: Math.round(bounds.x + bounds.width / 2),
    y: Math.round(bounds.y + bounds.height / 2),
  };
  const display = screen.getDisplayNearestPoint(center) || screen.getPrimaryDisplay();
  const { workArea } = display;
  const width = Math.min(Math.max(bounds.width, TOOLBAR_MIN_SIZE.width), workArea.width);
  const height = Math.min(Math.max(bounds.height, TOOLBAR_MIN_SIZE.height), workArea.height);
  return {
    width,
    height,
    x: Math.round(Math.min(Math.max(bounds.x, workArea.x), workArea.x + workArea.width - width)),
    y: Math.round(Math.min(Math.max(bounds.y, workArea.y), workArea.y + workArea.height - height)),
  };
}

function constrainBoundsToWorkArea(bounds, minimum = EDITOR_MIN_SIZE) {
  const center = {
    x: Math.round(bounds.x + bounds.width / 2),
    y: Math.round(bounds.y + bounds.height / 2),
  };
  const display = screen.getDisplayNearestPoint(center) || screen.getPrimaryDisplay();
  const { workArea } = display;
  const width = Math.min(Math.max(bounds.width, Math.min(minimum.width, workArea.width)), workArea.width);
  const height = Math.min(Math.max(bounds.height, Math.min(minimum.height, workArea.height)), workArea.height);
  return {
    width,
    height,
    x: Math.round(Math.min(Math.max(bounds.x, workArea.x), workArea.x + workArea.width - width)),
    y: Math.round(Math.min(Math.max(bounds.y, workArea.y), workArea.y + workArea.height - height)),
  };
}

function getEditorWindowBounds() {
  return constrainBoundsToWorkArea(lastEditorBounds || centeredBounds(EDITOR_DEFAULT_SIZE));
}

function rememberEditorBounds() {
  if (!mainWindow || mainWindow.isDestroyed() || mainWindowMode !== 'editor' || mainWindow.isMinimized()) return;
  const bounds = mainWindow.getBounds();
  if (bounds.width >= TOOLBAR_WINDOW_SIZE.width && bounds.height >= TOOLBAR_WINDOW_SIZE.height) {
    lastEditorBounds = bounds;
  }
}

function rememberToolbarBounds() {
  if (!mainWindow || mainWindow.isDestroyed() || mainWindowMode !== 'toolbar' || mainWindow.isMinimized()) return;
  const bounds = mainWindow.getBounds();
  if (bounds.width >= TOOLBAR_MIN_SIZE.width && bounds.height >= TOOLBAR_MIN_SIZE.height) {
    lastToolbarBounds = bounds;
  }
}

function applyToolbarWindowMode(options = {}) {
  if (mainWindowMode === 'editor') rememberEditorBounds();
  mainWindowMode = 'toolbar';
  if (process.platform === 'darwin') {
    try { mainWindow.setWindowButtonVisibility(false); } catch (_) {}
    try { mainWindow.setVibrancy(null); } catch (_) {}
  }

  if (mainWindow.isFullScreen()) mainWindow.setFullScreen(false);
  if (mainWindow.isMaximized()) mainWindow.unmaximize();
  mainWindow.setMinimumSize(TOOLBAR_MIN_SIZE.width, TOOLBAR_MIN_SIZE.height);
  mainWindow.setResizable(false);
  mainWindow.setMaximizable(false);
  if (typeof mainWindow.setFullScreenable === 'function') mainWindow.setFullScreenable(false);
  mainWindow.setContentProtection(false);
  mainWindow.setSkipTaskbar(process.platform === 'darwin');
  try { mainWindow.setHasShadow(false); } catch (_) {}
  try { mainWindow.setAlwaysOnTop(true, process.platform === 'darwin' ? 'floating' : 'normal'); } catch (_) { mainWindow.setAlwaysOnTop(true); }
  if (process.platform === 'darwin') {
    try { mainWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true }); } catch (_) {}
  }
  mainWindow.setBounds(getToolbarWindowBounds(), false);

  if (options.show) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    if (process.platform === 'darwin') {
      mainWindow.showInactive();
    } else {
      mainWindow.show();
      mainWindow.focus();
    }
  }
}

function applyEditorWindowMode(options = {}) {
  const wasEditor = mainWindowMode === 'editor';
  mainWindowMode = 'editor';
  if (process.platform === 'darwin') {
    try { mainWindow.setWindowButtonVisibility(true); } catch (_) {}
    try { mainWindow.setVibrancy('under-window'); } catch (_) {}
  }

  mainWindow.setResizable(true);
  mainWindow.setMaximizable(true);
  if (typeof mainWindow.setFullScreenable === 'function') mainWindow.setFullScreenable(true);
  mainWindow.setContentProtection(false);
  mainWindow.setMinimumSize(EDITOR_MIN_SIZE.width, EDITOR_MIN_SIZE.height);
  mainWindow.setSkipTaskbar(false);
  try { mainWindow.setAlwaysOnTop(false); } catch (_) {}
  if (process.platform === 'darwin') {
    try { mainWindow.setVisibleOnAllWorkspaces(false); } catch (_) {}
  }
  try { mainWindow.setHasShadow(true); } catch (_) {}

  if (!wasEditor || !mainWindow.isVisible()) {
    mainWindow.setBounds(getEditorWindowBounds(), false);
  }

  if (options.show) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.moveTop();
    mainWindow.focus();
  }
}

function showMainWindowForCurrentMode() {
  if (mainWindowMode === 'editor') applyEditorWindowMode({ show: true });
  else applyToolbarWindowMode({ show: true });
}


function isCaptureDataToastPayload(payload) {
  return payload?.type === 'single' || payload?.type === 'multi' || Array.isArray(payload?.screens);
}

function getPreviewToastDataUrl(payload) {
  if (typeof payload?.dataUrl === 'string') return payload.dataUrl;
  return payload?.screens?.find?.((screenData) => typeof screenData?.dataUrl === 'string')?.dataUrl || '';
}

function getPreviewToastDisplay() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    const bounds = mainWindow.getBounds();
    return screen.getDisplayNearestPoint({
      x: Math.round(bounds.x + bounds.width / 2),
      y: Math.round(bounds.y + bounds.height / 2),
    }) || screen.getPrimaryDisplay();
  }
  return screen.getDisplayNearestPoint(screen.getCursorScreenPoint()) || screen.getPrimaryDisplay();
}

function triggerPreviewToast(payload) {
  const dataUrl = getPreviewToastDataUrl(payload);
  if (!dataUrl) return;

  pendingPreviewToastPayload = payload;

  if (previewToastWindow && !previewToastWindow.isDestroyed()) {
    previewToastWindow.close();
  }

  const toastSize = { width: 240, height: 180 };
  const margin = 18;
  const { workArea } = getPreviewToastDisplay();
  const toastWindow = new BrowserWindow({
    width: toastSize.width,
    height: toastSize.height,
    x: Math.round(workArea.x + workArea.width - toastSize.width - margin),
    y: Math.round(workArea.y + workArea.height - toastSize.height - margin),
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    hasShadow: false,
    backgroundColor: '#00000000',
    show: false,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      sandbox: false,
    },
  });

  previewToastWindow = toastWindow;

  toastWindow.setAlwaysOnTop(true, process.platform === 'darwin' ? 'floating' : 'normal');
  if (process.platform === 'darwin') {
    try { toastWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true }); } catch (_) {}
  }

  const captureMode = isCaptureDataToastPayload(payload) ? 'fullscreen' : (payload?.captureMode || 'region');
  try { toastWindow.setHasShadow(false); } catch (_) {}
  toastWindow.loadFile(path.join(__dirname, 'renderer', 'preview-toast.html'), {
    query: {
      captureMode,
    },
  });
  toastWindow.once('ready-to-show', () => {
    if (toastWindow.isDestroyed()) return;
    if (process.platform === 'darwin') toastWindow.showInactive();
    else toastWindow.show();
  });
  toastWindow.on('closed', () => {
    if (previewToastWindow === toastWindow) previewToastWindow = null;
  });

  setTimeout(() => {
    if (!toastWindow.isDestroyed()) {
      toastWindow.close();
    }
  }, 4000);
}



function notifyRendererCaptureModeStarted() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send('capture-mode-started');
}

function notifyRendererCaptureFinished() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send('capture-finished');
}

function openPreferencesWindow() {
  if (preferencesWindow && !preferencesWindow.isDestroyed()) {
    preferencesWindow.focus();
    return;
  }

  preferencesWindow = new BrowserWindow({
    width: 520,
    height: 605,
    minWidth: 480,
    minHeight: 605,
    resizable: true,
    minimizable: false,
    maximizable: false,
    closable: true,
    movable: true,
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 14, y: 14 },
    vibrancy: process.platform === 'darwin' ? 'under-window' : undefined,
    visualEffectState: 'active',
    transparent: process.platform === 'darwin',
    backgroundColor: process.platform === 'darwin' ? '#00000000' : '#f5f1ec',
    autoHideMenuBar: true,
    title: 'Orange Fuji Preferences',
    webPreferences: getAppWebPreferences(),
  });

  preferencesWindow.loadFile(path.join(__dirname, 'renderer', 'preferences.html'));
  preferencesWindow.on('closed', () => {
    preferencesWindow = null;
  });
}

async function hideMacDesktopIconsForRecording(options = {}) {
  const shouldHide = process.platform === 'darwin' && options?.hideDesktopIcons !== false;
  if (!shouldHide) return;

  if (!desktopIconsHidden) {
    desktopIconsVisibleBeforeRecording = await getMacDesktopIconsVisible();
  }

  await setMacDesktopIconsVisible(false);
  desktopIconsHidden = true;
}

async function restoreMacDesktopIconsAfterRecording() {
  if (process.platform !== 'darwin' || !desktopIconsHidden) return;
  try {
    await setMacDesktopIconsVisible(desktopIconsVisibleBeforeRecording);
  } catch (restoreError) {
    console.error('[orange-fuji][recording] failed to restore desktop icons:', restoreError.message);
  } finally {
    desktopIconsHidden = false;
    desktopIconsVisibleBeforeRecording = true;
  }
}

function debugWindowState(tag) {
  const win = mainWindow;
  console.log('[orange-fuji][window-state]', {
    tag,
    appHidden: typeof app.isHidden === 'function' ? app.isHidden() : null,
    appFocused: typeof app.focus === 'function' ? Boolean(BrowserWindow.getFocusedWindow()) : null,
    hasFocusedWindow: Boolean(BrowserWindow.getFocusedWindow()),
    winExists: Boolean(win),
    winDestroyed: win ? win.isDestroyed() : null,
    winVisible: win && !win.isDestroyed() ? win.isVisible() : null,
    winMinimized: win && !win.isDestroyed() ? win.isMinimized() : null,
    winFocused: win && !win.isDestroyed() ? win.isFocused() : null,
    winLoading: win && !win.isDestroyed() ? win.webContents.isLoading() : null,
  });
}


function getMacScreenRecordingStatus() {
  if (process.platform !== 'darwin') return 'granted';
  try {
    return systemPreferences.getMediaAccessStatus('screen');
  } catch (err) {
    console.error('[orange-fuji] macOS screen recording permission check failed:', err.message);
    return 'unknown';
  }
}

async function openMacScreenRecordingSettings() {
  if (process.platform !== 'darwin') return;
  await shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture');
}

async function explainMacScreenRecordingPermission() {
  if (process.platform !== 'darwin') return;
  const result = await dialog.showMessageBox(mainWindow, {
    type: 'warning',
    buttons: ['Open System Settings', 'Not Now'],
    defaultId: 0,
    cancelId: 1,
    title: 'Screen Recording permission required',
    message: 'Orange Fuji needs macOS Screen Recording permission to capture the screen.',
    detail: 'Open System Settings → Privacy & Security → Screen & System Audio Recording, enable Orange Fuji, then quit and reopen the app before trying again.',
  });
  if (result.response === 0) await openMacScreenRecordingSettings();
}

async function ensureMacScreenRecordingPermission() {
  if (process.platform !== 'darwin') return true;
  const status = getMacScreenRecordingStatus();
  if (status === 'granted') return true;

  // Let a first capture attempt trigger Apple's TCC prompt when macOS still has
  // not made a decision. For explicit denials, fail fast with useful guidance.
  if (status === 'not-determined' || status === 'unknown') return true;

  await explainMacScreenRecordingPermission();
  return false;
}

async function getDefaultRecordingSource() {
  const primaryDisplay = screen.getPrimaryDisplay();
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: { width: 1, height: 1 },
  });
  return sources.find((source) => String(source.display_id) === String(primaryDisplay.id)) || sources[0];
}



function nativeMacWindowCapturePath() {
  return path.join(app.getPath('temp'), `orange-fuji-window-${process.pid}-${Date.now()}.png`);
}

function runNativeMacWindowCapture(filePath) {
  return new Promise((resolve, reject) => {
    execFile('/usr/sbin/screencapture', ['-i', '-w', '-x', '-t', 'png', filePath], (error, stdout, stderr) => {
      if (error) {
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

function readImageFileAsDataUrl(filePath) {
  const buffer = fs.readFileSync(filePath);
  return `data:image/png;base64,${buffer.toString('base64')}`;
}

async function captureNativeMacWindow() {
  if (process.platform !== 'darwin') return null;
  const filePath = nativeMacWindowCapturePath();
  let completed = false;
  try {
    await runNativeMacWindowCapture(filePath);
    if (!fs.existsSync(filePath) || fs.statSync(filePath).size === 0) {
      return { success: true, canceled: true };
    }
    const dataUrl = readImageFileAsDataUrl(filePath);
    copyDataUrlToClipboard(dataUrl);
    if (mainWindow) {
      applyToolbarWindowMode({ show: true });
      triggerPreviewToast({
        dataUrl,
        captureMode: 'window',
      });
      completed = true;
    }
    return { success: true };
  } catch (err) {
    if (!fs.existsSync(filePath) || fs.statSync(filePath).size === 0) {
      return { success: true, canceled: true };
    }
    console.error('[orange-fuji] native macOS window capture failed:', err.message, err.stderr || '');
    throw err;
  } finally {
    try { fs.unlinkSync(filePath); } catch (e) {}
    if (!completed && mainWindow && !mainWindow.isVisible()) showMainWindowForCurrentMode();
  }
}

function getHighQualityThumbnailSize(minWidth = 1920, minHeight = 1200) {
  const displays = screen.getAllDisplays();
  if (!displays.length) return { width: minWidth, height: minHeight };
  const maxScale = Math.max(...displays.map((display) => display.scaleFactor || 1));
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const display of displays) {
    minX = Math.min(minX, display.bounds.x);
    minY = Math.min(minY, display.bounds.y);
    maxX = Math.max(maxX, display.bounds.x + display.bounds.width);
    maxY = Math.max(maxY, display.bounds.y + display.bounds.height);
  }
  return {
    width: Math.max(minWidth, Math.ceil((maxX - minX) * maxScale)),
    height: Math.max(minHeight, Math.ceil((maxY - minY) * maxScale)),
  };
}


function shouldCaptureOrangeFuji(options = {}) {
  return options?.captureOrangeFuji === true;
}

function isOrangeFujiWindowText(value) {
  const text = String(value || '').toLowerCase();
  return text.includes('orange fuji') || text.includes('orange-fuji') || text.includes('pico');
}

function isOrangeFujiWindowSource(source) {
  const id = String(source?.id || '');
  return id.startsWith('window:') && isOrangeFujiWindowText(source?.name);
}

function toPickerSource(source) {
  const id = String(source?.id || '');
  const type = id.startsWith('screen:') ? 'screen' : 'window';
  const thumbnail = source?.thumbnail && !source.thumbnail.isEmpty()
    ? source.thumbnail.toDataURL()
    : '';
  return { id: source.id, name: source.name, type, thumbnail };
}

async function getDesktopSourcesForPicker(types = ['window']) {
  return desktopCapturer.getSources({
    types,
    thumbnailSize: getHighQualityThumbnailSize(),
    fetchWindowIcons: false,
  });
}

async function getWindowSourcesForPicker(options = {}) {
  const includeOrangeFuji = shouldCaptureOrangeFuji(options);
  const windowSources = (await getDesktopSourcesForPicker(['window']))
    .filter((source) => source && source.name && (includeOrangeFuji || !isOrangeFujiWindowSource(source)));

  let pickerSources = windowSources;
  let fallbackReason = '';

  if (pickerSources.length === 0) {
    // Some Windows/GPU combinations can fail to enumerate individual window
    // sources even though screen capture still works. Keep recording usable by
    // falling back to capturable screens instead of showing an empty picker.
    const screenSources = (await getDesktopSourcesForPicker(['screen']))
      .filter((source) => source && source.name);
    pickerSources = screenSources;
    fallbackReason = screenSources.length > 0
      ? 'No capturable windows were found. Select a screen to record instead.'
      : 'No capturable windows or screens were found.';
  }

  // Store full NativeImage references for later use on selection.
  windowPickerSources = pickerSources;
  return { sources: pickerSources.map(toPickerSource), fallbackReason };
}

async function openWindowPickerFallback(options = {}) {
  if (windowPickerWindow && !windowPickerWindow.isDestroyed()) {
    windowPickerWindow.focus();
    return { success: true, fallback: true };
  }

  windowPickerWindow = new BrowserWindow({
    width: 1100,
    height: 720,
    autoHideMenuBar: true,
    title: 'Select Window',
    resizable: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  windowPickerWindow.loadFile(path.join(__dirname, 'renderer', 'window-picker.html'));
  windowPickerWindow.on('closed', () => {
    windowPickerWindow = null;
    if (!recordingSourceSelection && mainWindow) showMainWindowForCurrentMode();
  });

  windowPickerWindow.webContents.once('did-finish-load', async () => {
    const payload = await getWindowSourcesForPicker(options);
    windowPickerWindow?.webContents.send('window-sources', payload);
  });

  return { success: true, fallback: true };
}



let finderRestartInProgress = null;

function restartFinder(visible) {
  const flag = visible ? 'true' : 'false';
  execSync(`defaults write com.apple.finder CreateDesktop -bool ${flag}`, { encoding: 'utf8', timeout: 5000 });
  try {
    execSync('killall Finder', { encoding: 'utf8', timeout: 5000 });
  } catch (_) {
    try {
      execSync('open /System/Library/CoreServices/Finder.app', { encoding: 'utf8', timeout: 5000 });
    } catch (_) {}
  }
}

async function setMacDesktopIconsVisible(visible) {
  if (process.platform !== 'darwin') return;
  if (finderRestartInProgress) await finderRestartInProgress;
  finderRestartInProgress = (async () => {
    restartFinder(visible);
  })();
  try {
    await finderRestartInProgress;
  } finally {
    finderRestartInProgress = null;
  }
}

async function getMacDesktopIconsVisible() {
  if (process.platform !== 'darwin') return true;
  try {
    const value = execSync('defaults read com.apple.finder CreateDesktop', { encoding: 'utf8', timeout: 5000 }).trim().toLowerCase();
    return value !== '0' && value !== 'false' && value !== 'no';
  } catch (_) {
    return true;
  }
}

async function withHiddenDesktopIcons(options = {}, action) {
  const shouldHide = process.platform === 'darwin' && options?.hideDesktopIcons !== false;
  if (!shouldHide) return action();
  if (desktopIconsHidden) return action();
  const wasVisible = await getMacDesktopIconsVisible();
  if (!wasVisible) return action();
  try {
    await setMacDesktopIconsVisible(false);
  } catch (hideError) {
    console.error('[orange-fuji][capture] failed to hide desktop icons:', hideError.message);
    return action();
  }
  desktopIconsHidden = true;

  // Give macOS time to repaint the desktop after killing Finder
  await new Promise(resolve => setTimeout(resolve, 350));

  try {
    return await action();
  } finally {
    try {
      await setMacDesktopIconsVisible(wasVisible);
    } catch (restoreError) {
      console.error('[orange-fuji][capture] failed to restore desktop icons:', restoreError.message);
    }
    desktopIconsHidden = false;
  }
}

function copyDataUrlToClipboard(dataUrl) {
  if (!dataUrl) return;
  const image = nativeImage.createFromDataURL(dataUrl);
  clipboard.writeImage(image);
}

function copyCaptureDataToClipboard(captureData) {
  if (!captureData) return;
  if (captureData.type === 'single') {
    copyDataUrlToClipboard(captureData.dataUrl);
    return;
  }
  const orderedScreens = [...(captureData.screens || [])].sort((a, b) => {
    if (a.bounds.y !== b.bounds.y) return a.bounds.y - b.bounds.y;
    return a.bounds.x - b.bounds.x;
  });
  copyDataUrlToClipboard(orderedScreens[0]?.dataUrl);
}

// ── Window Bounds Enumeration ───────────────────────────────────────────────

function getVisibleWindowBounds() {
  try {
    if (process.platform === 'win32') {
      return getWindowBoundsWindows();
    } else if (process.platform === 'darwin') {
      return getWindowBoundsMac();
    }
  } catch (err) {
    console.error('Window enumeration failed:', err.message);
  }
  return [];
}

function isOrangeFujiWindowBound(win) {
  return isOrangeFujiWindowText(win?.name) ||
    isOrangeFujiWindowText(win?.owner) ||
    isOrangeFujiWindowText(win?.title);
}

function filterOrangeFujiWindowBounds(windowBounds, includeOrangeFuji) {
  if (includeOrangeFuji) return windowBounds;
  return (windowBounds || []).filter((win) => !isOrangeFujiWindowBound(win));
}

function getWindowBoundsWindows() {
  // Use UIAutomation .NET assembly (pre-compiled, no CSC needed) with fallback to P/Invoke.
  // UIAutomation is much more reliable in packaged Electron apps where inline C# compilation
  // can be blocked by antivirus or restricted execution contexts.
  const psScript = `
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new()
try {
  Add-Type -AssemblyName UIAutomationClient
  Add-Type -AssemblyName UIAutomationTypes

  $root = [System.Windows.Automation.AutomationElement]::RootElement
  $cond = New-Object System.Windows.Automation.PropertyCondition(
    [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
    [System.Windows.Automation.ControlType]::Window
  )
  $windows = $root.FindAll([System.Windows.Automation.TreeScope]::Children, $cond)

  $results = @()
  foreach ($w in $windows) {
    try {
      if (-not $w.Current.IsOffscreen) {
        $rect = $w.Current.BoundingRectangle
        $name = $w.Current.Name
        if ([string]::IsNullOrWhiteSpace($name)) { continue }
        if ($rect.Width -lt 50 -or $rect.Height -lt 30) { continue }
        if ($rect.IsEmpty) { continue }
        $handle = [int64]$w.Current.NativeWindowHandle
        $pid = [int]$w.Current.ProcessId
        $sourceIds = @()
        if ($handle -gt 0 -and $pid -gt 0) { $sourceIds += "window:$($handle):$($pid)" }
        if ($handle -gt 0) { $sourceIds += "window:$($handle):0" }
        $results += @{
          name = $name
          x = [int]$rect.X
          y = [int]$rect.Y
          width = [int]$rect.Width
          height = [int]$rect.Height
          windowId = $handle
          processId = $pid
          sourceIds = $sourceIds
        }
      }
    } catch { continue }
  }

  if ($results.Count -eq 0) {
    Write-Output '[]'
  } else {
    $json = ConvertTo-Json -InputObject @($results) -Compress -Depth 2
    Write-Output $json
  }
} catch {
  Write-Error $_.Exception.Message
  Write-Output '[]'
}
`;

  const tmpFile = path.join(app.getPath('temp'), 'orange-fuji-enum-win.ps1');
  try {
    fs.writeFileSync(tmpFile, psScript, { encoding: 'utf8' });
  } catch (e) {
    console.error('[orange-fuji] Cannot write temp PS script:', e.message);
    return [];
  }

  try {
    const output = execSync(
      `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "${tmpFile}"`,
      { encoding: 'utf8', timeout: 15000, windowsHide: true }
    );
    const trimmed = output.trim();
    if (!trimmed || !trimmed.startsWith('[')) {
      console.error('[orange-fuji] PS window enum: unexpected output:', trimmed.slice(0, 300));
      return [];
    }
    const result = JSON.parse(trimmed);
    // Windows 10/11: UIAutomation BoundingRectangle includes invisible DWM frame
    // and has asymmetric vertical chrome (title bar + drop shadow) that changes with theme/DPI.
    // Keep this as a single calibration block so we can tune capture alignment
    // without touching the rest of the capture pipeline.
    // No frame inset - use bounds as-is. The highlight will be slightly larger
    // than the visible window, giving a comfortable margin around it.
    const corrected = result;
    console.log(`[orange-fuji] UIAutomation window enum OK: ${corrected.length} windows found`);
    return corrected;
  } catch (e) {
    console.error('[orange-fuji] PS window enum failed:', e.message);
    if (e.stderr) console.error('[orange-fuji] stderr:', e.stderr.toString().slice(0, 500));
    return [];
  } finally {
    try { fs.unlinkSync(tmpFile); } catch (e) {}
  }
}

function getWindowBoundsMac() {
  // Prefer Quartz CGWindow metadata because it matches desktopCapturer window ids.
  // Run a Python 2/3 compatible script so the legacy Intel build works on older
  // macOS installs that still expose PyObjC through /usr/bin/python, while new
  // Apple Silicon Macs can use python3 when available.
  const script = `
import json
import sys
try:
    from Quartz import CGWindowListCopyWindowInfo, kCGWindowListOptionOnScreenOnly, kCGWindowListExcludeDesktopElements, kCGNullWindowID
    wl = CGWindowListCopyWindowInfo(kCGWindowListOptionOnScreenOnly | kCGWindowListExcludeDesktopElements, kCGNullWindowID)
    r = []
    for w in wl:
        b = w.get('kCGWindowBounds', {})
        if w.get('kCGWindowLayer', 0) != 0: continue
        owner = w.get('kCGWindowOwnerName', '') or ''
        name = w.get('kCGWindowName', '') or ''
        title = (owner + ' - ' + name) if name else owner
        width, height = int(b.get('Width', 0)), int(b.get('Height', 0))
        window_id = int(w.get('kCGWindowNumber', 0) or 0)
        owner_pid = int(w.get('kCGWindowOwnerPID', 0) or 0)
        if width < 50 or height < 30: continue
        if window_id <= 0: continue
        source_ids = ['window:%s:0' % window_id]
        if owner_pid > 0:
            source_ids.append('window:%s:%s' % (window_id, owner_pid))
        r.append({
            'name': title,
            'owner': owner,
            'title': name,
            'x': int(b.get('X', 0)),
            'y': int(b.get('Y', 0)),
            'width': width,
            'height': height,
            'windowId': window_id,
            'processId': owner_pid,
            'sourceIds': source_ids,
        })
    sys.stdout.write(json.dumps(r))
except Exception as ex:
    sys.stdout.write('[]')
    sys.stderr.write(str(ex))
`;
  const interpreters = ['python3', '/usr/bin/python3', '/usr/bin/python'];
  for (const interpreter of interpreters) {
    try {
      const output = execSync(`${interpreter} -c ${JSON.stringify(script)}`, {
        encoding: 'utf8', timeout: 5000
      });
      const parsed = JSON.parse(output.trim() || '[]');
      if (parsed.length > 0) return parsed;
    } catch (e) {
      console.error(`Mac window enum error via ${interpreter}:`, e.message);
    }
  }
  return [];
}

function normalizeWindowName(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[\u2013\u2014]/g, '-')
    .replace(/\s+/g, ' ')
    .trim();
}

function getDesktopCapturerWindowKey(source) {
  const match = String(source?.id || '').match(/^window:(\d+):/);
  return match ? match[1] : null;
}

function sourceNameMatchesWindow(sourceName, win) {
  const source = normalizeWindowName(sourceName);
  const full = normalizeWindowName(win.name);
  const owner = normalizeWindowName(win.owner);
  const title = normalizeWindowName(win.title);
  if (!source) return false;
  return source === full ||
    (title && source === title) ||
    (owner && source === owner) ||
    (title && source.includes(title)) ||
    (full && full.includes(source));
}

function attachCapturerSourcesToWindowBounds(windowBounds, capturerSources, options = {}) {
  const includeOrangeFuji = shouldCaptureOrangeFuji(options);
  const sources = (capturerSources || [])
    .filter((source) => source && source.id && source.name && (includeOrangeFuji || !isOrangeFujiWindowSource(source)));
  if (sources.length === 0) return windowBounds;

  return windowBounds.map((win) => {
    const sourceIds = Array.isArray(win.sourceIds) ? win.sourceIds : [win.sourceIds].filter(Boolean);
    const candidateIds = new Set(sourceIds.map(String));
    let source = sources.find((item) => candidateIds.has(String(item.id)));

    if (!source && win.windowId) {
      const windowId = String(win.windowId);
      source = sources.find((item) => getDesktopCapturerWindowKey(item) === windowId);
    }

    if (!source) {
      source = sources.find((item) => sourceNameMatchesWindow(item.name, win));
    }

    return source
      ? { ...win, sourceId: source.id, sourceName: source.name }
      : win;
  });
}

// ── Window Creation ─────────────────────────────────────────────────────────


function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function showWindowInactiveOnMac(win) {
  if (!win || win.isDestroyed()) return;
  if (process.platform === 'darwin') win.showInactive();
  else win.show();
}

function rememberMacRecordingReturnApp() {
  if (process.platform !== 'darwin') return;
  try {
    const appPath = execSync('osascript -e \'POSIX path of (path to frontmost application as alias)\'', {
      encoding: 'utf8',
      timeout: 1500,
    }).trim();
    const normalized = appPath.toLowerCase();
    if (!appPath || normalized.includes('/electron.app') || normalized.includes('/orange-fuji/')) return;
    recordingReturnAppPath = appPath;
  } catch (error) {
    console.error('[orange-fuji][recording] failed to remember frontmost app:', error.message);
  }
}

function restoreMacRecordingReturnApp() {
  if (process.platform !== 'darwin' || !recordingReturnAppPath) return;
  const appPath = recordingReturnAppPath;
  execFile('open', [appPath], (error) => {
    if (error) console.error('[orange-fuji][recording] failed to restore frontmost app:', error.message);
  });
}

function showRecordingIndicator(options = {}) {
  if (recordingIndicatorWindows.length > 0) {
    recordingIndicatorWindows.forEach(showWindowInactiveOnMac);
    return;
  }

  // Determine which display should show the stop controls
  let targetDisplay = screen.getPrimaryDisplay();
  if (lastRecordingRegion?.displayId) {
    const allDisplays = screen.getAllDisplays();
    const matched = allDisplays.find(d => String(d.id) === String(lastRecordingRegion.displayId));
    if (matched) targetDisplay = matched;
  } else if (lastRecordingSourceId) {
    const sourceIdStr = String(lastRecordingSourceId);
    if (sourceIdStr.startsWith('screen:')) {
      const parts = sourceIdStr.split(':');
      const displayId = parts[1];
      const allDisplays = screen.getAllDisplays();
      const matched = allDisplays.find(d => String(d.id) === displayId);
      if (matched) targetDisplay = matched;
    } else {
      const cursorPoint = screen.getCursorScreenPoint();
      targetDisplay = screen.getDisplayNearestPoint(cursorPoint);
    }
  }

  const controlWidth = 276;
  const controlHeight = 54;
  const allDisplays = screen.getAllDisplays();
  const dimOpacity = 'rgba(0, 0, 0, 0.52)';
  const statusText = lastRecordingRegion ? 'Recording region' : 'Recording';
  const shouldShowRegionOverlay = Boolean(lastRecordingRegion);

  for (const display of allDisplays) {
    const { bounds } = display;
    const regionOnDisplay = lastRecordingRegion && String(lastRecordingRegion.displayId) === String(display.id)
      ? {
          left: Math.max(0, Math.round(lastRecordingRegion.x)),
          top: Math.max(0, Math.round(lastRecordingRegion.y)),
          width: Math.max(1, Math.round(lastRecordingRegion.width)),
          height: Math.max(1, Math.round(lastRecordingRegion.height)),
        }
      : null;
    if (regionOnDisplay) {
      regionOnDisplay.right = Math.max(0, bounds.width - regionOnDisplay.left - regionOnDisplay.width);
      regionOnDisplay.bottom = Math.max(0, bounds.height - regionOnDisplay.top - regionOnDisplay.height);
    }
    const dimBlocks = regionOnDisplay ? `
          <div class="recording-dim" style="left:0;top:0;width:100%;height:${regionOnDisplay.top}px"></div>
          <div class="recording-dim" style="left:0;top:${regionOnDisplay.top}px;width:${regionOnDisplay.left}px;height:${regionOnDisplay.height}px"></div>
          <div class="recording-dim" style="right:0;top:${regionOnDisplay.top}px;width:${regionOnDisplay.right}px;height:${regionOnDisplay.height}px"></div>
          <div class="recording-dim" style="left:0;bottom:0;width:100%;height:${regionOnDisplay.bottom}px"></div>`
      : (lastRecordingRegion ? '<div class="recording-dim full"></div>' : '');
    if (shouldShowRegionOverlay) {
      const overlayWindow = new BrowserWindow({
        width: bounds.width,
        height: bounds.height,
        x: bounds.x,
        y: bounds.y,
        frame: false,
        transparent: true,
        backgroundColor: '#00000000',
        resizable: false,
        movable: false,
        alwaysOnTop: true,
        skipTaskbar: true,
        hasShadow: false,
        show: false,
        autoHideMenuBar: true,
        fullscreenable: true,
        enableLargerThanScreen: true,
        webPreferences: {
          contextIsolation: false,
          nodeIntegration: true,
          sandbox: false,
        },
      });

      overlayWindow.setAlwaysOnTop(true, 'screen-saver');
      overlayWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
      overlayWindow.setContentProtection(true);
      overlayWindow.setIgnoreMouseEvents(true, { forward: true });

      overlayWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(`
      <!DOCTYPE html>
      <html>
        <head>
          <style>
            * { box-sizing: border-box; }
            body {
              margin: 0;
              width: 100vw;
              height: 100vh;
              overflow: hidden;
              background: transparent;
              user-select: none;
              pointer-events: none;
            }
            .recording-dim {
              position: fixed;
              background: ${dimOpacity};
              pointer-events: none;
            }
            .recording-dim.full { inset: 0; }
          </style>
        </head>
        <body>
          ${dimBlocks}
        </body>
      </html>
    `)}`);

      overlayWindow.webContents.once('did-finish-load', () => {
        if (overlayWindow.isDestroyed()) return;
        overlayWindow.setBounds({
          x: bounds.x,
          y: bounds.y,
          width: bounds.width,
          height: bounds.height,
        }, false);
        overlayWindow.showInactive();
      });

      overlayWindow.on('closed', () => {
        recordingIndicatorWindows = recordingIndicatorWindows.filter(w => w !== overlayWindow);
      });

      recordingIndicatorWindows.push(overlayWindow);
    }
  }

  const { workArea } = targetDisplay;
  const controlsX = Math.round(workArea.x + (workArea.width - controlWidth) / 2);
  const controlsY = Math.round(workArea.y + workArea.height - controlHeight - 16);
  const controlsWindow = new BrowserWindow({
    width: controlWidth,
    height: controlHeight,
    x: controlsX,
    y: controlsY,
    ...(process.platform === 'darwin' ? { acceptFirstMouse: true } : {}),
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: false,
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: false,
      nodeIntegration: true,
      sandbox: false,
    },
  });

  controlsWindow.setAlwaysOnTop(true, 'screen-saver');
  controlsWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  controlsWindow.setContentProtection(true);

  controlsWindow.webContents.once('did-finish-load', () => {
    showWindowInactiveOnMac(controlsWindow);
  });

  controlsWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(`
  <!DOCTYPE html>
  <html>
    <head>
      <style>
        * { box-sizing: border-box; }
        body {
          margin: 0;
          width: 100vw;
          height: 100vh;
          overflow: hidden;
          background: transparent;
          font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
          user-select: none;
        }
        .recording-controls {
          width: 100vw;
          height: 100vh;
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 12px;
          padding: 8px 12px 8px 14px;
          border: 1px solid rgba(255, 255, 255, 0.10);
          border-radius: 12px;
          background: rgba(14, 14, 17, 0.92);
          color: #f5f0eb;
          box-shadow: 0 8px 32px rgba(0,0,0,0.6), 0 1px 0 rgba(255,255,255,0.04) inset;
          backdrop-filter: blur(20px);
          pointer-events: auto;
        }
        .status { display: flex; align-items: center; gap: 9px; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 11px; font-weight: 700; letter-spacing: 0.04em; color: rgba(255,255,255,0.7); }
        .dot { width: 10px; height: 10px; border-radius: 50%; background: #ef4444; }
        button {
          border: 1px solid rgba(255, 255, 255, 0.12);
          border-radius: 8px;
          padding: 8px 14px;
          background: rgba(30, 31, 36, 0.95);
          color: #fecaca;
          font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
          font-size: 11px;
          font-weight: 700;
          letter-spacing: 0.04em;
          cursor: pointer;
          outline: none;
          transition: background 0.12s, border-color 0.12s;
          display: flex;
          align-items: center;
          gap: 6px;
        }
        button:focus,
        button:focus-visible {
          outline: none;
          box-shadow: none;
        }
        button::before {
          content: '';
          width: 8px;
          height: 8px;
          border-radius: 2px;
          background: #ef4444;
          flex-shrink: 0;
        }
        button:hover {
          background: rgba(239, 68, 68, 0.15);
          border-color: rgba(239, 68, 68, 0.5);
        }
      </style>
    </head>
    <body>
      <div class="recording-controls">
        <div class="status"><span class="dot"></span><span>${escapeHtml(statusText)}</span></div>
        <button id="stop">Stop</button>
      </div>
      <script>
        const { ipcRenderer } = require('electron');
        const stop = document.getElementById('stop');
        if (stop) stop.addEventListener('click', () => ipcRenderer.send('pro-recording-stop-clicked'));
      </script>
    </body>
  </html>
`)}`);

  controlsWindow.on('closed', () => {
    recordingIndicatorWindows = recordingIndicatorWindows.filter(w => w !== controlsWindow);
  });

  recordingIndicatorWindows.push(controlsWindow);

  // Keep Orange Fuji visible when the renderer is showing the selected stream inline.
  if (!options.inlinePreview && mainWindow && !mainWindow.isDestroyed()) {
    if (process.platform === 'darwin') mainWindow.hide();
    else mainWindow.minimize();
  }
}

function hideRecordingIndicator() {
  for (const w of recordingIndicatorWindows) {
    if (!w.isDestroyed()) w.close();
  }
  recordingIndicatorWindows = [];
  lastRecordingSourceId = null;
  lastRecordingRegion = null;
  restoreMacDesktopIconsAfterRecording();

  // Restore Orange Fuji main window when recording ends
  if (mainWindow && !mainWindow.isDestroyed()) {
    showMainWindowForCurrentMode();
  }
}

function showAboutDialog() {
  if (aboutWindow && !aboutWindow.isDestroyed()) {
    aboutWindow.focus();
    return;
  }

  const pkg = require('../package.json');
  const iconPath = path.join(__dirname, 'assets', 'icons', 'icon.png');
  const iconDataUrl = (() => {
    try {
      const img = nativeImage.createFromPath(iconPath);
      if (img.isEmpty()) return '';
      return img.toDataURL();
    } catch (_) {
      return '';
    }
  })();

  aboutWindow = new BrowserWindow({
    width: 380,
    height: 430,
    resizable: false,
    maximizable: false,
    minimizable: false,
    closable: true,
    movable: true,
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 14, y: 14 },
    vibrancy: process.platform === 'darwin' ? 'under-window' : undefined,
    visualEffectState: 'active',
    transparent: process.platform === 'darwin',
    backgroundColor: process.platform === 'darwin' ? '#00000000' : '#f5f1ec',
    title: 'About Orange Fuji',
    show: false,
    center: true,
    autoHideMenuBar: true,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
    },
  });

  aboutWindow.loadFile(path.join(__dirname, 'renderer', 'about.html'), {
    query: { version: pkg.version, description: pkg.description },
  });

  aboutWindow.once('ready-to-show', () => {
    aboutWindow.show();
    aboutWindow.focus();
    aboutWindow.webContents.executeJavaScript(`
      document.getElementById('icon').src = '${iconDataUrl}';
    `);
  });

  aboutWindow.on('closed', () => {
    aboutWindow = null;
  });

  aboutWindow.setMenuBarVisibility(false);
}

function createMainWindow(focusOnReady = false) {
  if (mainWindow && !mainWindow.isDestroyed()) return;
  const pkg = require(path.join(__dirname, '..', 'package.json'));
  const toolbarBounds = getToolbarWindowBounds();
  mainWindow = new BrowserWindow({
    ...toolbarBounds,
    type: 'panel',
    minWidth: TOOLBAR_MIN_SIZE.width,
    minHeight: TOOLBAR_MIN_SIZE.height,
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    transparent: true,
    frame: false,
    backgroundColor: '#00000000',
    autoHideMenuBar: true,
    titleBarStyle: process.platform === 'darwin' ? 'hidden' : 'default',
    alwaysOnTop: true,
    skipTaskbar: process.platform === 'darwin',
    hasShadow: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // Region recording composites the desktop stream through a canvas in this
      // renderer while the main window is minimized. Keep timers and animation
      // frames running so MediaRecorder receives actual video frames.
      backgroundThrottling: false,
    },
    icon: path.join(__dirname, 'assets', 'icons', 'linux', 'icons', '512x512.png'),
    show: false,
  });


  // Keep the pill visible to external proof recordings. The recording pipeline
  // hides Orange Fuji windows before capturing desktop frames, so capture recursion is
  // handled there instead of by shielding the normal UI from screen capture.
  mainWindow.setContentProtection(false);
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  if (process.platform === 'darwin') {
    try { mainWindow.setWindowButtonVisibility(false); } catch (_) {}
  }
  mainWindow.once('ready-to-show', () => {
    showMainWindowForCurrentMode();
    if (focusOnReady) {
      mainWindow.show();
      mainWindow.focus();
      mainWindow.webContents.send('toolbar-open-requested');
    }
  });
  mainWindow.webContents.on('did-finish-load', () => console.log('[orange-fuji][main] did-finish-load'));
  mainWindow.webContents.on('render-process-gone', (_, details) => console.error('[orange-fuji][main] render-process-gone', details));
  mainWindow.webContents.on('did-fail-load', (_, code, desc) => console.error('[orange-fuji][main] did-fail-load', code, desc));
  mainWindow.on('minimize', (event) => {
    if (process.platform === 'darwin') {
      event.preventDefault();
      mainWindow.hide();
    }
  });
  mainWindow.on('resize', rememberEditorBounds);
  mainWindow.on('move', rememberEditorBounds);
  mainWindow.on('resize', rememberToolbarBounds);
  mainWindow.on('move', rememberToolbarBounds);
  mainWindow.on('closed', () => { mainWindow = null; });
}

// ── Screen Capture ──────────────────────────────────────────────────────────

function getNativeImagePixelSize(image) {
  if (!image || image.isEmpty()) return { width: 0, height: 0 };
  const bitmapSize = typeof image.getBitmapSize === 'function' ? image.getBitmapSize() : null;
  const size = bitmapSize && bitmapSize.width > 0 && bitmapSize.height > 0
    ? bitmapSize
    : image.getSize();
  return { width: Math.round(size.width), height: Math.round(size.height) };
}

function getSourceForDisplay(sourceByDisplayId, sources, display, index) {
  return sourceByDisplayId.get(String(display.id)) || sources[index] || sources[0];
}

async function captureAllScreens() {
  const displays = screen.getAllDisplays();
  
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  displays.forEach(d => {
    minX = Math.min(minX, d.bounds.x);
    minY = Math.min(minY, d.bounds.y);
    maxX = Math.max(maxX, d.bounds.x + d.bounds.width);
    maxY = Math.max(maxY, d.bounds.y + d.bounds.height);
  });
  
  const totalWidth = maxX - minX;
  const totalHeight = maxY - minY;
  const maxScale = Math.max(...displays.map(d => d.scaleFactor || 1));
  const maxDisplayWidth = Math.max(...displays.map(d => d.bounds.width * (d.scaleFactor || 1)));
  const maxDisplayHeight = Math.max(...displays.map(d => d.bounds.height * (d.scaleFactor || 1)));

  // Request a thumbnail large enough for the largest physical display and then
  // keep Electron's returned bitmap size. Resizing to logical bounds breaks
  // Retina/HiDPI captures on modern Macs, while this remains compatible with
  // the legacy x64 macOS build where getBitmapSize may not exist.
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: {
      width: Math.ceil(maxDisplayWidth),
      height: Math.ceil(maxDisplayHeight),
    },
  });

  if (sources.length === 0 || sources.every((source) => !source.thumbnail || source.thumbnail.isEmpty())) {
    if (process.platform === 'darwin') await explainMacScreenRecordingPermission();
    throw new Error('No capturable screen sources were returned.');
  }

  const sourceByDisplayId = new Map();
  for (const source of sources) {
    if (source.display_id) sourceByDisplayId.set(String(source.display_id), source);
  }

  const screensData = displays.map((display, index) => {
    const source = getSourceForDisplay(sourceByDisplayId, sources, display, index);
    if (!source || !source.thumbnail || source.thumbnail.isEmpty()) {
      throw new Error(`No source for display ${display.id}`);
    }
    const pixelSize = getNativeImagePixelSize(source.thumbnail);
    const scaleFactor = pixelSize.width > 0 && display.bounds.width > 0
      ? pixelSize.width / display.bounds.width
      : (display.scaleFactor || 1);
    return {
      dataUrl: source.thumbnail.toDataURL(),
      sourceId: source.id,
      bounds: display.bounds,
      scaleFactor,
      pixelSize,
      displayId: display.id,
    };
  });

  if (displays.length > 1) {
    return {
      type: 'multi',
      screens: screensData,
      virtualBounds: { x: minX, y: minY, width: totalWidth, height: totalHeight },
      maxScale,
    };
  }

  const screenData = screensData[0];
  return {
    type: 'single',
    dataUrl: screenData.dataUrl,
    sourceId: screenData.sourceId,
    bounds: screenData.bounds,
    scaleFactor: screenData.scaleFactor,
    pixelSize: screenData.pixelSize,
    displayId: screenData.displayId,
  };
}

async function createCaptureOverlays(captureData, mode = 'region', windowBounds = []) {
    const displays = screen.getAllDisplays();
    const readyPromises = [];
    const isRecordingRegionOverlay = process.platform === 'darwin' && mode === 'record-region';
  
    displays.forEach((display) => {
      const win = new BrowserWindow({
        x: display.bounds.x,
        y: display.bounds.y,
        width: display.bounds.width,
        height: display.bounds.height,
        type: 'panel',
        frame: false,
        transparent: true,
        backgroundColor: '#00000000',
        hasShadow: false,
        skipTaskbar: true,
        resizable: false,
        movable: false,
        fullscreenable: true,
        enableLargerThanScreen: true,
        ...(isRecordingRegionOverlay ? { acceptFirstMouse: true } : {}),
        show: false,
        webPreferences: {
          preload: path.join(__dirname, 'preload.js'),
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
        },
      });
  
      win.setAlwaysOnTop(true, 'screen-saver');
      if (process.platform === 'darwin') {
        try { win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true }); } catch (_) {}
      }
      win.loadFile(path.join(__dirname, 'renderer', 'capture-overlay.html'));
  
      const p = new Promise((resolve) => {
        win.webContents.once('did-finish-load', () => {
          win.setBounds({
            x: display.bounds.x, y: display.bounds.y,
            width: display.bounds.width, height: display.bounds.height,
          });
          if (isRecordingRegionOverlay) win.showInactive();
          else win.show();
  
          const screenData = captureData.type === 'multi'
            ? captureData.screens.find(s =>
                s.bounds.x === display.bounds.x && s.bounds.y === display.bounds.y &&
                s.bounds.width === display.bounds.width && s.bounds.height === display.bounds.height
              )
            : captureData;
  
          const displayWindowBounds = windowBounds
            .map((wb) => {
              const dx1 = display.bounds.x;
              const dy1 = display.bounds.y;
              const dx2 = display.bounds.x + display.bounds.width;
              const dy2 = display.bounds.y + display.bounds.height;
              const ix1 = Math.max(wb.x, dx1);
              const iy1 = Math.max(wb.y, dy1);
              const ix2 = Math.min(wb.x + wb.width, dx2);
              const iy2 = Math.min(wb.y + wb.height, dy2);
              if (ix2 - ix1 <= 0 || iy2 - iy1 <= 0) return null;
              return {
                ...wb,
                x: ix1 - dx1,
                y: iy1 - dy1,
                width: ix2 - ix1,
                height: iy2 - iy1,
              };
            })
            .filter(Boolean);
  
          win.webContents.send('capture-data', {
            mode,
            type: 'single',
            dataUrl: screenData ? screenData.dataUrl : captureData.dataUrl,
            bounds: display.bounds,
            scaleFactor: screenData?.scaleFactor || display.scaleFactor || 1,
            pixelSize: screenData?.pixelSize,
            displayId: screenData?.displayId || display.id,
            sourceId: screenData?.sourceId,
            windowBounds: displayWindowBounds,
            platform: process.platform,
          });
  
          resolve();
        });
      });
      readyPromises.push(p);
  
      win.on('closed', () => { captureWindows = captureWindows.filter(w => w !== win); });
      captureWindows.push(win);
    });
  
    await Promise.all(readyPromises);

    // Once screenshot overlays are visible, lift the toolbar pill above them without stealing app focus.
    // Recording region selection must stay overlay-only on macOS so full-screen app Spaces are not disturbed.
    if (mode !== 'record-region' && mainWindow && !mainWindow.isDestroyed()) {
      applyToolbarWindowMode();

      if (process.platform === 'darwin') {
        try { mainWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true }); } catch (_) {}
        try { mainWindow.setAlwaysOnTop(true, 'screen-saver'); } catch (_) { mainWindow.setAlwaysOnTop(true); }
      }

      showWindowInactiveOnMac(mainWindow);

      if (process.platform === 'darwin') {
        mainWindow.moveTop();
      }
    }
  }

function getOrangeFujiAppWindows() {
  return [mainWindow, preferencesWindow, windowPickerWindow, previewToastWindow]
    .filter((win) => win && !win.isDestroyed());
}

function setOrangeFujiWindowsContentProtection(enabled) {
  for (const win of getOrangeFujiAppWindows()) {
    try {
      win.setContentProtection(enabled);
    } catch (error) {
      console.error('[orange-fuji] failed to update Orange Fuji window content protection:', error.message);
    }
  }
}

async function hideOrangeFujiWindowsBeforeCapture(options = {}) {
  if (shouldCaptureOrangeFuji(options)) {
    setOrangeFujiWindowsContentProtection(false);
    return false;
  }

  const windowsToHide = getOrangeFujiAppWindows();

  for (const win of windowsToHide) {
    try {
      win.hide();
    } catch (error) {
      console.error('[orange-fuji][capture] failed to hide Orange Fuji window:', error.message);
    }
  }

  await new Promise((resolve) => setTimeout(resolve, process.platform === 'darwin' ? 260 : 160));
  return windowsToHide.length > 0;
}

async function captureRegion(options = {}) {
  notifyRendererCaptureModeStarted();
  try {
    if (!await hasUsageEntitlement()) {
      notifyRendererCaptureFinished();
      if (mainWindow) showMainWindowForCurrentMode();
      return { success: false, error: 'Trial expired. Activate a license to continue.' };
    }
    if (!await ensureMacScreenRecordingPermission()) {
      notifyRendererCaptureFinished();
      if (mainWindow) showMainWindowForCurrentMode();
      return { success: false, error: 'Screen Recording permission is required.' };
    }
    await hideOrangeFujiWindowsBeforeCapture(options);
    const captureData = await withHiddenDesktopIcons(options, async () => captureAllScreens());
    console.log('[orange-fuji][capture] capture data ready; creating overlays');
    await createCaptureOverlays(captureData, 'region', []);
    return { success: true };
  } catch (err) {
    notifyRendererCaptureFinished();
    console.error('[orange-fuji][capture] capture failed:', err.message);
    if (mainWindow) showMainWindowForCurrentMode();
    return { success: false, error: err.message };
  }
}

// ── IPC Handlers ────────────────────────────────────────────────────────────


ipcMain.handle('preview-toast-data', async () => {
  const payload = pendingPreviewToastPayload;
  return {
    dataUrl: getPreviewToastDataUrl(payload),
    captureMode: isCaptureDataToastPayload(payload) ? 'fullscreen' : (payload?.captureMode || 'region'),
  };
});

ipcMain.on('preview-toast-clicked', () => {
  const payload = pendingPreviewToastPayload;
  pendingPreviewToastPayload = null;

  if (previewToastWindow && !previewToastWindow.isDestroyed()) {
    previewToastWindow.close();
  }

  if (!payload || !mainWindow || mainWindow.isDestroyed()) return;

  applyEditorWindowMode({ show: true });

  if (isCaptureDataToastPayload(payload)) {
    mainWindow.webContents.send('load-capture-data', payload);
  } else {
    mainWindow.webContents.send('load-capture', payload);
  }
});

ipcMain.handle('start-capture', async (event, options = {}) => {
    console.log('[orange-fuji][capture] start-capture invoked');
    const showToolbarBeforeCapture = options?.showToolbar !== false;
    const includeOrangeFuji = shouldCaptureOrangeFuji(options);
    if (showToolbarBeforeCapture && includeOrangeFuji && mainWindow && !mainWindow.isDestroyed()) {
      if (process.platform === 'darwin') mainWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
      mainWindow.setAlwaysOnTop(true, process.platform === 'darwin' ? 'screen-saver' : 'normal');
      showWindowInactiveOnMac(mainWindow);
      mainWindow.moveTop();
    }
    if (showToolbarBeforeCapture && includeOrangeFuji) await new Promise(r => setTimeout(r, 120));
    return captureRegion(options);
  });

ipcMain.handle('start-capture-window', async (event, options = {}) => {
  notifyRendererCaptureModeStarted();
  if (!await hasUsageEntitlement()) {
    notifyRendererCaptureFinished();
    if (mainWindow) showMainWindowForCurrentMode();
    return { success: false, error: 'Trial expired. Activate a license to continue.' };
  }
  const includeOrangeFuji = shouldCaptureOrangeFuji(options);
  if (includeOrangeFuji && mainWindow && !mainWindow.isDestroyed()) {
    setOrangeFujiWindowsContentProtection(false);
    if (process.platform === 'darwin') mainWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    mainWindow.setAlwaysOnTop(true, process.platform === 'darwin' ? 'screen-saver' : 'normal');
    showWindowInactiveOnMac(mainWindow);
    mainWindow.moveTop();
  }
  if (includeOrangeFuji) {
    await new Promise(r => setTimeout(r, process.platform === 'darwin' ? 180 : 80));
  } else {
    await hideOrangeFujiWindowsBeforeCapture(options);
  }
  try {
    if (process.platform === 'darwin') {
      return await captureNativeMacWindow();
    }

    const captureData = await withHiddenDesktopIcons(options, async () => captureAllScreens());
    // Fetch capturer sources before showing the overlay. Native source ids let the
    // overlay select the exact window on macOS/Windows instead of relying on names.
    const windowSources = await desktopCapturer.getSources({
      types: ['window'],
      thumbnailSize: getHighQualityThumbnailSize(),
      fetchWindowIcons: false,
    });
    windowPickerSources = windowSources.filter(s => s && s.name && (includeOrangeFuji || !isOrangeFujiWindowSource(s)));

    const winBounds = attachCapturerSourcesToWindowBounds(
      filterOrangeFujiWindowBounds(getVisibleWindowBounds(), includeOrangeFuji),
      windowPickerSources,
      options,
    )
      .filter((win) => win.sourceId || process.platform !== 'darwin');

    if (winBounds.length === 0) {
      return openWindowPickerFallback(options);
    }

    await createCaptureOverlays(captureData, 'window', winBounds);
    return { success: true };
  } catch (err) {
    notifyRendererCaptureFinished();
    if (mainWindow) showMainWindowForCurrentMode();
    return { success: false, error: err.message };
  }
});

ipcMain.handle('start-capture-fullscreen', async (event, options = {}) => {
  notifyRendererCaptureModeStarted();
  if (!await hasUsageEntitlement()) {
    notifyRendererCaptureFinished();
    if (mainWindow) showMainWindowForCurrentMode();
    return { success: false, error: 'Trial expired. Activate a license to continue.' };
  }
  await hideOrangeFujiWindowsBeforeCapture(options);
  try {
    if (!await ensureMacScreenRecordingPermission()) {
      notifyRendererCaptureFinished();
      if (mainWindow) showMainWindowForCurrentMode();
      return { success: false, error: 'Screen Recording permission is required.' };
    }
    const captureData = await withHiddenDesktopIcons(options, async () => captureAllScreens());
    copyCaptureDataToClipboard(captureData);
    if (mainWindow) {
      notifyRendererCaptureFinished();
      applyToolbarWindowMode({ show: true });
      triggerPreviewToast(captureData);
    }
    return { success: true };
  } catch (err) {
    notifyRendererCaptureFinished();
    if (mainWindow) showMainWindowForCurrentMode();
    return { success: false, error: err.message };
  }
});

ipcMain.on('window-overlay-select', async (event, windowName) => {
  // Use desktopCapturer to get a pixel-perfect capture of the selected window.
  // This avoids the frame inset guessing entirely.
  captureWindows.forEach(w => { if (!w.isDestroyed()) w.close(); });
  captureWindows = [];

  try {
    // Find matching source by name (best match)
    let selected = windowPickerSources.find(s => s.name === windowName);
    if (!selected) {
      // Fuzzy match: find source whose name contains the window name or vice versa
      selected = windowPickerSources.find(s =>
        s.name.includes(windowName) || windowName.includes(s.name)
      );
    }
    if (!selected) {
      // Re-fetch fresh sources as fallback
      const fresh = await desktopCapturer.getSources({ types: ['window'], thumbnailSize: getHighQualityThumbnailSize() });
      selected = fresh.find(s => s.name === windowName) ||
                 fresh.find(s => s.name.includes(windowName) || windowName.includes(s.name));
    }

    if (selected && !selected.thumbnail.isEmpty()) {
      const dataUrl = selected.thumbnail.toDataURL();
      windowPickerSources = [];
      copyDataUrlToClipboard(dataUrl);
      if (mainWindow) {
        notifyRendererCaptureFinished();
        applyToolbarWindowMode({ show: true });
        triggerPreviewToast({ dataUrl, captureMode: 'window' });
      }
      return;
    }
  } catch (err) {
    console.error('[orange-fuji] window-overlay-select error:', err.message);
  }

  // Fallback: if no matching source found, just show main window
  windowPickerSources = [];
  notifyRendererCaptureFinished();
  if (mainWindow) showMainWindowForCurrentMode();
});

ipcMain.on('capture-complete', (event, imageDataUrl) => {
  captureWindows.forEach(w => { if (!w.isDestroyed()) w.close(); });
  captureWindows = [];
  copyDataUrlToClipboard(imageDataUrl);
  if (mainWindow) {
    notifyRendererCaptureFinished();
    applyToolbarWindowMode({ show: true });
    triggerPreviewToast({ dataUrl: imageDataUrl, captureMode: 'region' });
  }
});

ipcMain.on('capture-cancel', () => {
  captureWindows.forEach(w => { if (!w.isDestroyed()) w.close(); });
  captureWindows = [];
  if (recordingRegionSelection) {
    recordingRegionSelection.resolve(null);
    recordingRegionSelection = null;
    notifyRendererCaptureFinished();
    if (mainWindow) showMainWindowForCurrentMode();
    return;
  }
  notifyRendererCaptureFinished();
  if (mainWindow) showMainWindowForCurrentMode();
});

ipcMain.on('recording-region-complete', (event, region) => {
  captureWindows.forEach(w => { if (!w.isDestroyed()) w.close(); });
  captureWindows = [];
  if (recordingRegionSelection) {
    recordingRegionSelection.resolve(region);
    recordingRegionSelection = null;
  }
  notifyRendererCaptureFinished();
});


ipcMain.on('window-source-select', async (event, sourceId) => {
  try {
    // Use cached sources first (reliable), fall back to re-fetch. For recording,
    // a valid source id is enough; thumbnails are only required for screenshot
    // capture after the picker selection.
    let selected = windowPickerSources.find((s) => s.id === sourceId);
    if (!selected) {
      const sourceTypes = String(sourceId).startsWith('screen:') ? ['screen'] : ['window'];
      const freshSources = await getDesktopSourcesForPicker(sourceTypes);
      selected = freshSources.find((s) => s.id === sourceId);
    }
    if (!selected) {
      if (windowPickerWindow && !windowPickerWindow.isDestroyed()) windowPickerWindow.close();
      windowPickerSources = [];
      recordingSourceSelection?.resolve(null);
      recordingSourceSelection = null;
      if (mainWindow) showMainWindowForCurrentMode();
      return;
    }
    if (windowPickerWindow && !windowPickerWindow.isDestroyed()) windowPickerWindow.close();
    windowPickerSources = [];

    if (recordingSourceSelection) {
      recordingSourceSelection.resolve({ id: selected.id, name: selected.name });
      recordingSourceSelection = null;
      return;
    }

    if (!selected.thumbnail || selected.thumbnail.isEmpty()) {
      if (mainWindow) showMainWindowForCurrentMode();
      return;
    }

    const dataUrl = selected.thumbnail.toDataURL();
    copyDataUrlToClipboard(dataUrl);
    if (mainWindow) {
      applyToolbarWindowMode({ show: true });
      triggerPreviewToast({ dataUrl, captureMode: 'window' });
    }
  } catch (err) {
    if (windowPickerWindow && !windowPickerWindow.isDestroyed()) windowPickerWindow.close();
    windowPickerSources = [];
    recordingSourceSelection?.reject(err);
    recordingSourceSelection = null;
    if (mainWindow) showMainWindowForCurrentMode();
  }
});

ipcMain.on('window-source-cancel', () => {
  if (windowPickerWindow && !windowPickerWindow.isDestroyed()) windowPickerWindow.close();
  windowPickerSources = [];
  recordingSourceSelection?.resolve(null);
  recordingSourceSelection = null;
  if (mainWindow) showMainWindowForCurrentMode();
});
ipcMain.handle('get-settings', async () => readSettings());

ipcMain.handle('save-settings', async (event, nextSettings = {}) => writeSettings(nextSettings));

ipcMain.handle('get-license-state', async () => getLicenseState());

ipcMain.handle('activate-license', async (event, email) => {
  try {
    return { ok: true, state: await activateLicense(email) };
  } catch (error) {
    return { ok: false, error: readableLicenseError(error.message) };
  }
});

ipcMain.handle('open-buy-license', async () => {
  await shell.openExternal(BUY_LICENSE_URL);
  return { success: true };
});

ipcMain.handle('open-native-preferences', async () => {
  openPreferencesWindow();
  return { success: true };
});

ipcMain.handle('get-app-update-state', async () => cloneUpdateState());

ipcMain.handle('check-for-app-updates', async () => checkForAppUpdates());

ipcMain.handle('download-app-update', async () => downloadAppUpdate());

ipcMain.handle('install-app-update', async () => installDownloadedAppUpdate());

ipcMain.on('settings-changed', () => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('settings-changed');
  }
});

ipcMain.handle('choose-default-save-path', async (event, currentPath = '') => {
  const result = await dialog.showOpenDialog(preferencesWindow || mainWindow, {
    title: 'Choose default save path',
    defaultPath: typeof currentPath === 'string' && currentPath ? currentPath : defaultSaveDirectory('documents'),
    properties: ['openDirectory', 'createDirectory'],
  });
  if (result.canceled || !result.filePaths[0]) return { canceled: true };
  const settings = writeSettings({ defaultSavePath: result.filePaths[0] });
  return { canceled: false, path: settings.defaultSavePath };
});

ipcMain.handle('open-file', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile'],
    filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp', 'bmp', 'gif'] }],
  });
  if (result.canceled || !result.filePaths[0]) return null;
  const filePath = result.filePaths[0];
  const buffer = fs.readFileSync(filePath);
  const ext = path.extname(filePath).toLowerCase().slice(1);
  const mime = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', bmp: 'image/bmp', gif: 'image/gif' }[ext] || 'image/png';
  return `data:${mime};base64,${buffer.toString('base64')}`;
});

ipcMain.handle('save-file', async (event, dataUrl) => {
  const result = await dialog.showSaveDialog(mainWindow, {
    defaultPath: defaultSavePath('pictures', `screenshot-${Date.now()}.png`),
    filters: [{ name: 'PNG Image', extensions: ['png'] }, { name: 'JPEG Image', extensions: ['jpg'] }],
  });
  if (result.canceled || !result.filePath) return { success: false };
  try {
    const base64Data = dataUrl.replace(/^data:image\/\w+;base64,/, '');
    fs.writeFileSync(result.filePath, Buffer.from(base64Data, 'base64'));
    return { success: true, path: result.filePath };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('copy-to-clipboard', async (event, dataUrl) => {
  try {
    clipboard.writeImage(nativeImage.createFromDataURL(dataUrl));
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('read-clipboard-image', async () => {
  try {
    const image = clipboard.readImage();
    if (image.isEmpty()) return null;
    return image.toDataURL();
  } catch (err) {
    return null;
  }
});

ipcMain.on('close-about', (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (win && !win.isDestroyed()) win.close();
});

ipcMain.handle('window-close', async () => {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.close();
  return { success: true };
});

ipcMain.handle('window-minimize', async () => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (process.platform === 'darwin') mainWindow.hide();
    else mainWindow.minimize();
  }
  return { success: true };
});

ipcMain.handle('window-set-mode', async (event, mode, options = {}) => {
  if (!mainWindow || mainWindow.isDestroyed()) return { success: false };
  if (mode === 'editor') applyEditorWindowMode({ show: Boolean(options?.show) });
  else applyToolbarWindowMode({ show: Boolean(options?.show) });
  return { success: true, mode: mainWindowMode };
});

ipcMain.handle('window-toggle-maximize', async () => {
  if (!mainWindow || mainWindow.isDestroyed()) return { success: false };
  if (mainWindowMode !== 'editor') applyEditorWindowMode({ show: true });
  if (mainWindow.isMaximized()) mainWindow.unmaximize();
  else mainWindow.maximize();
  return { success: true, maximized: mainWindow.isMaximized() };
});

ipcMain.handle('get-displays', () => screen.getAllDisplays());
ipcMain.handle('get-cursor-screen-point', () => screen.getCursorScreenPoint());


ipcMain.handle('pro-recording-indicator-show', async (event, payload = {}) => {
  recordingInProgress = true;
  if (payload?.region) lastRecordingRegion = payload.region;
  showRecordingIndicator({ inlinePreview: Boolean(payload?.inlinePreview) });
  if (process.platform === 'darwin' && payload?.region && !payload?.inlinePreview) {
    setTimeout(() => restoreMacRecordingReturnApp(), 120);
    setTimeout(() => restoreMacRecordingReturnApp(), 360);
  }
  return { success: true };
});

ipcMain.handle('pro-recording-indicator-hide', async () => {
  recordingInProgress = false;
  recordingReturnAppPath = '';
  hideRecordingIndicator();
  return { success: true };
});

ipcMain.handle('pro-recording-restore-frontmost-app', async () => {
  restoreMacRecordingReturnApp();
  return { success: true };
});

async function hideOrangeFujiWindowsBeforeRecording() {
  const windowsToHide = [mainWindow, preferencesWindow, windowPickerWindow]
    .filter((win) => win && !win.isDestroyed());

  for (const win of windowsToHide) {
    try {
      win.setContentProtection(true);
      win.hide();
    } catch (error) {
      console.error('[orange-fuji][recording] failed to hide Orange Fuji window:', error.message);
    }
  }

  // Let the OS compositor publish the hidden state before Chromium starts
  // reading desktop frames. Without this guard, the first captured frames can
  // contain Orange Fuji itself and create the recursive preview effect.
  await new Promise((resolve) => setTimeout(resolve, process.platform === 'darwin' ? 260 : 160));
}

ipcMain.handle('pro-recording-prepare', async (event, payload = {}) => {
  if (payload?.region) lastRecordingRegion = payload.region;
  if (payload?.captureOrangeFuji !== true) {
    await hideOrangeFujiWindowsBeforeRecording();
  } else {
    setOrangeFujiWindowsContentProtection(false);
    // Do not show Orange Fuji here: after region selection, activating or
    // re-showing an app window can pull macOS out of a full-screen app Space.
    if (mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible()) {
      try { mainWindow.setAlwaysOnTop(true, 'floating'); } catch (_) { mainWindow.setAlwaysOnTop(true); }
      if (process.platform !== 'darwin') mainWindow.moveTop();
    }
  }
  return { success: true };
});

async function chooseRecordingRegionSource(options = {}) {
  if (recordingRegionSelection) return recordingRegionSelection.promise;

  const promise = new Promise(async (resolve, reject) => {
    recordingRegionSelection = { resolve, reject, promise: null };
    try {
      notifyRendererCaptureModeStarted();
      if (mainWindow && !mainWindow.isDestroyed()) {
        if (process.platform === 'darwin') {
          if (shouldCaptureOrangeFuji(options)) {
            setOrangeFujiWindowsContentProtection(false);
          } else {
            await hideOrangeFujiWindowsBeforeRecording();
          }
        } else {
          lastToolbarBounds = null;
          applyToolbarWindowMode();
          mainWindow.setBounds({ width: TOOLBAR_WINDOW_SIZE.width, height: TOOLBAR_WINDOW_SIZE.height }, false);
          mainWindow.show();
          mainWindow.moveTop();
        }
      }
      await new Promise(r => setTimeout(r, 200));
      if (!await ensureMacScreenRecordingPermission()) {
        throw new Error('Screen Recording permission is required.');
      }
      rememberMacRecordingReturnApp();
      const captureData = await withHiddenDesktopIcons({ ...options, hideDesktopIcons: false }, async () => captureAllScreens());
      await createCaptureOverlays(captureData, 'record-region', []);
    } catch (error) {
      recordingRegionSelection = null;
      if (mainWindow) showMainWindowForCurrentMode();
      reject(error);
    }
  });
  recordingRegionSelection.promise = promise;
  return promise;
}

function chooseRecordingWindowSource() {
  if (recordingSourceSelection) return recordingSourceSelection.promise;

  const promise = new Promise(async (resolve, reject) => {
    recordingSourceSelection = { resolve, reject, promise: null };
    try {
      if (mainWindow) mainWindow.hide();
      const opened = await openWindowPickerFallback();
      if (!opened?.success) throw new Error('Unable to open the window picker');
    } catch (error) {
      recordingSourceSelection = null;
      reject(error);
    }
  });
  recordingSourceSelection.promise = promise;
  return promise;
}

ipcMain.handle('pro-recording-source', async (event, options = {}) => {
  if (!await hasUsageEntitlement()) {
    throw new Error('Trial expired. Activate a license to continue.');
  }
  if (!await ensureMacScreenRecordingPermission()) {
    throw new Error('Screen Recording permission is required.');
  }

  await hideMacDesktopIconsForRecording(options);

  try {
    if (options?.mode === 'region') {
      const region = await chooseRecordingRegionSource(options);
      if (!region) {
        await restoreMacDesktopIconsAfterRecording();
        return null;
      }
      lastRecordingSourceId = region.sourceId;
      recordingDisplayMediaSourceId = region.sourceId;
      lastRecordingRegion = region;
      return {
        id: region.sourceId,
        name: 'Selected region',
        mode: 'region',
        region,
        autoZoom: options.autoZoom !== false,
      };
    }

    const source = await chooseRecordingWindowSource();
    if (!source) {
      await restoreMacDesktopIconsAfterRecording();
      return null;
    }
    lastRecordingSourceId = source.id;
    recordingDisplayMediaSourceId = source.id;
    lastRecordingRegion = null;
    return { id: source.id, name: source.name, mode: 'window' };
  } catch (error) {
    await restoreMacDesktopIconsAfterRecording();
    throw error;
  }
});

ipcMain.handle('pro-recording-display-media-source', async (event, payload = {}) => {
  if (!payload?.sourceId) return { success: false };
  recordingDisplayMediaSourceId = payload.sourceId;
  lastRecordingSourceId = payload.sourceId;
  return { success: true };
});

ipcMain.handle('pro-save-recording', async (event, payload) => {
  const data = payload?.data;
  if (!data) throw new Error('Recording payload is empty');

  const format = payload?.format === 'gif' || payload?.gif ? 'gif' : 'mp4';
  const extension = format === 'gif' ? 'gif' : 'mp4';
  const trimStart = Number.isFinite(payload?.trimStart) && payload.trimStart > 0 ? payload.trimStart : 0;
  const trimEnd = Number.isFinite(payload?.trimEnd) && payload.trimEnd > trimStart ? payload.trimEnd : 0;
  const muted = payload?.muted === true;
  const filename = `orange-fuji-recording-${Date.now()}.${extension}`;
  const configuredSaveDirectory = configuredDefaultSaveDirectory();
  let outputPath = configuredSaveDirectory ? path.join(configuredSaveDirectory, filename) : '';

  if (!outputPath) {
    const saveResult = await dialog.showSaveDialog(mainWindow, {
      title: 'Save screen recording',
      defaultPath: defaultSavePath('videos', filename),
      buttonLabel: 'Save Recording',
      filters: format === 'gif'
        ? [{ name: 'GIF Animation', extensions: ['gif'] }]
        : [{ name: 'MP4 Video', extensions: ['mp4'] }],
    });
    if (saveResult.canceled || !saveResult.filePath) return { canceled: true };
    outputPath = saveResult.filePath;
  }

  event.sender.send('pro-save-recording-started');

  const webmPath = tempRecordingPath('webm');
  const bytes = Buffer.isBuffer(data) ? data : Buffer.from(data);
  fs.writeFileSync(webmPath, bytes);

  try {
    let mp4Path = outputPath;
    if (format === 'gif') mp4Path = tempRecordingPath('mp4');

    let mp4;
    try {
      mp4 = await convertWebmToMp4(webmPath, mp4Path, { trimStart, trimEnd, muted });
    } catch (conversionError) {
      fs.rmSync(mp4Path, { force: true });
      if (format === 'mp4') fs.rmSync(outputPath, { force: true });
      // Save as webm so the recording is not lost, but inform the user clearly
      const webmOutputPath = outputPath.replace(/\.[^.]+$/i, '.webm');
      fs.mkdirSync(path.dirname(webmOutputPath), { recursive: true });
      fs.copyFileSync(webmPath, webmOutputPath);
      return {
        webm: webmOutputPath,
        warning: `Saved as .webm (bundled ffmpeg/gifski conversion tools are unavailable for ${format.toUpperCase()} export).`,
      };
    }

    if (format === 'gif') {
      try {
        return { gif: await convertMp4ToGif(mp4, outputPath) };
      } finally {
        fs.rmSync(mp4, { force: true });
      }
    }

    return { mp4 };
  } finally {
    fs.rmSync(webmPath, { force: true });
  }
});


ipcMain.handle('pro-trim-recording', async (event, payload) => {
  const data = payload?.data;
  if (!data) throw new Error('Trim payload is empty');
  const trimStart = Number.isFinite(payload?.trimStart) && payload.trimStart > 0 ? payload.trimStart : 0;
  const trimEnd = Number.isFinite(payload?.trimEnd) && payload.trimEnd > trimStart ? payload.trimEnd : 0;
  if (!trimStart && !trimEnd) return { data, mimeType: payload.mimeType || 'video/webm', format: payload.format || 'mp4' };
  const webmPath = tempRecordingPath('webm');
  const mp4Path = tempRecordingPath('mp4');
  const bytes = Buffer.isBuffer(data) ? data : Buffer.from(data);
  fs.writeFileSync(webmPath, bytes);
  try {
    await convertWebmToMp4(webmPath, mp4Path, { trimStart, trimEnd, muted: false });
    const result = fs.readFileSync(mp4Path);
    return { data: result, mimeType: 'video/mp4', format: 'mp4' };
  } finally {
    fs.rmSync(webmPath, { force: true });
    fs.rmSync(mp4Path, { force: true });
  }
});

ipcMain.on('pro-recording-stop-clicked', () => {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('pro-recording-stop-requested');
});

// ── App Lifecycle ───────────────────────────────────────────────────────────


function setupTray() {
  if (process.platform !== 'darwin' || tray) return;
  const iconPath = path.join(__dirname, 'assets', 'icons', 'macos', 'StatusTemplate-volcano-thicker.png');
  const icon2xPath = path.join(__dirname, 'assets', 'icons', 'macos', 'StatusTemplate-volcano-thicker@2x.png');
  const trayIcon = nativeImage.createEmpty();
  trayIcon.addRepresentation({ scaleFactor: 1, dataURL: readImageFileAsDataUrl(iconPath) });
  if (fs.existsSync(icon2xPath)) {
    trayIcon.addRepresentation({ scaleFactor: 2, dataURL: readImageFileAsDataUrl(icon2xPath) });
  }
  trayIcon.setTemplateImage(true);
  tray = new Tray(trayIcon);
  tray.setToolTip('Orange Fuji');

  const trayMenu = Menu.buildFromTemplate([
    { label: 'Open', click: () => { if (!mainWindow || mainWindow.isDestroyed()) { createMainWindow(true); } else { applyToolbarWindowMode({ show: true }); mainWindow.show(); mainWindow.focus(); } mainWindow?.webContents?.send('toolbar-open-requested'); } },
    { type: 'separator' },
    { label: 'Preferences...', click: () => openPreferencesWindow() },
    { type: 'separator' },
    { label: 'Capture Region\t⌘⇧S', click: () => mainWindow?.webContents.send('trigger-capture') },
    { label: 'Capture Window', click: () => mainWindow?.webContents.send('trigger-capture-window') },
    { label: 'Capture Fullscreen', click: () => mainWindow?.webContents.send('trigger-capture-fullscreen') },
    { label: 'Record Screen', click: () => mainWindow?.webContents.send('trigger-record-screen') },
    { type: 'separator' },
    { label: 'About', click: showAboutDialog },
    { type: 'separator' },
    { label: 'Quit', role: 'quit' },
  ]);

  tray.setContextMenu(trayMenu);
  tray.on('click', () => {
    tray.popUpContextMenu();
  });
}

applyLegacyUserDataPath();

app.whenReady().then(() => {
  ensureLocalLicenseSettings();
  setupRecordingDisplayMediaHandler();
  createMainWindow();
  setupAutoUpdater();
  setupTray();
  const runWhenWindowReady = (callback) => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (mainWindow.isVisible() && !mainWindow.webContents.isLoading()) {
      callback();
      return;
    }
    mainWindow.once('ready-to-show', callback);
  };
  const focusAndShowMainWindow = () => {
    if (!mainWindow || mainWindow.isDestroyed()) createMainWindow();
    if (process.platform === 'darwin') {
      app.show();
      if (app.dock && typeof app.dock.show === 'function') app.dock.show();
      app.focus({ steal: true });
    }
    showMainWindowForCurrentMode();
    mainWindow.moveTop();
  };
  const triggerCaptureFromShortcut = () => {
    const wasMissingWindow = !mainWindow || mainWindow.isDestroyed();
    if (wasMissingWindow) createMainWindow();

    const startCapture = () => {
      if (recordingInProgress) {
        mainWindow?.webContents?.send('pro-recording-stop-requested');
        return;
      }
      const settings = readSettings();
      captureRegion({
        hideDesktopIcons: settings.hideDesktopIcons,
        captureOrangeFuji: settings.captureOrangeFuji,
        showToolbar: false,
      });
    };

    if (wasMissingWindow) {
      runWhenWindowReady(startCapture);
      return;
    }
    if (mainWindow?.webContents?.isLoading()) {
      mainWindow.webContents.once('did-finish-load', startCapture);
      return;
    }
    startCapture();
  };
  // On macOS users may press either Cmd+Shift+S or Ctrl+Shift+S.
  // Register both explicitly to improve reliability while minimized/hidden.
  const globalShortcuts = process.platform === 'darwin'
    ? ['Command+Shift+S', 'Control+Shift+S']
    : ['CommandOrControl+Shift+S'];
  globalShortcuts.forEach((accelerator) => {
    const ok = globalShortcut.register(accelerator, () => {
      console.log(`[orange-fuji][shortcut] fired: ${accelerator}`);
      debugWindowState('before-shortcut');
      triggerCaptureFromShortcut();
      debugWindowState('after-focus-show');
    });
    console.log(`[orange-fuji][shortcut] register ${accelerator}: ${ok ? 'ok' : 'failed'}`);
    if (!ok) console.warn(`[orange-fuji] Failed to register global shortcut: ${accelerator}`);
  });
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
    else showMainWindowForCurrentMode();
  });
});

app.on('window-all-closed', () => {
  // Keep global shortcuts active on macOS even when all windows are closed,
  // so tray/background usage can still trigger capture and recreate the window.
  if (process.platform !== 'darwin') globalShortcut.unregisterAll();
  if (process.platform !== 'darwin') app.quit();
});

app.on('will-quit', () => globalShortcut.unregisterAll());
