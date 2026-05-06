const fs = require('fs');
const path = require('path');
const { _electron: electron, test, expect } = require('@playwright/test');

const appRoot = path.resolve(__dirname, '../..');

async function launchPico(testInfo) {
  const outputDir = testInfo.outputPath('pico-e2e-output');
  fs.mkdirSync(outputDir, { recursive: true });

  const app = await electron.launch({
    executablePath: require('electron'),
    args: [appRoot],
    env: {
      ...process.env,
      PICO_E2E: '1',
      PICO_E2E_OUTPUT_DIR: outputDir,
      PICO_E2E_AUTO_RECORDING_SOURCE: '1',
    },
  });

  const page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  await expect(page.locator('#btn-capture-region')).toBeVisible();
  return { app, page, outputDir };
}

async function waitForWindow(app, predicate, timeout = 15_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    for (const win of app.windows()) {
      if (predicate(win)) return win;
    }
    const remaining = Math.max(250, deadline - Date.now());
    try {
      const win = await app.waitForEvent('window', { timeout: Math.min(500, remaining) });
      await win.waitForLoadState('domcontentloaded').catch(() => {});
      if (predicate(win)) return win;
    } catch (error) {
      // Keep polling until the full timeout is reached.
    }
  }
  throw new Error('Timed out waiting for matching Electron window');
}

async function expectLoadedCanvas(page) {
  await expect(page.locator('#canvas.visible')).toBeVisible();
  await expect(page.locator('#empty-state')).toHaveClass(/hidden/);
  const size = await page.locator('#canvas').evaluate((canvas) => ({
    width: canvas.width,
    height: canvas.height,
  }));
  expect(size.width).toBeGreaterThan(0);
  expect(size.height).toBeGreaterThan(0);
}

async function completeRegionCapture(app) {
  const overlay = await waitForWindow(app, (win) => win.url().endsWith('/capture-overlay.html'));
  await overlay.locator('#canvas').waitFor({ state: 'visible' });
  await overlay.mouse.move(80, 80);
  await overlay.mouse.down();
  await overlay.mouse.move(360, 260, { steps: 8 });
  await overlay.mouse.up();
}

async function completeWindowCapture(app) {
  const overlay = await waitForWindow(app, (win) => win.url().endsWith('/capture-overlay.html'));
  await overlay.locator('#canvas').waitFor({ state: 'visible' });
  const viewport = overlay.viewportSize() || { width: 800, height: 600 };
  await overlay.mouse.move(Math.floor(viewport.width / 2), Math.floor(viewport.height / 2));
  await overlay.mouse.click(Math.floor(viewport.width / 2), Math.floor(viewport.height / 2));
}

async function runRecordingScenario(page, outputDir, format) {
  await page.locator('#btn-record-screen').click();
  await expect(page.locator('#recording-format-menu')).toHaveClass(/visible/);
  await page.locator(`#recording-format-menu [data-format="${format}"]`).click();
  await expect(page.locator('#btn-record-screen')).toHaveAttribute('aria-pressed', 'true');
  await page.waitForTimeout(2_500);
  await page.locator('#btn-record-screen').click();
  await expect(page.locator('#btn-record-screen')).toHaveAttribute('aria-pressed', 'false', { timeout: 60_000 });
  await expect(page.locator('.toast').filter({ hasText: 'Saved recording:' })).toBeVisible({ timeout: 60_000 });

  const files = fs.readdirSync(outputDir).filter((file) => file.endsWith(`.${format}`));
  expect(files, `expected a .${format} recording in ${outputDir}`).toHaveLength(1);
  const stats = fs.statSync(path.join(outputDir, files[0]));
  expect(stats.size).toBeGreaterThan(0);
}

test.describe('main capture and recording flows', () => {
  test('captures a user-selected rectangle region', async ({}, testInfo) => {
    const { app, page } = await launchPico(testInfo);
    try {
      await page.locator('#btn-capture-region').click();
      await completeRegionCapture(app);
      await expectLoadedCanvas(page);
    } finally {
      await app.close();
    }
  });

  test('captures a user-selected window', async ({}, testInfo) => {
    const { app, page } = await launchPico(testInfo);
    try {
      await page.locator('#btn-capture-window').click();
      await completeWindowCapture(app);
      await expectLoadedCanvas(page);
    } finally {
      await app.close();
    }
  });

  test('captures the full screen', async ({}, testInfo) => {
    const { app, page } = await launchPico(testInfo);
    try {
      await page.locator('#btn-capture-fullscreen').click();
      await expectLoadedCanvas(page);
    } finally {
      await app.close();
    }
  });

  test('records and exports MP4', async ({}, testInfo) => {
    const { app, page, outputDir } = await launchPico(testInfo);
    try {
      await runRecordingScenario(page, outputDir, 'mp4');
    } finally {
      await app.close();
    }
  });

  test('records and exports GIF', async ({}, testInfo) => {
    const { app, page, outputDir } = await launchPico(testInfo);
    try {
      await runRecordingScenario(page, outputDir, 'gif');
    } finally {
      await app.close();
    }
  });
});
