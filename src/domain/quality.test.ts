import { describe, expect, it } from "vitest";
import { createFixtureState } from "./fixtures";
import { calculateQualityMetrics, candidateIsStale, scoreSyntheticGoldenSet } from "./quality";

describe("AI quality metrics", () => {
  it("counts only unchanged original adoption as the North Star numerator", () => {
    const state = createFixtureState();
    const candidate = state.evaluation_candidates.find((item) => item.status === "accepted")!;
    const decision = state.evaluation_decisions.find((item) => item.candidate_id === candidate.id)!;
    state.evaluation_candidates = [
      { ...candidate, id: "candidate-retained", status: "accepted" },
      { ...candidate, id: "candidate-new-evidence", status: "accepted" },
      { ...candidate, id: "candidate-reversal", status: "accepted" },
      { ...candidate, id: "candidate-modified", status: "modified" },
    ];
    state.evaluation_decisions = [
      { ...decision, id: "decision-retained", candidate_id: "candidate-retained", decision: "accepted", reviewed_within_48h: true, review_outcome: "retained" },
      { ...decision, id: "decision-new-evidence", candidate_id: "candidate-new-evidence", decision: "accepted", reviewed_within_48h: true, review_outcome: "new_evidence" },
      { ...decision, id: "decision-reversal", candidate_id: "candidate-reversal", decision: "accepted", reviewed_within_48h: true, review_outcome: "quality_reversal" },
      { ...decision, id: "decision-modified", candidate_id: "candidate-modified", decision: "modified", reviewed_within_48h: true, review_outcome: "retained" },
    ];

    const metrics = calculateQualityMetrics(state);
    expect(metrics.first_draft_adoption_rate).toBe(50);
    expect(metrics.review_coverage_rate).toBe(100);
  });

  it("marks changed pending snapshots stale without reclassifying historical decisions", () => {
    const state = createFixtureState();
    const accepted = state.evaluation_candidates.find((item) => item.status === "accepted" && !["cus-01", "cus-02", "cus-03", "cus-04", "cus-05", "cus-06"].includes(item.customer_id))!;
    expect(candidateIsStale(state, accepted)).toBe(false);
    state.customers = state.customers.map((item) => item.id === accepted.customer_id ? { ...item, revision: item.revision + 1 } : item);
    expect(candidateIsStale(state, accepted)).toBe(true);
    expect(calculateQualityMetrics(state).stale_candidates).toBe(state.evaluation_candidates.filter((item) => item.status === "stale" || (item.status === "pending" && candidateIsStale(state, item))).length);
  });

  it("requires absolute adoption, baseline lift, safety, slices and latency together", () => {
    const state = createFixtureState();
    const holdout = state.golden_cases.filter((item) => item.split === "holdout");
    const baseline = scoreSyntheticGoldenSet(holdout, false);
    const candidate = scoreSyntheticGoldenSet(holdout, true);

    expect(baseline.passed).toBe(false);
    expect(candidate).toMatchObject({
      passed: true,
      first_draft_adoption: 72.5,
      adoption_improvement_points: 17.5,
      evidence_precision: 100,
      policy_violations: 0,
      privacy_leaks: 0,
    });
    expect(candidate.critical_slice_regression).toBeLessThanOrEqual(2);
  });
});
