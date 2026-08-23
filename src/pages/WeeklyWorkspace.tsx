import { useState } from "react";
import { ArrowRight, Check, CircleDashed, LoaderCircle, LockKeyhole, Sparkles } from "lucide-react";
import { Link } from "react-router-dom";
import { aiClient } from "../data/ai-client";
import { InlineAlert, LoadingState, SectionHeader } from "../components/UI";
import { useAppStore } from "../store/AppStore";
import { can } from "../domain/permissions";

export function WeeklyWorkspace() {
  const { state, loading, health, saveWeeklyStrategy, explainError, notify } = useAppStore();
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState<{ code: string; message: string } | null>(null);
  if (loading || !state) return <LoadingState />;
  const currentState = state;
  const ready = state.drafts.filter((item) => item.status === "ready").length;
  const proofGaps = state.proofs.filter((item) => item.status !== "usable").length;
  const riskDrafts = state.drafts.filter((item) => item.approval_required && item.approval_status !== "approved").length;
  const pendingApprovals = state.approvals.filter((item) => item.status === "pending").length;
  const completedTasks = state.tasks.filter((item) => item.status === "done").length;
  const steps = [
    { label: "策略", detail: "主题与配比已确认", done: true, to: "#strategy" },
    { label: "草稿", detail: `${state.drafts.length} 条草稿 · ${ready} 条就绪`, done: true, to: "/content" },
    { label: "证据", detail: `${proofGaps} 项缺口待处理`, done: proofGaps === 0, to: "/proofs?readiness=gap" },
    { label: "风险", detail: `${riskDrafts} 条需要确定性门禁`, done: riskDrafts === 0, to: "/content?status=review" },
    { label: "审批", detail: `${pendingApprovals} 项正在等待负责人`, done: pendingApprovals === 0, to: "/execution?tab=approvals" },
    { label: "发布", detail: "必须人工复制发布", done: false, to: "/content?status=ready" },
    { label: "结果", detail: `${completedTasks}/${state.tasks.length} 项已回填`, done: completedTasks === state.tasks.length, to: "/execution?tab=tasks" },
  ];
  async function regenerate() {
    setGenerating(true); setError(null);
    try {
      const counts = Object.fromEntries(["T0", "T1", "I1", "D1", "A1", "C1"].map((code) => [code, currentState.customers.filter((item) => item.state === code).length]));
      const result = await aiClient.weeklyStrategy({
        current_plan: currentState.weekly_plan,
        metrics: { ready_drafts: ready, pending_approvals: currentState.approvals.filter((item) => item.status === "pending").length, overdue_tasks: currentState.tasks.filter((item) => item.status !== "done" && new Date(item.due_at).getTime() < Date.now()).length },
        customer_states: counts,
        drafts: currentState.drafts,
        proofs: currentState.proofs,
      });
      await saveWeeklyStrategy(result.data, `${result.meta.model} · ${result.meta.response_id}`);
      notify({ title: "周策略已生成", detail: `已写入提示词版本 ${result.meta.prompt_version}`, tone: "success" });
    } catch (cause) {
      const details = explainError(cause); setError(details);
    } finally { setGenerating(false); }
  }
  return <>
    <SectionHeader eyebrow="运营工作区" title="把本周策略推到可执行结果" description="每一步都显示完成度和阻塞原因；所有外部发布仍由人执行。" actions={<button className="primary-button" onClick={() => void regenerate()} disabled={generating || !can(state.role, "generate_strategy")} title={!can(state.role, "generate_strategy") ? "只有运营角色可以生成周策略" : undefined}><Sparkles />{generating ? "正在生成…" : "AI 重新生成策略"}</button>} />
    {!health?.ai_configured && <InlineAlert tone="warning" title="AI 生成当前被阻断">本地 AI 服务尚未配置。现有输入与策略不会被覆盖，配置后可直接重试。</InlineAlert>}
    {error && <InlineAlert tone="danger" title="策略生成失败">{error.message} <button className="text-button" onClick={() => void regenerate()}>重试</button><details className="technical-details"><summary>技术详情</summary><code>{error.code}</code></details></InlineAlert>}
    <section className="workflow-strip" aria-label="本周内容工作流">{steps.map((step, index) => <div className={`workflow-step ${step.done ? "complete" : "blocked"}`} key={step.label}><div className="workflow-line"><span>{step.done ? <Check /> : <CircleDashed />}</span>{index < steps.length - 1 && <i />}</div><b>{step.label}</b><small>{step.detail}</small><Link to={step.to}>{({ 策略: "查看策略", 草稿: "编辑草稿", 证据: "补齐证据", 风险: "检查风险", 审批: "处理审批", 发布: "查看就绪内容", 结果: "回填结果" } as Record<string, string>)[step.label]}<ArrowRight /></Link></div>)}</section>
    <div className="weekly-layout" id="strategy">
      <section className="panel strategy-panel"><div className="panel-heading"><div><span className="eyebrow">当前策略</span><h2>{state.weekly_plan.strategy.theme}</h2></div><span className="version-label">更新于 {formatDate(state.weekly_plan.generated_at)}</span></div><p className="strategy-objective">{state.weekly_plan.strategy.objective}</p>
        <dl className="strategy-facts"><div><dt>目标分组</dt><dd>{state.weekly_plan.strategy.target_segments.join(" · ")}</dd></div><div><dt>下次复查</dt><dd>{formatDate(state.weekly_plan.strategy.next_review_at)}</dd></div></dl>
        <div className="ratio-grid">{Object.entries(state.weekly_plan.strategy.ratio).map(([key, value]) => <div key={key}><span>{({ trust: "T 信任", interest: "I 兴趣", desire: "D 欲望", action: "A 行动" } as Record<string, string>)[key]}</span><strong>{value}%</strong><i><b style={{ width: `${value}%` }} /></i></div>)}</div>
      </section>
      <section className="panel"><div className="panel-heading"><div><span className="eyebrow">本周排期</span><h2>内容排期</h2></div><span className="count-badge">{state.weekly_plan.strategy.content_slots.length}</span></div><div className="slot-list">{state.weekly_plan.strategy.content_slots.map((slot) => <div key={`${slot.day}-${slot.topic}`}><span className={`stage-code stage-${slot.stage.toLowerCase()}`}>{slot.stage}</span><span><strong>{slot.day} · {slot.topic}</strong><small>唯一行动指引：{slot.cta}</small></span></div>)}</div></section>
      <aside className="panel gate-panel"><div className="panel-heading"><div><span className="eyebrow">阻塞原因</span><h2>发布门禁</h2></div><LockKeyhole /></div><ul className="check-list"><li><b>证据</b><span>{proofGaps} 项证明仍不可用</span></li><li><b>审批</b><span>{pendingApprovals} 项敏感内容等待负责人处理</span></li><li><b>外部动作</b><span>仅允许复制草稿，禁止自动外发</span></li></ul><Link className="secondary-button full" to="/execution">进入处理队列 <ArrowRight /></Link></aside>
    </div>
    {generating && <div className="generating-overlay" role="status"><LoaderCircle className="spin" />正在基于当前证据生成周策略…</div>}
  </>;
}

function formatDate(value: string) { return new Intl.DateTimeFormat("zh-CN", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(value)); }
