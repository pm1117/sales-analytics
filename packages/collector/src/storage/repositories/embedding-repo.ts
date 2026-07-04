import { toVectorLiteral, type Db } from "../db";

export interface EmbeddingRow {
  contentId: string;
  companyId: string;
  chunkIndex: number;
  chunkText: string;
  contentHash: Buffer;
  sourceUrl: string;
  embedding: Float32Array;
  model: string;
}

export interface EmbeddingHit {
  contentId: string;
  chunkText: string;
  sourceUrl: string;
  distance: number;
}

export class EmbeddingRepo {
  constructor(private readonly db: Db) {}

  /** content 内の既存 chunk hash 集合（未変更 chunk の再 embed 回避）。 */
  async existingHashes(contentId: string): Promise<Set<string>> {
    const rows = await this.db.query<{ content_hash: Buffer }>(
      `SELECT content_hash FROM embeddings WHERE content_id = $1`,
      [contentId],
    );
    return new Set(rows.map((r) => r.content_hash.toString("hex")));
  }

  /**
   * content 単位で最新 chunk 集合に置換する（chunk_index の穴を残さない）。
   * 変更のあった chunk だけを渡す運用でも、まとめて置換でも整合するよう upsert する。
   */
  async upsertChunks(rows: EmbeddingRow[]): Promise<void> {
    if (rows.length === 0) return;
    await this.db.tx(async (client) => {
      for (const r of rows) {
        await client.query(
          `INSERT INTO embeddings
             (content_id, company_id, chunk_index, chunk_text, content_hash, source_url, embedding, model)
           VALUES ($1,$2,$3,$4,$5,$6,$7::vector,$8)
           ON CONFLICT (content_id, chunk_index) DO UPDATE
             SET chunk_text = EXCLUDED.chunk_text,
                 content_hash = EXCLUDED.content_hash,
                 source_url = EXCLUDED.source_url,
                 embedding = EXCLUDED.embedding,
                 model = EXCLUDED.model`,
          [
            r.contentId,
            r.companyId,
            r.chunkIndex,
            r.chunkText,
            r.contentHash,
            r.sourceUrl,
            toVectorLiteral(r.embedding),
            r.model,
          ],
        );
      }
    });
  }

  /** company スコープの近傍検索（cosine）。 */
  async search(
    companyId: string,
    queryVec: Float32Array,
    k: number,
  ): Promise<EmbeddingHit[]> {
    const rows = await this.db.query<{
      content_id: string;
      chunk_text: string;
      source_url: string;
      distance: number;
    }>(
      `SELECT content_id, chunk_text, source_url,
              embedding <=> $2::vector AS distance
         FROM embeddings
        WHERE company_id = $1
        ORDER BY embedding <=> $2::vector
        LIMIT $3`,
      [companyId, toVectorLiteral(queryVec), k],
    );
    return rows.map((r) => ({
      contentId: r.content_id,
      chunkText: r.chunk_text,
      sourceUrl: r.source_url,
      distance: r.distance,
    }));
  }
}
