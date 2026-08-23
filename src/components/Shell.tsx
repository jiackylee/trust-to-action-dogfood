import { useState } from "react";
import { NavLink, Outlet, useLocation } from "react-router-dom";
import { Activity, BookOpenCheck, BriefcaseBusiness, ChevronDown, CircleUserRound, Database, FileText, Gauge, Library, ListChecks, RotateCcw, Settings2, ShieldCheck, Sparkles, Users } from "lucide-react";
import { Modal, ToastRegion } from "./UI";
import { useAppStore } from "../store/AppStore";
import type { Role } from "../domain/types";

const nav = [
  { group: "经营", items: [{ to: "/", label: "本周经营台", icon: Gauge }, { to: "/weekly", label: "本周运营", icon: BriefcaseBusiness }] },
  { group: "内容", items: [{ to: "/content", label: "策略与草稿", icon: FileText }, { to: "/proofs", label: "证明资产", icon: Library }] },
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
  const location = useLocation();
  const currentRole = roles.find((item) => item.value === state?.role) ?? roles[0];
  return <div className="app-shell">
    <aside className="sidebar" aria-label="主导航">
      <div className="brand" title="Trust-to-Action 2.0"><span className="brand-mark"><Sparkles /></span><span className="brand-copy"><strong>Trust-to-Action</strong><small>内部增长副驾 · 2.0</small></span></div>
      <nav className="nav-groups">{nav.map((section) => <div className="nav-group" key={section.group}><div className="nav-group-label">{section.group}</div>{section.items.map((item) => <NavLink key={item.to} to={item.to} end={item.to === "/"} className={({ isActive }) => isActive ? "nav-link active" : "nav-link"} title={item.label} aria-label={item.label}><item.icon /><span>{item.label}</span></NavLink>)}</div>)}</nav>
      <div className="sidebar-footer">
        <div className={`health-pill ${health?.ai_configured ? "healthy" : "warning"}`} title={health?.ai_configured ? `AI 已连接 · ${health.model}` : "AI 未配置，生成操作会明确阻断"}><Activity /><span>{health?.ai_configured ? "AI 已连接" : "AI 未配置"}</span></div>
      </div>
    </aside>
    <div className="main-column">
      <header className="topbar">
        <div className="breadcrumb"><span>Dogfood · 第 {state?.week ?? 2} 周</span><b>{pageTitle(location.pathname)}</b></div>
        <div className="topbar-actions">
          <button className="icon-button" title="重置演示数据" aria-label="重置演示数据" onClick={() => setResetOpen(true)}><RotateCcw /></button>
          <div className="role-switcher">
            <button className="role-button" onClick={() => setRoleOpen((open) => !open)} aria-expanded={roleOpen}><CircleUserRound /><span><b>{currentRole.label}</b><small>{currentRole.person}</small></span><ChevronDown /></button>
            {roleOpen && <div className="role-menu" role="menu">{roles.map((role) => <button role="menuitem" key={role.value} className={state?.role === role.value ? "selected" : ""} onClick={() => { void setRole(role.value); setRoleOpen(false); }}><span>{role.label}</span><small>{role.person}</small></button>)}</div>}
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
