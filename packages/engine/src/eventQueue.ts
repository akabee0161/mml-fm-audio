/** サンプル時刻つきのイベントを時刻順に保持する */
export class EventQueue<E extends { time: number }> {
  private readonly items: E[] = [];
  private readonly due: Array<{ offset: number; event: E }> = [];

  /** 時刻順に入れる。同じ時刻は入れた順を保つ */
  push(event: E): void {
    let i = this.items.length;
    while (i > 0 && this.items[i - 1]!.time > event.time) i--;
    this.items.splice(i, 0, event);
  }

  /**
   * [blockStart, blockStart + blockLength) より前のイベントを取り出す。過去のものは offset 0。
   * 音声処理のスレッドでブロックごとに呼ぶため、返す配列は使い回す（次に呼ぶまでに読み終えること）
   */
  takeDue(blockStart: number, blockLength: number): readonly { offset: number; event: E }[] {
    const end = blockStart + blockLength;
    const due = this.due;
    due.length = 0;
    while (this.items.length > 0 && this.items[0]!.time < end) {
      const event = this.items.shift()!;
      // offset は配列の添字になるので整数にする
      due.push({ offset: Math.max(0, Math.floor(event.time - blockStart)), event });
    }
    return due;
  }

  /** まだ取り出していないイベントのうち、predicate に合うものを捨てる。残りの順番は保つ */
  removeWhere(predicate: (event: E) => boolean): void {
    let kept = 0;
    for (const event of this.items) {
      if (!predicate(event)) this.items[kept++] = event;
    }
    this.items.length = kept;
  }

  get size(): number {
    return this.items.length;
  }
}
