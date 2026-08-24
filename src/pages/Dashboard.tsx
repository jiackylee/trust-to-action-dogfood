import { ArrowRight, CheckCircle2, Clock3, FileWarning, ShieldAlert, TrendingUp, Unplug, Users } from "lucide-react";
import { Link } from "react-router-dom";
import { LoadingState, SectionHeader, StatusBadge } from "../components/UI";
import { actorForRole } from "../domain/permissions";
import type { DomainState } from "../domain/types";
import { useAppStore } from "../store/AppStore";

export function Dashboard() {
  const { state, loading } = useAppStore();
  if (loading || !state) return <LoadingState />;
  if (state.role === "sales") return <SalesDashboard state={state} />;
  if (state.role === "lead") return <LeadDashboard state={state} />;
  return <OperationsDashboard state={state} />;
}

function OperationsDashboard({ state }: { state: DomainState }) {
  const readyDrafts = state.drafts.filter((draft) => draft.status === "ready").length;
  const pendingApprovals = state.approvals.filter((item) => item.status === "pending").length;
  const overdueTasks = state.tasks.filter((item) => item.status !== "done" && new Date(item.due_at).getTime() < Date.now()).length;
  const highIntent = state.customers.filter((item) => ["D1", "A1", "C1"].includes(item.state)).length;
  const evidenceGaps = state.proofs.filter((item) => item.status !== "usable").length;
  const problems = state.integrations.filter((item) => item.status !== "healthy").length;
  const gapProof = state.proofs.filter((item) => item.status !== "usable").sort((a, b) => a.completeness - b.completeness)[0];
  const pendingApproval = state.approvals.filter((item) => item.status === "pending").sort((a, b) => a.due_at.localeCompare(b.due_at))[0];
  const unhealthySource = state.integrations.find((item) => item.status !== "healthy");
  const blockers = [
    gapProof && { title: gapProof.title, detail: `${gapProof.completeness}% 完整 · ${gapProof.missing_fields.join("、") || "授权不可用"}`, tone: "danger", to: `/proofs?proof=${gapProof.id}`, action: "补齐证明" },
    pendingApproval && { title: pendingApproval.title, detail: `${pendingApproval.type} · ${formatDate(pendingApproval.due_at)} 截止`, tone: "warning", to: "/execution?tab=approvals", action: "处理审批" },
    unhealthySource && { title: unhealthySource.name, detail: unhealthySource.error || `${unhealthySource.freshness}未更新`, tone: "warning", to: "/governance", action: "检查数据" },
  ].filter(Boolean) as Array<{ title: string; detail: string; tone: string; to: string; action: string }>;
  const ratios = state.weekly_plan.strategy.ratio;
  const totalDrafts = state.drafts.length || 1;
  const stagePlan = [
    ["T", "建立信任", ratios.trust], ["I", "建立兴趣", ratios.interest], ["D", "形成欲望", ratios.desire], ["A", "推动行动", ratios.action],
  ] as const;

  return <>
    <SectionHeader eyebrow={`第 ${state.week} 周`} title="本周经营台" description="从证据缺口和审批阻塞开始，优先处理会影响客户推进的工作。" actions={<Link className="primary-button" to="/weekly">进入本周运营 <ArrowRight /></Link>} />
    <section className="focus-band" aria-labelledby="weekly-theme">
      <div><span className="eyebrow">本周主题</span><h2 id="weekly-theme">{state.weekly_plan.strategy.theme}</h2><p>{state.weekly_plan.strategy.objective}</p></div>
      <div className="gate"><span>核心门禁</span><strong>24h</strong><small>有效信号 → 下一动作</small></div>
      <div className="readiness"><span>内容就绪度</span><strong>{Math.round((readyDrafts / totalDrafts) * 100)}%</strong><div className="progress"><i style={{ width: `${(readyDrafts / totalDrafts) * 100}%` }} /></div><small>{readyDrafts}/{state.drafts.length} 条可人工发布</small></div>
    </section>
    <section className="metrics-grid" aria-label="核心经营指标">
      <Metric icon={<CheckCircle2 />} label="就绪内容" value={`${readyDrafts} 条`} note={`本周共 ${state.drafts.length} 条`} to="/content?status=ready" tone="success" />
      <Metric icon={<TrendingUp />} label="高意向状态" value={`${highIntent} 位`} note="D1 / A1 / C1" to="/customers?states=D1,A1,C1" />
      <Metric icon={<FileWarning />} label="证据缺口" value={`${evidenceGaps} 项`} note={`${state.proofs.filter((item) => item.status === "revoked").length} 项已撤权`} to="/proofs?readiness=gap" tone="danger" />
      <Metric icon={<ShieldAlert />} label="待审批" value={`${pendingApprovals} 项`} note={`${state.approvals.filter((item) => item.status === "pending" && new Date(item.due_at).getTime() < Date.now() + 24 * 60 * 60_000).length} 项 24h 内到期`} to="/execution?tab=approvals" tone="warning" />
      <Metric icon={<Clock3 />} label="逾期动作" value={`${overdueTasks} 项`} note="优先回填结果" to="/execution?tab=tasks" tone="danger" />
      <Metric icon={<Unplug />} label="数据异常" value={`${problems} 源`} note={`${state.integrations.length - problems} 源正常`} to="/governance" tone="warning" />
    </section>
    <div className="dashboard-lower">
      <section className="panel blockers-panel"><div className="panel-heading"><div><span className="eyebrow">优先队列</span><h2>前三个阻塞点</h2></div><span className="count-badge">{blockers.length}</span></div>
        <div className="blocker-list">{blockers.map((blocker, index) => <Link to={blocker.to} className="blocker-row" key={blocker.title}><span className={`rank rank-${blocker.tone}`}>{index + 1}</span><span><strong>{blocker.title}</strong><small>{blocker.detail}</small></span><b>{blocker.action}<ArrowRight /></b></Link>)}</div>
      </section>
      <section className="panel"><div className="panel-heading"><div><span className="eyebrow">内容组合</span><h2>T / I / D / A 进度</h2></div><Link to="/content">查看本周全部草稿</Link></div>
        <div className="stage-progress">{stagePlan.map(([code, label, ratio]) => { const target = Math.max(1, Math.round(totalDrafts * ratio / 100)); const done = state.drafts.filter((item) => item.stage === code && item.status === "ready").length; return <div className="stage-row" key={code}><span className={`stage-code stage-${code.toLowerCase()}`}>{code}</span><span><b>{label}</b><small>{ratio}% 策略配比</small></span><div className="segmented-progress">{Array.from({ length: target }, (_, index) => <i className={index < done ? "filled" : ""} key={index} />)}</div><strong>{done}/{target}</strong></div>; })}</div>
      </section>
      <section className="panel data-panel"><div className="panel-heading"><div><span className="eyebrow">同步健康</span><h2>企微数据面</h2></div><Link to="/governance">查看数据与审计</Link></div>
        {state.integrations.map((source) => <div className="source-mini" key={source.id}><span><strong>{source.name}</strong><small>{source.freshness}</small></span><StatusBadge status={source.status} /></div>)}
      </section>
    </div>
  </>;
}

function SalesDashboard({ state }: { state: DomainState }) {
  const owner = actorForRole("sales");
  const tasks = state.tasks.filter((item) => item.owner === owner && item.status !== "done").sort((a, b) => a.due_at.localeCompare(b.due_at));
  const customers = state.customers.filter((item) => (item.owner === owner || item.shared) && ["D1", "A1", "C1"].includes(item.state));
  const overdue = tasks.filter((item) => new Date(item.due_at).getTime() < Date.now()).length;
  return <>
    <SectionHeader eyebrow={`销售 · ${owner}`} title="我的销售工作台" description="先处理逾期动作和高价值客户，再回填执行结果。" actions={<Link className="primary-button" to="/execution?tab=tasks">进入我的任务 <ArrowRight /></Link>} />
    <section className="metrics-grid role-metrics"><Metric icon={<Clock3 />} label="我的待办" value={`${tasks.length} 项`} note={`${overdue} 项逾期`} to="/execution?tab=tasks" tone={overdue ? "danger" : "success"} /><Metric icon={<TrendingUp />} label="我的高价值客户" value={`${customers.length} 位`} note="D1 / A1 / C1" to={`/customers?owner=${encodeURIComponent(owner)}&states=D1,A1,C1`} /><Metric icon={<Users />} label="共享客户" value={`${state.customers.filter((item) => item.shared).length} 位`} note="可查看与处理建议" to="/customers" /></section>
    <div className="dashboard-lower sales-dashboard"><section className="panel"><div className="panel-heading"><div><span className="eyebrow">今日优先</span><h2>我的动作队列</h2></div><Link to="/execution?tab=tasks">查看全部任务</Link></div><div className="blocker-list">{tasks.slice(0, 5).map((task, index) => <Link to={`/execution?tab=tasks&task=${task.id}`} className="blocker-row" key={task.id}><span className={new Date(task.due_at).getTime() < Date.now() ? "rank rank-danger" : "rank"}>{index + 1}</span><span><strong>{task.title}</strong><small>{formatDate(task.due_at)} · {task.priority === "high" ? "高优先" : "常规"}</small></span><b>回填结果<ArrowRight /></b></Link>)}</div></section><section className="panel"><div className="panel-heading"><div><span className="eyebrow">推进机会</span><h2>高价值客户</h2></div><Link to={`/customers?owner=${encodeURIComponent(owner)}&states=D1,A1,C1`}>查看全部客户</Link></div>{customers.slice(0, 5).map((customer) => <div className="source-mini" key={customer.id}><span><strong>{customer.name} · {customer.company}</strong><small>{customer.evaluation?.recommendation}</small></span><Link to={`/customers/${customer.id}`}>处理下一动作</Link></div>)}</section></div>
  </>;
}

function LeadDashboard({ state }: { state: DomainState }) {
  const approvals = state.approvals.filter((item) => item.status === "pending").sort((a, b) => a.due_at.localeCompare(b.due_at));
  const blockedDrafts = state.drafts.filter((item) => item.status === "blocked");
  const revokedProofs = state.proofs.filter((item) => item.status === "revoked");
  return <>
    <SectionHeader eyebrow="负责人 · 周岚" title="审批与风险工作台" description="审批前检查完整正文、证据授权、风险和提交版本。" actions={<Link className="primary-button" to="/execution?tab=approvals">处理待审批 <ArrowRight /></Link>} />
    <section className="metrics-grid role-metrics"><Metric icon={<ShieldAlert />} label="待审批" value={`${approvals.length} 项`} note={`${approvals.filter((item) => new Date(item.due_at).getTime() < Date.now()).length} 项逾期`} to="/execution?tab=approvals" tone="warning" /><Metric icon={<FileWarning />} label="阻断草稿" value={`${blockedDrafts.length} 条`} note="不可复制发布" to="/content?status=blocked" tone="danger" /><Metric icon={<Unplug />} label="撤权证明" value={`${revokedProofs.length} 项`} note="检查关联内容" to="/proofs?readiness=gap" tone="danger" /></section>
    <section className="panel lead-queue"><div className="panel-heading"><div><span className="eyebrow">审批队列</span><h2>按截止时间排序</h2></div><Link to="/execution?tab=approvals">查看完整审批上下文</Link></div><div className="blocker-list">{approvals.map((approval, index) => <Link to="/execution?tab=approvals" className="blocker-row" key={approval.id}><span className={new Date(approval.due_at).getTime() < Date.now() ? "rank rank-danger" : "rank rank-warning"}>{index + 1}</span><span><strong>{approval.title}</strong><small>{approval.type} · 内容版本 v{approval.object_revision}</small></span><b>审阅并处理<ArrowRight /></b></Link>)}</div></section>
  </>;
}

function Metric({ icon, label, value, note, to, tone = "default" }: { icon: React.ReactNode; label: string; value: string; note: string; to: string; tone?: string }) {
  return <Link className={`metric metric-${tone}`} to={to}><span className="metric-icon">{icon}</span><span><small>{label}</small><strong>{value}</strong><em>{note}</em></span><ArrowRight className="metric-arrow" /></Link>;
}

function formatDate(value: string) { return new Intl.DateTimeFormat("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(value)); }
