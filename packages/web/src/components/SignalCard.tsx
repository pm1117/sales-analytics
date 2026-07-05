import type { SignalDef } from "@sa/shared/fit/signal-catalog";
import type { SignalResult } from "@sa/shared/types/fit";

const STRENGTH_JA = { strong: "強い", weak: "弱い", counter: "逆指標" } as const;

/** シグナル 1 件の表示（詳細設計 §D-2）。evidence は外部リンク + source チップ。 */
export function SignalCard({ def, result }: { def: SignalDef; result: SignalResult }) {
  return (
    <div className="card">
      <p>
        <span className={`chip chip--${result.strength}`}>{STRENGTH_JA[result.strength]}</span>
        <strong>
          {def.id} {def.name}
        </strong>
      </p>
      {result.insufficientHistory && (
        <p className="note">時系列情報が不足（判定対象外 — 掲載期間・条件変更の履歴が取れませんでした）</p>
      )}
      {result.evidence.length > 0 && (
        <ul>
          {result.evidence.map((e, i) => (
            <li key={i}>
              {e.quoteSummary}{" "}
              <a href={e.url} target="_blank" rel="noreferrer">
                {e.url}
              </a>{" "}
              {e.source === "manual" && <span className="chip chip--manual">手動</span>}
              {e.source === "careers_probe" && <span className="chip chip--manual">プローブ</span>}
              <span className="note">（{e.checkedAt}）</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
