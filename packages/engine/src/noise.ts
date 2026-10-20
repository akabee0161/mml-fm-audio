/** ドラム用のホワイトノイズ。種を固定できる擬似乱数（xorshift32） */
export class Noise {
  private state = 1;

  constructor(seed = 1) {
    this.reset(seed);
  }

  /** 種 0 は列が 0 のまま進まないため 1 に置き換える */
  reset(seed = 1): void {
    this.state = seed >>> 0 || 1;
  }

  /** −1 以上 1 未満の一様な値 */
  next(): number {
    let x = this.state;
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    this.state = x >>> 0;
    return (this.state / 2 ** 32) * 2 - 1;
  }
}
