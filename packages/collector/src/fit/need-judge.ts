import {
  SIGNAL_BY_ID,
  SIGNAL_CATALOG,
  type NeedLevel,
  type SignalId,
  type SignalResult,
} from "@sa/shared";

/**
 * need_level の決定的集約（詳細設計 §C-3 の決定表）。LLM を使わない（要件 F3 — 再現性）。
 * 入力は evidence 検証済み（出典なしシグナルは既に detected=false）の SignalResult[]。
 */

/** 収集最低要件（要件 §6-3）の充足状況。orchestrator が collect 段の結果から組み立てる。 */
export interface CollectionStatus {
  /** 自社 careers の有無確認が完了したか（プローブ or seedUrls。結果の有無は問わない）。 */
  careersChecked: boolean;
  /** 求人媒体の求人情報の件数（自動収集 + 手動入力）。 */
  jobsInfoCount: number;
  /** PR / ニュースの件数。 */
  prNewsCount: number;
}

export interface JudgeInput {
  signals: SignalResult[];
  collection: CollectionStatus;
}

export interface JudgeResult {
  needLevel: NeedLevel;
  rationale: string;
  missingData: SignalId[];
}

/** 「1-1（同一エンジニア職種の長期募集…）」形式の表示ラベル。 */
function label(id: SignalId): string {
  const def = SIGNAL_BY_ID.get(id);
  return def ? `${id}（${def.name}）` : id;
}

function labels(ids: SignalId[]): string {
  return ids.map(label).join("、");
}

export function judge(input: JudgeInput): JudgeResult {
  const { signals, collection } = input;

  // insufficientHistory=true は「検出なし」と同扱い（要件 F2 — 誤検出より欠損を選ぶ）
  const detected = signals.filter((s) => s.detected && !s.insufficientHistory);
  const idsOf = (pred: (s: SignalResult) => boolean): SignalId[] =>
    detected.filter(pred).map((s) => s.id);

  const strengthOf = (s: SignalResult) => SIGNAL_BY_ID.get(s.id)?.strength;
  const categoryOf = (s: SignalResult) => SIGNAL_BY_ID.get(s.id)?.category;
  const severityOf = (s: SignalResult) =>
    SIGNAL_BY_ID.get(s.id)?.counterSeverity;

  const fatalOrMajor = idsOf(
    (s) =>
      strengthOf(s) === "counter" &&
      (severityOf(s) === "fatal" || severityOf(s) === "major"),
  );
  const minorCounters = idsOf(
    (s) => strengthOf(s) === "counter" && severityOf(s) === "minor",
  );
  const strongJobs = idsOf(
    (s) => strengthOf(s) === "strong" && categoryOf(s) === "jobs",
  );
  const strongOther = idsOf(
    (s) =>
      strengthOf(s) === "strong" &&
      (categoryOf(s) === "reviews" || categoryOf(s) === "management"),
  );
  const weak = idsOf((s) => strengthOf(s) === "weak");

  // missingData = 履歴不足 + manual 検出のシグナルで入力が無いもの（詳細設計 §C-3）。
  // 収集失敗ソース起因の欠損は orchestrator 側で追加する。
  const detectedIds = new Set(detected.map((s) => s.id));
  const missingData: SignalId[] = SIGNAL_CATALOG.filter(
    (def) =>
      signals.some((s) => s.id === def.id && s.insufficientHistory) ||
      (def.detector === "manual" && !detectedIds.has(def.id)),
  ).map((def) => def.id);

  const minimumMet =
    collection.careersChecked &&
    collection.jobsInfoCount >= 1 &&
    collection.prNewsCount >= 1;

  // ---- 決定表（上から順に評価し、最初に該当した行で確定。順序が仕様） ----

  // 行 1: 収集最低要件未達 → unknown（要件 §6-3）
  if (!minimumMet) {
    const lacking: string[] = [];
    if (!collection.careersChecked) lacking.push("自社 careers の有無確認");
    if (collection.jobsInfoCount < 1) lacking.push("求人媒体の求人情報");
    if (collection.prNewsCount < 1) lacking.push("PR / ニュース");
    return {
      needLevel: "unknown",
      rationale: `収集最低要件未達（不足: ${lacking.join("、")}）`,
      missingData,
    };
  }

  // 行 2: fatal/major 逆指標 → low（counter があれば high 禁止 = S2 のハード制約）
  if (fatalOrMajor.length >= 1) {
    const reasons = fatalOrMajor
      .map((id) =>
        id === "4-1" ? "競合" : id === "1-5" ? "リファラル採用疑い" : id,
      )
      .join("、");
    return {
      needLevel: "low",
      rationale: `逆指標 ${labels(fatalOrMajor)} を検出（${reasons}）。問合せ対象外`,
      missingData,
    };
  }

  // 行 3: 軽微な逆指標 + 強い求人シグナル → medium（要件 §4-2 medium 前段）
  if (minorCounters.length >= 1 && strongJobs.length >= 1) {
    return {
      needLevel: "medium",
      rationale: `求人シグナル ${labels(strongJobs)} を検出したが、軽微な逆指標 ${labels(minorCounters)} あり`,
      missingData,
    };
  }

  // 行 4: 軽微な逆指標のみ → low（要件 §4-2 low）
  if (minorCounters.length >= 1) {
    return {
      needLevel: "low",
      rationale: `逆指標 ${labels(minorCounters)} あり。強い求人シグナルなし`,
      missingData,
    };
  }

  // 行 5: 強い求人シグナル → high（要件 §4-2 high）
  if (strongJobs.length >= 1) {
    const boost =
      strongOther.length >= 1 ? `。確度 UP: ${labels(strongOther)}` : "";
    return {
      needLevel: "high",
      rationale: `求人シグナル ${labels(strongJobs)} を検出。逆指標なし${boost}`,
      missingData,
    };
  }

  // 行 6: 弱いシグナル 2 件以上 → medium（要件 §4-2 medium 後段。strongOther は妨げない）
  if (weak.length >= 2) {
    const note =
      strongOther.length >= 1 ? `。補足: ${labels(strongOther)} も検出` : "";
    return {
      needLevel: "medium",
      rationale: `弱いシグナル ${labels(weak)} が 2 件以上。逆指標なし${note}`,
      missingData,
    };
  }

  // 行 7: それ以外 → low
  // 設計判断（2026-07-05 確定）: strongOther（2-1/3-1/3-2）単独では問い合わせしない。
  if (strongOther.length >= 1) {
    return {
      needLevel: "low",
      rationale: `${labels(strongOther)} を検出したが求人シグナルなし → 問い合わせ対象外`,
      missingData,
    };
  }
  return {
    needLevel: "low",
    rationale: "判定材料となるシグナルなし（または弱い 1 件のみ）",
    missingData,
  };
}
