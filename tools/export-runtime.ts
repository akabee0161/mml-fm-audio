// ゲームのリポジトリへ、ゲームが使う部分（runtime・engine・sequencer と音色）だけをフォルダごとコピーする。
// 使い方：npm run export:runtime -- <コピー先>
import { execFileSync } from 'node:child_process';
import { cpSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const UPSTREAM_URL = 'https://github.com/akabee0161/mml-fm-audio';
/** UPSTREAM.md に書く「コピー元」の行。コピー先を入れ替えてよいかの照合にも使う（部分一致にしない） */
const UPSTREAM_LINE = `- コピー元：${UPSTREAM_URL}`;

/** コピーするフォルダ（リポジトリからの相対パス）。中のテストは除く */
const SOURCE_DIRS = ['packages/engine/src', 'packages/sequencer/src', 'packages/runtime/src'];
/** 音色：JSON とライセンス全文だけ（tonedata.txt などの元データは入れない） */
const VOICE_DIRS = ['voices/ymf825', 'voices/custom'];
const VOICE_FILES = ['voices/LICENSE-YMF825.txt'];

export interface ExportInfo {
  /** コピーした時点の `git rev-parse HEAD` */
  commit: string;
  /** コピーした日（YYYY-MM-DD） */
  date: string;
  /** コピー元の作業ツリーに未コミットの変更があるか */
  dirty?: boolean;
}

function upstreamText(info: ExportInfo): string {
  const dirtyNote = info.dirty
    ? `
注意：コピーした時点で、コピー元の作業ツリーに未コミットの変更があった。このフォルダの中身は、上の commit と食い違っている。
`
    : '';
  return `# mml-fm-audio（コピー）

このフォルダは、FM 音源ライブラリ mml-fm-audio のうち、ゲームが使う部分だけをコピーしたもの。

${UPSTREAM_LINE}
- commit：${info.commit}
- コピーした日：${info.date}
${dirtyNote}
## ここでは直さない

このフォルダのファイルは直さない。直すときは本体のリポジトリで直してから、\`npm run export:runtime -- <このフォルダ>\` でコピーし直す（中身は入れ替わる）。

## 使い方

import の入口は \`packages/runtime/src/index.ts\`（\`FmAudio\`）。

\`\`\`ts
import { FmAudio } from './mml-fm-audio/packages/runtime/src/index.ts';
\`\`\`

\`voices/LICENSE-YMF825.txt\` は、YMF825 由来の音色の出典とライセンス全文。このフォルダに必ず含める。

## ゲーム側の前提

- Vite でビルドすること（音源の Worklet を \`processor.ts?worker&url\` で読み込むため）。
- tsconfig に \`"allowImportingTsExtensions": true\` が要る（import が \`.ts\` つきのため）。
- JSON の import のため \`"resolveJsonModule": true\` が要る。
`;
}

/** パスが無ければ undefined */
function lstatOrUndefined(path: string) {
  try {
    return lstatSync(path);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw e;
  }
}

/** 存在する一番近い祖先の実パスに、残りをつないだもの（まだ無いコピー先でも symlink を解いた位置を得る） */
function realPathOf(path: string): string {
  const rest: string[] = [];
  let current = resolve(path);
  while (lstatOrUndefined(current) === undefined) {
    rest.unshift(current.slice(dirname(current).length + 1));
    current = dirname(current);
  }
  return join(realpathSync.native(current), ...rest);
}

function isInside(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
}

/** コピー先を検査し、入れ替えてよいときは中身を空にする。書いてはいけないときは例外を投げる */
function prepareDest(dest: string): void {
  const realDest = realPathOf(dest);
  const realRepo = realpathSync.native(REPO_ROOT);
  if (isInside(realRepo, realDest) || isInside(realDest, realRepo)) {
    throw new Error(`コピー先がこのリポジトリの中、またはこのリポジトリを含むフォルダのため、何も書かずに止めました：${dest}`);
  }
  const stat = lstatOrUndefined(dest);
  if (stat === undefined) return;
  if (stat.isSymbolicLink()) {
    throw new Error(`コピー先が symlink のため、何も書かずに止めました：${dest}`);
  }
  if (!stat.isDirectory()) {
    throw new Error(`コピー先がフォルダではないため、何も書かずに止めました：${dest}`);
  }
  const entries = readdirSync(dest);
  if (entries.length === 0) return;
  const markerPath = join(dest, 'UPSTREAM.md');
  const marker = lstatOrUndefined(markerPath);
  if (marker === undefined || !marker.isFile()) {
    throw new Error(
      `コピー先に UPSTREAM.md がありません。別のフォルダを消さないよう、何も書かずに止めました：${dest}\n` +
        '前回のコピーが途中で失敗した跡かもしれません。その場合は、中身を確かめてから手で消してください。',
    );
  }
  if (!readFileSync(markerPath, 'utf8').split(/\r?\n/).includes(UPSTREAM_LINE)) {
    throw new Error(`コピー先の UPSTREAM.md が、このリポジトリ（${UPSTREAM_URL}）のコピーのものではないため、何も書かずに止めました：${dest}`);
  }
  // コピー先の直下だけを消す。rm は symlink をたどらず、リンクそのものを消す
  for (const name of entries) rmSync(join(dest, name), { recursive: true, force: true });
}

/** ゲームが使う部分を dest へコピーする。dest が既にあれば（UPSTREAM.md があるときだけ）中身を入れ替える */
export function exportRuntime(dest: string, info: ExportInfo): void {
  const target = resolve(dest);
  prepareDest(target);
  mkdirSync(target, { recursive: true });

  for (const dir of SOURCE_DIRS) {
    cpSync(join(REPO_ROOT, dir), join(target, dir), {
      recursive: true,
      filter: (src) => !src.endsWith('.test.ts'),
    });
  }
  for (const dir of VOICE_DIRS) {
    cpSync(join(REPO_ROOT, dir), join(target, dir), {
      recursive: true,
      filter: (src) => lstatSync(src).isDirectory() || src.endsWith('.json'),
    });
  }
  for (const file of VOICE_FILES) {
    mkdirSync(dirname(join(target, file)), { recursive: true });
    cpSync(join(REPO_ROOT, file), join(target, file));
  }
  writeFileSync(join(target, 'UPSTREAM.md'), upstreamText(info));
}

/** 本体のリポジトリの今の commit と、未コミットの変更があるか */
export function currentSource(): ExportInfo {
  const git = (...args: string[]) => execFileSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8' }).trim();
  return {
    commit: git('rev-parse', 'HEAD'),
    date: new Date().toISOString().slice(0, 10),
    dirty: git('status', '--porcelain') !== '',
  };
}

if (import.meta.main) {
  const dest = process.argv[2];
  if (dest === undefined || dest === '') {
    console.error('使い方：npm run export:runtime -- <コピー先>');
    process.exit(1);
  }
  try {
    const info = currentSource();
    // npm run はコマンドのあるリポジトリのルートへ移ってから動くので、相対パスは npm run を実行した場所（INIT_CWD）から解く
    const target = resolve(process.env.INIT_CWD ?? process.cwd(), dest);
    exportRuntime(target, info);
    console.log(`コピーしました：${target}（commit ${info.commit.slice(0, 7)}${info.dirty ? '、未コミットの変更あり' : ''}）`);
  } catch (e) {
    console.error((e as Error).message);
    process.exit(1);
  }
}
