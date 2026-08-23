import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { aiClient, AiClientError, type AiHealth } from "../data/ai-client";
import { createDataClient } from "../data/client";
import type { AiMeta, CustomerEvaluation, WeeklyStrategy } from "../domain/schemas";
import type { ApiProblem, DomainState, Draft, Role } from "../domain/types";

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
  saveDraft(draft: Draft, expectedRevision: number): Promise<void>;
  saveWeeklyStrategy(strategy: WeeklyStrategy, generatedBy: string): Promise<void>;
  applyCustomerEvaluation(customerId: string, evaluation: CustomerEvaluation, meta: AiMeta, expectedRevision: number): Promise<void>;
  decideApproval(id: string, decision: "approved" | "returned", reason: string, expectedRevision: number): Promise<void>;
  recordTaskOutcome(id: string, outcome: string, expectedRevision: number): Promise<void>;
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
      setHealth({ ok: false, ai_configured: false, model: "不可用", config_source: "none", configured_at: null });
    }
  }, []);

  useEffect(() => {
    void reload();
    void refreshHealth();
  }, [reload, refreshHealth]);

  async function update(operation: () => Promise<DomainState>) {
    const next = await operation();
    setState(next);
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
      await update(() => dataClient.saveDraft(draft, expectedRevision));
    },
    async saveWeeklyStrategy(strategy, generatedBy) {
      await update(() => dataClient.saveWeeklyPlan(strategy, generatedBy));
    },
    async applyCustomerEvaluation(customerId, evaluation, meta, expectedRevision) {
      await update(() => dataClient.applyCustomerEvaluation(customerId, evaluation, meta, expectedRevision));
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
