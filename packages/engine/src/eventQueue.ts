/** サンプル時刻つきのイベントを時刻順に保持する */
export class EventQueue<E extends { time: number }> {
  private readonly items: E[] = [];

  /** 時刻順に入れる。同じ時刻は入れた順を保つ */
  push(event: E): void {
    let i = this.items.length;
    while (i > 0 && this.items[i - 1]!.time > event.time) i--;
    this.items.splice(i, 0, event);
  }

  /** [blockStart, blockStart + blockLength) より前のイベントを取り出す。過去のものは offset 0 */
  takeDue(blockStart: number, blockLength: number): Array<{ offset: number; event: E }> {
    const end = blockStart + blockLength;
    const due: Array<{ offset: number; event: E }> = [];
    while (this.items.length > 0 && this.items[0]!.time < end) {
      const event = this.items.shift()!;
      due.push({ offset: Math.max(0, event.time - blockStart), event });
    }
    return due;
  }

  get size(): number {
    return this.items.length;
  }
}
