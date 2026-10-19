import { OP_FIELDS, type FmVoice } from '@mml-fm-audio/engine';

/** 音色の値を読み取り専用の表で見せる */
export function renderParams(container: HTMLElement, voice: FmVoice): void {
  const summary = document.createElement('p');
  summary.textContent = `id: ${voice.id ?? 'なし'} / name: ${voice.name} / alg: ${voice.alg} / bo: ${voice.bo} / lfo: ${voice.lfo}`;

  const table = document.createElement('table');
  const head = table.createTHead().insertRow();
  head.appendChild(document.createElement('th'));
  voice.ops.forEach((_, i) => {
    const th = document.createElement('th');
    th.textContent = `op${i + 1}`;
    head.appendChild(th);
  });
  const body = table.createTBody();
  for (const field of OP_FIELDS) {
    const row = body.insertRow();
    const th = document.createElement('th');
    th.textContent = field;
    row.appendChild(th);
    for (const op of voice.ops) row.insertCell().textContent = String(op[field]);
  }
  container.replaceChildren(summary, table);
}
