import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { aiClient, AiClientError, type AiHealth } from "../data/ai-client";
import { createDataClient } from "../data/client";
import type { AiMeta, CustomerEvaluation, WeeklyRetrospective, WeeklyStrategy } from "../domain/schemas";
import type { ApiProblem, ContentBrief, ContentOutcome, ConversationInsight, DomainState, Draft, EvaluationDecisionKind, EvaluationReasonCode, EvaluationReviewOutcome, NbaDecision, Proof, ProofCore, Role } from "../domain/types";

const dataClient = createDataClient();

export type ToastTone = "success" | "danger" | "warning" | "info";
export interface ToastMessage {
  id: string;
  title: string;
  detail?: string;
  tone: ToastTone;
  actionLabel?: string;
  onAction?: () => void | Promise<void>;
}

interface StoreValue {
  state: DomainState | null;
  loading: boolean;
  health: AiHealth | null;
  toasts: ToastMessage[];
  dismissToast(id: string): void;
  notify(message: Omit<ToastMessage, "id">): void;
  setRole(role: Role): Promise<void>;
  saveDraft(draft: Draft, expectedRevision: number): Promise<Draft>;
  submitDraftApproval(id: string, expectedRevision: number): Promise<void>;
  saveProof(proof: Proof, expectedRevision: number): Promise<void>;
  createProof(proof: Omit<ProofCore, "completeness" | "missing_fields" | "referenced_by">): Promise<void>;
  saveWeeklyStrategy(strategy: WeeklyStrategy, generatedBy: string): Promise<void>;
  decideEvaluationCandidate(customerId: string, candidateId: string, decision: EvaluationDecisionKind, evaluation: CustomerEvaluation | null, reasonCode: EvaluationReasonCode | null, reasonNote: string, expectedRevision: number): Promise<void>;
  recordEvaluationReview(decisionId: string, outcome: EvaluationReviewOutcome, reason: string, expectedRevision: number): Promise<void>;
  runGoldenEvaluation(promptVersionId: string, routerVersionId: string, split: "development" | "holdout"): Promise<void>;
  createPromptVersion(name: string, description: string): Promise<void>;
  createRouterVersion(name: string, description: string, confidenceThreshold: number): Promise<void>;
  promoteAiVersion(kind: "prompt" | "router", versionId: string, expectedRevision: number): Promise<void>;
  rollbackAiVersion(kind: "prompt" | "router", versionId: string, expectedRevision: number): Promise<void>;
  decideNba(customerId: string, decision: NbaDecision["decision"], action: string, reason: string, expectedRevision: number): Promise<void>;
  addCustomerNote(customerId: string, text: string, expectedRevision: number): Promise<void>;
  decideApproval(id: string, decision: "approved" | "returned", reason: string, expectedRevision: number): Promise<void>;
  recordTaskOutcome(id: string, outcome: string, expectedRevision: number): Promise<void>;
  decideInsight(id: string, decision: "accepted" | "dismissed", reason: string, edits: Partial<Pick<ConversationInsight, "title" | "summary" | "customer_segment">>, expectedRevision: number): Promise<void>;
  saveBrief(brief: ContentBrief, expectedRevision: number): Promise<void>;
  recordRawAccess(conversationId: string, purpose: string): Promise<void>;
  markPublished(draftId: string, expectedRevision: number): Promise<void>;
  syncPublicationResults(id: string, expectedRevision: number): Promise<void>;
  recordContentOutcome(publicationId: string, type: ContentOutcome["type"], detail: string, customerId: string | null): Promise<void>;
  saveWeeklyRetrospective(retrospective: WeeklyRetrospective, meta: AiMeta | null, generatedBy: string, expectedRevision: number): Promise<void>;
  resetDemo(): Promise<void>;
  reload(): Promise<void>;
  refreshHealth(): Promise<void>;
  explainError(error: unknown): { code: string; message: string; retryable: boolean; latest?: unknown };
}

const StoreContext = createContext<StoreValue | null>(null);

function errorDetails(error: unknown) {
  if (error instanceof AiClientError) return { code: error.code, message: error.message, retryable: error.retryable };
  const problem = error as Partial<ApiProblem> | null;
  return {
    code: problem?.code ?? "UNKNOWN_ERROR",
    message: problem?.message ?? "操作未完成，请保留当前输入后重试。",
    retryable: problem?.retryable ?? true,
    latest: problem?.latest,
  };
}

export function AppStore({ children }: { children: ReactNode }) {
  const [state, setState] = useState<DomainState | null>(null);
  const [loading, setLoading] = useState(true);
  const [health, setHealth] = useState<StoreValue["health"]>(null);
  const [toasts, setToasts] = useState<ToastMessage[]>([]);

  const dismissToast = useCallback((id: string) => setToasts((items) => items.filter((item) => item.id !== id)), []);
  const notify = useCallback((message: Omit<ToastMessage, "id">) => {
    const id = crypto.randomUUID();
    setToasts((items) => [...items.slice(-2), { ...message, id }]);
    window.setTimeout(() => dismissToast(id), message.actionLabel ? 7000 : 4500);
  }, [dismissToast]);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const next = await dataClient.getState();
      setState(next);
    } finally {
      setLoading(false);
    }
  }, []);

  const refreshHealth = useCallback(async () => {
    try {
      setHealth(await aiClient.health());
    } catch {
      setHealth({ ok: false, ai_configured: false, model: "不可用", fast_model: "不可用", fast_model_available: false, data_mode: "unavailable", session_warning: null, config_source: "none", configured_at: null });
    }
  }, []);

  useEffect(() => {
    void reload();
    void refreshHealth();
  }, [reload, refreshHealth]);

  async function update(operation: () => Promise<DomainState>) {
    const next = await operation();
    setState(next);
    return next;
  }

  const value = useMemo<StoreValue>(() => ({
    state,
    loading,
    health,
    toasts,
    dismissToast,
    notify,
    explainError: errorDetails,
    reload,
    refreshHealth,
    async setRole(role) {
      await update(() => dataClient.setRole(role));
    },
    async saveDraft(draft, expectedRevision) {
      const next = await update(() => dataClient.saveDraft(draft, expectedRevision));
      return next.drafts.find((item) => item.id === draft.id)!;
    },
    async submitDraftApproval(id, expectedRevision) {
      await update(() => dataClient.submitDraftApproval(id, expectedRevision));
      notify({ title: "已提交负责人审批", detail: "审批已绑定当前内容版本，实质修改后需重新提交。", tone: "success" });
    },
    async saveProof(proof, expectedRevision) {
      await update(() => dataClient.saveProof(proof, expectedRevision));
    },
    async createProof(proof) {
      await update(() => dataClient.createProof(proof));
    },
    async saveWeeklyStrategy(strategy, generatedBy) {
      await update(() => dataClient.saveWeeklyPlan(strategy, generatedBy));
    },
    async decideEvaluationCandidate(customerId, candidateId, decision, evaluation, reasonCode, reasonNote, expectedRevision) {
      await update(() => dataClient.decideEvaluationCandidate(customerId, candidateId, decision, evaluation, reasonCode, reasonNote, expectedRevision));
      notify({ title: decision === "accepted" ? "AI 首稿已原样采用" : decision === "modified" ? "修改后已采用" : "AI 首稿已拒绝", detail: decision === "rejected" ? "原因已进入质量反馈。" : "客户状态与 NBA 已通过确定性门禁写入。", tone: "success" });
    },
    async recordEvaluationReview(decisionId, outcome, reason, expectedRevision) {
      await update(() => dataClient.recordEvaluationReview(decisionId, outcome, reason, expectedRevision));
      notify({ title: "7 天质量复查已记录", detail: outcome === "quality_reversal" ? "本次计为质量撤销。" : outcome === "new_evidence" ? "本次变化归因于新增证据。" : "首稿保持有效。", tone: outcome === "quality_reversal" ? "warning" : "success" });
    },
    async runGoldenEvaluation(promptVersionId, routerVersionId, split) {
      await update(() => dataClient.runGoldenEvaluation(promptVersionId, routerVersionId, split));
      notify({ title: "黄金集评测已完成", detail: `${split === "holdout" ? "锁定 Holdout" : "调优集"}结果已写入质量中心。`, tone: "success" });
    },
    async createPromptVersion(name, description) {
      await update(() => dataClient.createPromptVersion(name, description));
      notify({ title: "Prompt 候选已创建", detail: "运行调优集与锁定 Holdout 后，负责人才能发布。", tone: "success" });
    },
    async createRouterVersion(name, description, confidenceThreshold) {
      await update(() => dataClient.createRouterVersion(name, description, confidenceThreshold));
      notify({ title: "路由候选已创建", detail: `Terra 置信度低于 ${confidenceThreshold} 时升级至主模型。`, tone: "success" });
    },
    async promoteAiVersion(kind, versionId, expectedRevision) {
      await update(() => dataClient.promoteAiVersion(kind, versionId, expectedRevision));
      notify({ title: kind === "prompt" ? "Prompt 版本已发布" : "路由版本已发布", detail: "上一线上版本已归档，可按审计记录回溯。", tone: "success" });
    },
    async rollbackAiVersion(kind, versionId, expectedRevision) {
      await update(() => dataClient.rollbackAiVersion(kind, versionId, expectedRevision));
      notify({ title: kind === "prompt" ? "Prompt 已回滚" : "路由已回滚", detail: "已恢复上一曾发布版本，现有候选保留原版本信息。", tone: "warning" });
    },
    async decideNba(customerId, decision, action, reason, expectedRevision) {
      await update(() => dataClient.decideNba(customerId, decision, action, reason, expectedRevision));
      notify({ title: decision === "rejected" ? "建议已拒绝" : "销售任务已建立", detail: decision === "modified" ? "已按修改后的动作进入执行队列。" : undefined, tone: "success" });
    },
    async addCustomerNote(customerId, text, expectedRevision) {
      await update(() => dataClient.addCustomerNote(customerId, text, expectedRevision));
      notify({ title: "人工笔记已记录", detail: "已写入客户时间线和审计日志。", tone: "success" });
    },
    async decideApproval(id, decision, reason, expectedRevision) {
      const snapshot = state;
      await update(() => dataClient.decideApproval(id, decision, reason, expectedRevision));
      notify({
        title: decision === "approved" ? "审批已通过" : "内容已退回",
        detail: "7 秒内可撤销本次操作。",
        tone: "success",
        actionLabel: "撤销",
        onAction: snapshot ? async () => { setState(await dataClient.restoreSnapshot(snapshot)); notify({ title: "已撤销", tone: "info" }); } : undefined,
      });
    },
    async recordTaskOutcome(id, outcome, expectedRevision) {
      const snapshot = state;
      await update(() => dataClient.recordTaskOutcome(id, outcome, expectedRevision));
      notify({
        title: "执行结果已回填",
        detail: "7 秒内可撤销本次操作。",
        tone: "success",
        actionLabel: "撤销",
        onAction: snapshot ? async () => { setState(await dataClient.restoreSnapshot(snapshot)); notify({ title: "已撤销", tone: "info" }); } : undefined,
      });
    },
    async decideInsight(id, decision, reason, edits, expectedRevision) {
      await update(() => dataClient.decideInsight(id, decision, reason, edits, expectedRevision));
      notify({ title: decision === "accepted" ? "洞察已接受" : "洞察已忽略", detail: decision === "accepted" ? "现在可以生成或采用内容 Brief。" : "判断原因已进入审计。", tone: "success" });
    },
    async saveBrief(brief, expectedRevision) {
      await update(() => dataClient.saveBrief(brief, expectedRevision));
      notify({ title: "内容 Brief 已采用", detail: "洞察血缘、唯一 CTA 和截止时间已固定。", tone: "success" });
    },
    async recordRawAccess(conversationId, purpose) {
      await update(() => dataClient.recordRawAccess(conversationId, purpose));
    },
    async markPublished(draftId, expectedRevision) {
      const snapshot = state;
      await update(() => dataClient.markPublished(draftId, expectedRevision));
      notify({ title: "已标记人工发布", detail: "系统未调用任何发送接口；7 秒内可撤销。", tone: "success", actionLabel: "撤销", onAction: snapshot ? async () => { setState(await dataClient.restoreSnapshot(snapshot)); } : undefined });
    },
    async syncPublicationResults(id, expectedRevision) {
      await update(() => dataClient.syncPublicationResults(id, expectedRevision));
      notify({ title: "合成互动已同步", detail: "点赞和评论仅作为平台弱信号展示。", tone: "success" });
    },
    async recordContentOutcome(publicationId, type, detail, customerId) {
      await update(() => dataClient.recordContentOutcome(publicationId, type, detail, customerId));
      notify({ title: "业务结果已回填", detail: "已与平台互动分层记录。", tone: "success" });
    },
    async saveWeeklyRetrospective(retrospective, meta, generatedBy, expectedRevision) {
      await update(() => dataClient.saveWeeklyRetrospective(retrospective, meta, generatedBy, expectedRevision));
      notify({ title: "周复盘已更新", detail: "下周主题候选已生成，时间关联不代表因果。", tone: "success" });
    },
    async resetDemo() {
      await update(() => dataClient.reset());
      notify({ title: "演示数据已重置", detail: "角色、筛选和所有修改均恢复为初始状态。", tone: "success" });
    },
  // dataClient is a stable module singleton; state is required for local undo snapshots.
  }), [state, loading, health, toasts, dismissToast, notify, reload, refreshHealth]);

  return <StoreContext.Provider value={value}>{children}</StoreContext.Provider>;
}

export function useAppStore() {
  const value = useContext(StoreContext);
  if (!value) throw new Error("useAppStore must be used within AppStore");
  return value;
}
