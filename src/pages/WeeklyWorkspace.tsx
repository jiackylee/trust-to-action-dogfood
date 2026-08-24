import { useState } from "react";
import { ArrowRight, BarChart3, Check, CircleDashed, LoaderCircle, LockKeyhole, Sparkles } from "lucide-react";
import { Link } from "react-router-dom";
import { aiClient } from "../data/ai-client";
import { InlineAlert, LoadingState, SectionHeader } from "../components/UI";
import { useAppStore } from "../store/AppStore";
import { can } from "../domain/permissions";
import { MarketingDecisionPanel } from "../components/MarketingDecisionPanel";

export function WeeklyWorkspace() {
  const { state, loading, health, generateMarketingCandidate, saveWeeklyRetrospective, explainError } = useAppStore();
  const [generating, setGenerating] = useState<"strategy" | "retrospective" | null>(null);
  const [error, setError] = useState<{ code: string; message: string } | null>(null);
  if (loading || !state) return <LoadingState />;
  const currentState = state;
  const ready = state.drafts.filter((item) => item.status === "ready").length;
  const proofGaps = state.proofs.filter((item) => item.status !== "usable").length;
  const riskDrafts = state.drafts.filter((item) => item.approval_required && item.approval_status !== "approved").length;
  const pendingApprovals = state.approvals.filter((item) => item.status === "pending").length;
  const acceptedInsights = state.conversation_insights.filter((item) => item.status === "accepted" && !item.invalidated_reason);
  const strategyCandidate = state.marketing_candidates.find((item) => item.task_type === "weekly_strategy" && item.subject_id === "weekly-plan" && item.status === "pending");
  const adoptedBriefs = state.content_briefs.filter((item) => item.status === "adopted").length;
  const syncedPublications = state.publications.filter((item) => item.status === "results_synced").length;
  const publicationsWithBusinessResults = state.publications.filter((publication) => state.content_outcomes.some((outcome) => outcome.publication_id === publication.id)).length;
  const steps = [
    { label: "洞察", detail: `${acceptedInsights.length} 条已接受`, done: acceptedInsights.length > 0, to: "/insights" },
    { label: "Brief", detail: `${adoptedBriefs}/${state.content_briefs.length} 份已采用`, done: adoptedBriefs === state.content_briefs.length, to: "/insights?status=accepted" },
    { label: "草稿", detail: `${state.drafts.length} 条草稿 · ${ready} 条就绪`, done: true, to: "/content" },
    { label: "证据", detail: `${proofGaps} 项缺口待处理`, done: proofGaps === 0, to: "/proofs?readiness=gap" },
    { label: "风险", detail: `${riskDrafts} 条需要确定性门禁`, done: riskDrafts === 0, to: "/content?status=review" },
    { label: "审批", detail: `${pendingApprovals} 项正在等待负责人`, done: pendingApprovals === 0, to: "/execution?tab=approvals" },
    { label: "发布", detail: `${state.publications.length} 条人工发布记录`, done: state.publications.length > 0, to: "/content?view=results" },
    { label: "结果", detail: `${syncedPublications} 条互动 · ${publicationsWithBusinessResults} 条业务回填`, done: publicationsWithBusinessResults >= Math.ceil(state.publications.length * .8), to: "/content?view=results" },
  ];
  async function regenerate() {
    setGenerating("strategy"); setError(null);
    try {
      const counts = Object.fromEntries(["T0", "T1", "I1", "D1", "A1", "C1"].map((code) => [code, currentState.customers.filter((item) => item.state === code).length]));
      await generateMarketingCandidate("weekly_strategy", "weekly-plan", 1, `${currentState.weekly_plan.strategy.theme} 企微窄市场周策略 内容密度 证据门禁`, {
        current_plan: currentState.weekly_plan,
        metrics: { ready_drafts: ready, pending_approvals: currentState.approvals.filter((item) => item.status === "pending").length, overdue_tasks: currentState.tasks.filter((item) => item.status !== "done" && new Date(item.due_at).getTime() < Date.now()).length },
        customer_states: counts,
        drafts: currentState.drafts,
        proofs: currentState.proofs,
        accepted_insights: acceptedInsights,
        historical_outcomes: currentState.content_outcomes,
      });
    } catch (cause) {
      const details = explainError(cause); setError(details);
    } finally { setGenerating(null); }
  }
  async function regenerateRetrospective() {
    setGenerating("retrospective"); setError(null);
    try {
      const result = await aiClient.weeklyRetrospective(currentState.conversation_insights, currentState.content_briefs, currentState.publications, currentState.content_outcomes);
      await saveWeeklyRetrospective(result.data, result.meta, `${result.meta.model} · ${result.meta.response_id}`, currentState.weekly_retrospective.revision);
    } catch (cause) { setError(explainError(cause)); }
    finally { setGenerating(null); }
  }
  return <>
    <SectionHeader eyebrow="运营工作区" title="把会话信号推到下周策略" description="洞察、Brief、证明、审批、人工发布和结果保持完整血缘；所有外部动作仍由人执行。" actions={<button className="primary-button" onClick={() => void regenerate()} disabled={Boolean(generating) || !can(state.role, "generate_strategy")} title={!can(state.role, "generate_strategy") ? "只有运营角色可以生成周策略" : undefined}><Sparkles />{generating === "strategy" ? "正在生成…" : "AI 重新生成策略"}</button>} />
    {!health?.ai_configured && <InlineAlert tone="warning" title="AI 生成当前被阻断">本地 AI 服务尚未配置。现有输入与策略不会被覆盖，配置后可直接重试。</InlineAlert>}
    {!health?.knowledge_configured && <InlineAlert tone="warning" title="私有知识包未配置">配置并激活 `KNOWLEDGE_PACK_PATH` 后才能生成 2.2 营销决策候选；系统不会静默退化为通用 Prompt。</InlineAlert>}
    {error && <InlineAlert tone="danger" title="策略生成失败">{error.message} <button className="text-button" onClick={() => void regenerate()}>重试</button><details className="technical-details"><summary>技术详情</summary><code>{error.code}</code></details></InlineAlert>}
    {strategyCandidate && <MarketingDecisionPanel candidate={strategyCandidate} currentRevision={1} />}
    <section className="workflow-strip content-loop-strip" aria-label="本周内容工作流">{steps.map((step, index) => <div className={`workflow-step ${step.done ? "complete" : "blocked"}`} key={step.label}><div className="workflow-line"><span>{step.done ? <Check /> : <CircleDashed />}</span>{index < steps.length - 1 && <i />}</div><b>{step.label}</b><small>{step.detail}</small><Link to={step.to}>{({ 洞察: "判断洞察", Brief: "采用 Brief", 草稿: "编辑草稿", 证据: "补齐证据", 风险: "检查风险", 审批: "处理审批", 发布: "查看发布", 结果: "回填结果" } as Record<string, string>)[step.label]}<ArrowRight /></Link></div>)}</section>
    <div className="weekly-layout" id="strategy">
      <section className="panel strategy-panel"><div className="panel-heading"><div><span className="eyebrow">当前策略</span><h2>{state.weekly_plan.strategy.theme}</h2></div><span className="version-label">更新于 {formatDate(state.weekly_plan.generated_at)}</span></div><p className="strategy-objective">{state.weekly_plan.strategy.objective}</p>
        <dl className="strategy-facts"><div><dt>目标分组</dt><dd>{state.weekly_plan.strategy.target_segments.join(" · ")}</dd></div><div><dt>下次复查</dt><dd>{formatDate(state.weekly_plan.strategy.next_review_at)}</dd></div></dl>
        <div className="ratio-grid">{Object.entries(state.weekly_plan.strategy.ratio).map(([key, value]) => <div key={key}><span>{({ trust: "T 信任", interest: "I 兴趣", desire: "D 欲望", action: "A 行动" } as Record<string, string>)[key]}</span><strong>{value}%</strong><i><b style={{ width: `${value}%` }} /></i></div>)}</div>
      </section>
      <section className="panel"><div className="panel-heading"><div><span className="eyebrow">本周排期</span><h2>内容排期</h2></div><span className="count-badge">{state.weekly_plan.strategy.content_slots.length}</span></div><div className="slot-list">{state.weekly_plan.strategy.content_slots.map((slot) => <div key={`${slot.day}-${slot.topic}`}><span className={`stage-code stage-${slot.stage.toLowerCase()}`}>{slot.stage}</span><span><strong>{slot.day} · {slot.topic}</strong><small>唯一行动指引：{slot.cta}</small></span></div>)}</div></section>
      <aside className="panel gate-panel"><div className="panel-heading"><div><span className="eyebrow">阻塞原因</span><h2>发布门禁</h2></div><LockKeyhole /></div><ul className="check-list"><li><b>证据</b><span>{proofGaps} 项证明仍不可用</span></li><li><b>审批</b><span>{pendingApprovals} 项敏感内容等待负责人处理</span></li><li><b>外部动作</b><span>仅允许复制草稿，禁止自动外发</span></li></ul><Link className="secondary-button full" to="/execution">进入处理队列 <ArrowRight /></Link></aside>
    </div>
    <section className="retrospective-band" id="retrospective"><div className="retrospective-head"><div><span className="eyebrow">周复盘</span><h2>{state.weekly_retrospective.week_label} 内容结果</h2><p>{state.weekly_retrospective.retrospective.summary}</p></div><button className="secondary-button" onClick={() => void regenerateRetrospective()} disabled={Boolean(generating) || !can(state.role, "generate_strategy")}><BarChart3 />{generating === "retrospective" ? "复盘中" : "AI 生成复盘"}</button></div>
      <div className="retro-metrics"><div><span>洞察采纳率</span><strong>{Math.round(acceptedInsights.length / state.conversation_insights.length * 100)}%</strong></div><div><span>Brief 采用率</span><strong>{Math.round(adoptedBriefs / state.content_briefs.length * 100)}%</strong></div><div><span>互动同步率</span><strong>{Math.round(syncedPublications / state.publications.length * 100)}%</strong></div><div><span>业务回填率</span><strong>{Math.round(publicationsWithBusinessResults / state.publications.length * 100)}%</strong></div></div>
      <div className="retro-columns"><div><h3>高表现主题</h3>{state.weekly_retrospective.retrospective.top_themes.map((theme) => <article key={theme.theme}><strong>{theme.theme}</strong><p>{theme.reason}</p><small>{theme.business_results} 个业务结果</small></article>)}</div><div><h3>下周策略候选</h3>{state.weekly_retrospective.retrospective.next_week_candidates.map((candidate) => <article key={candidate.theme}><strong>{candidate.theme}</strong><p>{candidate.objective}</p><small>{candidate.evidence_refs.join(" · ")}</small></article>)}</div></div><div className="causality-note">{state.weekly_retrospective.retrospective.caveat}</div>
    </section>
    {generating && <div className="generating-overlay" role="status"><LoaderCircle className="spin" />{generating === "strategy" ? "正在基于洞察和历史结果生成周策略…" : "正在分层复盘平台互动与业务结果…"}</div>}
  </>;
}

function formatDate(value: string) { return new Intl.DateTimeFormat("zh-CN", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(value)); }
