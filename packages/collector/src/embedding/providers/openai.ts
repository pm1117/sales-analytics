import type { EmbeddingProvider } from "../embedding-provider";
import { normalizeTo1536 } from "../normalize";

/** OpenAI 埋め込みプロバイダ。text-embedding-3-large=3072 → 先頭 1536 に truncation。 */
export class OpenAIProvider implements EmbeddingProvider {
  readonly nativeDim: number;

  constructor(
    readonly model: string,
    private readonly apiKey: string,
  ) {
    this.nativeDim = model.includes("small") ? 1536 : 3072;
  }

  async embed(texts: string[]): Promise<Float32Array[]> {
    if (texts.length === 0) return [];
    const res = await fetch("https://api.openai.com/v1/embeddings", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({ model: this.model, input: texts }),
    });
    if (!res.ok) {
      throw new Error(`OpenAI embed failed: HTTP ${res.status}`);
    }
    const json = (await res.json()) as {
      data: Array<{ embedding: number[] }>;
    };
    return json.data.map((d) =>
      normalizeTo1536(Float32Array.from(d.embedding), this.nativeDim),
    );
  }
}
