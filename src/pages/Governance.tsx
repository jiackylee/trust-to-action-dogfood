import { useState, type FormEvent } from "react";
import { Activity, AlertTriangle, CheckCircle2, Database, Eye, EyeOff, FileClock, KeyRound, RefreshCw, ShieldCheck, Trash2 } from "lucide-react";
import { InlineAlert, LoadingState, Modal, SectionHeader, StatusBadge } from "../components/UI";
import { aiClient } from "../data/ai-client";
import { useAppStore } from "../store/AppStore";

const SOURCE_LABELS = {
  environment: "服务端环境变量",
  runtime: "本次 BFF 会话",
  none: "未配置",
} as const;

export function Governance() {
  const { state, loading, health, notify, refreshHealth, explainError } = useAppStore();
  const [configOpen, setConfigOpen] = useState(false);
  const [clearOpen, setClearOpen] = useState(false);
  const [apiKey, setApiKey] = useState("");
  const [model, setModel] = useState("gpt-5.6");
  const [showKey, setShowKey] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [configError, setConfigError] = useState<{ code: string; message: string } | null>(null);
  const [clearError, setClearError] = useState<{ code: string; message: string } | null>(null);

  if (loading || !state) return <LoadingState />;

  function openConfiguration() {
    setModel(health?.model && health.model !== "不可用" ? health.model : "gpt-5.6");
    setConfigError(null);
    setConfigOpen(true);
  }

  function closeConfiguration() {
    if (submitting) return;
    setConfigOpen(false);
    setApiKey("");
    setShowKey(false);
    setConfigError(null);
  }

  async function submitConfiguration(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting(true);
    setConfigError(null);
    try {
      const configuration = await aiClient.configure(apiKey, model);
      await refreshHealth();
      setApiKey("");
      setShowKey(false);
      setConfigOpen(false);
      notify({ title: "AI 已配置", detail: `${configuration.model} 已通过验证并仅在当前 BFF 会话内启用。`, tone: "success" });
    } catch (error) {
      const problem = explainError(error);
      setConfigError({ code: problem.code, message: problem.message });
    } finally {
      setSubmitting(false);
    }
  }

  async function clearRuntimeConfiguration() {
    setClearing(true);
    setClearError(null);
    try {
      const configuration = await aiClient.clearRuntimeConfiguration();
      await refreshHealth();
      setClearOpen(false);
      notify({
        title: "会话密钥已清除",
        detail: configuration.configured ? "已恢复服务端环境变量配置。" : "AI 生成功能现已阻断。",
        tone: "info",
      });
    } catch (error) {
      const problem = explainError(error);
      setClearError({ code: problem.code, message: problem.message });
    } finally {
      setClearing(false);
    }
  }

  return <>
    <SectionHeader eyebrow="治理工作域" title="数据接入与审计" description="当前全部为合成、脱敏数据；接口状态用于验证无权限、延迟和部分失败体验。" actions={<button className="secondary-button" onClick={() => notify({ title: "已发起模拟重试", detail: "游标未变化，未写入任何生产数据。", tone: "info" })}><RefreshCw />重试异常源</button>} />
    <InlineAlert tone="info" title="独立中国区数据面边界">正式版不会复用东京 `leads` 数据库；本地 V2 只写入浏览器的 `trust-to-action-dogfood-v2` 命名空间。</InlineAlert>
    <div className="governance-grid">
      {state.integrations.map((source) => <section className="integration-row" key={source.id}><div className={`integration-icon integration-${source.status}`}><Database /></div><div className="integration-main"><div><h2>{source.name}</h2><StatusBadge status={source.status} /></div><p>{source.description}</p><dl><div><dt>权限范围</dt><dd>{source.scope}</dd></div><div><dt>最近成功</dt><dd>{source.last_success_at ? formatDate(source.last_success_at) : "从未成功"}</dd></div><div><dt>游标状态</dt><dd><code>{source.cursor}</code></dd></div><div><dt>数据时效</dt><dd>{source.freshness}</dd></div></dl>{source.error && <span className="integration-error"><AlertTriangle />{source.error}</span>}</div><button className="icon-button" aria-label={`重试 ${source.name}`} title="模拟重试" onClick={() => notify({ title: `${source.name} 已加入重试队列`, detail: "演示环境不会请求真实企微接口。", tone: "info" })}><RefreshCw /></button></section>)}
    </div>
    <div className="governance-lower">
      <section className="panel ai-config-panel">
        <div className="panel-heading"><div><span className="eyebrow">AI BFF</span><h2>本地模型配置</h2></div>{health?.ai_configured ? <CheckCircle2 className="success-text" /> : <KeyRound className="warning-text" />}</div>
        <div className={`ai-config-status ${health?.ai_configured ? "configured" : "unconfigured"}`}>
          <span className="config-mark">{health?.ai_configured ? <CheckCircle2 /> : <KeyRound />}</span>
          <span><strong>{health?.ai_configured ? "AI 已就绪" : "等待 API Key"}</strong><small>{health?.ok ? "本地 BFF 正常运行" : "本地 BFF 当前不可用"}</small></span>
        </div>
        <dl className="key-values">
          <div><dt>模型</dt><dd><code>{health?.model ?? "检查中"}</code></dd></div>
          <div><dt>配置来源</dt><dd>{health ? SOURCE_LABELS[health.config_source] : "检查中"}</dd></div>
          <div><dt>配置时间</dt><dd>{health?.configured_at ? formatDate(health.configured_at) : "—"}</dd></div>
          <div><dt>敏感日志</dt><dd>不记录密钥、完整提示词、客户片段或模型正文</dd></div>
        </dl>
        <div className="ai-config-actions">
          <button className="primary-button" onClick={openConfiguration}><KeyRound />{health?.ai_configured ? "重新配置" : "配置 API Key"}</button>
          {health?.config_source === "runtime" && <button className="secondary-button" onClick={() => { setClearError(null); setClearOpen(true); }}><Trash2 />清除会话密钥</button>}
        </div>
        <p className="config-footnote">页面提交的密钥只保存在本机 BFF 进程内存中，BFF 重启后自动清除。长期配置仍使用本地 <code>.env</code>。</p>
      </section>
      <section className="panel audit-panel"><div className="panel-heading"><div><span className="eyebrow">最近事件</span><h2>审计日志</h2></div><ShieldCheck /></div><div className="audit-list">{state.audits.slice(0, 8).map((event) => <div key={event.id}><span className={`audit-source source-${event.source}`}>{event.source === "ai" ? <Activity /> : event.source === "system" ? <FileClock /> : <ShieldCheck />}</span><span><strong>{event.action}</strong><small>{event.actor} · {formatDate(event.at)}</small><p>{event.detail}</p></span></div>)}</div></section>
    </div>

    <Modal
      open={configOpen}
      title={health?.ai_configured ? "重新配置本地 AI" : "配置本地 AI"}
      onClose={closeConfiguration}
      actions={<><button className="secondary-button" type="button" onClick={closeConfiguration} disabled={submitting}>取消</button><button className="primary-button" type="submit" form="ai-config-form" disabled={submitting || apiKey.trim().length < 20 || !model.trim()}>{submitting ? "正在验证…" : "验证并启用"}</button></>}
    >
      <form id="ai-config-form" className="ai-config-form" onSubmit={(event) => void submitConfiguration(event)}>
        <label htmlFor="openai-api-key"><span>OpenAI API Key</span></label>
        <div className="secret-input">
          <input id="openai-api-key" data-autofocus type={showKey ? "text" : "password"} autoComplete="off" spellCheck={false} value={apiKey} onChange={(event) => setApiKey(event.target.value)} placeholder="输入本地 API Key" minLength={20} maxLength={512} required aria-describedby="api-key-safety" />
          <button className="icon-button" type="button" onClick={() => setShowKey((value) => !value)} aria-label={showKey ? "隐藏 API Key" : "显示 API Key"} title={showKey ? "隐藏 API Key" : "显示 API Key"}>{showKey ? <EyeOff /> : <Eye />}</button>
        </div>
        <label htmlFor="openai-model"><span>模型</span><input id="openai-model" type="text" value={model} onChange={(event) => setModel(event.target.value)} pattern="[a-zA-Z0-9._-]+" maxLength={80} required /></label>
        {configError && <InlineAlert tone="danger" title={configError.code}>{configError.message} 密钥和模型输入已保留，可直接修正后重试。</InlineAlert>}
        <ul className="config-safety-list" id="api-key-safety">
          <li>仅提交至 <code>127.0.0.1</code> 上的本地 BFF。</li>
          <li>仅保存在服务进程内存，不写入浏览器存储、审计日志或响应。</li>
          <li>新配置验证成功前，现有可用配置不会被替换。</li>
          <li>BFF 重启会清除页面配置的会话密钥。</li>
        </ul>
      </form>
    </Modal>

    <Modal
      open={clearOpen}
      title="清除会话密钥"
      onClose={() => !clearing && setClearOpen(false)}
      actions={<><button className="secondary-button" type="button" onClick={() => setClearOpen(false)} disabled={clearing}>取消</button><button className="danger-button" type="button" onClick={() => void clearRuntimeConfiguration()} disabled={clearing}>{clearing ? "正在清除…" : "确认清除"}</button></>}
    >
      <p>清除后，当前 BFF 会话中的 API Key 会立即从内存移除。若未配置 <code>.env</code>，所有 AI 生成将被阻断。</p>
      {clearError && <InlineAlert tone="danger" title={clearError.code}>{clearError.message}</InlineAlert>}
    </Modal>
  </>;
}

function formatDate(value: string) { return new Intl.DateTimeFormat("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(value)); }
