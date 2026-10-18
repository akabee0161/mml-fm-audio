// ビルド済みの demo をヘッドレス Chromium で開き、音が出ることを確かめる。
// 実行：npm run check:browser（先に vite build する）
import { homedir } from 'node:os';
import { chromium } from 'playwright-core';
import { preview } from 'vite';

const PORT = 4179;
const executablePath = process.env.CHROME_PATH ?? `${homedir()}/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome`;

function check(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
  console.log(`OK: ${message}`);
}

const server = await preview({ preview: { port: PORT, strictPort: true } });
const browser = await chromium.launch({
  executablePath,
  args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'],
});
try {
  const page = await browser.newPage();
  const pageErrors: string[] = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));
  await page.goto(`http://localhost:${PORT}/play/mml-fm-audio/?debug`);
  await page.click('#start');
  await page.waitForSelector('#controls', { state: 'visible', timeout: 10_000 });
  check(true, 'Worklet が読み込まれ、操作欄が表示された');

  const options = await page.locator('#voice-select option').count();
  check(options === 18, `音色が 18 種ある（${options} 種）`);

  const silent = await page.evaluate(() => window.__mmlFmAudio!.peak());
  check(silent === 0, `鍵を押す前は無音（${silent}）`);

  await page.keyboard.down('a');
  await page.waitForTimeout(300);
  const playing = await page.evaluate(() => window.__mmlFmAudio!.peak());
  await page.keyboard.up('a');
  check(playing > 0.01, `鍵を押すと音が出る（最大振幅 ${playing.toFixed(3)}）`);

  check(pageErrors.length === 0, `ページでエラーが起きていない（${pageErrors.join(' / ')}）`);
} finally {
  await browser.close();
  await new Promise<void>((resolve) => server.httpServer.close(() => resolve()));
}
