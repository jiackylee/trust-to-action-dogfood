import { STATE_ORDER, type CustomerEvaluation } from "./schemas";
import type { ArchiveConsent, ArchivedMessage, ConversationInsight, Customer, Draft, Proof } from "./types";

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
  for (const id of draft.evidence_refs) {
    const proof = proofs.find((item) => item.id === id);
    if (!proof) flags.add("证明资产不存在");
    else if (proof.status === "revoked") flags.add("证据授权已撤销");
    else if (proof.status === "incomplete") flags.add("证明信息不完整");
    else if (proof.status === "internal_only") flags.add("证明仅限内部");
  }
  return [...flags];
}

const materialDraftKeys = ["title", "stage", "segment", "objective", "body", "cta", "expected_transition", "channel"] as const;

export function isMaterialDraftChange(before: Draft, after: Draft) {
  return materialDraftKeys.some((key) => before[key] !== after[key])
    || before.evidence_refs.join("\u0000") !== after.evidence_refs.join("\u0000");
}

export function draftApprovalRisks(draft: Draft, proofs: Proof[]) {
  const risks = new Set(deterministicDraftRisks(draft, proofs));
  for (const id of draft.evidence_refs) {
    const proof = proofs.find((item) => item.id === id);
    if (proof?.status === "usable" && !proof.authorization.includes(draft.channel)) risks.add(`证明未授权用于${draft.channel}`);
  }
  return [...risks];
}

export function proofCompleteness(proof: Pick<Proof, "redacted_quote" | "process" | "baseline" | "result" | "period" | "authorization" | "expires_at">) {
  const checks = [
    ["脱敏反馈", proof.redacted_quote.trim()],
    ["使用过程", proof.process.trim()],
    ["基线", proof.baseline.trim() && !/^(待补|未记录)$/u.test(proof.baseline.trim())],
    ["结果", proof.result.trim() && proof.result.trim() !== "待补"],
    ["周期", proof.period.trim() && proof.period.trim() !== "进行中"],
    ["有效授权", proof.authorization.length > 0],
    ["授权到期日", proof.expires_at.trim()],
  ] as const;
  const missing = checks.filter(([, value]) => !value).map(([label]) => label);
  return { completeness: Math.round(((checks.length - missing.length) / checks.length) * 100), missing_fields: missing };
}

export function proofIsUsable(proof: Pick<Proof, "status" | "expires_at" | "authorization">, at = new Date()) {
  return proof.status === "usable" && proof.authorization.length > 0 && new Date(proof.expires_at).getTime() >= at.getTime();
}

const phonePattern = /(?<!\d)1[3-9]\d{9}(?!\d)/gu;
const emailPattern = /[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/gu;
const wechatPattern = /(?:微信|wx|wechat)[:：\s]*[A-Za-z][-_A-Za-z0-9]{5,19}/giu;
const idCardPattern = /(?<!\d)\d{17}[\dXx](?!\d)/gu;

export function redactArchiveText(text: string) {
  return text.replace(phonePattern, "[手机号已脱敏]").replace(emailPattern, "[邮箱已脱敏]").replace(wechatPattern, "[微信号已脱敏]").replace(idCardPattern, "[证件号已脱敏]");
}

export function archiveMessageEligibility(message: ArchivedMessage, consent: ArchiveConsent | undefined, at = new Date("2026-08-24T12:00:00+08:00")) {
  const reasons: string[] = [];
  if (consent?.status !== "agreed") reasons.push("未获得有效会话存档同意");
  if (message.recalled) reasons.push("消息已撤回");
  if (message.duplicate_of) reasons.push("重复消息");
  if (message.decrypt_status !== "ok") reasons.push("消息解密失败");
  if (!message.text && !message.link_description) reasons.push("媒体仅保留元数据");
  if (at.getTime() - new Date(message.sent_at).getTime() > 5 * 24 * 60 * 60_000) reasons.push("超出 5 天补拉窗口");
  return { eligible: reasons.length === 0, reasons, redacted_text: reasons.length ? null : redactArchiveText(message.text ?? message.link_description ?? "") };
}

export function insightTrendScope(conversationRefs: string[]) {
  return new Set(conversationRefs).size >= 3 ? "trend" as const : "individual" as const;
}

export function validateInsightLineage(insight: Pick<ConversationInsight, "message_refs" | "conversation_refs">, messages: ArchivedMessage[], consents: ArchiveConsent[]) {
  const reasons: string[] = [];
  const referenced = insight.message_refs.map((id) => messages.find((message) => message.id === id));
  if (referenced.some((message) => !message)) reasons.push("存在未知消息引用");
  for (const message of referenced) {
    if (!message) continue;
    const consent = consents.find((item) => item.conversation_id === message.conversation_id);
    if (!archiveMessageEligibility(message, consent).eligible) reasons.push(`${message.id} 不符合分析门禁`);
    if (!insight.conversation_refs.includes(message.conversation_id)) reasons.push(`${message.id} 的会话血缘缺失`);
  }
  return { allowed: reasons.length === 0, code: reasons.length ? "INSIGHT_LINEAGE_BLOCKED" : "OK", reasons };
}
