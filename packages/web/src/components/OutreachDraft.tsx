import type { FitAssessment } from "@sa/shared/types/fit";

/**
 * 【スタブ — 実装しない】問い合わせ文面の生成は次フェーズ（要件 §3-2 で本 PoC は非スコープ）。
 * PoC 評価者にプロダクトの将来像（判定 → 文面生成 → フォーム営業）を見せるため意図的に表示する
 * （詳細設計 §D-2 / 2026-07-05 確定）。
 */
export function OutreachDraft({ assessment }: { assessment: FitAssessment }) {
  void assessment;
  return (
    <div className="card card--disabled">
      <h2>問い合わせ文面ドラフト</h2>
      <p className="note">
        次フェーズで提供予定 — 判定根拠（検出シグナル）をフックにした問い合わせ文面をここに生成します。
        本 PoC は Fit 判定の精度検証に集中するため未実装です。
      </p>
      <button disabled>文面を生成（次フェーズ）</button>
    </div>
  );
}
