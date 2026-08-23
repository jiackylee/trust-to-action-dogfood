import type { Approval, DomainState, Draft, Integration, Proof, Task } from "./types";
import type { Customer } from "./types";
import { STATE_LABELS, type StateCode } from "./schemas";

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
      },
      evaluation_meta: { model: "规则基线 V0.3", response_id: `fixture-${id}`, prompt_version: "fixture-v2" },
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
  ] as const;
  return data.map((item, index) => ({
    id: `draft-${String(index + 1).padStart(2, "0")}`,
    revision: 1,
    updated_at: date(23 - (index % 3), 9 + index),
    title: item[0], stage: item[1], segment: item[2], objective: item[3], body: item[4], cta: item[5], expected_transition: item[6],
    evidence_refs: [...item[7]], risk_flags: item[8] ? [index === 2 ? "客户证明" : "价格 / Offer"] : [], approval_required: item[8], approval_status: item[9], status: item[10], published_at: null, result: null,
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
    { id: "approval-01", object_id: "draft-03", title: "7 人销售团队如何减少线索遗漏", type: "客户证明 + 量化结果", requester: "林澈", approver: "周岚", status: "pending", summary: "引用 proof-01，包含团队规模与量化结果。", reason: "", due_at: date(23, 18), revision: 1, updated_at: NOW },
    { id: "approval-02", object_id: "draft-04", title: "Dogfood 试点实施边界", type: "Offer + 价格 / 排期", requester: "林澈", approver: "周岚", status: "returned", summary: "包含排期与实施范围表述。", reason: "缺少已确认的真实容量依据。", due_at: date(23, 12), revision: 2, updated_at: date(22, 17) },
    { id: "approval-03", object_id: "proof-03", title: "48 小时结果回填机制", type: "量化结果 + 官网使用", requester: "林澈", approver: "周岚", status: "approved", summary: "证据与授权完整。", reason: "必须说明 21 天观察期。", due_at: date(21, 18), revision: 2, updated_at: date(21, 16) },
    { id: "approval-04", object_id: "proof-04", title: "微信客服匹配失败反馈", type: "客户反馈 + 潜在投诉", requester: "陈牧", approver: "周岚", status: "pending", summary: "当前仅允许内部复盘。", reason: "", due_at: date(24, 10), revision: 1, updated_at: NOW },
  ];
}

function makeTasks(customers: Customer[]): Task[] {
  return customers.slice(0, 10).map((customer, index) => ({ id: `task-${index + 1}`, revision: 1, updated_at: NOW, customer_id: customer.id, title: `${customer.evaluation?.recommendation ?? "继续观察"} · ${customer.name}`, type: customer.evaluation?.recommendation ?? "继续观察", owner: customer.owner, priority: index < 3 ? "high" : index < 7 ? "medium" : "low", due_at: index < 2 ? date(22, 18) : date(24 + (index % 3), 17), status: index === 4 ? "done" : index === 5 ? "executed" : "pending", outcome: index === 4 ? "客户确认周三参加 Demo。" : "" }));
}

function makeIntegrations(): Integration[] {
  return [
    { id: "source-customers", revision: 1, updated_at: NOW, name: "企微客户与标签", description: "客户详情、负责人、标签和来源", scope: "3 名销售 · 24 位合成客户", status: "healthy", last_success_at: NOW, freshness: "8 分钟", cursor: "ext_demo_24", error: "" },
    { id: "source-moments", revision: 1, updated_at: NOW, name: "客户朋友圈", description: "记录、覆盖、评论和点赞弱信号", scope: "近 30 天 · 18 条记录", status: "delayed", last_success_at: date(23, 12), freshness: "3 小时", cursor: "mom_demo_18", error: "互动明细仍在分批同步。" },
    { id: "source-kf", revision: 1, updated_at: NOW, name: "微信客服", description: "回调触发与近 3 天消息", scope: "2 个客服账号 · 9 个会话", status: "partial", last_success_at: date(23, 14), freshness: "46 分钟", cursor: "kf_demo_09", error: "1 个会话无法关联客户。" },
    { id: "source-stats", revision: 1, updated_at: NOW, name: "联系客户统计", description: "成员级新增、聊天和删除趋势", scope: "应用缺少统计只读权限", status: "unauthorized", last_success_at: null, freshness: "不可用", cursor: "未建立", error: "API 未授权；不会参与单客户判断。" },
  ];
}

export function createFixtureState(): DomainState {
  const customers = makeCustomers();
  return {
    fixture_version: 2,
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
    drafts: makeDrafts(),
    proofs: makeProofs(),
    approvals: makeApprovals(),
    tasks: makeTasks(customers),
    integrations: makeIntegrations(),
    audits: [
      { id: "audit-01", actor: "系统", action: "生成周策略", detail: "主题：线索跟进不靠销售记忆", at: NOW, source: "system" },
      { id: "audit-02", actor: "林澈", action: "提交敏感审批", detail: "7 人销售团队案例", at: date(23, 11), source: "human" },
      { id: "audit-03", actor: "系统", action: "阻断失效证据", detail: "proof-05 授权已撤销", at: date(21, 10), source: "system" },
    ],
  };
}

export { STATE_LABELS };
