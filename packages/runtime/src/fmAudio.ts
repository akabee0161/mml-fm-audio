import { FmEngine, type AnyVoice, type VoiceGroup } from '../../engine/src/index.ts';
import { Player, parseMml, type EngineLike, type Song } from '../../sequencer/src/index.ts';
import { bundledVoices, validateVoiceEntries } from './voices.ts';

/** pump の間隔（ms）と先読み（秒）。試聴ページと同じ */
const PUMP_INTERVAL_MS = 25;
const LOOKAHEAD_SECONDS = 0.1;
/** 再生を始めてから曲の頭までの余裕（秒）。試聴ページと同じ */
const START_MARGIN_SECONDS = 0.05;

// テストで偽物に差し替えられるよう、使う操作だけを型にする（本物の AudioContext・FmEngine はこれを満たす）

export interface AudioParamLike {
  value: number;
  setValueAtTime(value: number, time: number): unknown;
  setTargetAtTime(target: number, time: number, timeConstant: number): unknown;
  linearRampToValueAtTime(value: number, time: number): unknown;
  cancelScheduledValues(time: number): unknown;
}

export interface AudioNodeLike {
  connect(destination: unknown, output?: number, input?: number): unknown;
  disconnect(): void;
}

export interface GainNodeLike extends AudioNodeLike {
  readonly gain: AudioParamLike;
}

export interface BiquadFilterNodeLike extends AudioNodeLike {
  type: string;
  readonly frequency: AudioParamLike;
  readonly Q: AudioParamLike;
}

export interface AudioContextLike {
  readonly currentTime: number;
  readonly sampleRate: number;
  readonly state: string;
  readonly destination: unknown;
  resume(): Promise<void>;
  suspend(): Promise<void>;
  createGain(): GainNodeLike;
  createBiquadFilter(): BiquadFilterNodeLike;
}

export interface VisibilityLike {
  readonly hidden: boolean;
  addEventListener(type: 'visibilitychange', listener: () => void): void;
}

/** FmAudio が音源に求める操作。FmEngine がこれを満たす */
export interface RuntimeEngine {
  noteOn(
    program: number,
    note: number,
    options: { pan: number; time: number; volume: number; bend: number; group?: VoiceGroup },
  ): number;
  noteOff(id: number, time: number): void;
  setPitchBend(id: number, cents: number, time: number): void;
  setVolume(id: number, volume: number, time: number): void;
  cancel(ids: readonly number[]): void;
  registerVoice(program: number, voice: AnyVoice): void;
  onWarning(handler: (message: string) => void): void;
  readonly node: AudioNodeLike;
}

export interface RuntimeDeps {
  context: AudioContextLike;
  engine: RuntimeEngine;
  document?: VisibilityLike;
}

export interface FmAudioOptions {
  context?: AudioContext;
  /** 番号と音色の組の一覧。省くと同梱の音色集（GM とドラム）を登録する */
  voices?: ReadonlyArray<{ program: number; voice: unknown }>;
}

type EventType = 'loop' | 'end' | 'warning';

/** 鳴らしている BGM。nextLoopPass は、まだ loop を呼んでいない最初の周（1 から） */
interface BgmState {
  player: Player;
  nextLoopPass: number;
}

function isSong(value: unknown): value is Song {
  return (
    typeof value === 'object' &&
    value !== null &&
    Array.isArray((value as Song).tracks) &&
    Array.isArray((value as Song).errors)
  );
}

function requireSong(name: string, song: unknown): asserts song is Song {
  if (!isSong(song)) throw new RangeError(`${name}: song は load が返した Song にしてください`);
}

/** ゲーム向けの API。BGM は同時に 1 曲、効果音は重ねて鳴らせる */
export class FmAudio {
  readonly context: BaseAudioContext;
  readonly engine: FmEngine;
  /** destination の直前のノード。分析器をつなぐ用 */
  readonly output: AudioNode;

  // 音量・フェード・フィルターは Task 6 でこの 4 つのノードに足す
  // 経路：engine 出力 0 → bgmFade → bgmGain → master、出力 1 → seGain → master、master → destination
  private readonly bgmFade: GainNodeLike;
  private readonly bgmGain: GainNodeLike;
  private readonly seGain: GainNodeLike;
  private readonly master: GainNodeLike;

  private bgm: BgmState | null = null;
  private readonly sePlayers = new Set<Player>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly handlers: Record<EventType, Set<(message: string) => void>> = {
    loop: new Set(),
    end: new Set(),
    warning: new Set(),
  };

  private constructor(
    private readonly ctx: AudioContextLike,
    private readonly rt: RuntimeEngine,
    _document?: VisibilityLike,
  ) {
    this.context = ctx as unknown as BaseAudioContext;
    this.engine = rt as unknown as FmEngine;

    this.bgmFade = ctx.createGain();
    this.bgmGain = ctx.createGain();
    this.seGain = ctx.createGain();
    this.master = ctx.createGain();
    rt.node.connect(this.bgmFade, 0);
    this.bgmFade.connect(this.bgmGain);
    this.bgmGain.connect(this.master);
    rt.node.connect(this.seGain, 1);
    this.seGain.connect(this.master);
    this.master.connect(ctx.destination);
    this.output = this.master as unknown as AudioNode;

    rt.onWarning((message) => this.emit('warning', message));
  }

  /** テスト用。偽の AudioContext・音源でつなぐ。通常は init を使う */
  static create(deps: RuntimeDeps): FmAudio {
    return new FmAudio(deps.context, deps.engine, deps.document);
  }

  /**
   * AudioContext を作り、Worklet を読み込んで音色を登録する。
   * 自動再生の制限で音が出せない状態で返ることがあるので、ユーザー操作の後に resume を呼ぶ。
   * 検査を通らない音色があれば、番号と理由つきで例外を投げる
   */
  static async init(options: FmAudioOptions = {}): Promise<FmAudio> {
    const entries = validateVoiceEntries(options.voices ?? bundledVoices());
    const context = options.context ?? new AudioContext();
    const engine = await FmEngine.create(context);
    for (const { program, voice } of entries) engine.registerVoice(program, voice);
    return FmAudio.create({
      context,
      engine,
      document: typeof document === 'undefined' ? undefined : document,
    });
  }

  resume(): Promise<void> {
    return this.ctx.resume();
  }

  /** MML を読む。エラーは例外にせず song.errors に入れて返す */
  load(mml: string): Song {
    return parseMml(mml);
  }

  /** BGM を鳴らす。再生中ならすぐ止めて差し替える。エラーのある曲は鳴らさず、鳴っている BGM も止める */
  playBgm(song: Song): void {
    requireSong('playBgm', song);
    this.stopBgm();
    if (song.errors.length > 0) {
      this.emit('warning', FmAudio.errorMessage(song));
      return;
    }
    this.bgm = { player: new Player(this.rt, song, this.playerOptions()), nextLoopPass: 1 };
    this.ensureTimer();
  }

  /** BGM をすぐ止める（送り済みの予約を捨て、持続中のノートをキーオフする）。loop・end は呼ばない */
  stopBgm(_options: { fadeMs?: number } = {}): void {
    if (!this.bgm) return;
    this.bgm.player.stop();
    this.bgm = null;
  }

  /** 効果音を鳴らす。BGM とは別のボイスを使い、続けて呼ぶと重なる。L は無視して最後まで鳴らす */
  playSe(song: Song): void {
    requireSong('playSe', song);
    if (song.errors.length > 0) {
      this.emit('warning', FmAudio.errorMessage(song));
      return;
    }
    const se: EngineLike = {
      noteOn: (program, note, o) => this.rt.noteOn(program, note, { ...o, group: 'se' }),
      noteOff: (id, time) => this.rt.noteOff(id, time),
      setPitchBend: (id, cents, time) => this.rt.setPitchBend(id, cents, time),
      setVolume: (id, volume, time) => this.rt.setVolume(id, volume, time),
      cancel: (ids) => this.rt.cancel(ids),
    };
    const once: Song = { ...song, loopStart: null, loopEnd: song.length };
    this.sePlayers.add(new Player(se, once, this.playerOptions()));
    this.ensureTimer();
  }

  on(type: 'loop' | 'end', handler: () => void): () => void;
  on(type: 'warning', handler: (message: string) => void): () => void;
  on(type: EventType, handler: (message: string) => void): () => void {
    if (type !== 'loop' && type !== 'end' && type !== 'warning') {
      throw new RangeError(`on: type は 'loop'・'end'・'warning' のどれかにしてください（type=${String(type)}）`);
    }
    if (typeof handler !== 'function') throw new RangeError('on: handler は関数にしてください');
    this.handlers[type].add(handler);
    return () => {
      this.handlers[type].delete(handler);
    };
  }

  private static errorMessage(song: Song): string {
    const first = song.errors[0]!;
    const more = song.errors.length > 1 ? `（ほか ${song.errors.length - 1} 件）` : '';
    return `MML にエラーがあるため鳴らしません：${first.line} 行 ${first.column} 列 ${first.message}${more}`;
  }

  private playerOptions() {
    const sampleRate = this.ctx.sampleRate;
    return { sampleRate, startFrame: Math.round((this.ctx.currentTime + START_MARGIN_SECONDS) * sampleRate) };
  }

  private emit(type: EventType, message?: string): void {
    for (const handler of [...this.handlers[type]]) handler(message ?? '');
  }

  private ensureTimer(): void {
    if (this.timer === null) this.timer = setInterval(() => this.tick(), PUMP_INTERVAL_MS);
  }

  private tick(): void {
    const sampleRate = this.ctx.sampleRate;
    const now = this.ctx.currentTime * sampleRate;
    const horizon = now + LOOKAHEAD_SECONDS * sampleRate;

    const bgm = this.bgm;
    if (bgm) {
      bgm.player.pump(now, horizon);
      this.fireBgmEvents(bgm, now);
    }
    for (const player of this.sePlayers) {
      player.pump(now, horizon);
      if (player.finished) this.sePlayers.delete(player);
    }

    if (this.bgm === null && this.sePlayers.size === 0 && this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** loop・end は、音が実際に鳴る時刻（currentTime がその位置に来たとき）に呼ぶ */
  private fireBgmEvents(bgm: BgmState, now: number): void {
    const end = bgm.player.endFrame;
    if (end === null) {
      while (this.bgm === bgm && now >= bgm.player.loopFrame(bgm.nextLoopPass)) {
        bgm.nextLoopPass++;
        this.emit('loop');
      }
    } else if (now >= end) {
      this.bgm = null;
      this.emit('end');
    }
  }
}
