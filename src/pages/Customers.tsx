import { useEffect, useMemo, useState } from "react";
import { ArrowLeft, ArrowRight, Bot, CalendarClock, CheckSquare, ChevronRight, Clock3, MessageSquareText, Search, Sparkles, Tag, UserRound, UsersRound } from "lucide-react";
import { Link, useLocation, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { aiClient } from "../data/ai-client";
import { STATE_LABELS, type EvidenceStrength, type StateCode } from "../domain/schemas";
import type { Customer } from "../domain/types";
import { EmptyState, EvidenceBadge, InlineAlert, LoadingState, SectionHeader, StateBadge } from "../components/UI";
import { useAppStore } from "../store/AppStore";

const SCROLL_KEY = "tta-v2-customers-scroll";

export function Customers() {
  const { state, loading, health, applyCustomerEvaluation, explainError, notify } = useAppStore();
  const [params, setParams] = useSearchParams();
  const location = useLocation();
  const [selected, setSelected] = useState<string[]>([]);
  const [evaluating, setEvaluating] = useState(false);
  const [error, setError] = useState<{ code: string; message: string } | null>(null);
  const query = params.get("q") ?? "";
  const owner = params.get("owner") ?? "all";
  const stateFilter = params.get("state") ?? "all";
  const evidence = params.get("evidence") ?? "all";
  useEffect(() => {
    const scroll = Number(sessionStorage.getItem(SCROLL_KEY) ?? 0);
    requestAnimationFrame(() => window.scrollTo({ top: scroll }));
    return () => sessionStorage.setItem(SCROLL_KEY, String(window.scrollY));
  }, []);
  const customers = useMemo(() => (state?.customers ?? []).filter((customer) => {
    const haystack = `${customer.name} ${customer.company} ${customer.tags.join(" ")}`.toLowerCase();
    return (!query || haystack.includes(query.toLowerCase())) && (owner === "all" || customer.owner === owner) && (stateFilter === "all" || customer.state === stateFilter) && (evidence === "all" || customer.evidence_strength === evidence);
  }), [state, query, owner, stateFilter, evidence]);
  if (loading || !state) return <LoadingState />;
  const currentState = state;
  function updateParam(key: string, value: string) { const next = new URLSearchParams(params); value === "all" || !value ? next.delete(key) : next.set(key, value); setParams(next, { replace: true }); }
  function toggle(id: string) { setSelected((items) => items.includes(id) ? items.filter((item) => item !== id) : items.length < 10 ? [...items, id] : items); }
  async function evaluateBatch() {
    setEvaluating(true); setError(null);
    let completed = 0;
    try {
      for (const id of selected.slice(0, 10)) {
        const customer = currentState.customers.find((item) => item.id === id);
        if (!customer) continue;
        const result = await aiClient.customerEvaluation(customer);
        await applyCustomerEvaluation(id, result.data, result.meta, customer.revision);
        completed += 1;
      }
      setSelected([]); notify({ title: `已自动评估 ${completed} 位客户`, detail: "状态与 NBA 已通过确定性规则并写入审计。", tone: "success" });
    } catch (cause) { setError(explainError(cause)); } finally { setEvaluating(false); }
  }
  return <>
    <SectionHeader eyebrow="客户工作域" title="客户状态看板" description="筛选条件和滚动位置会在查看详情后恢复；单批 AI 评估最多 10 位。" actions={<button className="primary-button" disabled={!selected.length || evaluating} onClick={() => void evaluateBatch()}><Sparkles />{evaluating ? `正在评估 ${selected.length} 位…` : `评估已选 ${selected.length || ""}`}</button>} />
    {!health?.ai_configured && selected.length > 0 && <InlineAlert tone="warning" title="AI 评估当前不可用">未配置服务端密钥。选择结果和筛选条件已保留，配置后可直接重试。</InlineAlert>}
    {error && <InlineAlert tone="danger" title={`${error.code} · 已停止批量写入`}>{error.message} 已完成对象保留审计，未处理对象仍保持选择。</InlineAlert>}
    <div className="filter-bar">
      <label className="search-field"><Search /><input aria-label="搜索客户" value={query} onChange={(event) => updateParam("q", event.target.value)} placeholder="搜索姓名、公司或标签" /></label>
      <select aria-label="按负责人筛选" value={owner} onChange={(event) => updateParam("owner", event.target.value)}><option value="all">全部负责人</option>{[...new Set(state.customers.map((item) => item.owner))].map((item) => <option key={item}>{item}</option>)}</select>
      <select aria-label="按状态筛选" value={stateFilter} onChange={(event) => updateParam("state", event.target.value)}><option value="all">全部状态</option>{Object.entries(STATE_LABELS).map(([code, label]) => <option value={code} key={code}>{code} · {label}</option>)}</select>
      <select aria-label="按证据强度筛选" value={evidence} onChange={(event) => updateParam("evidence", event.target.value)}><option value="all">全部证据</option><option value="strong">强证据</option><option value="medium">中证据</option><option value="weak">弱证据</option></select>
      <span className="filter-count">{customers.length} / {state.customers.length} 位</span>
    </div>
    {!customers.length ? <EmptyState title="没有匹配的客户" detail="调整负责人、状态或证据筛选后再试。" action={<button className="secondary-button" onClick={() => setParams({})}>清空筛选</button>} /> : <>
      <div className="table-wrap desktop-table customers-table"><table><thead><tr><th className="checkbox-cell"><input type="checkbox" aria-label="选择当前列表前十位" checked={Boolean(customers.length) && customers.slice(0, 10).every((item) => selected.includes(item.id))} onChange={(event) => setSelected(event.target.checked ? customers.slice(0, 10).map((item) => item.id) : [])} /></th><th>客户</th><th>状态 / 置信度</th><th>证据</th><th>最近互动</th><th>下一最佳动作</th><th>复查时间</th><th /></tr></thead><tbody>{customers.map((customer) => <tr key={customer.id}><td><input type="checkbox" aria-label={`选择 ${customer.name}`} checked={selected.includes(customer.id)} onChange={() => toggle(customer.id)} /></td><td><Link className="customer-name" to={`/customers/${customer.id}`} state={{ from: location.pathname + location.search }}><strong>{customer.name}</strong><small>{customer.company}</small></Link><span className="owner-line"><UserRound />{customer.owner}{customer.shared && " · 共享"}</span></td><td><StateBadge state={customer.state} /><small className="confidence-line"><i><b style={{ width: `${customer.confidence}%` }} /></i>{customer.confidence}%</small></td><td><EvidenceBadge strength={customer.evidence_strength} /><small>{customer.evidence.filter((item) => item.valid).length} 条有效引用</small></td><td className="interaction-cell"><span>{customer.last_interaction}</span><small>{relativeDate(customer.last_interaction_at)}</small></td><td><strong>{customer.evaluation?.recommendation ?? "待评估"}</strong><small>{customer.evaluation?.cta}</small></td><td><span className={new Date(customer.review_at) < new Date("2026-08-24") ? "warning-text" : ""}>{shortDate(customer.review_at)}</span>{customer.anomaly && <small className="danger-text">{customer.anomaly}</small>}</td><td><Link className="icon-button" aria-label={`查看 ${customer.name} 详情`} title="查看客户详情" to={`/customers/${customer.id}`} state={{ from: location.pathname + location.search }}><ChevronRight /></Link></td></tr>)}</tbody></table></div>
      <div className="mobile-card-list customer-cards">{customers.map((customer) => <article className="mobile-card" key={customer.id}><div className="mobile-card-head"><label className="mobile-check"><input type="checkbox" checked={selected.includes(customer.id)} onChange={() => toggle(customer.id)} /><span className="sr-only">选择 {customer.name}</span></label><StateBadge state={customer.state} /></div><h2>{customer.name} <small>{customer.company}</small></h2><div className="card-badges"><EvidenceBadge strength={customer.evidence_strength} /><span>{customer.confidence}% 置信</span></div><p>{customer.last_interaction}</p><div className="nba-mini"><span>NBA</span><strong>{customer.evaluation?.recommendation}</strong><small>{customer.evaluation?.cta}</small></div><Link className="secondary-button full" to={`/customers/${customer.id}`} state={{ from: location.pathname + location.search }}>查看详情 <ArrowRight /></Link></article>)}</div>
    </>}
  </>;
}

export function CustomerDetail() {
  const { customerId } = useParams();
  const location = useLocation();
  const navigate = useNavigate();
  const { state, loading, health, applyCustomerEvaluation, explainError, notify } = useAppStore();
  const [evaluating, setEvaluating] = useState(false);
  const [error, setError] = useState<{ code: string; message: string } | null>(null);
  const [note, setNote] = useState("");
  if (loading || !state) return <LoadingState />;
  const customer = state.customers.find((item) => item.id === customerId);
  if (!customer) return <EmptyState title="客户不存在" detail="该演示客户可能已被重置。" action={<Link className="secondary-button" to="/customers">返回客户列表</Link>} />;
  const currentCustomer = customer;
  const backTo = (location.state as { from?: string } | null)?.from ?? "/customers";
  async function evaluate() {
    setEvaluating(true); setError(null);
    try {
      const result = await aiClient.customerEvaluation(currentCustomer);
      await applyCustomerEvaluation(currentCustomer.id, result.data, result.meta, currentCustomer.revision);
      notify({ title: "客户状态与 NBA 已自动更新", detail: `${currentCustomer.state} → ${result.data.state_after} · ${result.data.recommendation}`, tone: "success" });
    } catch (cause) { setError(explainError(cause)); } finally { setEvaluating(false); }
  }
  return <>
    <button className="back-button" onClick={() => navigate(backTo)}><ArrowLeft />返回原筛选</button>
    <SectionHeader eyebrow={`${customer.company} · ${customer.title}`} title={customer.name} description={`${customer.owner} 负责 · 来源：${customer.source} · 最近互动 ${relativeDate(customer.last_interaction_at)}`} actions={<button className="primary-button" onClick={() => void evaluate()} disabled={evaluating}><Bot />{evaluating ? "正在评估…" : "AI 重新评估"}</button>} />
    {error && <InlineAlert tone="danger" title={`${error.code} · 未写入状态`}>{error.message} <button className="text-button" onClick={() => void evaluate()}>重试</button></InlineAlert>}
    <div className="customer-above-fold">
      <section className="panel state-focus"><div className="panel-heading"><div><span className="eyebrow">当前状态</span><h2><StateBadge state={customer.state} /></h2></div><strong className="confidence-number">{customer.confidence}%</strong></div><div className="confidence-track"><i style={{ width: `${customer.confidence}%` }} /></div><dl><div><dt>触发事件</dt><dd>{customer.evidence[0]?.type}</dd></div><div><dt>更新时间</dt><dd>{shortDate(customer.updated_at)}</dd></div><div><dt>复查时间</dt><dd>{shortDate(customer.review_at)}</dd></div></dl>{customer.anomaly && <span className="danger-line">{customer.anomaly}</span>}</section>
      <section className="panel evidence-focus"><div className="panel-heading"><div><span className="eyebrow">状态证据</span><h2>{customer.evidence.filter((item) => item.valid).length} 条有效证据</h2></div><EvidenceBadge strength={customer.evidence_strength} /></div><p className="evidence-summary">{customer.last_interaction}</p><div className="evidence-ref-row">{customer.evidence.map((item) => <span className={item.valid ? "" : "invalid"} key={item.id}>{item.id} · {item.type}{!item.valid && "（已失效）"}</span>)}</div><small>弱信号仅用于观察，不能单独升至 D1 / A1。</small></section>
      <section className="panel nba-focus"><div className="panel-heading"><div><span className="eyebrow">下一最佳动作</span><h2>{customer.evaluation?.recommendation ?? "待评估"}</h2></div><Sparkles /></div><p>{customer.evaluation?.draft}</p><div className="cta-box"><span>建议 CTA</span><strong>{customer.evaluation?.cta}</strong></div><div className="nba-meta"><span><CalendarClock />{shortDate(customer.evaluation?.next_review_at ?? customer.review_at)}</span><span>预期：{customer.evaluation?.expected_transition}</span></div></section>
    </div>
    {!health?.ai_configured && <InlineAlert tone="warning" title="真实模型未配置">重新评估会返回 `AI_NOT_CONFIGURED` 并保持当前状态，不会使用 Mock 结果。</InlineAlert>}
    <div className="detail-grid">
      <section className="panel"><div className="panel-heading"><div><span className="eyebrow">微信客服</span><h2>近 3 天摘要</h2></div><MessageSquareText /></div><p>{customer.kf_summary}</p><InlineAlert tone="info" title="只读同步">回复建议仅作为草稿，不调用发送接口。</InlineAlert></section>
      <section className="panel"><div className="panel-heading"><div><span className="eyebrow">人工补充</span><h2>销售私聊笔记</h2></div><UsersRound /></div><label className="field"><span>事实或结果</span><textarea className="note-area" placeholder="记录未接入会话存档的私聊事实…" value={note} onChange={(event) => setNote(event.target.value)} /></label><button className="secondary-button" disabled={!note.trim()} onClick={() => { setNote(""); notify({ title: "人工笔记已记录", detail: "演示版仅保存在当前会话。", tone: "success" }); }}><CheckSquare />记录笔记</button></section>
    </div>
    <section className="panel timeline-panel"><div className="panel-heading"><div><span className="eyebrow">客户时间线</span><h2>事件与证据</h2></div><Clock3 /></div><div className="timeline">{customer.evidence.map((item) => <div key={item.id}><i /><time>{shortDate(item.occurred_at)}</time><span><b>{item.type} · {item.source}</b><p>{item.text}</p><small>{item.strength} · {item.valid ? "有效" : "已失效"} · {item.id}</small></span></div>)}</div></section>
  </>;
}

function shortDate(value: string) { return new Intl.DateTimeFormat("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(value)); }
function relativeDate(value: string) { const hours = Math.max(1, Math.round((new Date("2026-08-23T15:00:00+08:00").getTime() - new Date(value).getTime()) / 3_600_000)); return hours < 24 ? `${hours} 小时前` : `${Math.round(hours / 24)} 天前`; }
