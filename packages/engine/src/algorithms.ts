// YMF825 の IF 仕様書（algo.png）の結線。添字は 0 始まり（op1 = 0）。
// modulators[i] は op(i+1) を変調するオペレーター。常に i より前の番号なので、0 から順に計算できる。

export interface Algorithm {
  opCount: 2 | 4;
  modulators: number[][];
  carriers: number[];
  /** 帰還が有効なオペレーター */
  feedback: number[];
}

export const ALGORITHMS: readonly Algorithm[] = [
  { opCount: 2, modulators: [[], [0]], carriers: [1], feedback: [0] },
  { opCount: 2, modulators: [[], []], carriers: [0, 1], feedback: [0] },
  { opCount: 4, modulators: [[], [], [], []], carriers: [0, 1, 2, 3], feedback: [0, 2] },
  { opCount: 4, modulators: [[], [], [1], [0, 2]], carriers: [3], feedback: [0] },
  { opCount: 4, modulators: [[], [0], [1], [2]], carriers: [3], feedback: [0] },
  { opCount: 4, modulators: [[], [0], [], [2]], carriers: [1, 3], feedback: [0, 2] },
  { opCount: 4, modulators: [[], [], [1], [2]], carriers: [0, 3], feedback: [0] },
  { opCount: 4, modulators: [[], [], [1], []], carriers: [0, 2, 3], feedback: [0] },
];
