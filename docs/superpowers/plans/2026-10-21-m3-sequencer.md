# M3 実装計画：MML の全命令とループ

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** MML のテキストを解析して音源を鳴らすシーケンサー（`packages/sequencer`）を作り、試聴ページで手書きの曲を `L`〜`E` の区間でループ再生できるようにする。

**Architecture:** 音源に、ノートごとの音量・ピッチベンドと、予約したイベントの取り消しを足す。`packages/sequencer` は、MML を解析してトラックごとのイベント列（ティック単位）とテンポの列・ループ区間を作る `parseMml`、ティックを秒に直す `Timeline`、先読みして音源へ送る `Player` からなる。`Player` は音源を直接 import せず `EngineLike` の型を受け取る。試聴ページは `FmEngine` を `Player` に渡し、M2 のリズムと同じく `setInterval` で先読みする。

**Tech Stack:** TypeScript、AudioWorklet、Vite（`?raw` で `.mml` を読む）、Vitest、playwright-core（ヘッドレス Chromium）、npm workspaces

**Spec:** `docs/superpowers/specs/2026-10-21-m3-sequencer-design.md`（製品仕様は `docs/spec.md`）

## Global Constraints

- 返答・コメント・コミットメッセージは日本語。Conventional Commits。author は `akabee0161 <akabee0161@gmail.com>`。
- 音の計算は Worklet に依存しない形で書き、Vitest で確かめる。`processor.ts` は薄く保つ。
- `packages/sequencer` の `parseMml`・`Timeline` はブラウザーにも Worklet にも依存しない（Node から使えること）。`packages/sequencer` は `packages/engine` を import しない。
- 製品名・商標（YAMAHA、MA-3、SMAF、YMF825 など）を API 名に使わない。
- 音源の引数の検査で投げる例外は `RangeError` で、値を含む日本語のメッセージにする（M2 と同じ）。
- MML のエラーは `{ line, column, message }`（行・列は 1 から、列は文字単位、`message` は日本語）。例外にしない。
- 四分音符 = 96 ティック。音長の表：1→384、2→192、4→96、8→48、16→24、32→12、3→128、6→64、12→32、24→16、48→8。
- 既定値：`o4`、`l4`、`t120`、`@0`、`v12`、`p64`、`q8`、`B+0`。`o4` の `c` はノート番号 60。
- 音量：`v15` を 0 dB、1 段 3 dB 下げ、`v0` は無音（暫定）。
- 各タスクの終わりに `npm test` と `npx tsc --noEmit` を通す。最後に `npm run build`、`npm run check:browser` を通す。ヘッドレス Chromium は 1 つずつ動かし、終わったら `pgrep -fa 'chrome|vite'` で残りがないことを確かめる（サーバーのメモリが約 1.9 GB のため）。

## Review Focus

1. 入れ子の繰り返しで巨大に展開される MML（例：`[[[[c]255]255]255]255`）→ 固まらずにエラーになる（Task 5 のテスト）。
2. タブが裏に回るなどでタイマーが遅れる → 逃したノートをまとめて鳴らさず、送ったノートのノートオフは必ず送る（Task 8 のテスト）。
3. 先読みで送り済みのノートがあるときに停止する → ノートが鳴り続けない（Task 2・Task 8 のテスト）。
4. 再生中にもう一度「再生」を押す → 前の再生の音が残らず、最初から鳴り直す（Task 9 の手順、Task 10 のブラウザーの確認）。
5. Windows の改行（CRLF）の MML を貼る → LF と同じに読め、列番号も同じ（Task 3 のテスト）。

---

### Task 1: ボイスに音量・ピッチベンド・取り消しを足す

**Files:**
- Modify: `packages/engine/src/voice.ts`、`voice.test.ts`
- Modify: `packages/engine/src/voicePool.ts`、`voicePool.test.ts`

**Interfaces:**
- Produces（voice.ts）：

```ts
noteOn(timbre: AnyVoice, note: number, pan: number, volume?: number, bend?: number): void; // volume 既定 1（倍率）、bend 既定 0（セント）
/** FM の全オペレーターの周波数を 2^(cents/1200) 倍にする。位相は続ける。ドラムでは何もしない */
setPitchBend(cents: number): void;
/** 出力に掛ける倍率を変える（左右のパンの係数に掛ける） */
setVolume(volume: number): void;
```

ドラムの `noteOn` では `bend` を使わない（`volume` は使う）。ピッチベンドの倍率は、ドラムの音程の降下（`pitchRatio`）・ビブラートと掛け合わせる。

- Produces（voicePool.ts）：

```ts
noteOn(id: number, program: number, note: number, pan: number, volume?: number, bend?: number): boolean;
setPitchBend(id: number, cents: number): void;   // 該当なしは何もしない
setVolume(id: number, volume: number): void;     // 該当なしは何もしない
/** ids の音をキーオフする（停止用）。該当なしは無視 */
cancel(ids: readonly number[]): void;
```

- [ ] **Step 1: 失敗するテストを書く**

`voice.test.ts`（既存の正弦波の音色と、上向きゼロ交差を数える作りを使う）：
- `volume 0.5 でピークが半分`：同じ音を volume 1 と 0.5 で鳴らし、ピークの比が 0.5 ± 0.01。
- `bend +1200 で周波数が 2 倍`：0.1 秒のゼロ交差数の比が 2 ± 0.05。
- `setPitchBend で鳴っている途中から高さが変わる`：0.1 秒鳴らした後に `setPitchBend(1200)`、次の 0.1 秒のゼロ交差数が前の 2 倍 ± 0.05。
- `setVolume で鳴っている途中から音量が変わる`：`setVolume(0.25)` の後のピークが前の 0.25 ± 0.01 倍。
- `ドラムは bend と setPitchBend を無視する`：ノイズのない FM のみのドラムで、bend 0 と bend 1200 の出力が一致。

`voicePool.test.ts`：
- `setPitchBend・setVolume は奪われた ID では何もしない`：17 音で id 1 を奪わせた後、`setVolume(1, 0)` しても出力が変わらない。
- `cancel はその ID の音をキーオフする`：`rr: 15` の音色で 2 音鳴らし、片方を `cancel([id])` すると数千サンプル後に `activeCount === 1`。

- [ ] **Step 2: 失敗を確かめる** — Run: `npx vitest run packages/engine/src/voice.test.ts packages/engine/src/voicePool.test.ts` → FAIL
- [ ] **Step 3: 実装する**（`increment` は元の値を保ち、`bendRatio` を別に持って `sampleFm` で掛ける。`gainLeft/Right` はパンの係数 × volume で作り直す）
- [ ] **Step 4: `npm test && npx tsc --noEmit`** → PASS
- [ ] **Step 5: コミット** — `feat: ボイスにノートごとの音量・ピッチベンドと、ID 指定のキーオフを追加`

---

### Task 2: メッセージ・processor・FmEngine に音量・ピッチベンド・取り消しを通す

**Files:**
- Modify: `packages/engine/src/eventQueue.ts`、`eventQueue.test.ts`
- Modify: `packages/engine/src/messages.ts`、`processor.ts`、`index.ts`、`index.test.ts`

**Interfaces:**
- Consumes: Task 1 の `VoicePool` の各関数。
- Produces（eventQueue.ts）：`removeWhere(predicate: (event: E) => boolean): void` — まだ取り出していないイベントのうち、合うものを捨てる。
- Produces（messages.ts の `EngineMessage` に足す・変える）：

```ts
| { type: 'noteOn'; id: number; program: number; note: number; pan: number; volume: number; bend: number; time: number }
| { type: 'setPitchBend'; id: number; cents: number; time: number }
| { type: 'setVolume'; id: number; volume: number; time: number }
| { type: 'cancel'; ids: number[] }   // 時刻を持たず、受け取ったらすぐ処理する
```

processor：`setPitchBend`・`setVolume` は `noteOn` と同じく待ち行列に入れて時刻に処理する。`cancel` は受け取った時点で、待ち行列から `id` が `ids` に入る `noteOn`・`noteOff`・`setPitchBend`・`setVolume` を `removeWhere` で捨て、`pool.cancel(ids)` を呼ぶ。

- Produces（index.ts の `FmEngine`。この形が Task 8 の `EngineLike` を満たす）：

```ts
noteOn(program: number, note: number, options?: { pan?: number; time?: number; volume?: number; bend?: number }): number; // volume 既定 1、bend 既定 0
setPitchBend(id: number, cents: number, time?: number): void;
setVolume(id: number, volume: number, time?: number): void;
/** ids の、まだ処理していないイベントを捨て、鳴っていればキーオフする */
cancel(ids: readonly number[]): void;
```

検査：`volume` は 0〜1 の有限の数、`bend`・`cents` は −1200〜1200 の有限の数、`id` は整数、`time` は有限。外れたら `RangeError`。`time` は M2 と同じく丸めて送る。

- [ ] **Step 1: 失敗するテストを書く**
- `eventQueue.test.ts`：`removeWhere` で合うものだけが消え、残りの順番が保たれる。
- `index.test.ts`：M2 の `noteOn` の期待値に `volume: 1, bend: 0` を足す。`noteOn(0, 60, { volume: 0.5, bend: -100, time: 10 })` がその値を送る。`setPitchBend(3, 50, 100)`・`setVolume(3, 0.25, 100)`・`cancel([1, 2])` のメッセージ。`volume: 1.5`、`bend: 1201`、`setPitchBend(1.5, 0)` で `RangeError`。

- [ ] **Step 2: 失敗を確かめる** → FAIL
- [ ] **Step 3: 実装する**
- [ ] **Step 4: `npm test && npx tsc --noEmit`** → PASS
- [ ] **Step 5: コミット** — `feat: 音源 API にノートごとの音量・ピッチベンドと、予約の取り消しを追加`

---

### Task 3: sequencer のパッケージと、トラックの分割・音符・休符・音長・オクターブ

**Files:**
- Create: `packages/sequencer/package.json`（`"name": "@mml-fm-audio/sequencer"`、engine と同じ形で `"exports": { ".": "./src/index.ts" }`）
- Create: `packages/sequencer/src/song.ts`、`source.ts`、`parser.ts`、`index.ts`、`parser.test.ts`
- Modify: `package-lock.json`（`npm install` を実行して workspace のリンクを作る。外部の依存は足さない）

**Interfaces:**
- Produces（song.ts。以降のタスクはこの型を使う）：

```ts
export const TICKS_PER_QUARTER = 96;
export const DRUM_PROGRAMS = { bd: 128, sd: 129, ch: 130, oh: 131, cy: 132, lt: 133, ht: 134, cp: 135 } as const;
export interface MmlError { line: number; column: number; message: string }
export type TrackEvent =
  /** gate はノートオンからノートオフまでのティック。volume は v の値（0〜15） */
  | { type: 'note'; tick: number; gate: number; program: number; note: number; volume: number; pan: number; bend: number }
  | { type: 'bend'; tick: number; cents: number }
  | { type: 'volume'; tick: number; volume: number };
export interface Track { name: string; events: TrackEvent[]; length: number } // events は tick の順、length はティック
export interface Tempo { tick: number; bpm: number }
export interface Song {
  tracks: Track[];        // MML に初めて出た順
  tempos: Tempo[];        // tick の順。先頭は必ず tick 0
  length: number;         // いちばん長いトラックの長さ
  loopStart: number | null;
  loopEnd: number;        // E の位置。E がなければ length
  errors: MmlError[];     // 行・列の順
}
```

- Produces（source.ts）：

```ts
export interface TrackSource { name: string; text: string; positions: Array<{ line: number; column: number }> }
/** 行をトラックごとに連結する。行の区切りは空白 1 文字として text に入れる。コメントを除く。CRLF は LF と同じ */
export function splitTracks(mml: string): { tracks: TrackSource[]; errors: MmlError[] };
```

`positions[i]` は `text[i]` の元の位置。トラック名は `A`〜`P`、`A`〜`P` に 1 以上の整数（先頭が 0 でない）、`R`。名前の後は空白か行末。名前が違う行はエラー（列 1）で、その行は捨てる。

- Produces（parser.ts、index.ts から export）：`export function parseMml(mml: string): Song`

このタスクで扱う命令：`c d e f g a b`（`+`・`-` は 1 個まで）、`r`、音長（表の数）、`%N`（1 以上）、付点（重ねてよい。ティックが整数にならなければエラー）、`oN`（0〜8）、`<` `>`、`lN`（音長と同じ数、付点可）。`note` イベントの `gate` は音長（`q` は Task 4）。ノート番号が 0〜127 を外れたらエラー。トラックの `length` は最後の音符・休符の終わり。知らない文字・範囲外・数の書き忘れはエラーで、エラーの列はその命令の先頭の文字。エラーの後は次の命令の先頭まで飛ばし、同じ命令から 2 つ目のエラーを出さない。

- [ ] **Step 1: 失敗するテストを書く**（`parser.test.ts`。以降のタスクも同じファイルに足す）
- `A c d e` → `note` が 60, 62, 64、tick 0, 96, 192、gate 96、program 0、volume 12、pan 64、bend 0。`length` 288。
- `A o5 c+8 d-16. r4 >c <c` → note が 73（tick 0、gate 48）、73（tick 48、gate 36）、84（tick 180）、72（tick 276）。休符は tick 84〜180。
- `A l8. c` の gate 72、`A c4.. c%36 c%36.` の gate 168・36・54、`A c3 c48` の gate 128・8。
- 音長の表の全数（1, 2, 4, 8, 16, 32, 3, 6, 12, 24, 48）のティック。
- エラー：`A c5` は「1 行 3 列」、`A o9` は 1 行 3 列、`A o0 c-` はノート番号 11 で通る、`A o0 <` はエラー、`A c48.` は通る（12）、`A c32...` は 12+6+3+1.5 が整数でなくエラー、`A x` は 1 行 3 列、`Q c` と `a c` と `A0 c` は 1 行 1 列、`A c 4` は 1 行 5 列（`4` が命令でない）。
- `A c4 x c4 y` のエラーは 2 つだけ。
- 複数行：`A c\nB d\nA e` で A が c, e（e の tick 96）、B が d。トラックの順は A, B。
- `;` 以降を無視する。空行・コメント行を無視する。
- CRLF：`A c\r\nA x` と `A c\nA x` で、エラーの行・列が同じ（2 行 3 列）。
- `parseMml('')` は tracks が空、`length` 0、`tempos` は `[{ tick: 0, bpm: 120 }]`、`loopStart` null、errors 空。

- [ ] **Step 2: 失敗を確かめる** — Run: `npx vitest run packages/sequencer` → FAIL
- [ ] **Step 3: 実装する**（手書きの再帰下降でよい。`[ ]` の繰り返しで同じ位置を読み直す作りにしておくと Task 5 が楽）
- [ ] **Step 4: `npm install && npm test && npx tsc --noEmit`** → PASS（`node_modules/@mml-fm-audio/sequencer` のリンクができていること）
- [ ] **Step 5: コミット** — `feat: sequencer パッケージに MML の音符・休符・音長・オクターブの解析を追加`

---

### Task 4: `@ v p q B t` とタイ

**Files:**
- Modify: `packages/sequencer/src/parser.ts`、`parser.test.ts`

**Interfaces:**
- Consumes: Task 3 の型。
- 決まり（設計書 §3.3・§3.5〜§3.8）：
  - `@N` 0〜127、`vN` 0〜15、`pN` 0〜127、`qN` 1〜8、`tN` 1〜999（小数可。`t132.5`）、`B±N` −1200〜1200（符号は必須）。
  - `v`・`B` は、書いた位置の tick で `volume`・`bend` イベントを出し、以降のノートの値も変える。`@`・`p`・`q` はイベントを出さず、以降のノートの値を変える。
  - `q`：`gate = max(1, floor(音長 × N / 8))`。タイでつないだノートは、つないだ全体の長さに掛ける。
  - タイ `&`：前のノートの長さに次の音符の長さを足し、新しい `note` イベントを出さない。前後のノート番号が違えばエラー（列は後ろの音符）。`&` と次の音符の間に書けるのは `B`・`v` だけ（ほかはエラー）。`&` の後に音符がない（トラックの終わり・休符など）ときは `&` の位置でエラー。行をまたいでよい。
  - テンポ：`t` はそのトラックのその tick にテンポを置く。全トラックを集めて `tempos` を作る。同じトラックの同じ tick では後の値。違うトラックで同じ tick に違う値ならエラー（後に出たほうの位置）。tick 0 にテンポがなければ `{ tick: 0, bpm: 120 }` を先頭に入れる。

- [ ] **Step 1: 失敗するテストを書く**
- `A @80 v10 p32 c` の note が program 80・volume 10・pan 32。
- `A q6 c4 q8 c4` の gate 72・96。`A q1 c%4` の gate 1（切り捨てで 0 になるのを 1 にする）。
- `A c4&c16` → note 1 つ、gate 120。`A q4 c4&c4` → gate 96。
- `A c8&B+50c8&v8c8 c` → 最初の note は gate 144、tick 48 に `bend +50`、tick 96 に `volume 8`。2 つ目の note（tick 144）の bend は 50、volume 8。
- 複数行のタイ：`A c4&\nA c4` → note 1 つ、gate 192。
- エラー：`A c4&d4`（1 行 6 列）、`A c4&r4`、`A c4&`、`A c4&o5c4`、`A B50`、`A B+1201`、`A v16`、`A q0`、`A t0`、`A t1000`、`A @128`、`A v`（数の書き忘れ）。
- テンポ：`A t140 c4 t90 c4` の tempos が `[{0,140},{96,90}]`。`A c4 t90` で `[{0,120},{96,90}]`。`A t130\nB t140` はエラー、`A t130\nB t130` は通る。
- `A c B+100 r4 c`：`bend` イベントは tick 96、2 つ目の note の bend は 100。

- [ ] **Step 2: 失敗を確かめる** → FAIL
- [ ] **Step 3: 実装する**
- [ ] **Step 4: `npm test && npx tsc --noEmit`** → PASS
- [ ] **Step 5: コミット** — `feat: MML の音色・音量・パン・ゲートタイム・ピッチベンド・テンポとタイを解析する`

---

### Task 5: 繰り返し `[ ]N` と、ループ `L`・`E`

**Files:**
- Modify: `packages/sequencer/src/parser.ts`、`parser.test.ts`

**Interfaces:**
- Consumes: Task 3・4。
- 決まり（設計書 §3.3・§3.9）：
  - `[ ... ]N`：N は 1〜255、省けない。入れ子可。中の命令の状態の変化（`o`・`v` など）は次の回に持ち越す（同じ位置を読み直す）。`]` に対応する `[` がない、`[` が閉じていない（`[` の位置）はエラー。`[ ]` をまたぐタイ（`[c4&]2`）はエラー。中のエラーは 1 回だけ報告する。
  - 展開の上限：1 トラックの `events` が 100,000 を超えたら、その `[` の位置でエラーにして読むのをやめる（Review Focus 1。私の判断）。
  - `L`・`E`：曲全体で各 1 つまで（2 つ目の位置でエラー）。`[ ]` の中はエラー。`loopStart` は `L` の tick。`E` は `L` がない曲、`L` より前（同じ tick を含む）ではエラー。`loopEnd` は `E` の tick、なければ `length`。`L` があり `loopStart === loopEnd` ならエラー（`L` の位置）。
  - `E` より後：どのトラックでも、tick が `loopEnd` 以上の位置での音符（タイの続きを除く）・`B`・`v`・`t` と、`@ p q o < > l` の命令はエラー。休符とタイの続きの音符は書ける。`E` がない曲ではこの検査をしない。`E` は別のトラックに書かれうるので、全トラックを読んだ後に検査する（各命令の tick と位置を覚えておく）。
  - `length`：全トラックの `length` の最大。

- [ ] **Step 1: 失敗するテストを書く**
- `A [cd]2 e` → c d c d e。`A [[c]2 d]2` → c c d c c d。`A [o5 c]2` → 2 つ目の c が 84（オクターブを持ち越す）。
- エラー：`A [cd]`（1 行 6 列）、`A [cd]0`、`A [cd]256`、`A cd]2`、`A [cd`（1 行 3 列）、`A [c4&]2`、`A [c x]3` のエラーは 1 つ。
- `A [[[[c]255]255]255]255` がエラー 1 つで、テストが 1 秒以内に終わる。
- `A c L d e` → loopStart 96、loopEnd 288。`A L c`→ loopStart 0。`A c d` → loopStart null、loopEnd 192。
- `A c L d E e` はエラー（`e` は E の後のノートオン）。`A c L d E r4` は通り、loopEnd 192、length 288。
- ループ終了を越えるノート：`B L c2 c2 E\nA r2 r4 r8 e8&e4` → loopStart 0、loopEnd 384、A の note の tick 336・gate 144、length 480、エラーなし。
- `A L c2 c4 r8 e8&E e4` はエラー（`&` と次の音符の間に `E`）。
- `A L c c E\nB c d v10` は `v10` がエラー（tick 192 ≥ loopEnd 192）。`A L c c E\nB c d r4` は通る。
- `A c L L d`、`A c E`（L がない）、`A c E L d`、`A L E c`（L より前ではないが同じ tick）、`A [L c]2`、`A c L`（長さ 0）がエラー。
- `A L c\nB d e f` → loopEnd = length = 288（違う長さのトラック）。

- [ ] **Step 2: 失敗を確かめる** → FAIL
- [ ] **Step 3: 実装する**
- [ ] **Step 4: `npm test && npx tsc --noEmit`** → PASS
- [ ] **Step 5: コミット** — `feat: MML の繰り返しとループ（L・E）を解析する`

---

### Task 6: ドラムトラック `R`

**Files:**
- Modify: `packages/sequencer/src/parser.ts`、`parser.test.ts`
- Modify: `demo/rhythm.ts`（自前の `DRUM_PROGRAMS` を消し、`@mml-fm-audio/sequencer` から import する）

**Interfaces:**
- Consumes: Task 3 の `DRUM_PROGRAMS`。
- 決まり（設計書 §3.4）：`R` ではドラム名（2 文字）を 1 文字の命令より先に照合する。ドラム名は `note` イベントになり、program は `DRUM_PROGRAMS`、note は 60、bend は 0、volume・pan はその時点の値。使える命令は `r l % . v p q t [ ] L E`。音符・`o < > @ & B` はエラー。`R` の `v` は `volume` イベントを出さない（次のドラムから効く）。

- [ ] **Step 1: 失敗するテストを書く**
- `R bd8 sd8 lt cp ch oh cy ht` の program 128, 129, 133, 135, 130, 131, 132, 134 と tick。
- `R l8 [bd ch]2 v8 sd` の volume（最後が 8）と `volume` イベントがないこと。
- エラー：`R c`、`R b`、`R bd&bd`、`R @1 bd`、`R o5 bd`、`R B+10 bd`。
- `R L bd E` と `A L c E` が同じに解析できる（`L`・`E` は R に書ける）。
- `demo/rhythm.test.ts` が今のまま通る。

- [ ] **Step 2: 失敗を確かめる** → FAIL
- [ ] **Step 3: 実装する**
- [ ] **Step 4: `npm test && npx tsc --noEmit`** → PASS
- [ ] **Step 5: コミット** — `feat: MML のドラムトラック（R）を解析する`

---

### Task 7: ティックから秒へ（Timeline）

**Files:**
- Create: `packages/sequencer/src/timing.ts`、`timing.test.ts`
- Modify: `packages/sequencer/src/index.ts`（export）

**Interfaces:**
- Consumes: Task 3 の `Tempo`、`Song`。
- Produces：

```ts
/** 曲の頭（tick 0）から tick までの秒。テンポの区切りごとに足し、丸めない */
export function tickToSeconds(tempos: readonly Tempo[], tick: number): number;
export class Timeline {
  constructor(song: Pick<Song, 'tempos' | 'loopStart' | 'loopEnd'>);
  /**
   * pass 回目（0 から）の tick の、再生開始からの秒。pass 0 は tick 0 から、pass 1 以降は loopStart から始まる。
   * ループする曲で tick ≥ loopEnd なら、次の回の loopStart + (tick − loopEnd) として計算する（ループ終了を越えるノートのノートオフ用）
   */
  seconds(pass: number, tick: number): number;
}
```

`seconds(k, t)`（k ≥ 1、loopStart ≤ t < loopEnd）＝ `tickToSeconds(loopEnd) + (k − 1) × (tickToSeconds(loopEnd) − tickToSeconds(loopStart)) + tickToSeconds(t) − tickToSeconds(loopStart)`。pass 0 は `tickToSeconds(t)`。ループしない曲では `pass` は 0 だけ。

- [ ] **Step 1: 失敗するテストを書く**
- `tickToSeconds([{0,120}], 96)` が 0.5。`[{0,120},{192,60}]` で 384 が 1 + 2 = 3。
- `L` 96・`E` 288・t120 の曲：`seconds(0, 0)` 0、`seconds(0, 288)` = `seconds(1, 96)` = 1.5、`seconds(1, 192)` 2、`seconds(2, 96)` 2.5。
- ループ終了を越える tick：`seconds(0, 336)`（loopEnd + 48）が `seconds(1, 144)` と同じ 1.75。
- テンポの戻り：tick 0 で t120、tick 192 で t60、L 96、E 288 の曲で、`seconds(1, 96)` から `seconds(1, 192)` までが 0.5 秒（L の位置のテンポ 120 で進む）。
- 1000 回目のループでも誤差が 1e-9 秒未満（各回を足し上げず式で求める）。

- [ ] **Step 2: 失敗を確かめる** → FAIL
- [ ] **Step 3: 実装する**
- [ ] **Step 4: `npm test && npx tsc --noEmit`** → PASS
- [ ] **Step 5: コミット** — `feat: テンポとループを考慮してティックを秒に直す Timeline を追加`

---

### Task 8: 先読みして音源へ送る再生器（Player）

**Files:**
- Create: `packages/sequencer/src/player.ts`、`player.test.ts`
- Modify: `packages/sequencer/src/index.ts`（export）

**Interfaces:**
- Consumes: Task 3 の `Song`、Task 7 の `Timeline`。Task 2 の `FmEngine` はこの `EngineLike` を満たす（型は sequencer 側で定義し、engine を import しない）。
- Produces：

```ts
export interface EngineLike {
  noteOn(program: number, note: number, options: { pan: number; time: number; volume: number; bend: number }): number;
  noteOff(id: number, time: number): void;
  setPitchBend(id: number, cents: number, time: number): void;
  setVolume(id: number, volume: number, time: number): void;
  cancel(ids: readonly number[]): void;
}
export const VOLUME_DB_PER_STEP = 3; // 暫定
/** v（0〜15）→ 倍率。15 で 1、0 で 0 */
export function volumeGain(v: number): number;
export interface PlayerOptions { sampleRate: number; startFrame: number } // startFrame は曲の頭のサンプル番号
export class Player {
  /** song.errors があれば Error を投げる */
  constructor(engine: EngineLike, song: Song, options: PlayerOptions);
  /** 時刻が horizonFrame より前のイベントを送る。nowFrame より前のノートオンは送らずに捨てる */
  pump(nowFrame: number, horizonFrame: number): void;
  /** 送ったノートのうち、ノートオフの時刻が過ぎていないものを cancel し、以後は何も送らない */
  stop(): void;
  /** ループしない曲で、最後のノートオフまで送り終えたら true */
  get finished(): boolean;
}
```

決まり：
- サンプル時刻 ＝ `startFrame + timeline.seconds(pass, tick) × sampleRate`（丸めは音源側）。
- ノートオフの時刻は `seconds(pass, tick + gate)`（ループ終了を越えるノートは次の回の位置になる）。
- ループする曲は、pass 0 の `[0, loopEnd)`、pass 1 以降の `[loopStart, loopEnd)` のイベントを順に送る。`tick < loopStart` のノートは pass 1 以降では送らない（`L` の前から持続中のノートを鳴らし直さない）。ループしない曲は pass 0 の全イベント。
- `bend`・`volume` イベントは、同じトラックで最後にノートオンしたノートの ID へ `setPitchBend`・`setVolume`（`volumeGain` で倍率に直す）。そのノートがなければ何もしない。各回の始めで「最後のノート」を忘れる（ループ終了を越えて持続中のノートには送らない）。
- 同じサンプル時刻のイベントは、ノートオフ → `setPitchBend`・`setVolume` → ノートオンの順。同じ種類の中はトラックの順。
- 遅れ（Review Focus 2）：ノートオンの時刻が `nowFrame` より前なら送らず、そのノートのノートオフ・`bend`・`volume` も送らない。送ったノートのノートオフは、時刻が過ぎていても送る（音源は過去の時刻をブロックの頭で処理する）。

- [ ] **Step 1: 失敗するテストを書く**（呼び出しを記録する偽の `EngineLike`。48000 Hz、t120 で 96 ティック ＝ 24000 サンプル）
- `A c d` を startFrame 1000 で `pump(0, 1e9)`：noteOn が 1000 と 25000、noteOff が 25000 と 49000、`volume` は `volumeGain(12)`、同じ時刻 25000 では noteOff が noteOn より先。その後 `finished` が true。
- `volumeGain(15)` 1、`volumeGain(0)` 0、`volumeGain(13) / volumeGain(14)` が 10^(−3/20)。
- 先読み：`pump(0, 24000)` では c のノートオンだけが送られ、続けて `pump(24000, 48000)` で残りが送られる（重複しない）。
- ループ：`A c L d e` の 3 回分（`pump(0, 6 * 24000)`）で、ノートオンの音が c d e d e d…、時刻が 0, 24000, 48000, 72000, 96000…。
- `L` の前から持続中のノート：`A c1\nB r4 L d4 e2`（loopStart 96、loopEnd 384）で、2 回目以降は A の c が送られず、B の d・e は送られる。
- ループ終了を越えるノート：`B L c2 c2 E\nA r2 r4 r8 e8&e4` の A の e は、1 回目のノートオンが `seconds(0, 336)`、ノートオフが `seconds(1, 96)`。
- 各回の始めで最後のノートを忘れる：`B L c2 c2 E\nA r4 B+100 r4 r4 r8 e8&e4` を 3 回分送っても `setPitchBend` は 1 度も呼ばれない（2 回目以降の tick 96 の `B+100` は、越えてきた e に送らない）。
- `A c8&B+50c8`：`setPitchBend(id, 50, 12000)` が c の ID に送られる。
- 遅れ：`A c d e` で `pump(30000, 60000)` を最初に呼ぶと、c（0）と d（24000）は送られず e（48000）だけが送られ、c・d のノートオフも送られない。
- 停止：`A c1` を `pump(0, 1000)` してから `stop()` すると `cancel([その ID])`、その後の `pump` は何も送らない。
- エラーのある曲で Error。

- [ ] **Step 2: 失敗を確かめる** → FAIL
- [ ] **Step 3: 実装する**（全回分を先に作らず、送るたびに次の回のイベントを作る。ノートオフ・`bend` などは時刻順の待ち行列に入れてよい）
- [ ] **Step 4: `npm test && npx tsc --noEmit`** → PASS
- [ ] **Step 5: コミット** — `feat: 曲を先読みして音源へ送る Player を追加`

---

### Task 9: 試聴ページに MML の欄と手書きの曲を足す

**Files:**
- Create: `demo/songs/m3-demo.mml`、`demo/songs.test.ts`
- Modify: `demo/main.ts`、`demo/index.html`、`demo/style.css`

**Interfaces:**
- Consumes: Task 2 の `FmEngine`、Task 3〜8 の `parseMml`・`Player`。
- 画面（設計書 §5.1）：
  - 「MML」の見出しの下に、`textarea#mml`（最初は `m3-demo.mml` の中身。`import song from './songs/m3-demo.mml?raw'`）、`button#mml-play`「再生」、`button#mml-stop`「停止」、`ul#mml-errors`（`行 N・列 M：理由`）、曲の説明の文。
  - 再生：解析し、エラーがあれば一覧に出して鳴らさない。なければ、鳴っている再生器があれば `stop()` してから、新しい `Player` を startFrame ＝ 今 + 0.05 秒で作り、`setInterval`（25 ms）で `pump(now, now + 0.1 秒)` を呼ぶ。`finished` になったらタイマーを止める。
  - 停止：`stop()` してタイマーを止める。
  - 起動時に `gm.json` の音色を各 `id` に登録する（ドラムは M2 のまま 128〜135）。登録されていない `@N` の音源の警告は、M2 の `#warnings` にそのまま出る。
  - 鍵盤と 16 音ボタンの番号 `KEYBOARD_PROGRAM` を 0 から 127 に変える（同梱の GM 音色に 127 番はなく、MML の `@0` とぶつからない）。
  - 鍵盤の入力欄の `keydown` は、すでに `textarea` を除外している（MML を打っても鍵盤が鳴らない）ことを確かめる。
- 曲（設計書 §5.2、下の内容をそのまま `demo/songs/m3-demo.mml` にする。設計者が作った新しい曲）：

```
; mml-fm-audio M3 の試聴曲（設計者の作曲）。テンポ 120、4/4 拍子、全 14 小節（約 28 秒）
; 1〜2 小節：イントロ（1 回だけ）。3 小節目の頭に L、15 小節目の頭に E（どちらも B に書いた）
; A：メロディ。2 小節目の最後の半拍から 3 小節目の 1 拍目まで、タイで行をまたぐ弱起のノート。
;    14 小節目の最後の半拍の g は E を越えて書いてあり、ループ後も 3 小節目の 1 拍目まで持続する
;    6 小節目：タイの途中の B でピッチベンド（+50 から +200 セントまで上げる）
;    10 小節目：タイの途中の v で音量を上げる
;    14 小節目：t112 でテンポを落とす（ループ後は L の位置のテンポ 120 に戻る）
; B：ベース。q6 で短く切る。[ ] の入れ子
; C1〜C3：和音（サブトラック）。p で左・中央・右に振る
; R：ドラム
A t120 @80 v11 p72 q7 o5 l8
A r1
A r2 r4 r8 g8&
A g4 e8 g8 >c4 <b8 a8
A a4. e8 a8 b8 >c4 <
A a4 f8 a8 >c8 <a8 f4
A d8 g8 b8 >d8&B+50d8&B+100d8&B+150d8&B+200d8 B+0 <
A e4 c8 e8 g4 e8 c8
A c4 <a8 >c8 e4 d8 c8
A c4. <a8 f4 a4
A >d4&v12d4&v13d4&v14d4 v11
A [e8 a8]2 b8 >c8 <b8 a8
A a8 f8 c8 f8 a4 >c4 <
A d4 f8 a8 >d4 c8 <a8
A t112 b4 g4 d4 r8 g8&g4

B @34 v13 p56 q6 o2 l8
B [f f >f <f]2 [g g >g <g]2
B L [[c c >c <c]2 [a a >a <a]2 [f f >f <f]2 [g g >g <g]2]2
B [a a >a <a]2 [f f >f <f]2 [d d >d <d]2 [g g >g <g]2 E

C1 @88 v8 p40 o4 a1 b1 [g1 a1 a1 b1]2 a1 a1 a1 b1
C2 @88 v8 p64 o4 f1 g1 [e1 e1 f1 g1]2 e1 f1 f1 g1
C3 @88 v8 p88 o4 c1 d1 [c1 c1 c1 d1]2 c1 c1 d1 d1

R v12 p64 l8 [bd ch sd ch]4
R [[bd ch sd ch bd bd sd oh]3 bd cy sd ch lt lt ht cp]3
```

- [ ] **Step 1: 失敗するテストを書く**（`demo/songs.test.ts`）
- `m3-demo.mml` がエラーなく解析でき、`loopStart` が 768（2 小節）、`loopEnd` が 5376（14 小節）、`length` が 5472（A の最後の g の残り 96 ティック）。
- トラックが A, B, C1, C2, C3, R の 6 つで、A 以外の長さが 5376。
- A に `bend` と `volume` のイベントがあり、`tempos` が `[{0,120},{4992,112}]`。

- [ ] **Step 2: 失敗を確かめる** → FAIL
- [ ] **Step 3: 曲のファイルと画面を作る**（曲の数値がテストと合わなければ、曲ではなく解析器の側を疑い、設計書 §3 と照らして原因を報告する）
- [ ] **Step 4: `npm test && npm run build`** → PASS
- [ ] **Step 5: コミット** — `feat: 試聴ページに MML の再生と手書きの曲を追加`

---

### Task 10: ブラウザーでの確認を広げ、文法の文書と正典を更新する

**Files:**
- Modify: `tools/check-browser.ts`
- Create: `docs/mml.md`
- Modify: `docs/spec.md`、`README.md`、`HANDOVER.md`

**Interfaces:**
- Consumes: Task 9 の画面の要素と `window.__mmlFmAudio`。

- [ ] **Step 1: `tools/check-browser.ts` に確認を足す**（M2 までの確認は残す）
- `#mml-play` を押し、3 秒の間 50 ms ごとに測ったピークの最大が 0.03 を超える。
- `#mml-play` をもう一度押してもページのエラーが出ず、音が出続ける（Review Focus 4）。
- `#mml-stop` を押すと、3 秒以内にピークが 0.001 未満になる。
- `#mml` を `A c4&d4` にして再生すると、`#mml-errors` に `行 1・列 6` を含む項目が出て、音が出ない。
- ページのエラーがない。

- [ ] **Step 2: `npm test && npm run build && npm run check:browser`** → すべて OK。終わったら `pgrep -fa 'chrome|vite'` で残りがないことを確かめる。

- [ ] **Step 3: 文書を書く**
- `docs/mml.md`：MML を書く人向けの文法（設計書 §3 の内容。全体・トラック名・命令の表・ドラムトラック・タイ・テンポ・`q`・`B`・ループと `E`・ループ位置をまたぐノートの書き方・エラー）。例は `m3-demo.mml` から引く。
- `docs/spec.md`：版を v0.4、日付を 2026-10-21 にする。§4 の冒頭に「詳しい文法は `docs/mml.md`」。§4.3 の表に `qN` と `E` を足し、`[ ... ]N` は N を省けないこと、`vN` と `B±N` は持続中のノートにも効くこと（タイの間に書ける）を書く。
- `README.md`：現在の状態を M3 までに。構成の表に `packages/sequencer/` と `demo/songs/`。暫定値に `VOLUME_DB_PER_STEP`（`packages/sequencer/src/player.ts`）。試聴ページで MML を再生できること。設計・計画の一覧に M3 を足す。
- `HANDOVER.md`：今の状態（M3 の実装済み・PR を出す段階）と次にやること（依頼者の確認 1〜6、設計書 §1.1）。

- [ ] **Step 4: コミット** — `docs: MML の文法の文書を追加し、M3 の状態を spec・README・HANDOVER に反映する`
