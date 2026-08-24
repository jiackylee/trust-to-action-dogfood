import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, BookOpenCheck, Check, Database, GitBranch, History, RefreshCw, RotateCcw, Search, ShieldCheck } from "lucide-react";
import { can } from "../domain/permissions";
import type { KnowledgeReference, MarketingTaskType } from "../domain/types";
import { knowledgeClient, type KnowledgeStatus } from "../data/knowledge-client";
import { EmptyState, InlineAlert, LoadingState, SectionHeader, StatusBadge } from "../components/UI";
import { useAppStore } from "../store/AppStore";

const TASKS: Array<{ value: MarketingTaskType; label: string }> = [
  { value: "weekly_strategy", label: "本周策略" }, { value: "content_brief", label: "内容 Brief" }, { value: "content_draft", label: "内容草稿" }, { value: "customer_nba", label: "客户 NBA" },
];

export function KnowledgeGovernance() {
  const { state, loading, reload, explainError, notify } = useAppStore();
  const [status, setStatus] = useState<KnowledgeStatus | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<{ code: string; message: string } | null>(null);
  const [task, setTask] = useState<MarketingTaskType>("weekly_strategy");
  const [query, setQuery] = useState("企微客户分组 周策略 窄市场 内容实验 授权门禁");
  const [references, setReferences] = useState<KnowledgeReference[]>([]);
  const [route, setRoute] = useState<string[]>([]);
  const [conflicts, setConflicts] = useState<string[]>([]);

  useEffect(() => { void refresh(); }, []);
  async function refresh() {
    try { setStatus(await knowledgeClient.status()); setError(null); }
    catch (cause) { setError(explainError(cause)); }
  }
  async function action(kind: "reindex" | "rollback" | "activate", id?: string) {
    setBusy(`${kind}:${id ?? ""}`); setError(null);
    try {
      const next = kind === "reindex" ? await knowledgeClient.reindex() : kind === "rollback" ? await knowledgeClient.rollback() : await knowledgeClient.activate(id!);
      setStatus(next); await reload();
      notify({ title: kind === "reindex" ? "知识索引已重建" : kind === "rollback" ? "知识版本已回滚" : "知识版本已激活", detail: "待处理候选已按版本绑定重新校验。", tone: kind === "rollback" ? "warning" : "success" });
    } catch (cause) { setError(explainError(cause)); }
    finally { setBusy(null); }
  }
  async function preview() {
    setBusy("preview"); setError(null);
    try { const result = await knowledgeClient.preview(task, query); setReferences(result.references); setRoute(result.skill_route); setConflicts(result.conflicts); await refresh(); }
    catch (cause) { setError(explainError(cause)); }
    finally { setBusy(null); }
  }

  if (loading || !state) return <LoadingState />;
  if (!can(state.role, "preview_knowledge")) return <EmptyState title="知识治理不在当前角色范围" detail="运营可预览检索，负责人可管理索引与版本。" />;
  const active = status?.active_version;
  const facts = state.tenant_fact_versions.find((item) => item.status === "published");
  const brain = state.marketing_brain_versions.find((item) => item.status === "published");
  const healthySources = status?.sources.filter((item) => item.status === "ready").length ?? 0;
  const coverage = status?.sources.length ? Math.round(healthySources / status.sources.length * 100) : 0;

  return <>
    <SectionHeader eyebrow="治理工作域" title="知识治理" description="管理私有知识包的索引、激活版本、检索适用性与企业事实绑定。知识正文只在私有文件中维护。" actions={can(state.role, "manage_knowledge") ? <div className="header-actions"><button className="secondary-button" disabled={Boolean(busy)} onClick={() => void action("rollback")}><RotateCcw />回滚</button><button className="primary-button" disabled={Boolean(busy)} onClick={() => void action("reindex")}><RefreshCw className={busy === "reindex:" ? "spin" : ""} />重新索引</button></div> : undefined} />
    {error && <InlineAlert tone="danger" title={error.code}>{error.message}</InlineAlert>}
    {!status?.configured && <InlineAlert tone="warning" title="KNOWLEDGE_NOT_CONFIGURED">BFF 未挂载可读的 `KNOWLEDGE_PACK_PATH`。四类营销生成均已阻断，不会回退到通用 Prompt。</InlineAlert>}
    <section className="knowledge-health-strip">
      <div><span><Database />当前知识包</span><strong>{active?.name ?? "尚未激活"}</strong><small>{status?.pack_path ?? "等待本地只读挂载"}</small></div>
      <div><span>来源健康</span><strong>{coverage}%</strong><small>{healthySources} 个可用来源</small></div>
      <div><span>索引规模</span><strong>{active?.chunk_count ?? 0}</strong><small>{active?.source_count ?? 0} 个来源 · 中文 trigram</small></div>
      <div><span>待处理</span><strong>{(status?.unresolved_sources.length ?? 0) + (status?.duplicate_sources.length ?? 0)}</strong><small>{status?.unresolved_sources.length ?? 0} 未解析 · {status?.duplicate_sources.length ?? 0} 重复</small></div>
    </section>

    <div className="knowledge-layout">
      <section className="panel retrieval-preview"><div className="panel-heading"><div><span className="eyebrow">运营预览</span><h2>检索与 SKILL 路由</h2></div><Search /></div>
        <div className="retrieval-controls"><label className="field"><span>任务</span><select value={task} onChange={(event) => setTask(event.target.value as MarketingTaskType)}>{TASKS.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}</select></label><label className="field"><span>业务问题</span><input value={query} onChange={(event) => setQuery(event.target.value)} /></label><button className="primary-button" disabled={busy === "preview" || query.trim().length < 3 || !active} onClick={() => void preview()}><Search />检索预览</button></div>
        {route.length > 0 && <div className="skill-route"><span>SKILL 路由</span>{route.map((item, index) => <span key={item}><code>{item}</code>{index < route.length - 1 && <b>→</b>}</span>)}</div>}
        {conflicts.map((item) => <InlineAlert key={item} tone="warning" title="知识冲突">{item}</InlineAlert>)}
        <div className="retrieval-results">{references.map((item) => <article key={item.chunk_id}><span><BookOpenCheck /><b>{item.source_title}</b><small>{item.knowledge_kind} · {item.skill}</small></span><strong>{item.heading_path.join(" / ")}</strong><p>{item.excerpt}</p><code>{item.chunk_id} · score {item.score}</code></article>)}{!references.length && <p className="muted">选择任务并运行预览后显示最多 8 个知识块，每个来源最多 2 个。</p>}</div>
      </section>

      <aside className="knowledge-bindings">
        <section className="panel"><div className="panel-heading"><div><span className="eyebrow">原子版本</span><h2>营销脑绑定</h2></div><GitBranch /></div>{brain ? <dl className="binding-list"><div><dt>营销脑</dt><dd>{brain.name}</dd></div><div><dt>知识包</dt><dd>{brain.knowledge_pack_version_id}</dd></div><div><dt>企业事实</dt><dd>{brain.tenant_fact_version_id}</dd></div><div><dt>检索器</dt><dd>{brain.retriever_version}</dd></div><div><dt>策略门禁</dt><dd>{brain.policy_version}</dd></div></dl> : <InlineAlert tone="warning" title="尚未发布">负责人需发布营销脑版本。</InlineAlert>}</section>
        <section className="panel"><div className="panel-heading"><div><span className="eyebrow">已发布事实</span><h2>企业事实层</h2></div><ShieldCheck /></div>{facts?.facts.map((fact) => <article className="fact-row" key={fact.id}><StatusBadge status={fact.status === "published" ? "approved" : "review"} /><span><strong>{fact.title}</strong><p>{fact.statement}</p><small>{fact.type} · {fact.id}</small></span></article>)}</section>
      </aside>
    </div>

    <section className="panel knowledge-source-panel"><div className="panel-heading"><div><span className="eyebrow">来源健康</span><h2>索引来源</h2></div><History /></div><div className="table-wrap desktop-table"><table><thead><tr><th>来源</th><th>SKILL</th><th>知识类型</th><th>状态</th><th>分块</th><th>版本操作</th></tr></thead><tbody>{status?.sources.map((source) => <tr key={source.id}><td><strong>{source.title}</strong><small>{source.relative_path}</small></td><td><code>{source.skill}</code></td><td>{source.knowledge_kind}</td><td><StatusBadge status={source.status === "ready" ? "approved" : source.status === "unresolved" ? "blocked" : "review"} />{source.error && <small className="warning-text">{source.error}</small>}</td><td>{source.chunk_count}</td><td>{source.pack_version_id !== active?.id && can(state.role, "manage_knowledge") ? <button className="secondary-button" disabled={Boolean(busy)} onClick={() => void action("activate", source.pack_version_id)}><Check />激活版本</button> : <span className="muted">{source.pack_version_id === active?.id ? "当前版本" : "只读"}</span>}</td></tr>)}</tbody></table></div><div className="mobile-card-list">{status?.sources.map((source) => <article className="mobile-card" key={source.id}><div className="mobile-card-head"><StatusBadge status={source.status === "ready" ? "approved" : "blocked"} /><strong>{source.chunk_count} 块</strong></div><h2>{source.title}</h2><p>{source.skill}</p><small>{source.knowledge_kind}</small></article>)}</div></section>
  </>;
}
