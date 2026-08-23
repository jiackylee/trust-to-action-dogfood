import { ArrowRight, CheckCircle2, Clock3, FileWarning, ShieldAlert, TrendingUp, Unplug, Users } from "lucide-react";
import { Link } from "react-router-dom";
import { LoadingState, SectionHeader, StatusBadge } from "../components/UI";
import { useAppStore } from "../store/AppStore";

export function Dashboard() {
  const { state, loading } = useAppStore();
  if (loading || !state) return <LoadingState />;
  const readyDrafts = state.drafts.filter((draft) => draft.status === "ready").length;
  const pendingApprovals = state.approvals.filter((item) => item.status === "pending").length;
  const overdueTasks = state.tasks.filter((item) => item.status !== "done" && new Date(item.due_at) < new Date("2026-08-23T15:00:00+08:00")).length;
  const stateMoves = state.customers.filter((item) => ["D1", "A1", "C1"].includes(item.state)).length;
  const evidenceGaps = state.proofs.filter((item) => item.status !== "usable").length;
  const problems = state.integrations.filter((item) => item.status !== "healthy").length;
  const blockers = [
    { title: "D1 同行业案例不足", detail: "2 条 D1 草稿尚无同业可公开案例", tone: "danger", to: "/proofs?readiness=gap", action: "补齐证明" },
    { title: "客户证明审批临近截止", detail: "“7 人销售团队”案例今天 18:00 到期", tone: "warning", to: "/execution?tab=approvals", action: "处理审批" },
    { title: "微信客服身份匹配不完整", detail: "1 个会话未能关联至客户，相关证据不可写入", tone: "warning", to: "/governance", action: "检查数据" },
  ];
  const ratios = state.weekly_plan.strategy.ratio;
  const totalDrafts = state.drafts.length;
  return <>
    <SectionHeader eyebrow="第 2 周 · 8 月 18–24 日" title="本周经营台" description="从证据缺口和审批阻塞开始，优先处理会影响客户推进的工作。" actions={<Link className="primary-button" to="/weekly">进入本周运营 <ArrowRight /></Link>} />
    <section className="focus-band" aria-labelledby="weekly-theme">
      <div><span className="eyebrow">本周主题</span><h2 id="weekly-theme">{state.weekly_plan.strategy.theme}</h2><p>{state.weekly_plan.strategy.objective}</p></div>
      <div className="gate"><span>核心 Gate</span><strong>24h</strong><small>有效信号 → 下一动作</small></div>
      <div className="readiness"><span>内容就绪度</span><strong>{Math.round((readyDrafts / totalDrafts) * 100)}%</strong><div className="progress"><i style={{ width: `${(readyDrafts / totalDrafts) * 100}%` }} /></div><small>{readyDrafts}/{totalDrafts} 条可人工发布</small></div>
    </section>
    <section className="metrics-grid" aria-label="核心经营指标">
      <Metric icon={<CheckCircle2 />} label="就绪内容" value={`${readyDrafts} 条`} note="本周目标 5 条" to="/content?status=ready" tone="success" />
      <Metric icon={<TrendingUp />} label="高意向状态" value={`${stateMoves} 位`} note="D1 / A1 / C1" to="/customers?state=D1" />
      <Metric icon={<FileWarning />} label="证据缺口" value={`${evidenceGaps} 项`} note="含 1 项已撤权" to="/proofs?readiness=gap" tone="danger" />
      <Metric icon={<ShieldAlert />} label="待审批" value={`${pendingApprovals} 项`} note="1 项今日到期" to="/execution?tab=approvals" tone="warning" />
      <Metric icon={<Clock3 />} label="逾期动作" value={`${overdueTasks} 项`} note="优先回填结果" to="/execution?tab=tasks" tone="danger" />
      <Metric icon={<Unplug />} label="数据异常" value={`${problems} 源`} note="客户主数据正常" to="/governance" tone="warning" />
    </section>
    <div className="dashboard-lower">
      <section className="panel blockers-panel"><div className="panel-heading"><div><span className="eyebrow">优先队列</span><h2>前三个阻塞点</h2></div><span className="count-badge">3</span></div>
        <div className="blocker-list">{blockers.map((blocker, index) => <Link to={blocker.to} className="blocker-row" key={blocker.title}><span className={`rank rank-${blocker.tone}`}>{index + 1}</span><span><strong>{blocker.title}</strong><small>{blocker.detail}</small></span><b>{blocker.action}<ArrowRight /></b></Link>)}</div>
      </section>
      <section className="panel"><div className="panel-heading"><div><span className="eyebrow">内容组合</span><h2>T / I / D / A 进度</h2></div><Link to="/content">查看草稿</Link></div>
        <div className="stage-progress">{[
          ["T", "建立信任", ratios.trust, 2, 2], ["I", "建立兴趣", ratios.interest, 2, 2], ["D", "形成欲望", ratios.desire, 0, 1], ["A", "推动行动", ratios.action, 0, 1],
        ].map(([code, label, ratio, done, target]) => <div className="stage-row" key={code as string}><span className={`stage-code stage-${String(code).toLowerCase()}`}>{code}</span><span><b>{label}</b><small>{ratio}% 策略配比</small></span><div className="segmented-progress">{Array.from({ length: Number(target) }, (_, index) => <i className={index < Number(done) ? "filled" : ""} key={index} />)}</div><strong>{done}/{target}</strong></div>)}</div>
      </section>
      <section className="panel data-panel"><div className="panel-heading"><div><span className="eyebrow">同步健康</span><h2>企微数据面</h2></div><Link to="/governance">详情</Link></div>
        {state.integrations.map((source) => <div className="source-mini" key={source.id}><span><strong>{source.name}</strong><small>{source.freshness}</small></span><StatusBadge status={source.status} /></div>)}
      </section>
    </div>
  </>;
}
function Metric({ icon, label, value, note, to, tone = "default" }: { icon: React.ReactNode; label: string; value: string; note: string; to: string; tone?: string }) {
  return <Link className={`metric metric-${tone}`} to={to}><span className="metric-icon">{icon}</span><span><small>{label}</small><strong>{value}</strong><em>{note}</em></span><ArrowRight className="metric-arrow" /></Link>;
}
