(function () {
  if (window.pico) return;

  const noopSubscription = () => {};
  const platform = /Mac|iPhone|iPad|iPod/.test(navigator.platform) ? 'darwin'
    : /Win/.test(navigator.platform) ? 'win32'
      : 'linux';

  function dataUrlToBlob(dataUrl) {
    const [header, base64] = dataUrl.split(',');
    const type = header.match(/data:(.*?);base64/)?.[1] || 'image/png';
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return new Blob([bytes], { type });
  }

  function downloadDataUrl(dataUrl, filename = 'pico-capture.png') {
    const link = document.createElement('a');
    link.href = dataUrl;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
  }

  function readFileAsDataUrl(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(reader.error || new Error('Unable to read file'));
      reader.readAsDataURL(file);
    });
  }

  async function captureDisplayFrame() {
    if (!navigator.mediaDevices?.getDisplayMedia) {
      return { success: false, error: 'Screen capture requires a browser with getDisplayMedia support.' };
    }

    let stream;
    try {
      stream = await navigator.mediaDevices.getDisplayMedia({
        video: { cursor: 'always', displaySurface: 'monitor' },
        audio: false,
      });

      const video = document.createElement('video');
      video.muted = true;
      video.playsInline = true;
      video.srcObject = stream;
      await video.play();
      await new Promise((resolve) => {
        if (video.videoWidth && video.videoHeight) resolve();
        else video.onloadedmetadata = resolve;
      });

      const canvas = document.createElement('canvas');
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
      return { success: true, dataUrl: canvas.toDataURL('image/png'), source: 'capture' };
    } catch (error) {
      return { success: false, error: error?.name === 'NotAllowedError' ? 'Screen capture was canceled.' : (error?.message || 'Failed to capture screen.') };
    } finally {
      stream?.getTracks().forEach((track) => track.stop());
    }
  }

  window.pico = {
    platform,
    isBrowserPwa: true,

    startCapture: captureDisplayFrame,
    startCaptureWindow: captureDisplayFrame,
    startCaptureFullscreen: captureDisplayFrame,

    onLoadCapture: noopSubscription,
    onTriggerCapture: noopSubscription,
    onLoadCaptureData: noopSubscription,
    onRecordingStopRequested: noopSubscription,
    onCaptureData: noopSubscription,
    captureComplete: noopSubscription,
    selectWindowByName: noopSubscription,
    captureCancel: noopSubscription,
    onWindowSources: noopSubscription,
    selectWindowSource: noopSubscription,
    cancelWindowSource: noopSubscription,

    async startRecording() {
      throw new Error('Screen recording is only available in the desktop app.');
    },

    async stopRecording() {
      throw new Error('Screen recording is only available in the desktop app.');
    },

    async openFile() {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = 'image/*';
      return new Promise((resolve) => {
        input.addEventListener('change', async () => {
          const file = input.files?.[0];
          resolve(file ? await readFileAsDataUrl(file) : null);
        }, { once: true });
        input.click();
      });
    },

    async saveFile(dataUrl) {
      if (!dataUrl) return { success: false };
      downloadDataUrl(dataUrl);
      return { success: true };
    },

    async copyToClipboard(dataUrl) {
      if (!dataUrl || !navigator.clipboard) return { success: false };
      try {
        if (window.ClipboardItem) {
          const blob = dataUrlToBlob(dataUrl);
          await navigator.clipboard.write([new ClipboardItem({ [blob.type]: blob })]);
          return { success: true };
        }
        await navigator.clipboard.writeText(dataUrl);
        return { success: true };
      } catch (error) {
        return { success: false, error: error?.message };
      }
    },

    async readClipboardImage() {
      if (!navigator.clipboard?.read) return null;
      const items = await navigator.clipboard.read();
      for (const item of items) {
        const type = item.types.find((candidate) => candidate.startsWith('image/'));
        if (type) return readFileAsDataUrl(await item.getType(type));
      }
      return null;
    },

    async getDisplays() {
      return [];
    },
  };

  if ('serviceWorker' in navigator && (window.isSecureContext || location.hostname === 'localhost')) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('./sw.js').catch(() => {});
    });
  }
}());
