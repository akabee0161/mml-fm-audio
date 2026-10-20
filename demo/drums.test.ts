import { validateDrum } from '@mml-fm-audio/engine';
import drums from '../voices/custom/drums.json';

describe('voices/custom/drums.json', () => {
  it('8 種が設計書 §5 の番号と名前で並ぶ', () => {
    expect(drums.map((d) => [d.id, d.name])).toEqual([
      [128, 'bd'], [129, 'sd'], [130, 'ch'], [131, 'oh'], [132, 'cy'], [133, 'lt'], [134, 'ht'], [135, 'cp'],
    ]);
  });

  it.each(drums.map((d) => [d.name, d] as const))('%s が検証を通る', (_name, drum) => {
    const result = validateDrum(drum);
    expect(result.ok ? [] : result.errors).toEqual([]);
  });
});
