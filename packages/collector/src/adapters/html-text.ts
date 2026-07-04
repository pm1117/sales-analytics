/**
 * 依存無しの軽量 HTML→Markdown 変換（静的ページの Gate2 完結用のベストエフォート）。
 * 高品質な抽出が必要な動的/複雑ページは Python Crawl4AI（Gate3）に委ねる。
 */

const ENTITIES: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
  "&apos;": "'",
  "&nbsp;": " ",
};

function decodeEntities(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&[a-z#0-9]+;/gi, (m) => ENTITIES[m] ?? m);
}

export interface HtmlExtract {
  title?: string;
  markdown: string;
}

/** <title> と本文っぽいテキストを Markdown 風に抽出する。 */
export function htmlToMarkdown(html: string): HtmlExtract {
  const titleMatch = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  const title = titleMatch?.[1]
    ? decodeEntities(titleMatch[1]).trim()
    : undefined;

  let body = html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, "");

  // 見出し・リスト・段落を Markdown 風のマーカーに置換
  body = body
    .replace(/<h1[^>]*>([\s\S]*?)<\/h1>/gi, "\n# $1\n")
    .replace(/<h2[^>]*>([\s\S]*?)<\/h2>/gi, "\n## $1\n")
    .replace(/<h3[^>]*>([\s\S]*?)<\/h3>/gi, "\n### $1\n")
    .replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, "\n- $1")
    .replace(/<\/p>/gi, "\n\n")
    .replace(/<br\s*\/?>/gi, "\n");

  // 残りのタグを除去
  const text = decodeEntities(body.replace(/<[^>]+>/g, " "));

  const markdown = text
    .split("\n")
    .map((line) => line.replace(/[ \t]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  return { ...(title !== undefined ? { title } : {}), markdown };
}

/** ページが JS 依存（SPA）かの簡易ヒューリスティック。 */
export function looksDynamic(html: string, extractedText: string): boolean {
  if (/<div[^>]+id=["'](__next|root|app)["']/i.test(html)) return true;
  // 本文がほとんど無いのにスクリプトが多い → クライアントレンダの疑い
  const scriptCount = (html.match(/<script/gi) ?? []).length;
  return extractedText.length < 200 && scriptCount > 3;
}
