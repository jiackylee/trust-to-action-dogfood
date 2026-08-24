import { useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { ArrowRight, BookOpenCheck, Check, Eye, Filter, MessageSquareText, Sparkles, X } from "lucide-react";
import { canViewRawConversation } from "../domain/permissions";
import { archiveMessageEligibility } from "../domain/policy";
import type { ContentBrief, ConversationInsight } from "../domain/types";
import { EvidenceBadge, InlineAlert, LoadingState, Modal, SectionHeader, StatusBadge } from "../components/UI";
import { useAppStore } from "../store/AppStore";
import { MarketingDecisionPanel } from "../components/MarketingDecisionPanel";

type DecisionMode = "accepted" | "dismissed";

export function Insights() {
  const { state, loading, decideInsight, generateMarketingCandidate, recordRawAccess, explainError, notify } = useAppStore();
  const [params] = useSearchParams();
  const [status, setStatus] = useState(params.get("status") ?? "all");
  const [category, setCategory] = useState("all");
  const [scope, setScope] = useState("all");
  const [strength, setStrength] = useState("all");
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<ConversationInsight | null>(null);
  const [decisionMode, setDecisionMode] = useState<DecisionMode | null>(null);
  const [reason, setReason] = useState("");
  const [editedTitle, setEditedTitle] = useState("");
  const [briefInsight, setBriefInsight] = useState<ConversationInsight | null>(null);
  const [briefCandidate, setBriefCandidate] = useState<ContentBrief | null>(null);
  const [generating, setGenerating] = useState(false);
  const [rawConversationId, setRawConversationId] = useState<string | null>(null);
  const [rawPurpose, setRawPurpose] = useState("");
  const [rawUnlocked, setRawUnlocked] = useState<string | null>(null);
  const [error, setError] = useState<{ code: string; message: string } | null>(null);

  const filtered = useMemo(() => state?.conversation_insights.filter((insight) => {
    const text = `${insight.title} ${insight.summary} ${insight.customer_segment}`.toLowerCase();
    return (status === "all" || insight.status === status)
      && (category === "all" || insight.category === category)
      && (scope === "all" || insight.trend_scope === scope)
      && (strength === "all" || insight.evidence_strength === strength)
      && (!query || text.includes(query.toLowerCase()));
  }) ?? [], [state, status, category, scope, strength, query]);

  if (loading || !state) return <LoadingState />;
  const currentState = state;
  const candidateCount = currentState.conversation_insights.filter((item) => item.status === "candidate").length;
  const acceptedWithoutBrief = currentState.conversation_insights.filter((item) => item.status === "accepted" && !item.brief_id).length;
  const validMessages = currentState.archived_messages.filter((message) => archiveMessageEligibility(message, currentState.archive_consents.find((consent) => consent.conversation_id === message.conversation_id)).eligible).length;

  function openDecision(insight: ConversationInsight, mode: DecisionMode) {
    setSelected(insight); setDecisionMode(mode); setReason(""); setEditedTitle(insight.title); setError(null);
  }

  async function submitDecision() {
    if (!selected || !decisionMode) return;
    try {
      await decideInsight(selected.id, decisionMode, reason, editedTitle !== selected.title ? { title: editedTitle } : {}, selected.revision);
      setDecisionMode(null); setSelected(null);
    } catch (cause) { setError(explainError(cause)); }
  }

  async function openBrief(insight: ConversationInsight) {
    const existing = currentState.content_briefs.find((brief) => brief.id === insight.brief_id) ?? currentState.content_briefs.find((brief) => brief.insight_ids.includes(insight.id));
    setBriefInsight(insight); setBriefCandidate(existing ?? null); setError(null);
  }

  async function generateBrief() {
    if (!briefInsight) return;
    setGenerating(true); setError(null);
    try {
      const existing = currentState.content_briefs.find((brief) => brief.insight_ids.includes(briefInsight.id)) ?? currentState.content_briefs.find((brief) => brief.status === "draft");
      if (!existing) throw new Error("NO_BRIEF_SLOT");
      await generateMarketingCandidate("content_brief", existing.id, existing.revision, `${briefInsight.title} ${briefInsight.customer_segment} 朋友圈内容 Brief 唯一 CTA 证明需求`, { insight_id: briefInsight.id });
      setBriefCandidate(existing);
    } catch (cause) { setError(explainError(cause)); }
    finally { setGenerating(false); }
  }

  async function unlockRaw() {
    if (!rawConversationId || !rawPurpose) return;
    try { await recordRawAccess(rawConversationId, rawPurpose); setRawUnlocked(rawConversationId); setRawConversationId(null); setRawPurpose(""); }
    catch (cause) { setError(explainError(cause)); }
  }

  const rawConversation = state.archive_conversations.find((item) => item.id === rawUnlocked);
  const rawMessages = rawConversation ? state.archived_messages.filter((message) => message.conversation_id === rawConversation.id).sort((a, b) => a.seq - b.seq) : [];
  const activeBrief = briefInsight ? state.content_briefs.find((brief) => brief.insight_ids.includes(briefInsight.id)) ?? null : null;
  const briefMarketingCandidate = activeBrief ? state.marketing_candidates.find((candidate) => candidate.task_type === "content_brief" && candidate.subject_id === activeBrief.id && candidate.status === "pending") : null;

  return <>
    <SectionHeader eyebrow="内容运营输入" title="会话洞察池" description="只分析已同意、有效且脱敏的文本与链接描述。运营看到聚类和脱敏引用，不展示客户原文。" actions={<button className="secondary-button" onClick={() => notify({ title: "分析批次已是最新", detail: `${validMessages} 条消息通过隐私与有效性门禁。`, tone: "info" })}><Sparkles />运行合成分析</button>} />
    <section className="insight-summary" aria-label="洞察处理概览">
      <div><span>待判断洞察</span><strong>{candidateCount}</strong><small>需要运营接受或忽略</small></div>
      <div><span>待生成 Brief</span><strong>{acceptedWithoutBrief}</strong><small>仅已接受洞察可进入</small></div>
      <div><span>有效分析消息</span><strong>{validMessages}</strong><small>未同意与异常消息已排除</small></div>
      <div><span>趋势门槛</span><strong>3</strong><small>独立有效会话</small></div>
    </section>
    <div className="filter-bar insight-filters">
      <Filter aria-hidden="true" />
      <input aria-label="搜索洞察" placeholder="搜索主题、分组或摘要" value={query} onChange={(event) => setQuery(event.target.value)} />
      <select aria-label="洞察状态" value={status} onChange={(event) => setStatus(event.target.value)}><option value="all">全部状态</option><option value="candidate">待判断</option><option value="accepted">已接受</option><option value="dismissed">已忽略</option></select>
      <select aria-label="信号类型" value={category} onChange={(event) => setCategory(event.target.value)}><option value="all">全部类型</option>{["问题", "异议", "期望结果", "购买信号"].map((item) => <option key={item}>{item}</option>)}</select>
      <select aria-label="趋势范围" value={scope} onChange={(event) => setScope(event.target.value)}><option value="all">趋势与个体</option><option value="trend">趋势</option><option value="individual">个体信号</option></select>
      <select aria-label="证据强度" value={strength} onChange={(event) => setStrength(event.target.value)}><option value="all">全部强度</option><option value="weak">弱证据</option><option value="medium">中证据</option><option value="strong">强证据</option></select>
    </div>
    <section className="insight-list" aria-label="洞察列表">{filtered.map((insight) => {
      const canDecide = state.role === "operations" && insight.status === "candidate";
      return <article className={`insight-card insight-${insight.status}`} key={insight.id}>
        <div className="insight-main">
          <div className="insight-heading"><span className="signal-category">{insight.category}</span><StatusBadge status={insight.status} /><EvidenceBadge strength={insight.evidence_strength} /><span className={`scope-pill scope-${insight.trend_scope}`}>{insight.trend_scope === "trend" ? "趋势" : "个体信号"}</span></div>
          <h2>{insight.title}</h2><p>{insight.summary}</p>
          <div className="quote-list">{insight.redacted_quotes.map((quote) => <blockquote key={quote}>“{quote}”</blockquote>)}</div>
          <dl className="insight-meta"><div><dt>目标分组</dt><dd>{insight.customer_segment}</dd></div><div><dt>独立会话</dt><dd>{insight.distinct_conversation_count} 个</dd></div><div><dt>置信度</dt><dd>{insight.confidence}%</dd></div><div><dt>血缘</dt><dd>{insight.message_refs.length} 条消息</dd></div></dl>
          {insight.decision_reason && <small className="decision-reason">判断：{insight.decision_reason}</small>}
        </div>
        <aside className="insight-actions">
          {canDecide && <><button className="primary-button" onClick={() => openDecision(insight, "accepted")}><Check />接受</button><button className="secondary-button" onClick={() => openDecision(insight, "dismissed")}><X />忽略</button></>}
          {insight.status === "accepted" && <button className="secondary-button" onClick={() => void openBrief(insight)}><BookOpenCheck />{insight.brief_id ? "查看 Brief" : "生成 Brief"}<ArrowRight /></button>}
          {insight.conversation_refs.map((conversationId) => {
            const conversation = state.archive_conversations.find((item) => item.id === conversationId);
            return conversation && canViewRawConversation(state.role, conversation) ? <button key={conversationId} className="text-button raw-access" onClick={() => { setRawConversationId(conversationId); setRawUnlocked(null); }}><Eye />查看 {conversationId} 原文</button> : null;
          })}
        </aside>
      </article>;
    })}</section>
    {!filtered.length && <InlineAlert tone="info" title="当前筛选没有洞察">调整状态、类型或证据强度后再查看。</InlineAlert>}

    <Modal open={Boolean(decisionMode)} title={decisionMode === "accepted" ? "接受会话洞察" : "忽略会话洞察"} onClose={() => setDecisionMode(null)} actions={<><button className="secondary-button" onClick={() => setDecisionMode(null)}>取消</button><button className={decisionMode === "accepted" ? "primary-button" : "danger-button"} disabled={(decisionMode === "dismissed" || editedTitle !== selected?.title) && !reason.trim()} onClick={() => void submitDecision()}>确认判断</button></>}>
      <label className="field"><span>洞察标题</span><input data-autofocus value={editedTitle} onChange={(event) => setEditedTitle(event.target.value)} /></label>
      <label className="field"><span>判断原因{decisionMode === "accepted" && editedTitle === selected?.title ? "（可选）" : "（必填）"}</span><textarea value={reason} onChange={(event) => setReason(event.target.value)} placeholder="说明接受、修改或忽略依据" /></label>
      {selected && selected.distinct_conversation_count < 3 && <InlineAlert title="只能标记为个体信号">当前只有 {selected.distinct_conversation_count} 个独立有效会话，不能称为趋势。</InlineAlert>}
      {error && <InlineAlert tone="danger" title={error.code}>{error.message}</InlineAlert>}
    </Modal>

    <Modal open={Boolean(briefInsight)} title="内容 Brief" onClose={() => { setBriefInsight(null); setBriefCandidate(null); }} actions={<button className="secondary-button" onClick={() => void generateBrief()} disabled={generating}><Sparkles />{generating ? "生成中" : briefMarketingCandidate ? "重新生成候选" : "AI 生成候选"}</button>}>
      {briefMarketingCandidate && activeBrief ? <MarketingDecisionPanel candidate={briefMarketingCandidate} currentRevision={activeBrief.revision} compact /> : briefCandidate ? <div className="brief-preview"><div><span>目标客户</span><strong>{briefCandidate.target_segment}</strong></div><div><span>阶段</span><strong>{briefCandidate.stage}</strong></div><div className="wide"><span>朋友圈主角度</span><strong>{briefCandidate.primary_angle}</strong></div><div className="wide"><span>关键事实</span><ul>{briefCandidate.key_facts.map((fact) => <li key={fact}>{fact}</li>)}</ul></div><div className="wide"><span>证明需求</span><strong>{briefCandidate.proof_requirements.join("、") || "无额外证明需求"}</strong></div><div><span>唯一 CTA</span><strong>{briefCandidate.cta}</strong></div><div><span>截止时间</span><strong>{new Date(briefCandidate.due_at).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })}</strong></div></div> : <InlineAlert tone="info" title="尚无 Brief 候选">生成后会保存知识引用和企业事实版本，必须人工判断后才写入 Brief。</InlineAlert>}
      {error && <InlineAlert tone="danger" title={error.code}>{error.message}</InlineAlert>}
    </Modal>

    <Modal open={Boolean(rawConversationId)} title="访问会话原文" onClose={() => setRawConversationId(null)} actions={<><button className="secondary-button" onClick={() => setRawConversationId(null)}>取消</button><button className="primary-button" disabled={!rawPurpose} onClick={() => void unlockRaw()}>记录用途并展开</button></>}>
      <InlineAlert title="原文访问会进入审计">销售只能查看本人会话；负责人可按需查看全部。运营无原文访问权限。</InlineAlert>
      <label className="field"><span>访问用途</span><select data-autofocus value={rawPurpose} onChange={(event) => setRawPurpose(event.target.value)}><option value="">请选择</option><option>确认销售洞察</option><option>处理客户投诉</option><option>合规抽查</option></select></label>
    </Modal>
    <Modal open={Boolean(rawUnlocked)} title={rawConversation?.display_name ?? "会话原文"} onClose={() => setRawUnlocked(null)}>
      <div className="raw-message-list">{rawMessages.map((message) => <div key={message.id} className={message.sender === "customer" ? "raw-customer" : "raw-employee"}><span>{message.sender_name} · seq {message.seq}</span><p>{message.recalled ? "[该消息已撤回]" : message.decrypt_status === "failed" ? "[消息解密失败]" : message.text ?? message.link_description ?? `[${message.kind} 元数据：${message.media_name}]`}</p></div>)}</div>
    </Modal>
  </>;
}
