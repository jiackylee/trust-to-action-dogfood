# Trust-to-Action 2.2 营销大脑知识增强产品方案

## 1. 版本定位

2.2 将项目已有的企微营销 SKILLS、精选理论、已验证经验和企业事实接入本周策略、内容 Brief、朋友圈草稿与客户 NBA。系统仍服务于企业微信营销闭环，客户、会话、内容与业务结果均使用合成数据，不接真实企微、生产身份或客户数据库。

本版默认采用进攻型增长姿态：聚焦窄市场、提高内容密度、快速运行可测实验、放大有效组合。以下确定性规则始终优先：同意与授权、事实真实性、频控、服务容量、客户证明审批、隐私治理、禁止自动发布、禁止自动私聊、禁止自动报价和 Offer 发送。

## 2. North Star

North Star 为四类输出的“决策有效采用率”：

1. 分别统计 `weekly_strategy`、`content_brief`、`content_draft`、`customer_nba`。
2. 分母为 48 小时内已审阅并完成 7 天复查的候选。
3. 分子为原样采用，且 7 天内未因 AI 判断错误撤销的候选。
4. 新增证据导致的正常迁移不算质量失败。
5. 四类采用率等权平均，不按候选量加权。

发布目标：宏平均不低于 70%，较 2.1 同集盲测基线提升至少 15pp，审阅覆盖率不低于 80%，任何单类不低于 60%。

## 3. 用户与职责

| 角色 | 核心职责 | 2.2 权限 |
| --- | --- | --- |
| 运营 | 经营策略、洞察、Brief、草稿、企业事实维护 | 审阅策略/Brief/草稿候选；预览知识检索；运行离线评测 |
| 销售 | 客户状态、NBA、动作执行与结果 | 仅审阅本人客户 NBA；记录修改、拒绝与 7 天复查 |
| 负责人 | 风险审批与版本治理 | 重新索引、激活/回滚知识版本；发布企业事实和营销脑；处理敏感审批 |

运营不获得会话原文访问能力。销售只看本人会话原文，负责人按用途审计后查看全部原文。知识治理不会扩大客户数据可见范围。

## 4. 知识架构

### 4.1 私有知识包

完整知识通过 BFF 环境变量 `KNOWLEDGE_PACK_PATH` 只读挂载。公开仓库仅保存：

- 类型、Schema、索引器、Prompt builder 和测试。
- 脱敏合成元数据与示例。
- 不包含完整 SKILL 正文、references、书籍、真实企业资料或无法公开的理论来源。

未配置可读目录、未建立索引或未激活版本时返回 `KNOWLEDGE_NOT_CONFIGURED`，四类生成全部阻断，不允许静默退化为通用 Prompt。

允许进入完整知识包的来源：

- `enterprise-wechat-friend-marketing` 及全部 references。
- `marketing-growth-system` 及全部 references。
- `enterprise-marketing-brain` 及全部 references。
- `global-marketing-brain` 及全部 references。
- 企业微信好友全生命周期营销手册。
- 朋友圈第四轮框架。
- Trust-to-Action Agent 化方案。
- 客户分组营销技能树。
- 个人 Marketing 技能树与理论框架。

排除 `books-markdown/`、旧版朋友圈迭代、重复内容及无法解析的外部绝对路径。`theory-library.md` 中缺失的绝对路径记录为 `unresolved`，不建立知识块，也不能参与生成或引用。

### 4.2 分块与索引

- Markdown 标题感知分块，保留完整标题路径。
- 目标块长 400–1600 中文字，块间保留约 120 字重叠。
- 每块记录来源、SKILL、标题路径、版本、内容哈希、市场、渠道、任务、生命周期、T/I/D/A 阶段和知识类型。
- SQLite FTS5 使用 `trigram` tokenizer 支持本地中文检索。
- 先按任务、市场、渠道、阶段和 SKILL 路由过滤，再按 BM25 排序。
- 单次最多 8 块，每来源最多 2 块，总上下文不超过约 6000 中文字。
- 不使用 OpenAI File Search 或 Embeddings，不向外部服务上传完整知识包。

知识类型固定为：

`hard_guardrail`、`operating_principle`、`verified_experience`、`experience_baseline`、`theory`、`test_hypothesis`、`prohibited_action`。

理论与经验只能解释策略，不能替代产品事实、客户证明、授权或成交事实。

### 4.3 SKILL 路由

| 条件 | 加载 SKILL |
| --- | --- |
| 所有企微核心任务 | `enterprise-wechat-friend-marketing` |
| 默认增长姿态 | `marketing-growth-system` |
| 明确跨渠道、CRM、官网、邮件或组织协同 | `enterprise-marketing-brain` |
| 明确北美、美国、加拿大、欧洲、欧盟或欧洲国家 | `global-marketing-brain` |

默认路由为前两套。全球 SKILL 不因英文词或一般“国际化”表述自动触发。

### 4.4 冲突优先级

1. 系统、隐私、合规与确定性策略。
2. 已发布企业事实与有效业务证据。
3. 企业微信领域规则。
4. 匹配市场的专用规则。
5. 进攻型增长战术。
6. 通用理论。

无法通过该顺序自动消解的冲突写入 `knowledge_conflicts`，由审阅人判断。模型不能隐藏冲突，也不能用增长目标解除门禁。

## 5. 企业事实层

企业事实对象包括：

- `ProductTruth`：已存在的产品能力和明确非能力。
- `ExpertPosition`：企业公开坚持的专业判断。
- `BrandVoice`：措辞、语气和禁用表达。
- `OfferDefinition`：有效期、范围、容量、交付与人工确认边界。
- `Proof`：现有客户证明、授权范围、有效期和适用渠道。

运营维护事实草稿，负责人发布。只有 `published`、已生效、未过期、未撤销的事实进入模型。任何事实版本发布、过期或撤销都会使待审候选过期。

## 6. 核心工作流

### 6.1 四类统一候选

`生成 → 确定性校验 → 保存候选 → 原样采用 / 修改后采用 / 拒绝 → 再次确定性校验 → 写入业务对象 → 7 天复查`

运营审阅策略、Brief 和草稿；销售审阅本人客户 NBA。修改或拒绝必须选择原因并填写说明：

- 状态错误、证据错误、NBA 不合适、缺少上下文、风险或合规、过于泛化。
- 知识不适用、企业事实错误、语气不符、策略过激、实验设计不足、其他。

失败、409 冲突或候选过期时保留本地输入。候选绑定业务 revision、证据指纹、知识包、企业事实、营销脑、代码化 Prompt 与模型路由版本。

### 6.2 页面内 AI 决策面板

不新增独立营销大脑业务页。以下页面嵌入统一决策面板：

- 本周运营：策略候选、业务目标、T/I/D/A 配比、测量计划。
- 会话洞察：Brief 候选、洞察血缘、证明需求与唯一 CTA。
- 草稿与发布：正文候选、知识依据、企业事实、品牌语气与审批门禁。
- 客户详情：状态、证据摘要、NBA、不建议动作、风险与模型路由。

面板固定展示业务证据、知识引用、SKILL 路由、假设、冲突、测量计划、建议和不建议动作。移动端可完成审阅与查看引用；长正文修改和知识版本治理提示使用桌面端。

### 6.3 知识治理

`/knowledge` 展示：

- 挂载与激活状态、知识包内容哈希、来源数、块数和索引时间。
- 正常、重复、未解析和错误来源。
- 检索预览、SKILL 路由、BM25 结果与冲突。
- 企业事实版本和 MarketingBrain 原子绑定。
- 最近检索、引用覆盖、激活与回滚。

知识正文不在产品内编辑，仍由私有文件的代码审查和版本控制维护。

## 7. AI 契约

`MarketingDecisionEnvelope<T>`：

```ts
interface MarketingDecisionEnvelope<T> {
  task_type: "weekly_strategy" | "content_brief" | "content_draft" | "customer_nba";
  output: T;
  business_evidence_refs: string[];
  knowledge_refs: KnowledgeReference[];
  skill_route: string[];
  assumptions: string[];
  knowledge_conflicts: string[];
  measurement_plan: string[];
  growth_posture: "aggressive";
  ai_meta: AiMeta;
  knowledge_pack_version: string;
  tenant_fact_version: string;
  marketing_brain_version: string;
  prompt_hash: string;
  input_fingerprint: string;
}
```

Prompt 由代码内类型化 builder 生成并用 SHA-256 哈希版本化。`MarketingBrainVersion` 原子绑定四类 Prompt 哈希、SKILL 路由、FTS5 检索器、知识包、企业事实、模型路由和确定性策略。只有名称和描述、但不改变 Prompt 的空壳版本不再作为 2.2 发布单元。

模型路由：

- 周策略和 Brief 始终使用 `gpt-5.6`。
- Terra 仅用于低风险草稿改写和简单 T0/T1 NBA。
- Terra 低置信、拒答、结构失败、未知引用或策略失败时最多升级一次到主模型。
- 主模型失败后阻断，不向低能力模型降级。

API Key 仅存于 BFF 内存或环境变量，不写入 SQLite、浏览器状态或日志。BFF 不记录完整客户片段、完整 Prompt 或完整模型正文日志。

## 8. 接口

知识：

- `GET /api/v2/knowledge/status`
- `POST /api/v2/knowledge/reindex`
- `POST /api/v2/knowledge/retrieval-preview`
- `POST /api/v2/knowledge/versions/:id/activate`
- `POST /api/v2/knowledge/rollback`

营销决策：

- `POST /api/v2/marketing/candidates/generate`
- `POST /api/v2/marketing/candidates/:id/decision`
- `POST /api/v2/marketing/decisions/:id/review`

评测与发布门禁：

- `POST /api/v2/ai-quality/eval-runs`：CI 与日常调优使用的确定性回放。
- `POST /api/v2/ai-quality/live-holdout-runs`：负责人确认用量后启动或恢复 88 条真实模型 Holdout。
- `POST /api/v2/ai-quality/live-holdout-runs/:id/pause`：暂停新案例领取，保留已完成结果与逐案例幂等键。

所有写接口继续校验签名会话、tenant、角色与 CSRF。生成接口要求幂等键，重复请求不能重复调用或计费。所有写入继续使用 revision 和 expected revision；冲突返回 `409 VERSION_CONFLICT` 或 `409 STALE_MARKETING_CANDIDATE`。

## 9. 数据对象

- `KnowledgePackVersion`、`KnowledgeSource`、`KnowledgeChunk`、`KnowledgeRetrievalRun`。
- `TenantFactVersion` 及 `ProductTruth`、`ExpertPosition`、`BrandVoice`、`OfferDefinition`。
- `MarketingBrainVersion`。
- `MarketingDecisionCandidate`、`MarketingDecisionDecision`。
- `EvalRun`、`LiveEvalCaseResult`；真实运行逐案例记录模型、response ID、token、grader、错误码和恢复状态。
- 现有 `Proof`、客户、证据、洞察、Brief、草稿、发布、结果和审计对象继续复用。

全部服务端对象包含 `tenant_id`、revision、审计字段和内容哈希。公开前端状态不包含知识正文全集，只包含候选实际引用的短摘要与治理元数据。

## 10. 评测与发布门禁

黄金集共 440 条：

- 保留 200 条客户 NBA。
- 新增 80 条策略、80 条 Brief、80 条草稿。
- 352 条调优集，88 条锁定 Holdout。

确定性 grader 逐例检查：状态、NBA 集合、业务证据引用、知识引用、SKILL 路由、弱信号、越级迁移、C1 成交事实、未知来源、隐私泄露、禁止来源和无依据事实。模型 grader 只诊断表达与解释质量，不能解除任何门禁。

发布必须同时满足：

- 宏平均决策有效采用率 ≥70%，相对基线 +15pp，各类 ≥60%。
- 审阅覆盖率 ≥80%。
- 状态准确率 ≥85%，NBA 可接受率 ≥80%。
- Recall@5 ≥95%。
- 知识引用精度、业务证据精度均为 100%。
- 禁止来源、策略违规、隐私泄露、无依据事实均为 0。
- 关键切片回归 ≤2pp，P95 ≤30 秒。

CI 只运行确定性检索、Mock OpenAI 合约和固定结果回放。完整 88 条真实 OpenAI Holdout 需要负责人在界面显式确认 API 用量，最大并发 2，使用幂等键并支持中断续跑。`RUN_LIVE_OPENAI_TEST=1` 仅作为显式开关，默认关闭。

## 11. 验收标准

- 四类生成缺少有效知识时 100% 阻断，无通用 Prompt 降级。
- 每个候选都有业务证据、知识引用、SKILL 路由、版本、假设与测量计划。
- 理论和经验不能满足客户证明、产品事实或成交事实门禁。
- 知识包、事实或营销脑版本变化后，全部待处理候选立即过期。
- 运营不能读取客户原文；销售只能审阅本人客户 NBA；负责人知识治理操作进入审计。
- 390px 无页面级横向滚动，候选审阅和引用查看可操作。
- 不发生自动发布、自动私聊、自动报价、Offer 发送或真实企微调用。

## 12. 非目标与后续

2.2 不实现真实企微、真实客户数据、生产 SSO、媒体 OCR/ASR、因果归因、微调、线上随机 A/B 或三模型路由。SQLite Repository、tenant 边界、版本化事实与知识接口为后续中国区 PostgreSQL、企业微信 SSO 和生产知识服务预留替换点。

正式试点前必须通过 88 条 Holdout、负责人用量确认、安全门禁和公开仓库密钥扫描。合成数据只能验证流程、引用和决策质量，不能证明真实内容增长效果。
