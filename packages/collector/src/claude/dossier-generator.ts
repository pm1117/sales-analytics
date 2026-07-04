import Anthropic from "@anthropic-ai/sdk";
import type { Env } from "@sa/shared";
import {
  buildDossierUserMessage,
  DOSSIER_SYSTEM_PROMPT,
  type DossierPromptInput,
} from "./prompt";

export interface Dossier {
  markdown: string;
  sourceUrls: string[];
  gaps: string[];
}

/**
 * Claude API でカルテを生成する（構造化+生成はここで初めて実行 = 収集時は LLM を使わない）。
 * 全記述に出典を紐づける制約はプロンプトで強制する。
 */
export class DossierGenerator {
  private readonly client: Anthropic;

  constructor(private readonly env: Env) {
    if (!env.ANTHROPIC_API_KEY) {
      throw new Error("ANTHROPIC_API_KEY is required for dossier generation");
    }
    this.client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  }

  async generate(input: DossierPromptInput): Promise<Dossier> {
    const message = await this.client.messages.create({
      model: this.env.DOSSIER_MODEL,
      max_tokens: 4096,
      system: DOSSIER_SYSTEM_PROMPT,
      messages: [{ role: "user", content: buildDossierUserMessage(input) }],
    });

    const markdown = message.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("\n");

    return {
      markdown,
      sourceUrls: input.snippets.map((s) => s.sourceUrl),
      gaps: input.gaps,
    };
  }
}
