# 引き継ぎ（2026-10-23）

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

- M3（MML の全命令とループ）は、実装・レビュー・マージまで完了。PR #3 でマージ済み（67b61e8、2026-10-22）、GitHub Actions のデプロイは成功し、https://ankardo.com/play/mml-fm-audio/ に公開済み。CodeRabbit は承認した。
  - 依頼者が公開後に設計書 §1.1 の確認 1〜6 を行い、すべて問題なしとした（2026-10-23）。確認 5 で停止後に残って聞こえるのは、ノートオフ後のリリースで、設計どおり（停止は送り済みの予約を捨て、鳴っている音をキーオフする。設計書 §4）。
  - 文法の文書：`docs/mml.md`（新規）。`docs/spec.md` は v0.4 に更新した。
  - 作ったもの：音源への音量・ピッチベンド・予約の取り消し、`packages/sequencer`（`parseMml`・`Timeline`・`Player`）、試聴ページの MML の欄と曲 `demo/songs/m3-demo.mml`、`npm run check:browser` の MML の確認。
  - 設計：`docs/superpowers/specs/2026-10-21-m3-sequencer-design.md`（依頼者が読んで承認した）
  - 計画：`docs/superpowers/plans/2026-10-21-m3-sequencer.md`（全 10 タスク）
  - 設計に書いていなかった 2 点は、依頼者が了承した（`docs/mml.md` の「タイと `q`、タイと `L`」）：タイでつないだ音の `q` はノートオンした時点の値を全体の長さに掛けること、`L` をはさんだタイ（`c L &c`）はエラーにならず、`L` の位置で持続中のノートと同じ扱いになること。
  - ブランチ全体の最終レビュー（Opus）は済ませ、指摘も直した。CodeRabbit の指摘 3 件のうち、テンポ登録と秒の変換の二乗の遅さ（病的な入力で十数秒かかる）は直した（5d58c62）。「停止時にドラムも即時停止」は、M2 の決まり（ドラムはノートオフを無視して鳴り終わるまで鳴る）と、即時停止でプチッと鳴る懸念から、依頼者が見送った。ドラムの余韻は M6 の音の調整（`ISSUES.md` #9）の中で聞いて判断する。CodeRabbit が提案したフォローアップ Issue（ドラムの余韻を M6 の試聴確認項目にする）は、`ISSUES.md` #9 に含まれるため作らないと依頼者が決めた（2026-10-23）。
  - MML にエラーが 1 つでもあれば再生しない（鳴っている再生も止める）。この方針を依頼者が決めた。
  - M3 最終レビューで見つけた「`Player` の送り済みノート一覧（`sent`）が `stop()` まで増え続ける」（旧 `ISSUES.md` #10）は、M4 の前にブランチ `fix/player-sent-growth` で直した。`pump` でノートオフの時刻を過ぎたものを捨てる。
  - 依頼者が brainstorming で決めたことは、設計書に「依頼者の決定」と書いてある。主なもの：`v` と `B` は持続中のノートにもその位置から効く（タイの間に書く）、`L` の前から持続中のノートはループ後に鳴らし直さない、ループ位置をまたぐノート（弱起）は、ループ終了の命令 `E` を越える長さで書けばループ後も持続する、`[ ]N` の N は省けない、違う高さのタイはエラー、ゲートタイム `q` を足す、ピッチベンドを滑らかに変える命令は作らない。

## 次にやること

1. 次は M4（runtime：API、効果音の同時再生、音量・フェード）。エラーのあったトラックだけを無音にする動きと設定の切り替え、ループの回数の指定（`playBgm` の `loop`）も M4 で扱う。設計 → 計画 → 実装の順（brainstorming から）。M4 で公開 API にするときは、`FmEngine.cancel` の引数検査（配列でない値）と `operatorFrequency`・`waveValue` の範囲検査（`ISSUES.md` #5）も入れる。`Player` を公開 API にする前に、ループの各周回の頭でメインスレッドが止まる件（`ISSUES.md` #11）も直す。

## M3 の作業で分かったこと（次のセッション向け）

- 最終レビューで見落としやすい点：**病的な入力で重くなる処理は、実測するまで「手書きでは出ない」と軽く見積もらない。** `[[t120 r%1]250]255` のような入れ子の繰り返しで、テンポ登録と秒の変換が二乗の遅さになっていた（13 秒と 9.7 秒）。解析と再生は画面側で動くので、貼り付けた MML で画面が固まる。パーサーと `Player` を触るときは、`A [[t120 c%1]200]200` などの入力で時間を測る。
- `parseMml` は 1 トラックの events が 100,000、実行した命令が 400,000、失敗した命令が 10,000 を超えると、エラー 1 件で読むのをやめる。`Player` は 1 周分のアクションを `for` で `queue` に積む（`push(...配列)` はスタックが溢れるので使わない）。
- 設計書で決まっていない挙動を実装が決めたときは、`docs/mml.md` に事実として書き、依頼者に確認する。M3 では「タイの `q`」「`L` をはさんだタイ」「エラー時の再生」がこれに当たり、すべて依頼者が決めた（`q` は依頼者が私に一任した）。
- 手元の `git stash`（`stash@{0}`）が 1 つ残っている。中身はコミット済みの変更と同じなので、依頼者が了承すれば `git stash drop` で消してよい。
- `.superpowers/sdd/` は subagent-driven-development の作業記録（台帳・報告・レビューの diff）。git の管理外（`.git/info/exclude`）で、M2 と M3 の分がある。消してよいが、M3 の各タスクの Minor と Ruling の経緯は `2026-10-21-m3-sequencer/progress.md` にある。
- ブランチ `feat/m1-engine`・`feat/m2-polyphony`・`feat/m3-sequencer` はマージ済みで、手元とリモートに残っている。整理するときは依頼者に確認する。

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
