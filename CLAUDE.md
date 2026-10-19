# mml-fm-audio の作業上の決まり

- 製品仕様は `docs/spec.md`。今の状態・使い方の正典は `README.md` とこのファイル。`docs/superpowers/` は作成時点のログで、後から更新しない。
- マイルストーン（`docs/spec.md` §7）ごとに、設計 → 計画 → 実装を 1 回ずつ回す。
- 権利面（`docs/spec.md` §8）：
  - 参照してよいのは、公開仕様、ライセンスが明示された公開コードとデータ、耳による比較だけ。リークされたソースや DLL・ファームウェアの解析結果は参照しない。
  - 製品名・商標（YAMAHA、MA-3、SMAF、YMF825 など）を、ライブラリ名・API 名・宣伝文句に使わない。説明文で事実として言及するのは可。
- `voices/ymf825/*.json` は `npm run import:ymf825` の生成物。手で編集しない。独自の音色は `voices/custom/` に分けて置く。
- `packages/engine/src/voiceData.ts` は `tools/` から Node で直接読むため、他のファイルを import しない。`tools/` の import は拡張子 `.ts` つきで書く。
- 音の計算は Worklet に依存しない形で書き、Vitest で確かめる。`processor.ts` は薄く保つ。
- 完了を報告する前に `npm test`、`npm run build`、`npm run check:browser` を通す。
