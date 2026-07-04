import { createHash } from "node:crypto";

/** トラッキング系クエリは正規化時に除去する。 */
const TRACKING_PARAMS = new Set([
  "gclid",
  "fbclid",
  "ref",
  "ref_src",
  "mc_cid",
  "mc_eid",
]);

function isTracking(key: string): boolean {
  return key.startsWith("utm_") || TRACKING_PARAMS.has(key);
}

/**
 * URL を正規化して一意キー（canonical_url）を作る。
 * scheme 小文字化・www 除去・既定ポート除去・末尾スラッシュ統一・
 * トラッキング除去・クエリキー昇順・fragment 除去。
 */
export function canonicalizeUrl(rawUrl: string): string {
  const u = new URL(rawUrl); // 不正なら throw

  u.protocol = u.protocol.toLowerCase();
  if (u.protocol === "http:") u.protocol = "https:";

  u.hostname = u.hostname.toLowerCase().replace(/^www\./, "");

  // 既定ポート除去
  if (
    (u.protocol === "https:" && u.port === "443") ||
    (u.protocol === "http:" && u.port === "80")
  ) {
    u.port = "";
  }

  // クエリ: トラッキング除去 + キー昇順
  const params = [...u.searchParams.entries()]
    .filter(([k]) => !isTracking(k))
    .sort(([a], [b]) => a.localeCompare(b));
  u.search = "";
  const sp = new URLSearchParams();
  for (const [k, v] of params) sp.append(k, v);
  const query = sp.toString();

  u.hash = "";

  // 末尾スラッシュ統一（ルート "/" 以外は末尾スラッシュを除去）
  let path = u.pathname;
  if (path.length > 1 && path.endsWith("/")) path = path.slice(0, -1);

  const base = `${u.protocol}//${u.host}${path}`;
  return query ? `${base}?${query}` : base;
}

/** URL からホスト（origin）を取り出す。robots/レート制御のキー。 */
export function originOf(rawUrl: string): string {
  const u = new URL(rawUrl);
  return `${u.protocol}//${u.host}`;
}

/** ドメイン（www 除去済みホスト名）を取り出す。companies.domain の canonical キー。 */
export function domainOf(rawUrl: string): string {
  const u = new URL(rawUrl);
  return u.hostname.toLowerCase().replace(/^www\./, "");
}

/**
 * 保存 dedup 用の content_hash。軽微な空白差分でハッシュが変わらないよう正規化する。
 */
export function contentHash(markdown: string): Buffer {
  const normalized = markdown
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+/g, " ")
    .split("\n")
    .map((line) => line.trim())
    .join("\n")
    .replace(/\n+$/g, "");
  return createHash("sha256").update(normalized, "utf8").digest();
}

/** チャンク単位ハッシュ（16進文字列。embeddings.content_hash の比較キー）。 */
export function chunkHashHex(text: string): string {
  return contentHash(text).toString("hex");
}
