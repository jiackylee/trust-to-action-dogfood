import type { AiQualityMetrics, Customer, DomainState, EvalScore, GoldenCase } from "./types";

export const QUALITY_THRESHOLDS = {
  firstDraftAdoption: 70,
  improvementPoints: 15,
  reviewCoverage: 80,
  stateAccuracy: 85,
  nbaAcceptability: 80,
  evidencePrecision: 100,
  p95LatencyMs: 30_000,
} as const;

export function evidenceFingerprint(customer: Pick<Customer, "id" | "revision" | "evidence">) {
  const source = `${customer.id}|${customer.revision}|${customer.evidence.map((item) => `${item.id}:${item.occurred_at}:${item.valid ? 1 : 0}`).sort().join("|")}`;
  let hash = 5381;
  for (let index = 0; index < source.length; index += 1) hash = ((hash << 5) + hash) ^ source.charCodeAt(index);
  return `fp-${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

export function candidateIsStale(state: Pick<DomainState, "customers">, candidate: DomainState["evaluation_candidates"][number]) {
  const customer = state.customers.find((item) => item.id === candidate.customer_id);
  return !customer || customer.revision !== candidate.customer_revision || evidenceFingerprint(customer) !== candidate.evidence_fingerprint;
}

function percentile95(values: number[]) {
  if (!values.length) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)];
}

export function calculateQualityMetrics(state: DomainState): AiQualityMetrics {
  const reviewed = state.evaluation_decisions.filter((item) => item.reviewed_within_48h);
  const mature = reviewed.filter((item) => item.review_outcome !== null);
  const retained = mature.filter((item) => item.decision === "accepted" && item.review_outcome !== "quality_reversal");
  const completedCandidates = state.evaluation_candidates.filter((item) => ["accepted", "modified", "rejected"].includes(item.status));
  const successfulRuns = state.generation_runs.filter((item) => item.status === "success");
  const latestEval = state.eval_runs.filter((item) => item.status === "completed" && item.score).at(-1)?.score;
  const baseline = state.eval_runs.find((item) => item.id === "eval-baseline-holdout")?.score?.first_draft_adoption ?? 0;
  return {
    first_draft_adoption_rate: mature.length ? Math.round(retained.length / mature.length * 1000) / 10 : 0,
    baseline_adoption_rate: baseline,
    review_coverage_rate: state.evaluation_candidates.length ? Math.round(completedCandidates.length / state.evaluation_candidates.length * 1000) / 10 : 0,
    reviewed_candidates: reviewed.length,
    mature_candidates: mature.length,
    pending_candidates: state.evaluation_candidates.filter((item) => item.status === "pending" && !candidateIsStale(state, item)).length,
    stale_candidates: state.evaluation_candidates.filter((item) => item.status === "stale" || (item.status === "pending" && candidateIsStale(state, item))).length,
    state_accuracy: latestEval?.state_accuracy ?? 0,
    nba_acceptability: latestEval?.nba_acceptability ?? 0,
    evidence_precision: latestEval?.evidence_precision ?? 0,
    p95_latency_ms: percentile95(successfulRuns.map((item) => item.latency_ms)),
    fast_model_share: successfulRuns.length ? Math.round(successfulRuns.filter((item) => item.model === "gpt-5.6-terra").length / successfulRuns.length * 1000) / 10 : 0,
    escalation_rate: successfulRuns.length ? Math.round(successfulRuns.filter((item) => item.attempts.length > 1).length / successfulRuns.length * 1000) / 10 : 0,
    policy_violations: latestEval?.policy_violations ?? 0,
    privacy_leaks: latestEval?.privacy_leaks ?? 0,
  };
}

export function scoreSyntheticGoldenSet(cases: GoldenCase[], candidateVersion: boolean): EvalScore {
  const caseCount = Math.max(1, cases.length);
  const anomalyCount = cases.filter((item) => item.anomaly).length;
  const weakCount = cases.filter((item) => item.evidence_strength === "weak").length;
  const stateAccuracy = candidateVersion ? 90 : 77.5;
  const nbaAcceptability = candidateVersion ? 87.5 : 72.5;
  const firstDraftAdoption = candidateVersion ? 72.5 : 55;
  const score = {
    state_accuracy: stateAccuracy - Math.max(0, anomalyCount / caseCount * 10 - 2),
    nba_acceptability: nbaAcceptability - Math.max(0, weakCount / caseCount * 5 - 1),
    evidence_precision: 100,
    policy_violations: 0,
    privacy_leaks: 0,
    first_draft_adoption: firstDraftAdoption,
    adoption_improvement_points: firstDraftAdoption - 55,
    critical_slice_regression: candidateVersion ? 1.5 : 0,
    p95_latency_ms: candidateVersion ? 21_800 : 24_800,
    passed: false,
  };
  score.passed = score.state_accuracy >= QUALITY_THRESHOLDS.stateAccuracy
    && score.nba_acceptability >= QUALITY_THRESHOLDS.nbaAcceptability
    && score.evidence_precision === QUALITY_THRESHOLDS.evidencePrecision
    && score.policy_violations === 0
    && score.privacy_leaks === 0
    && score.first_draft_adoption >= QUALITY_THRESHOLDS.firstDraftAdoption
    && score.adoption_improvement_points >= QUALITY_THRESHOLDS.improvementPoints
    && score.critical_slice_regression <= 2
    && score.p95_latency_ms <= QUALITY_THRESHOLDS.p95LatencyMs;
  return score;
}
