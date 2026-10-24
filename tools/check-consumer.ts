// 別の Vite プロジェクトへ runtime をコピーし、型検査・ビルドをして、ヘッドレス Chromium で FmAudio が鳴ることを確かめる。
// ゲームのリポジトリに取り込んだときと同じ状況を、一時フォルダで作る。
// 実行：npm run check:browser の最後に呼ばれる（単独でも node tools/check-consumer.ts で動く）
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { build, preview } from 'vite';
import { currentSource, exportRuntime } from './export-runtime.ts';

// 一時フォルダの main.ts が window に出す関数（ブラウザー側で評価する）
declare global {
  interface Window {
    playBgm(mml: string): void;
    playSe(mml: string): void;
    peak(): number;
  }
}

const PORT = 4180;
const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const executablePath = process.env.CHROME_PATH ?? `${homedir()}/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome`;

const INDEX_HTML = `<!doctype html>
<html lang="ja">
  <head><meta charset="utf-8" /><title>consumer</title></head>
  <body>
    <button id="start">start</button>
    <script type="module" src="./main.ts"></script>
  </body>
</html>
`;

const MAIN_TS = `import { FmAudio } from './mml-fm-audio/packages/runtime/src/index.ts';

declare global {
  interface Window {
    playBgm(mml: string): void;
    playSe(mml: string): void;
    peak(): number;
  }
}

document.getElementById('start')!.addEventListener('click', async () => {
  const audio = await FmAudio.init();
  await audio.resume();
  const output = audio.output;
  const analyser = output.context.createAnalyser();
  output.connect(analyser);
  const buffer = new Float32Array(analyser.fftSize);
  window.playBgm = (mml) => audio.playBgm(audio.load(mml));
  window.playSe = (mml) => audio.playSe(audio.load(mml));
  window.peak = () => {
    analyser.getFloatTimeDomainData(buffer);
    return buffer.reduce((m, x) => Math.max(m, Math.abs(x)), 0);
  };
  document.body.dataset.ready = 'true';
});
`;

// character-tactics の tsconfig.json と同じ compilerOptions（noUncheckedIndexedAccess を含む）に、コピーを読むのに要る 2 つを足す
const TSCONFIG = {
  compilerOptions: {
    target: 'ES2022',
    module: 'ESNext',
    moduleResolution: 'bundler',
    lib: ['ES2022', 'DOM'],
    strict: true,
    noUncheckedIndexedAccess: true,
    noEmit: true,
    skipLibCheck: true,
    types: ['vitest/globals', 'vite/client', 'node'],
    allowImportingTsExtensions: true,
    resolveJsonModule: true,
  },
  include: ['main.ts'],
};

function check(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
  console.log(`OK: ${message}`);
}

const tmpRoot = mkdtempSync(join(tmpdir(), 'mml-fm-audio-consumer-'));
let browser: import('playwright-core').Browser | undefined;
let server: Awaited<ReturnType<typeof preview>> | undefined;
try {
  exportRuntime(join(tmpRoot, 'mml-fm-audio'), currentSource());
  writeFileSync(join(tmpRoot, 'index.html'), INDEX_HTML);
  writeFileSync(join(tmpRoot, 'main.ts'), MAIN_TS);
  writeFileSync(join(tmpRoot, 'tsconfig.json'), JSON.stringify(TSCONFIG, null, 2));
  // 型定義（vite/client など）と typescript・vite は、このリポジトリのものを使う
  symlinkSync(join(REPO_ROOT, 'node_modules'), join(tmpRoot, 'node_modules'));
  check(true, `一時フォルダへコピーした（${tmpRoot}）`);

  try {
    execFileSync(process.execPath, [join(REPO_ROOT, 'node_modules/typescript/bin/tsc'), '-p', tmpRoot], {
      encoding: 'utf8',
      stdio: 'pipe',
    });
  } catch (e) {
    const out = e as { stdout?: string; stderr?: string };
    throw new Error(`別のプロジェクトの型検査（noUncheckedIndexedAccess）に通りません：\n${out.stdout ?? ''}${out.stderr ?? ''}`);
  }
  check(true, '別のプロジェクトの型検査（noUncheckedIndexedAccess）に通る');

  const outDir = join(tmpRoot, 'dist');
  mkdirSync(outDir);
  await build({ root: tmpRoot, configFile: false, logLevel: 'warn', build: { outDir, emptyOutDir: true } });
  check(true, '別のプロジェクトで vite build が通る');

  server = await preview({
    root: tmpRoot,
    configFile: false,
    logLevel: 'warn',
    build: { outDir },
    preview: { port: PORT, strictPort: true },
  });
  browser = await chromium.launch({
    executablePath,
    args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'],
  });
  const page = await browser.newPage();
  const pageErrors: string[] = [];
  page.on('pageerror', (e) => pageErrors.push(e.message));
  await page.goto(`http://localhost:${PORT}/`);
  await page.click('#start');
  await page.waitForSelector('body[data-ready="true"]', { timeout: 10_000 });
  check(true, '別のプロジェクトで FmAudio.init が終わった');

  const peak = () => page.evaluate(() => window.peak());
  /** 指定した時間、50 ms ごとに測ったピークの最大 */
  const maxPeak = async (ms: number) => {
    let max = 0;
    for (let i = 0; i < ms / 50; i++) {
      max = Math.max(max, await peak());
      await page.waitForTimeout(50);
    }
    return max;
  };
  const waitSilent = async () => {
    for (let i = 0; i < 60 && (await peak()) > 0.001; i++) await page.waitForTimeout(100);
  };

  await page.evaluate(() => window.playBgm('A t120 l8 cdefgab>c'));
  const bgm = await maxPeak(1500);
  check(bgm > 0.01, `別のプロジェクトで BGM が鳴る（最大振幅 ${bgm.toFixed(3)}）`);
  await waitSilent();

  await page.evaluate(() => window.playSe('A t200 o6 l32 ceg>c'));
  const se = await maxPeak(500);
  check(se > 0.01, `別のプロジェクトで効果音が鳴る（最大振幅 ${se.toFixed(3)}）`);

  check(pageErrors.length === 0, `別のプロジェクトでページのエラーが起きていない（${pageErrors.join(' / ')}）`);
} finally {
  if (browser) await browser.close();
  if (server) await new Promise<void>((resolve) => server!.httpServer.close(() => resolve()));
  rmSync(tmpRoot, { recursive: true, force: true });
}
