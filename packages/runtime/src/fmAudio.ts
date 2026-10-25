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
  silence(group: VoiceGroup): void;
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

/** 鳴らしている BGM。nextLoopPass は、まだ loop を呼んでいない最初の周（1 から）。fadeEnd はフェードが終わる currentTime（秒）で、フェード中でなければ null */
interface BgmState {
  player: Player;
  nextLoopPass: number;
  fadeEnd: number | null;
}

/** 音量を変えるときの時定数（秒）。プチッと鳴らない程度に短く */
const VOLUME_TIME_CONSTANT = 0.005;
/** スピーカー風フィルターの周波数（Hz、暫定） */
const SPEAKER_HIGHPASS_HZ = 300;
const SPEAKER_LOWPASS_HZ = 7000;

function requireVolume(name: string, value: unknown): asserts value is number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new RangeError(`setVolume: ${name} は 0〜1 の数にしてください（${name}=${String(value)}）`);
  }
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
  // 経路：engine 出力 0 → bgmFade → bgmGain → master、出力 1 → seGain → master、master → destination
  // スピーカー風フィルターがオンのときは master → ハイパス → ローパス → destination
  // bgmFade は stopBgm のフェード専用の倍率、bgmGain・seGain・master は setVolume の音量
  private readonly bgmFade: GainNodeLike;
  private readonly bgmGain: GainNodeLike;
  private readonly seGain: GainNodeLike;
  private readonly master: GainNodeLike;

  private filters: { highpass: BiquadFilterNodeLike; lowpass: BiquadFilterNodeLike } | null = null;
  private speakerFilter = false;
  /** タブが裏に回ったとき、こちらから suspend したか */
  private suspendedByVisibility = false;
  /** bgmFade を 0 へ下げた（1 でない）可能性があるか。次の playBgm で 1 へ戻す */
  private fadeLowered = false;
  /** bgmFade に最後に予約した直線のフェード。今の値を gain.value を読まずに出すため（なければ 1 のまま） */
  private fadeRamp: { startTime: number; startValue: number; endTime: number; endValue: number } | null = null;
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
    visibility?: VisibilityLike,
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

    rt.onWarning((message) => this.emit('warning', message));
    visibility?.addEventListener('visibilitychange', () => this.onVisibilityChange(visibility));
  }

  /** destination の直前のノード。分析器をつなぐ用。スピーカー風フィルターのオン・オフで変わる */
  get output(): AudioNode {
    const last = this.speakerFilter && this.filters ? this.filters.lowpass : this.master;
    return last as unknown as AudioNode;
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
    let engine: FmEngine;
    try {
      engine = await FmEngine.create(context);
      for (const { program, voice } of entries) engine.registerVoice(program, voice);
    } catch (e) {
      // 自分で作った context は、使われないまま残らないよう閉じる（渡された context は呼び出し側のものなので閉じない）
      if (!options.context) await context.close().catch(() => {});
      throw e;
    }
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
    this.bgm = { player: new Player(this.rt, song, this.playerOptions()), nextLoopPass: 1, fadeEnd: null };
    if (this.fadeLowered) {
      // 前の曲の尾が跳ね上がらないよう、新しい曲の頭の時刻に向けて今の値から 1 へ戻す
      this.rampFade(this.ctx.currentTime, 1, this.ctx.currentTime + START_MARGIN_SECONDS);
      this.fadeLowered = false;
    }
    this.pumpNow(this.bgm.player);
    this.ensureTimer();
  }

  /**
   * BGM を止める（送り済みの予約を捨て、持続中のノートをキーオフする）。loop・end は呼ばない。
   * fadeMs が 0 より大きければ、その間に音量を 0 まで下げてから止める（フェード中も曲は進む）。省くか 0 ならすぐ止める。
   * フェード中にもう一度呼んだら、終わりが早いほうに合わせる
   */
  stopBgm(options: { fadeMs?: number } = {}): void {
    if (typeof options !== 'object' || options === null) {
      throw new RangeError('stopBgm: options は { fadeMs } の形にしてください');
    }
    const fadeMs = options.fadeMs ?? 0;
    if (typeof fadeMs !== 'number' || !Number.isFinite(fadeMs) || fadeMs < 0) {
      throw new RangeError(`stopBgm: fadeMs は 0 以上の有限の数にしてください（fadeMs=${String(fadeMs)}）`);
    }
    const bgm = this.bgm;
    if (!bgm) return;
    // 一時停止中は鳴っていないので、フェードせずに止める
    if (fadeMs === 0 || bgm.player.paused) {
      this.dropBgm(bgm);
      return;
    }
    const now = this.ctx.currentTime;
    const end = now + fadeMs / 1000;
    if (bgm.fadeEnd !== null && end >= bgm.fadeEnd) return;
    this.rampFade(now, 0, end);
    bgm.fadeEnd = end;
    this.fadeLowered = true;
  }

  /** BGM を一時停止する（持続中のノートをキーオフし、曲の位置を止める）。フェード中なら、フェードを終えたものとしてすぐ止める */
  pauseBgm(): void {
    const bgm = this.bgm;
    if (!bgm || bgm.player.paused) return;
    if (bgm.fadeEnd !== null) {
      this.dropBgm(bgm);
      return;
    }
    bgm.player.pause(this.safeFrame());
  }

  /** 一時停止した BGM を、止めた位置から続ける。一時停止中でなければ何もしない */
  resumeBgm(): void {
    const bgm = this.bgm;
    if (!bgm || !bgm.player.paused) return;
    bgm.player.resume(this.safeFrame());
    // 最初の tick が遅れても、再開後の最初のノートが消えないように
    this.pumpNow(bgm.player);
    this.ensureTimer();
  }

  /** master・bgm・se の音量（0〜1）。渡したものだけ変える。持続中のノートにもすぐ効く */
  setVolume(volume: { master?: number; bgm?: number; se?: number }): void {
    if (typeof volume !== 'object' || volume === null) {
      throw new RangeError('setVolume: volume は { master, bgm, se } の形にしてください');
    }
    const targets: Array<[string, number | undefined, GainNodeLike]> = [
      ['master', volume.master, this.master],
      ['bgm', volume.bgm, this.bgmGain],
      ['se', volume.se, this.seGain],
    ];
    // 値を変える前に全部を検査する
    for (const [name, value] of targets) if (value !== undefined) requireVolume(name, value);
    const now = this.ctx.currentTime;
    for (const [, value, node] of targets) {
      if (value !== undefined) node.gain.setTargetAtTime(value, now, VOLUME_TIME_CONSTANT);
    }
  }

  /** 出力の最後にハイパス（300 Hz）とローパス（7000 Hz）を入れて、小さなスピーカー風にする。既定はオフ */
  setSpeakerFilter(enabled: boolean): void {
    if (typeof enabled !== 'boolean') {
      throw new RangeError(`setSpeakerFilter: enabled は true か false にしてください（enabled=${String(enabled)}）`);
    }
    if (enabled === this.speakerFilter) return;
    this.master.disconnect();
    if (enabled) {
      if (!this.filters) {
        const highpass = this.ctx.createBiquadFilter();
        highpass.type = 'highpass';
        highpass.frequency.value = SPEAKER_HIGHPASS_HZ;
        const lowpass = this.ctx.createBiquadFilter();
        lowpass.type = 'lowpass';
        lowpass.frequency.value = SPEAKER_LOWPASS_HZ;
        this.filters = { highpass, lowpass };
      }
      const { highpass, lowpass } = this.filters;
      this.master.connect(highpass);
      highpass.connect(lowpass);
      lowpass.connect(this.ctx.destination);
    } else if (this.filters) {
      this.filters.highpass.disconnect();
      this.filters.lowpass.disconnect();
      this.master.connect(this.ctx.destination);
    }
    this.speakerFilter = enabled;
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
    const player = new Player(se, once, this.playerOptions());
    this.sePlayers.add(player);
    this.pumpNow(player);
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

  /** bgmFade を、今の値から endTime に endValue になる直線へ予約し直す */
  private rampFade(now: number, endValue: number, endTime: number): void {
    const startValue = this.fadeValueAt(now);
    const gain = this.bgmFade.gain;
    gain.cancelScheduledValues(now);
    gain.setValueAtTime(startValue, now);
    gain.linearRampToValueAtTime(endValue, endTime);
    this.fadeRamp = { startTime: now, startValue, endTime, endValue };
  }

  /** 予約したフェードの、time での値（直線の補間）。何も予約していなければ 1 */
  private fadeValueAt(time: number): number {
    const r = this.fadeRamp;
    if (r === null) return 1;
    if (time >= r.endTime) return r.endValue;
    if (time <= r.startTime) return r.startValue;
    return r.startValue + ((r.endValue - r.startValue) * (time - r.startTime)) / (r.endTime - r.startTime);
  }

  /**
   * 一時停止・再開の時刻（フレーム）。currentTime より START_MARGIN 先。
   * すでに音源へ送り済みで、この余裕の中で鳴り始めるノートは持続中として扱う（再開後に鳴らし直さない）
   */
  private safeFrame(): number {
    return (this.ctx.currentTime + START_MARGIN_SECONDS) * this.ctx.sampleRate;
  }

  /** 鳴らし始めた直後に 1 回送る。最初の tick が遅れても、最初のノートが消えないように */
  private pumpNow(player: Player): void {
    const now = this.ctx.currentTime * this.ctx.sampleRate;
    player.pump(now, now + LOOKAHEAD_SECONDS * this.ctx.sampleRate);
  }

  private emit(type: EventType, message?: string): void {
    for (const handler of [...this.handlers[type]]) {
      try {
        handler(message ?? '');
      } catch (e) {
        // 1 つの handler の例外で、tick の残りや他の handler を飛ばさない。例外は握りつぶさず、あとで投げ直す
        queueMicrotask(() => {
          throw e;
        });
      }
    }
  }

  private ensureTimer(): void {
    if (this.timer === null) this.timer = setInterval(() => this.tick(), PUMP_INTERVAL_MS);
  }

  private tick(): void {
    const sampleRate = this.ctx.sampleRate;
    const now = this.ctx.currentTime * sampleRate;
    const horizon = now + LOOKAHEAD_SECONDS * sampleRate;

    const bgm = this.bgm;
    if (bgm && bgm.fadeEnd !== null && this.ctx.currentTime >= bgm.fadeEnd) {
      // 出力が 0 になったので、リリースの尾やドラムが残らないよう BGM 側のボイスを止める（0 の出力を止めるので、プチッとは鳴らない）
      this.dropBgm(bgm);
      this.rt.silence('bgm');
    } else if (bgm && !bgm.player.paused) {
      // 一時停止中は何も送らず、loop・end も呼ばない
      bgm.player.pump(now, horizon);
      this.fireBgmEvents(bgm, now);
    }
    for (const player of this.sePlayers) {
      player.pump(now, horizon);
      if (player.finished) this.sePlayers.delete(player);
    }

    const bgmIdle = this.bgm === null || this.bgm.player.paused;
    if (bgmIdle && this.sePlayers.size === 0 && this.timer !== null) {
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

  /**
   * BGM をすぐ止めて捨てる。bgmFade は戻さない（cancel はキーオフするだけでリリースの尾が残り、
   * Worklet への届きも遅れるので、戻すと尾が全音量で鳴る）。1 へ戻すのは次の playBgm
   */
  private dropBgm(bgm: BgmState): void {
    bgm.player.stop();
    this.bgm = null;
  }

  private onVisibilityChange(visibility: VisibilityLike): void {
    if (visibility.hidden) {
      if (this.ctx.state !== 'running') return;
      this.suspendedByVisibility = true;
      this.ctx.suspend().catch((e: unknown) => this.emit('warning', `AudioContext を止められませんでした：${String(e)}`));
    } else if (this.suspendedByVisibility) {
      this.suspendedByVisibility = false;
      this.ctx.resume().catch((e: unknown) => this.emit('warning', `AudioContext を再開できませんでした：${String(e)}`));
    }
  }
}
