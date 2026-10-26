/** 変換を止めるエラー。message は依頼者にそのまま見せる日本語。 */
export class ConvError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConvError';
  }
}
