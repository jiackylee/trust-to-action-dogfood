import { useEffect, useMemo, useState } from "react";
import { AlertCircle, Check, CheckCircle2, Clipboard, Cloud, CloudOff, FileClock, LoaderCircle, PanelRightOpen, RefreshCw, Save, ShieldCheck, Sparkles } from "lucide-react";
import { useSearchParams } from "react-router-dom";
import { aiClient } from "../data/ai-client";
import { draftApprovalRisks, proofIsUsable } from "../domain/policy";
import type { ContentDraftProposal } from "../domain/schemas";
import type { Draft } from "../domain/types";
import { InlineAlert, LoadingState, Modal, SectionHeader, StatusBadge } from "../components/UI";
import { useAppStore } from "../store/AppStore";
import { can } from "../domain/permissions";

export function ContentWorkspace() {
  const { state, loading, health, saveDraft, submitDraftApproval, explainError, notify } = useAppStore();
  const [params] = useSearchParams();
  const [selectedId, setSelectedId] = useState<string | null>(() => params.get("draft"));
  const [local, setLocal] = useState<Draft | null>(null);
  const [dirty, setDirty] = useState(false);
  const [saveStatus, setSaveStatus] = useState<"saved" | "saving" | "failed">("saved");
  const [error, setError] = useState<{ code: string; message: string; latest?: unknown } | null>(null);
  const [generating, setGenerating] = useState<"draft" | "risk" | null>(null);
  const [riskSummary, setRiskSummary] = useState<string>("");
  const [conflictOpen, setConflictOpen] = useState(false);
  const [discardOpen, setDiscardOpen] = useState(false);
  const [pendingSwitch, setPendingSwitch] = useState<string | null>(null);
  const [candidate, setCandidate] = useState<ContentDraftProposal | null>(null);
  const [candidateOpen, setCandidateOpen] = useState(false);
  const drafts = useMemo(() => state?.drafts.filter((draft) => !params.get("status") || draft.status === params.get("status")) ?? [], [state, params]);
  const selected = state?.drafts.find((draft) => draft.id === selectedId) ?? drafts[0];

  useEffect(() => { if (!selectedId && drafts[0]) setSelectedId(drafts[0].id); }, [selectedId, drafts]);
  useEffect(() => { if (selected && (!dirty || selected.id !== local?.id)) { setLocal(selected); setDirty(false); setSaveStatus("saved"); } }, [selected, dirty, local?.id]);
  useEffect(() => {
    if (!dirty || !local) return;
    const timer = window.setTimeout(async () => {
      setSaveStatus("saving"); setError(null);
      try { const saved = await saveDraft(local, local.revision); setLocal(saved); setDirty(false); setSaveStatus("saved"); }
      catch (cause) {
        const details = explainError(cause); setError(details); setSaveStatus("failed");
        if (details.code === "VERSION_CONFLICT") setConflictOpen(true);
      }
    }, 1000);
    return () => window.clearTimeout(timer);
  }, [dirty, local, saveDraft, explainError]);

  useEffect(() => {
    const beforeUnload = (event: BeforeUnloadEvent) => { if (dirty) event.preventDefault(); };
    window.addEventListener("beforeunload", beforeUnload); return () => window.removeEventListener("beforeunload", beforeUnload);
  }, [dirty]);

  if (loading || !state || !local) return <LoadingState />;
  const currentState = state;
  const currentDraft = local;
  const proofs = state.proofs;
  const deterministicRisks = draftApprovalRisks(local, proofs);
  const boundProofs = local.evidence_refs.map((id) => proofs.find((item) => item.id === id)).filter(Boolean);
  const hasBlockedProof = boundProofs.some((proof) => !proof || !proofIsUsable(proof) || !proof.authorization.includes(local.channel));
  const approvalNeeded = deterministicRisks.length > 0 || local.approval_required;
  const canEdit = can(state.role, "edit_draft");

  function change<K extends keyof Draft>(key: K, value: Draft[K]) { setLocal((draft) => draft ? { ...draft, [key]: value } : draft); setDirty(true); setSaveStatus("saving"); }
  async function saveCurrent() {
    if (!local || !dirty) return local;
    setSaveStatus("saving"); setError(null);
    try {
      const saved = await saveDraft(local, local.revision);
      setLocal(saved); setDirty(false); setSaveStatus("saved");
      return saved;
    } catch (cause) {
      const details = explainError(cause); setError(details); setSaveStatus("failed");
      if (details.code === "VERSION_CONFLICT") setConflictOpen(true);
      throw cause;
    }
  }
  async function selectDraft(id: string) {
    if (id === local?.id) return;
    if (dirty) {
      try { await saveCurrent(); }
      catch { setPendingSwitch(id); setDiscardOpen(true); return; }
    }
    setSelectedId(id);
  }
  async function generateDraft() {
    setGenerating("draft"); setError(null);
    try {
      const result = await aiClient.contentDraft(currentState.weekly_plan.strategy, proofs.filter((item) => item.status === "usable"), currentDraft.stage);
      setCandidate(result.data); setCandidateOpen(true);
    } catch (cause) { setError(explainError(cause)); } finally { setGenerating(null); }
  }
  async function reviewRisk() {
    setGenerating("risk"); setError(null);
    try { const result = await aiClient.riskReview(currentDraft, proofs); setRiskSummary(result.data.summary || "检查完成"); change("risk_flags", [...new Set([...deterministicRisks, ...result.data.risk_flags])]); }
    catch (cause) { setError(explainError(cause)); } finally { setGenerating(null); }
  }
  async function copyDraft() {
    if (hasBlockedProof || (approvalNeeded && currentDraft.approval_status !== "approved")) return;
    await navigator.clipboard.writeText(`${currentDraft.body}\n\n${currentDraft.cta}`);
    notify({ title: "草稿已复制", detail: "请在企业微信中人工检查并发布。", tone: "success" });
  }
  async function requestApproval() {
    setError(null);
    try {
      const saved = dirty ? await saveCurrent() : currentDraft;
      if (saved) await submitDraftApproval(saved.id, saved.revision);
    } catch (cause) { setError(explainError(cause)); }
  }
  return <>
    <SectionHeader eyebrow="内容工作域" title="策略与草稿" description="草稿、正文和证据风险同屏处理；完整编辑体验面向桌面。" actions={<div className={`save-indicator save-${saveStatus}`}>{saveStatus === "saving" ? <LoaderCircle className="spin" /> : saveStatus === "failed" ? <CloudOff /> : <Cloud />}{saveStatus === "saving" ? "正在自动保存" : saveStatus === "failed" ? "保存失败" : `已保存 · v${local.revision}`}</div>} />
    <div className="mobile-editor-notice"><InlineAlert tone="info" title="完整编辑请使用桌面端">移动端仍可查看草稿状态、证据和审批，但长正文编辑已收起。</InlineAlert></div>
    {error && <InlineAlert tone="danger" title="操作未完成，当前输入已保留">{error.message} <button className="text-button" onClick={() => error.code === "AI_NOT_CONFIGURED" ? void generateDraft() : setError(null)}>重试</button><details className="technical-details"><summary>技术详情</summary><code>{error.code}</code></details></InlineAlert>}
    <div className="content-workspace desktop-editor">
      <aside className="draft-list-pane"><div className="pane-title"><span>本周草稿</span><b>{drafts.length}</b></div><div className="draft-list">{drafts.map((draft) => <button key={draft.id} className={draft.id === local.id ? "draft-item selected" : "draft-item"} onClick={() => void selectDraft(draft.id)}><span><i className={`stage-code stage-${draft.stage.toLowerCase()}`}>{draft.stage}</i><StatusBadge status={draft.status} /></span><strong>{draft.title}</strong><small>{draft.segment}</small>{draft.approval_required && <em><ShieldCheck />需审批</em>}</button>)}</div></aside>
      <section className="editor-pane">
        <div className="editor-toolbar"><div className="segmented-control" aria-label="漏斗阶段">{["T", "I", "D", "A"].map((stage) => <button disabled={!canEdit} className={local.stage === stage ? "active" : ""} onClick={() => change("stage", stage as Draft["stage"])} key={stage}>{stage}</button>)}</div><div><button className="secondary-button" onClick={() => void generateDraft()} disabled={Boolean(generating) || !canEdit} title={!canEdit ? "只有运营角色可以编辑草稿" : undefined}><Sparkles />{generating === "draft" ? "生成中" : "AI 生成候选"}</button><button className="icon-button" title="立即保存" aria-label="立即保存" disabled={!dirty || !canEdit} onClick={() => void saveCurrent()}><Save /></button></div></div>
        {!canEdit && <InlineAlert tone="info" title="当前角色为只读">销售和负责人可查看或复制已就绪草稿，只有运营可以编辑。</InlineAlert>}
        <label className="field"><span>标题</span><input readOnly={!canEdit} value={local.title} onChange={(event) => change("title", event.target.value)} /></label>
        <div className="field-grid"><label className="field"><span>目标客户</span><input readOnly={!canEdit} value={local.segment} onChange={(event) => change("segment", event.target.value)} /></label><label className="field"><span>经营目标</span><input readOnly={!canEdit} value={local.objective} onChange={(event) => change("objective", event.target.value)} /></label></div>
        <label className="field body-field"><span>正文 <small>{local.body.length} 字</small></span><textarea readOnly={!canEdit} value={local.body} onChange={(event) => change("body", event.target.value)} /></label>
        <div className="field-grid"><label className="field"><span>唯一行动指引</span><input readOnly={!canEdit} value={local.cta} onChange={(event) => change("cta", event.target.value)} /></label><label className="field"><span>发布渠道</span><select disabled={!canEdit} value={local.channel} onChange={(event) => change("channel", event.target.value as Draft["channel"])}>{["朋友圈", "销售", "官网", "仅内部"].map((channel) => <option key={channel}>{channel}</option>)}</select></label></div>
        <label className="field"><span>预期状态变化</span><input readOnly={!canEdit} value={local.expected_transition} onChange={(event) => change("expected_transition", event.target.value)} /></label>
        {dirty && <div className="unsaved-hint"><FileClock />存在未保存修改；离开页面前系统会提示。</div>}
      </section>
      <aside className="risk-pane"><div className="pane-title"><span>证据与风险</span><PanelRightOpen /></div>
        <section className="side-section"><div className="side-heading"><strong>绑定证据</strong><span>{boundProofs.length}</span></div>{boundProofs.length ? boundProofs.map((proof) => proof && <label className={`proof-check proof-${proof.status}`} key={proof.id}><input disabled={!canEdit} type="checkbox" checked onChange={() => change("evidence_refs", local.evidence_refs.filter((id) => id !== proof.id))} /><span><b>{proof.title}</b><small>{proof.completeness}% 完整 · {proof.authorization.join(" / ") || "无授权"}</small></span></label>) : <p className="muted">尚未绑定证明资产。</p>}
          <select disabled={!canEdit} aria-label="添加证明资产" value="" onChange={(event) => event.target.value && change("evidence_refs", [...local.evidence_refs, event.target.value])}><option value="">+ 添加证据</option>{proofs.filter((proof) => !local.evidence_refs.includes(proof.id)).map((proof) => { const available = proofIsUsable(proof) && proof.authorization.includes(local.channel); return <option key={proof.id} value={proof.id} disabled={!available}>{proof.title} · {available ? `${proof.completeness}%` : "状态或渠道授权不符"}</option>; })}</select>
        </section>
        <section className="side-section"><div className="side-heading"><strong>确定性风险</strong><span>{deterministicRisks.length}</span></div>{deterministicRisks.length ? <div className="risk-tags">{deterministicRisks.map((risk) => <span key={risk}><AlertCircle />{risk}</span>)}</div> : <div className="pass-line"><CheckCircle2 />未命中敏感门禁</div>}{riskSummary && <p className="review-summary">AI 建议：{riskSummary}</p>}<button className="secondary-button full" onClick={() => void reviewRisk()} disabled={Boolean(generating) || !canEdit}><RefreshCw className={generating === "risk" ? "spin" : ""} />运行风险检查</button></section>
        {hasBlockedProof && <InlineAlert tone="danger" title="引用已阻断">绑定资产不可用或未授权用于“{local.channel}”，草稿不可复制或发布。</InlineAlert>}
        <section className="publish-gate"><div><strong>人工发布门禁</strong><small>{hasBlockedProof ? "证据失效或渠道未授权" : approvalNeeded && local.approval_status !== "approved" ? "等待负责人批准" : "已满足复制条件"}</small></div>{approvalNeeded && local.approval_status !== "approved" && <button className="secondary-button full" onClick={() => void requestApproval()} disabled={!canEdit || local.approval_status === "pending" || hasBlockedProof}><ShieldCheck />{local.approval_status === "pending" ? "审批处理中" : "提交负责人审批"}</button>}<button className="primary-button full" onClick={() => void copyDraft()} disabled={hasBlockedProof || (approvalNeeded && local.approval_status !== "approved")}><Clipboard />复制草稿</button><p>复制不等于发布。系统不会调用企业微信发送接口。</p></section>
      </aside>
    </div>
    <div className="mobile-draft-list">{drafts.map((draft) => <article key={draft.id} className="mobile-card"><div className="mobile-card-head"><span className={`stage-code stage-${draft.stage.toLowerCase()}`}>{draft.stage}</span><StatusBadge status={draft.status} /></div><h2>{draft.title}</h2><p>{draft.body.slice(0, 88)}…</p><dl><div><dt>目标</dt><dd>{draft.segment}</dd></div><div><dt>行动指引</dt><dd>{draft.cta}</dd></div></dl>{draft.approval_required && <span className="warning-line"><ShieldCheck />需要负责人审批</span>}</article>)}</div>
    <Modal open={conflictOpen} title="检测到版本冲突" onClose={() => setConflictOpen(false)} actions={<><button className="secondary-button" onClick={() => setConflictOpen(false)}>保留本地输入</button><button className="primary-button" onClick={() => { const latest = error?.latest as Draft | undefined; if (latest) { setLocal(latest); setDirty(false); setSaveStatus("saved"); } setConflictOpen(false); }}>载入最新版本</button></>}><p>当前草稿已被其他操作更新。本地输入仍在编辑器中；可保留后人工合并，或载入服务端最新版本。</p></Modal>
    <Modal open={discardOpen} title="当前修改尚未保存" onClose={() => setDiscardOpen(false)} actions={<><button className="secondary-button" onClick={() => { setPendingSwitch(null); setDiscardOpen(false); }}>继续编辑</button><button className="danger-button" onClick={() => { if (pendingSwitch) setSelectedId(pendingSwitch); setPendingSwitch(null); setDirty(false); setDiscardOpen(false); }}>放弃修改并切换</button></>}><p>自动保存未成功。你可以留在当前草稿重试，或明确放弃本地修改后切换。</p></Modal>
    <Modal open={candidateOpen} title="检查 AI 草稿候选" onClose={() => setCandidateOpen(false)} actions={<><button className="secondary-button" onClick={() => setCandidateOpen(false)}>保留原稿</button><button className="primary-button" onClick={() => { if (candidate) { setLocal({ ...currentDraft, title: candidate.title, segment: candidate.target_segment, objective: candidate.objective, body: candidate.body, cta: candidate.cta, expected_transition: candidate.expected_transition, evidence_refs: candidate.evidence_refs, risk_flags: candidate.risk_flags, approval_required: candidate.approval_required }); setDirty(true); setSaveStatus("saving"); } setCandidateOpen(false); }}><Check />采用候选</button></>}><div className="candidate-diff"><div><span>当前版本</span><strong>{currentDraft.title}</strong><p>{currentDraft.body}</p></div><div><span>AI 候选</span><strong>{candidate?.title}</strong><p>{candidate?.body}</p></div></div><p className="muted">采用后只会进入编辑器并触发本地保存，不会自动发布。</p></Modal>
  </>;
}
