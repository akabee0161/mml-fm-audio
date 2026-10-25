// Player の pump の重さを測る道具。試聴ページと同じ条件（48 kHz・25 ms ごとに pump、先読み 0.1 秒）で回す。
// 使い方：npm run measure:player [-- 秒数]（既定 60 秒分）
import { readFileSync } from 'node:fs';
import { parseMml } from '../packages/sequencer/src/parser.ts';
import { Player } from '../packages/sequencer/src/player.ts';
import type { EngineLike } from '../packages/sequencer/src/player.ts';

const SAMPLE_RATE = 48000;
const PUMP_INTERVAL_SECONDS = 0.025;
const LOOKAHEAD_SECONDS = 0.1;

const seconds = process.argv[2] === undefined ? 60 : Number(process.argv[2]);
if (!Number.isFinite(seconds) || seconds <= 0) {
  console.error(`秒数は正の数で指定してください: ${process.argv[2]}`);
  process.exit(1);
}

const manyTracks = 'ABCDEFGHIJKLMNOP'.split('').map((name, i) => `${name} ${i === 0 ? 't999 L ' : ''}[[c%1]200]200`).join('\n');
// ループの中でノートオンしたノートのゲートは、ループ 1 周の 16 倍まで（超えると解析エラー）。B がループ（L・E）を決め、
// 残りの 15 トラックは、1 周の最後のノートを 16 倍ちょうどにして、周ごとに重ねる。
const others = 'ACDEFGHIJKLMNOP'.split('');
const shortLoop = ['B t999 L r%2 E', ...others.map((name) => `${name} c%32`)].join('\n');
const longPeriod = 200 * 200 + 1;
const longLoop = [
  `B t999 L r%${longPeriod} E`,
  ...others.map((name) => `${name} [[c%1]200]200 c%${16 * longPeriod}`),
].join('\n');
const inputs: { name: string; mml: string }[] = [
  { name: '1 トラック 4 万ノート・t120', mml: 'A L [[t120 c%1]200]200' },
  { name: '16 トラック × 4 万ノート・t999', mml: manyTracks },
  { name: '上限：ループ 1 周 2 ティック・15 トラックの 16 倍ちょうどのノート', mml: shortLoop },
  { name: '上限：ループ 1 周 4 万ティック・15 トラックの短いノート 4 万個＋16 倍ちょうどのノート', mml: longLoop },
  { name: 'demo/songs/m3-demo.mml', mml: readFileSync(new URL('../demo/songs/m3-demo.mml', import.meta.url), 'utf8') },
];

let sentCount = 0;
const engine: EngineLike = {
  noteOn() { sentCount++; return sentCount; },
  noteOff() { sentCount++; },
  setPitchBend() { sentCount++; },
  setVolume() { sentCount++; },
  cancel() {},
};

const rows: Record<string, string>[] = [];
for (const { name, mml } of inputs) {
  const t0 = performance.now();
  const song = parseMml(mml);
  const parseMs = performance.now() - t0;
  if (song.errors.length > 0) {
    console.error(`${name}: MML にエラーがあります（${song.errors[0].line} 行 ${song.errors[0].column} 列 ${song.errors[0].message}）`);
    process.exit(1);
  }
  const player = new Player(engine, song, { sampleRate: SAMPLE_RATE, startFrame: 0 });
  let totalMs = 0;
  let maxMs = 0;
  let maxSent = 0;
  let totalSent = 0;
  const steps = Math.round(seconds / PUMP_INTERVAL_SECONDS);
  for (let i = 0; i < steps; i++) {
    const now = Math.round(i * PUMP_INTERVAL_SECONDS * SAMPLE_RATE);
    sentCount = 0;
    const t = performance.now();
    player.pump(now, now + LOOKAHEAD_SECONDS * SAMPLE_RATE);
    const ms = performance.now() - t;
    totalMs += ms;
    totalSent += sentCount;
    if (ms > maxMs) { maxMs = ms; maxSent = sentCount; }
  }
  const ts = performance.now();
  player.stop();
  const stopMs = performance.now() - ts;
  rows.push({
    入力: name,
    測った秒数: String(seconds),
    '解析時間(ms)': parseMs.toFixed(1),
    'pump 合計(ms)': totalMs.toFixed(1),
    'pump 最大(ms)': maxMs.toFixed(2),
    '最大の pump のイベント数': String(maxSent),
    'sent 合計': String(totalSent),
    'stop(ms)': stopMs.toFixed(2),
  });
}
console.table(rows);
