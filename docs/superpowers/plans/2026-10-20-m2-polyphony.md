# M2 実装計画：16 音同時発音、ステレオ、ノイズ、ドラム 8 種

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 16 ボイスの同時発音・ステレオ・ノイズ・ドラム 8 種と負荷の計測を音源と試聴ページに加え、公開して実測できる状態にする。

**Architecture:** `Voice` は 1 音（FM 音色かドラム）を、音色とパンを `noteOn` で受け取って左右のバッファーへ足し込む。新しい `VoicePool` が 16 ボイスの割り当て・ID 管理・LFO を持ち、`processor.ts` は待ち行列・丸め・負荷計測を `VoicePool` につなぐだけにする。試聴ページは番号付きの音色登録と ID 付きの `noteOn`/`noteOff` で操作する。

**Tech Stack:** TypeScript、AudioWorklet、Vite、Vitest、playwright-core（ヘッドレス Chromium）

**Spec:** `docs/superpowers/specs/2026-10-20-m2-polyphony-design.md`（製品仕様は `docs/spec.md`）

## Global Constraints

- 返答・コメント・コミットメッセージは日本語。Conventional Commits。author は `akabee0161 <akabee0161@gmail.com>`。
- `MAX_VOICES = 16` は 1 か所（`voicePool.ts`）で定義する。
- 音の計算は Worklet に依存しない形で書き、Vitest で確かめる。`processor.ts` は薄く保つ。
- `packages/engine/src/voiceData.ts` は他のファイルを import しない。
- `voices/ymf825/*.json` は手で編集しない。独自の音色は `voices/custom/` に置く。
- 製品名・商標（YAMAHA、MA-3、SMAF、YMF825 など）を API 名に使わない。
- 引数の検査で投げる例外は M1 と同じく `RangeError` で、値を含む日本語のメッセージにする。
- 各タスクの終わりに `npm test` と `npx tsc --noEmit` を通す。最後に `npm run build`、`npm run check:browser` を通す。ヘッドレス Chromium は 1 つずつ動かし、終わったら chrome と vite のプロセスが残っていないことを確かめる。

## Review Focus

1. 奪われたボイスの ID で後から `noteOff` が来る → 新しい音を止めてはいけない（Task 5 のテスト）。
2. 鳴っている最中に同じ `program` を登録し直す → 鳴っている音は前の音色のまま鳴り終える（Task 5 のテスト）。
3. 未登録の `program` の `noteOn` → 鳴らさず warning（Task 5・6 のテスト）。
4. ドラムを繰り返し鳴らしてもボイスが溜まらない（鳴り終えたボイスが空きになる）→ `validateDrum` の終端の規則と、リズムを模した連打のテスト（Task 3・5）。
5. 和音を押さえたまま `blur`・`visibilitychange` が起きる → 押していた全音を止める（Task 7 のテスト）。

---

### Task 1: 残りの結線の出力テスト（ISSUES #4）

**Files:**
- Modify: `packages/engine/src/voice.test.ts`
- Modify: `ISSUES.md`（#4 の行を消す）

**Interfaces:** なし（M1 の `Voice` をそのまま使う。このタスクは Task 4 より前に行う）

- [ ] **Step 1: テストを足す**

`describe('Voice')` に、表駆動のテスト `it.each` で alg 1/2/3/6/7 を足す。各 alg について：
- 出力するオペレーター（spec §3.6 の表：1→[1,2]、2→[1,2,3,4]、3→[4]、6→[1,4]、7→[1,3,4]）をすべて TL=63 にすると `peak < 0.01`。
- 出力しないオペレーターをすべて TL=63 にし、出力するものは TL=0 のままだと `peak > 0.05`。
- 出力するオペレーターのうち 1 つだけを TL=0 に戻すと `peak > 0.05`（各出力オペレーターについて）。

- [ ] **Step 2: 実行して通ることを確かめる**

Run: `npx vitest run packages/engine/src/voice.test.ts`
Expected: PASS（結線は M1 で正しいはず。落ちたら結線表と `algorithms.ts` を照合して原因を報告する）

- [ ] **Step 3: `ISSUES.md` の #4 の行を消してコミット**

```bash
git commit -am "test: 残りの結線（alg 1/2/3/6/7）の出力を確かめるテストを追加（ISSUES #4）"
```

---

### Task 2: エンベロープの引数を広げ、ノイズ発生器を作る

**Files:**
- Modify: `packages/engine/src/envelope.ts`、`envelope.test.ts`
- Create: `packages/engine/src/noise.ts`、`noise.test.ts`

**Interfaces:**
- Produces: `export type EnvelopeParams = Pick<FmOperator, 'ar' | 'dr' | 'sl' | 'sr' | 'rr' | 'ksr' | 'xof'>`（envelope.ts）。`Envelope.keyOn(params: EnvelopeParams, note: number): void`。
- Produces: `export class Noise { constructor(seed?: number); reset(seed?: number): void; next(): number }`（noise.ts）。`next()` は −1 以上 1 未満。

- [ ] **Step 1: 失敗するテストを書く**

`noise.test.ts`：
- `同じ種なら同じ列`：`new Noise(7)` を 2 つ作り、1000 個の値が一致。
- `値は −1〜1、平均はほぼ 0`：48000 個で `min >= -1`、`max < 1`、`|平均| < 0.02`。
- `種が違えば列が違う`。
- `reset で最初からやり直せる`。

`envelope.test.ts`：`keyOn` に `{ ar: 15, dr: 15, sl: 4, sr: 10, rr: 15, ksr: 0, xof: 0 }`（FmOperator でないオブジェクト）を渡して、`decay → sustain → 下がり続けて off` になることを確かめるテスト。

- [ ] **Step 2: 失敗を確かめる** — Run: `npx vitest run packages/engine/src/noise.test.ts` → FAIL（モジュールがない）

- [ ] **Step 3: 実装する**

`noise.ts` は xorshift32（種 0 は 1 に置き換える）。`next()` は `(x >>> 0) / 2**32 * 2 - 1`。`envelope.ts` は `keyOn` の型を `EnvelopeParams` にするだけ。

- [ ] **Step 4: 通ることを確かめる** — Run: `npm test && npx tsc --noEmit` → PASS

- [ ] **Step 5: コミット** — `feat: ノイズ発生器を追加し、エンベロープの引数をオペレーター以外からも渡せるようにする`

---

### Task 3: ドラム音色の型と検証

**Files:**
- Modify: `packages/engine/src/voiceData.ts`、`voiceData.test.ts`
- Modify: `packages/engine/src/index.ts`（型と `validateDrum` を export）

**Interfaces:**
- Produces（voiceData.ts）：

```ts
export interface DrumNoise {
  level: number; ar: number; dr: number; sl: number; rr: number; color: 'white';
  repeat?: { count: number; intervalMs: number };
}
export interface DrumVoice {
  id: number;            // 128 以上の整数
  name: string;
  kind: 'drum';
  fm?: { voice: FmVoice; note: number; level: number };
  pitch?: { fromSemitone: number; toSemitone: number; decayMs: number };
  noise?: DrumNoise;
}
export type AnyVoice = FmVoice | DrumVoice;
export type DrumValidationResult = { ok: true; voice: DrumVoice } | { ok: false; errors: ValidationError[] };
export function validateDrum(input: unknown): DrumValidationResult;
```

規則（設計書 §3.5）：`id` は 128〜255 の整数。`fm.voice` は `validateVoice` で検証し、エラーの path に `fm.voice.` を前置する。`fm.note` 0〜127 の整数、`fm.level`・`noise.level` は 0〜1 の数。`pitch` は `fm` がなければエラー、半音は −48〜48 の数、`decayMs` は 0 より大きく 1000 以下の数。`noise.ar`・`dr`・`sl` は 0〜15、`rr` は 1〜15 の整数、`color` は `"white"` のみ。`repeat.count` 1〜8 の整数、`intervalMs` 1〜100 の数。`fm` と `noise` が両方ないとエラー（path は `''`）。`fm.voice` の出力オペレーター（`ALGORITHMS` は import できないので、voiceData.ts 内に alg → 出力オペレーターの添字の表を持つ。値は spec §3.6）のうち「`sl` が 15 未満かつ `sr` が 0」のものはエラー（path は `fm.voice.ops[i].sr`、理由は「ドラムは鳴り終わる必要があるため、sl=15 か sr≥1 にしてください」）。

- [ ] **Step 1: 失敗するテストを書く**

`describe('validateDrum')`：
- 正しい bd（fm＋pitch）、ch（noise のみ）、cp（noise＋repeat）が通る。
- `fm` も `noise` もない → エラー。
- `pitch` だけで `fm` がない → path `pitch`。
- `noise.color: 'pink'` → path `noise.color`。
- `noise.rr: 0` → path `noise.rr`。
- `fm.voice.alg` が範囲外 → path `fm.voice.alg`。
- 出力オペレーターが `sl: 3, sr: 0` → path `fm.voice.ops[1].sr`（alg 0 の op2）。出力しないオペレーター（op1）が `sl: 3, sr: 0` でも通る。
- `id: 127` → path `id`。
- 出力オペレーターの表が `algorithms.ts` の `ALGORITHMS[*].carriers` と一致する（テスト側は両方を import してよい）。

- [ ] **Step 2: 失敗を確かめる** → FAIL
- [ ] **Step 3: 実装する**
- [ ] **Step 4: `npm test && npx tsc --noEmit`** → PASS
- [ ] **Step 5: コミット** — `feat: ドラム音色の型と検証（validateDrum）を追加`

---

### Task 4: Voice を、音色・パン付きの noteOn とステレオの足し込みに変え、ドラムを鳴らせるようにする

**Files:**
- Modify: `packages/engine/src/voice.ts`、`voice.test.ts`
- Modify: `packages/engine/src/output.ts`、`output.test.ts`

**Interfaces:**
- Consumes: Task 2 の `EnvelopeParams`、`Noise`。Task 3 の `AnyVoice`、`DrumVoice`。
- Produces（output.ts）：`export function panGains(pan: number): [left: number, right: number]`。設計書 §3.3 の式（64 でちょうど π/4）。
- Produces（voice.ts）：

```ts
export class Voice {
  constructor(sampleRate: number);
  noteOn(timbre: AnyVoice, note: number, pan: number): void; // 鳴っていた音は切る
  noteOff(): void;                 // ドラムでは何もしない
  stop(): void;                    // すぐに無音にする（奪うとき用）
  get active(): boolean;
  /** left/right の [from, to) に足し込む。lfo[s] はサンプル s の LFO 値（−1〜1） */
  render(left: Float32Array, right: Float32Array, from: number, to: number, lfo: Float32Array): void;
}
```

M1 の `setVoice` と、`render` 内で `Lfo.next()` を呼ぶ作りは無くす（LFO は Task 5 の `VoicePool` が 1 ブロック分の値を作る）。ドラムは：FM 部を `fm.voice` で `fm.note` の高さに鳴らし、`pitch` があれば全オペレーターの周波数に `2 ** (offset / 12)` を掛ける（`offset` は設計書 §3.5 の式、毎サンプル `diff *= exp(-1 / (decayMs * sampleRate / 1000))` で求めてよい）。ノイズ部は `Envelope` に `{ ar, dr, sl, sr: rr, rr, ksr: 0, xof: 0 }` を渡し、`repeat` があれば `intervalMs` ごとに `count` 回目まで `keyOn` し直す。出力は `fmSample × fm.level + noise × 10^(−dB/20) × noise.level × OUTPUT_GAIN`。`active` は FM の出力オペレーター・ノイズのエンベロープ・残りの `repeat` のどれかが残っていれば true。

- [ ] **Step 1: 既存テストを新しい形に書き換え、失敗するテストを足す**

テストの `play` を `noteOn(timbre, note, 64)` と `render(left, right, 0, n, zeros)` に変える。M1 の既存の期待値は、左チャンネルの値を `panGains(64)[0]` で割って比べる（またはピークの閾値に 0.707 を掛ける）。足すテスト：
- `output.test.ts`：`panGains(0)` は `[1, 0]`（右は 1e-12 未満）、`panGains(127)` は左が 1e-12 未満で右が 1、`panGains(64)` は左右が等しく約 0.7071、二乗和は全域で 1。
- `render は足し込む`：あらかじめ 0.5 を入れたバッファーに足され、範囲外は変わらない。
- `pan 0 で右が無音`。
- `noteOn で別の音色に替えても例外なく鳴る`（M1 の「切り替えると止まる」テストの置き換え）。
- `stop() ですぐに active が false`。
- ドラム：`noteOff を無視し、エンベロープが尽きると active が false`（2 秒以内）。`pitch` あり（from 24・to 0）と無しで、最初の 10 ms の上向きゼロ交差数が多い。`noise のみのドラムが鳴る`。`repeat: {count: 3, intervalMs: 10}` で、0〜10 ms・10〜20 ms・20〜30 ms のそれぞれの区間の始め 2 ms に振幅の山がある（`dr` を速く、`sl: 15` にしたノイズで、各区間の終わり近くは小さい）。`fm.level: 0` で FM 部が聞こえない。

- [ ] **Step 2: 失敗を確かめる** → FAIL
- [ ] **Step 3: 実装する**（ドラムの処理を `voice.ts` に入れるか `drum.ts` に分けるかは任意。分ける場合も `Voice` の公開面は上のとおり）
- [ ] **Step 4: `npm test && npx tsc --noEmit`** → `voice` と `output` のテストは PASS。`processor.ts` は Task 6 まで型エラーになるので、このタスクでは `processor.ts` を最小限直して（`new Voice` を 1 つ使い、`setVoice` で受けた音色を保持して `noteOn(timbre, note, 64)` を呼ぶ）型を通す。
- [ ] **Step 5: コミット** — `feat: Voice を音色・パン付きの発音とステレオの足し込みに変え、ドラムを鳴らせるようにする`

---

### Task 5: 16 ボイスの割り当て（VoicePool）

**Files:**
- Create: `packages/engine/src/voicePool.ts`、`voicePool.test.ts`

**Interfaces:**
- Consumes: Task 4 の `Voice`、`Lfo`（`setRate(index)`・`next()`）。
- Produces：

```ts
export const MAX_VOICES = 16;
export class VoicePool {
  constructor(sampleRate: number, size?: number); // 既定 MAX_VOICES
  register(program: number, timbre: AnyVoice): void;
  /** 鳴らせたら true。未登録の program は false */
  noteOn(id: number, program: number, note: number, pan: number): boolean;
  noteOff(id: number): void;           // 該当なしは何もしない
  /** left/right の [from, to) に足し込む。LFO を (to − from) サンプル進める */
  render(left: Float32Array, right: Float32Array, from: number, to: number): void;
  get activeCount(): number;
}
```

割り当ては設計書 §3.1（空き → なければ最も古く `noteOn` したものを `stop()` して使う）。`register` は音色オブジェクトを保持するだけで、鳴っている `Voice` には前の音色が残る。FM 音色の `noteOn` で `lfo.setRate(timbre.lfo)`。

- [ ] **Step 1: 失敗するテストを書く**
- `16 音まで同時に鳴る`（`activeCount === 16`）。
- `17 音目で最も古い音が止まる`：id 1〜16 を鳴らし、id 17 を鳴らすと、その後の `noteOff(1)` は何も変えず、`noteOff(2)` のあとリリースが進む（`rr: 15` の音色で数千サンプル後に `activeCount === 15`）。
- `奪われた ID の noteOff は新しい音を止めない`。
- `鳴り終えたボイスが使い回される`：`noteOff` して鳴り終えた後、17 音目を鳴らしても奪いが起きない（16 音目までの別の音が鳴り続ける）。
- `未登録の program は false で、鳴らない`。
- `登録し直しても、鳴っている音は前の音色で鳴る`：登録し直す前後で同じ id の出力が、新しい音色で鳴らしたものと異なる。
- `ドラムを 100 回連打しても溜まらない`：ノイズのみ・短いドラムを 125 ms ごとに 100 回鳴らし、各回の直前で `activeCount <= 2`。
- `16 音の和でも render は例外なく、値は有限`。

- [ ] **Step 2: 失敗を確かめる** → FAIL
- [ ] **Step 3: 実装する**（LFO の値はブロック用の `Float32Array` に作って各 `Voice.render` に渡す）
- [ ] **Step 4: `npm test && npx tsc --noEmit`** → PASS
- [ ] **Step 5: コミット** — `feat: 16 ボイスの割り当て（VoicePool）を追加`

---

### Task 6: メッセージ・processor・FmEngine を新しい形にし、負荷を計測する

**Files:**
- Create: `packages/engine/src/loadMeter.ts`、`loadMeter.test.ts`
- Modify: `packages/engine/src/messages.ts`、`processor.ts`、`index.ts`、`index.test.ts`
- Modify: `packages/engine/src/tables.ts`（`MIX_GAIN = 0.5` を足す。暫定のコメント付き）

**Interfaces:**
- Consumes: Task 5 の `VoicePool`、Task 4 の `panGains` は不要（Voice 内で使う）。
- Produces（messages.ts）：

```ts
export type EngineMessage =
  | { type: 'registerVoice'; program: number; voice: AnyVoice }
  | { type: 'noteOn'; id: number; program: number; note: number; pan: number; time: number }
  | { type: 'noteOff'; id: number; time: number }
  | { type: 'setQuantize'; enabled: boolean }
  | { type: 'setLoadReport'; enabled: boolean };
export type EngineReply = { type: 'warning'; message: string } | { type: 'load'; report: LoadReport };
```

- Produces（loadMeter.ts）：

```ts
export type ClockKind = 'performance' | 'date';
export interface LoadReport {
  avgMs: number; maxMs: number | null; blockMs: number; percent: number; maxVoices: number; clock: ClockKind;
}
export class LoadMeter {
  constructor(sampleRate: number, clock: ClockKind);
  /** 1 ブロック分を記録する。音声で 1 秒分たまったら集計を返して数え直す。そうでなければ null */
  record(elapsedMs: number, blockFrames: number, activeVoices: number): LoadReport | null;
}
```

`clock: 'date'` のとき `maxMs` は null。`percent = avgMs / blockMs × 100`。

- Produces（index.ts の `FmEngine`）：

```ts
registerVoice(program: number, voice: AnyVoice): void;             // program は 0〜255 の整数
noteOn(program: number, note: number, options?: { pan?: number; time?: number }): number; // ID を返す。pan 既定 64
noteOff(id: number, time?: number): void;
setQuantize(enabled: boolean): void;
setLoadReport(enabled: boolean): void;
onWarning(handler: (message: string) => void): void;
onLoad(handler: (report: LoadReport) => void): void;
```

`program` 0〜255 の整数、`note` 0〜127、`pan` 0〜127 の整数、`time` は有限、`id` は整数。外れたら `RangeError`。ID は 1 から振る連番。`index.ts` から `AnyVoice`、`DrumVoice`、`LoadReport`、`validateDrum`、`MAX_VOICES` も export する。

processor：`process` の先頭と末尾で時計を読み（`typeof performance !== 'undefined'` なら `performance.now()`、そうでなければ `Date.now()`）、`setLoadReport` がオンのときだけ `LoadMeter.record` し、返った集計を `{ type: 'load' }` で送る。出力は左右のバッファーを 0 で埋めてから `VoicePool.render`、`MIX_GAIN` を掛けて左右それぞれ丸め。出力が 1 チャンネルのときは左右の平均を書く。未登録 `program` の `noteOn` は warning。FM 音色の `registerVoice` では M1 と同じく `voiceWarnings` を送る。

- [ ] **Step 1: 失敗するテストを書く**
- `loadMeter.test.ts`：48000 Hz・128 フレームで 375 ブロック記録すると集計が返る（374 ブロック目までは null）。平均・最大・`blockMs`（2.6667）・`percent`・`maxVoices`。`date` では `maxMs` が null。返した後は数え直す。
- `index.test.ts`（M1 の偽の `AudioWorkletNode` を使う既存の作りに合わせる）：`noteOn` が 1, 2, … を返し、送ったメッセージに `id`・`program`・`pan`（既定 64）が入る。`pan: 128`・`program: 256`・`note: -1` で `RangeError`。`noteOff(id)` が `id` を送る。`load` の返信が `onLoad` に届く。

- [ ] **Step 2: 失敗を確かめる** → FAIL
- [ ] **Step 3: 実装する**
- [ ] **Step 4: `npm test && npx tsc --noEmit`** → PASS（demo は Task 7 まで型エラーになりうる。その場合は demo の呼び出しを最小限直して通す）
- [ ] **Step 5: コミット** — `feat: 16 ボイス・ステレオの Worklet と、ID 付きの発音 API・負荷の計測を追加`

---

### Task 7: ドラム 8 種と試聴ページ

**Files:**
- Create: `voices/custom/drums.json`、`demo/drums.test.ts`（または `voiceData.test.ts` に足す）
- Create: `demo/rhythm.ts`、`demo/rhythm.test.ts`
- Modify: `demo/keyboard.ts`、`keyboard.test.ts`、`demo/main.ts`、`demo/index.html`、`demo/style.css`

**Interfaces:**
- Consumes: Task 6 の `FmEngine`、`validateDrum`、`MAX_VOICES`。
- Produces（keyboard.ts。`MonoNoteTracker` を置き換える）：

```ts
export class PolyNoteTracker {
  /** key を押し始めた。すでに押されていれば false（鳴らさない） */
  press(key: string): boolean;
  /** press が true だった key に、鳴らした音の ID を結び付ける */
  bind(key: string, id: number): void;
  /** 離した key の ID。なければ undefined */
  release(key: string): number | undefined;
  /** 押されている全 key を離し、その ID を返す */
  releaseAll(): number[];
}
```

- Produces（rhythm.ts）：

```ts
export const DRUM_PROGRAMS: Readonly<Record<'bd'|'sd'|'ch'|'oh'|'cy'|'lt'|'ht'|'cp', number>>; // 128〜135（設計書 §5）
export interface RhythmStep { tick: number; drum: keyof typeof DRUM_PROGRAMS }
export const RHYTHM_PATTERN: readonly RhythmStep[]; // 1 小節 = 16 分音符 16 個（tick 0〜15）、8 種すべてを含む
/** テンポ bpm で、小節頭のサンプル時刻 barStart から始まる 1 小節分の発音時刻 */
export function scheduleBar(barStart: number, sampleRate: number, bpm: number): Array<{ time: number; program: number }>;
```

画面（設計書 §4）：
- 音色の選択は FM の 18 種のみ。選んだ音色を `program` 0 に登録し直し、鍵盤と 16 音ボタンは `program` 0 で鳴らす（登録し直しても鳴っている音は前の音色のまま）。
- ドラムは起動時に `drums.json` の 8 種を各 `id` の `program` に登録する。検証を通らないものは `console.error`（M1 の `bundledVoices` と同じ扱い）。
- 「16 音を鳴らす」ボタン：押すと `MAX_VOICES` 個の音（C3＝48 から始めて 2〜3 半音おきなど、2 オクターブ半に収まる並び）を鳴らし、ボタンの表示を「16 音を止める」に変える。もう一度押すと全 ID を `noteOff`。
- パンのつまみ（`input type=range` 0〜127、既定 64、今の値を数字でも表示）。鍵盤・16 音・ドラム・リズムの次の発音に効く。
- ドラムのボタン 8 個（ラベルは名前と楽器名。例：「bd バスドラム」）。
- 「リズムを鳴らす」ボタン：テンポ 120、`setInterval`（25 ms ごと）で 0.1 秒先までの小節を `scheduleBar` で作り、`time` 付きで `noteOn` する。もう一度押すと止める（先に送った分は鳴ってよい）。
- 「負荷を表示」のチェック：オンで `setLoadReport(true)` と `onLoad` の表示（平均 ms、最大 ms または「−」、1 ブロック ms、割合 %、最大ボイス数、時計の種類）。
- `?debug` の `window.__mmlFmAudio` を `{ peak(): number; peakLeft(): number; peakRight(): number }` にする（`ChannelSplitterNode` と左右の `AnalyserNode`）。`peak` は左右の大きい方。
- ヒントの文：鍵盤で和音が弾けること、16 音を鳴らしたまま鍵盤を押すと 17 音目になること。

ドラム 8 種の値は設計書 §5・spec §3.4 の構成の目安に従って作る（暫定）。Rim Shot・Castanet の値は写さない。

- [ ] **Step 1: 失敗するテストを書く**
- `PolyNoteTracker`：2 つのキーを押して両方の ID が返る、同じキーの 2 度押しは false、`releaseAll` が全 ID を返して空になる、知らないキーの `release` は undefined。
- `rhythm.test.ts`：`RHYTHM_PATTERN` に 8 種すべてがある、`tick` が 0〜15、`scheduleBar(0, 48000, 120)` の時刻が 16 分音符（6000 サンプル）刻み、`program` が 128〜135。
- `drums.json`：8 件、`id` が 128〜135 で名前が設計書 §5 の表のとおり、すべて `validateDrum` を通る。
- （Review Focus 5）`blur` で全音が止まることは、`releaseAll` のテストと Task 8 のブラウザーの確認で押さえる。

- [ ] **Step 2: 失敗を確かめる** → FAIL
- [ ] **Step 3: 実装する**（keyboard・rhythm・drums.json → main.ts・index.html・style.css）
- [ ] **Step 4: `npm test && npm run build`** → PASS
- [ ] **Step 5: 開発サーバーで動かし、音を出す前後でコンソールにエラーがないことを確かめる**（`npm run check:browser` は Task 8 で拡張する）
- [ ] **Step 6: コミット** — `feat: 試聴ページに和音・16 音・パン・ドラム・リズム・負荷の表示を追加`

---

### Task 8: ブラウザーでの確認を広げ、正典を更新する

**Files:**
- Modify: `tools/check-browser.ts`
- Modify: `README.md`、`docs/spec.md`（§3.4 に `noise.repeat`、`id` の範囲）、`HANDOVER.md`

**Interfaces:**
- Consumes: Task 7 の画面の要素と `window.__mmlFmAudio`。

- [ ] **Step 1: `tools/check-browser.ts` に確認を足す**
- 音色の選択肢が 18 種のまま。
- 和音：`a` だけのピークより、`a`・`d`・`g` を押したときのピークが大きい。
- パン：つまみを 0 にして鳴らすと `peakRight() < 0.01` かつ `peakLeft() > 0.01`。64 に戻す。
- ドラム：8 個のボタンそれぞれで音が出る（押して 50 ms 後のピーク > 0.01、次まで 1 秒待つか、bd などの長いものは鳴り終わりを待つ）。
- 16 音ボタン：押してエラーがなく音が出る。負荷を表示にして 1.5 秒以内に負荷の表示が出る（数値が入る）。止める。
- `blur` を発火すると、押したままの鍵の音が止まる（`a` を押したまま `window.dispatchEvent(new Event('blur'))`、リリース後にピークが下がる）。
- ページのエラーがない。

- [ ] **Step 2: `npm test && npm run build && npm run check:browser`** → すべて OK。終わったら `pgrep -fa 'chrome|vite'` で残りがないことを確かめる。

- [ ] **Step 3: 正典を更新する**
- `README.md`：現在の状態を M2 までに、暫定値に `MIX_GAIN`（tables.ts）を足す、ドラム音色の置き場（`voices/custom/drums.json`、番号 128〜135）、試聴ページでできること。負荷の記録の置き場 `docs/load-measurements.md` は記録を書くときに足す（M2 の PR では作らない）。
- `docs/spec.md` §3.4：`noise.repeat`、`rr` を SL 到達後の減衰に使うこと、ドラムは鳴り終わる必要があること。版を v0.3、日付を 2026-10-20 にする。
- `HANDOVER.md`：今の状態（M2 の実装済み・PR を出す段階）と次にやること（依頼者の確認 1〜7、実測、記録）。

- [ ] **Step 4: コミット** — `docs: M2 の状態を README・spec・HANDOVER に反映し、ブラウザーでの確認を広げる`
