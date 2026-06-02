const recordingFormatSetting = document.querySelector('#recording-format-setting');
const recordingAutozoomSetting = document.querySelector('#recording-autozoom-setting');
const hideDesktopIconsSetting = document.querySelector('#hide-desktop-icons-setting');
const defaultSavePathSetting = document.querySelector('#default-save-path-setting');
const chooseDefaultSavePathSetting = document.querySelector('#choose-default-save-path-setting');
const clearDefaultSavePathSetting = document.querySelector('#clear-default-save-path-setting');
const licenseStatusSetting = document.querySelector('#license-status-setting');
const licenseEmailSetting = document.querySelector('#license-email-setting');
const buyLicenseSetting = document.querySelector('#buy-license-setting');
const activateLicenseSetting = document.querySelector('#activate-license-setting');


const settings = {
  format: 'mp4',
  autoZoom: true,
  hideDesktopIcons: true,
  defaultSavePath: '',
};

const RECORDING_SETTINGS_KEY = 'orangefuji-recording-settings';
// Legacy key retained for one-time migration from builds branded as Pico.
const LEGACY_RECORDING_SETTINGS_KEY = 'pico-recording-settings';

async function loadSettings() {
  try {
    const raw = localStorage.getItem(RECORDING_SETTINGS_KEY) || localStorage.getItem(LEGACY_RECORDING_SETTINGS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      settings.format = parsed?.format === 'gif' ? 'gif' : 'mp4';
      settings.autoZoom = parsed?.autoZoom !== false;
      settings.hideDesktopIcons = parsed?.hideDesktopIcons !== false;
      settings.defaultSavePath = typeof parsed?.defaultSavePath === 'string' ? parsed.defaultSavePath : '';
    }
  } catch (_) {}

  try {
    const persistedSettings = await window.pico.getSettings();
    settings.defaultSavePath = typeof persistedSettings?.defaultSavePath === 'string' ? persistedSettings.defaultSavePath : settings.defaultSavePath;
  } catch (_) {}

  recordingFormatSetting.value = settings.format;
  recordingAutozoomSetting.checked = settings.autoZoom;
  hideDesktopIconsSetting.checked = settings.hideDesktopIcons;
  defaultSavePathSetting.value = settings.defaultSavePath;
}

function setLicenseMessage(message = '', type = '') {
  if (!licenseStatusSetting) return;
  licenseStatusSetting.textContent = message;
  licenseStatusSetting.classList.toggle('error', type === 'error');
  licenseStatusSetting.classList.toggle('success', type === 'success');
}

function renderLicenseState(state) {
  if (!state || !licenseStatusSetting) return;
  if (licenseEmailSetting && state.email) licenseEmailSetting.value = state.email;

  if (state.licensed) {
    licenseStatusSetting.textContent = `Active license for ${state.email}`;
    setLicenseMessage('License active.', 'success');
    return;
  }

  if (state.trial?.expired) {
    licenseStatusSetting.textContent = 'Trial ended. Activate a license to continue.';
    setLicenseMessage('', '');
    return;
  }

  const days = state.trial?.daysRemaining ?? 0;
  licenseStatusSetting.textContent = `${days} day${days === 1 ? '' : 's'} left in your trial.`;
  setLicenseMessage('', '');
}

async function loadLicenseState() {
  try {
    renderLicenseState(await window.pico.getLicenseState());
  } catch (error) {
    if (licenseStatusSetting) licenseStatusSetting.textContent = 'Could not load license status.';
    setLicenseMessage(error?.message || 'License status unavailable.', 'error');
  }
}

async function saveSettings() {
  localStorage.setItem(RECORDING_SETTINGS_KEY, JSON.stringify(settings));
  localStorage.removeItem(LEGACY_RECORDING_SETTINGS_KEY);
  try {
    await window.pico.saveSettings({ defaultSavePath: settings.defaultSavePath, hideDesktopIcons: settings.hideDesktopIcons });
  } catch (_) {}
  window.pico.notifySettingsChanged?.();
}

recordingFormatSetting.addEventListener('change', () => {
  settings.format = recordingFormatSetting.value === 'gif' ? 'gif' : 'mp4';
  saveSettings();
});

recordingAutozoomSetting.addEventListener('change', () => {
  settings.autoZoom = Boolean(recordingAutozoomSetting.checked);
  saveSettings();
});

hideDesktopIconsSetting.addEventListener('change', () => {
  settings.hideDesktopIcons = Boolean(hideDesktopIconsSetting.checked);
  saveSettings();
});

document.addEventListener('DOMContentLoaded', loadSettings);
document.addEventListener('DOMContentLoaded', loadLicenseState);

chooseDefaultSavePathSetting.addEventListener('click', async () => {
  const result = await window.pico.chooseDefaultSavePath(settings.defaultSavePath);
  if (!result?.canceled && typeof result?.path === 'string') {
    settings.defaultSavePath = result.path;
    defaultSavePathSetting.value = settings.defaultSavePath;
    saveSettings();
  }
});

clearDefaultSavePathSetting.addEventListener('click', () => {
  settings.defaultSavePath = '';
  defaultSavePathSetting.value = '';
  saveSettings();
});

buyLicenseSetting?.addEventListener('click', () => {
  window.pico.openBuyLicense?.();
});

activateLicenseSetting?.addEventListener('click', async () => {
  const email = licenseEmailSetting?.value || '';
  setLicenseMessage('Activating...', '');
  activateLicenseSetting.disabled = true;
  try {
    renderLicenseState(await window.pico.activateLicense(email));
  } catch (error) {
    const message = String(error?.message || 'Activation failed.');
    const readable = message.includes('license_not_found')
      ? 'We could not find a license for this email. Use the same email you entered at checkout, or buy a license first.'
      : message.includes('activation_limit_reached')
        ? 'This license has reached its 2-device activation limit.'
        : message;
    setLicenseMessage(readable, 'error');
  } finally {
    activateLicenseSetting.disabled = false;
  }
});
