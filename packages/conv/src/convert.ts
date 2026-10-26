import { parseMml } from '../../sequencer/src/index.ts';
import { allocateTracks } from './allocate.ts';
import { ConvError } from './errors.ts';
import { extract } from './extract.ts';
import type { ConvWarning } from './extract.ts';
import { resolveLoop } from './loop.ts';
import type { LoopRange } from './loop.ts';
import { createMeter } from './meter.ts';
import { quantize } from './quantize.ts';
import type { QuantizeUnit } from './quantize.ts';
import { readSmf } from './smf.ts';
import { writeMml } from './writer.ts';

export interface ConvReport {
  discarded: Map<string, number>;
  perChannel: { channel: number; names: string[] }[];
  loop: LoopRange;
}
/** warnings は「12 小節 3 拍：…」の形 */
export interface ConvertResult { mml: string; warnings: string[]; report: ConvReport }

const DEFAULT_QUANTIZE: QuantizeUnit = 32;
const SHOWN_PARSE_ERRORS = 3;

/** SMF を MML に変換する。出力は parseMml で解析し直し、エラーがあれば ConvError。 */
export function convertSmf(bytes: Uint8Array, options: { quantize?: QuantizeUnit } = {}): ConvertResult {
  const extracted = extract(readSmf(bytes));
  const quantized = quantize(extracted, options.quantize ?? DEFAULT_QUANTIZE);
  const meter = createMeter(quantized.timeSignatures);
  const { song, loop } = resolveLoop(quantized, meter);
  const planned = allocateTracks(song, meter);
  const mml = writeMml(planned.tracks, song, loop, meter);

  const parsed = parseMml(mml);
  if (parsed.errors.length > 0) {
    const shown = parsed.errors
      .slice(0, SHOWN_PARSE_ERRORS)
      .map((e) => `${e.line} 行 ${e.column} 列：${e.message}`)
      .join('、');
    const rest = parsed.errors.length > SHOWN_PARSE_ERRORS ? `（ほか ${parsed.errors.length - SHOWN_PARSE_ERRORS} 件）` : '';
    throw new ConvError(`変換した MML に ${parsed.errors.length} 件のエラーがあります。${shown}${rest}`);
  }

  // 同じ tick の警告は、段の順（extract・quantize・loop、allocate）を保つ
  const all: ConvWarning[] = [...song.warnings, ...planned.warnings];
  const sorted = all.map((w, i) => ({ w, i })).sort((a, b) => a.w.tick - b.w.tick || a.i - b.i);
  const warnings = sorted.map(({ w }) => `${meter.position(w.tick)}：${w.message}`);

  return { mml, warnings, report: { discarded: song.discarded, perChannel: planned.perChannel, loop } };
}
