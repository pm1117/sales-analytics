import type { Env, Logger } from "@sa/shared";
import { chunkHashHex, contentHash } from "../compliance/url-canonical";
import type {
  EmbeddingRepo,
  EmbeddingRow,
} from "../storage/repositories/embedding-repo";
import type { ScrapedContentRepo } from "../storage/repositories/scraped-content-repo";
import { chunkMarkdown } from "./chunker";
import type { EmbeddingProvider } from "./embedding-provider";

/**
 * store 時 async embed。未変更 chunk（chunk hash 一致）は再 embed しない。
 * 収集時 LLM 禁止の唯一の例外（embed は生成より桁違いに安い）。
 */
export class EmbedPipeline {
  constructor(
    private readonly env: Env,
    private readonly logger: Logger,
    private readonly scrapedRepo: ScrapedContentRepo,
    private readonly embeddingRepo: EmbeddingRepo,
    private readonly provider: EmbeddingProvider,
  ) {}

  async run(contentId: string): Promise<void> {
    const content = await this.scrapedRepo.getById(contentId);
    if (!content || content.contentMd.trim().length === 0) return;

    const chunks = chunkMarkdown(content.contentMd);
    if (chunks.length === 0) return;

    const existing = await this.embeddingRepo.existingHashes(contentId);
    const pending = chunks.filter(
      (c) => !existing.has(chunkHashHex(c.text)),
    );
    if (pending.length === 0) return;

    const batchSize = this.env.EMBED_BATCH_SIZE;
    const rows: EmbeddingRow[] = [];
    for (let i = 0; i < pending.length; i += batchSize) {
      const batch = pending.slice(i, i + batchSize);
      const vectors = await this.provider.embed(batch.map((c) => c.text));
      for (let j = 0; j < batch.length; j++) {
        const chunk = batch[j];
        const vec = vectors[j];
        if (!chunk || !vec) continue;
        rows.push({
          contentId,
          companyId: content.companyId,
          chunkIndex: chunk.chunkIndex,
          chunkText: chunk.text,
          contentHash: contentHash(chunk.text),
          sourceUrl: content.canonicalUrl,
          embedding: vec,
          model: this.provider.model,
        });
      }
    }

    await this.embeddingRepo.upsertChunks(rows);
    this.logger.debug(
      { contentId, embedded: rows.length, total: chunks.length },
      "embedded chunks",
    );
  }
}
