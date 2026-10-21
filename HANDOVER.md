# 引き継ぎ（2026-10-21）

次のセッションが作業を再開するためのメモ。今の状態・使い方の正典は `README.md` と `CLAUDE.md`、課題は `ISSUES.md`。

## 今の状態

- M1（4 オペレーター FM を 1 音）は完了。PR #1 でマージ済み（7335c25）、https://ankardo.com/play/mml-fm-audio/ に公開済み、依頼者が試聴済み。
- M2（16 音同時発音、ステレオ、ノイズ、ドラム 8 種、負荷の計測）は完了。PR #2 でマージ済み（1c91dc6）、https://ankardo.com/play/mml-fm-audio/ に公開済み。
  - 依頼者が設計書 §1.1 の確認 1〜7 を行い、すべて問題なしとした（2026-10-21）。確認 4 のドラムは「どれもそれらしくない」が、M2 では暫定でよいので M6 に回した（`ISSUES.md` #9）。
  - 負荷は PC・Google Pixel 7a・iPhone SE（第 2 世代）で実測し、`docs/load-measurements.md` に記録した。同時発音数の見直し（spec §9 の未決事項 4）は判断していない。処理を速くする工夫は何もしていない段階で、今後検討する。
  - 設計：`docs/superpowers/specs/2026-10-20-m2-polyphony-design.md`
  - 計画：`docs/superpowers/plans/2026-10-20-m2-polyphony.md`
  - 実装は依頼者の指示で、サブエージェントを使わずにメインのセッションが行った。
  - `ISSUES.md` の #4（結線ごとの出力テスト）は M2 で直し、行を消した。
- 公開は `main` への push で GitHub Actions が行う。secrets（`CLOUDFLARE_API_TOKEN`・`CLOUDFLARE_ACCOUNT_ID`）は依頼者が設定済み。environment `production` は、初回のデプロイで自動作成された。
- 直さずに残した課題は `ISSUES.md` にある。直す時期は依頼者と合意済み。

- M3（MML の全命令とループ）は、設計と実装計画まで済んだ。どちらもブランチ `feat/m3-sequencer` にコミット済みで、push はしていない。
  - 設計：`docs/superpowers/specs/2026-10-21-m3-sequencer-design.md`（依頼者が読んで承認した）
  - 計画：`docs/superpowers/plans/2026-10-21-m3-sequencer.md`（全 10 タスク。依頼者は読んで実装に進むことにした）
  - 依頼者が brainstorming で決めたことは、設計書に「依頼者の決定」と書いてある。主なもの：`v` と `B` は持続中のノートにもその位置から効く（タイの間に書く）、`L` の前から持続中のノートはループ後に鳴らし直さない、ループ位置をまたぐノート（弱起）は、ループ終了の命令 `E` を越える長さで書けばループ後も持続する、`[ ]N` の N は省けない、違う高さのタイはエラー、ゲートタイム `q` を足す、ピッチベンドを滑らかに変える命令は作らない。

## 次にやること

M3 の実装計画を、subagent-driven-development で Task 1 から実装する。実装・タスクごとのレビューは Sonnet のサブエージェント、ブランチ全体の最終レビューは Opus のサブエージェント。メインのエージェントは Sonnet でもよいと依頼者に伝えてある（ループの決まりで、レビューの指摘と計画が食い違ったときは、設計書と照らして判断する）。

## 依頼者と決めた進め方

- マイルストーンごとに、設計 → 計画 → 実装を 1 回ずつ回す。
  - 設計：superpowers の brainstorming。設計書は `docs/superpowers/specs/` に置く。
  - 計画：writing-plans。計画は `docs/superpowers/plans/` に置く。
  - 実装：subagent-driven-development。
- 実装は Sonnet のサブエージェント、タスクごとのレビューも Sonnet、ブランチ全体の最終レビューは Opus。
- 依頼者が「Task N が終わったら止めて」と言ったら、そこで実際に止まる。
- GitHub の操作、push、マージ、公開などの外部への操作は、実行の直前に依頼者に確認する。ただし、文書だけの小さな変更は、依頼者の指示で `main` に直接 push したことがある（この引き継ぎと `ISSUES.md`）。
- PR を出したら、依頼者が CodeRabbit のレビューを始める。指摘は内容を確かめてから直し、各スレッドに返信する。
- 依頼者は MIDI の制御に詳しい。音楽まわりの質問は、言い換えずに MIDI の用語（ノートオン・ノートオフ・持続中のノート・コントロールなど）で書く。brainstorming の質問は一度にまとめて出す。
- 権利面は `docs/spec.md` §8 に従う。新しい世代のチップに固有の機能を加えるときは、§8.1 と同じ観点で、その機能の初出を確かめる。
- 返答とコミットメッセージは日本語。コミットは Conventional Commits、author は `akabee0161 <akabee0161@gmail.com>`。

## 作業環境の注意

- サーバーのメモリは約 1.9 GB と少ない。ヘッドレス Chromium（`npm run check:browser`）は 1 つずつ動かし、終わったら chrome と vite のプロセスが残っていないことを確かめる。
- Chromium は `~/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome` にある。ブラウザーはダウンロードしない。
