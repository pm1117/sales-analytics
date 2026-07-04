# sales-analytics ワークスペース

新しいプロダクトを立ち上げるためのクリーンなワークスペース。プロダクト本体はまだ無く、
これから TypeScript / Node で構築していく。このリポジトリには、今後の開発を支える
**汎用的な開発支援スキル**（Claude Code の skills / hooks）を先に整備してある。

## 技術方針（決定事項）

- 言語: **TypeScript**（`tsconfig` は `strict` を基本）
- ランタイム: Node（`type: module` / ESM 前提）
- パッケージマネージャ: **pnpm**
- 型チェック: `tsc --noEmit`（`incremental` で高速化）

## 開発支援ツール（.claude/）

このワークスペースには次が組み込まれている。詳細は各 `SKILL.md` を参照。

| 種類 | 名前 | 役割 |
|---|---|---|
| Skill | `/scaffold` | 空フォルダから TS(strict) の開発基盤を一発構築する |
| Skill | `/typecheck` | 任意タイミングで `tsc --noEmit` を実行しエラーを要約 |
| Hook  | `PostToolUse` → `.claude/hooks/typecheck.sh` | `*.ts`/`*.tsx` 編集後に自動で型チェックし、エラーを検知したら知らせる |

### 自動型チェックの挙動

- `tsconfig.json` が**無い**間は自動フックは何もしない（no-op）。`/scaffold` で TS 基盤が
  できると自然に効き始める。
- 型チェックは編集ファイルから上位に `tsconfig.json` を探し、その直下で実行する。
- 依存（`typescript`）が未インストールのプロジェクトでも無害（黙って何もしない）。

## グローバルへの昇格

ここで作り込んで安定したら、`skills/` と `hooks/` を `~/.claude/` にコピーし、hooks 定義を
`~/.claude/settings.json` に移すことで、全プロジェクトで有効化できる（TS 以外のプロジェクトでは
`tsconfig.json` が無いため自動的に無害）。
