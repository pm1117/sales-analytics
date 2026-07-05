// 型は @sa/shared のサブパスから import する（バレル index は pino 等 Node 依存を含むため、
// ブラウザバンドルには型モジュールとカタログ（純データ）のみを使う）
import type {
  AssessmentInput,
  AssessmentListItem,
  FitAssessment,
  HumanReview,
  MismatchReason,
  NeedLevel,
} from "@sa/shared/types/fit";
import {
  getMockAssessment,
  getMockListItems,
  mockCreateAssessment,
  mockSaveHumanReview,
} from "./mock-data";

const USE_MOCK = import.meta.env.VITE_USE_MOCK === "true";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    headers: { "content-type": "application/json" },
    ...init,
  });
  const body: unknown = await res.json();
  if (!res.ok) {
    const e = body as { error?: string; message?: string };
    throw new ApiError(res.status, e.error ?? "unknown", e.message ?? res.statusText);
  }
  return body as T;
}

export function getAssessments(): Promise<{ items: AssessmentListItem[] }> {
  if (USE_MOCK) {
    return Promise.resolve({ items: getMockListItems() });
  }
  return request("/assessments");
}

export function getAssessment(id: string): Promise<FitAssessment> {
  if (USE_MOCK) {
    const a = getMockAssessment(id);
    if (!a) {
      return Promise.reject(new ApiError(404, "not_found", "assessment が見つかりません"));
    }
    return Promise.resolve({ ...a });
  }
  return request(`/assessments/${id}`);
}

export function createAssessment(
  input: AssessmentInput,
): Promise<{ assessmentId: string; status: "running" }> {
  if (USE_MOCK) {
    void input;
    return Promise.resolve(mockCreateAssessment());
  }
  return request("/assessments", { method: "POST", body: JSON.stringify(input) });
}

export function saveHumanReview(
  id: string,
  review: { needLevel: NeedLevel; mismatchReason: MismatchReason | null },
): Promise<FitAssessment> {
  if (USE_MOCK) {
    return Promise.resolve(
      mockSaveHumanReview(id, {
        ...review,
        reviewedAt: new Date().toISOString(),
      }),
    );
  }
  return request(`/assessments/${id}/human-review`, {
    method: "PATCH",
    body: JSON.stringify(review),
  });
}

export type { AssessmentInput, AssessmentListItem, FitAssessment, HumanReview };
