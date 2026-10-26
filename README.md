# mml-fm-audio

ankardo のブラウザゲームで使う、FM 音源と軽量楽曲フォーマット（MML）の再生ライブラリ。
製品仕様は `docs/spec.md`。

公開中の試聴ページ：https://ankardo.com/play/mml-fm-audio/

## 現在の状態

M4（ゲーム向け API、効果音、音量とフェード）まで。ゲームからは `FmAudio`（`packages/runtime`）で BGM と効果音を鳴らす。API は `docs/api.md`、MML の文法は `docs/mml.md`。

- 音源は BGM 用 16 ボイス（`packages/engine/src/voicePool.ts` の `MAX_VOICES`、暫定）と効果音用 4 ボイス（`SE_VOICES`、暫定）。別々のボイスで、効果音が BGM のボイスを借りることはない。空きがなければ、それぞれの中で、ノートオフを受けた後の音（リリース中の音など）のうち最も古くノートオフを受けたものを、なければ最も古く鳴らした音を止めて使う。
- 音色は番号（`program`）に登録して鳴らす。0〜127 は FM 音色、128〜255 はドラム。`FmEngine.noteOn` は音の ID を返し、`noteOff` はその ID で止める。ドラムは `noteOff` を無視し、鳴り終わるまで鳴る。
- 音源は、音量（`noteOn` の倍率と `setVolume`）、ピッチベンド（`noteOn` のずれと `setPitchBend`）、予約した発音の取り消しを受け付ける。
- `packages/sequencer` の `parseMml` が MML を解析し（エラーは行・列・理由つき）、`Player` が曲を少し先まで音源へ送って鳴らす。`L` から `E`（省けば曲の終わり）までを繰り返す。
- `FmAudio` は、BGM（同時に 1 曲、差し替え・停止・フェード・一時停止）、重ねて鳴らせる効果音、master・bgm・se の音量、スピーカー風フィルター（既定オフ）、`loop`・`end`・`warning` のイベントを持つ。MML にエラーがあれば鳴らさず、例外ではなく `warning` を出す。ページが裏に回ると止まり、戻ると続きから鳴る。
- ゲームのリポジトリへは `npm run export:runtime -- <コピー先>` でコピーする（`docs/api.md`）。
- 試聴ページは `FmAudio` で動く。和音、16 音の同時発音、パン、ドラム 8 種、簡易なリズム、負荷の表示（1 ブロックの処理時間）に加え、MML の欄で曲（`demo/songs/m3-demo.mml`）を書き換えて BGM・効果音として再生し、音量・フェード・一時停止を試せる。エラーは欄の下に出る。
- 設計：`docs/superpowers/specs/2026-10-11-m1-engine-design.md`、`docs/superpowers/specs/2026-10-20-m2-polyphony-design.md`、`docs/superpowers/specs/2026-10-21-m3-sequencer-design.md`、`docs/superpowers/specs/2026-10-23-m4-runtime-design.md`
- 実装計画：`docs/superpowers/plans/2026-10-11-m1-engine.md`、`docs/superpowers/plans/2026-10-20-m2-polyphony.md`、`docs/superpowers/plans/2026-10-21-m3-sequencer.md`、`docs/superpowers/plans/2026-10-23-m4-runtime.md`
- 負荷の実測記録：`docs/load-measurements.md`
- 残っている課題：`ISSUES.md`
- 作業の引き継ぎ：`HANDOVER.md`

## 構成

| パス | 内容 |
|---|---|
| `packages/engine/` | 音源。`processor.ts` が AudioWorklet、それ以外は Worklet に依存しない計算 |
| `packages/sequencer/` | MML の解析（`parseMml`）、ティックから時刻への変換、曲を音源へ送る `Player`。Worklet には依存しない |
| `packages/runtime/` | ゲーム向けの API `FmAudio`（`docs/api.md`）。`engine`・`sequencer` へは相対パスで import する |
| `voices/ymf825/` | YMF825 の音色データ（`tonedata.txt`）と、その変換結果（`gm.json`・`unassigned.json`） |
| `voices/custom/` | 独自の音色（ドラム 8 種の `drums.json`） |
| `tools/` | 音色データの変換、ヘッドレス Chromium での確認 |
| `demo/` | 試聴ページ |
| `demo/songs/` | 試聴ページが読み込む手書きの曲（`m3-demo.mml`） |

## 使い方

Node 22.18 以上が必要（`tools/` の `.ts` を Node で直接実行するため）。

| コマンド | 内容 |
|---|---|
| `npm install` | 依存を入れる |
| `npm run dev` | 試聴ページを開発サーバーで開く（`http://localhost:5173/play/mml-fm-audio/`） |
| `npm test` | Vitest |
| `npm run build` | 型検査と `out/play/mml-fm-audio/` へのビルド |
| `npm run import:ymf825` | `voices/ymf825/tonedata.txt` から `gm.json`・`unassigned.json` を作り直す |
| `npm run export:runtime -- <コピー先>` | ゲームのリポジトリへ runtime・engine・sequencer と音色をコピーする（コピー先は絶対パス。`docs/api.md`） |
| `npm run measure:player [-- 秒数]` | `Player` の 1 回の pump の重さを測る（48 kHz・25 ms ごと・先読み 0.1 秒、既定 60 秒分） |
| `npm run check:browser` | ビルドしてから、ヘッドレス Chromium で発音と、別の Vite プロジェクトへコピーした `FmAudio` の発音を確かめる（`CHROME_PATH` で Chromium の場所を指定できる） |

## 音色

- 形式は `docs/spec.md` §3.2。検証は `packages/engine/src/voiceData.ts` の `validateVoice`。
- `voices/ymf825/` は YMF825_sample（Copyright (c) 2017 Yamaha Corporation, MIT License）由来。出典とライセンス全文は `voices/LICENSE-YMF825.txt`。
- 16 音色は GM の楽器番号に割り当てた（`tools/ymf825.ts` の `GM_ASSIGNMENTS`）。Rim Shot と Castanet は当てはまる番号がないため `id: null` で `unassigned.json` に置いている。
- ドラム 8 種は独自の音色で、`voices/custom/drums.json`（番号 128〜135：bd・sd・ch・oh・cy・lt・ht・cp）。形式は `docs/spec.md` §3.4、検証は `validateDrum`。値は暫定で、M6 で調整してよい。

## 暫定値

次の値は独自に決めた暫定値で、試聴で調整してよい。

- `packages/engine/src/tables.ts`：`BO_TABLE`（bo=0 を標準の高さとする）、`DT_CENTS`、`TL_DB_PER_STEP`、`SL_DB_PER_STEP`、`MOD_INDEX`、`OUTPUT_GAIN`、`MIX_GAIN`（全ボイスの和に掛ける係数）
- `packages/engine/src/envelope.ts`：`RATE15_DB_PER_SEC`、`ATTACK_SPEEDUP`、KSR の効き方
- `packages/engine/src/output.ts`：パンの効き方（等パワー、64 を中央）
- `packages/engine/src/voicePool.ts`：`MAX_VOICES`（BGM の同時発音数）、`SE_VOICES`（効果音のボイス数）。負荷の実測を見て見直す
- `packages/runtime/src/fmAudio.ts`：スピーカー風フィルターの周波数（`SPEAKER_HIGHPASS_HZ` 300 Hz、`SPEAKER_LOWPASS_HZ` 7 kHz。M6 で調整）
- `packages/sequencer/src/player.ts`：`VOLUME_DB_PER_STEP`（`v` の 1 段の dB。3 dB、`v15` が 0 dB）

## 公開

`main` への push で GitHub Actions（`.github/workflows/deploy.yml`）がテスト・ビルドし、Cloudflare Workers（`ankardo-game-mml-fm-audio`、ルート `ankardo.com/play/mml-fm-audio/*`）へ公開する。

- `vite.config.ts` の `build.outDir` は `out/play/mml-fm-audio`（`out` 直下にすると、パス付きルートの Workers では deploy が失敗する）
- リポジトリの secrets に `CLOUDFLARE_API_TOKEN`・`CLOUDFLARE_ACCOUNT_ID`、environment に `production` が必要
