import { useState, type FormEvent } from "react";
import { Activity, AlertTriangle, CheckCircle2, Cloud, Database, Eye, EyeOff, FileClock, FlaskConical, KeyRound, LockKeyhole, Plus, RefreshCw, RotateCcw, Server, ShieldCheck, Trash2, Zap } from "lucide-react";
import { InlineAlert, LoadingState, Modal, SectionHeader, StatusBadge } from "../components/UI";
import { aiClient } from "../data/ai-client";
import type { AiEndpointScope, AiProtocol, AiProviderId, ModelProfileVersion } from "../domain/types";
import { useAppStore } from "../store/AppStore";
import { can } from "../domain/permissions";

const SOURCE_LABELS = { environment: "服务端环境引用", runtime: "本次 BFF 内存", none: "未配置" } as const;
const PROVIDER_LABELS: Record<AiProviderId, string> = { openai: "OpenAI", deepseek: "DeepSeek", anthropic: "Anthropic", qwen: "Qwen", custom: "企业私有端点" };
const PROTOCOL_LABELS: Record<AiProtocol, string> = { openai_responses: "Responses", openai_chat: "Chat JSON", anthropic_messages: "Messages" };
const STATUS_LABELS: Record<ModelProfileVersion["status"], string> = { draft: "待验证", connection_verified: "连接已验证", trial_ready: "试用可激活", enterprise_ready: "企业就绪", active: "当前激活", archived: "已归档", credential_missing: "凭据缺失" };
const STATUS_TONES: Record<ModelProfileVersion["status"], string> = { draft: "neutral", connection_verified: "info", trial_ready: "warning", enterprise_ready: "success", active: "success", archived: "neutral", credential_missing: "danger" };

const PRESETS: Record<AiProviderId, { endpoint: string; protocol: AiProtocol; scope: AiEndpointScope; region: string; auth: "bearer" | "x-api-key" | "none"; model: string; fallback: string; credentialRef: string }> = {
  openai: { endpoint: "https://api.openai.com/v1", protocol: "openai_responses", scope: "public_cloud", region: "global", auth: "bearer", model: "gpt-5.6", fallback: "gpt-5.6-terra", credentialRef: "OPENAI_API_KEY" },
  deepseek: { endpoint: "https://api.deepseek.com", protocol: "openai_responses", scope: "public_cloud", region: "global", auth: "bearer", model: "deepseek-chat", fallback: "deepseek-reasoner", credentialRef: "DEEPSEEK_API_KEY" },
  anthropic: { endpoint: "https://api.anthropic.com", protocol: "anthropic_messages", scope: "public_cloud", region: "global", auth: "x-api-key", model: "claude-sonnet-4-5-20250929", fallback: "", credentialRef: "ANTHROPIC_API_KEY" },
  qwen: { endpoint: "https://dashscope.aliyuncs.com/compatible-mode/v1", protocol: "openai_responses", scope: "public_cloud", region: "cn-beijing", auth: "bearer", model: "qwen3.8-max", fallback: "qwen3.7-plus", credentialRef: "DASHSCOPE_API_KEY" },
  custom: { endpoint: "http://127.0.0.1:8000/v1", protocol: "openai_chat", scope: "private", region: "enterprise-local", auth: "none", model: "enterprise-marketing-32b", fallback: "enterprise-marketing-14b", credentialRef: "" },
};

export function Governance() {
  const { state, loading, health, notify, reload, refreshHealth, explainError } = useAppStore();
  const [createOpen, setCreateOpen] = useState(false);
  const [keyProfile, setKeyProfile] = useState<ModelProfileVersion | null>(null);
  const [activationProfile, setActivationProfile] = useState<ModelProfileVersion | null>(null);
  const [holdoutProfile, setHoldoutProfile] = useState<ModelProfileVersion | null>(null);
  const [apiKey, setApiKey] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<{ code: string; message: string } | null>(null);
  const [egressConfirmed, setEgressConfirmed] = useState(false);
  const [provider, setProvider] = useState<AiProviderId>("deepseek");
  const [connectionName, setConnectionName] = useState("DeepSeek 官方云");
  const [profileName, setProfileName] = useState("DeepSeek 营销主模型");
  const [endpoint, setEndpoint] = useState(PRESETS.deepseek.endpoint);
  const [protocol, setProtocol] = useState<AiProtocol>(PRESETS.deepseek.protocol);
  const [scope, setScope] = useState<AiEndpointScope>(PRESETS.deepseek.scope);
  const [region, setRegion] = useState(PRESETS.deepseek.region);
  const [authMode, setAuthMode] = useState<"bearer" | "x-api-key" | "none">(PRESETS.deepseek.auth);
  const [credentialRef, setCredentialRef] = useState(PRESETS.deepseek.credentialRef);
  const [primaryModel, setPrimaryModel] = useState(PRESETS.deepseek.model);
  const [fallbackModel, setFallbackModel] = useState(PRESETS.deepseek.fallback);

  if (loading || !state) return <LoadingState />;
  const domainState = state;
  const canConfigure = can(domainState.role, "configure_ai");
  const canActivate = domainState.role === "lead";
  const activeProfile = domainState.model_profiles.find((item) => item.status === "active");
  const activeConnection = domainState.provider_connections.find((item) => item.id === activeProfile?.connection_profile_id);

  function chooseProvider(next: AiProviderId) {
    const preset = PRESETS[next];
    setProvider(next); setConnectionName(`${PROVIDER_LABELS[next]}${next === "custom" ? "" : " 官方云"}`); setProfileName(`${PROVIDER_LABELS[next]} 营销主模型`);
    setEndpoint(preset.endpoint); setProtocol(preset.protocol); setScope(preset.scope); setRegion(preset.region); setAuthMode(preset.auth); setCredentialRef(preset.credentialRef); setPrimaryModel(preset.model); setFallbackModel(preset.fallback);
  }

  async function createProfile(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy("create"); setError(null);
    try {
      const before = new Set(domainState.provider_connections.map((item) => item.id));
      const connectionState = await aiClient.createConnection({ name: connectionName, provider, endpoint_scope: scope, protocol, base_url: endpoint, region, auth_mode: authMode, credential_ref: credentialRef.trim() || null });
      const connection = connectionState.provider_connections.find((item) => !before.has(item.id));
      if (!connection) throw new Error("新连接未返回");
      await aiClient.createModelProfile({ name: profileName, connection_profile_id: connection.id, primary_model: primaryModel, fallback_model: fallbackModel.trim() || null });
      await reload(); setCreateOpen(false); notify({ title: "模型 Profile 已创建", detail: "下一步验证凭据和结构化输出能力。", tone: "success" });
    } catch (cause) { setError(explainError(cause)); } finally { setBusy(null); }
  }

  async function testConnection(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!keyProfile) return;
    const connection = domainState.provider_connections.find((item) => item.id === keyProfile.connection_profile_id);
    if (!connection) return;
    setBusy(`test:${keyProfile.id}`); setError(null);
    try {
      await aiClient.testConnection(connection.id, keyProfile.id, apiKey, connection.revision);
      await Promise.all([reload(), refreshHealth()]); setApiKey(""); setShowKey(false); setKeyProfile(null);
      notify({ title: "连接验证通过", detail: `${PROVIDER_LABELS[keyProfile.provider]} · ${keyProfile.primary_model} 已通过最小 Structured Output 测试。`, tone: "success" });
    } catch (cause) { setError(explainError(cause)); } finally { setBusy(null); }
  }

  async function runSmoke(profile: ModelProfileVersion) {
    setBusy(`smoke:${profile.id}`); setError(null);
    try { await aiClient.runProfileSmoke(profile.id, profile.revision); await reload(); notify({ title: "14 条 Smoke 全部通过", detail: `${profile.name} 现在可进入试用激活。`, tone: "success" }); }
    catch (cause) { setError(explainError(cause)); } finally { setBusy(null); }
  }

  async function activate() {
    if (!activationProfile) return;
    setBusy(`activate:${activationProfile.id}`); setError(null);
    try {
      await aiClient.activateProfile(activationProfile.id, activationProfile.revision, activationProfile.endpoint_scope === "private" || egressConfirmed);
      await Promise.all([reload(), refreshHealth()]); setActivationProfile(null); setEgressConfirmed(false);
      notify({ title: "全局模型已切换", detail: `${PROVIDER_LABELS[activationProfile.provider]} · ${activationProfile.primary_model} 现用于全部七类 AI 任务。`, tone: "success" });
    } catch (cause) { setError(explainError(cause)); } finally { setBusy(null); }
  }

  async function rollback(profile: ModelProfileVersion) {
    setBusy(`rollback:${profile.id}`); setError(null);
    try { await aiClient.rollbackProfile(profile.id); await Promise.all([reload(), refreshHealth()]); notify({ title: "模型 Profile 已回滚", detail: "已恢复上一全局模型，历史候选保持原版本信息。", tone: "warning" }); }
    catch (cause) { setError(explainError(cause)); } finally { setBusy(null); }
  }

  async function clearSecret(connectionId: string) {
    setBusy(`clear:${connectionId}`); setError(null);
    try { await aiClient.clearConnectionSecret(connectionId); await Promise.all([reload(), refreshHealth()]); notify({ title: "会话凭据已清除", detail: "密钥已从 BFF 内存移除。", tone: "info" }); }
    catch (cause) { setError(explainError(cause)); } finally { setBusy(null); }
  }

  async function runHoldout() {
    if (!holdoutProfile) return;
    setBusy(`holdout:${holdoutProfile.id}`); setError(null);
    try { await aiClient.runProfileHoldout(holdoutProfile.id); await reload(); setHoldoutProfile(null); notify({ title: "完整 Holdout 已启动", detail: "88 条纯合成案例按最多 2 并发运行，可在 AI 质量中心查看进度。", tone: "success" }); }
    catch (cause) { setError(explainError(cause)); } finally { setBusy(null); }
  }

  return <>
    <SectionHeader eyebrow="治理工作域" title="数据接入与模型治理" description="企业统一选择一个全局模型；知识、证据、审批与合规门禁不随供应商切换。" actions={canConfigure ? <button className="primary-button" onClick={() => { setError(null); setCreateOpen(true); }}><Plus />新增模型 Profile</button> : undefined} />
    {error && <InlineAlert tone="danger" title="操作未完成">{error.message}<details className="technical-details"><summary>技术详情</summary><code>{error.code}</code></details></InlineAlert>}
    {health?.session_warning && <InlineAlert tone="warning" title="开发会话密钥">{health.session_warning}</InlineAlert>}
    {activeProfile?.status === "active" && !activeProfile.holdout_run_id && <InlineAlert tone="warning" title="当前为试用级模型">已通过 14 条兼容性 Smoke，但尚未通过完整 88 条 Holdout。确定性门禁继续生效。</InlineAlert>}

    <section className="panel model-governance-panel">
      <div className="panel-heading"><div><span className="eyebrow">全局 AI Profile</span><h2>{activeProfile ? `${PROVIDER_LABELS[activeProfile.provider]} · ${activeProfile.primary_model}` : "尚未激活"}</h2></div>{health?.ai_configured ? <CheckCircle2 className="success-text" /> : <KeyRound className="warning-text" />}</div>
      <div className={`active-model-strip ${health?.ai_configured ? "configured" : "blocked"}`}>
        <span className="active-model-icon">{activeProfile?.endpoint_scope === "private" ? <Server /> : <Cloud />}</span>
        <div><strong>{health?.ai_configured ? "七类 AI 任务已就绪" : "当前 Profile 缺少可用凭据"}</strong><small>{activeProfile?.fallback_model ? `失败时仅在 ${PROVIDER_LABELS[activeProfile.provider]} 内回退至 ${activeProfile.fallback_model}` : "未配置备用模型，主模型失败后直接阻断"}</small></div>
        <dl><div><dt>协议</dt><dd>{health ? PROTOCOL_LABELS[health.protocol] : "检查中"}</dd></div><div><dt>数据边界</dt><dd>{activeProfile?.endpoint_scope === "private" ? "企业私有" : activeConnection?.region ?? "公有云"}</dd></div><div><dt>凭据</dt><dd>{health ? SOURCE_LABELS[health.config_source] : "检查中"}</dd></div></dl>
      </div>

      {state.role === "sales" ? <InlineAlert tone="info" title="全局模型由负责人治理">销售可查看候选使用的供应商和模型，但端点、凭据引用及评测治理仅对运营与负责人开放。</InlineAlert> : <div className="model-profile-list" role="table" aria-label="模型 Profile 列表">
        <div className="model-profile-head" role="row"><span>供应商 / Profile</span><span>主模型与备用</span><span>能力与凭据</span><span>就绪级别</span><span>操作</span></div>
        {state.model_profiles.map((profile) => {
          const connection = state.provider_connections.find((item) => item.id === profile.connection_profile_id);
          if (!connection) return null;
          const needsCredential = connection.auth_mode !== "none" && !connection.credential_available;
          return <div className={`model-profile-row ${profile.status === "active" ? "is-active" : ""}`} role="row" key={profile.id}>
            <span className="model-provider-cell"><span className="provider-mark">{profile.endpoint_scope === "private" ? <Server /> : <Cloud />}</span><span><strong>{PROVIDER_LABELS[profile.provider]}</strong><small>{profile.name}</small><code>{PROTOCOL_LABELS[profile.protocol]}</code></span></span>
            <span><strong>{profile.primary_model}</strong><small>{profile.fallback_model ? `备用：${profile.fallback_model}` : "无备用模型"}</small></span>
            <span><strong>{connection.capabilities.structured_output ? "结构化输出已验证" : "等待能力验证"}</strong><small>{connection.auth_mode === "none" ? "无需凭据" : connection.credential_available ? SOURCE_LABELS[connection.credential_source] : "凭据缺失"}</small></span>
            <span><span className={`profile-status status-${STATUS_TONES[profile.status]}`}>{STATUS_LABELS[profile.status]}</span><small>{profile.smoke_case_count ? `Smoke ${profile.smoke_case_count}/14` : "尚未运行 Smoke"}</small></span>
            <span className="profile-actions">
              <button className="icon-button" aria-label={`验证 ${profile.name}`} title="验证连接" disabled={!canConfigure || busy !== null} onClick={() => { setError(null); setApiKey(""); setKeyProfile(profile); }}><KeyRound /></button>
              <button className="icon-button" aria-label={`运行 ${profile.name} Smoke`} title="运行 14 条 Smoke" disabled={!canConfigure || needsCredential || !connection.capabilities.structured_output || busy !== null} onClick={() => void runSmoke(profile)}><FlaskConical /></button>
              {profile.status !== "active" && <button className="icon-button" aria-label={`激活 ${profile.name}`} title="激活为全局模型" disabled={!canActivate || !["trial_ready", "enterprise_ready"].includes(profile.status) || needsCredential || busy !== null} onClick={() => { setError(null); setEgressConfirmed(false); setActivationProfile(profile); }}><Zap /></button>}
              {profile.status === "active" && <button className="icon-button" aria-label={`评测 ${profile.name}`} title="运行完整 Holdout" disabled={!canActivate || busy !== null} onClick={() => setHoldoutProfile(profile)}><ShieldCheck /></button>}
              {profile.status === "active" && profile.previous_profile_id && <button className="icon-button" aria-label={`回滚 ${profile.name}`} title="回滚上一 Profile" disabled={!canActivate || busy !== null} onClick={() => void rollback(profile)}><RotateCcw /></button>}
              {connection.credential_source === "runtime" && <button className="icon-button danger-icon" aria-label={`清除 ${profile.name} 会话凭据`} title="清除会话凭据" disabled={!canConfigure || busy !== null} onClick={() => void clearSecret(connection.id)}><Trash2 /></button>}
            </span>
          </div>;
        })}
      </div>}
      <p className="config-footnote"><LockKeyhole />SQLite 只保存非密钥 Profile。API Key 仅来自环境引用或本次 BFF 内存，服务重启后运行时密钥自动清除。</p>
    </section>

    <div className="governance-grid">
      {state.integrations.map((source) => <section className="integration-row" key={source.id}><div className={`integration-icon integration-${source.status}`}><Database /></div><div className="integration-main"><div><h2>{source.name}</h2><StatusBadge status={source.status} /></div><p>{source.description}</p><dl><div><dt>权限范围</dt><dd>{source.scope}</dd></div><div><dt>最近成功</dt><dd>{source.last_success_at ? formatDate(source.last_success_at) : "从未成功"}</dd></div><div><dt>游标状态</dt><dd><code>{source.cursor}</code></dd></div><div><dt>数据时效</dt><dd>{source.freshness}</dd></div></dl>{source.error && <span className="integration-error"><AlertTriangle />{source.error}</span>}</div><button className="icon-button" aria-label={`重试 ${source.name}`} title="模拟重试" onClick={() => notify({ title: `${source.name} 已加入重试队列`, detail: "演示环境不会请求真实企微接口。", tone: "info" })}><RefreshCw /></button></section>)}
    </div>
    <section className="panel audit-panel"><div className="panel-heading"><div><span className="eyebrow">最近事件</span><h2>模型与数据审计</h2></div><ShieldCheck /></div><div className="audit-list">{state.audits.slice(0, 8).map((event) => <div key={event.id}><span className={`audit-source source-${event.source}`}>{event.source === "ai" ? <Activity /> : event.source === "system" ? <FileClock /> : <ShieldCheck />}</span><span><strong>{event.action}</strong><small>{event.actor} · {formatDate(event.at)}</small><p>{event.detail}</p></span></div>)}</div></section>

    <Modal open={createOpen} title="新增模型连接与 Profile" onClose={() => busy !== "create" && setCreateOpen(false)} actions={<><button className="secondary-button" onClick={() => setCreateOpen(false)} disabled={busy === "create"}>取消</button><button className="primary-button" type="submit" form="model-profile-form" disabled={busy === "create"}>{busy === "create" ? "正在创建…" : "创建 Profile"}</button></>}>
      <form id="model-profile-form" className="ai-config-form profile-create-form" onSubmit={(event) => void createProfile(event)}>
        <label><span>供应商</span><select data-autofocus value={provider} onChange={(event) => chooseProvider(event.target.value as AiProviderId)}>{Object.entries(PROVIDER_LABELS).map(([id, label]) => <option key={id} value={id}>{label}</option>)}</select></label>
        <label><span>连接名称</span><input value={connectionName} onChange={(event) => setConnectionName(event.target.value)} required maxLength={80} /></label>
        <label><span>Profile 名称</span><input value={profileName} onChange={(event) => setProfileName(event.target.value)} required maxLength={80} /></label>
        <label><span>API 协议</span><select value={protocol} onChange={(event) => setProtocol(event.target.value as AiProtocol)} disabled={provider === "openai" || provider === "deepseek" || provider === "anthropic"}><option value="openai_responses">OpenAI Responses</option><option value="openai_chat">Chat Completions JSON</option><option value="anthropic_messages">Anthropic Messages</option></select></label>
        <label className="profile-field-wide"><span>端点</span><input value={endpoint} onChange={(event) => setEndpoint(event.target.value)} type="url" required maxLength={300} /></label>
        <label><span>区域</span><input value={region} onChange={(event) => setRegion(event.target.value)} required maxLength={80} /></label>
        <label><span>认证方式</span><select value={authMode} onChange={(event) => setAuthMode(event.target.value as typeof authMode)}><option value="bearer">Bearer</option><option value="x-api-key">x-api-key</option><option value="none">无认证</option></select></label>
        <label><span>环境变量引用</span><input value={credentialRef} onChange={(event) => setCredentialRef(event.target.value.toUpperCase())} placeholder="DEEPSEEK_API_KEY" pattern="[A-Z][A-Z0-9_]{2,63}" disabled={authMode === "none"} /></label>
        <label><span>主模型 ID</span><input value={primaryModel} onChange={(event) => setPrimaryModel(event.target.value)} required maxLength={120} /></label>
        <label><span>备用模型 ID</span><input value={fallbackModel} onChange={(event) => setFallbackModel(event.target.value)} maxLength={120} placeholder="可选，同供应商" /></label>
        <InlineAlert tone="info" title={scope === "private" ? "企业私有端点" : "公有云数据边界"}>{scope === "private" ? "私有域名需进入服务端 AI_ENDPOINT_ALLOWLIST；仅 loopback 可使用 HTTP。" : "激活前负责人必须确认供应商、端点、区域和发送字段。"}</InlineAlert>
      </form>
    </Modal>

    <Modal open={Boolean(keyProfile)} title="验证模型连接" onClose={() => busy?.startsWith("test:") ? undefined : setKeyProfile(null)} actions={<><button className="secondary-button" onClick={() => setKeyProfile(null)} disabled={busy?.startsWith("test:")}>取消</button><button className="primary-button" type="submit" form="connection-test-form" disabled={Boolean(busy) || (state.provider_connections.find((item) => item.id === keyProfile?.connection_profile_id)?.auth_mode !== "none" && !apiKey.trim() && !state.provider_connections.find((item) => item.id === keyProfile?.connection_profile_id)?.credential_ref)}>{busy?.startsWith("test:") ? "正在验证…" : "验证并保留会话凭据"}</button></>}>
      <form id="connection-test-form" className="ai-config-form" onSubmit={(event) => void testConnection(event)}>
        <dl className="key-values"><div><dt>供应商</dt><dd>{keyProfile ? PROVIDER_LABELS[keyProfile.provider] : "—"}</dd></div><div><dt>模型</dt><dd><code>{keyProfile?.primary_model}</code></dd></div></dl>
        {state.provider_connections.find((item) => item.id === keyProfile?.connection_profile_id)?.auth_mode !== "none" && <><label htmlFor="provider-api-key"><span>API Key</span></label><div className="secret-input"><input id="provider-api-key" data-autofocus type={showKey ? "text" : "password"} autoComplete="off" value={apiKey} onChange={(event) => setApiKey(event.target.value)} placeholder="留空时使用服务端环境变量引用" maxLength={1024} /><button className="icon-button" type="button" onClick={() => setShowKey((value) => !value)} aria-label={showKey ? "隐藏 API Key" : "显示 API Key"}>{showKey ? <EyeOff /> : <Eye />}</button></div></>}
        <ul className="config-safety-list"><li>测试只发送无业务数据的最小 JSON Schema。</li><li>页面录入的密钥只保存在 BFF 内存，响应与日志不包含密钥。</li><li>验证失败不会替换当前全局模型。</li></ul>
      </form>
    </Modal>

    <Modal open={Boolean(activationProfile)} title="激活全局模型 Profile" onClose={() => !busy?.startsWith("activate:") && setActivationProfile(null)} actions={<><button className="secondary-button" onClick={() => setActivationProfile(null)} disabled={busy?.startsWith("activate:")}>取消</button><button className="primary-button" onClick={() => void activate()} disabled={Boolean(busy) || (activationProfile?.endpoint_scope === "public_cloud" && !egressConfirmed)}><Zap />确认激活</button></>}>
      <div className="activation-review"><InlineAlert tone="warning" title="切换影响全部七类 AI 任务">切换会让所有待处理候选立即过期，但不会改写历史结果或反转已采用状态。</InlineAlert><dl><div><dt>供应商</dt><dd>{activationProfile ? PROVIDER_LABELS[activationProfile.provider] : "—"}</dd></div><div><dt>主模型</dt><dd>{activationProfile?.primary_model}</dd></div><div><dt>端点</dt><dd>{state.provider_connections.find((item) => item.id === activationProfile?.connection_profile_id)?.base_url}</dd></div><div><dt>区域</dt><dd>{state.provider_connections.find((item) => item.id === activationProfile?.connection_profile_id)?.region}</dd></div><div><dt>发送字段</dt><dd>任务上下文、脱敏业务证据、知识引用与企业事实</dd></div></dl>{activationProfile?.endpoint_scope === "public_cloud" && <label className="confirmation-check"><input type="checkbox" checked={egressConfirmed} onChange={(event) => setEgressConfirmed(event.target.checked)} /><span>我确认以上数据去向，并批准该公有云 Profile 用于企业试用。</span></label>}</div>
    </Modal>

    <Modal open={Boolean(holdoutProfile)} title="运行完整 88 条 Holdout" onClose={() => !busy?.startsWith("holdout:") && setHoldoutProfile(null)} actions={<><button className="secondary-button" onClick={() => setHoldoutProfile(null)} disabled={busy?.startsWith("holdout:")}>取消</button><button className="primary-button" onClick={() => void runHoldout()} disabled={Boolean(busy)}><FlaskConical />确认 API 用量并启动</button></>}>
      <div className="activation-review"><InlineAlert tone="warning" title="本次会产生真实模型用量">系统使用 88 条纯合成锁定案例，最大并发 2，支持中断续跑和逐案例幂等。</InlineAlert><dl><div><dt>Profile</dt><dd>{holdoutProfile?.name}</dd></div><div><dt>模型</dt><dd>{holdoutProfile?.primary_model}</dd></div><div><dt>数据</dt><dd>纯合成 Holdout，不含真实客户或会话</dd></div></dl></div>
    </Modal>
  </>;
}

function formatDate(value: string) { return new Intl.DateTimeFormat("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(value)); }
