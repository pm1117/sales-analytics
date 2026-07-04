/** 埋め込みアダプタ。プロバイダを差し替えても DB は vector(1536) 固定のまま。 */
export interface EmbeddingProvider {
  readonly model: string;
  /** プロバイダのネイティブ次元（例: voyage-3=1024, openai-3-large=3072）。 */
  readonly nativeDim: number;
  /** 返却は常に 1536 次元に正規化済み（各要素は Float32Array, length===1536）。 */
  embed(texts: string[]): Promise<Float32Array[]>;
}

export const FIXED_DIM = 1536;
