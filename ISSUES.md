# 課題一覧

M1 の実装中のレビューで見つかり、直さずに残した課題。直す時期は依頼者と合意済み（2026-10-20）。直したら、その行を消す。

| # | 課題 | 直す時期 | 関係するファイル |
|---|---|---|---|
| 1 | 鍵を押し直したときに小さなクリック音が出る。`noteOn` で位相と帰還をリセットする一方、エンベロープは今の減衰量から続けているため | M6（音の調整） | `packages/engine/src/voice.ts` |
| 2 | 波形表（1 周期 1024 点）を補間せずに引くため、小さな雑音（およそ −54 dB）が出る。狙いの質感でもあるので、試聴で判断する | M6 | `packages/engine/src/voice.ts`、`waveforms.ts` |
| 3 | KSR（高い音ほどエンベロープを速める）の補正が、段階ではなく連続値（ノート 60 から 24 半音ごとに +1） | M6 | `packages/engine/src/envelope.ts` |
| 4 | 結線ごとの出力を確かめるテストが 8 種のうち alg 0/4/5 だけ。残り（1/2/3/6/7）は、レビューで結線表と手で照合しただけ | M2（同時発音でエンジンを触るとき） | `packages/engine/src/voice.test.ts` |
| 5 | `operatorFrequency` と `waveValue` が範囲外の値を検査しない。今は `validateVoice` を通った音色しか渡らないので問題は起きない | M4（ゲーム向け API を作るとき） | `packages/engine/src/tables.ts`、`waveforms.ts` |
| 6 | 末尾に `/` がない URL（`ankardo.com/play/mml-fm-audio`）では、Workers のルートに当たらずページが開けない | 必要になったら | `wrangler.toml` |
| 7 | Tab で選んだ鍵盤ボタンを Enter・Space で鳴らす操作は、ヘッドレス Chromium でだけ確かめた。Firefox と Safari では未確認 | 必要になったら | `demo/main.ts` |
| 8 | GitHub Actions で、Node.js 20 向けの actions（checkout・setup-node・wrangler-action）の非推奨表示が出る。character-tactics も同じ版に固定している | 両リポジトリでまとめて | `.github/workflows/deploy.yml` |
