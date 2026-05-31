const recordingFormatSetting = document.querySelector('#recording-format-setting');
const recordingAutozoomSetting = document.querySelector('#recording-autozoom-setting');
const hideDesktopIconsSetting = document.querySelector('#hide-desktop-icons-setting');
const defaultSavePathSetting = document.querySelector('#default-save-path-setting');
const chooseDefaultSavePathSetting = document.querySelector('#choose-default-save-path-setting');
const clearDefaultSavePathSetting = document.querySelector('#clear-default-save-path-setting');

const settings = {
  format: 'mp4',
  autoZoom: true,
  hideDesktopIcons: true,
  defaultSavePath: '',
};

async function loadSettings() {
  try {
    const raw = localStorage.getItem('pico-recording-settings');
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

async function saveSettings() {
  localStorage.setItem('pico-recording-settings', JSON.stringify(settings));
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
