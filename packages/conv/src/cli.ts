// SMF を MML へ変換するコマンド。
// 使い方：npm run conv -- <入力.mid> [-o <出力.mml>] [--quantize 4|8|16|32|64] [--report]
import { readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { TICKS_PER_QUARTER } from '../../sequencer/src/index.ts';
import { ConvError, convertSmf, QUANTIZE_UNITS } from './index.ts';
import type { ConvReport, QuantizeUnit } from './index.ts';

export interface CliIo {
  cwd: string;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
}

const USAGE = `使い方：npm run conv -- <入力.mid> [-o <出力.mml>] [--quantize ${QUANTIZE_UNITS.join('|')}] [--report]`;

function reportLines(report: ConvReport): string[] {
  const lines = ['捨てたイベント：'];
  if (report.discarded.size === 0) lines.push('  なし');
  for (const [label, count] of report.discarded) lines.push(`  ${label}：${count} 件`);
  lines.push('チャンネルとトラック名：');
  for (const { channel, names } of report.perChannel) lines.push(`  チャンネル ${channel + 1}：${names.join('、')}`);
  const { start, end, fromMarkers } = report.loop;
  lines.push(`ループ：tick ${start}〜${end}（四分音符 = ${TICKS_PER_QUARTER}）、${fromMarkers ? 'マーカーから' : 'マーカーがないので曲全体'}`);
  return lines;
}

/** 終了コードを返す。0 は成功 */
export function runCli(args: string[], io: CliIo): number {
  const fail = (message: string, withUsage = false): number => {
    io.stderr(`${message}\n`);
    if (withUsage) io.stderr(`${USAGE}\n`);
    return 1;
  };

  let parsed;
  try {
    parsed = parseArgs({
      args,
      allowPositionals: true,
      options: {
        o: { type: 'string', short: 'o' },
        quantize: { type: 'string' },
        report: { type: 'boolean' },
      },
    });
  } catch (e) {
    return fail((e as Error).message, true);
  }
  const { values, positionals } = parsed;
  if (positionals.length !== 1) return fail('入力の .mid ファイルを 1 つ指定してください', true);

  let quantize: QuantizeUnit | undefined;
  if (values.quantize !== undefined) {
    const unit = QUANTIZE_UNITS.find((u) => String(u) === values.quantize);
    if (unit === undefined) return fail(`--quantize は ${QUANTIZE_UNITS.join('・')} のどれかにしてください：${values.quantize}`, true);
    quantize = unit;
  }

  const inputPath = resolve(io.cwd, positionals[0]);
  let bytes: Uint8Array;
  try {
    bytes = readFileSync(inputPath);
  } catch (e) {
    return fail(`入力ファイルを読めません：${inputPath}（${(e as Error).message}）`);
  }

  let result;
  try {
    result = convertSmf(bytes, quantize === undefined ? undefined : { quantize });
  } catch (e) {
    if (e instanceof ConvError) return fail(e.message);
    throw e;
  }

  if (values.o === undefined) {
    io.stdout(result.mml);
  } else {
    const outputPath = resolve(io.cwd, values.o);
    try {
      writeFileSync(outputPath, result.mml);
    } catch (e) {
      return fail(`出力ファイルを書けません：${outputPath}（${(e as Error).message}）`);
    }
  }
  for (const warning of result.warnings) io.stderr(`${warning}\n`);
  if (values.report) for (const line of reportLines(result.report)) io.stderr(`${line}\n`);
  return 0;
}

// import.meta.main は Node 23 系にないため、直接実行されたかを argv[1] で確かめる
if (process.argv[1] !== undefined && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  // npm run はリポジトリのルートへ移ってから動くので、相対パスは npm run を実行した場所（INIT_CWD）から解く
  const code = runCli(process.argv.slice(2), {
    cwd: process.env.INIT_CWD ?? process.cwd(),
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
  });
  process.exit(code);
}
