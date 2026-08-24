import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, ArrowLeft, ArrowRight, Bot, CalendarClock, Check, CheckSquare, ChevronRight, Clock3, GitCompareArrows, MessageSquareText, Search, Sparkles, UserRound, UsersRound, X } from "lucide-react";
import { Link, useLocation, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { STATE_LABELS, type CustomerEvaluation, type EvidenceStrength, type StateCode } from "../domain/schemas";
import type { Customer, EvaluationDecisionKind, EvaluationReasonCode } from "../domain/types";
import { EmptyState, EvidenceBadge, InlineAlert, LoadingState, SectionHeader, StateBadge } from "../components/UI";
import { useAppStore } from "../store/AppStore";
import { actorForRole, can, canAccessCustomer } from "../domain/permissions";
import type { NbaDecision } from "../domain/types";
import { candidateIsStale } from "../domain/quality";
import { MarketingDecisionPanel } from "../components/MarketingDecisionPanel";

const SCROLL_KEY = "tta-v2-customers-scroll";
const REASON_LABELS: Record<EvaluationReasonCode, string> = {
  wrong_state: "状态判断错误",
  wrong_evidence: "证据引用错误",
  wrong_nba: "下一最佳动作不合适",
  missing_context: "缺少关键上下文",
  risk_compliance: "风险或合规问题",
  too_generic: "建议过于泛化",
  other: "其他",
};

export function Customers() {
  const { state, loading, health, generateMarketingCandidate, explainError, notify } = useAppStore();
  const [params, setParams] = useSearchParams();
  const location = useLocation();
  const [selected, setSelected] = useState<string[]>([]);
  const [evaluating, setEvaluating] = useState(false);
  const [error, setError] = useState<{ code: string; message: string } | null>(null);
  const [visibleCount, setVisibleCount] = useState(8);
  const query = params.get("q") ?? "";
  const owner = params.get("owner") ?? (state?.role === "sales" ? actorForRole("sales") : "all");
  const stateFilter = params.get("state") ?? "all";
  const evidence = params.get("evidence") ?? "all";
  const stateSet = new Set((params.get("states") ?? "").split(",").filter(Boolean));
  useEffect(() => {
    const scroll = Number(sessionStorage.getItem(SCROLL_KEY) ?? 0);
    requestAnimationFrame(() => window.scrollTo({ top: scroll }));
    return () => sessionStorage.setItem(SCROLL_KEY, String(window.scrollY));
  }, []);
  const customers = useMemo(() => (state?.customers ?? []).filter((customer) => {
    const haystack = `${customer.name} ${customer.company} ${customer.tags.join(" ")}`.toLowerCase();
    return canAccessCustomer(state?.role ?? "operations", customer) && (!query || haystack.includes(query.toLowerCase())) && (owner === "all" || customer.owner === owner) && (stateFilter === "all" || customer.state === stateFilter) && (!stateSet.size || stateSet.has(customer.state)) && (evidence === "all" || customer.evidence_strength === evidence);
  }), [state, query, owner, stateFilter, evidence, params]);
  useEffect(() => setVisibleCount(8), [query, owner, stateFilter, evidence, params]);
  const visibleCustomers = customers.slice(0, visibleCount);
  if (loading || !state) return <LoadingState />;
  function updateParam(key: string, value: string) { const next = new URLSearchParams(params); value === "all" || !value ? next.delete(key) : next.set(key, value); setParams(next, { replace: true }); }
  function toggle(id: string) { setSelected((items) => items.includes(id) ? items.filter((item) => item !== id) : items.length < 10 ? [...items, id] : items); }
  async function evaluateBatch() {
    if (!state) return;
    setEvaluating(true); setError(null);
    try {
      const failedIds: string[] = [];
      let completed = 0;
      for (const customerId of selected.slice(0, 10)) {
        const customer = state.customers.find((item) => item.id === customerId);
        if (!customer) { failedIds.push(customerId); continue; }
        try { await generateMarketingCandidate("customer_nba", customer.id, customer.revision, `${customer.industry} ${customer.state} 客户状态 下一最佳动作 企微跟进证据`, { customer_id: customer.id }); completed += 1; }
        catch { failedIds.push(customerId); }
      }
      const failed = failedIds.length;
      setSelected(failedIds);
      notify({ title: `已生成 ${completed} 条评估候选`, detail: failed ? `${failed} 位未完成并保持选择，可修正后重试。` : "客户状态尚未改变，等待负责销售审阅。", tone: failed ? "warning" : "success" });
    } catch (cause) { setError(explainError(cause)); } finally { setEvaluating(false); }
  }
  return <>
    <SectionHeader eyebrow="客户工作域" title="客户状态看板" description="AI 只生成待审阅候选；销售采用后才写入状态与 NBA。单批最多 10 位。" actions={<button className="primary-button" disabled={!selected.length || evaluating} onClick={() => void evaluateBatch()}><Sparkles />{evaluating ? `正在生成 ${selected.length} 条候选…` : `评估已选 ${selected.length || ""}`}</button>} />
    {!health?.ai_configured && selected.length > 0 && <InlineAlert tone="warning" title="AI 评估当前不可用">未配置服务端密钥。选择结果和筛选条件已保留，配置后可直接重试。</InlineAlert>}
    {error && <InlineAlert tone="danger" title="批量评估已停止">{error.message} 已生成候选保持不变，未处理对象仍保持选择。<details className="technical-details"><summary>技术详情</summary><code>{error.code}</code></details></InlineAlert>}
    <div className="filter-bar">
      <label className="search-field"><Search /><input aria-label="搜索客户" value={query} onChange={(event) => updateParam("q", event.target.value)} placeholder="搜索姓名、公司或标签" /></label>
      <select aria-label="按负责人筛选" value={owner} onChange={(event) => updateParam("owner", event.target.value)}><option value="all">全部负责人</option>{[...new Set(state.customers.map((item) => item.owner))].map((item) => <option key={item}>{item}</option>)}</select>
      <select aria-label="按状态筛选" value={stateFilter} onChange={(event) => updateParam("state", event.target.value)}><option value="all">全部状态</option>{Object.entries(STATE_LABELS).map(([code, label]) => <option value={code} key={code}>{code} · {label}</option>)}</select>
      <select aria-label="按证据强度筛选" value={evidence} onChange={(event) => updateParam("evidence", event.target.value)}><option value="all">全部证据</option><option value="strong">强证据</option><option value="medium">中证据</option><option value="weak">弱证据</option></select>
      <span className="filter-count">{customers.length} / {state.customers.filter((item) => canAccessCustomer(state.role, item)).length} 位</span>
    </div>
    {!customers.length ? <EmptyState title="没有匹配的客户" detail="调整负责人、状态或证据筛选后再试。" action={<button className="secondary-button" onClick={() => setParams({})}>清空筛选</button>} /> : <>
      <div className="table-wrap desktop-table customers-table"><table><thead><tr><th className="checkbox-cell"><input type="checkbox" aria-label="选择当前列表前十位" checked={Boolean(customers.length) && customers.slice(0, 10).every((item) => selected.includes(item.id))} onChange={(event) => setSelected(event.target.checked ? customers.slice(0, 10).map((item) => item.id) : [])} /></th><th>客户</th><th>状态 / 置信度</th><th>证据</th><th>最近互动</th><th>下一最佳动作</th><th>AI 候选</th><th>复查时间</th><th /></tr></thead><tbody>{customers.map((customer) => { const pending = state.marketing_candidates.find((item) => item.task_type === "customer_nba" && item.subject_id === customer.id && item.status === "pending") ?? state.evaluation_candidates.find((item) => item.customer_id === customer.id && item.status === "pending"); return <tr key={customer.id}><td><input type="checkbox" aria-label={`选择 ${customer.name}`} checked={selected.includes(customer.id)} onChange={() => toggle(customer.id)} /></td><td><Link className="customer-name" to={`/customers/${customer.id}`} state={{ from: location.pathname + location.search }}><strong>{customer.name}</strong><small>{customer.company}</small></Link><span className="owner-line"><UserRound />{customer.owner}{customer.shared && " · 共享"}</span></td><td><StateBadge state={customer.state} /><small className="confidence-line"><i><b style={{ width: `${customer.confidence}%` }} /></i>{customer.confidence}%</small></td><td><EvidenceBadge strength={customer.evidence_strength} /><small>{customer.evidence.filter((item) => item.valid).length} 条有效引用</small></td><td className="interaction-cell"><span>{customer.last_interaction}</span><small>{relativeDate(customer.last_interaction_at)}</small></td><td><strong>{customer.evaluation?.recommendation ?? "待评估"}</strong><small>{customer.evaluation?.cta}</small></td><td>{pending ? <Link className="candidate-pill" to={`/customers/${customer.id}`}><Sparkles />待销售判断</Link> : <span className="muted">—</span>}</td><td><span className={new Date(customer.review_at).getTime() < Date.now() ? "warning-text" : ""}>{shortDate(customer.review_at)}</span>{customer.anomaly && <small className="danger-text">{customer.anomaly}</small>}</td><td><Link className="icon-button" aria-label={`查看 ${customer.name} 详情`} title="查看客户详情" to={`/customers/${customer.id}`} state={{ from: location.pathname + location.search }}><ChevronRight /></Link></td></tr>; })}</tbody></table></div>
      <div className="mobile-card-list customer-cards">{visibleCustomers.map((customer) => <article className="mobile-card" key={customer.id}><div className="mobile-card-head"><label className="mobile-check"><input type="checkbox" checked={selected.includes(customer.id)} onChange={() => toggle(customer.id)} /><span className="sr-only">选择 {customer.name}</span></label><StateBadge state={customer.state} /></div><h2>{customer.name} <small>{customer.company}</small></h2><div className="card-badges"><EvidenceBadge strength={customer.evidence_strength} /><span>{customer.confidence}% 置信</span></div><p>{customer.last_interaction}</p><div className="nba-mini"><span>下一最佳动作</span><strong>{customer.evaluation?.recommendation}</strong><small>{customer.evaluation?.cta}</small></div><Link className="secondary-button full" to={`/customers/${customer.id}`} state={{ from: location.pathname + location.search }}>查看 {customer.name} 的状态与动作 <ArrowRight /></Link></article>)}</div>
      {visibleCount < customers.length && <button className="secondary-button mobile-load-more" onClick={() => setVisibleCount((count) => count + 8)}>继续加载（剩余 {customers.length - visibleCount} 位）</button>}
      {selected.length > 0 && <div className="mobile-selection-bar" role="status"><strong>已选 {selected.length} 位</strong><button className="primary-button" disabled={evaluating} onClick={() => void evaluateBatch()}><Sparkles />批量评估</button><button className="icon-button" aria-label="清空选择" onClick={() => setSelected([])}><X /></button></div>}
    </>}
  </>;
}

export function CustomerDetail() {
  const { customerId } = useParams();
  const location = useLocation();
  const navigate = useNavigate();
  const { state, loading, health, generateMarketingCandidate, decideEvaluationCandidate, decideNba, addCustomerNote, explainError } = useAppStore();
  const [evaluating, setEvaluating] = useState(false);
  const [error, setError] = useState<{ code: string; message: string } | null>(null);
  const [note, setNote] = useState("");
  const [nbaMode, setNbaMode] = useState<NbaDecision["decision"] | null>(null);
  const [nbaAction, setNbaAction] = useState("");
  const [nbaReason, setNbaReason] = useState("");
  const [savingNba, setSavingNba] = useState(false);
  const [savingNote, setSavingNote] = useState(false);
  const [candidateMode, setCandidateMode] = useState<EvaluationDecisionKind | null>(null);
  const [candidateEvaluation, setCandidateEvaluation] = useState<CustomerEvaluation | null>(null);
  const [candidateReason, setCandidateReason] = useState<EvaluationReasonCode | "">("");
  const [candidateNote, setCandidateNote] = useState("");
  const [savingCandidate, setSavingCandidate] = useState(false);
  if (loading || !state) return <LoadingState />;
  const customer = state.customers.find((item) => item.id === customerId && canAccessCustomer(state.role, item));
  if (!customer) return <EmptyState title="客户不存在" detail="该演示客户可能已被重置。" action={<Link className="secondary-button" to="/customers">返回客户列表</Link>} />;
  const currentCustomer = customer;
  const candidate = state.evaluation_candidates.find((item) => item.customer_id === customer.id && item.status === "pending");
  const marketingCandidate = state.marketing_candidates.find((item) => item.task_type === "customer_nba" && item.subject_id === customer.id && item.status === "pending");
  const staleCandidate = candidate ? candidateIsStale(state, candidate) || new Date(candidate.expires_at).getTime() < Date.now() : false;
  const canHandleNba = can(state.role, "record_task") && canAccessCustomer(state.role, customer);
  const canReviewCandidate = can(state.role, "review_evaluation") && customer.owner === actorForRole("sales");
  const backTo = (location.state as { from?: string } | null)?.from ?? "/customers";
  async function evaluate() {
    setEvaluating(true); setError(null);
    try {
      await generateMarketingCandidate("customer_nba", currentCustomer.id, currentCustomer.revision, `${currentCustomer.industry} ${currentCustomer.state} 客户状态 下一最佳动作 强弱证据`, { customer_id: currentCustomer.id });
    } catch (cause) { setError(explainError(cause)); } finally { setEvaluating(false); }
  }
  async function handleCandidateDecision(decision: EvaluationDecisionKind) {
    if (!candidate || staleCandidate) return;
    const evaluation = decision === "accepted" ? candidate.evaluation : decision === "modified" ? candidateEvaluation : null;
    if (decision !== "accepted" && !candidateReason) return;
    setSavingCandidate(true); setError(null);
    try {
      await decideEvaluationCandidate(currentCustomer.id, candidate.id, decision, evaluation, decision === "accepted" ? null : candidateReason as EvaluationReasonCode, candidateNote, currentCustomer.revision);
      setCandidateMode(null); setCandidateEvaluation(null); setCandidateReason(""); setCandidateNote("");
    } catch (cause) { setError(explainError(cause)); } finally { setSavingCandidate(false); }
  }
  async function handleNba(decision: NbaDecision["decision"]) {
    if ((decision === "modified" || decision === "rejected") && !nbaReason.trim()) return;
    setSavingNba(true); setError(null);
    try {
      await decideNba(currentCustomer.id, decision, decision === "modified" ? nbaAction : currentCustomer.evaluation?.recommendation ?? "继续观察", nbaReason, currentCustomer.revision);
      setNbaMode(null); setNbaAction(""); setNbaReason("");
    } catch (cause) { setError(explainError(cause)); } finally { setSavingNba(false); }
  }
  async function saveNote() {
    if (!note.trim()) return;
    setSavingNote(true); setError(null);
    try { await addCustomerNote(currentCustomer.id, note, currentCustomer.revision); setNote(""); }
    catch (cause) { setError(explainError(cause)); } finally { setSavingNote(false); }
  }
  return <>
    <button className="back-button" onClick={() => navigate(backTo)}><ArrowLeft />返回原筛选</button>
    <SectionHeader eyebrow={`${customer.company} · ${customer.title}`} title={customer.name} description={`${customer.owner} 负责 · 来源：${customer.source} · 最近互动 ${relativeDate(customer.last_interaction_at)}`} actions={<button className="primary-button" onClick={() => void evaluate()} disabled={evaluating}><Bot />{evaluating ? "正在评估…" : "AI 重新评估"}</button>} />
    {error && <InlineAlert tone="danger" title="操作未完成">{error.message} <button className="text-button" onClick={() => void evaluate()}>重试</button><details className="technical-details"><summary>技术详情</summary><code>{error.code}</code></details></InlineAlert>}
    {marketingCandidate && <MarketingDecisionPanel candidate={marketingCandidate} currentRevision={currentCustomer.revision} />}
    {candidate && <section className={`evaluation-candidate-panel ${staleCandidate ? "candidate-stale" : ""}`}>
      <div className="candidate-title"><span><Sparkles /><b>AI 待判断候选</b><small>{candidate.ai_meta.model} · {candidate.ai_meta.route_reason ?? "默认路由"} · {candidate.ai_meta.attempts ?? 1} 次调用</small></span><span className="candidate-age">{relativeDate(candidate.created_at)}生成</span></div>
      {staleCandidate ? <InlineAlert tone="warning" title="候选已过期">客户 revision 或证据已经变化，当前候选不能写入。请重新生成。</InlineAlert> : <>
        <div className="candidate-grid">
          <div className="candidate-transition"><span>状态建议</span><strong><StateBadge state={candidate.evaluation.state_before} /><ArrowRight /><StateBadge state={candidate.evaluation.state_after} /></strong><small>{candidate.evaluation.confidence}% 置信 · {candidate.evaluation.decision === "insufficient_evidence" ? "证据不足" : "建议推进"}</small></div>
          <div><span>下一最佳动作</span><strong>{candidate.evaluation.recommendation}</strong><small>{candidate.evaluation.cta}</small></div>
          <div><span>证据依据</span><strong>{candidate.evaluation.evidence_refs.length} 条引用</strong><small>{candidate.evaluation.evidence_assessment.map((item) => item.summary).join("；")}</small></div>
          <div><span>风险与未知项</span><strong>{candidate.evaluation.risk_flags.length + candidate.evaluation.uncertainties.length || "无"}</strong><small>{[...candidate.evaluation.risk_flags, ...candidate.evaluation.uncertainties].join("；") || "未发现额外阻塞"}</small></div>
        </div>
        {canReviewCandidate ? <div className="candidate-review">
          {candidateMode && candidateMode !== "accepted" ? <div className="candidate-review-form">
            {candidateMode === "modified" && candidateEvaluation && <div className="candidate-edit-grid"><label className="field"><span>修改后的状态</span><select value={candidateEvaluation.state_after} onChange={(event) => setCandidateEvaluation({ ...candidateEvaluation, state_after: event.target.value as StateCode })}>{Object.entries(STATE_LABELS).map(([code, label]) => <option key={code} value={code}>{code} · {label}</option>)}</select></label><label className="field"><span>修改后的 NBA</span><select value={candidateEvaluation.recommendation} onChange={(event) => setCandidateEvaluation({ ...candidateEvaluation, recommendation: event.target.value as CustomerEvaluation["recommendation"] })}>{["继续观察", "发送知识内容", "询问资格问题", "分享 Demo", "分享案例", "创建跟进任务", "准备 Offer", "转人工"].map((action) => <option key={action}>{action}</option>)}</select></label></div>}
            <label className="field"><span>{candidateMode === "modified" ? "修改原因" : "拒绝原因"}（必选）</span><select value={candidateReason} onChange={(event) => setCandidateReason(event.target.value as EvaluationReasonCode)}><option value="">请选择</option>{Object.entries(REASON_LABELS).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></label>
            <label className="field"><span>补充说明{candidateReason === "other" ? "（必填）" : "（可选）"}</span><textarea value={candidateNote} onChange={(event) => setCandidateNote(event.target.value)} /></label>
            <div><button className="secondary-button" onClick={() => { setCandidateMode(null); setCandidateReason(""); setCandidateNote(""); }}>取消</button><button className="primary-button" disabled={savingCandidate || !candidateReason || (candidateReason === "other" && !candidateNote.trim())} onClick={() => void handleCandidateDecision(candidateMode)}><Check />确认判断</button></div>
          </div> : <div className="candidate-review-actions"><button className="primary-button" disabled={savingCandidate} onClick={() => void handleCandidateDecision("accepted")}><Check />原样采用并写入</button><button className="secondary-button" onClick={() => { setCandidateMode("modified"); setCandidateEvaluation(structuredClone(candidate.evaluation)); }}><GitCompareArrows />修改后采用</button><button className="text-button danger-text" onClick={() => setCandidateMode("rejected")}><X />拒绝</button></div>}
        </div> : <small className="candidate-owner-note"><AlertTriangle />仅负责销售 {customer.owner} 可处理该候选。</small>}
      </>}
    </section>}
    <div className="customer-above-fold">
      <section className="panel state-focus"><div className="panel-heading"><div><span className="eyebrow">当前状态</span><h2><StateBadge state={customer.state} /></h2></div><strong className="confidence-number">{customer.confidence}%</strong></div><div className="confidence-track"><i style={{ width: `${customer.confidence}%` }} /></div><dl><div><dt>触发事件</dt><dd>{customer.evidence[0]?.type}</dd></div><div><dt>更新时间</dt><dd>{shortDate(customer.updated_at)}</dd></div><div><dt>复查时间</dt><dd>{shortDate(customer.review_at)}</dd></div></dl>{customer.anomaly && <span className="danger-line">{customer.anomaly}</span>}</section>
      <section className="panel evidence-focus"><div className="panel-heading"><div><span className="eyebrow">状态证据</span><h2>{customer.evidence.filter((item) => item.valid).length} 条有效证据</h2></div><EvidenceBadge strength={customer.evidence_strength} /></div><p className="evidence-summary">{customer.last_interaction}</p><div className="evidence-ref-row">{customer.evidence.map((item) => <span className={item.valid ? "" : "invalid"} key={item.id}>{item.id} · {item.type}{!item.valid && "（已失效）"}</span>)}</div><small>弱信号仅用于观察，不能单独升至 D1 / A1。</small></section>
      <section className="panel nba-focus"><div className="panel-heading"><div><span className="eyebrow">下一最佳动作</span><h2>{customer.evaluation?.recommendation ?? "待评估"}</h2></div><Sparkles /></div><p>{customer.evaluation?.draft}</p><div className="cta-box"><span>建议行动指引</span><strong>{customer.evaluation?.cta}</strong></div><div className="nba-meta"><span><CalendarClock />{shortDate(customer.evaluation?.next_review_at ?? customer.review_at)}</span><span>预期：{customer.evaluation?.expected_transition}</span></div>
        {customer.nba_decision ? <div className={`nba-decision decision-${customer.nba_decision.decision}`}><strong>{customer.nba_decision.decision === "accepted" ? "已采纳" : customer.nba_decision.decision === "modified" ? "修改后采纳" : "已拒绝"}</strong><span>{customer.nba_decision.action}</span>{customer.nba_decision.reason && <small>{customer.nba_decision.reason}</small>}{customer.nba_decision.task_id && <Link to={`/execution?tab=tasks&task=${customer.nba_decision.task_id}`}>查看关联销售任务 <ArrowRight /></Link>}</div> : canHandleNba ? <div className="nba-actions">{nbaMode ? <><label className="field"><span>{nbaMode === "modified" ? "修改后的动作" : "拒绝原因"}</span>{nbaMode === "modified" && <input value={nbaAction} onChange={(event) => setNbaAction(event.target.value)} />}{nbaMode === "rejected" && <textarea value={nbaReason} onChange={(event) => setNbaReason(event.target.value)} />}</label>{nbaMode === "modified" && <label className="field"><span>修改原因（必填）</span><input value={nbaReason} onChange={(event) => setNbaReason(event.target.value)} /></label>}<div><button className="secondary-button" onClick={() => setNbaMode(null)}>取消</button><button className="primary-button" disabled={savingNba || !nbaReason.trim() || (nbaMode === "modified" && !nbaAction.trim())} onClick={() => void handleNba(nbaMode)}><Check />确认</button></div></> : <><button className="primary-button" disabled={savingNba} onClick={() => void handleNba("accepted")}><Check />采纳并建任务</button><button className="secondary-button" onClick={() => { setNbaMode("modified"); setNbaAction(customer.evaluation?.recommendation ?? ""); }}>修改</button><button className="text-button danger-text" onClick={() => setNbaMode("rejected")}>拒绝</button></>}</div> : <small>切换到负责销售后可采纳、修改或拒绝建议。</small>}
      </section>
    </div>
    {!health?.ai_configured && <InlineAlert tone="warning" title="真实模型未配置">重新评估当前不可用；客户状态会保持不变，也不会生成替代结果。</InlineAlert>}
    {!health?.knowledge_configured && <InlineAlert tone="warning" title="知识增强未就绪">未激活私有知识包时客户评估会明确阻断，不会生成无知识依据的 NBA。</InlineAlert>}
    <div className="detail-grid">
      <section className="panel"><div className="panel-heading"><div><span className="eyebrow">微信客服</span><h2>近 3 天摘要</h2></div><MessageSquareText /></div><p>{customer.kf_summary}</p><InlineAlert tone="info" title="只读同步">回复建议仅作为草稿，不调用发送接口。</InlineAlert></section>
      <section className="panel"><div className="panel-heading"><div><span className="eyebrow">人工补充</span><h2>销售私聊笔记</h2></div><UsersRound /></div><label className="field"><span>事实或结果</span><textarea className="note-area" placeholder="记录未接入会话存档的私聊事实…" value={note} onChange={(event) => setNote(event.target.value)} /></label><button className="secondary-button" disabled={!note.trim() || savingNote} onClick={() => void saveNote()}><CheckSquare />{savingNote ? "正在记录" : "记录笔记"}</button>{customer.notes.map((item) => <div className="saved-note" key={item.id}><p>{item.text}</p><small>{item.actor} · {shortDate(item.at)}</small></div>)}</section>
    </div>
    <section className="panel timeline-panel"><div className="panel-heading"><div><span className="eyebrow">客户时间线</span><h2>事件、证据与人工记录</h2></div><Clock3 /></div><div className="timeline">{[...customer.notes.map((item) => ({ id: item.id, occurred_at: item.at, type: "人工笔记", source: item.actor, text: item.text, strength: "人工", valid: true })), ...customer.evidence].sort((a, b) => b.occurred_at.localeCompare(a.occurred_at)).map((item) => <div key={item.id}><i /><time>{shortDate(item.occurred_at)}</time><span><b>{item.type} · {item.source}</b><p>{item.text}</p><small>{item.strength} · {item.valid ? "有效" : "已失效"} · {item.id}</small></span></div>)}</div></section>
  </>;
}

function shortDate(value: string) { return new Intl.DateTimeFormat("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(value)); }
function relativeDate(value: string) { const hours = Math.max(1, Math.round((Date.now() - new Date(value).getTime()) / 3_600_000)); return hours < 24 ? `${hours} 小时前` : `${Math.round(hours / 24)} 天前`; }
