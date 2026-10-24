# ゲーム向け API（packages/runtime）

ゲームから BGM と効果音を MML で鳴らすための API。入口は `FmAudio`。仕様の位置づけは `docs/spec.md` §5、MML の文法は `docs/mml.md`。

## 最小の使用例

```ts
import { FmAudio } from './mml-fm-audio/packages/runtime/src/index.ts';

const audio = await FmAudio.init();
startButton.addEventListener('click', async () => {
  await audio.resume(); // ユーザー操作の後に呼ぶ
  audio.playBgm(audio.load('A t120 L @0 o4 l8 cdefgab>c'));
});
jumpButton.addEventListener('click', () => {
  audio.playSe(audio.load('A t200 @80 o6 l32 c e g >c'));
});
```

- `FmAudio.init()` は音色を同梱のもの（GM とドラム）で登録する。自動再生の制限で、返った時点では音が出ない状態のことがある。ユーザー操作の中で `resume()` を呼ぶと鳴る。
- `load` が返す曲は何度でも `playBgm`・`playSe` に渡せる。曲を作り直す必要はない。

## 関数

| 関数 | 内容 |
|---|---|
| `FmAudio.init(options?)` | AudioContext を作り、Worklet を読み込み、音色を登録して `FmAudio` を返す |
| `audio.resume()` | AudioContext を再開する。`Promise<void>` |
| `audio.load(mml)` | MML を解析して `Song` を返す。エラーは例外にせず `song.errors` に入る |
| `audio.playBgm(song)` | BGM を鳴らす |
| `audio.stopBgm({ fadeMs? })` | BGM を止める |
| `audio.pauseBgm()` / `audio.resumeBgm()` | BGM を一時停止する・続ける |
| `audio.playSe(song)` | 効果音を鳴らす |
| `audio.setVolume({ master?, bgm?, se? })` | 音量を変える |
| `audio.setSpeakerFilter(enabled)` | スピーカー風フィルターを入れる・外す |
| `audio.on(type, handler)` | イベントを受ける。解除する関数を返す |
| `audio.output` | `destination` の直前のノード（`AudioNode`）。分析器などをつなぐ用 |
| `audio.context` / `audio.engine` | 内部の `AudioContext` と `FmEngine` |

### `FmAudio.init(options?)`

| 引数 | 内容 |
|---|---|
| `options.context` | 使う `AudioContext`。省くと新しく作る |
| `options.voices` | `{ program, voice }` の配列。省くと同梱の音色集を登録する |

- `voices` の音色が検査（`validateVoice`・`validateDrum`）を通らなければ、番号と理由つきの `RangeError` を投げる。`kind` が `'drum'` ならドラム、それ以外は FM 音色として検査する。
- 同梱の音色集は、GM の音色（`id` を番号に）とドラム 8 種（128〜135）。`id` が `null` の音色は MML の `@N` で呼べないので含めない。

### `load(mml)` と エラーのある曲

- 解析エラーは行・列・理由つきで `song.errors` に入る（`docs/mml.md` のエラーの節）。`load` は例外を投げない。
- エラーが 1 つでもある曲は鳴らさない。`playBgm`・`playSe` は例外を投げず、`warning` イベントで最初のエラーを知らせる（`MML にエラーがあるため鳴らしません：1 行 6 列 …（ほか 2 件）`）。
- `playBgm` に渡した曲にエラーがあるときは、鳴っている BGM も止める。

### `playBgm(song)`

- BGM は同時に 1 曲。鳴っている BGM があれば、すぐ止めて新しい曲に差し替える。
- 曲は呼んでから 0.05 秒後に頭から始まる。
- ループするかどうかは MML の `L`・`E` で決まる。ループの回数や有無を引数で指定することはできない。
- `song` が `load` の戻り値の形でなければ `RangeError`。

### `stopBgm({ fadeMs })`

- `fadeMs` を省くか 0 にすると、すぐ止める。送り済みの予約を捨て、持続中のノートをキーオフする（ノートのリリースは鳴り終わるまで聞こえる）。`loop`・`end` は呼ばない。
- `fadeMs` が 0 より大きければ、その間に BGM の音量を 0 まで直線的に下げてから止める。フェード中も曲は進み、`loop` も呼ばれる。
- フェードを下げ終えた時点で、BGM の残りの音（リリース・ドラム）もすぐ消える。出力が 0 になってから止めるので、プチッとは鳴らない。フェード中に `playBgm`・`pauseBgm` や、`fadeMs` なしの `stopBgm` を呼んだときは、出力が 0 でないので止めない。
- フェード中にもう一度呼ぶと、終わりが早いほうに合わせる。遅くなる呼び出しは無視する。
- 一時停止中に呼ぶと、フェードせずにすぐ止める（鳴っていないため）。
- 鳴っている BGM がなければ何もしない。
- `options` が `{ fadeMs }` の形でない、`fadeMs` が 0 以上の有限の数でないときは `RangeError`。

### `pauseBgm()` と `resumeBgm()`

- `pauseBgm` は持続中のノートをキーオフし、曲の位置を止める。止めている間は `loop`・`end` も呼ばない。
- `resumeBgm` は、止めた位置から続ける。持続中だったノートは鳴らし直さない（次のノートから鳴る）。
- 止める時刻・続ける時刻は、呼んだ時点（`currentTime`）から 0.05 秒先。`pauseBgm` の時点から 0.05 秒以内に鳴り始めるノートは持続中として扱い、キーオフして再開後に鳴らし直さない。0.05 秒より後に鳴るノートは、再開後に 1 回だけ鳴る。一時停止の直後 0.05 秒以内のノートは鳴らさない（二重にノートオンするよりこちらを選んでいる）。
- 一時停止中でなければ、`resumeBgm` は何もしない。BGM がなければ両方とも何もしない。
- フェード中に `pauseBgm` を呼ぶと、フェードを終えたものとして BGM をすぐ止める（再開はできない）。

### `playSe(song)`

- 効果音は BGM とは別の 4 ボイス（`SE_VOICES`）で鳴らす。BGM のボイスを借りないので、効果音が増えても BGM のノートは欠けない。
- 続けて呼ぶと重なって鳴る。4 ボイスを超えたら、効果音の 4 ボイスのうち、最も古くノートオンした音のボイスを止めて使う（音の単位。効果音の曲の単位ではない）。
- 効果音の MML に `L` があっても無視して、最後まで 1 回だけ鳴らす。
- 効果音を止める関数はない。鳴り終わるのを待つ。`end` イベントも呼ばない。
- エラーのある曲は鳴らさず、`warning` を出す。
- `song` が `load` の戻り値の形でなければ `RangeError`。

### `setVolume({ master, bgm, se })`

| 名前 | 内容 |
|---|---|
| `master` | 全体の音量 |
| `bgm` | BGM の音量 |
| `se` | 効果音の音量 |

- 値は 0〜1 の数。渡した名前だけ変える。既定はすべて 1。
- 持続中のノートにもすぐ効く。変化は約 5 ms の時定数でなめらかにつなぎ、プチッと鳴らない。
- 渡した値を全部検査してから変える。1 つでも範囲外なら、何も変えずに `RangeError`。
- フェード（`stopBgm`）は `bgm` の音量とは別の倍率で、2 つは掛け合わせて効く。フェード中に `setVolume({ bgm })` を呼んでも、フェードは続く。
- フェードで下げた倍率は、止めたときには 1 に戻さない。次の `playBgm` で、新しい曲の頭（呼んでから 0.05 秒後）に向けて 1 へ戻す。止めた直後は前の曲のリリースが残るため、戻すとそれが全音量で鳴ってしまうから。

### `setSpeakerFilter(enabled)`

- `true` で、出力の最後にハイパス（300 Hz）とローパス（7 kHz）を入れて、小さなスピーカー風にする。`false` で外す。既定はオフ。
- 周波数は暫定で、M6 の試聴で調整する。
- 切り替えると `output` が変わる（オンのときはローパス、オフのときは内部の出力）。`output` につないでいたノードは外れるので、切り替えたら `audio.output` につなぎ直す。
- `enabled` が真偽値でなければ `RangeError`。

### `on(type, handler)`

| type | handler の引数 | 呼ばれるとき |
|---|---|---|
| `'loop'` | なし | BGM がループの終わりを越えて、`L` の位置から次の周に入ったとき |
| `'end'` | なし | `L` のない BGM が最後まで鳴ったとき（その後 BGM は鳴っていない状態になる） |
| `'warning'` | メッセージ（文字列） | エラーのある曲を渡したとき、鳴らせない音色を指定したとき、AudioContext を止める・再開するのに失敗したとき。鳴らせない音色の警告は、音色の番号ごとに最初の 1 回だけ（その番号を登録し直すまで）。`init` の中で音色を登録したときの警告は、`init` の返り値（`FmAudio`）を受け取るまで handler をつなげないので、返った直後に `on('warning', …)` をつなぐこと（Worklet からの返事は `init` が返ってから届く） |

- 戻り値は解除する関数。
- `loop`・`end` は、音が実際に鳴る時刻（`currentTime` がその位置に来たとき）に呼ぶ。先読みして送る時刻ではない。
- `stopBgm` と `playBgm` による差し替えでは、`loop`・`end` を呼ばない。ただし `fadeMs` つきの `stopBgm` のフェード中に、`L` のない曲が最後まで来たときは、`end` を呼ぶ（フェードの終わりを待たず、BGM は鳴っていない状態になる）。
- 知らない `type` や、関数でない `handler` は `RangeError`。

## タブの切り替え

- ページが裏に回ったら AudioContext を止め（suspend）、戻ったら続ける。曲の位置も止まるので、戻ったときは続きから鳴る。
- こちらから止めたときだけ戻す。ゲームが自分で止めていた AudioContext を、ページが戻っただけで再開することはない。

## ゲームへのコピーのしかた

ゲームのリポジトリにはパッケージとして入れず、必要な部分をフォルダごとコピーする。

```
npm run export:runtime -- /絶対パス/ゲームのリポジトリ/mml-fm-audio
```

- コピーするのは、`packages/engine/src`・`packages/sequencer/src`・`packages/runtime/src`（テストを除く）と、音色（`voices/ymf825`・`voices/custom` の JSON、`voices/LICENSE-YMF825.txt`）。
- コピー先に `UPSTREAM.md` を書く。コピー元の URL・commit・日付、「ここでは直さない」こと、ゲーム側の前提が入る。コピー元に未コミットの変更があったときは、その注意も入る。
- 直すときは、このリポジトリで直してからコピーし直す。コピー先の中身は入れ替わる。
- コピー先を相対パスで指定したときは、`npm run` を実行した場所からの相対パスになる。
- 次のコピー先には、何も消さずに止める。

| コピー先 | 動き |
|---|---|
| まだないフォルダ、空のフォルダ | コピーする |
| 「コピー元」の行がこのリポジトリの URL と完全に一致する `UPSTREAM.md`（ファイル）があるフォルダ | 直下を消して入れ替える |
| symlink | 止める |
| ファイル | 止める |
| このリポジトリの中、またはこのリポジトリを含むフォルダ | 止める |
| `UPSTREAM.md` のない、空でないフォルダ | 止める（別のフォルダを消さないため） |
| `UPSTREAM.md` はあるが、「コピー元」の行がこのリポジトリの URL と一致しない（別の URL、前方一致するだけの URL を含む）フォルダ | 止める |
| `UPSTREAM.md` がフォルダや symlink のフォルダ | 止める |

- 前回のコピーが途中で失敗した跡（`UPSTREAM.md` のない中途半端なフォルダ）は、中身を確かめて手で消す。

### ゲーム側の前提

- Vite でビルドする。音源の Worklet を `processor.ts?worker&url` で読み込むため。
- tsconfig に `"allowImportingTsExtensions": true` が要る（import が `.ts` つきのため）。
- tsconfig に `"resolveJsonModule": true` が要る（音色の JSON を import するため）。
- `noUncheckedIndexedAccess` を有効にしていても型検査に通る（character-tactics の tsconfig と同じ設定で `npm run check:browser` が確かめている）。

`npm run check:browser` の最後の `tools/check-consumer.ts` が、一時フォルダへのコピー、型検査、Vite のビルド、ヘッドレス Chromium での発音を確かめる。
