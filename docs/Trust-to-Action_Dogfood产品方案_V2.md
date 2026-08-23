# Trust-to-Action 内部增长副驾 Dogfood 产品方案 V2

> 文档版本：V2.0 Local Review
> 更新日期：2026-08-23
> 评审范围：运营优先 UX、类型化数据适配层、OpenAI BFF、自动状态写入策略
> 基础文档：V1 业务方案（未纳入本公开仓库）
> 本地入口：`http://127.0.0.1:4174/`

## 1. 版本目标

V2 不改变 V1 的业务假设与合规边界，而是解决内部人员是否能持续使用的问题：运营可以从经营指标直接进入本周阻塞对象，销售可以在客户首屏看到证据和下一最佳动作，负责人可以行内完成敏感审批，所有角色都能明确知道数据、模型和审批 Gate 是否可用。

本轮验证四个问题：

1. 运营是否能在两次操作内从经营异常进入具体草稿、证明资产、客户、审批或数据源。
2. “策略 → 草稿 → 证据 → 风险 → 审批 → 人工发布 → 结果”是否能作为连续工作流运行。
3. 通过结构化模型输出和确定性规则自动写入客户状态/NBA，是否仍能保持逐条可解释和可审计。
4. 390px 下，客户、动作、审批和结果回填是否能完成，而不依赖桌面宽表格。

### 1.1 非目标

- 不接真实企业微信，不建设 OAuth、成员身份或生产数据库。
- 不自动发布朋友圈、私聊、回复客服、群发或发送 Offer。
- 不将浏览器 Mock 数据写入 V1、`landing-page`、东京 Firestore、Cloud Run 或 `leads`。
- 不为模型失败提供伪装成 AI 的 Mock 降级。
- 不在移动端支持长策略和朋友圈正文的完整编辑。

## 2. 信息架构

V2 将功能按工作目的重组为五个工作域：

| 工作域 | 一级页面 | 核心问题 | 主要角色 |
|---|---|---|---|
| 经营 | 本周经营台、本周运营 | 本周最重要的结果与阻塞是什么 | 运营、负责人 |
| 内容 | 策略与草稿、证明资产 | 内容是否有证据、授权和唯一 CTA | 运营 |
| 客户 | 客户状态、客户详情 | 客户为何处于当前状态，下一步做什么 | 销售、运营 |
| 执行 | 销售任务、负责人审批 | 人工动作是否完成，敏感门禁是否处理 | 销售、负责人 |
| 治理 | 数据接入、AI 状态、审计 | 输入是否新鲜，自动判断是否可追溯 | 负责人、运营 |

### 2.1 导航与响应式规则

- 1440px：224px 完整侧栏，显示工作域和页面名称。
- 1024px：64px 图标侧栏；每个导航项保留 `title` Tooltip 和 `aria-label`，键盘焦点可见。
- 390px：固定底部五工作域导航。经营默认进入经营台，内容默认进入草稿；二级页面通过页面内入口到达。
- 页面不产生横向滚动。桌面表格在 760px 以下不渲染，改为字段明确的业务卡片。

## 3. 经营台与运营工作区

### 3.1 首屏内容

1440×900 的首屏必须同时看到：

- 本周主题与经营目标。
- 核心 Gate：有效信号到下一动作中位时间不超过 24 小时。
- 内容就绪度和 T/I/D/A 配比。
- 就绪内容、高意向状态、证据缺口、待审批、逾期动作和数据异常。
- 前三个阻塞点及其直接处理入口。

指标链接带过滤条件，例如 `待审批 → /execution?tab=approvals`，最多再点一次即可进入目标对象。

### 3.2 连续工作流

本周运营页将七步流程固定显示：

`策略 → 草稿 → 证据 → 风险 → 审批 → 人工发布 → 结果`

每一步展示状态、数量和阻塞原因。发布步骤只提供复制能力，并持续展示“不调用发送接口”的边界。

## 4. 关键 UX 规则

### 4.1 内容编辑器

- 桌面使用“草稿列表 / 正文编辑 / 证据与风险”三栏布局。
- 自动保存防抖 1 秒，展示 `正在保存 / 已保存 revision / 保存失败`。
- 离开存在未保存内容的页面前触发浏览器提示。
- `409 VERSION_CONFLICT` 打开冲突对话框，允许保留本地输入或载入最新 revision。
- 证据授权撤销后，引用草稿立即显示阻断，复制按钮不可用。
- AI 草稿和风险检查失败时保留标题、正文、CTA、证据和筛选。
- 确定性风险优先于模型建议；模型不能解除审批门禁。

### 4.2 客户列表与详情

- 筛选条件保存在 URL，滚动位置保存在当前浏览器会话。
- 从详情返回时恢复原筛选和滚动位置。
- 客户详情首屏固定展示当前状态、置信度、有效证据、NBA、CTA 和复查时间；时间线下移。
- 客户状态批量评估需显式选择，每批最多 10 位。
- 批量处理遇到失败后停止；已成功对象保留审计，未处理对象保持选择。

### 4.3 快速处理与撤销

- 销售在任务行内填写结果；失败不清空输入。
- 负责人在审批行内填写必填意见并批准或退回。
- 本地 Mock 成功操作保存操作前快照，7 秒内可撤销。正式 HTTP 数据面应改为服务端 mutation token，不允许无版本覆盖整个快照。

### 4.4 移动端

- 客户、证明资产、任务和审批使用卡片，不展示桌面宽表格。
- 客户详情的状态/NBA 仍在页面前部，销售可重试评估和记录人工事实。
- 任务结果和审批可操作；长正文编辑显示“请使用桌面端”。

## 5. 角色与权限

| 能力 | 运营 | 销售 | 负责人 |
|---|---:|---:|---:|
| 查看经营与汇总 | 是 | 是 | 是 |
| 生成周策略 | 是 | 否 | 只读 |
| 编辑内容草稿 | 是 | 只读/复制就绪稿 | 只读 |
| 查看证明资产 | 是 | 是 | 是 |
| 触发客户 AI 评估 | 是 | 是 | 是 |
| 执行销售动作并回填 | 只读 | 是 | 只读 |
| 处理敏感审批 | 否 | 否 | 是 |
| 查看数据接入与审计 | 是 | 只读 | 是 |
| 重置本地演示数据 | 是 | 是 | 是 |

前端禁用只用于解释体验；正式 HTTP 实现必须在服务端再次授权。

## 6. 数据架构

### 6.1 `DataClient`

前端只依赖 `DataClient`，不直接访问本地存储或未来后端：

```ts
interface DataClient {
  getState(): Promise<DomainState>;
  setRole(role: Role): Promise<DomainState>;
  saveDraft(draft: Draft, expectedRevision: number): Promise<DomainState>;
  applyCustomerEvaluation(customerId, evaluation, meta, expectedRevision): Promise<DomainState>;
  decideApproval(id, decision, reason, expectedRevision): Promise<DomainState>;
  recordTaskOutcome(id, outcome, expectedRevision): Promise<DomainState>;
  saveWeeklyPlan(strategy, generatedBy): Promise<DomainState>;
  restoreSnapshot(snapshot): Promise<DomainState>; // 仅本地 Dogfood 撤销
  reset(): Promise<DomainState>;
}
```

默认 `VITE_DATA_MODE=mock`：异步模拟 90ms 延迟，数据写入 `localStorage` 的 `trust-to-action-dogfood-v2` 命名空间。`VITE_DATA_MODE=http` 是未来接口适配入口。

### 6.2 版本与冲突

所有可变对象都满足：

```ts
type Versioned<T> = T & {
  id: string;
  revision: number;
  updated_at: string;
}
```

写入必须提交 `expectedRevision`。不一致返回：

```json
{
  "status": 409,
  "code": "VERSION_CONFLICT",
  "message": "草稿已被其他操作更新",
  "retryable": true,
  "latest": {}
}
```

### 6.3 演示数据

- 24 位合成客户，覆盖 T0/T1/I1/D1/A1/C1、弱中强证据和异常状态。
- 6 条内容草稿，覆盖就绪、审批中、退回和阻断。
- 5 个证明资产，覆盖公开授权、仅内部、不完整和授权撤销。
- 10 个销售动作、4 个审批案例、4 个数据源、初始审计事件。

所有数据均为合成或脱敏内容，不使用项目中的会员表和真实聊天记录。

## 7. OpenAI BFF

### 7.1 本地接口

| Method | Path | 输出 Schema | 写入行为 |
|---|---|---|---|
| GET | `/api/v2/health` | BFF、密钥配置和模型状态 | 无 |
| GET | `/api/v2/ai/config` | 配置状态、模型、来源和配置时间 | 无 |
| POST | `/api/v2/ai/config` | 运行时配置状态，不返回密钥或指纹 | 验证成功后原子替换内存配置 |
| DELETE | `/api/v2/ai/config` | 环境配置或未配置状态 | 清除运行时密钥并回退 `.env` |
| POST | `/api/v2/ai/weekly-strategy` | `WeeklyStrategy` | 前端确认接口成功后保存周策略 |
| POST | `/api/v2/ai/content-draft` | `ContentDraftProposal` | 填入编辑器，随后自动保存 |
| POST | `/api/v2/ai/risk-review` | `RiskReview` | 合并风险建议，不解除规则门禁 |
| POST | `/api/v2/ai/customer-evaluation` | `CustomerEvaluation` | 双重规则校验后自动写状态/NBA |

BFF 使用 OpenAI Node SDK、Responses API、Structured Outputs 和 Zod。默认模型为 `gpt-5.6`，可由服务端 `OPENAI_MODEL` 覆盖。实现依据：

- [Structured Outputs](https://developers.openai.com/api/docs/guides/structured-outputs)
- [Model selection](https://developers.openai.com/api/docs/guides/model-selection)

### 7.2 安全与日志

- 持久密钥通过 BFF 的 `OPENAI_API_KEY` 环境变量提供；禁止任何 `VITE_` 前缀。
- Dogfood 治理页可向本机回环地址提交临时密钥。BFF 验证候选密钥和模型后才原子替换现有配置，且只在进程内存保存；服务重启后清除。
- 运行时配置接口要求回环来源和产品自定义请求头；不接受远程地址调用。
- 配置状态响应只返回是否配置、模型、来源和时间，不返回密钥、后缀或指纹。
- 前端 Bundle、`localStorage`、审计详情和日志中不得出现密钥。
- BFF 不记录完整提示词、客户片段、草稿正文或模型正文。
- 请求 Body 上限 128 KB；本地频率 5 分钟 20 次；OpenAI 超时 45 秒、最多重试一次。

### 7.3 成功响应

```json
{
  "data": {},
  "meta": {
    "model": "gpt-5.6",
    "response_id": "resp_...",
    "prompt_version": "trust-to-action-v2.0.0",
    "generated_at": "2026-08-23T15:00:00.000Z"
  }
}
```

### 7.4 错误契约

```json
{
  "error": {
    "code": "AI_NOT_CONFIGURED",
    "message": "未配置 OPENAI_API_KEY，真实模型能力已阻断。",
    "retryable": false,
    "request_id": "uuid"
  }
}
```

明确区分：`INVALID_REQUEST`、`AI_NOT_CONFIGURED`、`OPENAI_AUTH_FAILED`、`OPENAI_RATE_LIMITED`、`OPENAI_TIMEOUT`、`MODEL_REFUSAL`、`MODEL_OUTPUT_INVALID`、`MODEL_SCHEMA_INVALID`、`POLICY_BLOCKED` 和 `INTERNAL_ERROR`。任何失败都阻断本次生成或写入，并在界面保留输入与重试入口。

## 8. 客户自动写入策略

模型返回 `CustomerEvaluation` 后，BFF 和 `DataClient` 各执行一次策略校验，防止绕过：

1. `state_before` 必须等于客户当前 revision 的状态。
2. 新状态最多前进一步，可以保持或回退。
3. 至少引用一条存在且有效的证据。
4. D1/A1 必须引用有效强证据；点赞等弱信号不能单独推动。
5. C1 必须引用 `transaction_fact=true` 的明确成交事实。
6. 证据 ID 未知、失效或撤权时阻断写入。

通过后自动写入：`state`、`confidence`、`review_at`、完整 `evaluation` 与模型元数据。审计记录包含前后状态、NBA、证据引用、模型、OpenAI response ID 和提示词版本。未通过时返回 `422 POLICY_BLOCKED`，客户 revision 不变。

自动写入不等于自动执行。系统不会发布内容、私聊客户、回复客服或发送 Offer。

## 9. 确定性审批门禁

下列内容无论模型是否判为低风险，都必须由负责人审批：

- 客户案例、反馈、原话或可识别过程。
- 价格、报价、折扣、名额、排期、试用或 Offer。
- 量化承诺、结果、百分比、团队规模、周期。
- 投诉、补偿、身份证、手机号及其他个人敏感信息。
- 引用授权范围不足或已经撤销的证明资产。

授权撤销是最高优先级阻断：引用草稿不得复制，审批通过也不能解除，必须移除或更换证据。

## 10. 验收标准

### 10.1 功能

- 三种角色的写操作符合权限矩阵。
- 周策略、草稿、风险和客户评估在无密钥时返回明确错误，不使用 Mock AI。
- 治理页支持本地 API Key 配置、重新配置和清除；验证失败保留输入且不替换旧配置，成功后立即清空前端输入。
- 客户自动评估通过策略后写入状态/NBA并生成审计；策略失败不写入。
- 草稿自动保存展示版本；冲突时可保留本地或载入最新。
- 失效证明立即阻断草稿复制。
- 任务与审批支持行内操作、失败保留输入、成功短时撤销。
- 重置只清除 V2 本地命名空间。

### 10.2 视觉与可访问性

- 1440×900 首屏可见主题、核心指标和前三个阻塞点。
- 1024×768 折叠导航可辨识，Tooltip 和可访问名称存在。
- 390×844 无页面级横向滚动，不显示 977px 客户表格。
- 客户详情的状态、证据与 NBA 在 390 和桌面均位于时间线之前。
- 所有交互控件有可见焦点；对话框打开时焦点进入、Tab 循环、Escape 关闭并恢复原焦点。
- 文字不溢出按钮、卡片和导航；加载、空状态、错误和禁用状态可辨识。

### 10.3 工程

- `npm test`、`npm run build`、`npm run test:e2e` 通过。
- 真实 OpenAI 冒烟测试只在 `RUN_LIVE_OPENAI_TEST=1` 时执行，每次一条周策略和一位客户评估。
- 构建产物不包含 `OPENAI_API_KEY`，BFF 日志不输出输入正文。
- API 配置合约测试验证本机门禁、失败回滚、环境回退和响应不含提交密钥。
- 本地评审环境运行于 `127.0.0.1:4174`，BFF 仅监听 `127.0.0.1`。

## 11. 4 周 Dogfood 决策门槛

继续沿用 V1 门槛，并增加 UX 观察项：

- 至少 90% 状态判断有带时间证据。
- NBA 采纳率至少 60%，80% 已执行动作在 48 小时内回填。
- 有效信号到下一动作中位时间不超过 24 小时。
- 不少于 20 个 T1、10 个 I1、5 个 D1、3 个真实 Offer 结果和 3 个授权反馈样本。
- 未授权证明使用、自动外发和重大隐私/合规事故为 0。
- 经营指标进入目标对象不超过两次操作；筛选恢复成功率达到 95%。
- 内容自动保存成功率达到 99%，冲突和失败均未造成输入丢失。

第 4 周输出继续 / 调整 / 停止结论。若合规红线发生、状态不可解释或销售无法维持结果回填，则即使活跃度高也不继续扩大范围。
