import type { ArchiveConversation, Customer, Role, Task } from "./types";

export type Ability = "generate_strategy" | "edit_draft" | "edit_proof" | "evaluate_customer" | "review_evaluation" | "review_marketing_output" | "record_task" | "decide_approval" | "view_governance" | "view_ai_quality" | "manage_ai_quality" | "publish_ai_version" | "configure_ai" | "decide_insight" | "manage_brief" | "mark_publish" | "record_content_outcome" | "view_raw_archive" | "preview_knowledge" | "manage_knowledge";

const permissions: Record<Role, ReadonlySet<Ability>> = {
  operations: new Set(["generate_strategy", "edit_draft", "edit_proof", "evaluate_customer", "review_marketing_output", "view_governance", "view_ai_quality", "manage_ai_quality", "configure_ai", "decide_insight", "manage_brief", "mark_publish", "preview_knowledge"]),
  sales: new Set(["evaluate_customer", "review_evaluation", "review_marketing_output", "record_task", "view_governance", "view_ai_quality", "record_content_outcome", "view_raw_archive"]),
  lead: new Set(["evaluate_customer", "decide_approval", "view_governance", "view_ai_quality", "publish_ai_version", "configure_ai", "view_raw_archive", "preview_knowledge", "manage_knowledge"]),
};

export function can(role: Role, ability: Ability) {
  return permissions[role].has(ability);
}

export function actorForRole(role: Role) {
  return role === "operations" ? "林澈" : role === "sales" ? "陈牧" : "周岚";
}

export function canAccessCustomer(role: Role, customer: Pick<Customer, "owner" | "shared">) {
  return role !== "sales" || customer.owner === actorForRole(role) || customer.shared;
}

export function canActOnTask(role: Role, task: Pick<Task, "owner">) {
  return can(role, "record_task") && task.owner === actorForRole(role);
}

export function canViewRawConversation(role: Role, conversation: Pick<ArchiveConversation, "owner">) {
  return role === "lead" || (role === "sales" && conversation.owner === actorForRole(role));
}
