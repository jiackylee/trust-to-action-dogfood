import { useEffect, useRef, type ReactNode } from "react";
import { AlertCircle, CheckCircle2, Info, LoaderCircle, TriangleAlert, X } from "lucide-react";
import type { EvidenceStrength, StateCode } from "../domain/schemas";
import { STATE_LABELS } from "../domain/schemas";
import { useAppStore, type ToastTone } from "../store/AppStore";

export function StateBadge({ state }: { state: StateCode }) {
  return <span className={`badge state-${state.toLowerCase()}`}><b>{state}</b> {STATE_LABELS[state]}</span>;
}

export function EvidenceBadge({ strength }: { strength: EvidenceStrength }) {
  const labels = { weak: "弱证据", medium: "中证据", strong: "强证据" };
  return <span className={`badge evidence-${strength}`}>{labels[strength]}</span>;
}

export function StatusBadge({ status }: { status: string }) {
  const labels: Record<string, string> = {
    pending: "待处理", ready: "已就绪", review: "待检查", approved: "已批准", returned: "已退回",
    done: "已完成", blocked: "已阻断", executed: "待回填", usable: "可使用", internal_only: "仅内部",
    incomplete: "不完整", revoked: "已撤权", healthy: "正常", delayed: "延迟", partial: "部分失败", unauthorized: "未授权",
  };
  return <span className={`status-dot status-${status}`}>{labels[status] ?? status}</span>;
}

export function SectionHeader({ eyebrow, title, description, actions }: { eyebrow?: string; title: string; description?: string; actions?: ReactNode }) {
  return <div className="section-header">
    <div>{eyebrow && <div className="eyebrow">{eyebrow}</div>}<h1>{title}</h1>{description && <p>{description}</p>}</div>
    {actions && <div className="header-actions">{actions}</div>}
  </div>;
}

export function EmptyState({ title, detail, action }: { title: string; detail: string; action?: ReactNode }) {
  return <div className="empty-state"><Info size={22} /><strong>{title}</strong><p>{detail}</p>{action}</div>;
}

export function LoadingState() {
  return <div className="loading-state" role="status"><LoaderCircle className="spin" />正在读取演示数据…</div>;
}

export function InlineAlert({ tone = "warning", title, children }: { tone?: ToastTone; title: string; children?: ReactNode }) {
  const Icon = tone === "danger" ? AlertCircle : tone === "success" ? CheckCircle2 : tone === "info" ? Info : TriangleAlert;
  return <div className={`inline-alert alert-${tone}`} role={tone === "danger" ? "alert" : "status"} aria-live={tone === "danger" ? "assertive" : "polite"}><Icon size={18} /><div><strong>{title}</strong>{children && <div>{children}</div>}</div></div>;
}

export function Modal({ open, title, children, onClose, actions }: { open: boolean; title: string; children: ReactNode; onClose(): void; actions?: ReactNode }) {
  const dialog = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement as HTMLElement | null;
    const root = dialog.current;
    const focusables = root?.querySelectorAll<HTMLElement>("button, input, textarea, select, [tabindex]:not([tabindex='-1'])");
    (root?.querySelector<HTMLElement>("[data-autofocus]") ?? focusables?.[0])?.focus();
    const handle = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
      if (event.key !== "Tab" || !focusables?.length) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener("keydown", handle);
    return () => { document.removeEventListener("keydown", handle); previous?.focus(); };
  }, [open, onClose]);
  if (!open) return null;
  return <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
    <div className="modal" role="dialog" aria-modal="true" aria-labelledby="modal-title" ref={dialog}>
      <div className="modal-header"><h2 id="modal-title">{title}</h2><button className="icon-button" onClick={onClose} aria-label="关闭对话框" title="关闭"><X /></button></div>
      <div className="modal-body">{children}</div>
      {actions && <div className="modal-actions">{actions}</div>}
    </div>
  </div>;
}

export function ToastRegion() {
  const { toasts, dismissToast } = useAppStore();
  const icons = { success: CheckCircle2, danger: AlertCircle, warning: TriangleAlert, info: Info };
  return <div className="toast-region" aria-live="polite">{toasts.map((toast) => {
    const Icon = icons[toast.tone];
    return <div className={`toast toast-${toast.tone}`} key={toast.id}>
      <Icon size={18} /><div className="toast-copy"><strong>{toast.title}</strong>{toast.detail && <span>{toast.detail}</span>}</div>
      {toast.actionLabel && <button className="text-button" onClick={() => void toast.onAction?.()}>{toast.actionLabel}</button>}
      <button className="icon-button small" aria-label="关闭通知" onClick={() => dismissToast(toast.id)}><X /></button>
    </div>;
  })}</div>;
}
