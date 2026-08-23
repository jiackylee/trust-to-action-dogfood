import { STATE_ORDER, type CustomerEvaluation } from "./schemas";
import type { Customer, Draft, Proof } from "./types";

export interface PolicyDecision {
  allowed: boolean;
  code: string;
  reasons: string[];
}

export function validateCustomerEvaluation(customer: Customer, evaluation: CustomerEvaluation): PolicyDecision {
  const reasons: string[] = [];
  const beforeIndex = STATE_ORDER.indexOf(customer.state);
  const afterIndex = STATE_ORDER.indexOf(evaluation.state_after);
  const referenced = customer.evidence.filter((item) => evaluation.evidence_refs.includes(item.id));
  const validReferenced = referenced.filter((item) => item.valid);

  if (evaluation.state_before !== customer.state) reasons.push("模型输入状态与当前版本不一致");
  if (afterIndex - beforeIndex > 1) reasons.push("状态最多前进一步");
  if (!validReferenced.length) reasons.push("至少需要一条有效证据引用");
  if (["D1", "A1"].includes(evaluation.state_after) && !validReferenced.some((item) => item.strength === "strong")) reasons.push("D1/A1 必须引用有效强证据");
  if (evaluation.state_after === "C1" && !validReferenced.some((item) => item.transaction_fact)) reasons.push("C1 必须存在明确成交事实");
  if (evaluation.evidence_refs.some((id) => !customer.evidence.some((item) => item.id === id))) reasons.push("存在未知证据引用");

  return { allowed: reasons.length === 0, code: reasons.length ? "POLICY_BLOCKED" : "OK", reasons };
}

export function deterministicDraftRisks(draft: Pick<Draft, "title" | "body" | "evidence_refs">, proofs: Proof[]) {
  const text = `${draft.title} ${draft.body}`;
  const flags = new Set<string>();
  if (/价格|报价|折扣|Offer|名额|排期|试用/iu.test(text)) flags.add("价格 / Offer");
  if (/客户|团队|案例|反馈/iu.test(text) && /\d+\s*(%|条|人|天|周|个月)/u.test(text)) flags.add("客户证明 / 量化结果");
  if (/投诉|补偿|身份证|手机号|泄露/iu.test(text)) flags.add("投诉 / 敏感信息");
  if (draft.evidence_refs.some((id) => proofs.find((proof) => proof.id === id)?.status === "revoked")) flags.add("证据授权已撤销");
  return [...flags];
}
