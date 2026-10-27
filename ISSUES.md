# 課題一覧

レビューや試聴で見つかり、直さずに残した課題。直す時期は依頼者と合意済み（#1〜#8 は 2026-10-20、#9 は 2026-10-21、#12 は 2026-10-27）。直したら、その行を消す。

| # | 課題 | 直す時期 | 関係するファイル |
|---|---|---|---|
| 1 | 鍵を押し直したときに小さなクリック音が出る。`noteOn` で位相と帰還をリセットする一方、エンベロープは今の減衰量から続けているため | M6（音の調整） | `packages/engine/src/voice.ts` |
| 2 | 波形表（1 周期 1024 点）を補間せずに引くため、小さな雑音（およそ −54 dB）が出る。狙いの質感でもあるので、試聴で判断する | M6 | `packages/engine/src/voice.ts`、`waveforms.ts` |
| 3 | KSR（高い音ほどエンベロープを速める）の補正が、段階ではなく連続値（ノート 60 から 24 半音ごとに +1） | M6 | `packages/engine/src/envelope.ts` |
| 6 | 末尾に `/` がない URL（`ankardo.com/play/mml-fm-audio`）では、Workers のルートに当たらずページが開けない | 必要になったら | `wrangler.toml` |
| 7 | Tab で選んだ鍵盤ボタンを Enter・Space で鳴らす操作は、ヘッドレス Chromium でだけ確かめた。Firefox と Safari では未確認 | 必要になったら | `demo/main.ts` |
| 8 | GitHub Actions で、Node.js 20 向けの actions（checkout・setup-node・wrangler-action）の非推奨表示が出る。character-tactics も同じ版に固定している | 両リポジトリでまとめて | `.github/workflows/deploy.yml` |
| 9 | ドラム 8 種が、どれもそれらしく聞こえない（依頼者の試聴、2026-10-21）。M2 では暫定の音でよいと合意済み | M6 | `voices/custom/drums.json` |
| 10 | `check:browser` の「ドラム ch が鳴る」が時々落ちる。クリックの 30 ms 後に 1 回だけ振幅を測る（`tools/check-browser.ts` 94〜96 行）ため、減衰の速いハイハットでは、ヘッドレスの遅れ次第で 0.01 を下回る。直し方は #rhythm と同じく、短い時間の最大を取る（M5 の最終レビュー、2026-10-26） | 必要になったら | `tools/check-browser.ts` |
| 12 | ドラムが 8 種しかなく、依頼者が増やしたい（2026-10-27）。変換ツールでは GM の違うノート番号が同じドラム名になり、同じ時刻に打つとベロシティの大きいほう 1 つだけが残る（49 と 57 がどちらも `cy` など）。増やすときは MML のドラム名と `DRUM_PROGRAMS`、変換の対応表（spec §6.6、`docs/conv.md`）、音色を合わせて変える。#9 と同じ時期に音を作る | M6 | `voices/custom/drums.json`、`packages/sequencer/src/song.ts`、`packages/conv/` |
