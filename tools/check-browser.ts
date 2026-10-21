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
let browser: import('playwright-core').Browser | undefined;
try {
  browser = await chromium.launch({
    executablePath,
    args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'],
  });
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

  const peak = () => page.evaluate(() => window.__mmlFmAudio!.peak());
  const peakLeft = () => page.evaluate(() => window.__mmlFmAudio!.peakLeft());
  const peakRight = () => page.evaluate(() => window.__mmlFmAudio!.peakRight());
  /** 音が消えるまで待つ（最大 3 秒） */
  const waitSilent = async () => {
    for (let i = 0; i < 30 && (await peak()) > 0.001; i++) await page.waitForTimeout(100);
  };
  const setPan = (value: number) =>
    page.$eval('#pan', (el, v) => {
      (el as HTMLInputElement).value = String(v);
      el.dispatchEvent(new Event('input'));
    }, value);

  await page.keyboard.down('a');
  await page.waitForTimeout(300);
  const single = await peak();
  check(single > 0.01, `鍵を押すと音が出る（最大振幅 ${single.toFixed(3)}）`);

  await page.keyboard.down('d');
  await page.keyboard.down('g');
  await page.waitForTimeout(300);
  const chord = await peak();
  check(chord > single * 1.2, `和音で振幅が増える（${single.toFixed(3)} → ${chord.toFixed(3)}）`);

  await page.evaluate(() => window.dispatchEvent(new Event('blur')));
  await waitSilent();
  const afterBlur = await peak();
  check(afterBlur < 0.001, `ウィンドウのフォーカスが外れると、押したままの音が止まる（${afterBlur.toFixed(4)}）`);
  for (const key of ['a', 'd', 'g']) await page.keyboard.up(key);

  await page.focus('#keyboard .key');
  await page.keyboard.down('Enter');
  await page.waitForTimeout(200);
  const focused = await peak();
  await page.keyboard.press('Tab');
  await page.keyboard.up('Enter');
  await waitSilent();
  const afterTab = await peak();
  check(
    focused > 0.01 && afterTab < 0.001,
    `画面の鍵を Enter で押したまま Tab でフォーカスを移しても、離せば止まる（${focused.toFixed(3)} → ${afterTab.toFixed(4)}）`,
  );

  await setPan(0);
  await page.keyboard.down('a');
  await page.waitForTimeout(300);
  const [left, right] = [await peakLeft(), await peakRight()];
  await page.keyboard.up('a');
  check(left > 0.01 && right < 0.001, `パン 0 では左だけから鳴る（左 ${left.toFixed(3)}、右 ${right.toFixed(4)}）`);
  await setPan(64);
  await waitSilent();

  const drums = await page.locator('#drums .drum').count();
  check(drums === 8, `ドラムのボタンが 8 個ある（${drums} 個）`);
  for (let i = 0; i < drums; i++) {
    const button = page.locator('#drums .drum').nth(i);
    const name = await button.getAttribute('data-drum');
    await button.click();
    await page.waitForTimeout(30);
    const value = await peak();
    check(value > 0.01, `ドラム ${name} が鳴る（最大振幅 ${value.toFixed(3)}）`);
    await waitSilent();
  }

  await page.check('#load-toggle');
  await page.click('#poly-test');
  await page.waitForTimeout(300);
  const poly = await peak();
  check(poly > 0.01, `16 音ボタンで音が出る（最大振幅 ${poly.toFixed(3)}）`);
  await page.waitForFunction(() => /平均/.test(document.getElementById('load')!.textContent ?? ''), null, { timeout: 3000 });
  const load = await page.textContent('#load');
  check(/ボイス数（最大） 16/.test(load ?? ''), `負荷が表示され、16 ボイスが鳴っている（${(load ?? '').replace(/\n/g, ' / ')}）`);
  await page.click('#poly-test');
  await page.uncheck('#load-toggle');
  await waitSilent();

  // 1 回の測定は音の隙間に当たりうるので、2 小節（4 秒）の間 50 ms ごとに測って最大を取る
  await page.click('#rhythm');
  let rhythm = 0;
  for (let i = 0; i < 80; i++) {
    rhythm = Math.max(rhythm, await peak());
    await page.waitForTimeout(50);
  }
  await page.click('#rhythm');
  check(rhythm > 0.03, `リズムが鳴る（2 小節の最大振幅 ${rhythm.toFixed(3)}）`);

  /** 指定した時間、50 ms ごとに測ったピークの最大 */
  const maxPeak = async (ms: number) => {
    let max = 0;
    for (let i = 0; i < ms / 50; i++) {
      max = Math.max(max, await peak());
      await page.waitForTimeout(50);
    }
    return max;
  };

  // MML の欄：試聴曲の再生・再生し直し・停止
  await page.click('#mml-play');
  const song = await maxPeak(3000);
  check(song > 0.03, `MML の試聴曲が鳴る（3 秒間の最大振幅 ${song.toFixed(3)}）`);

  await page.click('#mml-play');
  const restarted = await maxPeak(2000);
  check(
    restarted > 0.03 && pageErrors.length === 0,
    `再生をもう一度押しても音が出続け、ページのエラーが出ない（最大振幅 ${restarted.toFixed(3)}）`,
  );

  await page.click('#mml-stop');
  await waitSilent();
  const stopped = await peak();
  check(stopped < 0.001, `停止すると 3 秒以内に無音になる（${stopped.toFixed(4)}）`);

  // エラーの確認の前に停止しておく（エラー時は鳴っている再生を止めない）
  await page.fill('#mml', 'A c4&d4');
  await page.click('#mml-play');
  const errorTexts = await page.locator('#mml-errors li').allTextContents();
  check(
    errorTexts.some((t) => t.includes('行 1・列 6')),
    `違う高さのタイが「行 1・列 6」のエラーとして出る（${errorTexts.join(' / ')}）`,
  );
  const afterError = await maxPeak(1000);
  check(afterError < 0.001, `エラーのある MML は鳴らない（最大振幅 ${afterError.toFixed(4)}）`);

  check(pageErrors.length === 0, `ページでエラーが起きていない（${pageErrors.join(' / ')}）`);
} finally {
  if (browser) await browser.close();
  await new Promise<void>((resolve) => server.httpServer.close(() => resolve()));
}
