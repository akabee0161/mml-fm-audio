import './style.css';
import { FmEngine, validateVoice, type FmVoice, type ValidationError } from '@mml-fm-audio/engine';
import gmVoices from '../voices/ymf825/gm.json';
import unassignedVoices from '../voices/ymf825/unassigned.json';
import {
  ASSISTIVE_CLICK_HOLD_MS,
  MonoNoteTracker,
  PC_KEY_OFFSETS,
  isActivationKey,
  isAssistiveClick,
  keyLayout,
  noteName,
  parseVoiceJson,
  shiftBase,
} from './keyboard';
import { renderParams } from './params';

declare global {
  interface Window {
    __mmlFmAudio?: { peak(): number };
  }
}

/** Safari 16.4+ の Audio Session API。マナーモードでも鳴らすために使う */
interface NavigatorWithAudioSession extends Navigator {
  audioSession?: { type: string };
}

const OCTAVES = 2;

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

function listItems(list: HTMLElement, items: string[]): void {
  list.replaceChildren(
    ...items.map((text) => {
      const li = document.createElement('li');
      li.textContent = text;
      return li;
    }),
  );
}

function exposeDebug(analyser: AnalyserNode): void {
  const buffer = new Float32Array(analyser.fftSize);
  window.__mmlFmAudio = {
    peak() {
      analyser.getFloatTimeDomainData(buffer);
      return buffer.reduce((m, x) => Math.max(m, Math.abs(x)), 0);
    },
  };
}

function setup(engine: FmEngine, context: AudioContext): void {
  const voices = bundledVoices();
  const select = byId<HTMLSelectElement>('voice-select');
  const keyboard = byId('keyboard');
  const warnings = byId('warnings');
  const tracker = new MonoNoteTracker();
  let base = 60;
  let currentId: number | null = null;

  const addOption = (voice: FmVoice, index: number) => {
    const option = document.createElement('option');
    option.value = String(index);
    option.textContent = `${voice.id ?? '−'}: ${voice.name}`;
    select.appendChild(option);
  };

  const selectVoice = (voice: FmVoice) => {
    listItems(warnings, []);
    engine.registerVoice(0, voice);
    renderParams(byId('params'), voice);
  };

  const clearPressedHighlight = () => {
    keyboard.querySelectorAll('.key.pressed').forEach((el) => el.classList.remove('pressed'));
  };

  const press = (key: string, note: number) => {
    if (context.state !== 'running') void context.resume();
    if (currentId !== null) engine.noteOff(currentId);
    currentId = engine.noteOn(0, tracker.press(key, note));
    keyboard.querySelectorAll<HTMLElement>('.key').forEach((el) => {
      el.classList.toggle('pressed', Number(el.dataset.note) === note);
    });
  };

  const release = (key: string) => {
    if (!tracker.release(key)) return;
    if (currentId !== null) engine.noteOff(currentId);
    currentId = null;
    clearPressedHighlight();
  };

  const releaseAll = () => {
    if (!tracker.releaseAll()) return;
    if (currentId !== null) engine.noteOff(currentId);
    currentId = null;
    clearPressedHighlight();
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
  };

  voices.forEach(addOption);
  select.addEventListener('change', () => selectVoice(voices[Number(select.value)]!));
  if (voices[0]) selectVoice(voices[0]);

  engine.onWarning((message) => {
    const li = document.createElement('li');
    li.textContent = message;
    warnings.appendChild(li);
  });

  byId<HTMLInputElement>('quantize').addEventListener('change', (e) => {
    engine.setQuantize((e.target as HTMLInputElement).checked);
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
  keyboard.addEventListener('keyup', (e) => {
    const target = (e.target as HTMLElement).closest<HTMLElement>('.key');
    if (!target || !isActivationKey(e.key)) return;
    release(`focus:${target.dataset.note}`);
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
    if (new URLSearchParams(location.search).has('debug')) {
      const analyser = context.createAnalyser();
      engine.node.connect(analyser).connect(context.destination);
      exposeDebug(analyser);
    } else {
      engine.node.connect(context.destination);
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
