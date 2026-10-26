import type { MmlError } from './song.ts';

export interface SourcePosition { line: number; column: number }

/**
 * 1 トラック分の MML。text は同じ名前の行を上から連結したもの（コメント除去済み）で、
 * positions[i] は text[i] の元の位置（text と同じ UTF-16 の添字で引く）。
 */
export interface TrackSource { name: string; text: string; positions: SourcePosition[] }

// A〜P、R、A〜P・R に 1 以上の整数（先頭が 0 でない）。後ろは空白か行末
const TRACK_NAME = /^(?:[A-PR][1-9][0-9]*|[A-P]|R)(?=\s|$)/u;

/** 曲のトラック数の上限（違うトラック名の数）。超えた分は解析しない */
export const MAX_TRACKS = 30;

/** 行をトラックごとに連結する。行の区切りは空白 1 文字として text に入れる。コメントを除く。CRLF は LF と同じ */
export function splitTracks(mml: string): { tracks: TrackSource[]; errors: MmlError[] } {
  const byName = new Map<string, TrackSource>();
  const errors: MmlError[] = [];
  let tooMany = false;

  mml.split(/\r?\n/).forEach((rawLine, index) => {
    const line = index + 1;
    const semicolon = rawLine.indexOf(';');
    const body = (semicolon < 0 ? rawLine : rawLine.slice(0, semicolon)).trimEnd();
    if (body.trim() === '') return;

    // 列は文字（コードポイント）単位。UTF-16 の添字ごとに列を引けるようにする
    const columns: number[] = [];
    let column = 0;
    for (const ch of body) {
      column++;
      for (let k = 0; k < ch.length; k++) columns.push(column);
    }

    const lead = body.length - body.trimStart().length;
    const match = TRACK_NAME.exec(body.slice(lead));
    if (!match) {
      errors.push({
        line,
        column: columns[lead]!, // lead は body の範囲内
        message: 'トラック名が正しくありません（行頭に A〜P、A〜P に 1 以上の整数、R、R に 1 以上の整数のどれかを書きます）',
      });
      return;
    }

    const name = match[0];
    let track = byName.get(name);
    if (!track) {
      // 上限を超える新しいトラック名は、最初の 1 件だけ報告し、その行以降の新しいトラックは読まない
      if (byName.size >= MAX_TRACKS) {
        if (!tooMany) errors.push({ line, column: columns[lead]!, message: `トラックが多すぎます（${MAX_TRACKS} まで）` });
        tooMany = true;
        return;
      }
      track = { name, text: '', positions: [] };
      byName.set(name, track);
    }

    const rest = body.slice(lead + name.length).trimStart();
    if (rest === '') return;

    // 2 行目以降は、前の行との間に空白 1 文字を入れる（位置は前の行の末尾の次）
    if (track.text !== '') {
      const last = track.positions[track.positions.length - 1]!; // text が空でなければ positions も空でない
      track.text += ' ';
      track.positions.push({ line: last.line, column: last.column + 1 });
    }
    track.text += rest;
    for (let i = body.length - rest.length; i < body.length; i++) {
      track.positions.push({ line, column: columns[i]! });
    }
  });

  return { tracks: [...byName.values()], errors };
}
