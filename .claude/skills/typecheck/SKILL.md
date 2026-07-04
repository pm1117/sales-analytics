---
name: typecheck
description: TypeScript の型チェック (tsc --noEmit) を任意タイミングで実行し、エラーをファイル別に要約する。型エラーを確認したい・型を通したいとき、typecheck / type error / tsc / 型チェック / 型エラー のとき使う。
---

# /typecheck — 型チェックの手動実行

編集後に自動で走る PostToolUse フック（`.claude/hooks/typecheck.sh`）とは別に、
任意のタイミングでプロジェクト全体を型チェックしたいときに使う。

## 手順

1. **tsconfig の確認**: プロジェクトルートに `tsconfig.json` があるか確認する。
   無ければ TS 基盤が未整備 → `/scaffold` を案内して終了。

2. **型チェック実行**:
   ```bash
   pnpm typecheck
   ```
   `typecheck` スクリプトが無い場合は直接:
   ```bash
   npx tsc --noEmit
   ```

3. **結果の提示**:
   - エラー 0 → 「型チェック OK」と伝える。
   - エラーあり → ファイル別・行別に要約し、原因と修正方針を示す。必要なら修正まで行う。

## 補足

- 自動フックは「編集したファイルの属するプロジェクト」だけを型チェックする。
  monorepo 全体をまとめて確認したいときはこの `/typecheck` を使う。
- `incremental: true` のため 2 回目以降は高速（`.tsbuildinfo` キャッシュ）。
