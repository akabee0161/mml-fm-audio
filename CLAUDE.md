# mml-fm-audio の作業上の決まり

- 製品仕様は `docs/spec.md`。今の状態・使い方の正典は `README.md` とこのファイル。`docs/superpowers/` は作成時点のログで、後から更新しない。
- マイルストーン（`docs/spec.md` §7）ごとに、設計 → 計画 → 実装を 1 回ずつ回す。
- 権利面（`docs/spec.md` §8）：
  - 参照してよいのは、公開仕様、ライセンスが明示された公開コードとデータ、耳による比較だけ。リークされたソースや DLL・ファームウェアの解析結果は参照しない。
  - 製品名・商標（YAMAHA、MA-3、SMAF、YMF825 など）を、ライブラリ名・API 名・宣伝文句に使わない。説明文で事実として言及するのは可。
- `voices/ymf825/*.json` は `npm run import:ymf825` の生成物。手で編集しない。独自の音色は `voices/custom/` に分けて置く。
- `packages/engine/src/voiceData.ts` は `tools/` から Node で直接読むため、他のファイルを import しない。`tools/` の import は拡張子 `.ts` つきで書く。
- 音の計算は Worklet に依存しない形で書き、Vitest で確かめる。`processor.ts` は薄く保つ。
- `packages/runtime` から `engine`・`sequencer` へは相対パスで import する（`@mml-fm-audio/*` を使わない）。ゲームへコピーしたとき、裸の import が解決できないため。
- パーサーと `Player` を触るときは、`npm run measure:player` で 1 回の pump の最大時間を見る。病的な入力で重くならないことを確かめる。
- 想定外の MML（手書きの曲や変換ツールの出力では出ない、極端な入力）への対策は、過剰に扱わない。課題として挙げるのはよいが、普通の曲で実害がなければ、簡単な上限のエラーで止めるか、`ISSUES.md` に書く程度にとどめる。凝った対策や、その検証に大きな手間をかけない（依頼者の方針、2026-10-25）。
- 完了を報告する前に `npm test`、`npm run build`、`npm run check:browser` を通す。
