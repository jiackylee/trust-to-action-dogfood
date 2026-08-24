import { useMemo, useState } from "react";
import { ArrowRight, Check, CheckCircle2, Clock3, CornerUpLeft, ListChecks, ShieldCheck, Undo2 } from "lucide-react";
import { Link, useSearchParams } from "react-router-dom";
import { EmptyState, InlineAlert, LoadingState, SectionHeader, StatusBadge } from "../components/UI";
import { useAppStore } from "../store/AppStore";
import { actorForRole, can, canActOnTask } from "../domain/permissions";

export function Execution() {
  const { state, loading, decideApproval, recordTaskOutcome, explainError } = useAppStore();
  const [params, setParams] = useSearchParams();
  const tab = params.get("tab") === "approvals" ? "approvals" : "tasks";
  const [taskInputs, setTaskInputs] = useState<Record<string, string>>({});
  const [approvalInputs, setApprovalInputs] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<{ code: string; message: string } | null>(null);
  const tasks = useMemo(() => (state?.tasks ?? []).filter((task) => state?.role !== "sales" || task.owner === actorForRole("sales")).slice().sort((a, b) => a.status === "done" ? 1 : b.status === "done" ? -1 : a.due_at.localeCompare(b.due_at)), [state]);
  const approvals = useMemo(() => (state?.approvals ?? []).slice().sort((a, b) => a.status === "pending" ? -1 : b.status === "pending" ? 1 : a.due_at.localeCompare(b.due_at)), [state]);
  if (loading || !state) return <LoadingState />;
  const currentState = state;
  const canApprove = can(state.role, "decide_approval");
  const focusedTask = params.get("task");
  async function finishTask(id: string) {
    const task = currentState.tasks.find((item) => item.id === id); const outcome = taskInputs[id]?.trim(); if (!task || !outcome) return;
    setBusy(id); setError(null);
    try { await recordTaskOutcome(id, outcome, task.revision); setTaskInputs((items) => ({ ...items, [id]: "" })); }
    catch (cause) { setError(explainError(cause)); } finally { setBusy(null); }
  }
  async function decide(id: string, decision: "approved" | "returned") {
    const approval = currentState.approvals.find((item) => item.id === id); const reason = approvalInputs[id]?.trim(); if (!approval || !reason) return;
    setBusy(id); setError(null);
    try { await decideApproval(id, decision, reason, approval.revision); setApprovalInputs((items) => ({ ...items, [id]: "" })); }
    catch (cause) { setError(explainError(cause)); } finally { setBusy(null); }
  }
  return <>
    <SectionHeader eyebrow="执行工作域" title="任务与审批" description="行内完成销售动作和敏感审批；成功后 7 秒内可撤销，失败不会清空输入。" />
    {error && <InlineAlert tone="danger" title="操作未完成">{error.message} 当前填写内容已保留。<details className="technical-details"><summary>技术详情</summary><code>{error.code}</code></details></InlineAlert>}
    <div className="tabs" role="tablist" aria-label="执行视图" onKeyDown={(event) => { if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return; event.preventDefault(); const next = tab === "tasks" ? "approvals" : "tasks"; setParams({ tab: next }); requestAnimationFrame(() => document.getElementById(`tab-${next}`)?.focus()); }}><button id="tab-tasks" role="tab" aria-controls="panel-tasks" tabIndex={tab === "tasks" ? 0 : -1} aria-selected={tab === "tasks"} className={tab === "tasks" ? "active" : ""} onClick={() => setParams({ tab: "tasks" })}><ListChecks />销售动作 <span>{tasks.filter((item) => item.status !== "done").length}</span></button><button id="tab-approvals" role="tab" aria-controls="panel-approvals" tabIndex={tab === "approvals" ? 0 : -1} aria-selected={tab === "approvals"} className={tab === "approvals" ? "active" : ""} onClick={() => setParams({ tab: "approvals" })}><ShieldCheck />负责人审批 <span>{approvals.filter((item) => item.status === "pending").length}</span></button></div>
    {tab === "tasks" ? <div id="panel-tasks" role="tabpanel" aria-labelledby="tab-tasks">
      {!can(state.role, "record_task") && <InlineAlert tone="warning" title="当前角色只有查看权限">切换至“销售 · 陈牧”后可回填执行结果。</InlineAlert>}
      <div className="table-wrap desktop-table action-table"><table><thead><tr><th>动作 / 客户</th><th>负责人</th><th>优先级</th><th>截止时间</th><th>状态</th><th>执行结果</th></tr></thead><tbody>{tasks.map((task) => { const canRecord = canActOnTask(state.role, task); return <tr key={task.id} className={focusedTask === task.id ? "row-focused" : ""}><td><strong>{task.title}</strong><small>{task.type} · <Link to={`/customers/${task.customer_id}`}>查看关联客户</Link></small></td><td>{task.owner}</td><td><span className={`priority priority-${task.priority}`}>{task.priority === "high" ? "高" : task.priority === "medium" ? "中" : "低"}</span></td><td className={new Date(task.due_at).getTime() < Date.now() && task.status !== "done" ? "danger-text" : ""}>{formatDate(task.due_at)}</td><td><StatusBadge status={task.status} /></td><td>{task.status === "done" ? <span className="outcome-done"><CheckCircle2 />{task.outcome}</span> : <div className="inline-action"><input disabled={!canRecord} aria-label={`${task.title} 的执行结果`} placeholder="记录客户反馈或下一事实" value={taskInputs[task.id] ?? ""} onChange={(event) => setTaskInputs((items) => ({ ...items, [task.id]: event.target.value }))} /><button className="primary-button" disabled={!canRecord || !taskInputs[task.id]?.trim() || busy === task.id} onClick={() => void finishTask(task.id)}><Check />回填</button></div>}</td></tr>; })}</tbody></table></div>
      <div className="mobile-card-list">{tasks.map((task) => { const canRecord = canActOnTask(state.role, task); return <article className={`mobile-card ${focusedTask === task.id ? "card-focused" : ""}`} key={task.id}><div className="mobile-card-head"><span className={`priority priority-${task.priority}`}>{task.priority === "high" ? "高优先" : task.priority === "medium" ? "中优先" : "低优先"}</span><StatusBadge status={task.status} /></div><h2>{task.title}</h2><dl><div><dt>负责人</dt><dd>{task.owner}</dd></div><div><dt>截止</dt><dd>{formatDate(task.due_at)}</dd></div></dl><Link className="context-link" to={`/customers/${task.customer_id}`}>查看关联客户状态 <ArrowRight /></Link>{task.status === "done" ? <p className="outcome-done"><CheckCircle2 />{task.outcome}</p> : <div className="stacked-action"><input disabled={!canRecord} aria-label={`${task.title} 的执行结果`} placeholder="记录执行结果" value={taskInputs[task.id] ?? ""} onChange={(event) => setTaskInputs((items) => ({ ...items, [task.id]: event.target.value }))} /><button className="primary-button" disabled={!canRecord || !taskInputs[task.id]?.trim() || busy === task.id} onClick={() => void finishTask(task.id)}><Check />回填结果</button></div>}</article>; })}</div>
    </div> : <div id="panel-approvals" role="tabpanel" aria-labelledby="tab-approvals">
      {!canApprove && <InlineAlert tone="warning" title="当前角色只有查看权限">切换至“负责人 · 周岚”后可批准或退回；运营和销售不能绕过敏感门禁。</InlineAlert>}
      {!approvals.length ? <EmptyState title="没有审批记录" detail="敏感草稿提交后会显示在这里。" /> : <div className="approval-list">{approvals.map((approval) => { const source = approval.object_type === "draft" ? state.drafts.find((item) => item.id === approval.object_id) : state.proofs.find((item) => item.id === approval.object_id); const stale = !source || source.revision !== approval.object_revision; return <article className={`approval-row approval-${approval.status}`} key={approval.id}><div className="approval-main"><div className="approval-heading"><StatusBadge status={approval.status} /><span>{approval.type}</span><small><Clock3 />{formatDate(approval.due_at)}</small></div><h2>{approval.title}</h2><p>{approval.summary}</p>{stale && approval.status === "pending" && <InlineAlert tone="danger" title="审批内容已更新">当前对象已不是提交审批时的版本，必须重新提交。</InlineAlert>}<dl className="approval-context"><div><dt>审批内容版本</dt><dd>v{approval.object_revision}</dd></div><div><dt>风险</dt><dd>{approval.risk_flags.join("、") || "无"}</dd></div><div><dt>证据</dt><dd>{approval.evidence_refs.join("、") || "未引用"}</dd></div></dl><Link className="context-link" to={approval.object_type === "draft" ? `/content?draft=${approval.object_id}` : `/proofs?proof=${approval.object_id}`}>查看{approval.object_type === "draft" ? "草稿正文、渠道与证据" : "证明内容与授权范围"} <ArrowRight /></Link><div className="approval-people"><span>申请人：{approval.requester}</span><span>负责人：{approval.approver}</span>{approval.reason && <span>处理意见：{approval.reason}</span>}</div></div>{approval.status === "pending" ? <div className="approval-action"><label><span>处理意见（必填）</span><input value={approvalInputs[approval.id] ?? ""} onChange={(event) => setApprovalInputs((items) => ({ ...items, [approval.id]: event.target.value }))} placeholder="说明批准边界或退回原因" /></label><div><button className="secondary-button" disabled={!canApprove || !approvalInputs[approval.id]?.trim() || busy === approval.id} onClick={() => void decide(approval.id, "returned")}><CornerUpLeft />退回</button><button className="primary-button" disabled={!canApprove || stale || !approvalInputs[approval.id]?.trim() || busy === approval.id} onClick={() => void decide(approval.id, "approved")}><Check />批准</button></div></div> : <div className="decision-mark">{approval.status === "approved" ? <CheckCircle2 /> : <Undo2 />}<span>{approval.status === "approved" ? "已批准" : "已退回"}</span></div>}</article>; })}</div>}
    </div>}
  </>;
}

function formatDate(value: string) { return new Intl.DateTimeFormat("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(value)); }
