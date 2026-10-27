import { DRUM_PROGRAMS } from '../../sequencer/src/index.ts';
import { ConvError } from './errors.ts';
import type { ConvWarning, RawNote } from './extract.ts';
import type { Meter } from './meter.ts';
import type { Quantized } from './quantize.ts';

/** ドラムの note は、ドラム名の音色番号ではなく SMF のノート番号のまま。ドラムの off は on と同じ */
export interface PlacedNote { on: number; off: number; note: number; velocity: number }
export interface PlannedTrack {
  name: string; // 'A'、'A1'、'R'、'R1' など
  channel: number; // 0〜15
  drum: boolean;
  drumNames?: string[]; // drum のとき、notes と同じ順のドラム名
  notes: PlacedNote[]; // on の順、トラックの中で重ならない
}

/** MML のトラックの上限。packages/sequencer の MAX_TRACKS と同じ（index から出ていないので写す） */
const MAX_TRACKS = 30;
const MAX_POLYPHONY = 16;
const DRUM_CHANNEL = 9;
const CONDUCTOR_TRACKS = 1; // 指揮用の J

const DRUM_NOTES: Record<number, keyof typeof DRUM_PROGRAMS> = {};
for (const [name, notes] of Object.entries({
  bd: [35, 36], sd: [38, 40], cp: [37, 39], ch: [42, 44], oh: [46],
  cy: [49, 51, 52, 55, 57, 59], lt: [41, 43, 45], ht: [47, 48, 50],
}) as [keyof typeof DRUM_PROGRAMS, number[]][]) {
  for (const note of notes) DRUM_NOTES[note] = name;
}
const DRUM_ORDER = Object.keys(DRUM_PROGRAMS) as (keyof typeof DRUM_PROGRAMS)[];

const channelLetter = (channel: number): string => String.fromCharCode(65 + channel);
const subName = (base: string, index: number, count: number): string => (count === 1 ? base : `${base}${index + 1}`);

/** 1 つのチャンネルのノートを、重ならないサブトラックに分ける。高い音ほど若い番号 */
function allocateMelody(channel: number, notes: RawNote[]): PlannedTrack[] {
  const lanes: PlacedNote[][] = [];
  for (let i = 0; i < notes.length; ) {
    let j = i;
    while (j < notes.length && notes[j].on === notes[i].on) j++;
    const group = notes.slice(i, j).sort((a, b) => b.note - a.note);
    for (const raw of group) {
      let lane = lanes.find((l) => l[l.length - 1].off <= raw.on);
      if (!lane) {
        lane = [];
        lanes.push(lane);
      }
      lane.push({ on: raw.on, off: raw.off, note: raw.note, velocity: raw.velocity });
    }
    i = j;
  }
  return lanes.map((placed, i) => ({
    name: subName(channelLetter(channel), i, lanes.length),
    channel,
    drum: false,
    notes: placed,
  }));
}

/** ドラムの打撃を tick ごとにまとめ（同じドラムは 1 つ、ベロシティは大きいほう）、R1 から詰める */
function allocateDrums(
  notes: RawNote[],
  warnings: ConvWarning[],
): { tracks: PlannedTrack[]; hitsByTick: Map<number, number> } {
  const unassigned = new Map<number, { first: number; count: number }>();
  const byTick = new Map<number, Map<keyof typeof DRUM_PROGRAMS, PlacedNote>>();
  for (const raw of notes) {
    const name = DRUM_NOTES[raw.note];
    if (!name) {
      const u = unassigned.get(raw.note);
      if (u) u.count++;
      else unassigned.set(raw.note, { first: raw.on, count: 1 });
      continue;
    }
    const hits = byTick.get(raw.on) ?? new Map();
    const prev = hits.get(name);
    if (!prev || raw.velocity > prev.velocity) {
      hits.set(name, { on: raw.on, off: raw.on, note: raw.note, velocity: raw.velocity });
    }
    byTick.set(raw.on, hits);
  }
  for (const [note, u] of unassigned) {
    warnings.push({ tick: u.first, message: `ドラムのノート ${note} は割り当てがないため捨てます（${u.count} 件）` });
  }

  const lanes: { notes: PlacedNote[]; names: string[] }[] = [];
  const hitsByTick = new Map<number, number>();
  for (const tick of [...byTick.keys()].sort((a, b) => a - b)) {
    const hits = byTick.get(tick)!;
    hitsByTick.set(tick, hits.size);
    DRUM_ORDER.filter((name) => hits.has(name)).forEach((name, i) => {
      lanes[i] ??= { notes: [], names: [] };
      lanes[i].notes.push(hits.get(name)!);
      lanes[i].names.push(name);
    });
  }
  const tracks = lanes.map((lane, i) => ({
    name: subName('R', i, lanes.length),
    channel: DRUM_CHANNEL,
    drum: true,
    drumNames: lane.names,
    notes: lane.notes,
  }));
  return { tracks, hitsByTick };
}

/** 同時に鳴るノートが 16 を超えた状態に入った tick ごとに 1 件。メロディは on ≤ t < off、ドラムは打撃の tick だけ */
function warnPolyphony(melody: RawNote[], hitsByTick: Map<number, number>, warnings: ConvWarning[]): void {
  const delta = new Map<number, number>();
  for (const raw of melody) {
    delta.set(raw.on, (delta.get(raw.on) ?? 0) + 1);
    delta.set(raw.off, (delta.get(raw.off) ?? 0) - 1);
  }
  const ticks = [...new Set([...delta.keys(), ...hitsByTick.keys()])].sort((a, b) => a - b);
  let active = 0;
  let over = false;
  for (const tick of ticks) {
    active += delta.get(tick) ?? 0;
    const count = active + (hitsByTick.get(tick) ?? 0);
    if (count > MAX_POLYPHONY && !over) {
      warnings.push({ tick, message: `同時に鳴るノートが ${count} 個になり、${MAX_POLYPHONY} を超えます` });
    }
    over = count > MAX_POLYPHONY;
  }
}

/**
 * ノートを MML のトラックに割り当てる。順はチャンネルの順（チャンネル 10 は最後）、チャンネルの中は番号の順。
 * 指揮用の J はここでは作らないが、30 の上限には数える。警告の位置（小節・拍）は呼び出し側が tick から付ける。
 * `meter` は今は使わない（呼び出しの形をほかの段とそろえている）。
 */
export function allocateTracks(
  song: Quantized,
  _meter: Meter,
): { tracks: PlannedTrack[]; warnings: ConvWarning[]; perChannel: { channel: number; names: string[] }[] } {
  const warnings: ConvWarning[] = [];
  const melodyByChannel = new Map<number, RawNote[]>();
  const drumNotes: RawNote[] = [];
  for (const raw of song.notes) {
    if (raw.channel === DRUM_CHANNEL) {
      drumNotes.push(raw);
    } else {
      const list = melodyByChannel.get(raw.channel) ?? [];
      list.push(raw);
      melodyByChannel.set(raw.channel, list);
    }
  }

  const tracks: PlannedTrack[] = [];
  for (const channel of [...melodyByChannel.keys()].sort((a, b) => a - b)) {
    tracks.push(...allocateMelody(channel, melodyByChannel.get(channel)!));
  }
  const drums = allocateDrums(drumNotes, warnings);
  tracks.push(...drums.tracks);

  const perChannel: { channel: number; names: string[] }[] = [];
  for (const t of tracks) {
    const last = perChannel[perChannel.length - 1];
    if (last?.channel === t.channel) last.names.push(t.name);
    else perChannel.push({ channel: t.channel, names: [t.name] });
  }
  // チャンネルの順（チャンネル 10 も順番どおりの位置）
  perChannel.sort((a, b) => a.channel - b.channel);

  const total = tracks.length + CONDUCTOR_TRACKS;
  if (total > MAX_TRACKS) {
    const parts = perChannel.map((c) =>
      c.channel === DRUM_CHANNEL ? `ドラム：${c.names.length}` : `チャンネル ${c.channel + 1}：${c.names.length}`,
    );
    parts.push(`指揮用 J：${CONDUCTOR_TRACKS}`);
    throw new ConvError(`トラックが ${total} 個になり、上限の ${MAX_TRACKS} を超えます（${parts.join('、')}）`);
  }

  warnPolyphony(song.notes.filter((r) => r.channel !== DRUM_CHANNEL), drums.hitsByTick, warnings);
  warnings.sort((a, b) => a.tick - b.tick);
  return { tracks, warnings, perChannel };
}
