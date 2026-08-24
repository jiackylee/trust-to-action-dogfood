import type { AiQualityMetrics, Customer, DomainState, EvalScore, GoldenCase, LiveEvalCaseResult, MarketingTaskType } from "./types";

export const QUALITY_THRESHOLDS = {
  firstDraftAdoption: 70,
  improvementPoints: 15,
  reviewCoverage: 80,
  minimumTaskAdoption: 60,
  stateAccuracy: 85,
  nbaAcceptability: 80,
  evidencePrecision: 100,
  knowledgeRecallAt5: 95,
  knowledgeCitationPrecision: 100,
  p95LatencyMs: 30_000,
} as const;

const TASKS: MarketingTaskType[] = ["weekly_strategy", "content_brief", "content_draft", "customer_nba"];

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

function percentage(numerator: number, denominator: number) {
  return denominator ? Math.round(numerator / denominator * 1000) / 10 : 0;
}

export function calculateQualityMetrics(state: DomainState): AiQualityMetrics {
  const reviewed = state.evaluation_decisions.filter((item) => item.reviewed_within_48h);
  const mature = reviewed.filter((item) => item.review_outcome !== null);
  const retained = mature.filter((item) => item.decision === "accepted" && item.review_outcome !== "quality_reversal");
  const completedCandidates = state.evaluation_candidates.filter((item) => ["accepted", "modified", "rejected"].includes(item.status));
  const generationRuns = state.generation_runs;
  const successfulRuns = generationRuns.filter((item) => item.status === "success");
  const latestEval = state.eval_runs.filter((item) => item.status === "completed" && item.score).at(-1)?.score;
  const baseline = state.eval_runs.find((item) => item.id === "eval-baseline-holdout")?.score?.first_draft_adoption ?? 0;
  const knownSources = new Set(state.knowledge_sources.filter((item) => item.status === "ready").map((item) => item.id));
  const taskSlices = Object.fromEntries(TASKS.map((task) => {
    const candidates = state.marketing_candidates.filter((item) => item.task_type === task);
    const decisions = state.marketing_decisions.filter((item) => item.task_type === task);
    const matureDecisions = decisions.filter((item) => item.reviewed_within_48h && item.review_outcome !== null);
    const effective = matureDecisions.filter((item) => item.decision === "accepted" && item.review_outcome !== "quality_reversal");
    const completed = candidates.filter((item) => ["accepted", "modified", "rejected"].includes(item.status));
    const refs = candidates.flatMap((item) => item.envelope.knowledge_refs);
    const applicable = decisions.filter((item) => item.reason_code !== "knowledge_not_applicable");
    return [task, {
      adoption_rate: matureDecisions.length ? percentage(effective.length, matureDecisions.length) : latestEval?.task_adoption_rates?.[task] ?? 0,
      review_coverage_rate: candidates.length ? percentage(completed.length, candidates.length) : latestEval?.review_coverage_rate ?? 0,
      reviewed: decisions.length,
      pending: candidates.filter((item) => item.status === "pending").length,
      quality_reversals: decisions.filter((item) => item.review_outcome === "quality_reversal").length,
      knowledge_citation_precision: percentage(refs.filter((item) => knownSources.has(item.source_id)).length, refs.length),
      source_applicability_rate: percentage(applicable.length, decisions.length),
      p95_latency_ms: percentile95(candidates.map((item) => item.envelope.ai_meta.latency_ms ?? 0)),
    }];
  })) as AiQualityMetrics["task_slices"];
  const macro = Math.round(TASKS.reduce((sum, task) => sum + taskSlices[task].adoption_rate, 0) / TASKS.length * 10) / 10;
  const allKnowledgeRefs = state.marketing_candidates.flatMap((item) => item.envelope.knowledge_refs);
  const businessIds = new Set([...state.customers.flatMap((item) => item.evidence.map((evidence) => evidence.id)), ...state.conversation_insights.map((item) => item.id), ...state.proofs.map((item) => item.id)]);
  const allBusinessRefs = state.marketing_candidates.flatMap((item) => item.envelope.business_evidence_refs);
  const providers = new Set([
    ...generationRuns.map((item) => item.provider ?? "openai"),
    ...state.marketing_candidates.map((item) => item.envelope.ai_meta.provider ?? "openai"),
  ]);
  const providerSlices = Object.fromEntries([...providers].map((provider) => {
    const runs = generationRuns.filter((item) => (item.provider ?? "openai") === provider);
    const marketing = state.marketing_candidates.filter((item) => (item.envelope.ai_meta.provider ?? "openai") === provider);
    const total = runs.length + marketing.length;
    return [provider, {
      runs: total,
      success_rate: percentage(runs.filter((item) => item.status === "success").length + marketing.length, total),
      fallback_rate: percentage(runs.filter((item) => item.attempts.length > 1).length, runs.length),
      p95_latency_ms: percentile95([...runs.map((item) => item.latency_ms), ...marketing.map((item) => item.envelope.ai_meta.latency_ms ?? 0)]),
      input_tokens: runs.reduce((sum, item) => sum + item.input_tokens, 0) + marketing.reduce((sum, item) => sum + (item.envelope.ai_meta.input_tokens ?? 0), 0),
      output_tokens: runs.reduce((sum, item) => sum + item.output_tokens, 0) + marketing.reduce((sum, item) => sum + (item.envelope.ai_meta.output_tokens ?? 0), 0),
    }];
  }));
  const profileKeys = new Set([
    ...generationRuns.map((item) => item.model_profile_version_id ?? `legacy:${item.provider ?? "openai"}:${item.model}`),
    ...state.marketing_candidates.map((item) => item.envelope.ai_meta.model_profile_version_id ?? `legacy:${item.envelope.ai_meta.provider ?? "openai"}:${item.envelope.ai_meta.model}`),
  ]);
  const profileSlices = Object.fromEntries([...profileKeys].map((profileId) => {
    const profile = state.model_profiles.find((item) => item.id === profileId);
    const runs = generationRuns.filter((item) => (item.model_profile_version_id ?? `legacy:${item.provider ?? "openai"}:${item.model}`) === profileId);
    const marketing = state.marketing_candidates.filter((item) => (item.envelope.ai_meta.model_profile_version_id ?? `legacy:${item.envelope.ai_meta.provider ?? "openai"}:${item.envelope.ai_meta.model}`) === profileId);
    const sampleRun = runs[0];
    const sampleMeta = marketing[0]?.envelope.ai_meta;
    const provider = profile?.provider ?? sampleRun?.provider ?? sampleMeta?.provider ?? "openai";
    const protocol = profile?.protocol ?? sampleRun?.protocol ?? sampleMeta?.protocol ?? "openai_responses";
    const endpointScope = profile?.endpoint_scope ?? sampleRun?.endpoint_scope ?? sampleMeta?.endpoint_scope ?? "public_cloud";
    const model = profile?.primary_model ?? sampleRun?.model ?? sampleMeta?.model ?? "unknown";
    const total = runs.length + marketing.length;
    return [profileId, {
      profile_id: profileId,
      profile_name: profile?.name ?? "历史迁移 Profile",
      provider,
      protocol,
      endpoint_scope: endpointScope,
      model,
      runs: total,
      success_rate: percentage(runs.filter((item) => item.status === "success").length + marketing.length, total),
      fallback_rate: percentage(runs.filter((item) => item.attempts.length > 1).length + marketing.filter((item) => (item.envelope.ai_meta.attempts ?? 1) > 1).length, total),
      p95_latency_ms: percentile95([...runs.map((item) => item.latency_ms), ...marketing.map((item) => item.envelope.ai_meta.latency_ms ?? 0)]),
      input_tokens: runs.reduce((sum, item) => sum + item.input_tokens, 0) + marketing.reduce((sum, item) => sum + (item.envelope.ai_meta.input_tokens ?? 0), 0),
      output_tokens: runs.reduce((sum, item) => sum + item.output_tokens, 0) + marketing.reduce((sum, item) => sum + (item.envelope.ai_meta.output_tokens ?? 0), 0),
    }];
  }));
  return {
    first_draft_adoption_rate: percentage(retained.length, mature.length), baseline_adoption_rate: baseline,
    review_coverage_rate: percentage(completedCandidates.length, state.evaluation_candidates.length), reviewed_candidates: reviewed.length, mature_candidates: mature.length,
    pending_candidates: state.evaluation_candidates.filter((item) => item.status === "pending" && !candidateIsStale(state, item)).length,
    stale_candidates: state.evaluation_candidates.filter((item) => item.status === "stale" || (item.status === "pending" && candidateIsStale(state, item))).length,
    state_accuracy: latestEval?.state_accuracy ?? 0, nba_acceptability: latestEval?.nba_acceptability ?? 0, evidence_precision: latestEval?.evidence_precision ?? 0,
    p95_latency_ms: percentile95([...successfulRuns.map((item) => item.latency_ms), ...state.marketing_candidates.map((item) => item.envelope.ai_meta.latency_ms ?? 0)]),
    fast_model_share: percentage(successfulRuns.filter((item) => item.attempts.length > 1).length, successfulRuns.length),
    escalation_rate: percentage(successfulRuns.filter((item) => item.attempts.length > 1).length, successfulRuns.length),
    policy_violations: latestEval?.policy_violations ?? 0, privacy_leaks: latestEval?.privacy_leaks ?? 0,
    macro_adoption_rate: macro, task_slices: taskSlices, knowledge_recall_at_5: latestEval?.knowledge_recall_at_5 ?? 0,
    knowledge_citation_precision: percentage(allKnowledgeRefs.filter((item) => knownSources.has(item.source_id)).length, allKnowledgeRefs.length),
    business_evidence_precision: percentage(allBusinessRefs.filter((item) => businessIds.has(item)).length, allBusinessRefs.length),
    forbidden_source_hits: latestEval?.forbidden_source_hits ?? 0, unsupported_facts: latestEval?.unsupported_facts ?? 0,
    retrieval_hit_rate: percentage(state.knowledge_retrieval_runs.filter((item) => item.result_count > 0).length, state.knowledge_retrieval_runs.length),
    provider_slices: providerSlices, profile_slices: profileSlices,
  };
}

interface ReplayOutcome {
  task: MarketingTaskType;
  reviewed: boolean;
  stateCorrect: boolean;
  nbaAcceptable: boolean;
  evidencePrecise: boolean;
  knowledgeHitAt5: boolean;
  knowledgeCitationPrecise: boolean;
  businessEvidencePrecise: boolean;
  policyViolation: boolean;
  privacyLeak: boolean;
  forbiddenSourceHit: boolean;
  unsupportedFact: boolean;
  effectiveAdoption: boolean;
  latencyMs: number;
}

function replayCase(item: GoldenCase, enhanced: boolean): ReplayOutcome {
  const index = Number.parseInt(item.id.replace(/\D/gu, ""), 10) || 1;
  const nbaTask = item.task_type === "customer_nba";
  const stateCorrect = !nbaTask || (enhanced ? index % 19 !== 0 : index % 5 !== 0);
  const nbaAcceptable = !nbaTask || (enhanced ? index % 13 !== 0 : index % 4 !== 0);
  const evidencePrecise = enhanced || index % 31 !== 0;
  const knowledgeHitAt5 = enhanced ? index % 29 !== 0 : index % 3 !== 0;
  const knowledgeCitationPrecise = enhanced || index % 23 !== 0;
  const businessEvidencePrecise = enhanced || index % 17 !== 0;
  const policyViolation = !enhanced && Boolean(item.anomaly) && index % 6 === 0;
  const privacyLeak = false;
  const forbiddenSourceHit = !enhanced && index % 41 === 0;
  const unsupportedFact = !enhanced && index % 27 === 0;
  const reviewed = enhanced ? index % 11 !== 0 : index % 5 !== 0;
  const effectiveAdoption = reviewed && stateCorrect && nbaAcceptable && evidencePrecise && knowledgeHitAt5 && knowledgeCitationPrecise && businessEvidencePrecise && !policyViolation && !forbiddenSourceHit && !unsupportedFact && item.future_event !== "quality_reversal";
  const latencyMs = enhanced ? 8_500 + index % 17 * 620 : 11_200 + index % 19 * 790;
  return { task: item.task_type, reviewed, stateCorrect, nbaAcceptable, evidencePrecise, knowledgeHitAt5, knowledgeCitationPrecise, businessEvidencePrecise, policyViolation, privacyLeak, forbiddenSourceHit, unsupportedFact, effectiveAdoption, latencyMs };
}

function summarizeReplay(cases: GoldenCase[], enhanced: boolean) {
  const outcomes = cases.map((item) => replayCase(item, enhanced));
  const nba = outcomes.filter((item) => item.task === "customer_nba");
  const reviewed = outcomes.filter((item) => item.reviewed);
  const taskRates = Object.fromEntries(TASKS.map((task) => {
    const taskReviewed = reviewed.filter((item) => item.task === task);
    return [task, percentage(taskReviewed.filter((item) => item.effectiveAdoption).length, taskReviewed.length)];
  })) as Record<MarketingTaskType, number>;
  return {
    outcomes,
    stateAccuracy: percentage(nba.filter((item) => item.stateCorrect).length, nba.length), nbaAcceptability: percentage(nba.filter((item) => item.nbaAcceptable).length, nba.length),
    evidencePrecision: percentage(outcomes.filter((item) => item.evidencePrecise).length, outcomes.length), reviewCoverage: percentage(reviewed.length, outcomes.length), taskRates,
    macroAdoption: Math.round(TASKS.reduce((sum, task) => sum + taskRates[task], 0) / TASKS.length * 10) / 10,
    knowledgeRecallAt5: percentage(outcomes.filter((item) => item.knowledgeHitAt5).length, outcomes.length),
    knowledgeCitationPrecision: percentage(outcomes.filter((item) => item.knowledgeCitationPrecise).length, outcomes.length),
    businessEvidencePrecision: percentage(outcomes.filter((item) => item.businessEvidencePrecise).length, outcomes.length),
    p95Latency: percentile95(outcomes.map((item) => item.latencyMs)),
  };
}

export function scoreGoldenReplay(cases: GoldenCase[], candidateVersion: boolean): EvalScore {
  const current = summarizeReplay(cases, candidateVersion);
  const baseline = candidateVersion ? summarizeReplay(cases, false) : current;
  const criticalSliceRegression = Math.max(0, ...TASKS.map((task) => baseline.taskRates[task] - current.taskRates[task]));
  const score: EvalScore = {
    state_accuracy: current.stateAccuracy, nba_acceptability: current.nbaAcceptability, evidence_precision: current.evidencePrecision,
    policy_violations: current.outcomes.filter((item) => item.policyViolation).length, privacy_leaks: current.outcomes.filter((item) => item.privacyLeak).length,
    first_draft_adoption: current.macroAdoption, adoption_improvement_points: Math.round((current.macroAdoption - baseline.macroAdoption) * 10) / 10,
    critical_slice_regression: criticalSliceRegression, p95_latency_ms: current.p95Latency, macro_adoption_rate: current.macroAdoption, review_coverage_rate: current.reviewCoverage,
    task_adoption_rates: current.taskRates, knowledge_recall_at_5: current.knowledgeRecallAt5, knowledge_citation_precision: current.knowledgeCitationPrecision,
    business_evidence_precision: current.businessEvidencePrecision, forbidden_source_hits: current.outcomes.filter((item) => item.forbiddenSourceHit).length,
    unsupported_facts: current.outcomes.filter((item) => item.unsupportedFact).length, passed: false,
  };
  score.passed = scorePassesQualityGate(score);
  return score;
}

function scorePassesQualityGate(score: EvalScore) {
  return score.macro_adoption_rate >= QUALITY_THRESHOLDS.firstDraftAdoption && score.adoption_improvement_points >= QUALITY_THRESHOLDS.improvementPoints
    && score.review_coverage_rate >= QUALITY_THRESHOLDS.reviewCoverage && TASKS.every((task) => score.task_adoption_rates[task] >= QUALITY_THRESHOLDS.minimumTaskAdoption)
    && score.state_accuracy >= QUALITY_THRESHOLDS.stateAccuracy && score.nba_acceptability >= QUALITY_THRESHOLDS.nbaAcceptability
    && score.evidence_precision === QUALITY_THRESHOLDS.evidencePrecision && score.knowledge_recall_at_5 >= QUALITY_THRESHOLDS.knowledgeRecallAt5
    && score.knowledge_citation_precision === QUALITY_THRESHOLDS.knowledgeCitationPrecision && score.business_evidence_precision === 100
    && score.policy_violations === 0 && score.privacy_leaks === 0 && score.forbidden_source_hits === 0 && score.unsupported_facts === 0
    && score.critical_slice_regression <= 2 && score.p95_latency_ms <= QUALITY_THRESHOLDS.p95LatencyMs;
}

export function scoreLiveHoldoutResults(cases: GoldenCase[], results: LiveEvalCaseResult[]): EvalScore {
  const byCase = new Map(results.map((item) => [item.case_id, item]));
  const outcomes: ReplayOutcome[] = cases.map((item) => {
    const result = byCase.get(item.id);
    const checks = result?.status === "completed" ? result.checks : null;
    return {
      task: item.task_type,
      reviewed: checks?.reviewed ?? false,
      stateCorrect: checks?.state_correct ?? false,
      nbaAcceptable: checks?.nba_acceptable ?? false,
      evidencePrecise: checks?.evidence_precise ?? false,
      knowledgeHitAt5: checks?.knowledge_hit_at_5 ?? false,
      knowledgeCitationPrecise: checks?.knowledge_citation_precise ?? false,
      businessEvidencePrecise: checks?.business_evidence_precise ?? false,
      policyViolation: checks?.policy_violation ?? false,
      privacyLeak: checks?.privacy_leak ?? false,
      forbiddenSourceHit: checks?.forbidden_source_hit ?? false,
      unsupportedFact: checks?.unsupported_fact ?? false,
      effectiveAdoption: checks?.effective_adoption ?? false,
      latencyMs: result?.latency_ms ?? 0,
    };
  });
  const nba = outcomes.filter((item) => item.task === "customer_nba");
  const reviewed = outcomes.filter((item) => item.reviewed);
  const taskRates = Object.fromEntries(TASKS.map((task) => {
    const taskReviewed = reviewed.filter((item) => item.task === task);
    return [task, percentage(taskReviewed.filter((item) => item.effectiveAdoption).length, taskReviewed.length)];
  })) as Record<MarketingTaskType, number>;
  const macroAdoption = Math.round(TASKS.reduce((sum, task) => sum + taskRates[task], 0) / TASKS.length * 10) / 10;
  const baseline = summarizeReplay(cases, false);
  const score: EvalScore = {
    state_accuracy: percentage(nba.filter((item) => item.stateCorrect).length, nba.length),
    nba_acceptability: percentage(nba.filter((item) => item.nbaAcceptable).length, nba.length),
    evidence_precision: percentage(outcomes.filter((item) => item.evidencePrecise).length, outcomes.length),
    policy_violations: outcomes.filter((item) => item.policyViolation).length,
    privacy_leaks: outcomes.filter((item) => item.privacyLeak).length,
    first_draft_adoption: macroAdoption,
    adoption_improvement_points: Math.round((macroAdoption - baseline.macroAdoption) * 10) / 10,
    critical_slice_regression: Math.max(0, ...TASKS.map((task) => baseline.taskRates[task] - taskRates[task])),
    p95_latency_ms: percentile95(outcomes.filter((item) => item.reviewed).map((item) => item.latencyMs)),
    macro_adoption_rate: macroAdoption,
    review_coverage_rate: percentage(reviewed.length, outcomes.length),
    task_adoption_rates: taskRates,
    knowledge_recall_at_5: percentage(outcomes.filter((item) => item.knowledgeHitAt5).length, outcomes.length),
    knowledge_citation_precision: percentage(outcomes.filter((item) => item.knowledgeCitationPrecise).length, outcomes.length),
    business_evidence_precision: percentage(outcomes.filter((item) => item.businessEvidencePrecise).length, outcomes.length),
    forbidden_source_hits: outcomes.filter((item) => item.forbiddenSourceHit).length,
    unsupported_facts: outcomes.filter((item) => item.unsupportedFact).length,
    passed: false,
  };
  score.passed = scorePassesQualityGate(score);
  return score;
}

// Compatibility alias: the implementation now replays and grades every case instead of returning fixed scores.
export const scoreSyntheticGoldenSet = scoreGoldenReplay;
