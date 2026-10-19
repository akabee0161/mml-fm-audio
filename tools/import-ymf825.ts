// voices/ymf825/tonedata.txt から gm.json と unassigned.json を書き出す。
// 実行：npm run import:ymf825
import { readFileSync, writeFileSync } from 'node:fs';
import { convertAll } from './ymf825.ts';

const dir = new URL('../voices/ymf825/', import.meta.url);
const { gm, unassigned } = convertAll(readFileSync(new URL('tonedata.txt', dir), 'utf8'));
writeFileSync(new URL('gm.json', dir), `${JSON.stringify(gm, null, 2)}\n`);
writeFileSync(new URL('unassigned.json', dir), `${JSON.stringify(unassigned, null, 2)}\n`);
console.log(`gm.json に ${gm.length} 音色、unassigned.json に ${unassigned.length} 音色を書き出しました`);
