# 引き継ぎ（2026-10-20）

次のセッションが作業を再開するためのメモ。今の状態・使い方の正典は `README.md` と `CLAUDE.md`、課題は `ISSUES.md`。

## 今の状態

- M1（4 オペレーター FM を 1 音）は完了。PR #1 でマージ済み（7335c25）、https://ankardo.com/play/mml-fm-audio/ に公開済み、依頼者が試聴済み。
- M2（16 音同時発音、ステレオ、ノイズ、ドラム 8 種、負荷の計測）は、ブランチ `feat/m2-polyphony` で実装済み。PR はまだ出していない。
  - 設計：`docs/superpowers/specs/2026-10-20-m2-polyphony-design.md`
  - 計画：`docs/superpowers/plans/2026-10-20-m2-polyphony.md`
  - 実装は依頼者の指示で、サブエージェントを使わずにメインのセッションが行った。
  - `ISSUES.md` の #4（結線ごとの出力テスト）は M2 で直し、行を消した。
- 公開は `main` への push で GitHub Actions が行う。secrets（`CLOUDFLARE_API_TOKEN`・`CLOUDFLARE_ACCOUNT_ID`）は依頼者が設定済み。environment `production` は、初回のデプロイで自動作成された。
- 直さずに残した課題は `ISSUES.md` にある。直す時期は依頼者と合意済み。

## 次にやること

M2 は、依頼者と決めた次の順で終える（設計書 §6）。

1. PR を出す → 依頼者が CodeRabbit のレビューを始める → 指摘に対応 → マージ（公開される）。
2. 依頼者が公開ページで、設計書 §1.1 の確認 1〜7 を行う。負荷は PC・Google Pixel 7a・iPhone SE（世代はそのとき聞く）で測り、数字を受け取る。
3. 受け取った数字を `docs/load-measurements.md` に記録し、`docs/spec.md` §9 の未決事項 4 に記録の置き場を書き足す（判断はしない：依頼者の決定）。記録を他の修正（確認 4 で直すドラムなど）と一緒に push するときは、その PR に含める。
4. 確認 4 で「それらしくない」と言われたドラムは、M2 で直すか M6 に回すかを依頼者に聞く。

参考：サーバーのヘッドレス Chromium（2026-10-20）では、16 音同時で 1 ブロック 2.902 ms に対して平均 0.8〜1.0 ms（約 28〜33 %）だった。Worklet で `performance.now()` が使えず、`Date.now()` の平均だけになった。

## 依頼者と決めた進め方

- マイルストーンごとに、設計 → 計画 → 実装を 1 回ずつ回す。
  - 設計：superpowers の brainstorming。設計書は `docs/superpowers/specs/` に置く。
  - 計画：writing-plans。計画は `docs/superpowers/plans/` に置く。
  - 実装：subagent-driven-development。
- 実装は Sonnet のサブエージェント、タスクごとのレビューも Sonnet、ブランチ全体の最終レビューは Opus。
- 依頼者が「Task N が終わったら止めて」と言ったら、そこで実際に止まる。
- GitHub の操作、push、マージ、公開などの外部への操作は、実行の直前に依頼者に確認する。ただし、文書だけの小さな変更は、依頼者の指示で `main` に直接 push したことがある（この引き継ぎと `ISSUES.md`）。
- PR を出したら、依頼者が CodeRabbit のレビューを始める。指摘は内容を確かめてから直し、各スレッドに返信する。
- 権利面は `docs/spec.md` §8 に従う。新しい世代のチップに固有の機能を加えるときは、§8.1 と同じ観点で、その機能の初出を確かめる。
- 返答とコミットメッセージは日本語。コミットは Conventional Commits、author は `akabee0161 <akabee0161@gmail.com>`。

## 作業環境の注意

- サーバーのメモリは約 1.9 GB と少ない。ヘッドレス Chromium（`npm run check:browser`）は 1 つずつ動かし、終わったら chrome と vite のプロセスが残っていないことを確かめる。
- Chromium は `~/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome` にある。ブラウザーはダウンロードしない。
