import type { Env } from "@sa/shared";
import type { EmbeddingProvider } from "./embedding-provider";
import { VoyageProvider } from "./providers/voyage";
import { OpenAIProvider } from "./providers/openai";

/** EMBEDDING_PROVIDER に応じて実装を選択する。DB の vector(1536) は不変。 */
export function createEmbeddingProvider(env: Env): EmbeddingProvider {
  switch (env.EMBEDDING_PROVIDER) {
    case "voyage": {
      if (!env.VOYAGE_API_KEY) {
        throw new Error("VOYAGE_API_KEY is required for EMBEDDING_PROVIDER=voyage");
      }
      return new VoyageProvider(env.EMBEDDING_MODEL, env.VOYAGE_API_KEY);
    }
    case "openai": {
      if (!env.OPENAI_API_KEY) {
        throw new Error("OPENAI_API_KEY is required for EMBEDDING_PROVIDER=openai");
      }
      return new OpenAIProvider(env.EMBEDDING_MODEL, env.OPENAI_API_KEY);
    }
  }
}
