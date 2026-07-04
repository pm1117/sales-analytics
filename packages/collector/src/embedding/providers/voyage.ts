import type { EmbeddingProvider } from "../embedding-provider";
import { normalizeTo1536 } from "../normalize";

/** Voyage AI 埋め込みプロバイダ。日本語品質×コストで MVP 既定。 */
export class VoyageProvider implements EmbeddingProvider {
  readonly nativeDim = 1024; // voyage-3 系の代表値

  constructor(
    readonly model: string,
    private readonly apiKey: string,
  ) {}

  async embed(texts: string[]): Promise<Float32Array[]> {
    if (texts.length === 0) return [];
    const res = await fetch("https://api.voyageai.com/v1/embeddings", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({ model: this.model, input: texts }),
    });
    if (!res.ok) {
      throw new Error(`Voyage embed failed: HTTP ${res.status}`);
    }
    const json = (await res.json()) as {
      data: Array<{ embedding: number[] }>;
    };
    return json.data.map((d) =>
      normalizeTo1536(Float32Array.from(d.embedding), this.nativeDim),
    );
  }
}
