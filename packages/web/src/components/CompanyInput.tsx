import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type {
  AssessmentInput,
  ManualInput,
  SeedUrl,
  SignalId,
} from "@sa/shared/types/fit";
import { SIGNAL_CATALOG } from "@sa/shared/fit/signal-catalog";
import { ApiError, createAssessment } from "../api/client";

const today = () => new Date().toISOString().slice(0, 10);

/** 企業 URL 入力 + 詳細オプション（seedUrls / manualInputs）— 詳細設計 §D-2。 */
export function CompanyInput({ onSubmitted }: { onSubmitted: (id: string) => void }) {
  const [url, setUrl] = useState("");
  const [showOptions, setShowOptions] = useState(false);
  const [seedUrls, setSeedUrls] = useState<SeedUrl[]>([]);
  const [manualInputs, setManualInputs] = useState<ManualInput[]>([]);
  const queryClient = useQueryClient();

  const mutation = useMutation({
    mutationFn: (input: AssessmentInput) => createAssessment(input),
    onSuccess: async (res) => {
      await queryClient.invalidateQueries({ queryKey: ["assessments"] });
      setUrl("");
      onSubmitted(res.assessmentId);
    },
  });

  const submit = () => {
    const input: AssessmentInput = {
      companyNameOrUrl: url.trim(),
      ...(seedUrls.length > 0 ? { seedUrls: seedUrls.filter((s) => s.url) } : {}),
      ...(manualInputs.length > 0
        ? { manualInputs: manualInputs.filter((m) => m.url && m.quoteSummary) }
        : {}),
    };
    mutation.mutate(input);
  };

  return (
    <div className="card">
      <div className="form-row">
        <input
          type="url"
          placeholder="https://demo-company.example"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
        />
        <button
          className="secondary"
          type="button"
          onClick={() => setShowOptions((v) => !v)}
        >
          {showOptions ? "－オプション" : "＋詳細オプション"}
        </button>
        <button type="button" onClick={submit} disabled={!url.trim() || mutation.isPending}>
          判定を実行
        </button>
      </div>

      {mutation.error instanceof ApiError && (
        <p className="error-text">
          {mutation.error.code === "already_running"
            ? "この企業の判定は実行中です。完了を待ってください。"
            : mutation.error.message}
        </p>
      )}

      {showOptions && (
        <div>
          <h2>seedUrls（careers / 求人媒体 URL）</h2>
          {seedUrls.map((seed, i) => (
            <div className="form-row" key={i}>
              <select
                value={seed.kind}
                onChange={(e) =>
                  setSeedUrls(seedUrls.map((s, j) =>
                    j === i ? { ...s, kind: e.target.value as SeedUrl["kind"] } : s,
                  ))
                }
              >
                <option value="careers">careers（自社採用ページ）</option>
                <option value="jobs_media">jobs_media（求人媒体）</option>
              </select>
              <input
                type="url"
                placeholder="https://..."
                value={seed.url}
                onChange={(e) =>
                  setSeedUrls(seedUrls.map((s, j) => (j === i ? { ...s, url: e.target.value } : s)))
                }
              />
              <button
                className="secondary"
                type="button"
                onClick={() => setSeedUrls(seedUrls.filter((_, j) => j !== i))}
              >
                削除
              </button>
            </div>
          ))}
          <button
            className="secondary"
            type="button"
            onClick={() => setSeedUrls([...seedUrls, { kind: "careers", url: "" }])}
          >
            ＋ seed を追加
          </button>

          <h2>manualInputs（口コミ等の手動確認 — 規約上自動収集しないソース）</h2>
          {manualInputs.map((m, i) => (
            <div className="form-row" key={i}>
              <select
                value={m.signalId}
                onChange={(e) =>
                  setManualInputs(manualInputs.map((x, j) =>
                    j === i ? { ...x, signalId: e.target.value as SignalId } : x,
                  ))
                }
              >
                {SIGNAL_CATALOG.map((def) => (
                  <option key={def.id} value={def.id}>
                    {def.id} {def.name}
                  </option>
                ))}
              </select>
              <input
                type="url"
                placeholder="確認した URL"
                value={m.url}
                onChange={(e) =>
                  setManualInputs(manualInputs.map((x, j) => (j === i ? { ...x, url: e.target.value } : x)))
                }
              />
              <input
                type="text"
                placeholder="要約（逐語転載しない）"
                value={m.quoteSummary}
                onChange={(e) =>
                  setManualInputs(manualInputs.map((x, j) =>
                    j === i ? { ...x, quoteSummary: e.target.value } : x,
                  ))
                }
              />
              <input
                type="date"
                value={m.checkedAt}
                onChange={(e) =>
                  setManualInputs(manualInputs.map((x, j) =>
                    j === i ? { ...x, checkedAt: e.target.value } : x,
                  ))
                }
              />
              <button
                className="secondary"
                type="button"
                onClick={() => setManualInputs(manualInputs.filter((_, j) => j !== i))}
              >
                削除
              </button>
            </div>
          ))}
          <button
            className="secondary"
            type="button"
            onClick={() =>
              setManualInputs([
                ...manualInputs,
                { signalId: "2-1", url: "", quoteSummary: "", checkedAt: today() },
              ])
            }
          >
            ＋ 手動入力を追加
          </button>
        </div>
      )}
    </div>
  );
}
