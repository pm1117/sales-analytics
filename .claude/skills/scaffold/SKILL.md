---
name: scaffold
description: 空フォルダから TypeScript(strict) の開発基盤を一発で構築する。プロジェクトを初期化・セットアップ・立ち上げたいとき、tsconfig / package.json / src を作りたいときに使う。scaffold, init, setup, bootstrap, 初期化, 立ち上げ。
---

# /scaffold — TypeScript プロジェクト初期化

空のワークスペースに、型チェック自動連携がすぐ効く **TypeScript(strict) 基盤**を作る。
`pnpm` / ESM 前提。フレームワークは載せない薄い土台なので、後から Next.js 等を重ねられる。

## 前提

- Node / pnpm が使えること（`node -v`, `pnpm -v` で確認）。
- カレントが初期化したいプロジェクトのルートであること。

## 手順（この順で実行）

1. **既存確認**: `package.json` が既にあれば上書きしない。あるなら不足分だけ足す。

2. **package.json 生成**（無い場合）:
   ```bash
   pnpm init
   ```
   生成後、`package.json` を ESM + scripts 付きに整える（`"type": "module"` と
   `"scripts"` に以下を追加）:
   ```json
   {
     "type": "module",
     "scripts": {
       "typecheck": "tsc --noEmit"
     }
   }
   ```

3. **TypeScript を devDependency に追加**:
   ```bash
   pnpm add -D typescript
   ```

4. **tsconfig.json を strict で作成**（`incremental` で自動フックを高速化）:
   ```json
   {
     "compilerOptions": {
       "target": "ES2022",
       "module": "ESNext",
       "moduleResolution": "Bundler",
       "strict": true,
       "noEmit": true,
       "incremental": true,
       "esModuleInterop": true,
       "skipLibCheck": true,
       "forceConsistentCasingInFileNames": true,
       "resolveJsonModule": true
     },
     "include": ["src"]
   }
   ```

5. **最小エントリを作成**:
   ```bash
   mkdir -p src
   ```
   `src/index.ts` に動作確認用の最小コードを置く（例: `export const hello = (name: string): string => ` + backtick 文字列）。

6. **型チェックが通ることを確認**:
   ```bash
   pnpm typecheck
   ```
   エラー 0 で完了。ここで `tsconfig.json` ができたので、以降 `*.ts` を編集すると
   `.claude/hooks/typecheck.sh`（PostToolUse フック）が自動で型チェックする。

7. `.gitignore` に `node_modules/`, `*.tsbuildinfo` を追加。

## 完了条件

- `pnpm typecheck` が成功する。
- `tsconfig.json` と `src/index.ts` が存在する。

## 補足

- ESLint / Prettier / テスト基盤（vitest）は最小土台には含めない。必要になったら別途追加する。
- 既存プロジェクトに対しては、欠けているファイル（tsconfig 等）だけを補う形で使える。
