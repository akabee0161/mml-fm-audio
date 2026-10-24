import './style.css';
import {
  FmEngine,
  MAX_VOICES,
  validateDrum,
  validateVoice,
  type DrumVoice,
  type FmVoice,
  type LoadReport,
  type ValidationError,
} from '@mml-fm-audio/engine';
import { Player, parseMml } from '@mml-fm-audio/sequencer';
import drumData from '../voices/custom/drums.json';
import gmVoices from '../voices/ymf825/gm.json';
import unassignedVoices from '../voices/ymf825/unassigned.json';
import {
  ASSISTIVE_CLICK_HOLD_MS,
  PC_KEY_OFFSETS,
  PolyNoteTracker,
  isActivationKey,
  isAssistiveClick,
  keyLayout,
  noteName,
  parseVoiceJson,
  shiftBase,
} from './keyboard';
import demoSong from './songs/m3-demo.mml?raw';
import { renderParams } from './params';
import { catchUpBar, scheduleBar } from './rhythm';

declare global {
  interface Window {
    __mmlFmAudio?: { peak(): number; peakLeft(): number; peakRight(): number };
  }
}

/** Safari 16.4+ の Audio Session API。マナーモードでも鳴らすために使う */
interface NavigatorWithAudioSession extends Navigator {
  audioSession?: { type: string };
}

const OCTAVES = 2;
/**
 * 鍵盤と 16 音ボタンで使う音色の番号。選んだ音色をここへ登録し直す。
 * 同梱の GM 音色に 127 番はなく、MML の @0 などとぶつからない
 */
const KEYBOARD_PROGRAM = 127;
/** 16 音ボタンの最低音（C3） */
const POLY_TEST_BASE = 48;
const RHYTHM_BPM = 120;
const RHYTHM_TICK_MS = 25;
const RHYTHM_LOOKAHEAD_SEC = 0.1;
const MML_TICK_MS = 25;
const MML_LOOKAHEAD_SEC = 0.1;
/** 再生ボタンから曲の頭までの余裕 */
const MML_START_DELAY_SEC = 0.05;

const DRUM_LABELS: Readonly<Record<string, string>> = {
  bd: 'バスドラム',
  sd: 'スネア',
  ch: 'クローズドハイハット',
  oh: 'オープンハイハット',
  cy: 'シンバル',
  lt: 'ロータム',
  ht: 'ハイタム',
  cp: 'クラップ',
};

function byId<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`#${id} がページにありません`);
  return el as T;
}

function bundledVoices(): FmVoice[] {
  const voices: FmVoice[] = [];
  for (const raw of [...gmVoices, ...unassignedVoices]) {
    const result = validateVoice(raw);
    if (result.ok) voices.push(result.voice);
    else console.error('同梱の音色が検証を通りません', raw, result.errors);
  }
  return voices;
}

function bundledDrums(): DrumVoice[] {
  const drums: DrumVoice[] = [];
  for (const raw of drumData) {
    const result = validateDrum(raw);
    if (result.ok) drums.push(result.voice);
    else console.error('同梱のドラムが検証を通りません', raw, result.errors);
  }
  return drums;
}

function listItems(list: HTMLElement, items: string[]): void {
  list.replaceChildren(
    ...items.map((text) => {
      const li = document.createElement('li');
      li.textContent = text;
      return li;
    }),
  );
}

function exposeDebug(left: AnalyserNode, right: AnalyserNode): void {
  const buffer = new Float32Array(left.fftSize);
  const peakOf = (analyser: AnalyserNode) => {
    analyser.getFloatTimeDomainData(buffer);
    return buffer.reduce((m, x) => Math.max(m, Math.abs(x)), 0);
  };
  window.__mmlFmAudio = {
    peak: () => Math.max(peakOf(left), peakOf(right)),
    peakLeft: () => peakOf(left),
    peakRight: () => peakOf(right),
  };
}

function formatLoad(report: LoadReport): string {
  const max = report.maxMs === null ? '−' : report.maxMs.toFixed(3);
  const clock = report.clock === 'performance' ? 'performance.now' : 'Date.now（平均のみ）';
  return [
    `平均 ${report.avgMs.toFixed(3)} ms / 最大 ${max} ms`,
    `1 ブロック ${report.blockMs.toFixed(3)} ms に対して ${report.percent.toFixed(1)} %`,
    `鳴っていたボイス数（最大） ${report.maxVoices}`,
    `時計 ${clock}`,
  ].join('\n');
}

/** MML の欄：解析してエラーを出し、なければ Player で先読みして鳴らす */
function setupMml(engine: FmEngine, context: AudioContext, wake: () => void): void {
  const textarea = byId<HTMLTextAreaElement>('mml');
  const errorList = byId('mml-errors');
  let player: Player | undefined;
  let timer: number | undefined;

  textarea.value = demoSong;

  const stopTimer = () => {
    if (timer !== undefined) {
      window.clearInterval(timer);
      timer = undefined;
    }
  };
  const stop = () => {
    stopTimer();
    player?.stop();
    player = undefined;
  };

  byId('mml-play').addEventListener('click', () => {
    wake();
    const song = parseMml(textarea.value);
    if (song.errors.length > 0) {
      // エラーが 1 つでもあれば再生しない。鳴っている再生も止める
      stop();
      listItems(errorList, song.errors.map((e) => `行 ${e.line}・列 ${e.column}：${e.message}`));
      return;
    }
    listItems(errorList, []);
    stop();
    const rate = context.sampleRate;
    const current = new Player(engine, song, {
      sampleRate: rate,
      startFrame: Math.round((context.currentTime + MML_START_DELAY_SEC) * rate),
    });
    player = current;
    const tick = () => {
      const now = context.currentTime * rate;
      current.pump(now, now + MML_LOOKAHEAD_SEC * rate);
      // 終わった曲は、送り済みの最後の音が鳴り終わるまで cancel せず、タイマーだけ止める
      if (current.finished && player === current) stopTimer();
    };
    tick();
    if (player === current) timer = window.setInterval(tick, MML_TICK_MS);
  });

  byId('mml-stop').addEventListener('click', stop);
}

function setup(engine: FmEngine, context: AudioContext): void {
  const voices = bundledVoices();
  const select = byId<HTMLSelectElement>('voice-select');
  const keyboard = byId('keyboard');
  const warnings = byId('warnings');
  const panInput = byId<HTMLInputElement>('pan');
  const tracker = new PolyNoteTracker();
  /** 押しているキー → 鳴らしているノート（鍵盤の色付け用） */
  const heldNotes = new Map<string, number>();
  let base = 60;

  const pan = () => Number(panInput.value);
  const wake = () => {
    if (context.state !== 'running') void context.resume();
  };

  const addOption = (voice: FmVoice, index: number) => {
    const option = document.createElement('option');
    option.value = String(index);
    option.textContent = `${voice.id ?? '−'}: ${voice.name}`;
    select.appendChild(option);
  };

  const selectVoice = (voice: FmVoice) => {
    listItems(warnings, []);
    engine.registerVoice(KEYBOARD_PROGRAM, voice);
    renderParams(byId('params'), voice);
  };

  const highlight = () => {
    const notes = new Set(heldNotes.values());
    keyboard.querySelectorAll<HTMLElement>('.key').forEach((el) => {
      el.classList.toggle('pressed', notes.has(Number(el.dataset.note)));
    });
  };

  const press = (key: string, note: number) => {
    if (!tracker.press(key)) return;
    wake();
    tracker.bind(key, engine.noteOn(KEYBOARD_PROGRAM, note, { pan: pan() }));
    heldNotes.set(key, note);
    highlight();
  };

  const release = (key: string) => {
    const id = tracker.release(key);
    if (id !== undefined) engine.noteOff(id);
    if (heldNotes.delete(key)) highlight();
  };

  const releaseAll = () => {
    for (const id of tracker.releaseAll()) engine.noteOff(id);
    heldNotes.clear();
    highlight();
  };

  const renderKeyboard = () => {
    keyboard.replaceChildren(
      ...keyLayout(base, OCTAVES).map((key) => {
        const el = document.createElement('button');
        el.type = 'button';
        el.className = `key ${key.black ? 'black' : 'white'}`;
        el.dataset.note = String(key.note);
        el.title = key.label;
        if (key.note % 12 === 0) el.textContent = key.label;
        return el;
      }),
    );
    byId('octave-label').textContent = `${noteName(base)}〜${noteName(base + OCTAVES * 12)}`;
    highlight();
  };

  voices.forEach(addOption);
  select.addEventListener('change', () => selectVoice(voices[Number(select.value)]!));
  if (voices[0]) selectVoice(voices[0]);

  for (const drum of bundledDrums()) {
    engine.registerVoice(drum.id, drum);
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'drum';
    button.dataset.drum = drum.name;
    button.textContent = `${drum.name} ${DRUM_LABELS[drum.name] ?? ''}`;
    button.addEventListener('click', () => {
      wake();
      engine.noteOn(drum.id, 60, { pan: pan() });
    });
    byId('drums').appendChild(button);
  }

  // MML の @N で使う GM 音色を、それぞれの id に登録する（ドラムは上で 128〜135 に登録済み）
  for (const raw of gmVoices) {
    const result = validateVoice(raw);
    if (!result.ok) continue; // bundledVoices() がすでにエラーを出している
    const id = result.voice.id;
    if (id !== null && Number.isInteger(id) && id >= 0 && id <= 127 && id !== KEYBOARD_PROGRAM) engine.registerVoice(id, result.voice);
  }

  setupMml(engine, context, wake);

  engine.onWarning((message) => {
    const li = document.createElement('li');
    li.textContent = message;
    warnings.appendChild(li);
  });

  byId<HTMLInputElement>('quantize').addEventListener('change', (e) => {
    engine.setQuantize((e.target as HTMLInputElement).checked);
  });

  panInput.addEventListener('input', () => {
    byId('pan-value').textContent = panInput.value;
  });

  // 16 音を鳴らし続け、もう一度押すと止める
  const polyButton = byId<HTMLButtonElement>('poly-test');
  let polyIds: number[] = [];
  polyButton.addEventListener('click', () => {
    wake();
    if (polyIds.length > 0) {
      for (const id of polyIds) engine.noteOff(id);
      polyIds = [];
      polyButton.textContent = `${MAX_VOICES} 音を鳴らす`;
      return;
    }
    // C3 から 2 半音おきに、2 オクターブ半に収める
    polyIds = Array.from({ length: MAX_VOICES }, (_, i) =>
      engine.noteOn(KEYBOARD_PROGRAM, POLY_TEST_BASE + i * 2, { pan: pan() }),
    );
    polyButton.textContent = `${MAX_VOICES} 音を止める`;
  });
  polyButton.textContent = `${MAX_VOICES} 音を鳴らす`;

  // リズム：メインスレッドから先読みして、サンプル時刻付きで送る（spec §2.2）
  const rhythmButton = byId<HTMLButtonElement>('rhythm');
  let rhythmTimer: number | undefined;
  let nextBar = 0;
  const barFrames = (60 / RHYTHM_BPM) * 4 * context.sampleRate;
  const scheduleAhead = () => {
    const now = context.currentTime * context.sampleRate;
    nextBar = catchUpBar(nextBar, now, barFrames);
    const horizon = now + RHYTHM_LOOKAHEAD_SEC * context.sampleRate;
    while (nextBar < horizon) {
      for (const { time, program } of scheduleBar(nextBar, context.sampleRate, RHYTHM_BPM)) {
        engine.noteOn(program, 60, { pan: pan(), time });
      }
      nextBar += barFrames;
    }
  };
  rhythmButton.addEventListener('click', () => {
    wake();
    if (rhythmTimer !== undefined) {
      window.clearInterval(rhythmTimer);
      rhythmTimer = undefined;
      rhythmButton.textContent = 'リズムを鳴らす';
      return;
    }
    nextBar = Math.round((context.currentTime + 0.05) * context.sampleRate);
    scheduleAhead();
    rhythmTimer = window.setInterval(scheduleAhead, RHYTHM_TICK_MS);
    rhythmButton.textContent = 'リズムを止める';
  });

  const loadText = byId('load');
  engine.onLoad((report) => {
    loadText.textContent = formatLoad(report);
  });
  byId<HTMLInputElement>('load-toggle').addEventListener('change', (e) => {
    const enabled = (e.target as HTMLInputElement).checked;
    engine.setLoadReport(enabled);
    loadText.hidden = !enabled;
    if (enabled) loadText.textContent = '計測中…（1 秒ごとに更新）';
  });

  byId('octave-down').addEventListener('click', () => {
    base = shiftBase(base, -1);
    renderKeyboard();
  });
  byId('octave-up').addEventListener('click', () => {
    base = shiftBase(base, 1);
    renderKeyboard();
  });

  keyboard.addEventListener('pointerdown', (e) => {
    const target = (e.target as HTMLElement).closest<HTMLElement>('.key');
    if (!target) return;
    e.preventDefault();
    press(`pointer:${e.pointerId}`, Number(target.dataset.note));
  });
  for (const type of ['pointerup', 'pointercancel'] as const) {
    window.addEventListener(type, (e) => release(`pointer:${e.pointerId}`));
  }

  keyboard.addEventListener('keydown', (e) => {
    const target = (e.target as HTMLElement).closest<HTMLElement>('.key');
    if (!target || !isActivationKey(e.key)) return;
    e.preventDefault();
    if (e.repeat) return;
    press(`focus:${target.dataset.note}`, Number(target.dataset.note));
  });
  // 押している間に Tab でフォーカスが別の鍵や鍵盤の外へ移っても止まるよう、
  // 離した時点のフォーカス先ではなく、押している focus: の音をすべて離す
  window.addEventListener('keyup', (e) => {
    if (!isActivationKey(e.key)) return;
    for (const id of tracker.releaseMatching('focus:')) engine.noteOff(id);
    for (const key of [...heldNotes.keys()]) if (key.startsWith('focus:')) heldNotes.delete(key);
    highlight();
  });
  // スクリーンリーダー等が pointerdown/keydown を経由せず直接発火する click（AT 操作）。
  // マウス/タッチの click（detail >= 1）や、上の keydown/keyup で処理済みの Enter/Space による
  // click（それらは preventDefault 済みなので発生しない）とは区別する。
  keyboard.addEventListener('click', (e) => {
    if (!isAssistiveClick(e.detail)) return;
    const target = (e.target as HTMLElement).closest<HTMLElement>('.key');
    if (!target) return;
    const note = Number(target.dataset.note);
    const key = `assistive-click:${note}`;
    press(key, note);
    setTimeout(() => release(key), ASSISTIVE_CLICK_HOLD_MS);
  });

  window.addEventListener('keydown', (e) => {
    if (e.repeat || e.target instanceof HTMLTextAreaElement) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const offset = PC_KEY_OFFSETS[e.key.toLowerCase()];
    if (offset === undefined) return;
    press(`key:${e.key.toLowerCase()}`, base + offset);
  });
  window.addEventListener('keyup', (e) => release(`key:${e.key.toLowerCase()}`));
  window.addEventListener('blur', releaseAll);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) releaseAll();
  });

  byId('load-json').addEventListener('click', () => {
    const errorList = byId('json-errors');
    const result = parseVoiceJson(byId<HTMLTextAreaElement>('voice-json').value);
    if (!result.ok) {
      listItems(errorList, result.errors.map((e: ValidationError) => `${e.path || '(全体)'}: ${e.message}`));
      return;
    }
    listItems(errorList, []);
    voices.push(result.voice);
    addOption(result.voice, voices.length - 1);
    select.value = String(voices.length - 1);
    selectVoice(result.voice);
  });

  renderKeyboard();
}

byId('start').addEventListener('click', async () => {
  const button = byId<HTMLButtonElement>('start');
  const errorText = byId('start-error');
  button.disabled = true;
  let context: AudioContext | undefined;
  try {
    const audioSession = (navigator as NavigatorWithAudioSession).audioSession;
    if (audioSession) audioSession.type = 'playback';
    context = new AudioContext();
    void context.resume();
    const engine = await FmEngine.create(context);
    // 出力 0 が BGM、出力 1 が効果音。Task 7 で FmAudio に置き換えるまでは両方をそのまま出す
    engine.node.connect(context.destination, 0);
    engine.node.connect(context.destination, 1);
    if (new URLSearchParams(location.search).has('debug')) {
      const splitter = context.createChannelSplitter(2);
      const left = context.createAnalyser();
      const right = context.createAnalyser();
      engine.node.connect(splitter, 0);
      engine.node.connect(splitter, 1);
      splitter.connect(left, 0);
      splitter.connect(right, 1);
      exposeDebug(left, right);
    }
    await context.resume();
    setup(engine, context);
    button.hidden = true;
    byId('controls').hidden = false;
  } catch (e) {
    if (context) void context.close();
    button.disabled = false;
    errorText.hidden = false;
    errorText.textContent = `音源を開始できませんでした：${e instanceof Error ? e.message : String(e)}`;
  }
});
