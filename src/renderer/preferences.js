const recordingFormatSetting = document.querySelector('#recording-format-setting');
const recordingAutozoomSetting = document.querySelector('#recording-autozoom-setting');
const hideDesktopIconsSetting = document.querySelector('#hide-desktop-icons-setting');

const settings = {
  format: 'mp4',
  autoZoom: true,
  hideDesktopIcons: true,
};

function loadSettings() {
  try {
    const raw = localStorage.getItem('pico-recording-settings');
    if (raw) {
      const parsed = JSON.parse(raw);
      settings.format = parsed?.format === 'gif' ? 'gif' : 'mp4';
      settings.autoZoom = parsed?.autoZoom !== false;
      settings.hideDesktopIcons = parsed?.hideDesktopIcons !== false;
    }
  } catch (_) {}

  recordingFormatSetting.value = settings.format;
  recordingAutozoomSetting.checked = settings.autoZoom;
  hideDesktopIconsSetting.checked = settings.hideDesktopIcons;
}

function saveSettings() {
  localStorage.setItem('pico-recording-settings', JSON.stringify(settings));
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
