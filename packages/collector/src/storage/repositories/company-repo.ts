import type { Company } from "@sa/shared";
import type { Db } from "../db";

interface CompanyRow {
  id: string;
  name: string;
  domain: string;
  aliases: string[];
  corp_number: string | null;
}

function mapRow(r: CompanyRow): Company {
  return {
    id: r.id,
    name: r.name,
    domain: r.domain,
    aliases: r.aliases,
    ...(r.corp_number !== null ? { corpNumber: r.corp_number } : {}),
  };
}

export class CompanyRepo {
  constructor(private readonly db: Db) {}

  async findByDomain(domain: string): Promise<Company | undefined> {
    const row = await this.db.queryOne<CompanyRow>(
      `SELECT id, name, domain, aliases, corp_number FROM companies WHERE domain = $1`,
      [domain],
    );
    return row ? mapRow(row) : undefined;
  }

  /** name/alias 一致で検索（ドメイン未確定入力の解決に使う）。 */
  async findByNameOrAlias(name: string): Promise<Company | undefined> {
    const row = await this.db.queryOne<CompanyRow>(
      `SELECT id, name, domain, aliases, corp_number
         FROM companies
        WHERE name = $1 OR $1 = ANY(aliases)
        LIMIT 1`,
      [name],
    );
    return row ? mapRow(row) : undefined;
  }

  /** domain を canonical キーに upsert。既存なら name/aliases を更新。 */
  async upsertByDomain(input: {
    name: string;
    domain: string;
    aliases?: string[];
    corpNumber?: string;
  }): Promise<Company> {
    const row = await this.db.queryOne<CompanyRow>(
      `INSERT INTO companies (name, domain, aliases, corp_number)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (domain) DO UPDATE
         SET name = EXCLUDED.name,
             aliases = EXCLUDED.aliases,
             updated_at = now()
       RETURNING id, name, domain, aliases, corp_number`,
      [
        input.name,
        input.domain,
        input.aliases ?? [],
        input.corpNumber ?? null,
      ],
    );
    // RETURNING は必ず 1 行返る
    return mapRow(row as CompanyRow);
  }
}
