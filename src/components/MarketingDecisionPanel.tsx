import { useState } from "react";
import { AlertTriangle, ArrowRight, BookOpenCheck, Check, FlaskConical, GitCompareArrows, ShieldCheck, Sparkles, X } from "lucide-react";
import type { ContentBriefProposal, ContentDraftProposal, CustomerEvaluation, WeeklyStrategy } from "../domain/schemas";
import type { MarketingDecisionCandidate, MarketingDecisionKind, MarketingDecisionOutput, MarketingDecisionReasonCode } from "../domain/types";
import { useAppStore } from "../store/AppStore";
import { InlineAlert, StatusBadge } from "./UI";

const REASONS: Array<{ value: MarketingDecisionReasonCode; label: string }> = [
  { value: "wrong_state", label: "状态错误" }, { value: "wrong_evidence", label: "证据错误" }, { value: "wrong_nba", label: "NBA 不合适" },
  { value: "missing_context", label: "缺少上下文" }, { value: "risk_compliance", label: "风险或合规" }, { value: "too_generic", label: "过于泛化" },
  { value: "knowledge_not_applicable", label: "知识不适用" }, { value: "tenant_fact_wrong", label: "企业事实错误" }, { value: "voice_mismatch", label: "语气不符" },
  { value: "strategy_too_aggressive", label: "策略过激" }, { value: "experiment_weak", label: "实验设计不足" }, { value: "other", label: "其他" },
];

const TASK_LABELS = { weekly_strategy: "本周策略", content_brief: "内容 Brief", content_draft: "内容草稿", customer_nba: "客户状态 / NBA" } as const;

export function MarketingDecisionPanel({ candidate, currentRevision, compact = false, onDecision }: { candidate: MarketingDecisionCandidate; currentRevision: number; compact?: boolean; onDecision?: () => void }) {
  const { decideMarketingCandidate, explainError } = useAppStore();
  const [mode, setMode] = useState<MarketingDecisionKind | null>(null);
  const [reason, setReason] = useState<MarketingDecisionReasonCode | "">("");
  const [note, setNote] = useState("");
  const [output, setOutput] = useState<MarketingDecisionOutput>(() => structuredClone(candidate.envelope.output));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ code: string; message: string } | null>(null);
  const stale = candidate.status === "stale" || new Date(candidate.expires_at).getTime() < Date.now() || candidate.subject_revision !== currentRevision;
  const summary = decisionSummary(candidate.task_type, output);

  async function submit(decision: MarketingDecisionKind) {
    if (stale || (decision !== "accepted" && (!reason || !note.trim()))) return;
    setBusy(true); setError(null);
    try {
      await decideMarketingCandidate(candidate.id, decision, decision === "modified" ? output : null, decision === "accepted" ? null : reason as MarketingDecisionReasonCode, note, currentRevision);
      setMode(null); setReason(""); setNote("");
      onDecision?.();
    } catch (cause) { setError(explainError(cause)); }
    finally { setBusy(false); }
  }

  return <section className={`marketing-decision-panel ${compact ? "marketing-decision-compact" : ""} ${stale ? "candidate-stale" : ""}`}>
    <div className="marketing-decision-head"><span><Sparkles /><b>{TASK_LABELS[candidate.task_type]}候选</b><small>{candidate.envelope.ai_meta.model} · {candidate.envelope.growth_posture === "aggressive" ? "进攻型增长" : candidate.envelope.growth_posture}</small></span><StatusBadge status={stale ? "blocked" : candidate.status} /></div>
    {stale ? <InlineAlert tone="warning" title="候选已过期">业务对象、证据、知识或营销脑版本已变化，请重新生成。</InlineAlert> : <>
      <div className="marketing-decision-summary"><div><span>建议</span><strong>{summary.title}</strong><small>{summary.detail}</small></div><div><span>不建议 / 门禁</span><strong>{summary.notRecommended || "无额外阻塞"}</strong><small>确定性规则优先于模型建议</small></div></div>
      <div className="decision-evidence-grid">
        <div><span><ShieldCheck />业务证据</span><div className="reference-chips">{candidate.envelope.business_evidence_refs.map((ref) => <code key={ref}>{ref}</code>)}</div></div>
        <div><span><BookOpenCheck />知识依据</span>{candidate.envelope.knowledge_refs.map((ref) => <details key={ref.chunk_id}><summary>{ref.source_title} · {ref.heading_path.at(-1) ?? "正文"}</summary><p>{ref.excerpt}</p><small>{ref.knowledge_kind} · {ref.skill} · {ref.chunk_id}</small></details>)}</div>
      </div>
      <div className="decision-meta-strip"><span><b>SKILL</b>{candidate.envelope.skill_route.join(" → ")}</span><span><b>假设</b>{candidate.envelope.assumptions.join("；")}</span><span><b>测量</b>{candidate.envelope.measurement_plan.join("；")}</span></div>
      {candidate.envelope.knowledge_conflicts.length > 0 && <InlineAlert tone="warning" title="知识冲突">{candidate.envelope.knowledge_conflicts.join("；")}</InlineAlert>}
      {mode === "modified" && <OutputEditor task={candidate.task_type} output={output} onChange={setOutput} />}
      {mode && mode !== "accepted" ? <div className="marketing-review-form"><label className="field"><span>{mode === "modified" ? "修改原因" : "拒绝原因"}</span><select value={reason} onChange={(event) => setReason(event.target.value as MarketingDecisionReasonCode)}><option value="">请选择</option>{REASONS.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}</select></label><label className="field"><span>判断说明</span><textarea value={note} onChange={(event) => setNote(event.target.value)} placeholder="说明知识适用性、企业事实或业务上下文" /></label><div><button className="secondary-button" onClick={() => { setMode(null); setReason(""); setNote(""); }}>取消</button><button className="primary-button" disabled={busy || !reason || !note.trim()} onClick={() => void submit(mode)}><Check />确认判断</button></div></div>
        : <div className="marketing-review-actions"><button className="primary-button" disabled={busy} onClick={() => void submit("accepted")}><Check />原样采用</button><button className="secondary-button" onClick={() => { setMode("modified"); setOutput(structuredClone(candidate.envelope.output)); }}><GitCompareArrows />修改后采用</button><button className="text-button danger-text" onClick={() => setMode("rejected")}><X />拒绝</button></div>}
      {error && <InlineAlert tone="danger" title={error.code}>{error.message}</InlineAlert>}
    </>}
  </section>;
}

function OutputEditor({ task, output, onChange }: { task: MarketingDecisionCandidate["task_type"]; output: MarketingDecisionOutput; onChange(output: MarketingDecisionOutput): void }) {
  if (task === "weekly_strategy") {
    const item = output as WeeklyStrategy;
    return <div className="decision-output-editor"><label className="field"><span>策略主题</span><input value={item.theme} onChange={(event) => onChange({ ...item, theme: event.target.value })} /></label><label className="field"><span>经营目标</span><textarea value={item.objective} onChange={(event) => onChange({ ...item, objective: event.target.value })} /></label></div>;
  }
  if (task === "content_brief") {
    const item = output as ContentBriefProposal;
    return <div className="decision-output-editor"><label className="field"><span>朋友圈主角度</span><textarea value={item.primary_angle} onChange={(event) => onChange({ ...item, primary_angle: event.target.value })} /></label><label className="field"><span>唯一 CTA</span><input value={item.cta} onChange={(event) => onChange({ ...item, cta: event.target.value })} /></label></div>;
  }
  if (task === "content_draft") {
    const item = output as ContentDraftProposal;
    return <div className="decision-output-editor"><label className="field"><span>标题</span><input value={item.title} onChange={(event) => onChange({ ...item, title: event.target.value })} /></label><label className="field"><span>正文</span><textarea rows={6} value={item.body} onChange={(event) => onChange({ ...item, body: event.target.value })} /></label><label className="field"><span>唯一 CTA</span><input value={item.cta} onChange={(event) => onChange({ ...item, cta: event.target.value })} /></label></div>;
  }
  const item = output as CustomerEvaluation;
  return <div className="decision-output-editor"><label className="field"><span>建议状态</span><select value={item.state_after} onChange={(event) => onChange({ ...item, state_after: event.target.value as CustomerEvaluation["state_after"] })}>{["T0", "T1", "I1", "D1", "A1", "C1"].map((state) => <option key={state}>{state}</option>)}</select></label><label className="field"><span>下一最佳动作</span><select value={item.recommendation} onChange={(event) => onChange({ ...item, recommendation: event.target.value as CustomerEvaluation["recommendation"] })}>{["继续观察", "发送知识内容", "询问资格问题", "分享 Demo", "分享案例", "创建跟进任务", "准备 Offer", "转人工"].map((action) => <option key={action}>{action}</option>)}</select></label><label className="field"><span>行动指引</span><input value={item.cta} onChange={(event) => onChange({ ...item, cta: event.target.value })} /></label></div>;
}

function decisionSummary(task: MarketingDecisionCandidate["task_type"], output: MarketingDecisionOutput) {
  if (task === "weekly_strategy") { const item = output as WeeklyStrategy; return { title: item.theme, detail: item.objective, notRecommended: item.risk_flags.join("；") || item.evidence_gaps.join("；") }; }
  if (task === "content_brief") { const item = output as ContentBriefProposal; return { title: item.primary_angle, detail: `${item.target_segment} · ${item.stage} · CTA：${item.cta}`, notRecommended: item.proof_requirements.join("；") }; }
  if (task === "content_draft") { const item = output as ContentDraftProposal; return { title: item.title, detail: `${item.target_segment} · CTA：${item.cta}`, notRecommended: item.risk_flags.join("；") }; }
  const item = output as CustomerEvaluation;
  return { title: `${item.state_before} → ${item.state_after} · ${item.recommendation}`, detail: `${item.confidence}% 置信 · ${item.cta}`, notRecommended: item.not_recommended.join("；") };
}
