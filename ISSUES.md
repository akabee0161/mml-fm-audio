# 課題一覧

レビューや試聴で見つかり、直さずに残した課題。直す時期は依頼者と合意済み（#1〜#8 は 2026-10-20、#9 は 2026-10-21、#11 は 2026-10-23）。直したら、その行を消す。

| # | 課題 | 直す時期 | 関係するファイル |
|---|---|---|---|
| 1 | 鍵を押し直したときに小さなクリック音が出る。`noteOn` で位相と帰還をリセットする一方、エンベロープは今の減衰量から続けているため | M6（音の調整） | `packages/engine/src/voice.ts` |
| 2 | 波形表（1 周期 1024 点）を補間せずに引くため、小さな雑音（およそ −54 dB）が出る。狙いの質感でもあるので、試聴で判断する | M6 | `packages/engine/src/voice.ts`、`waveforms.ts` |
| 3 | KSR（高い音ほどエンベロープを速める）の補正が、段階ではなく連続値（ノート 60 から 24 半音ごとに +1） | M6 | `packages/engine/src/envelope.ts` |
| 5 | `operatorFrequency` と `waveValue` が範囲外の値を検査しない。今は `validateVoice` を通った音色しか渡らないので問題は起きない | M4（ゲーム向け API を作るとき） | `packages/engine/src/tables.ts`、`waveforms.ts` |
| 6 | 末尾に `/` がない URL（`ankardo.com/play/mml-fm-audio`）では、Workers のルートに当たらずページが開けない | 必要になったら | `wrangler.toml` |
| 7 | Tab で選んだ鍵盤ボタンを Enter・Space で鳴らす操作は、ヘッドレス Chromium でだけ確かめた。Firefox と Safari では未確認 | 必要になったら | `demo/main.ts` |
| 8 | GitHub Actions で、Node.js 20 向けの actions（checkout・setup-node・wrangler-action）の非推奨表示が出る。character-tactics も同じ版に固定している | 両リポジトリでまとめて | `.github/workflows/deploy.yml` |
| 9 | ドラム 8 種が、どれもそれらしく聞こえない（依頼者の試聴、2026-10-21）。M2 では暫定の音でよいと合意済み | M6 | `voices/custom/drums.json` |
| 11 | ループの各周回の頭（`generatePass`）で、`Player` がその周回のアクションをまとめて待ち行列に積み、全体を並べ直すため、1 周に 1 回メインスレッドが止まる。試聴ページと同じ条件（25 ms ごとに `pump`、先読み 0.1 秒）の実測で、`A L [[t120 c%1]200]200`（1 周 4 万ノート）は 60〜150 ms、16 トラック × 4 万ノート・`t999` は約 1.5 秒。手書きの曲の大きさでは問題にならない。#10 の修正の前からある重さ（2026-10-23、`fix/player-sent-growth` の最終レビューで実測） | M4（ゲーム向け API を作るとき） | `packages/sequencer/src/player.ts` |
