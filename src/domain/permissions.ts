import type { Role } from "./types";

export type Ability = "generate_strategy" | "edit_draft" | "evaluate_customer" | "record_task" | "decide_approval" | "view_governance";

const permissions: Record<Role, ReadonlySet<Ability>> = {
  operations: new Set(["generate_strategy", "edit_draft", "evaluate_customer", "view_governance"]),
  sales: new Set(["evaluate_customer", "record_task"]),
  lead: new Set(["evaluate_customer", "decide_approval", "view_governance"]),
};

export function can(role: Role, ability: Ability) {
  return permissions[role].has(ability);
}
