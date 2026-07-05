import { z } from "zod";

/**
 * .env を zod で検証し、型付き Env を単一エクスポートする（起動時 fail-fast）。
 * dev では Node 組み込みの process.loadEnvFile で .env を読み込む（依存追加なし）。
 */

// "true"/"false" 文字列を厳密に真偽へ（z.coerce.boolean は "false" も true にするため使わない）
const boolFromEnv = (def: boolean) =>
  z
    .enum(["true", "false"])
    .transform((v) => v === "true")
    .default(def ? "true" : "false");

const intFromEnv = (def: number) => z.coerce.number().int().default(def);

const EnvSchema = z.object({
  // --- DB ---
  DATABASE_URL: z.string().url(),
  DB_POOL_MAX: intFromEnv(10),

  // --- Crawler service ---
  CRAWLER_BASE_URL: z.string().url().default("http://localhost:8000"),
  CONCURRENT_CRAWL_LIMIT: intFromEnv(4),
  CRAWL_TIMEOUT_MS: intFromEnv(30_000),
  CRAWL_CONNECT_TIMEOUT_MS: intFromEnv(5_000),
  LIGHT_HTTP_TIMEOUT_MS: intFromEnv(10_000),
  FETCH_MAX_RETRIES: intFromEnv(2),
  FETCH_RETRY_BASE_MS: intFromEnv(500),

  // --- Compliance ---
  USER_AGENT: z
    .string()
    .default(
      "SalesAnalyticsBot/0.1 (+https://example.com/bot; contact: bot@example.com)",
    ),
  CONTACT_EMAIL: z.string().email().default("bot@example.com"),
  ROBOTS_CACHE_TTL_SEC: intFromEnv(86_400),
  DEFAULT_CRAWL_DELAY_MS: intFromEnv(2_000),
  // 同一ドメインへの連続リクエスト間隔の下限とランダム揺らぎ幅。
  // 実効間隔 = max(robotsのCrawl-delay, MIN) + random(0..JITTER)。
  CRAWL_DELAY_MIN_MS: intFromEnv(10_000),
  CRAWL_DELAY_JITTER_MS: intFromEnv(10_000),
  DOMAIN_MAX_CONCURRENCY: intFromEnv(1),

  // --- Embedding ---
  EMBEDDING_PROVIDER: z.enum(["voyage", "openai"]).default("voyage"),
  EMBEDDING_MODEL: z.string().default("voyage-3"),
  EMBEDDING_DIM: intFromEnv(1536),
  VOYAGE_API_KEY: z.string().optional(),
  OPENAI_API_KEY: z.string().optional(),
  EMBED_BATCH_SIZE: intFromEnv(64),
  EMBED_CONCURRENCY: intFromEnv(2),

  // --- Managed crawl fallback (Gate4) ---
  MANAGED_CRAWL_ENABLED: boolFromEnv(false),
  MANAGED_CRAWL_PROVIDER: z.string().default("firecrawl"),
  FIRECRAWL_API_KEY: z.string().optional(),

  // --- Claude (カルテ生成時のみ) ---
  ANTHROPIC_API_KEY: z.string().optional(),
  DOSSIER_MODEL: z.string().default("claude-opus-4-8"),
  DOSSIER_MAX_CONTEXT_TOKENS: intFromEnv(180_000),

  // --- Fit 判定（シグナル抽出時のみ）。default は DOSSIER 側と同値 ---
  FIT_MODEL: z.string().default("claude-opus-4-8"),
  FIT_MAX_CONTEXT_TOKENS: intFromEnv(180_000),

  // --- Freshness cron ---
  FRESHNESS_POLL_CRON: z.string().default("0 */6 * * *"),
  FRESHNESS_POLL_ENABLED: boolFromEnv(true),
});

export type Env = z.infer<typeof EnvSchema>;

let cached: Env | undefined;

/** 検証済み Env を返す（初回に .env をロード + 検証。失敗時は throw）。 */
export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  if (cached) return cached;

  // Node 21+ の組み込みローダ。.env が無ければ黙って無視。
  const loader = (process as unknown as { loadEnvFile?: (p?: string) => void })
    .loadEnvFile;
  if (typeof loader === "function") {
    try {
      loader(".env");
    } catch {
      /* .env 不在は許容（本番は環境変数で注入） */
    }
  }

  const parsed = EnvSchema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  cached = parsed.data;
  return cached;
}
