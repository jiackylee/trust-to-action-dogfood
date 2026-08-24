import { useEffect, useState, type ReactNode } from "react";
import { Activity, AlertTriangle, ArrowRight, Bot, Check, Clock3, Cloud, FlaskConical, GitBranch, Gauge, Pause, Play, Server, ShieldCheck, Sparkles, TrendingUp, UserCheck, X } from "lucide-react";
import { Link } from "react-router-dom";
import { InlineAlert, LoadingState, Modal, SectionHeader, StatusBadge } from "../components/UI";
import { actorForRole, can } from "../domain/permissions";
import { calculateQualityMetrics, QUALITY_THRESHOLDS } from "../domain/quality";
import type { AiProtocol, AiProviderId, EvaluationDecision, EvaluationReasonCode, EvaluationReviewOutcome } from "../domain/types";
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
const PROVIDER_LABELS: Record<AiProviderId, string> = { openai: "OpenAI", deepseek: "DeepSeek", anthropic: "Anthropic", qwen: "Qwen", custom: "企业私有端点" };
const PROTOCOL_LABELS: Record<AiProtocol, string> = { openai_responses: "Responses", openai_chat: "Chat JSON", anthropic_messages: "Messages" };

export function AiQuality() {
  const { state, loading, health, runGoldenEvaluation, startLiveHoldout, pauseLiveHoldout, promoteAiVersion, rollbackAiVersion, recordEvaluationReview, reload, explainError } = useAppStore();
  const [brainId, setBrainId] = useState("brain-v2.2-published");
  const [routerId, setRouterId] = useState("router-v2.1-rc1");
  const [split, setSplit] = useState<"development" | "holdout">("development");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<{ code: string; message: string } | null>(null);
  const [reviewInputs, setReviewInputs] = useState<Record<string, string>>({});
  const [usageDialogOpen, setUsageDialogOpen] = useState(false);
  const [usageConfirmed, setUsageConfirmed] = useState(false);
  const liveRunning = state?.eval_runs.some((item) => item.mode === "live" && item.status === "running") ?? false;
  useEffect(() => {
    if (!liveRunning) return;
    const timer = window.setInterval(() => void reload(), 1500);
    return () => window.clearInterval(timer);
  }, [liveRunning, reload]);
  if (loading || !state) return <LoadingState />;

  const metrics = calculateQualityMetrics(state);
  const improvement = metrics.macro_adoption_rate - metrics.baseline_adoption_rate;
  const latestEval = [...state.eval_runs].reverse().find((item) => item.status === "completed");
  const latestLiveEval = [...state.eval_runs].reverse().find((item) => item.mode === "live");
  const myName = actorForRole(state.role);
  const myDecisions = state.evaluation_decisions.filter((item) => item.actor === myName);
  const reasonCounts = Object.entries(REASON_LABELS).map(([code, label]) => ({ code, label, count: state.evaluation_decisions.filter((item) => item.reason_code === code).length })).sort((left, right) => right.count - left.count);
  const canManage = can(state.role, "manage_ai_quality");
  const canPublish = can(state.role, "publish_ai_version");
  const activeProfile = state.model_profiles.find((item) => item.status === "active");

  async function runEval() {
    setBusy("eval"); setError(null);
    try { await runGoldenEvaluation(brainId, routerId, split); }
    catch (cause) { setError(explainError(cause)); } finally { setBusy(null); }
  }

  async function runLiveEval() {
    setBusy("live-eval"); setError(null);
    const resumable = latestLiveEval && latestLiveEval.status !== "completed" && latestLiveEval.marketing_brain_version_id === brainId && latestLiveEval.router_version_id === routerId;
    const key = resumable ? latestLiveEval.idempotency_key! : `live-holdout-${crypto.randomUUID()}`;
    try {
      await startLiveHoldout(brainId, routerId, key);
      setUsageDialogOpen(false);
      setUsageConfirmed(false);
    } catch (cause) { setError(explainError(cause)); } finally { setBusy(null); }
  }

  async function pauseLive() {
    if (!latestLiveEval) return;
    setBusy("pause-live"); setError(null);
    try { await pauseLiveHoldout(latestLiveEval.id, latestLiveEval.revision); }
    catch (cause) { setError(explainError(cause)); } finally { setBusy(null); }
  }

  async function promote(kind: "brain" | "router", id: string, revision: number) {
    setBusy(`${kind}:${id}`); setError(null);
    try { await promoteAiVersion(kind, id, revision); }
    catch (cause) { setError(explainError(cause)); } finally { setBusy(null); }
  }

  async function rollback(kind: "brain" | "router", id: string, revision: number) {
    setBusy(`rollback:${kind}:${id}`); setError(null);
    try { await rollbackAiVersion(kind, id, revision); }
    catch (cause) { setError(explainError(cause)); } finally { setBusy(null); }
  }

  async function review(decisionId: string, outcome: EvaluationReviewOutcome, revision: number) {
    const reason = reviewInputs[decisionId] ?? "";
    if (outcome !== "retained" && !reason.trim()) return;
    setBusy(`review:${decisionId}`); setError(null);
    try { await recordEvaluationReview(decisionId, outcome, reason, revision); setReviewInputs((items) => ({ ...items, [decisionId]: "" })); }
    catch (cause) { setError(explainError(cause)); } finally { setBusy(null); }
  }

  return <>
    <SectionHeader eyebrow="AI 质量工作域" title={state.role === "sales" ? "我的 AI 反馈" : "AI 质量中心"} description="按策略、Brief、草稿与 NBA 四类输出等权衡量采用质量；引用、事实和合规门禁独立计分。" />
    {error && <InlineAlert tone="danger" title="操作未完成">{error.message}<details className="technical-details"><summary>技术详情</summary><code>{error.code}</code></details></InlineAlert>}

    <section className="quality-north-star">
      <div><span>North Star</span><h2>决策有效采用率</h2><p>四类候选分别计算 48 小时原样采用与 7 天质量保持，再取等权平均。</p></div>
      <strong>{metrics.macro_adoption_rate}%</strong>
      <div className={improvement >= QUALITY_THRESHOLDS.improvementPoints ? "quality-delta success-text" : "quality-delta warning-text"}><TrendingUp />较 2.1 同集基线 {improvement >= 0 ? "+" : ""}{improvement.toFixed(1)}pp<small>目标 +{QUALITY_THRESHOLDS.improvementPoints}pp 且不低于 {QUALITY_THRESHOLDS.firstDraftAdoption}%</small></div>
    </section>

    <div className="quality-metrics">
      <QualityMetric icon={<UserCheck />} label="最低审阅覆盖" value={`${Math.min(...Object.values(metrics.task_slices).map((item) => item.review_coverage_rate))}%`} target={`单类目标 ≥ ${QUALITY_THRESHOLDS.reviewCoverage}%`} pass={Object.values(metrics.task_slices).every((item) => item.review_coverage_rate >= QUALITY_THRESHOLDS.reviewCoverage)} />
      <QualityMetric icon={<Gauge />} label="Recall@5" value={`${metrics.knowledge_recall_at_5}%`} target={`目标 ≥ ${QUALITY_THRESHOLDS.knowledgeRecallAt5}%`} pass={metrics.knowledge_recall_at_5 >= QUALITY_THRESHOLDS.knowledgeRecallAt5} />
      <QualityMetric icon={<Bot />} label="检索命中" value={`${metrics.retrieval_hit_rate}%`} target="四类任务有知识依据" pass={metrics.retrieval_hit_rate >= 95} />
      <QualityMetric icon={<ShieldCheck />} label="知识引用精度" value={`${metrics.knowledge_citation_precision}%`} target="必须 100%" pass={metrics.knowledge_citation_precision === 100} />
      <QualityMetric icon={<Clock3 />} label="P95 生成" value={`${(metrics.p95_latency_ms / 1000).toFixed(1)}s`} target="目标 ≤ 30s" pass={metrics.p95_latency_ms <= QUALITY_THRESHOLDS.p95LatencyMs} />
      <QualityMetric icon={<GitBranch />} label="备用回退率" value={`${metrics.escalation_rate}%`} target="仅同供应商回退一次" pass />
    </div>

    <section className="panel quality-slices"><div className="panel-heading"><div><span className="eyebrow">四类质量切片</span><h2>决策采用与知识适用</h2></div><Gauge /></div><div className="quality-slice-grid">{Object.entries(metrics.task_slices).map(([task, slice]) => <article key={task}><span>{({ weekly_strategy: "本周策略", content_brief: "内容 Brief", content_draft: "内容草稿", customer_nba: "客户 NBA" } as Record<string, string>)[task]}</span><strong className={slice.adoption_rate >= QUALITY_THRESHOLDS.minimumTaskAdoption ? "success-text" : "warning-text"}>{slice.adoption_rate}%</strong><dl><div><dt>审阅覆盖</dt><dd>{slice.review_coverage_rate}%</dd></div><div><dt>引用精度</dt><dd>{slice.knowledge_citation_precision}%</dd></div><div><dt>来源适用</dt><dd>{slice.source_applicability_rate}%</dd></div><div><dt>P95</dt><dd>{(slice.p95_latency_ms / 1000).toFixed(1)}s</dd></div></dl><small>单类门槛 ≥ {QUALITY_THRESHOLDS.minimumTaskAdoption}% · {slice.pending} 条待审</small></article>)}</div></section>

    {state.role !== "sales" && <section className="panel provider-quality-panel"><div className="panel-heading"><div><span className="eyebrow">模型兼容性与数据去向</span><h2>供应商、协议与 Profile 质量</h2></div><Cloud /></div><div className="provider-quality-grid">{Object.values(metrics.profile_slices).map((slice) => <article key={slice.profile_id}><div className="provider-quality-head"><span className="provider-mark">{slice.endpoint_scope === "private" ? <Server /> : <Cloud />}</span><span><strong>{PROVIDER_LABELS[slice.provider]}</strong><small>{slice.profile_name}</small></span><b>{slice.success_rate}%</b></div><dl><div><dt>模型</dt><dd>{slice.model}</dd></div><div><dt>协议</dt><dd>{PROTOCOL_LABELS[slice.protocol]}</dd></div><div><dt>回退</dt><dd>{slice.fallback_rate}%</dd></div><div><dt>P95</dt><dd>{(slice.p95_latency_ms / 1000).toFixed(1)}s</dd></div><div><dt>Token</dt><dd>{slice.input_tokens + slice.output_tokens}</dd></div><div><dt>数据边界</dt><dd>{slice.endpoint_scope === "private" ? "企业私有" : "公有云"}</dd></div></dl></article>)}</div></section>}

    {(metrics.policy_violations > 0 || metrics.privacy_leaks > 0) && <InlineAlert tone="danger" title="安全门禁未通过">策略违规 {metrics.policy_violations}，隐私泄露 {metrics.privacy_leaks}。任何非零结果都会阻断发布。</InlineAlert>}

    {state.role === "sales" ? <SalesFeedback decisions={myDecisions} inputs={reviewInputs} busy={busy} onInput={(id, value) => setReviewInputs((items) => ({ ...items, [id]: value }))} onReview={review} /> : <>
      <div className="quality-workspace">
        <section className="panel quality-feedback"><div className="panel-heading"><div><span className="eyebrow">行为反馈</span><h2>修改与拒绝原因</h2></div><Activity /></div>{reasonCounts.map((item) => <div className="reason-bar" key={item.code}><span>{item.label}</span><i><b style={{ width: `${Math.min(100, item.count * 14)}%` }} /></i><strong>{item.count}</strong></div>)}</section>
        <section className="panel route-health"><div className="panel-heading"><div><span className="eyebrow">全局模型 Profile</span><h2>{activeProfile ? `${PROVIDER_LABELS[activeProfile.provider]} · ${activeProfile.primary_model}` : "尚未激活"}</h2></div><GitBranch /></div><dl className="route-stats"><div><dt>协议</dt><dd>{activeProfile ? PROTOCOL_LABELS[activeProfile.protocol] : "—"}</dd></div><div><dt>备用模型</dt><dd>{activeProfile?.fallback_model ?? "未配置"}</dd></div><div><dt>Fallback</dt><dd>{metrics.escalation_rate}%</dd></div><div><dt>数据边界</dt><dd>{activeProfile?.endpoint_scope === "private" ? "企业私有" : "公有云"}</dd></div></dl><InlineAlert tone="info" title="不跨供应商传输">七类任务均从全局主模型开始；只有可回退错误会切换一次同供应商备用模型，随后失败即阻断。</InlineAlert></section>
      </div>

      {canManage && <div className="mobile-authoring-notice"><InlineAlert tone="info" title="请使用桌面端">营销脑哈希对比、黄金集和模型 Profile 治理在桌面端开放；移动端仍可查看质量指标。</InlineAlert></div>}

      <section className="panel eval-console">
        <div className="panel-heading"><div><span className="eyebrow">440 条纯合成黄金集</span><h2>逐条回放、检索与确定性 grader</h2></div><FlaskConical /></div>
        <div className="eval-controls"><label><span>营销脑版本</span><select value={brainId} onChange={(event) => setBrainId(event.target.value)}>{state.marketing_brain_versions.map((item) => <option key={item.id} value={item.id}>{item.name} · {item.status}</option>)}</select></label><label><span>兼容评测基线</span><select value={routerId} onChange={(event) => setRouterId(event.target.value)}>{state.router_versions.map((item) => <option key={item.id} value={item.id}>{item.name} · 仅迁移兼容</option>)}</select></label><label><span>数据切分</span><select value={split} onChange={(event) => setSplit(event.target.value as typeof split)}><option value="development">调优集 · 352</option><option value="holdout">锁定 Holdout · 88</option></select></label><button className="primary-button" disabled={!canManage || busy === "eval"} onClick={() => void runEval()}><Sparkles />{busy === "eval" ? "正在评分…" : "运行离线评测"}</button></div>
        {!canManage && <small className="muted">负责人可查看和发布；运行评测由运营执行。</small>}
        {latestEval?.score && <div className={`eval-result ${latestEval.score.passed ? "eval-pass" : "eval-blocked"}`}><span>{latestEval.split === "holdout" ? "锁定 Holdout" : "调优集"} · {latestEval.case_count} 条</span><strong>{latestEval.score.passed ? <><Check />全部门槛通过</> : <><X />发布被阻断</>}</strong><small>宏平均 {latestEval.score.macro_adoption_rate}%（+{latestEval.score.adoption_improvement_points.toFixed(1)}pp） · Recall@5 {latestEval.score.knowledge_recall_at_5}% · 知识引用 {latestEval.score.knowledge_citation_precision}% · 业务证据 {latestEval.score.business_evidence_precision}% · P95 {(latestEval.score.p95_latency_ms / 1000).toFixed(1)}s</small></div>}
        <div className="live-eval-console">
          <div><span className="eyebrow">真实模型发布门禁</span><h3>88 条锁定 Holdout</h3><p>负责人确认 API 用量后异步执行，最大并发 2。逐条结果、token 和幂等键写入 SQLite，可暂停和断点续跑。</p></div>
          <div className="live-eval-actions">
            {latestLiveEval?.status === "running"
              ? <button className="secondary-button" disabled={busy === "pause-live" || !canPublish} onClick={() => void pauseLive()}><Pause />暂停</button>
              : <button className="primary-button" disabled={!canPublish || busy === "live-eval" || !health?.ai_configured || !health?.knowledge_configured} onClick={() => setUsageDialogOpen(true)}><Play />{latestLiveEval && latestLiveEval.status !== "completed" ? "继续真实运行" : "启动真实运行"}</button>}
          </div>
          {latestLiveEval && <div className="live-eval-progress" aria-label={`真实 Holdout 已处理 ${latestLiveEval.processed_count ?? 0} 条，共 ${latestLiveEval.case_count} 条`}>
            <div><strong>{latestLiveEval.processed_count ?? 0} / {latestLiveEval.case_count}</strong><span>{latestLiveEval.status === "running" ? "运行中" : latestLiveEval.status === "paused" ? "已暂停" : latestLiveEval.status === "failed" ? "有失败，可续跑" : "已完成"}</span></div>
            <progress max={latestLiveEval.case_count} value={latestLiveEval.processed_count ?? 0} />
            <small>成功 {latestLiveEval.successful_count ?? 0} · 失败 {latestLiveEval.failed_count ?? 0} · 输入 {latestLiveEval.input_tokens ?? 0} tokens · 输出 {latestLiveEval.output_tokens ?? 0} tokens</small>
          </div>}
          {!health?.ai_configured && <InlineAlert tone="warning" title="全局模型尚未就绪">先在模型治理页验证并激活一个 Profile；真实 Holdout 不提供 Mock 或跨供应商降级。</InlineAlert>}
        </div>
      </section>

      <section className="version-band single-column">
        <BrainVersionTable rows={state.marketing_brain_versions} canPublish={canPublish} busy={busy} onPromote={promote} onRollback={rollback} />
      </section>
    </>}
    <Modal open={usageDialogOpen} title="确认真实 Holdout API 用量" onClose={() => { if (busy !== "live-eval") setUsageDialogOpen(false); }} actions={<><button className="secondary-button" disabled={busy === "live-eval"} onClick={() => setUsageDialogOpen(false)}>取消</button><button className="primary-button" disabled={!usageConfirmed || busy === "live-eval"} onClick={() => void runLiveEval()}><Play />{busy === "live-eval" ? "正在启动…" : "确认并运行 88 条"}</button></>}>
      <div className="usage-confirmation"><InlineAlert tone="warning" title="本次会产生真实 API 用量">系统会调用当前全局 Profile 处理 88 条纯合成锁定案例，最大并发 2。失败案例不会自动无限重试，续跑沿用逐案例幂等键。</InlineAlert><dl><div><dt>营销脑</dt><dd>{state.marketing_brain_versions.find((item) => item.id === brainId)?.name ?? brainId}</dd></div><div><dt>模型 Profile</dt><dd>{activeProfile ? `${PROVIDER_LABELS[activeProfile.provider]} · ${activeProfile.primary_model}` : "未激活"}</dd></div><div><dt>数据</dt><dd>88 条纯合成 Holdout</dd></div></dl><label className="confirmation-check"><input type="checkbox" checked={usageConfirmed} onChange={(event) => setUsageConfirmed(event.target.checked)} /><span>我确认本次真实模型调用及其 API 用量，并理解结果仅用于发布评测。</span></label></div>
    </Modal>
  </>;
}

function QualityMetric({ icon, label, value, target, pass }: { icon: ReactNode; label: string; value: string; target: string; pass: boolean }) {
  return <div className="quality-metric"><span>{icon}{label}</span><strong>{value}</strong><small className={pass ? "success-text" : "warning-text"}>{pass ? <Check /> : <AlertTriangle />}{target}</small></div>;
}

function SalesFeedback({ decisions, inputs, busy, onInput, onReview }: { decisions: EvaluationDecision[]; inputs: Record<string, string>; busy: string | null; onInput(id: string, value: string): void; onReview(id: string, outcome: EvaluationReviewOutcome, revision: number): void }) {
  const pending = decisions.filter((item) => item.decision === "accepted" && item.review_outcome === null);
  return <div className="sales-quality-layout"><section className="panel"><div className="panel-heading"><div><span className="eyebrow">7 天质量复查</span><h2>{pending.length} 条待确认</h2></div><UserCheck /></div>{pending.length ? pending.map((item) => <article className="review-row" key={item.id}><div><strong>{item.original_evaluation.recommendation}</strong><small>{item.customer_id} · {item.original_evaluation.state_before} → {item.original_evaluation.state_after}</small></div><input aria-label={`${item.customer_id} 复查说明`} placeholder="撤销或新增证据时填写原因" value={inputs[item.id] ?? ""} onChange={(event) => onInput(item.id, event.target.value)} /><div><button className="secondary-button" disabled={busy === `review:${item.id}`} onClick={() => onReview(item.id, "retained", item.revision)}><Check />保持有效</button><button className="secondary-button" disabled={!inputs[item.id]?.trim() || busy === `review:${item.id}`} onClick={() => onReview(item.id, "new_evidence", item.revision)}>新增证据</button><button className="text-button danger-text" disabled={!inputs[item.id]?.trim() || busy === `review:${item.id}`} onClick={() => onReview(item.id, "quality_reversal", item.revision)}>质量撤销</button></div></article>) : <p className="muted">当前没有待复查的原样采用记录。</p>}</section><section className="panel"><div className="panel-heading"><div><span className="eyebrow">我的反馈</span><h2>最近判断</h2></div><Activity /></div>{decisions.slice(0, 8).map((item) => <div className="feedback-history" key={item.id}><StatusBadge status={item.decision === "accepted" ? "approved" : item.decision === "modified" ? "review" : "returned"} /><span><strong>{item.customer_id} · {item.decision === "accepted" ? "原样采用" : item.decision === "modified" ? "修改后采用" : "拒绝"}</strong><small>{item.reason_code ? REASON_LABELS[item.reason_code as EvaluationReasonCode] : "首稿无需修改"} · {item.review_outcome ?? "待 7 天复查"}</small></span><Link to={`/customers/${item.customer_id}`} aria-label={`查看 ${item.customer_id}`}><ArrowRight /></Link></div>)}</section></div>;
}

function BrainVersionTable({ rows, canPublish, busy, onPromote, onRollback }: { rows: import("../domain/types").MarketingBrainVersion[]; canPublish: boolean; busy: string | null; onPromote(kind: "brain" | "router", id: string, revision: number): void; onRollback(kind: "brain" | "router", id: string, revision: number): void }) {
  return <section className="panel version-panel brain-version-panel"><div className="panel-heading"><div><span className="eyebrow">原子版本治理</span><h2>营销脑版本</h2></div><GitBranch /></div>{rows.map((item) => <div className="version-row" key={item.id}><StatusBadge status={item.status === "published" ? "approved" : item.status === "draft" ? "review" : "done"} /><span><strong>{item.name}</strong><small>周策略 {item.prompt_hashes.weekly_strategy} · Brief {item.prompt_hashes.content_brief} · 草稿 {item.prompt_hashes.content_draft} · NBA {item.prompt_hashes.customer_nba}</small><small>{item.knowledge_pack_version_id} · {item.tenant_fact_version_id} · {item.retriever_version}</small></span>{item.status === "draft" && <button className="secondary-button" disabled={!canPublish || busy === `brain:${item.id}`} onClick={() => onPromote("brain", item.id, item.revision)}>发布</button>}{item.status === "archived" && item.published_at && <button className="secondary-button" disabled={!canPublish || busy === `rollback:brain:${item.id}`} onClick={() => onRollback("brain", item.id, item.revision)}>回滚</button>}</div>)}</section>;
}
