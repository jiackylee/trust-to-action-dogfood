import { ArrowDownUp, CalendarClock, Link2, Pencil, Plus, ShieldOff } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { InlineAlert, LoadingState, Modal, SectionHeader, StatusBadge } from "../components/UI";
import { can } from "../domain/permissions";
import type { Proof, PublicationChannel } from "../domain/types";
import { useAppStore } from "../store/AppStore";

const channels: PublicationChannel[] = ["朋友圈", "销售", "官网", "仅内部"];

function blankProof(): Proof {
  return {
    id: "new", revision: 0, updated_at: "", title: "", industry: "企业服务", redacted_quote: "", process: "", baseline: "", result: "", period: "", authorization: ["仅内部"], expires_at: "2026-12-31", completeness: 0, status: "incomplete", missing_fields: [], referenced_by: [],
  };
}

export function ProofLibrary() {
  const { state, loading, saveProof, createProof, explainError, notify } = useAppStore();
  const [params] = useSearchParams();
  const [sort, setSort] = useState<"asc" | "desc">("asc");
  const [editing, setEditing] = useState<Proof | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ code: string; message: string } | null>(null);
  const proofs = useMemo(() => (state?.proofs ?? []).filter((proof) => params.get("readiness") !== "gap" || proof.status !== "usable").sort((a, b) => sort === "asc" ? a.completeness - b.completeness : b.completeness - a.completeness), [state, params, sort]);

  useEffect(() => {
    const proofId = params.get("proof");
    const proof = state?.proofs.find((item) => item.id === proofId);
    if (proof) setEditing(structuredClone(proof));
  }, [params, state]);

  if (loading || !state) return <LoadingState />;
  const canEdit = can(state.role, "edit_proof");
  const today = Date.now();
  const soon = today + 40 * 24 * 60 * 60_000;
  const expiredCount = state.proofs.filter((proof) => new Date(proof.expires_at).getTime() < today).length;
  const expiringCount = state.proofs.filter((proof) => { const expires = new Date(proof.expires_at).getTime(); return expires >= today && expires < soon; }).length;

  function change<K extends keyof Proof>(key: K, value: Proof[K]) { setEditing((proof) => proof ? { ...proof, [key]: value } : proof); }
  function toggleChannel(channel: PublicationChannel) {
    if (!editing) return;
    change("authorization", editing.authorization.includes(channel) ? editing.authorization.filter((item) => item !== channel) : [...editing.authorization, channel]);
  }
  async function submit() {
    if (!editing || !editing.title.trim()) return;
    setBusy(true); setError(null);
    try {
      if (editing.id === "new") {
        const { id: _id, revision: _revision, updated_at: _updatedAt, completeness: _completeness, missing_fields: _missing, referenced_by: _references, ...core } = editing;
        await createProof(core);
        notify({ title: "证明资产已创建", detail: "完整度和可用状态已按字段自动计算。", tone: "success" });
      } else {
        await saveProof(editing, editing.revision);
        notify({ title: "证明资产已更新", detail: "引用关系、授权门禁和完整度已重新计算。", tone: "success" });
      }
      setEditing(null);
    } catch (cause) { setError(explainError(cause)); } finally { setBusy(false); }
  }

  return <>
    <SectionHeader eyebrow="内容工作域" title="证明资产库" description="先处理低就绪度和即将到期的授权；失效资产会立即阻断引用草稿。" actions={<><button className="secondary-button" onClick={() => setSort((value) => value === "asc" ? "desc" : "asc")}><ArrowDownUp />就绪度 {sort === "asc" ? "低到高" : "高到低"}</button><button className="primary-button" disabled={!canEdit} onClick={() => setEditing(blankProof())}><Plus />新增证明</button></>} />
    {!canEdit && <InlineAlert tone="info" title="当前角色为只读">只有运营可以新增、修改或撤销证明资产。</InlineAlert>}
    <div className="summary-strip"><div><strong>{state.proofs.filter((proof) => proof.status === "usable").length}</strong><span>可使用</span></div><div><strong>{state.proofs.filter((proof) => proof.status === "incomplete").length}</strong><span>信息不完整</span></div><div className="danger"><strong>{state.proofs.filter((proof) => proof.status === "revoked").length}</strong><span>授权已撤销</span></div><div className="danger"><strong>{expiredCount}</strong><span>已经到期</span></div><div className="warning"><strong>{expiringCount}</strong><span>40 天内到期</span></div></div>
    <div className="table-wrap desktop-table"><table><thead><tr><th>证明资产</th><th>就绪度</th><th>授权范围</th><th>缺失字段</th><th>引用草稿</th><th>授权到期</th><th>状态</th><th /></tr></thead><tbody>{proofs.map((proof) => <tr key={proof.id} className={proof.status === "revoked" ? "row-blocked" : ""}><td><strong>{proof.title}</strong><small>{proof.industry} · {proof.period}</small></td><td><div className="readiness-cell"><b>{proof.completeness}%</b><i><span style={{ width: `${proof.completeness}%` }} /></i></div></td><td>{proof.authorization.length ? proof.authorization.map((item) => <span className="tag" key={item}>{item}</span>) : <span className="danger-text"><ShieldOff />无有效授权</span>}</td><td>{proof.missing_fields.length ? proof.missing_fields.join("、") : <span className="success-text"><span>✓</span> 完整</span>}</td><td>{proof.referenced_by.length ? proof.referenced_by.map((id) => <Link key={id} className="context-link" to={`/content?draft=${id}`}><Link2 />查看引用草稿 {id}</Link>) : "—"}</td><td>{proof.expires_at}<small>{new Date(proof.expires_at).getTime() < today ? <span className="danger-text"><CalendarClock />已到期</span> : new Date(proof.expires_at).getTime() < soon && <span className="warning-text"><CalendarClock />即将到期</span>}</small></td><td><StatusBadge status={proof.status} /></td><td><button className="icon-button" disabled={!canEdit} aria-label={`编辑 ${proof.title}`} title="编辑证明资产" onClick={() => setEditing(structuredClone(proof))}><Pencil /></button></td></tr>)}</tbody></table></div>
    <div className="mobile-card-list">{proofs.map((proof) => <article className={`mobile-card ${proof.status === "revoked" ? "card-blocked" : ""}`} key={proof.id}><div className="mobile-card-head"><StatusBadge status={proof.status} /><strong>{proof.completeness}%</strong></div><h2>{proof.title}</h2><p>{proof.redacted_quote}</p><dl><div><dt>授权</dt><dd>{proof.authorization.join(" / ") || "无"}</dd></div><div><dt>缺失</dt><dd>{proof.missing_fields.join("、") || "无"}</dd></div><div><dt>引用</dt><dd>{proof.referenced_by.join("、") || "未引用"}</dd></div><div><dt>到期</dt><dd>{proof.expires_at}</dd></div></dl><button className="secondary-button full" disabled={!canEdit} onClick={() => setEditing(structuredClone(proof))}><Pencil />编辑 {proof.title}</button></article>)}</div>

    <Modal open={Boolean(editing)} title={editing?.id === "new" ? "新增证明资产" : "维护证明资产"} onClose={() => !busy && setEditing(null)} actions={<><button className="secondary-button" disabled={busy} onClick={() => setEditing(null)}>取消</button><button className="primary-button" disabled={busy || !editing?.title.trim()} onClick={() => void submit()}>{busy ? "正在保存" : "保存证明资产"}</button></>}>
      {editing && <div className="proof-form">
        {error && <InlineAlert tone="danger" title="保存未完成">{error.message} 当前输入已保留。</InlineAlert>}
        <div className="field-grid"><label className="field"><span>名称</span><input data-autofocus value={editing.title} onChange={(event) => change("title", event.target.value)} /></label><label className="field"><span>行业</span><input value={editing.industry} onChange={(event) => change("industry", event.target.value)} /></label></div>
        <label className="field"><span>脱敏反馈原文</span><textarea value={editing.redacted_quote} onChange={(event) => change("redacted_quote", event.target.value)} /></label>
        <label className="field"><span>使用过程</span><textarea value={editing.process} onChange={(event) => change("process", event.target.value)} /></label>
        <div className="field-grid"><label className="field"><span>基线</span><input value={editing.baseline} onChange={(event) => change("baseline", event.target.value)} /></label><label className="field"><span>结果</span><input value={editing.result} onChange={(event) => change("result", event.target.value)} /></label></div>
        <div className="field-grid"><label className="field"><span>观察周期</span><input value={editing.period} onChange={(event) => change("period", event.target.value)} /></label><label className="field"><span>授权到期日</span><input type="date" value={editing.expires_at} onChange={(event) => change("expires_at", event.target.value)} /></label></div>
        <fieldset className="channel-field"><legend>授权范围</legend>{channels.map((channel) => <label key={channel}><input type="checkbox" checked={editing.authorization.includes(channel)} onChange={() => toggleChannel(channel)} />{channel}</label>)}</fieldset>
        <label className="field"><span>授权状态</span><select value={editing.status === "revoked" ? "revoked" : "active"} onChange={(event) => change("status", event.target.value === "revoked" ? "revoked" : "incomplete")}><option value="active">有效，按完整度自动判断</option><option value="revoked">撤销授权并阻断引用</option></select></label>
        {editing.referenced_by.length > 0 && <InlineAlert tone="warning" title={`当前被 ${editing.referenced_by.length} 条草稿引用`}>撤权、清空授权或修改渠道范围后，不再满足条件的草稿会立即被阻断。</InlineAlert>}
      </div>}
    </Modal>
  </>;
}
