import { Pool, type PoolClient, type QueryResultRow } from "pg";
import type { Env } from "@sa/shared";

/** pg Pool のラッパ。型付き query と単純なトランザクションヘルパを提供する。 */
export class Db {
  readonly pool: Pool;

  constructor(env: Env) {
    this.pool = new Pool({
      connectionString: env.DATABASE_URL,
      max: env.DB_POOL_MAX,
    });
  }

  async query<R extends QueryResultRow>(
    text: string,
    params: readonly unknown[] = [],
  ): Promise<R[]> {
    const res = await this.pool.query<R>(text, params as unknown[]);
    return res.rows;
  }

  async queryOne<R extends QueryResultRow>(
    text: string,
    params: readonly unknown[] = [],
  ): Promise<R | undefined> {
    const rows = await this.query<R>(text, params);
    return rows[0];
  }

  async tx<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await fn(client);
      await client.query("COMMIT");
      return result;
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

/** Float32Array を pgvector リテラル '[a,b,c]' に変換する。 */
export function toVectorLiteral(vec: Float32Array): string {
  return `[${Array.from(vec).join(",")}]`;
}
