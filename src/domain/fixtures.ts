import type { AnalysisBatch, Approval, ArchiveConsent, ArchiveConversation, ArchivedMessage, ContentBrief, ContentFamily, ContentOutcome, ConversationInsight, DomainState, Draft, EvalRun, EvaluationCandidate, EvaluationDecision, GenerationRun, GoldenCase, Integration, KnowledgePackVersion, KnowledgeRetrievalRun, KnowledgeSource, MarketingBrainVersion, MarketingDecisionCandidate, MarketingDecisionDecision, MarketingDecisionOutput, MarketingTaskType, PromptVersion, Proof, PublicationRecord, RouterVersion, Task, TenantFactVersion } from "./types";
import type { Customer } from "./types";
import { STATE_LABELS, type StateCode } from "./schemas";
import { evidenceFingerprint } from "./quality";

const NOW = "2026-08-23T15:00:00+08:00";
const names = ["顾言", "沈宁", "程知", "唐禾", "苏越", "陆川", "姜楠", "宋佳", "叶舟", "白露", "徐嘉", "蒋闻", "高原", "阮青", "夏林", "孟乔", "杜衡", "何安", "许澄", "罗简", "林悦", "陈屿", "周恬", "袁初"];
const companies = ["启明云科", "拾光零售", "澄海咨询", "远川教育", "砺行软件", "青禾服务", "知野科技", "简一商贸", "春山企服", "向量数据", "联创制造", "观澜设计", "合序管理", "见微网络", "沐星电商", "云程培训", "同频咨询", "原点科技", "清越品牌", "拓界软件", "南桥商学", "杉谷智能", "星帆服务", "涟漪增长"];
const states: StateCode[] = ["A1", "D1", "I1", "T1", "T0", "D1", "I1", "T1", "A1", "T0", "I1", "D1", "T1", "C1", "T0", "I1", "T1", "D1", "T0", "A1", "I1", "T1", "T0", "T1"];
const owners = ["陈牧", "许清", "何川"];
const industries = ["企业服务", "零售电商", "教育培训", "软件科技", "专业咨询", "智能制造"];

function date(day: number, hour = 10) {
  return `2026-08-${String(day).padStart(2, "0")}T${String(hour).padStart(2, "0")}:00:00+08:00`;
}

const signalByState: Record<StateCode, { type: string; text: string; strength: "weak" | "medium" | "strong"; action: string }> = {
  T0: { type: "朋友圈点赞", text: "对本周经营判断点了赞，暂无主动问题。", strength: "weak", action: "继续观察" },
  T1: { type: "主动询问方法", text: "主动追问线索分层方法，希望获得一页检查清单。", strength: "medium", action: "发送知识内容" },
  I1: { type: "索要产品界面", text: "询问状态看板能否区分负责人，并索要产品界面。", strength: "strong", action: "分享 Demo" },
  D1: { type: "提供团队规模", text: "补充团队规模和当前流程，明确线索遗漏问题。", strength: "strong", action: "询问资格问题" },
  A1: { type: "询问价格排期", text: "主动询问试用排期、实施周期和报价范围。", strength: "strong", action: "准备 Offer" },
  C1: { type: "成交事实", text: "合同已确认，等待首周配置和首次价值验收。", strength: "strong", action: "转人工" },
};

function makeCustomers(): Customer[] {
  return names.map((name, index) => {
    const state = states[index];
    const signal = signalByState[state];
    const id = `cus-${String(index + 1).padStart(2, "0")}`;
    const confidence = { T0: 42, T1: 67, I1: 78, D1: 85, A1: 91, C1: 100 }[state] + (index % 3) - 1;
    return {
      id,
      revision: 1,
      updated_at: date(23 - (index % 4), 15),
      name,
      company: `${companies[index]}（演示）`,
      title: ["销售负责人", "创始人", "运营总监", "市场负责人"][index % 4],
      owner: owners[index % owners.length],
      shared: index % 8 === 0,
      industry: industries[index % industries.length],
      size: ["1-10 人", "11-30 人", "31-100 人", "101-300 人"][index % 4],
      source: ["内容资料领取", "线下活动", "客户转介绍", "微信客服"][index % 4],
      tags: [industries[index % industries.length], index % 2 ? "重点培育" : "新线索"],
      state,
      confidence,
      evidence_strength: signal.strength,
      last_interaction: signal.text,
      last_interaction_at: date(23 - (index % 5), 10 + (index % 6)),
      review_at: date(24 + (index % 4), 10),
      anomaly: index === 9 ? "数据过期" : index === 18 ? "证据授权已撤销" : index === 21 ? "人工修改冲突" : null,
      kf_summary: index % 4 === 0 ? `近 3 天共 ${2 + (index % 3)} 条消息。核心意图：${signal.text} 尚有问题待人工确认。` : "近 3 天无可关联的微信客服消息。",
      evidence: [
        { id: `evi-${id}-1`, strength: signal.strength, type: signal.type, text: signal.text, occurred_at: date(23 - (index % 5), 10), source: index % 4 === 0 ? "微信客服" : "企微事件", valid: index !== 18, transaction_fact: state === "C1" },
        { id: `evi-${id}-2`, strength: "weak", type: "朋友圈互动", text: "浏览相关主题并产生一次轻互动，仅用于观察。", occurred_at: date(20 - (index % 3), 16), source: "客户朋友圈", valid: true, transaction_fact: false },
      ],
      evaluation: {
        decision: state === "T0" ? "insufficient_evidence" : "recommend",
        objective: state === "A1" ? "确认决策人和实施边界" : "获得一条可推进状态的新证据",
        target_segment: state === "T0" ? "新线索" : "重点培育",
        state_before: state,
        state_after: state,
        confidence,
        evidence_refs: [`evi-${id}-1`],
        recommendation: signal.action as never,
        not_recommended: state === "T0" ? ["直接报价"] : ["连续发送多份材料"],
        draft: "先确认一个会改变下一步的问题，再提供对应材料。",
        cta: "确认当前团队规模",
        expected_transition: `${state} 保持或前进一步`,
        risk_flags: state === "A1" ? ["价格 / Offer"] : [],
        approval_required: state === "A1",
        next_review_at: date(25 + (index % 3), 10),
        evidence_assessment: [{ evidence_id: `evi-${id}-1`, supports: "both", weight: signal.strength, summary: signal.text }],
        uncertainties: state === "T0" ? ["只有弱互动，缺少主动问题"] : [],
      },
      evaluation_meta: { model: "规则基线 V0.3", response_id: `fixture-${id}`, prompt_version: "fixture-v2" },
      notes: [],
      nba_decision: null,
    };
  });
}

function makeDrafts(): Draft[] {
  const data = [
    ["线索不是越多越好，先看有没有下一步", "T", "T0 / T1 · 新线索与长期培育", "建立可追溯跟进的经营判断", "最近复盘线索池时，我们先不看总量，而是问三个问题：谁在负责、最近一条有效证据是什么、下一次复查是哪天。\n\n如果这三个问题答不上来，增加线索只会放大遗漏。", "回复“清单”", "T0 → T1", [], false, "not_required", "ready"],
    ["一个客户状态看板只解决一件事", "I", "T1 / I1 · 已主动询问流程", "连接经营问题与产品场景", "客户状态看板的价值，不是给每个人贴更多标签。它只解决一件事：让销售每天知道先跟进谁、为什么、下一步做什么。", "预约 20 分钟 Demo", "T1 → I1", [], false, "not_required", "ready"],
    ["7 人销售团队如何减少线索遗漏", "D", "I1 / D1 · 5-10 人销售团队", "用相似过程降低决策风险", "一支 7 人销售团队先统一了强弱证据、下一动作和 48 小时结果回填。两周后，逾期动作从 31 条下降到 12 条。", "回复“案例”", "I1 → D1", ["proof-01"], true, "pending", "review"],
    ["Dogfood 试点实施边界", "A", "D1 / A1 · 已确认团队规模", "推动人工诊断与试点确认", "本轮 Dogfood 先用 4 周校准状态证据和下一动作，不自动发朋友圈、不自动私聊。价格与范围在诊断后确认。", "预约范围确认", "D1 → A1", [], true, "returned", "blocked"],
    ["为什么单次点赞不能算高意向", "T", "全量线索 · 弱信号客户", "建立证据强弱的共同语言", "点赞说明看见了，不等于准备买。真正推动状态的，是主动描述问题、索要案例、提供团队规模、询问实施或排期。", "查看证据分级表", "保持 T0 / 建立 T1", [], false, "not_required", "ready"],
    ["客户说先发方案看看以后怎么办", "I", "I1 · 索要材料但信息不足", "用资格问题换取新证据", "客户说先发方案看看，不要立刻塞完整产品介绍。先问一个会改变方案的问题，例如团队规模和最常遗漏的环节。", "领取资格问题模板", "I1 → D1", [], false, "not_required", "ready"],
    ["客户真正关心的不是线索数量", "T", "T1 · 线索较多但跟进失控", "回应高频流程异议", "会话里反复出现的不是“线索从哪里来”，而是“线索来了以后谁负责、什么时候跟、结果记在哪里”。先把这三个问题答清楚，增长才有可执行的下一步。", "回复“复盘”", "T0 → T1", [], false, "not_required", "ready"],
    ["从一次追问识别真实购买信号", "I", "I1 · 主动询问实施方式", "帮助销售识别有效会话信号", "主动询问实施周期、团队协作和数据边界，比一次点赞更接近真实决策。把信号落到带时间的证据上，再决定是否分享 Demo。", "查看信号清单", "T1 → I1", [], false, "not_required", "ready"],
  ] as const;
  return data.map((item, index) => ({
    id: `draft-${String(index + 1).padStart(2, "0")}`,
    revision: 1,
    updated_at: date(23 - (index % 3), 9 + index),
    title: item[0], stage: item[1], segment: item[2], objective: item[3], body: item[4], cta: item[5], expected_transition: item[6],
    channel: "朋友圈",
    evidence_refs: [...item[7]], risk_flags: item[8] ? [index === 2 ? "客户证明" : "价格 / Offer"] : [], approval_required: item[8], approval_status: item[9], status: item[10], published_at: null, result: null,
    brief_id: `brief-${String(index + 1).padStart(2, "0")}`,
    content_family_id: `family-${String(index + 1).padStart(2, "0")}`,
    variant_of: null,
  }));
}

function makeProofs(): Proof[] {
  const data: Array<Omit<Proof, "revision" | "updated_at">> = [
    { id: "proof-01", title: "7 人销售团队线索跟进校准", industry: "企业服务", redacted_quote: "统一状态证据与下一步后，周会能更直接地处理跟进问题。", process: "盘点线索池、校准证据、每日处理队列。", baseline: "逾期动作 31 条", result: "两周后 12 条", period: "14 天", authorization: ["朋友圈", "销售"], expires_at: "2026-11-30", completeness: 92, status: "usable", missing_fields: [], referenced_by: ["draft-03"] },
    { id: "proof-02", title: "Demo 前资格问题清单", industry: "软件科技", redacted_quote: "Demo 前确认规模和线索量后，讨论更聚焦。", process: "增加两个低摩擦问题。", baseline: "未记录", result: "主观反馈", period: "7 天", authorization: ["仅内部"], expires_at: "2026-09-30", completeness: 64, status: "internal_only", missing_fields: ["量化基线"], referenced_by: [] },
    { id: "proof-03", title: "48 小时结果回填机制", industry: "教育培训", redacted_quote: "结果回填帮助区分建议质量与执行记录缺失。", process: "动作完成后 48 小时内记录结果。", baseline: "回填率 46%", result: "提升至 83%", period: "21 天", authorization: ["朋友圈", "销售", "官网"], expires_at: "2027-01-31", completeness: 96, status: "usable", missing_fields: [], referenced_by: [] },
    { id: "proof-04", title: "微信客服意图摘要", industry: "零售电商", redacted_quote: "客服主动问题有价值，但身份匹配仍需补齐。", process: "只读同步并人工确认关联。", baseline: "待补", result: "待补", period: "进行中", authorization: ["仅内部"], expires_at: "2026-09-15", completeness: 48, status: "incomplete", missing_fields: ["基线", "结果", "公开授权"], referenced_by: [] },
    { id: "proof-05", title: "已撤销授权的客户评价", industry: "专业咨询", redacted_quote: "该资产授权已撤销，不得继续引用。", process: "撤销后阻断所有引用。", baseline: "不适用", result: "阻断 1 条草稿", period: "即时", authorization: [], expires_at: "2026-08-21", completeness: 88, status: "revoked", missing_fields: ["有效授权"], referenced_by: [] },
  ];
  return data.map((proof) => ({ ...proof, revision: 1, updated_at: NOW }));
}

function makeApprovals(): Approval[] {
  return [
    { id: "approval-01", object_id: "draft-03", object_type: "draft", object_revision: 1, title: "7 人销售团队如何减少线索遗漏", type: "客户证明 + 量化结果", requester: "林澈", approver: "周岚", status: "pending", summary: "引用 proof-01，包含团队规模与量化结果。", risk_flags: ["客户证明 / 量化结果"], evidence_refs: ["proof-01"], reason: "", due_at: date(23, 18), revision: 1, updated_at: NOW },
    { id: "approval-02", object_id: "draft-04", object_type: "draft", object_revision: 1, title: "Dogfood 试点实施边界", type: "Offer + 价格 / 排期", requester: "林澈", approver: "周岚", status: "returned", summary: "包含排期与实施范围表述。", risk_flags: ["价格 / Offer"], evidence_refs: [], reason: "缺少已确认的真实容量依据。", due_at: date(23, 12), revision: 2, updated_at: date(22, 17) },
    { id: "approval-03", object_id: "proof-03", object_type: "proof", object_revision: 1, title: "48 小时结果回填机制", type: "量化结果 + 官网使用", requester: "林澈", approver: "周岚", status: "approved", summary: "证据与授权完整。", risk_flags: ["量化结果"], evidence_refs: ["proof-03"], reason: "必须说明 21 天观察期。", due_at: date(21, 18), revision: 2, updated_at: date(21, 16) },
    { id: "approval-04", object_id: "proof-04", object_type: "proof", object_revision: 1, title: "微信客服匹配失败反馈", type: "客户反馈 + 潜在投诉", requester: "陈牧", approver: "周岚", status: "pending", summary: "当前仅允许内部复盘。", risk_flags: ["投诉 / 敏感信息"], evidence_refs: ["proof-04"], reason: "", due_at: date(24, 10), revision: 1, updated_at: NOW },
  ];
}

function makeTasks(customers: Customer[]): Task[] {
  return customers.slice(0, 10).map((customer, index) => ({ id: `task-${index + 1}`, revision: 1, updated_at: NOW, customer_id: customer.id, title: `${customer.evaluation?.recommendation ?? "继续观察"} · ${customer.name}`, type: customer.evaluation?.recommendation ?? "继续观察", owner: customer.owner, priority: index < 3 ? "high" : index < 7 ? "medium" : "low", due_at: index < 2 ? date(22, 18) : date(24 + (index % 3), 17), status: index === 4 ? "done" : index === 5 ? "executed" : "pending", outcome: index === 4 ? "客户确认周三参加 Demo。" : "" }));
}

function makeIntegrations(): Integration[] {
  return [
    { id: "source-archive", revision: 2, updated_at: NOW, name: "会话内容存档（合成）", description: "seq 增量同步、单批 1000 条、SDK 解密与 5 天补拉窗口", scope: "36 个会话 · 252 条合成消息", status: "partial", last_success_at: date(23, 15), freshness: "12 分钟", cursor: "seq=1367 · gap=1124-1125", error: "1 个游标缺口、1 条解密失败；超窗消息不会补拉或进入分析。" },
    { id: "source-customers", revision: 1, updated_at: NOW, name: "企微客户与标签", description: "客户详情、负责人、标签和来源", scope: "3 名销售 · 24 位合成客户", status: "healthy", last_success_at: NOW, freshness: "8 分钟", cursor: "ext_demo_24", error: "" },
    { id: "source-moments", revision: 1, updated_at: NOW, name: "客户朋友圈", description: "记录、覆盖、评论和点赞弱信号", scope: "近 30 天 · 18 条记录", status: "delayed", last_success_at: date(23, 12), freshness: "3 小时", cursor: "mom_demo_18", error: "互动明细仍在分批同步。" },
    { id: "source-kf", revision: 1, updated_at: NOW, name: "微信客服", description: "回调触发与近 3 天消息", scope: "2 个客服账号 · 9 个会话", status: "partial", last_success_at: date(23, 14), freshness: "46 分钟", cursor: "kf_demo_09", error: "1 个会话无法关联客户。" },
    { id: "source-stats", revision: 1, updated_at: NOW, name: "联系客户统计", description: "成员级新增、聊天和删除趋势", scope: "应用缺少统计只读权限", status: "unauthorized", last_success_at: null, freshness: "不可用", cursor: "未建立", error: "API 未授权；不会参与单客户判断。" },
  ];
}

const ARCHIVE_NOW = new Date("2026-08-24T04:00:00.000Z");
function archiveDate(daysAgo: number, hourOffset = 0) {
  return new Date(ARCHIVE_NOW.getTime() - daysAgo * 24 * 60 * 60_000 + hourOffset * 60 * 60_000).toISOString();
}

function makeArchive(customers: Customer[]) {
  const consents: ArchiveConsent[] = [];
  const conversations: ArchiveConversation[] = [];
  const messages: ArchivedMessage[] = [];
  for (let index = 0; index < 36; index += 1) {
    const number = String(index + 1).padStart(2, "0");
    const conversationId = `conv-${number}`;
    const customer = customers[index % customers.length];
    const daysAgo = index < 12 ? index % 4 : 6 + (index % 22);
    const consentStatus = [4, 15].includes(index) ? "declined" as const : index === 8 ? "withdrawn" as const : "agreed" as const;
    consents.push({
      id: `consent-${number}`, revision: index === 8 ? 2 : 1, updated_at: archiveDate(Math.min(daysAgo, 4)),
      customer_id: customer.id, conversation_id: conversationId, status: consentStatus,
      scope: "服务质量改进与内部内容洞察", agreed_at: consentStatus === "agreed" ? archiveDate(daysAgo + 2) : null,
      changed_at: archiveDate(Math.min(daysAgo, 4)),
    });
    const syncState = index === 12 ? "seq_gap" as const : index === 13 ? "decrypt_partial" as const : daysAgo > 5 ? "outside_recovery_window" as const : "healthy" as const;
    conversations.push({
      id: conversationId, revision: 1, updated_at: archiveDate(daysAgo), customer_id: customer.id, owner: customer.owner,
      kind: index % 5 === 0 ? "group" : "direct", display_name: index % 5 === 0 ? `${customer.company}需求讨论群` : `${customer.name}会话`,
      participant_count: index % 5 === 0 ? 5 + (index % 4) : 2, started_at: archiveDate(Math.min(28, daysAgo + 6)),
      last_message_at: archiveDate(daysAgo), consent_id: `consent-${number}`, message_count: 7,
      latest_seq: 1000 + index * 10 + 7, sync_state: syncState,
    });
    const customerLines = [
      "最近线索不少，但销售跟进全靠各自记忆。",
      "我们最担心引入工具后还要维护很多字段。",
      `团队现在有 ${5 + (index % 8)} 位销售，想先看一份实施清单。`,
      "能否区分只是点赞和主动询问这两类信号？",
      "如果两周能看出遗漏是否下降，我们愿意安排 Demo。",
    ];
    for (let messageIndex = 0; messageIndex < 7; messageIndex += 1) {
      const messageNumber = `${number}-${messageIndex + 1}`;
      const kind = messageIndex === 6 ? (["image", "voice", "file"] as const)[index % 3] : messageIndex === 4 ? "link" as const : "text" as const;
      const recalled = index === 2 && messageIndex === 5;
      const duplicateOf = index === 3 && messageIndex === 5 ? `msg-${number}-5` : null;
      const decryptFailed = index === 13 && messageIndex === 3;
      const isCustomer = messageIndex % 2 === 0;
      messages.push({
        id: `message-${messageNumber}`, revision: recalled ? 2 : 1, updated_at: archiveDate(daysAgo, -messageIndex),
        conversation_id: conversationId, customer_id: customer.id, owner: customer.owner, msgid: duplicateOf ? `msg-${number}-5` : `msg-${messageNumber}`,
        seq: 1000 + index * 10 + messageIndex + 1 + (index === 12 && messageIndex >= 4 ? 2 : 0),
        sender: isCustomer ? "customer" : "employee", sender_name: isCustomer ? customer.name : customer.owner,
        kind, text: kind === "text" ? (isCustomer ? customerLines[Math.floor(messageIndex / 2) % customerLines.length] : "已记录，我先确认当前流程和目标，再提供对应材料。") : null,
        link_description: kind === "link" ? "客户状态证据分级与跟进复盘清单" : null,
        media_name: ["image", "voice", "video", "file"].includes(kind) ? `合成附件-${messageNumber}.${kind === "image" ? "png" : kind === "voice" ? "amr" : "pdf"}` : null,
        sent_at: archiveDate(daysAgo, -messageIndex), recalled, duplicate_of: duplicateOf, decrypt_status: decryptFailed ? "failed" : "ok",
      });
    }
  }
  return { consents, conversations, messages };
}

const insightTopics = [
  ["跟进依赖个人记忆", "问题", "流程失控", "销售团队", "线索进入后缺少统一负责人、证据和复查时间。"],
  ["担心工具增加维护负担", "异议", "实施成本", "5-15 人销售团队", "客户希望最少字段即可开始，不接受重型 CRM 改造。"],
  ["希望先看实施清单", "购买信号", "索要方法资料", "I1 主动咨询客户", "主动索要实施清单，适合用低摩擦内容承接。"],
  ["用两周观察遗漏下降", "期望结果", "量化验证", "D1 结果导向客户", "客户希望用短周期试点验证跟进遗漏是否下降。"],
] as const;

function makeInsights(): ConversationInsight[] {
  const groups = [["conv-01", "conv-02", "conv-03"], ["conv-06", "conv-07", "conv-08"], ["conv-10", "conv-11", "conv-12"]];
  return Array.from({ length: 12 }, (_, index) => {
    const number = String(index + 1).padStart(2, "0");
    const topic = insightTopics[index % insightTopics.length];
    const conversationRefs = index === 11 ? ["conv-01", "conv-02"] : groups[index % groups.length];
    const messageRefs = conversationRefs.map((conversationId) => `message-${conversationId.slice(-2)}-3`);
    const status = index < 8 ? "accepted" as const : index < 10 ? "candidate" as const : "dismissed" as const;
    return {
      id: `insight-${number}`, revision: 1, updated_at: archiveDate(index % 4), batch_id: "batch-01",
      title: topic[0], category: topic[1], signal_type: topic[2], customer_segment: topic[3], summary: topic[4],
      redacted_quotes: ["团队规模为 [数字已泛化]，跟进仍主要依赖个人记录。", "希望先看一份不包含客户原文的实施清单。"],
      message_refs: messageRefs, conversation_refs: conversationRefs, distinct_conversation_count: new Set(conversationRefs).size,
      confidence: 74 + (index % 5) * 4, evidence_strength: index % 4 === 2 ? "strong" : "medium",
      trend_scope: conversationRefs.length >= 3 ? "trend" : "individual", status,
      decision_reason: status === "dismissed" ? "与本周目标客户不匹配。" : status === "accepted" ? "证据跨多个有效会话且可转化为内容问题。" : "",
      decided_by: status === "candidate" ? null : "林澈", decided_at: status === "candidate" ? null : archiveDate(index % 3),
      brief_id: index < 8 ? `brief-${number}` : null, invalidated_reason: null,
    };
  });
}

function makeBriefs(): ContentBrief[] {
  return Array.from({ length: 8 }, (_, index) => {
    const number = String(index + 1).padStart(2, "0");
    const topic = insightTopics[index % insightTopics.length];
    return {
      id: `brief-${number}`, revision: 1, updated_at: archiveDate(index % 4), title: `${topic[0]}内容 Brief`, insight_ids: [`insight-${number}`],
      target_segment: topic[3], stage: (["T", "I", "D", "A"] as const)[index % 4], primary_angle: topic[4],
      key_facts: ["只使用已同意且有效的脱敏会话信号", "朋友圈互动属于弱信号"],
      proof_requirements: index % 3 === 2 ? ["补充已授权的量化过程证明"] : [], cta: index % 2 ? "回复“清单”" : "预约 20 分钟诊断",
      due_at: archiveDate(-2 + (index % 3)), status: index === 7 ? "draft" : "adopted", adopted_by: index === 7 ? null : "林澈",
      content_family_id: `family-${number}`, ai_meta: null,
    };
  });
}

function makeContentFamilies(): ContentFamily[] {
  return Array.from({ length: 8 }, (_, index) => {
    const number = String(index + 1).padStart(2, "0");
    return { id: `family-${number}`, revision: 1, updated_at: archiveDate(index % 4), brief_id: `brief-${number}`, title: `内容家族 ${number}`, primary_draft_id: `draft-${number}`, variant_draft_ids: [] };
  });
}

function makePublicationHistory() {
  const publications: PublicationRecord[] = Array.from({ length: 8 }, (_, index) => {
    const number = String(index + 1).padStart(2, "0");
    const synced = index < 7;
    return {
      id: `publication-${number}`, revision: 1, updated_at: archiveDate(2 + index * 3), draft_id: `history-draft-${number}`,
      content_family_id: `family-${number}`, channel: "朋友圈", operator: "林澈", published_at: archiveDate(3 + index * 3),
      status: synced ? "results_synced" : "published", association_window_days: 7,
      visible_customers: synced ? 82 + index * 11 : null, likes: synced ? 4 + index * 2 : null, comments: synced ? index % 4 : null,
      synced_at: synced ? archiveDate(2 + index * 3) : null,
    };
  });
  const outcomes: ContentOutcome[] = Array.from({ length: 6 }, (_, index) => ({
    id: `outcome-${String(index + 1).padStart(2, "0")}`, revision: 1, updated_at: archiveDate(1 + index * 3), publication_id: `publication-${String(index + 1).padStart(2, "0")}`,
    customer_id: `cus-${String(index + 1).padStart(2, "0")}`, type: (["inquiry", "demo", "offer", "state_transition"] as const)[index % 4],
    detail: ["主动咨询实施清单", "预约产品 Demo", "请求准备试点 Offer", "客户状态由 T1 进入 I1"][index % 4],
    occurred_at: archiveDate(1 + index * 3), recorded_by: "陈牧",
  }));
  return { publications, outcomes };
}

function makeAnalysisBatches(insights: ConversationInsight[], messages: ArchivedMessage[]): AnalysisBatch[] {
  return [{
    id: "batch-01", revision: 1, updated_at: NOW, seq_from: 1001, seq_to: 1117, started_at: archiveDate(1, -1), completed_at: archiveDate(1),
    message_refs: messages.filter((message) => message.conversation_id <= "conv-12" && message.kind === "text" && !message.recalled && !message.duplicate_of).map((message) => message.id),
    insight_ids: insights.map((insight) => insight.id), included_count: 78, excluded_count: 6, duplicate_count: 1, decrypt_failure_count: 0, cursor_status: "complete", model: "规则基线 V0.4",
  }];
}

function makeGoldenCases(): GoldenCase[] {
  const stateOrder: StateCode[] = ["T0", "T1", "I1", "D1", "A1", "C1"];
  const actionByState = ["继续观察", "发送知识内容", "分享 Demo", "询问资格问题", "准备 Offer", "转人工"] as const;
  const nbaCases = Array.from({ length: 200 }, (_, index) => {
    const stateIndex = index % stateOrder.length;
    const stateBefore = stateOrder[stateIndex];
    const anomaly = index % 17 === 0 ? "数据过期" : index % 29 === 0 ? "证据冲突" : null;
    const evidenceStrength = index % 5 === 0 ? "weak" as const : index % 3 === 0 ? "medium" as const : "strong" as const;
    const canAdvance = !anomaly && evidenceStrength !== "weak" && stateIndex < stateOrder.length - 1;
    const expectedState = canAdvance ? stateOrder[stateIndex + 1] : stateBefore;
    const expectedIndex = stateOrder.indexOf(expectedState);
    const evidenceId = `gold-evi-${String(index + 1).padStart(3, "0")}`;
    const expectedEvidenceRefs = stateIndex >= stateOrder.indexOf("D1")
      ? [evidenceId, `gold-history-${String(index + 1).padStart(3, "0")}`]
      : [evidenceId];
    return {
      id: `gold-${String(index + 1).padStart(3, "0")}`,
      revision: 1,
      updated_at: NOW,
      task_type: "customer_nba" as const,
      split: index < 160 ? "development" as const : "holdout" as const,
      scenario: `${industries[index % industries.length]} · ${stateBefore} · ${evidenceStrength}证据${anomaly ? ` · ${anomaly}` : ""}`,
      industry: industries[index % industries.length],
      state_before: stateBefore,
      evidence_strength: evidenceStrength,
      anomaly,
      expected_state: expectedState,
      acceptable_nba: [actionByState[expectedIndex]],
      expected_evidence_refs: expectedEvidenceRefs,
      future_event: index % 13 === 0 ? "quality_reversal" as const : index % 7 === 0 ? "new_evidence" as const : "retained" as const,
      double_reviewed: index % 5 === 0,
      query: `${industries[index % industries.length]}客户 ${stateBefore} 状态下一最佳动作与跟进证据`,
      expected_skill_route: ["enterprise-wechat-friend-marketing", "marketing-growth-system"],
      expected_knowledge_terms: ["证据", "下一动作"],
    };
  });
  const tasks: Array<{ task: Exclude<MarketingTaskType, "customer_nba">; label: string; terms: string[] }> = [
    { task: "weekly_strategy", label: "企微周策略", terms: ["窄市场", "实验"] },
    { task: "content_brief", label: "朋友圈内容 Brief", terms: ["目标客户", "唯一 CTA"] },
    { task: "content_draft", label: "朋友圈草稿", terms: ["证据", "行动"] },
  ];
  const contentCases = tasks.flatMap(({ task, label, terms }, taskIndex) => Array.from({ length: 80 }, (_, index) => {
    const globalIndex = 200 + taskIndex * 80 + index;
    const holdout = index >= 64;
    return {
      id: `gold-${String(globalIndex + 1).padStart(3, "0")}`, revision: 1, updated_at: NOW, task_type: task,
      split: holdout ? "holdout" as const : "development" as const,
      scenario: `${label} · ${industries[index % industries.length]} · ${index % 7 === 0 ? "合规冲突" : "进攻增长"}`,
      industry: industries[index % industries.length], state_before: stateOrder[index % stateOrder.length], evidence_strength: index % 4 === 0 ? "medium" as const : "strong" as const,
      anomaly: index % 7 === 0 ? "增长战术与授权门禁冲突" : null, expected_state: stateOrder[index % stateOrder.length], acceptable_nba: ["继续观察" as const],
      expected_evidence_refs: [`business-${task}-${index + 1}`], future_event: index % 11 === 0 ? "quality_reversal" as const : index % 8 === 0 ? "new_evidence" as const : "retained" as const,
      double_reviewed: index % 5 === 0, query: `${industries[index % industries.length]} ${label} 企微客户分组 进攻增长 证明门禁`,
      expected_skill_route: ["enterprise-wechat-friend-marketing", "marketing-growth-system"], expected_knowledge_terms: terms,
    };
  }));
  return [...nbaCases, ...contentCases];
}

function makeKnowledgeFixtures() {
  const pack: KnowledgePackVersion = {
    id: "knowledge-private-demo", revision: 2, updated_at: NOW, name: "private-pack-demo-v2.2", content_hash: "fixture-private-pack-v22",
    status: "active", source_count: 23, chunk_count: 118, unresolved_count: 2, duplicate_count: 1, indexed_at: date(23, 14), activated_at: date(23, 15), error: null,
  };
  const sourceData = [
    ["source-wechat", "enterprise-wechat-friend-marketing/SKILL.md", "企微好友营销主技能", "enterprise-wechat-friend-marketing", "hard_guardrail", 18],
    ["source-growth", "marketing-growth-system/SKILL.md", "进攻型增长系统", "marketing-growth-system", "operating_principle", 15],
    ["source-enterprise", "enterprise-marketing-brain/SKILL.md", "企业营销大脑", "enterprise-marketing-brain", "operating_principle", 12],
    ["source-global", "global-marketing-brain/SKILL.md", "全球市场营销规则", "global-marketing-brain", "theory", 11],
    ["source-lifecycle", "企业微信好友全生命周期营销手册.md", "企微全生命周期手册", "enterprise-wechat-friend-marketing", "verified_experience", 20],
    ["source-framework", "朋友圈特征与IP属性分析及运营框架_第四轮迭代.md", "朋友圈第四轮框架", "enterprise-wechat-friend-marketing", "operating_principle", 14],
  ] as const;
  const sources: KnowledgeSource[] = sourceData.map(([id, relative_path, title, skill, knowledge_kind, chunk_count]) => ({
    id, revision: 1, updated_at: NOW, pack_version_id: pack.id, relative_path, title, skill, version: "2.2", market: skill === "global-marketing-brain" ? ["north_america", "europe"] : ["china"],
    channels: ["enterprise_wechat"], tasks: ["weekly_strategy", "content_brief", "content_draft", "customer_nba"], lifecycle: ["acquisition", "nurture", "conversion"], stages: ["T", "I", "D", "A"],
    knowledge_kind, status: "ready", content_hash: `fixture-${id}`, chunk_count, error: null,
  }));
  sources.push({ id: "source-unresolved", revision: 1, updated_at: NOW, pack_version_id: pack.id, relative_path: "/external/missing/theory.md", title: "待补理论资料", skill: "marketing-growth-system", version: "unresolved", market: [], channels: [], tasks: [], lifecycle: [], stages: [], knowledge_kind: "theory", status: "unresolved", content_hash: "missing", chunk_count: 0, error: "外部绝对路径不可解析，未进入生成上下文" });
  const retrievalRuns: KnowledgeRetrievalRun[] = (["weekly_strategy", "content_brief", "content_draft", "customer_nba"] as MarketingTaskType[]).map((task, index) => ({
    id: `retrieval-demo-${index + 1}`, revision: 1, updated_at: date(23, 14 + index), task_type: task, query: `${task} 企微增长与证据门禁`, filters: { market: ["china"], channels: ["enterprise_wechat"] },
    skill_route: ["enterprise-wechat-friend-marketing", "marketing-growth-system"], chunk_refs: [`chunk-demo-${index + 1}`], source_refs: [index % 2 ? "source-growth" : "source-wechat"], conflict_count: index === 0 ? 1 : 0,
    latency_ms: 18 + index * 3, result_count: 6 + index % 2, created_at: date(23, 14 + index),
  }));
  const facts: TenantFactVersion[] = [{
    id: "facts-v2.2-published", revision: 2, updated_at: NOW, name: "企业事实 2026-W34", status: "published", content_hash: "fixture-facts-v22", created_by: "林澈", published_by: "周岚", published_at: date(23, 13),
    facts: [
      { id: "fact-product-01", type: "product_truth", title: "产品能力边界", statement: "系统提供可追溯客户状态与下一动作建议，不自动发布、私聊或发送 Offer。", status: "published", markets: ["china"], channels: ["enterprise_wechat"], evidence_refs: [], valid_from: "2026-08-01", expires_at: null },
      { id: "fact-expert-01", type: "expert_position", title: "专家立场", statement: "增长判断必须回到带时间的客户证据和可执行下一步。", status: "published", markets: ["china"], channels: ["enterprise_wechat"], evidence_refs: [], valid_from: "2026-08-01", expires_at: null },
      { id: "fact-voice-01", type: "brand_voice", title: "品牌语气", statement: "直接、克制、事实优先，不夸大承诺，不用焦虑驱动成交。", status: "published", markets: ["china"], channels: ["enterprise_wechat"], evidence_refs: [], valid_from: "2026-08-01", expires_at: null },
      { id: "fact-offer-01", type: "offer_definition", title: "Dogfood Offer", statement: "4 周内部试点，范围和价格在人工诊断后确认。", status: "published", markets: ["china"], channels: ["enterprise_wechat"], evidence_refs: ["proof-01"], valid_from: "2026-08-01", expires_at: "2026-12-31" },
    ],
  }];
  const brains: MarketingBrainVersion[] = [
    {
      id: "brain-v2.1-baseline", revision: 2, updated_at: date(10), name: "营销大脑 2.1 基线", status: "archived",
      prompt_hashes: { weekly_strategy: "legacy-weekly-v21", content_brief: "legacy-brief-v21", content_draft: "legacy-draft-v21", customer_nba: "legacy-nba-v21" },
      skill_router_version: "skill-router-v2.1", retriever_version: "none", knowledge_pack_version_id: "none", tenant_fact_version_id: facts[0].id,
      model_router_version_id: "router-v2.0", policy_version: "policy-v2.1", created_by: "系统", published_by: "周岚", published_at: date(10),
    },
    {
      id: "brain-v2.2-published", revision: 2, updated_at: NOW, name: "营销大脑 2.2-RC1", status: "published",
      prompt_hashes: { weekly_strategy: "prompt-weekly-a91f", content_brief: "prompt-brief-4c23", content_draft: "prompt-draft-18db", customer_nba: "prompt-nba-730a" },
      skill_router_version: "skill-router-v2.2", retriever_version: "fts5-trigram-v2.2", knowledge_pack_version_id: pack.id, tenant_fact_version_id: facts[0].id,
      model_router_version_id: "router-v2.1-rc1", model_profile_version_id: "model-profile-openai", policy_version: "policy-v2.2", created_by: "林澈", published_by: "周岚", published_at: NOW,
    },
    {
      id: "brain-v2.2-rc2", revision: 1, updated_at: NOW, name: "营销大脑 2.2-RC2", status: "draft",
      prompt_hashes: { weekly_strategy: "code-weekly-v22rc2", content_brief: "code-brief-v22rc2", content_draft: "code-draft-v22rc2", customer_nba: "code-nba-v22rc2" },
      skill_router_version: "skill-router-v2.2", retriever_version: "fts5-trigram-v2.2", knowledge_pack_version_id: pack.id, tenant_fact_version_id: facts[0].id,
      model_router_version_id: "router-v2.1-rc1", model_profile_version_id: "model-profile-openai", policy_version: "policy-v2.2", created_by: "代码发布流程", published_by: null, published_at: null,
    },
  ];
  return { pack, sources, retrievalRuns, facts, brains };
}

function makeMarketingDecisionFixtures(customers: Customer[], drafts: Draft[], briefs: ContentBrief[], knowledge: ReturnType<typeof makeKnowledgeFixtures>) {
  const publishedBrain = knowledge.brains.find((item) => item.status === "published")!;
  const taskTypes: MarketingTaskType[] = ["weekly_strategy", "content_brief", "content_draft", "customer_nba"];
  const outputs: Record<MarketingTaskType, MarketingDecisionOutput> = {
    weekly_strategy: createFixtureStateBaseStrategy(),
    content_brief: { title: briefs[0].title, target_segment: briefs[0].target_segment, stage: briefs[0].stage, primary_angle: briefs[0].primary_angle, key_facts: briefs[0].key_facts, proof_requirements: briefs[0].proof_requirements, cta: briefs[0].cta, due_at: briefs[0].due_at, insight_refs: briefs[0].insight_ids },
    content_draft: { title: drafts[0].title, stage: drafts[0].stage, target_segment: drafts[0].segment, objective: drafts[0].objective, body: drafts[0].body, cta: drafts[0].cta, expected_transition: drafts[0].expected_transition, evidence_refs: drafts[0].evidence_refs, risk_flags: drafts[0].risk_flags, approval_required: drafts[0].approval_required },
    customer_nba: customers[0].evaluation!,
  };
  const candidates: MarketingDecisionCandidate[] = [];
  const decisions: MarketingDecisionDecision[] = [];
  for (let index = 0; index < 16; index += 1) {
    const task = taskTypes[index % 4];
    const subject = task === "customer_nba" ? customers[index % customers.length] : task === "content_draft" ? drafts[index % drafts.length] : task === "content_brief" ? briefs[index % briefs.length] : null;
    const candidateId = `marketing-candidate-${String(index + 1).padStart(2, "0")}`;
    const decided = index < 12;
    const decisionKind = index % 7 === 0 ? "modified" as const : index % 11 === 0 ? "rejected" as const : "accepted" as const;
    const createdAt = date(15 + (index % 7), 9 + (index % 6));
    const decisionId = decided ? `marketing-decision-${String(index + 1).padStart(2, "0")}` : null;
    const output = task === "customer_nba" && subject ? (subject as Customer).evaluation! : outputs[task];
    const knowledgeRef = { chunk_id: `chunk-demo-${index % 4 + 1}`, source_id: index % 2 ? "source-growth" : "source-wechat", source_title: index % 2 ? "进攻型增长系统" : "企微好友营销主技能", heading_path: ["营销决策", "证据与动作"], knowledge_kind: index % 2 ? "operating_principle" as const : "hard_guardrail" as const, skill: index % 2 ? "marketing-growth-system" : "enterprise-wechat-friend-marketing", version: "2.2", excerpt: "聚焦窄市场，以带时间的有效证据选择下一动作；授权与事实门禁优先。", score: 8.2 };
    candidates.push({
      id: candidateId, revision: decided ? 2 : 1, updated_at: createdAt, task_type: task, subject_id: subject?.id ?? "weekly-plan", subject_revision: subject?.revision ?? 1,
      evidence_fingerprint: `fixture-${task}-${subject?.id ?? "weekly"}`, envelope: { task_type: task, output, business_evidence_refs: task === "customer_nba" ? (output as Customer["evaluation"])!.evidence_refs : ["insight-01", "proof-01"], knowledge_refs: [knowledgeRef],
        skill_route: ["enterprise-wechat-friend-marketing", "marketing-growth-system"], assumptions: ["本周服务容量维持 3 个诊断名额"], knowledge_conflicts: index % 6 === 0 ? ["进攻频率受当前服务容量门禁约束"] : [],
        measurement_plan: ["48 小时记录采用结果", "发布后 7 天复查业务结果"], growth_posture: "aggressive", ai_meta: { model: "gpt-5.6", provider: "openai", protocol: "openai_responses", endpoint_scope: "public_cloud", connection_profile_id: "connection-openai", model_profile_version_id: "model-profile-openai", response_id: `resp-marketing-${index + 1}`, prompt_version: `code-${task}-v2.2`, generated_at: createdAt, router_version: "global-profile-v2.3", route_reason: "global_primary", attempts: 1, latency_ms: 4300 + index * 120, input_tokens: 880 + index * 7, output_tokens: 310 + index * 3, fallback_from: null },
        knowledge_pack_version: knowledge.pack.id, tenant_fact_version: knowledge.facts[0].id, marketing_brain_version: publishedBrain.id, prompt_hash: publishedBrain.prompt_hashes[task], input_fingerprint: `input-${index + 1}` },
      status: decided ? decisionKind : "pending", created_at: createdAt, expires_at: date(28, 18), decided_at: decided ? date(16 + (index % 7), 11) : null, decision_id: decisionId,
    });
    if (decided && decisionId) decisions.push({
      id: decisionId, revision: index < 8 ? 2 : 1, updated_at: date(23, 12), candidate_id: candidateId, task_type: task, subject_id: subject?.id ?? "weekly-plan", decision: decisionKind,
      original_output: output, final_output: decisionKind === "rejected" ? null : output, reason_code: decisionKind === "accepted" ? null : index % 2 ? "knowledge_not_applicable" : "voice_mismatch",
      reason_note: decisionKind === "accepted" ? "" : "合成 2.2 盲测反馈", actor: task === "customer_nba" ? "陈牧" : "林澈", decided_at: date(16 + (index % 7), 11), reviewed_within_48h: index % 9 !== 0,
      review_outcome: index < 8 ? (index === 4 ? "quality_reversal" : index === 5 ? "new_evidence" : "retained") : null, review_reason: index === 4 ? "知识适用范围判断错误" : index === 5 ? "新增业务证据" : "", reviewed_at: index < 8 ? date(23, 11) : null,
    });
  }
  return { candidates, decisions };
}

function createFixtureStateBaseStrategy() {
  return {
    theme: "聚焦跟进失控的 5-10 人企服销售团队", objective: "用高密度证据内容推动有效咨询", target_segments: ["T1 / I1 · 5-10 人企服销售团队"],
    ratio: { trust: 40, interest: 30, desire: 20, action: 10 }, evidence_gaps: ["同行业授权案例不足"],
    content_slots: [{ day: "周一", stage: "T" as const, topic: "跟进失控的三个迹象", cta: "领取检查清单" }, { day: "周二", stage: "I" as const, topic: "状态证据看板", cta: "查看 Demo" }, { day: "周四", stage: "D" as const, topic: "7 人团队过程案例", cta: "回复案例" }, { day: "周五", stage: "A" as const, topic: "4 周试点边界", cta: "预约诊断" }],
    evidence_refs: ["insight-01", "proof-01"], risk_flags: [], next_review_at: date(25, 10),
  };
}

function makeQualityFixtures(customers: Customer[]) {
  const generationRuns: GenerationRun[] = [];
  const candidates: EvaluationCandidate[] = [];
  const decisions: EvaluationDecision[] = [];
  for (let index = 0; index < 30; index += 1) {
    const customer = customers[index % customers.length];
    const runId = `run-${String(index + 1).padStart(2, "0")}`;
    const candidateId = `candidate-${String(index + 1).padStart(2, "0")}`;
    const decided = index < 24;
    const createdAt = date(12 + (index % 11), 9 + (index % 7));
    const providerConfig = index < 18
      ? { provider: "openai" as const, protocol: "openai_responses" as const, scope: "public_cloud" as const, profile: "model-profile-openai", primary: "gpt-5.6", fallback: "gpt-5.6-terra" }
      : index < 24
        ? { provider: "deepseek" as const, protocol: "openai_responses" as const, scope: "public_cloud" as const, profile: "model-profile-deepseek", primary: "deepseek-chat", fallback: "deepseek-reasoner" }
        : index < 27
          ? { provider: "qwen" as const, protocol: "openai_responses" as const, scope: "public_cloud" as const, profile: "model-profile-qwen", primary: "qwen3.8-max", fallback: "qwen3.7-plus" }
          : index < 29
            ? { provider: "anthropic" as const, protocol: "anthropic_messages" as const, scope: "public_cloud" as const, profile: "model-profile-anthropic", primary: "claude-sonnet-4-5-20250929", fallback: null }
            : { provider: "custom" as const, protocol: "openai_chat" as const, scope: "private" as const, profile: "model-profile-private", primary: "enterprise-marketing-32b", fallback: "enterprise-marketing-14b" };
    const escalated = index % 8 === 0;
    const model = escalated && providerConfig.fallback ? providerConfig.fallback : providerConfig.primary;
    const fingerprint = evidenceFingerprint(customer);
    const decision = index % 6 === 0 ? "modified" as const : index % 9 === 0 ? "rejected" as const : "accepted" as const;
    const decisionId = decided ? `decision-${String(index + 1).padStart(2, "0")}` : null;
    const meta = {
      model, provider: providerConfig.provider, protocol: providerConfig.protocol, endpoint_scope: providerConfig.scope, connection_profile_id: `connection-${providerConfig.provider === "custom" ? "private" : providerConfig.provider}`, model_profile_version_id: providerConfig.profile,
      response_id: `resp-quality-${index + 1}`, prompt_version: index < 12 ? "customer-eval-v2.0.0" : "customer-eval-v2.3.0", generated_at: createdAt,
      router_version: "global-profile-v2.3", route_reason: escalated && providerConfig.fallback ? "global_fallback:RATE_LIMITED" : "global_primary", attempts: escalated && providerConfig.fallback ? 2 : 1,
      latency_ms: 4200 + index * 170, input_tokens: 720 + index * 4, output_tokens: 260 + index * 3,
      escalated_from: escalated && providerConfig.fallback ? providerConfig.primary : null, fallback_from: escalated && providerConfig.fallback ? providerConfig.primary : null, input_fingerprint: fingerprint,
    };
    generationRuns.push({
      id: runId, revision: 1, updated_at: createdAt, task: "customer_evaluation", subject_id: customer.id, status: "success", provider: providerConfig.provider, protocol: providerConfig.protocol, endpoint_scope: providerConfig.scope, connection_profile_id: meta.connection_profile_id, model_profile_version_id: providerConfig.profile, model, prompt_version: meta.prompt_version,
      router_version: meta.router_version, route_reason: meta.route_reason, attempts: escalated
        && providerConfig.fallback ? [{ provider: providerConfig.provider, protocol: providerConfig.protocol, endpoint_scope: providerConfig.scope, model: providerConfig.primary, status: "escalated", latency_ms: 2100, response_id: null, error_code: "RATE_LIMITED" }, { provider: providerConfig.provider, protocol: providerConfig.protocol, endpoint_scope: providerConfig.scope, model: providerConfig.fallback, status: "success", latency_ms: meta.latency_ms - 2100, response_id: meta.response_id, error_code: null }]
        : [{ provider: providerConfig.provider, protocol: providerConfig.protocol, endpoint_scope: providerConfig.scope, model, status: "success", latency_ms: meta.latency_ms, response_id: meta.response_id, error_code: null }],
      latency_ms: meta.latency_ms, input_tokens: meta.input_tokens, output_tokens: meta.output_tokens, input_fingerprint: meta.input_fingerprint, response_id: meta.response_id, error_code: null, created_at: createdAt,
    });
    candidates.push({
      id: candidateId, revision: decided ? 2 : 1, updated_at: decided ? date(13 + (index % 10), 11) : createdAt, customer_id: customer.id, customer_revision: customer.revision,
      evidence_fingerprint: meta.input_fingerprint, evaluation: customer.evaluation!, ai_meta: meta, run_id: runId, status: decided ? decision : "pending", created_at: createdAt,
      expires_at: date(27, 18), decided_at: decided ? date(13 + (index % 10), 11) : null, decision_id: decisionId,
    });
    if (decided && decisionId) {
      const reviewOutcome = index < 16 ? (index % 11 === 0 ? "quality_reversal" as const : index % 7 === 0 ? "new_evidence" as const : "retained" as const) : null;
      decisions.push({
        id: decisionId, revision: reviewOutcome ? 2 : 1, updated_at: date(20 + (index % 3), 14), candidate_id: candidateId, customer_id: customer.id, decision,
        original_evaluation: customer.evaluation!, final_evaluation: decision === "rejected" ? null : customer.evaluation!,
        reason_code: decision === "accepted" ? null : decision === "modified" ? "wrong_nba" : "missing_context", reason_note: decision === "accepted" ? "" : "合成盲测反馈",
        actor: "陈牧", decided_at: date(13 + (index % 10), 11), reviewed_within_48h: index % 10 !== 0, review_outcome: reviewOutcome,
        review_reason: reviewOutcome === "quality_reversal" ? "状态依据不足" : reviewOutcome === "new_evidence" ? "出现新的主动咨询" : "", reviewed_at: reviewOutcome ? date(20 + (index % 3), 14) : null,
      });
    }
  }
  return { generationRuns, candidates, decisions };
}

function makeAiVersions() {
  const prompts: PromptVersion[] = [
    { id: "prompt-v2.0", revision: 2, updated_at: date(10), name: "customer-eval-v2.0.0", task: "customer_evaluation", status: "published", description: "2.0 盲测基线", created_by: "系统", published_by: "周岚", published_at: date(10) },
    { id: "prompt-v2.1-rc1", revision: 1, updated_at: NOW, name: "customer-eval-v2.1.0-rc1", task: "customer_evaluation", status: "draft", description: "证据分层、未知项与 NBA 约束", created_by: "林澈", published_by: null, published_at: null },
  ];
  const routers: RouterVersion[] = [
    { id: "router-v2.0", revision: 3, updated_at: NOW, name: "router-v2.0-single", status: "archived", primary_model: "gpt-5.6", fast_model: "gpt-5.6", confidence_threshold: 0, description: "2.0 单模型基线，已迁移为归档 Profile", created_by: "系统", published_by: "周岚", published_at: date(10) },
    { id: "router-v2.1-rc1", revision: 2, updated_at: NOW, name: "router-v2.1-risk-first", status: "archived", primary_model: "gpt-5.6", fast_model: "gpt-5.6-terra", confidence_threshold: 75, description: "2.1 动态路由基线，仅供旧评测兼容", created_by: "林澈", published_by: null, published_at: null },
  ];
  const evalRuns: EvalRun[] = [{
    id: "eval-baseline-holdout", revision: 1, updated_at: NOW, marketing_brain_version_id: "brain-v2.1-baseline", prompt_version_id: "prompt-v2.0", router_version_id: "router-v2.0", split: "holdout", mode: "replay", status: "completed", case_count: 40,
    score: { state_accuracy: 77.5, nba_acceptability: 72.5, evidence_precision: 100, policy_violations: 0, privacy_leaks: 0, first_draft_adoption: 55, adoption_improvement_points: 0, critical_slice_regression: 0, p95_latency_ms: 24800, macro_adoption_rate: 55, review_coverage_rate: 80, task_adoption_rates: { weekly_strategy: 56, content_brief: 54, content_draft: 58, customer_nba: 52 }, knowledge_recall_at_5: 72, knowledge_citation_precision: 96, business_evidence_precision: 94, forbidden_source_hits: 0, unsupported_facts: 2, passed: false },
    started_at: date(21, 9), completed_at: date(21, 10), generated_by: "系统盲测",
  }];
  return { prompts, routers, evalRuns };
}

function makeProviderProfiles() {
  const capability = (tested: boolean, notes: string[] = []) => ({
    structured_output: tested,
    native_json_schema: tested,
    refusal_signal: tested,
    usage_reporting: tested,
    request_id: tested,
    tested_at: tested ? NOW : null,
    notes,
  });
  const connections = [
    { id: "connection-openai", revision: 2, updated_at: NOW, tenant_id: "tenant-dogfood-cn", name: "OpenAI 官方云", provider: "openai" as const, endpoint_scope: "public_cloud" as const, protocol: "openai_responses" as const, base_url: "https://api.openai.com/v1", region: "global", auth_mode: "bearer" as const, credential_source: "environment" as const, credential_ref: "OPENAI_API_KEY", credential_available: false, capabilities: capability(true, ["Responses Structured Outputs"]), last_tested_at: NOW, last_error_code: null, created_by: "系统迁移" },
    { id: "connection-deepseek", revision: 1, updated_at: NOW, tenant_id: "tenant-dogfood-cn", name: "DeepSeek 官方云", provider: "deepseek" as const, endpoint_scope: "public_cloud" as const, protocol: "openai_responses" as const, base_url: "https://api.deepseek.com", region: "global", auth_mode: "bearer" as const, credential_source: "none" as const, credential_ref: "DEEPSEEK_API_KEY", credential_available: false, capabilities: capability(false), last_tested_at: null, last_error_code: null, created_by: "林澈" },
    { id: "connection-anthropic", revision: 1, updated_at: NOW, tenant_id: "tenant-dogfood-cn", name: "Anthropic 官方云", provider: "anthropic" as const, endpoint_scope: "public_cloud" as const, protocol: "anthropic_messages" as const, base_url: "https://api.anthropic.com", region: "global", auth_mode: "x-api-key" as const, credential_source: "none" as const, credential_ref: "ANTHROPIC_API_KEY", credential_available: false, capabilities: capability(false), last_tested_at: null, last_error_code: null, created_by: "林澈" },
    { id: "connection-qwen", revision: 1, updated_at: NOW, tenant_id: "tenant-dogfood-cn", name: "Qwen 百炼中国站", provider: "qwen" as const, endpoint_scope: "public_cloud" as const, protocol: "openai_responses" as const, base_url: "https://dashscope.aliyuncs.com/compatible-mode/v1", region: "cn-beijing", auth_mode: "bearer" as const, credential_source: "none" as const, credential_ref: "DASHSCOPE_API_KEY", credential_available: false, capabilities: capability(false), last_tested_at: null, last_error_code: null, created_by: "林澈" },
    { id: "connection-private", revision: 1, updated_at: NOW, tenant_id: "tenant-dogfood-cn", name: "企业私有模型", provider: "custom" as const, endpoint_scope: "private" as const, protocol: "openai_chat" as const, base_url: "http://127.0.0.1:8000/v1", region: "enterprise-local", auth_mode: "none" as const, credential_source: "none" as const, credential_ref: null, credential_available: true, capabilities: capability(false, ["等待连接测试"]), last_tested_at: null, last_error_code: null, created_by: "林澈" },
  ];
  const profile = (id: string, name: string, connectionId: string, provider: "openai" | "deepseek" | "anthropic" | "qwen" | "custom", protocol: "openai_responses" | "openai_chat" | "anthropic_messages", scope: "public_cloud" | "private", primary: string, fallback: string | null, status: "active" | "trial_ready" | "connection_verified" | "draft") => ({
    id, revision: status === "active" ? 2 : 1, updated_at: NOW, tenant_id: "tenant-dogfood-cn", name, connection_profile_id: connectionId, provider, protocol, endpoint_scope: scope, primary_model: primary, fallback_model: fallback, status,
    smoke_passed_at: status === "trial_ready" || status === "active" ? NOW : null, smoke_case_count: status === "trial_ready" || status === "active" ? 14 : 0, holdout_run_id: status === "active" ? "eval-baseline-holdout" : null,
    data_egress_acknowledged_by: status === "active" ? "周岚" : null, data_egress_acknowledged_at: status === "active" ? NOW : null, activated_by: status === "active" ? "周岚" : null, activated_at: status === "active" ? NOW : null, previous_profile_id: null, created_by: status === "active" ? "系统迁移" : "林澈",
  });
  const profiles = [
    profile("model-profile-openai", "OpenAI 全局主模型", "connection-openai", "openai", "openai_responses", "public_cloud", "gpt-5.6", "gpt-5.6-terra", "active"),
    profile("model-profile-deepseek", "DeepSeek 试用候选", "connection-deepseek", "deepseek", "openai_responses", "public_cloud", "deepseek-chat", "deepseek-reasoner", "trial_ready"),
    profile("model-profile-anthropic", "Anthropic 连接候选", "connection-anthropic", "anthropic", "anthropic_messages", "public_cloud", "claude-sonnet-4-5-20250929", null, "draft"),
    profile("model-profile-qwen", "Qwen 试用候选", "connection-qwen", "qwen", "openai_responses", "public_cloud", "qwen3.8-max", "qwen3.7-plus", "trial_ready"),
    profile("model-profile-private", "企业私有模型候选", "connection-private", "custom", "openai_chat", "private", "enterprise-marketing-32b", "enterprise-marketing-14b", "connection_verified"),
  ];
  return { connections, profiles };
}

export function createFixtureState(): DomainState {
  const customers = makeCustomers();
  const archive = makeArchive(customers);
  const conversationInsights = makeInsights();
  const briefs = makeBriefs();
  const publicationHistory = makePublicationHistory();
  const quality = makeQualityFixtures(customers);
  const versions = makeAiVersions();
  const providers = makeProviderProfiles();
  const knowledge = makeKnowledgeFixtures();
  const drafts = makeDrafts();
  const marketing = makeMarketingDecisionFixtures(customers, drafts, briefs, knowledge);
  return {
    fixture_version: 8,
    role: "operations",
    week: 2,
    weekly_plan: {
      status: "ready",
      generated_by: "规则基线 V0.3",
      generated_at: NOW,
      strategy: {
        theme: "线索跟进不靠销售记忆",
        objective: "让高价值线索在 24 小时内有可解释的下一动作",
        target_segments: ["T1 / I1 长期培育", "D1 / A1 高价值机会"],
        ratio: { trust: 50, interest: 20, desire: 20, action: 10 },
        evidence_gaps: ["D1 同行业案例不足", "微信客服身份匹配仍有缺口"],
        content_slots: [
          { day: "周一", stage: "T", topic: "跟进失控的三个迹象", cta: "领取检查清单" },
          { day: "周二", stage: "T", topic: "强弱证据分级", cta: "查看分级表" },
          { day: "周四", stage: "I", topic: "客户状态看板场景", cta: "预约 Demo" },
          { day: "周五", stage: "D", topic: "7 人团队过程案例", cta: "回复案例" },
        ],
        evidence_refs: ["proof-01", "proof-03"],
        risk_flags: [],
        next_review_at: date(25, 10),
      },
    },
    customers,
    drafts,
    proofs: makeProofs(),
    approvals: makeApprovals(),
    tasks: makeTasks(customers),
    integrations: makeIntegrations(),
    archive_consents: archive.consents,
    archive_conversations: archive.conversations,
    archived_messages: archive.messages,
    conversation_insights: conversationInsights,
    content_briefs: briefs,
    content_families: makeContentFamilies(),
    publications: publicationHistory.publications,
    content_outcomes: publicationHistory.outcomes,
    analysis_batches: makeAnalysisBatches(conversationInsights, archive.messages),
    weekly_retrospective: {
      id: "retrospective-week-04", revision: 1, updated_at: NOW, week_label: "第 4 周", generated_by: "规则基线 V0.4", ai_meta: null,
      retrospective: {
        week_label: "第 4 周", summary: "流程失控和实施成本是本周最稳定的内容机会，结果层仍需更多销售回填。",
        top_themes: [{ theme: "跟进依赖个人记忆", reason: "跨 3 个有效会话且带来 2 次业务咨询", business_results: 2 }],
        bottlenecks: ["1 条发布记录尚未同步互动", "量化过程证明覆盖不足"],
        next_week_candidates: [{ theme: "最少字段启动跟进复盘", objective: "降低实施成本异议", evidence_refs: ["insight-02", "insight-06"] }],
        caveat: "时间关联，不代表因果",
      },
    },
    generation_runs: quality.generationRuns,
    evaluation_candidates: quality.candidates,
    evaluation_decisions: quality.decisions,
    prompt_versions: versions.prompts,
    router_versions: versions.routers,
    provider_connections: providers.connections,
    model_profiles: providers.profiles,
    golden_cases: makeGoldenCases(),
    eval_runs: versions.evalRuns,
    knowledge_pack_versions: [knowledge.pack],
    knowledge_sources: knowledge.sources,
    knowledge_retrieval_runs: knowledge.retrievalRuns,
    tenant_fact_versions: knowledge.facts,
    marketing_brain_versions: knowledge.brains,
    marketing_candidates: marketing.candidates,
    marketing_decisions: marketing.decisions,
    audits: [
      { id: "audit-01", actor: "系统", action: "生成周策略", detail: "主题：线索跟进不靠销售记忆", at: NOW, source: "system" },
      { id: "audit-02", actor: "林澈", action: "提交敏感审批", detail: "7 人销售团队案例", at: date(23, 11), source: "human" },
      { id: "audit-03", actor: "系统", action: "阻断失效证据", detail: "proof-05 授权已撤销", at: date(21, 10), source: "system" },
    ],
  };
}

export { STATE_LABELS };
