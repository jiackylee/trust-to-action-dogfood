import { ArrowDownUp, CalendarClock, Link2, ShieldOff } from "lucide-react";
import { useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { LoadingState, SectionHeader, StatusBadge } from "../components/UI";
import { useAppStore } from "../store/AppStore";

export function ProofLibrary() {
  const { state, loading } = useAppStore();
  const [params] = useSearchParams();
  const [sort, setSort] = useState<"asc" | "desc">("asc");
  const proofs = useMemo(() => (state?.proofs ?? []).filter((proof) => params.get("readiness") !== "gap" || proof.status !== "usable").sort((a, b) => sort === "asc" ? a.completeness - b.completeness : b.completeness - a.completeness), [state, params, sort]);
  if (loading || !state) return <LoadingState />;
  return <>
    <SectionHeader eyebrow="内容工作域" title="证明资产库" description="先处理低就绪度和即将到期的授权；失效资产会立即阻断引用草稿。" actions={<button className="secondary-button" onClick={() => setSort((value) => value === "asc" ? "desc" : "asc")}><ArrowDownUp />就绪度 {sort === "asc" ? "低到高" : "高到低"}</button>} />
    <div className="summary-strip"><div><strong>{state.proofs.filter((proof) => proof.status === "usable").length}</strong><span>可使用</span></div><div><strong>{state.proofs.filter((proof) => proof.status === "incomplete").length}</strong><span>信息不完整</span></div><div className="danger"><strong>{state.proofs.filter((proof) => proof.status === "revoked").length}</strong><span>授权已撤销</span></div><div className="warning"><strong>{state.proofs.filter((proof) => new Date(proof.expires_at) < new Date("2026-10-01")).length}</strong><span>40 天内到期</span></div></div>
    <div className="table-wrap desktop-table"><table><thead><tr><th>证明资产</th><th>就绪度</th><th>授权范围</th><th>缺失字段</th><th>引用草稿</th><th>授权到期</th><th>状态</th></tr></thead><tbody>{proofs.map((proof) => <tr key={proof.id} className={proof.status === "revoked" ? "row-blocked" : ""}><td><strong>{proof.title}</strong><small>{proof.industry} · {proof.period}</small></td><td><div className="readiness-cell"><b>{proof.completeness}%</b><i><span style={{ width: `${proof.completeness}%` }} /></i></div></td><td>{proof.authorization.length ? proof.authorization.map((item) => <span className="tag" key={item}>{item}</span>) : <span className="danger-text"><ShieldOff />无有效授权</span>}</td><td>{proof.missing_fields.length ? proof.missing_fields.join("、") : <span className="success-text"><span>✓</span> 完整</span>}</td><td>{proof.referenced_by.length ? <span><Link2 /> {proof.referenced_by.join("、")}</span> : "—"}</td><td>{proof.expires_at}<small>{new Date(proof.expires_at) < new Date("2026-10-01") && <span className="warning-text"><CalendarClock />即将到期</span>}</small></td><td><StatusBadge status={proof.status} /></td></tr>)}</tbody></table></div>
    <div className="mobile-card-list">{proofs.map((proof) => <article className={`mobile-card ${proof.status === "revoked" ? "card-blocked" : ""}`} key={proof.id}><div className="mobile-card-head"><StatusBadge status={proof.status} /><strong>{proof.completeness}%</strong></div><h2>{proof.title}</h2><p>{proof.redacted_quote}</p><dl><div><dt>授权</dt><dd>{proof.authorization.join(" / ") || "无"}</dd></div><div><dt>缺失</dt><dd>{proof.missing_fields.join("、") || "无"}</dd></div><div><dt>引用</dt><dd>{proof.referenced_by.join("、") || "未引用"}</dd></div><div><dt>到期</dt><dd>{proof.expires_at}</dd></div></dl></article>)}</div>
  </>;
}
