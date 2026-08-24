import { useEffect, useRef, useState } from "react";
import { NavLink, Outlet, useLocation } from "react-router-dom";
import { Activity, BriefcaseBusiness, ChevronDown, CircleUserRound, FileText, Gauge, Library, ListChecks, MessageSquareText, RotateCcw, ShieldCheck, Sparkles, Users } from "lucide-react";
import { Modal, ToastRegion } from "./UI";
import { useAppStore } from "../store/AppStore";
import type { Role } from "../domain/types";

const nav = [
  { group: "经营", items: [{ to: "/", label: "本周经营台", icon: Gauge }, { to: "/weekly", label: "本周运营", icon: BriefcaseBusiness }] },
  { group: "内容", items: [{ to: "/insights", label: "会话洞察", icon: MessageSquareText }, { to: "/content", label: "草稿与发布", icon: FileText }, { to: "/proofs", label: "证明资产", icon: Library }] },
  { group: "客户", items: [{ to: "/customers", label: "客户状态", icon: Users }] },
  { group: "执行", items: [{ to: "/execution", label: "任务与审批", icon: ListChecks }] },
  { group: "治理", items: [{ to: "/governance", label: "数据与审计", icon: ShieldCheck }] },
];

const roles: Array<{ value: Role; label: string; person: string }> = [
  { value: "operations", label: "运营", person: "林澈" },
  { value: "sales", label: "销售", person: "陈牧" },
  { value: "lead", label: "负责人", person: "周岚" },
];

export function Shell() {
  const { state, setRole, resetDemo, health } = useAppStore();
  const [roleOpen, setRoleOpen] = useState(false);
  const [resetOpen, setResetOpen] = useState(false);
  const roleSwitcher = useRef<HTMLDivElement>(null);
  const roleItems = useRef<Array<HTMLButtonElement | null>>([]);
  const location = useLocation();
  const currentRole = roles.find((item) => item.value === state?.role) ?? roles[0];
  useEffect(() => {
    if (!roleOpen) return;
    const close = (event: MouseEvent) => { if (!roleSwitcher.current?.contains(event.target as Node)) setRoleOpen(false); };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") { setRoleOpen(false); roleSwitcher.current?.querySelector<HTMLButtonElement>(".role-button")?.focus(); } };
    document.addEventListener("mousedown", close); document.addEventListener("keydown", escape);
    return () => { document.removeEventListener("mousedown", close); document.removeEventListener("keydown", escape); };
  }, [roleOpen]);
  return <div className="app-shell">
    <aside className="sidebar" aria-label="主导航">
      <div className="brand" title="Trust-to-Action 2.0"><span className="brand-mark"><Sparkles /></span><span className="brand-copy"><strong>Trust-to-Action</strong><small>内部增长副驾 · 2.0</small></span></div>
      <nav className="nav-groups">{nav.map((section) => <div className="nav-group" key={section.group}><div className="nav-group-label">{section.group}</div>{section.items.map((item, index) => <NavLink key={item.to} to={item.to} end={item.to === "/"} className={({ isActive }) => `nav-link${isActive ? " active" : ""}${index === 0 && isSectionActive(section.group, location.pathname) ? " mobile-parent-active" : ""}`} title={item.label} aria-label={item.label}><item.icon /><span>{item.label}</span></NavLink>)}</div>)}</nav>
      <div className="sidebar-footer">
        <div className={`health-pill ${health?.ai_configured ? "healthy" : "warning"}`} title={health?.ai_configured ? `AI 已连接 · ${health.model}` : "AI 未配置，生成操作会明确阻断"}><Activity /><span>{health?.ai_configured ? "AI 已连接" : "AI 未配置"}</span></div>
      </div>
    </aside>
    <div className="main-column">
      <header className="topbar">
        <div className="breadcrumb"><span>Dogfood · 第 {state?.week ?? 2} 周</span><b>{pageTitle(location.pathname)}</b></div>
        <div className="topbar-actions">
          <button className="icon-button" title="重置演示数据" aria-label="重置演示数据" onClick={() => setResetOpen(true)}><RotateCcw /></button>
          <div className="role-switcher" ref={roleSwitcher}>
            <button className="role-button" onClick={() => { if (roleOpen) { setRoleOpen(false); return; } setRoleOpen(true); window.setTimeout(() => roleItems.current[roles.findIndex((item) => item.value === currentRole.value)]?.focus(), 0); }} aria-expanded={roleOpen} aria-haspopup="menu" aria-controls="role-menu"><CircleUserRound /><span><b>{currentRole.label}</b><small>{currentRole.person}</small></span><ChevronDown /></button>
            {roleOpen && <div className="role-menu" id="role-menu" role="menu" aria-label="切换内部角色" onKeyDown={(event) => { if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return; event.preventDefault(); const current = roleItems.current.indexOf(document.activeElement as HTMLButtonElement); const next = event.key === "Home" ? 0 : event.key === "End" ? roles.length - 1 : event.key === "ArrowDown" ? (current + 1) % roles.length : (current - 1 + roles.length) % roles.length; roleItems.current[next]?.focus(); }}>{roles.map((role, index) => <button ref={(node) => { roleItems.current[index] = node; }} role="menuitemradio" aria-checked={state?.role === role.value} key={role.value} className={state?.role === role.value ? "selected" : ""} onClick={() => { void setRole(role.value); setRoleOpen(false); }}><span>{role.label}</span><small>{role.person}</small></button>)}</div>}
          </div>
        </div>
      </header>
      <main className="page"><Outlet /></main>
    </div>
    <ToastRegion />
    <Modal open={resetOpen} title="重置全部演示数据？" onClose={() => setResetOpen(false)} actions={<><button className="secondary-button" onClick={() => setResetOpen(false)}>取消</button><button className="danger-button" onClick={() => { void resetDemo(); setResetOpen(false); }}>确认重置</button></>}>
      <p>这会清除 V2 的本地修改、审批结果、任务回填和角色设置，并恢复 24 位合成客户。V1 和其他项目数据不会受影响。</p>
    </Modal>
  </div>;
}
function pageTitle(pathname: string) {
  if (pathname.startsWith("/customers/")) return "客户详情";
  return nav.flatMap((item) => item.items).find((item) => item.to === pathname)?.label ?? "内部工作台";
}

function isSectionActive(group: string, pathname: string) {
  if (group === "经营") return pathname === "/" || pathname.startsWith("/weekly");
  if (group === "内容") return pathname.startsWith("/insights") || pathname.startsWith("/content") || pathname.startsWith("/proofs");
  if (group === "客户") return pathname.startsWith("/customers");
  if (group === "执行") return pathname.startsWith("/execution");
  return pathname.startsWith("/governance");
}
