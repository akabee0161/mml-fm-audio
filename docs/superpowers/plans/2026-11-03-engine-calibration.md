# 音源の補正 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `packages/engine` の暫定の振る舞い（変調の強さ・レート・アタック・キースケール・KSL・DT・LFO・波形 2 種）を、設計書の式と表に置き換える。

**Architecture:** 式は `tables.ts`（キーコード・DT・KSL）と `envelope.ts`（レートの番号・減衰・アタック）に純粋関数として置き、`voice.ts` が呼ぶ。LFO は `VoicePool` から `Voice` へ移し、ボイスごとに持つ。

**Tech Stack:** TypeScript、Vitest。

**Spec:** `docs/superpowers/specs/2026-11-03-engine-calibration-design.md`

## Global Constraints

- 公開 API（`packages/engine/src/index.ts` の export、`FmEngine` のメソッド）は変えない。
- 音の計算は Worklet に依存しない形で書き、Vitest で確かめる。`processor.ts` は触らない。
- `voiceData.ts` は他のファイルを import しない（変えない）。
- 音声スレッドで毎サンプル呼ぶ処理では、クロージャーや配列を作らない。
- テストの名前・コメント・コミットメッセージは日本語。コミットは Conventional Commits（`feat:`・`fix:`・`test:` など）。
- 完了前に `npm test` と `npm run build` を通す。

## Review Focus

1. 鳴っている途中のノートオン（アタック中・リリース中）：今の振幅から上がり、音量が跳ねない → Task 1 のテスト「途中のキーオンは今の振幅から上げる」。
2. 端のノート（0・127）と BO 3：キーコードが 0〜31 に収まり、DT の表の範囲外を引かない → Task 1 の keyCode のテスト、Task 2 の DT のテスト。
3. ドラム（FM 部とノイズ部）：新しいエンベロープでも鳴って止まる → 既存の voice.test のドラムのテストを通す（Task 1・3）。
4. AR が大きく idx ≥ 60：最初のサンプルから 0 dB → Task 1 のテスト。
5. 複数ボイスで LFO 音色が違う：ボイスごとの速さで揺れる → Task 3 のテスト。

---

### Task 1: キーコード・レートの番号・アタックの形

**Files:**
- Modify: `packages/engine/src/tables.ts`（`keyCode` を足す）
- Modify: `packages/engine/src/envelope.ts`
- Modify: `packages/engine/src/voice.ts`（`Envelope.keyOn` の呼び出し 2 か所）
- Test: `packages/engine/src/tables.test.ts`、`packages/engine/src/envelope.test.ts`

**Interfaces:**
- Produces:
  - `tables.ts`：`export function keyCode(note: number, bo: number): number`（0〜31）
  - `envelope.ts`：`export function rateIndex(rate: number, ksr: number, kc: number): number`（rate 0 なら 0、それ以外は `min(63, 4*rate + (ksr ? kc >> 1 : kc >> 3))`）
  - `envelope.ts`：`export function decayDbPerSec(idx: number): number`（idx 0 → 0）
  - `envelope.ts`：`export function attackSeconds(idx: number): number`（idx 0 → Infinity、idx ≥ 60 → 0）
  - `Envelope.keyOn(op: EnvelopeParams, kc: number): void`（第 2 引数をノート番号からキーコードに変える）
  - `effectiveRate` は消す。`RATE15_DB_PER_SEC`・`ATTACK_SPEEDUP`・`ATTACK_END_DB` も消す。

- [ ] **Step 1: 失敗するテストを書く**

`tables.test.ts` に `describe('keyCode')`：
- `keyCode(60, 0) === 15`、`keyCode(36, 0) === 7`、`keyCode(42, 0) === 7`、`keyCode(43, 0) === 10`、`keyCode(45, 0) === 10`、`keyCode(46, 0) === 11`
- `keyCode(72, 1) === keyCode(60, 0)`（BO 1 は 12 下げる）
- `keyCode(0, 3) === 3`（block は 0 に止まる。k = 5）、`keyCode(127, 0) === 30`、`keyCode(126, 0) === 31`

`envelope.test.ts` の「レートの表」を置き換える：
- `decayDbPerSec(rateIndex(6, 0, keyCode(60, 0)))` を `toBeCloseTo(89.36, 1)`（設計書の例 89.4）
- `decayDbPerSec(rateIndex(6, 1, keyCode(60, 0)))` を `toBeCloseTo(250.2, 1)`（例 250）
- `attackSeconds(rateIndex(4, 0, keyCode(36, 0)))` を `toBeCloseTo(0.3856, 4)`（例 0.386 秒）
- `rateIndex(0, 1, 31) === 0`、`decayDbPerSec(0) === 0`、`attackSeconds(0) === Infinity`
- `rateIndex(15, 0, 0) === 60`、`attackSeconds(60) === 0`、`rateIndex(15, 1, 31) === 63`
- `decayDbPerSec(63)` を `toBeCloseTo(36600 * 1.75, 6)`

`Envelope` の既存テストは `keyOn(..., 60)` を `keyOn(..., keyCode(60, 0))` に替え、レートの数値に依存する期待値（「ディケイで SL まで下がり」の 0.5 dB/サンプル、など）は新しい式で計算し直す。足すテスト：
- 「アタックは振幅が時間に比例して上がる」：SR 1000、`op({ ar: 4 })` を kc 7 でキーオン、`attackSeconds(rateIndex(4,0,7))` 秒の半分のサンプル数だけ進めたとき、`10 ** (-attenuation / 20)` が `toBeCloseTo(0.5, 2)`。アタックの秒数を過ぎたら `phase` が `decay` 以降。
- 「idx が 60 以上なら最初のサンプルから 0 dB」：`op({ ar: 15 })`・kc 0 で `next() === 0`。
- 「途中のキーオンは今の振幅から上げる」：リリース中に再キーオンしたとき、最初の `next()` の振幅がキーオン直前の振幅以上で、その差が 1 サンプル分の傾き（`1 / (attackSeconds * SR)`）以下。

- [ ] **Step 2: 失敗を確かめる**

Run: `npx vitest run packages/engine/src/tables.test.ts packages/engine/src/envelope.test.ts`
Expected: FAIL（`keyCode`・`rateIndex` がない）

- [ ] **Step 3: 実装する**

- `keyCode`：`n = note - 12 * bo`、`block = clamp(floor((n - 43) / 12) + 2, 0, 7)`、`k = ((n - 43) % 12 + 12) % 12`、`sub = k <= 2 ? 2 : 3`、`4 * block + sub`。
- `decayDbPerSec(idx) = 36600 * (1 + (idx & 3) / 4) * 2 ** ((idx >> 2) - 15)`。
- `attackSeconds(idx) = 6.17 / ((1 + (idx & 3) / 4) * 2 ** (idx >> 2))`。
- `Envelope` のアタック：キーオン時に `attackStep = 1 / (attackSeconds * sampleRate)` を求め（Infinity なら 0、0 なら直ちに 0 dB でディケイへ）、アタック中は振幅 `amp` を持ち、`amp += attackStep`。`amp >= 1` で 0 dB にしてディケイへ。減衰量は `amp > 0 ? min(SILENT_DB, -20 * log10(amp)) : SILENT_DB`。キーオン時の `amp` は今の減衰量から `10 ** (-attenuation / 20)`（無音なら 0）。
- `voice.ts`：`startFm` で `keyCode(note, voice.bo)` を渡す。`keyOnNoise` は `keyCode(60, 0)` を渡す。

- [ ] **Step 4: 通ることを確かめる**

Run: `npx vitest run packages/engine`
Expected: PASS（voice・voicePool の既存テストも、値を固定していないものは通る。落ちたものは、新しい速さで計算し直した値に直す。直した理由をテストのコメントに書く）

- [ ] **Step 5: コミット**

```bash
git add packages/engine/src
git commit -m "feat: レートの速さとアタックの形をキーコードとレートの番号で決める"
```

### Task 2: 変調の強さ・KSL・DT・波形

**Files:**
- Modify: `packages/engine/src/tables.ts`、`packages/engine/src/voice.ts`、`packages/engine/src/waveforms.ts`
- Test: `packages/engine/src/tables.test.ts`、`packages/engine/src/waveforms.test.ts`、`packages/engine/src/voice.test.ts`

**Interfaces:**
- Consumes: Task 1 の `keyCode(note, bo)`
- Produces:
  - `MOD_INDEX = 8 * Math.PI`
  - `export const DT_TABLE: readonly (readonly number[])[]`（d=1〜3 の 3 行 × 32、設計書の表）。`DT_CENTS` は消す。
  - `operatorFrequency(note, bo, mul, dt)`（引数の検査は今のまま）＝ `(base * BO_TABLE[bo] + s * DT_TABLE[d - 1][keyCode(note, bo)] * 48000 / 2 ** 20) * MUL_TABLE[mul]`。dt 0・4 は s = 0。
  - `export function kslAttenuation(ksl: number, note: number): number` ＝ `KSL_DB_PER_OCT[ksl] * max(0, (note - 30) / 12)`（BO は含めない）

- [ ] **Step 1: 失敗するテストを書く**

`tables.test.ts`：
- 「dt は Hz でずらす」：`operatorFrequency(72, 0, 1, 3) - operatorFrequency(72, 0, 1, 0)` を `toBeCloseTo(0.4578, 3)`（例 +0.458 Hz）。dt 7 は同じ大きさで負。dt 4 は dt 0 と等しい。`operatorFrequency(72, 0, 2, 3) - operatorFrequency(72, 0, 2, 0)` は 2 倍（MULTI はずらした後に掛ける）。
- 「DT の表は kc 0〜31 の 32 個ずつ」：`DT_TABLE.length === 3`、各行 32 個、`DT_TABLE[2][31] === 22`。
- `operatorFrequency(0, 3, 0, 7)` と `operatorFrequency(127, 0, 15, 3)` が有限の正の数。
- 「変調指数」：`MOD_INDEX * 10 ** (-(20 * TL_DB_PER_STEP) / 20)` を `toBeCloseTo(4.45, 1)`。
- `kslAttenuation(1, 54) === 6`、`kslAttenuation(3, 30) === 0`、`kslAttenuation(3, 20) === 0`、`kslAttenuation(2, 42) === 1.5`。

`waveforms.test.ts` の代表点：
- 7：`[0, 1]`、`[0.25, 2 ** -8]`、`[0.5, -(2 ** -16)]`、`[0.999, -(2 ** (-32 * 0.001))]`
- 27：`[0.125, 0.5]`、`[0.25, 0]`、`[0.5, 0]`、`[0.5625, 0.125]`、`[0.625, 0]`、`[0.75, 0]`
- 3・11・19（27 と同じ切り出し方の他の基本波形）の既存の代表点が変わらないこと（なければ 1 点ずつ足す）

- [ ] **Step 2: 失敗を確かめる**

Run: `npx vitest run packages/engine/src/tables.test.ts packages/engine/src/waveforms.test.ts`
Expected: FAIL

- [ ] **Step 3: 実装する**

- `tables.ts`：上の Produces のとおり。`TL_DB_PER_STEP` は変えない。
- `voice.ts` の `startFm`：`staticDb = op.tl * TL_DB_PER_STEP + kslAttenuation(op.ksl, note)`。
- `waveforms.ts`：`special` の 7 を `2 ** (-32 * x)`／`-(2 ** (-32 * (1 - x)))` に。27 は `waveValue` で `cut` より先に特別扱いする（`x < 0.25 ? 4 * x : x >= 0.5 && x < 0.625 ? 2 * (x - 0.5) : 0`）。

- [ ] **Step 4: 通ることを確かめる**

Run: `npx vitest run packages/engine`
Expected: PASS

- [ ] **Step 5: コミット**

```bash
git add packages/engine/src
git commit -m "feat: 変調の強さ・KSL・DT・波形 7 と 27 を実機に近い値にする"
```

### Task 3: LFO をボイスごとに持つ

**Files:**
- Modify: `packages/engine/src/lfo.ts`、`packages/engine/src/voice.ts`、`packages/engine/src/voicePool.ts`、`packages/engine/src/tables.ts`（`LFO_HZ`）
- Test: `packages/engine/src/lfo.test.ts`、`packages/engine/src/voice.test.ts`、`packages/engine/src/voicePool.test.ts`

**Interfaces:**
- Produces:
  - `LFO_HZ = [1.9, 4.2, 6.1, 7.2]`
  - `Lfo` に `reset(): void`（位相を 0 に。値は −1 から始まる）を足す
  - `Voice.render(left, right, from, to): void`（第 5 引数 `lfo` を消す）。`Voice` は `Lfo` を 1 つ持ち、FM の音色（ドラムは FM 部の音色）のノートオンで `setRate(音色の lfo)` と `reset()` を呼ぶ。
  - `VoicePool` から `Lfo`・`lfoValues` を消す。`VoicePool.render` の引数は変えない。
- 振る舞い：トレモロは今の式のまま（LFO −1 で減衰 0）。ビブラートは `inc *= 2 ** ((-lfo * VIB_DEPTH_CENTS[vibDepth]) / 1200)`（鳴り始めがいちばん高い）。LFO はアクティブな FM のボイスのサンプルごとに 1 回進める。

- [ ] **Step 1: 失敗するテストを書く**

- `lfo.test.ts`：「lfo=1 は 4.2 Hz」（SR 4200 で 1000 サンプルが 1 周期）、「reset で −1 から始まる」。
- `voicePool.test.ts`：「LFO は 1 系統」のテストを消し、「LFO はボイスごとで、ノートオンで先頭に戻る」に替える：ビブラートの音色を 1 音だけ鳴らしたプールの左の出力と、先に別のボイスで 1000 サンプル鳴らしてから同じ音をノートオンしたプールの、ノートオン後の出力（先のボイスはパン 127 で左に出さない）が一致する。
- `voicePool.test.ts`：「LFO の速さは音色ごと」：lfo 0 と lfo 3 の音色を同時に鳴らしても、それぞれ単独で鳴らした出力と一致する（左右のパンで分ける）。
- `voice.test.ts`：「ビブラートは鳴り始めがいちばん高い」：SR 48000、ノート 120、alg 1、op0 はサイン・TL 0・`vib: 1, vibDepth: 3`、op1 は TL 63、lfo 0。最初の 2400 サンプルのゼロ交差（負→正）の数が、`vib: 0` の同じ音色より多い。
- `voice.test.ts` の `render(..., lfo)` の呼び出しから第 5 引数を消す。

- [ ] **Step 2: 失敗を確かめる**

Run: `npx vitest run packages/engine/src/lfo.test.ts packages/engine/src/voice.test.ts packages/engine/src/voicePool.test.ts`
Expected: FAIL

- [ ] **Step 3: 実装する**（上の Interfaces のとおり。`sampleFm` は引数をなくし、中で `this.lfo.next()` を 1 回呼ぶ）

- [ ] **Step 4: 通ることを確かめる**

Run: `npm test && npm run build`
Expected: PASS

- [ ] **Step 5: コミット**

```bash
git add packages/engine/src
git commit -m "feat: LFO をボイスごとに持ち、速さとビブラートの向きを実機に合わせる"
```

### Task 4: 文書と音色の変化の一覧（メインのセッションが行う）

**Files:**
- Modify: `packages/engine/src/tables.ts`（先頭の注記に「実測」の区分を足し、各値の注記を「暫定」「公開値」から直す）、`envelope.ts` の注記
- Modify: `docs/spec.md`（§2・§3.2 の dt・LFO・tl の説明、§8 の使ってよい資料、版を v0.10 に）
- Modify: `ISSUES.md`（#3 の行を消す）、`README.md`（該当があれば）、`HANDOVER.md`
- 音色集の変化の一覧：変更前（`main`）と変更後で、音色ごとにアタック・減衰の秒数、変調の強さ、DT・LFO・波形 7/27・KSL の使用を比べ、Artifact のページで依頼者に渡す（リポジトリには入れない）。

- [ ] **Step 1:** 上の文書を直す
- [ ] **Step 2:** `npm test`・`npm run build`・`npm run check:browser` を通す
- [ ] **Step 3:** コミット `docs: 音源の補正に合わせて仕様と課題を直す`
- [ ] **Step 4:** 一覧を作って Artifact で渡す
