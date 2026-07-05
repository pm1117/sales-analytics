---
name: fit-implement
description: Fit 判定 PoC を詳細設計に沿ってフェーズ分割実装する。ブランチ作成・PR 単位・コミット手順を含む。fit implement, Fit 実装, PR1, フェーズ実装, fit-validation 実装 のとき使う。
---

# /fit-implement — Fit 判定 PoC フェーズ実装

`docs/ui/fit-validation-detailed-design.md`（以下「詳細設計」）を正として、
**1 フェーズ = 1 ブランチ = 1 PR** で実装する。

## 設計の正

| 文書 | 役割 |
|---|---|
| `docs/ui/fit-validation-detailed-design.md` | 型・API・ロジック・UI の実装仕様（**最優先**） |
| `docs/ui/fit-validation-requirements.md` | 要件・成功基準 |
| `docs/ui/fit-validation-design.md` | 基本設計（詳細設計と矛盾する場合は詳細設計を正とする） |
| `docs/ui/fit-validation-signals.md` | シグナルカタログ v0.2 |

## ブランチ戦略

```
master
  └── feature/add-analytics-page     ← 統合ブランチ（Fit PoC の作業ベース）
        ├── feature/fit-pr1-shared
        ├── feature/fit-pr2-judge
        └── ...
```

| 種類 | ブランチ名 | PR の向き先 |
|---|---|---|
| 統合 | `feature/add-analytics-page` | `master`（ドキュメント or 全実装完了時） |
| フェーズ | `feature/fit-pr{N}-{slug}` | `feature/add-analytics-page` |

**フェーズ着手前に必ず:**

1. `git checkout feature/add-analytics-page && git pull`（最新化）
2. `git checkout -b feature/fit-pr{N}-{slug}`

## フェーズ定義

詳細設計の「実装チェックリスト」に対応。ユーザーが `PR3` 等と指定したらその行だけ実装する。
**指定フェーズ以外のファイルは触らない。**

| PR | ブランチ slug 例 | チェックリスト | 主な成果物 |
|---|---|---|---|
| **PR0** | （済） | ドキュメントのみ | 設計書群 — `feature/add-analytics-page` にコミット済み想定 |
| **PR1** | `pr1-shared` | 1 + 2 | `packages/shared` fit 型・カタログ・zod・env / `0002_fit.sql` |
| **PR2** | `pr2-judge` | 3 + 4 | `need-judge` / `evidence-filter` / `merge-manual` + 単体テスト |
| **PR3** | `pr3-extract` | 5 + 6 | `fit-prompt` / `signal-extractor` + snapshot・モックテスト |
| **PR4** | `pr4-careers` | 7 | `careers-probe` / `SourceEnumerator` seedUrls + テスト |
| **PR5** | `pr5-pipeline` | 8 + 9 | `fit-assessment-repo` / `fit-orchestrator` / `assess-poc.ts` |
| **PR6** | `pr6-api` | 10 | `server/routes/assessment.ts` / `index.ts` 配線 |
| **PR7** | `pr7-web` | 11 | `packages/web` 一式 |
| **評価** | — | 12 | 10 社評価（コード PR ではなく運用） |

## 実装手順（毎フェーズ共通）

1. **詳細設計を読む** — 当該フェーズの § を特定し、型・ファイルパス・テストケースを把握する。
2. **ブランチを切る** — 上記「ブランチ戦略」に従う。
3. **実装** — 既存 collector / shared の流儀に合わせる（interface、vitest、ESM）。
4. **検証** — フェーズに応じて実行し、エラー 0 で完了とする:
   ```bash
   pnpm test          # テストを追加したフェーズ
   pnpm typecheck     # またはルート / 各 package の tsc --noEmit
   ```
   PR1 などテスト未追加フェーズは `pnpm typecheck` のみでよい。
5. **コミット** — ユーザーが「コミットして」と明示したときのみ行う（下記「Git 操作」参照）。
6. **報告** — 変更ファイル一覧・検証結果・次フェーズの提案を短く伝える。

## Git 操作

| 操作 | デフォルト | ユーザーが明示したとき |
|---|---|---|
| コミット | **しない** | 「コミットして」「コミットまで」→ 1 フェーズ 1 コミット推奨 |
| push | **しない** | 「push して」 |
| PR 作成 | **しない** | 「PR 作って」→ base は `feature/add-analytics-page` |

### コミットメッセージ形式

```
feat(fit): <短い要約> (PR{N})

<1行の why。詳細設計 §X-Y 参照>
```

例:
```
feat(fit): add shared types and migration (PR1)

Fit 判定の型・カタログ・DB スキーマを shared/collector に追加。詳細設計 §A, §B-2。
```

### PR 作成（依頼されたとき）

```bash
git push -u origin HEAD
gh pr create --base feature/add-analytics-page --title "feat(fit): ... (PR{N})" --body "$(cat <<'EOF'
## Summary
- ...

## Test plan
- [ ] pnpm test
- [ ] pnpm typecheck

EOF
)"
```

ドキュメントのみを `master` に入れる PR（PR0）は `--base master` を使う。

## スコープ外（触らない）

- チェックリストに無いリファクタリング
- 既存 `/dossiers` の挙動変更（詳細設計: 並存・無変更）
- OutreachDraft の実装（スタブのみ — PR7）
- 10 社評価の実施そのもの（PR7 完了後の運用）

## フェーズ別の完了条件（抜粋）

### PR1
- `SIGNAL_CATALOG` 14 件、`types/fit.ts` の型が詳細設計 §A-1 と一致
- `0002_fit.sql` が基本設計 §5-2 の DDL を反映

### PR2
- §C-3 決定表 8 行 + §F-1 境界ケースがテストで固定
- **最初にマージしたいコアロジック**

### PR5
- `assess-poc.ts --offline poc-output/<sample-domain>` が動く（§E-1）
- UI なしで仮説検証可能なマイルストーン

### PR7
- TanStack Query（詳細設計 §D-3）。基本設計 §8 との差分は詳細設計を正とする
- `OutreachDraft` は無効化スタブのみ

## ユーザーへの依頼例

```
/fit-implement PR1 を実装して。ブランチ切って、コミットまで。
```

```
/fit-implement PR2。push と PR はしない。
```

## トラブル時

- 詳細設計と実装で食い違い → 実装を止め、差分を報告。設計修正が必要ならユーザーに確認。
- 前フェーズ未マージで次を依頼された → 統合ブランチの状態を確認し、依存があれば先にマージを促す。
