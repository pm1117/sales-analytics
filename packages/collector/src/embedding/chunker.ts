/**
 * Markdown を H2/H3 見出し境界でチャンク化する（~800-1000 tokens 目標, ~100 overlap）。
 * 表・箇条書き・コードブロックは原子単位として途中で割らない（段落境界のみで分割）。
 */

const TARGET_TOKENS = 900;
const OVERLAP_TOKENS = 100;

/** ざっくりトークン概算（日本語混在を考慮し ~3 chars/token）。 */
function approxTokens(text: string): number {
  return Math.ceil(text.length / 3);
}

export interface Chunk {
  chunkIndex: number;
  text: string;
}

/** H2/H3 を境界にセクション分割（H1 は章境界にしない）。 */
function splitSections(md: string): string[] {
  const lines = md.split("\n");
  const sections: string[] = [];
  let current: string[] = [];
  for (const line of lines) {
    if (/^#{2,3}\s/.test(line) && current.length > 0) {
      sections.push(current.join("\n"));
      current = [line];
    } else {
      current.push(line);
    }
  }
  if (current.length > 0) sections.push(current.join("\n"));
  return sections.filter((s) => s.trim().length > 0);
}

/** 段落境界（空行）で分割。ただし原子ブロック（表/箇条書き/コード）は結合維持。 */
function splitParagraphs(section: string): string[] {
  return section
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
}

function lastOverlap(text: string): string {
  const chars = OVERLAP_TOKENS * 3;
  return text.length <= chars ? text : text.slice(text.length - chars);
}

export function chunkMarkdown(md: string): Chunk[] {
  const chunks: Chunk[] = [];
  let buffer = "";
  let index = 0;

  const flush = (): void => {
    const text = buffer.trim();
    if (text.length > 0) {
      chunks.push({ chunkIndex: index, text });
      index += 1;
    }
  };

  for (const section of splitSections(md)) {
    for (const para of splitParagraphs(section)) {
      const candidate = buffer.length > 0 ? `${buffer}\n\n${para}` : para;
      if (approxTokens(candidate) > TARGET_TOKENS && buffer.length > 0) {
        const carry = lastOverlap(buffer);
        flush();
        buffer = `${carry}\n\n${para}`;
      } else {
        buffer = candidate;
      }
    }
  }
  flush();
  return chunks;
}
