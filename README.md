# mml-fm-audio

ankardo のブラウザゲームで使う、FM 音源と軽量楽曲フォーマット（MML）の再生ライブラリ。
製品仕様は `docs/spec.md`。

公開中の試聴ページ：https://ankardo.com/play/mml-fm-audio/

## 現在の状態

M1（4 オペレーター FM を 1 音、AudioWorklet で鳴らす）まで。同時発音・MML・ゲーム向け API はまだない。

- 設計：`docs/superpowers/specs/2026-10-11-m1-engine-design.md`
- 実装計画：`docs/superpowers/plans/2026-10-11-m1-engine.md`

## 構成

| パス | 内容 |
|---|---|
| `packages/engine/` | 音源。`processor.ts` が AudioWorklet、それ以外は Worklet に依存しない計算 |
| `voices/ymf825/` | YMF825 の音色データ（`tonedata.txt`）と、その変換結果（`gm.json`・`unassigned.json`） |
| `tools/` | 音色データの変換、ヘッドレス Chromium での確認 |
| `demo/` | 試聴ページ |

## 使い方

Node 22.18 以上が必要（`tools/` の `.ts` を Node で直接実行するため）。

| コマンド | 内容 |
|---|---|
| `npm install` | 依存を入れる |
| `npm run dev` | 試聴ページを開発サーバーで開く（`http://localhost:5173/play/mml-fm-audio/`） |
| `npm test` | Vitest |
| `npm run build` | 型検査と `out/play/mml-fm-audio/` へのビルド |
| `npm run import:ymf825` | `voices/ymf825/tonedata.txt` から `gm.json`・`unassigned.json` を作り直す |
| `npm run check:browser` | ビルドしてから、ヘッドレス Chromium で発音を確かめる（`CHROME_PATH` で Chromium の場所を指定できる） |

## 音色

- 形式は `docs/spec.md` §3.2。検証は `packages/engine/src/voiceData.ts` の `validateVoice`。
- `voices/ymf825/` は YMF825_sample（Copyright (c) 2017 Yamaha Corporation, MIT License）由来。出典とライセンス全文は `voices/LICENSE-YMF825.txt`。
- 16 音色は GM の楽器番号に割り当てた（`tools/ymf825.ts` の `GM_ASSIGNMENTS`）。Rim Shot と Castanet は当てはまる番号がないため `id: null` で `unassigned.json` に置いている。

## 暫定値

次の値は独自に決めた暫定値で、試聴で調整してよい。

- `packages/engine/src/tables.ts`：`BO_TABLE`（bo=0 を標準の高さとする）、`DT_CENTS`、`TL_DB_PER_STEP`、`SL_DB_PER_STEP`、`MOD_INDEX`、`OUTPUT_GAIN`
- `packages/engine/src/envelope.ts`：`RATE15_DB_PER_SEC`、`ATTACK_SPEEDUP`、KSR の効き方

## 公開

`main` への push で GitHub Actions（`.github/workflows/deploy.yml`）がテスト・ビルドし、Cloudflare Workers（`ankardo-game-mml-fm-audio`、ルート `ankardo.com/play/mml-fm-audio/*`）へ公開する。

- `vite.config.ts` の `build.outDir` は `out/play/mml-fm-audio`（`out` 直下にすると、パス付きルートの Workers では deploy が失敗する）
- リポジトリの secrets に `CLOUDFLARE_API_TOKEN`・`CLOUDFLARE_ACCOUNT_ID`、environment に `production` が必要
