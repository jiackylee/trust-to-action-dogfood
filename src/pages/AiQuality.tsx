import { useState, type ReactNode } from "react";
import { Activity, AlertTriangle, ArrowRight, Bot, Check, Clock3, FlaskConical, GitBranch, Gauge, ShieldCheck, Sparkles, TrendingUp, UserCheck, X } from "lucide-react";
import { Link } from "react-router-dom";
import { InlineAlert, LoadingState, SectionHeader, StatusBadge } from "../components/UI";
import { actorForRole, can } from "../domain/permissions";
import { calculateQualityMetrics, QUALITY_THRESHOLDS } from "../domain/quality";
import type { EvaluationDecision, EvaluationReasonCode, EvaluationReviewOutcome } from "../domain/types";
import { useAppStore } from "../store/AppStore";

const REASON_LABELS: Record<EvaluationReasonCode, string> = {
  wrong_state: "状态错误",
  wrong_evidence: "证据错误",
  wrong_nba: "NBA 不合适",
  missing_context: "缺少上下文",
  risk_compliance: "风险或合规",
  too_generic: "过于泛化",
  other: "其他",
};

export function AiQuality() {
  const { state, loading, runGoldenEvaluation, createPromptVersion, createRouterVersion, promoteAiVersion, rollbackAiVersion, recordEvaluationReview, explainError } = useAppStore();
  const [promptId, setPromptId] = useState("prompt-v2.1-rc1");
  const [routerId, setRouterId] = useState("router-v2.1-rc1");
  const [split, setSplit] = useState<"development" | "holdout">("development");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<{ code: string; message: string } | null>(null);
  const [reviewInputs, setReviewInputs] = useState<Record<string, string>>({});
  const [versionKind, setVersionKind] = useState<"prompt" | "router">("prompt");
  const [versionName, setVersionName] = useState("customer-eval-v2.1.0-rc2");
  const [versionDescription, setVersionDescription] = useState("补充失败聚类示例并收紧未知证据约束");
  const [confidenceThreshold, setConfidenceThreshold] = useState(75);
  if (loading || !state) return <LoadingState />;

  const metrics = calculateQualityMetrics(state);
  const improvement = metrics.first_draft_adoption_rate - metrics.baseline_adoption_rate;
  const latestEval = [...state.eval_runs].reverse().find((item) => item.status === "completed");
  const myName = actorForRole(state.role);
  const myDecisions = state.evaluation_decisions.filter((item) => item.actor === myName);
  const reasonCounts = Object.entries(REASON_LABELS).map(([code, label]) => ({ code, label, count: state.evaluation_decisions.filter((item) => item.reason_code === code).length })).sort((left, right) => right.count - left.count);
  const canManage = can(state.role, "manage_ai_quality");
  const canPublish = can(state.role, "publish_ai_version");

  async function runEval() {
    setBusy("eval"); setError(null);
    try { await runGoldenEvaluation(promptId, routerId, split); }
    catch (cause) { setError(explainError(cause)); } finally { setBusy(null); }
  }

  async function promote(kind: "prompt" | "router", id: string, revision: number) {
    setBusy(`${kind}:${id}`); setError(null);
    try { await promoteAiVersion(kind, id, revision); }
    catch (cause) { setError(explainError(cause)); } finally { setBusy(null); }
  }

  async function rollback(kind: "prompt" | "router", id: string, revision: number) {
    setBusy(`rollback:${kind}:${id}`); setError(null);
    try { await rollbackAiVersion(kind, id, revision); }
    catch (cause) { setError(explainError(cause)); } finally { setBusy(null); }
  }

  async function createVersion() {
    if (!versionName.trim() || !versionDescription.trim()) return;
    setBusy("create-version"); setError(null);
    try {
      if (versionKind === "prompt") await createPromptVersion(versionName, versionDescription);
      else await createRouterVersion(versionName, versionDescription, confidenceThreshold);
      setVersionName(versionKind === "prompt" ? "customer-eval-v2.1.0-rc-next" : "router-v2.1-risk-next");
      setVersionDescription("");
    } catch (cause) { setError(explainError(cause)); } finally { setBusy(null); }
  }

  async function review(decisionId: string, outcome: EvaluationReviewOutcome, revision: number) {
    const reason = reviewInputs[decisionId] ?? "";
    if (outcome !== "retained" && !reason.trim()) return;
    setBusy(`review:${decisionId}`); setError(null);
    try { await recordEvaluationReview(decisionId, outcome, reason, revision); setReviewInputs((items) => ({ ...items, [decisionId]: "" })); }
    catch (cause) { setError(explainError(cause)); } finally { setBusy(null); }
  }

  return <>
    <SectionHeader eyebrow="AI 质量工作域" title={state.role === "sales" ? "我的 AI 反馈" : "AI 质量中心"} description="先达到准确率与安全门槛，再优化模型成本和时延。所有结果来自合成数据。" />
    {error && <InlineAlert tone="danger" title="操作未完成">{error.message}<details className="technical-details"><summary>技术详情</summary><code>{error.code}</code></details></InlineAlert>}

    <section className="quality-north-star">
      <div><span>North Star</span><h2>首稿有效采用率</h2><p>48 小时内审阅、原样采用且 7 天未因质量问题撤销。</p></div>
      <strong>{metrics.first_draft_adoption_rate}%</strong>
      <div className={improvement >= QUALITY_THRESHOLDS.improvementPoints ? "quality-delta success-text" : "quality-delta warning-text"}><TrendingUp />较 2.0 基线 {improvement >= 0 ? "+" : ""}{improvement.toFixed(1)}pp<small>目标 +{QUALITY_THRESHOLDS.improvementPoints}pp 且不低于 {QUALITY_THRESHOLDS.firstDraftAdoption}%</small></div>
    </section>

    <div className="quality-metrics">
      <QualityMetric icon={<UserCheck />} label="审阅覆盖" value={`${metrics.review_coverage_rate}%`} target={`目标 ≥ ${QUALITY_THRESHOLDS.reviewCoverage}%`} pass={metrics.review_coverage_rate >= QUALITY_THRESHOLDS.reviewCoverage} />
      <QualityMetric icon={<Gauge />} label="状态准确率" value={`${metrics.state_accuracy}%`} target={`目标 ≥ ${QUALITY_THRESHOLDS.stateAccuracy}%`} pass={metrics.state_accuracy >= QUALITY_THRESHOLDS.stateAccuracy} />
      <QualityMetric icon={<Bot />} label="NBA 可接受" value={`${metrics.nba_acceptability}%`} target={`目标 ≥ ${QUALITY_THRESHOLDS.nbaAcceptability}%`} pass={metrics.nba_acceptability >= QUALITY_THRESHOLDS.nbaAcceptability} />
      <QualityMetric icon={<ShieldCheck />} label="证据精度" value={`${metrics.evidence_precision}%`} target="必须 100%" pass={metrics.evidence_precision === 100} />
      <QualityMetric icon={<Clock3 />} label="P95 生成" value={`${(metrics.p95_latency_ms / 1000).toFixed(1)}s`} target="目标 ≤ 30s" pass={metrics.p95_latency_ms <= QUALITY_THRESHOLDS.p95LatencyMs} />
      <QualityMetric icon={<GitBranch />} label="模型升级率" value={`${metrics.escalation_rate}%`} target={`Terra 占比 ${metrics.fast_model_share}%`} pass />
    </div>

    {(metrics.policy_violations > 0 || metrics.privacy_leaks > 0) && <InlineAlert tone="danger" title="安全门禁未通过">策略违规 {metrics.policy_violations}，隐私泄露 {metrics.privacy_leaks}。任何非零结果都会阻断发布。</InlineAlert>}

    {state.role === "sales" ? <SalesFeedback decisions={myDecisions} inputs={reviewInputs} busy={busy} onInput={(id, value) => setReviewInputs((items) => ({ ...items, [id]: value }))} onReview={review} /> : <>
      <div className="quality-workspace">
        <section className="panel quality-feedback"><div className="panel-heading"><div><span className="eyebrow">行为反馈</span><h2>修改与拒绝原因</h2></div><Activity /></div>{reasonCounts.map((item) => <div className="reason-bar" key={item.code}><span>{item.label}</span><i><b style={{ width: `${Math.min(100, item.count * 14)}%` }} /></i><strong>{item.count}</strong></div>)}</section>
        <section className="panel route-health"><div className="panel-heading"><div><span className="eyebrow">动态路由</span><h2>质量优先，两档模型</h2></div><GitBranch /></div><dl className="route-stats"><div><dt>主模型</dt><dd>gpt-5.6</dd></div><div><dt>轻量模型</dt><dd>gpt-5.6-terra</dd></div><div><dt>Terra 分流</dt><dd>{metrics.fast_model_share}%</dd></div><div><dt>升级至主模型</dt><dd>{metrics.escalation_rate}%</dd></div></dl><InlineAlert tone="info" title="只升不降">Terra 低置信、拒答、结构或策略失败时最多升级一次；主模型失败后阻断。</InlineAlert></section>
      </div>

      {canManage && <section className="panel version-authoring desktop-authoring">
        <div className="panel-heading"><div><span className="eyebrow">仅桌面维护</span><h2>创建 Prompt / 路由候选</h2></div><Sparkles /></div>
        <div className="segmented-control" aria-label="候选版本类型"><button className={versionKind === "prompt" ? "active" : ""} aria-pressed={versionKind === "prompt"} onClick={() => { setVersionKind("prompt"); setVersionName("customer-eval-v2.1.0-rc-next"); }}>Prompt</button><button className={versionKind === "router" ? "active" : ""} aria-pressed={versionKind === "router"} onClick={() => { setVersionKind("router"); setVersionName("router-v2.1-risk-next"); }}>路由</button></div>
        <div className="version-authoring-fields"><label><span>版本名称</span><input value={versionName} onChange={(event) => setVersionName(event.target.value)} /></label><label className="version-description"><span>变更说明与策略摘要</span><textarea rows={2} value={versionDescription} onChange={(event) => setVersionDescription(event.target.value)} /></label>{versionKind === "router" && <label><span>Terra 升级阈值</span><input type="number" min={50} max={95} value={confidenceThreshold} onChange={(event) => setConfidenceThreshold(Number(event.target.value))} /></label>}<button className="primary-button" disabled={busy === "create-version" || !versionName.trim() || !versionDescription.trim()} onClick={() => void createVersion()}><Sparkles />创建候选</button></div>
      </section>}
      {canManage && <div className="mobile-authoring-notice"><InlineAlert tone="info" title="请使用桌面端">Prompt 编辑、黄金集管理和版本对比在桌面端开放；移动端仍可查看质量指标。</InlineAlert></div>}

      <section className="panel eval-console">
        <div className="panel-heading"><div><span className="eyebrow">200 条纯合成黄金集</span><h2>版本回归与发布门禁</h2></div><FlaskConical /></div>
        <div className="eval-controls"><label><span>Prompt 候选</span><select value={promptId} onChange={(event) => setPromptId(event.target.value)}>{state.prompt_versions.map((item) => <option key={item.id} value={item.id}>{item.name} · {item.status}</option>)}</select></label><label><span>路由候选</span><select value={routerId} onChange={(event) => setRouterId(event.target.value)}>{state.router_versions.map((item) => <option key={item.id} value={item.id}>{item.name} · {item.status}</option>)}</select></label><label><span>数据切分</span><select value={split} onChange={(event) => setSplit(event.target.value as typeof split)}><option value="development">调优集 · 160</option><option value="holdout">锁定 Holdout · 40</option></select></label><button className="primary-button" disabled={!canManage || busy === "eval"} onClick={() => void runEval()}><Sparkles />{busy === "eval" ? "正在评分…" : "运行离线评测"}</button></div>
        {!canManage && <small className="muted">负责人可查看和发布；运行评测由运营执行。</small>}
        {latestEval?.score && <div className={`eval-result ${latestEval.score.passed ? "eval-pass" : "eval-blocked"}`}><span>{latestEval.split === "holdout" ? "锁定 Holdout" : "调优集"} · {latestEval.case_count} 条</span><strong>{latestEval.score.passed ? <><Check />全部门槛通过</> : <><X />发布被阻断</>}</strong><small>状态 {latestEval.score.state_accuracy.toFixed(1)}% · NBA {latestEval.score.nba_acceptability.toFixed(1)}% · 首稿采用 {latestEval.score.first_draft_adoption}%（+{latestEval.score.adoption_improvement_points.toFixed(1)}pp） · 关键切片回归 {latestEval.score.critical_slice_regression.toFixed(1)}pp · P95 {(latestEval.score.p95_latency_ms / 1000).toFixed(1)}s</small></div>}
      </section>

      <section className="version-band">
        <VersionTable title="Prompt 版本" rows={state.prompt_versions} kind="prompt" canPublish={canPublish} busy={busy} onPromote={promote} onRollback={rollback} />
        <VersionTable title="路由版本" rows={state.router_versions} kind="router" canPublish={canPublish} busy={busy} onPromote={promote} onRollback={rollback} />
      </section>
    </>}
  </>;
}

function QualityMetric({ icon, label, value, target, pass }: { icon: ReactNode; label: string; value: string; target: string; pass: boolean }) {
  return <div className="quality-metric"><span>{icon}{label}</span><strong>{value}</strong><small className={pass ? "success-text" : "warning-text"}>{pass ? <Check /> : <AlertTriangle />}{target}</small></div>;
}

function SalesFeedback({ decisions, inputs, busy, onInput, onReview }: { decisions: EvaluationDecision[]; inputs: Record<string, string>; busy: string | null; onInput(id: string, value: string): void; onReview(id: string, outcome: EvaluationReviewOutcome, revision: number): void }) {
  const pending = decisions.filter((item) => item.decision === "accepted" && item.review_outcome === null);
  return <div className="sales-quality-layout"><section className="panel"><div className="panel-heading"><div><span className="eyebrow">7 天质量复查</span><h2>{pending.length} 条待确认</h2></div><UserCheck /></div>{pending.length ? pending.map((item) => <article className="review-row" key={item.id}><div><strong>{item.original_evaluation.recommendation}</strong><small>{item.customer_id} · {item.original_evaluation.state_before} → {item.original_evaluation.state_after}</small></div><input aria-label={`${item.customer_id} 复查说明`} placeholder="撤销或新增证据时填写原因" value={inputs[item.id] ?? ""} onChange={(event) => onInput(item.id, event.target.value)} /><div><button className="secondary-button" disabled={busy === `review:${item.id}`} onClick={() => onReview(item.id, "retained", item.revision)}><Check />保持有效</button><button className="secondary-button" disabled={!inputs[item.id]?.trim() || busy === `review:${item.id}`} onClick={() => onReview(item.id, "new_evidence", item.revision)}>新增证据</button><button className="text-button danger-text" disabled={!inputs[item.id]?.trim() || busy === `review:${item.id}`} onClick={() => onReview(item.id, "quality_reversal", item.revision)}>质量撤销</button></div></article>) : <p className="muted">当前没有待复查的原样采用记录。</p>}</section><section className="panel"><div className="panel-heading"><div><span className="eyebrow">我的反馈</span><h2>最近判断</h2></div><Activity /></div>{decisions.slice(0, 8).map((item) => <div className="feedback-history" key={item.id}><StatusBadge status={item.decision === "accepted" ? "approved" : item.decision === "modified" ? "review" : "returned"} /><span><strong>{item.customer_id} · {item.decision === "accepted" ? "原样采用" : item.decision === "modified" ? "修改后采用" : "拒绝"}</strong><small>{item.reason_code ? REASON_LABELS[item.reason_code as EvaluationReasonCode] : "首稿无需修改"} · {item.review_outcome ?? "待 7 天复查"}</small></span><Link to={`/customers/${item.customer_id}`} aria-label={`查看 ${item.customer_id}`}><ArrowRight /></Link></div>)}</section></div>;
}

function VersionTable({ title, rows, kind, canPublish, busy, onPromote, onRollback }: { title: string; rows: Array<{ id: string; revision: number; name: string; status: "draft" | "published" | "archived"; description: string; updated_at: string; published_at?: string | null }>; kind: "prompt" | "router"; canPublish: boolean; busy: string | null; onPromote(kind: "prompt" | "router", id: string, revision: number): void; onRollback(kind: "prompt" | "router", id: string, revision: number): void }) {
  return <section className="panel version-panel"><div className="panel-heading"><div><span className="eyebrow">版本治理</span><h2>{title}</h2></div><GitBranch /></div>{rows.map((item) => <div className="version-row" key={item.id}><StatusBadge status={item.status === "published" ? "approved" : item.status === "draft" ? "review" : "done"} /><span><strong>{item.name}</strong><small>{item.description}</small></span>{item.status === "draft" && <button className="secondary-button" disabled={!canPublish || busy === `${kind}:${item.id}`} onClick={() => onPromote(kind, item.id, item.revision)}>发布</button>}{item.status === "archived" && item.published_at && <button className="secondary-button" disabled={!canPublish || busy === `rollback:${kind}:${item.id}`} onClick={() => onRollback(kind, item.id, item.revision)}>回滚</button>}</div>)}</section>;
}
