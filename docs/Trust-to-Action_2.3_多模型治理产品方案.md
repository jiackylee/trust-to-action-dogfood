# Trust-to-Action 2.3 多模型治理与企业私有模型产品方案

## 1. 版本定位

2.3 在 2.2 营销大脑、知识检索、企业事实、业务证据、审批和确定性门禁之上，增加可治理的多模型运行层。企业可以选择 OpenAI、DeepSeek、Anthropic、Qwen，或接入自建的 OpenAI-compatible 私有端点。

本项目不下载、托管或启动模型权重。所谓“企业私有模型”是由企业自行运行并暴露 Responses 或 Chat Completions JSON 协议的服务端点。

2.3 保持以下边界：

- 不接真实企业微信、生产客户数据或生产身份认证。
- 不自动发布、私聊、客服回复、报价或发送 Offer。
- 供应商模型不能解除知识引用、业务证据、客户证明、同意、审批和隐私门禁。
- 不将同一次请求并行发送给多个供应商，不做线上随机 A/B。
- 自动回退不得跨供应商、连接或协议传输数据。

## 2. North Star 与质量切片

North Star 延续 2.2 的四类“决策有效采用率”：

1. 分别统计本周策略、内容 Brief、内容草稿和客户 NBA。
2. 分母为 48 小时内已审阅并完成 7 天复查的候选。
3. 分子为原样采用且未因 AI 判断错误撤销的候选。
4. 新增证据导致的正常迁移不算质量失败。
5. 四类采用率等权平均，目标绝对值不低于 70%，较 2.1 同集基线提升至少 15pp，单类不低于 60%，审阅覆盖率不低于 80%。

2.3 增加以下诊断维度：

- 供应商、模型、协议、Model Profile 和数据边界。
- Schema 成功率、策略阻断率、Fallback 率和错误码。
- P50/P95 时延、输入/输出 Token 和估算成本。
- Smoke 与 Holdout 级别、最近连接测试和凭据状态。

质量切片用于选择模型，不改变 North Star 口径。

## 3. 用户与权限

| 能力 | 运营 | 销售 | 负责人 |
| --- | --- | --- | --- |
| 查看当前供应商、模型和候选运行信息 | 是 | 仅本人客户 | 是 |
| 查看连接端点、凭据来源和能力测试 | 是 | 否 | 是 |
| 新建连接和 Model Profile | 是 | 否 | 是 |
| 录入会话级 API Key | 是 | 否 | 是 |
| 运行连接测试和 14 条 Smoke | 是 | 否 | 是 |
| 运行完整 88 条 Holdout | 否 | 否 | 是 |
| 确认公有云数据去向并激活 | 否 | 否 | 是 |
| 回滚全局 Model Profile | 否 | 否 | 是 |
| 查看全部供应商质量切片 | 是 | 否 | 是 |

销售响应中的连接端点、环境变量引用、凭据可用性和非当前 Profile 均由 BFF 移除。前端角色切换不能扩大服务端权限。

## 4. 供应商架构

| 供应商 | 协议 | 结构化输出 | 默认端点范围 |
| --- | --- | --- | --- |
| OpenAI | Responses API | `text.format` + Zod Structured Outputs | `api.openai.com` |
| DeepSeek | OpenAI-compatible Responses | `text.format`，处理空响应和能力差异 | `api.deepseek.com` |
| Anthropic | Messages API | `output_config.format` JSON Schema + Zod 复验 | `api.anthropic.com` |
| Qwen | Responses 优先，Chat JSON 可选 | 能力探测后固定协议 + Zod 复验 | DashScope 中国站或国际站 |
| 企业私有端点 | Responses 或 Chat JSON | 管理员显式选择协议 + Zod 复验 | loopback 或服务端白名单 |

实现参考：

- [OpenAI Structured Outputs](https://developers.openai.com/api/docs/guides/structured-outputs)
- [Anthropic Structured Outputs](https://platform.claude.com/docs/en/build-with-claude/structured-outputs)
- [DeepSeek Responses API](https://api-docs.deepseek.com/guides/responses_api)
- [Qwen OpenAI-compatible Responses](https://help.aliyun.com/zh/model-studio/openai-compatible-responses/)

业务层只依赖标准化 Adapter，不接触供应商 SDK 对象。Adapter 输出固定包含：

```ts
interface AdapterResult<T> {
  data: T;
  responseId: string;
  inputTokens: number;
  outputTokens: number;
}
```

所有结果再次通过同一 Zod 业务 Schema 和确定性策略校验。

## 5. 全局 Model Profile

每个租户同时只有一个全局激活的 `ModelProfileVersion`，七类任务统一从其主模型开始：

1. 周策略。
2. 内容 Brief。
3. 内容草稿。
4. 客户状态与 NBA。
5. 风险分析。
6. 会话洞察。
7. 周复盘。

Profile 包含一个供应商连接、一个主模型和零或一个备用模型。备用模型始终复用同一 Adapter，因此天然受同一供应商、端点、连接和协议约束。模型 ID 可以使用服务端预设或管理员自定义值，预设不代表已验证。

以下错误最多触发一次备用模型：

- `RATE_LIMITED`
- `TIMEOUT`
- `MODEL_UNAVAILABLE` 中的可重试服务端失败
- `REFUSAL`
- `OUTPUT_TRUNCATED`
- `SCHEMA_INVALID`
- `LOW_CONFIDENCE`
- 模型输出未通过可重试策略校验

以下情况不触发备用模型：

- 鉴权失败或模型无权限。
- 输入 Schema 无效。
- 同意、角色、租户或客户范围失败。
- 硬合规、审批、授权或预算阻断。
- 管理员取消操作。

主模型和备用模型都失败后阻断生成，不向低能力模型或其他供应商降级。

## 6. Profile 生命周期

状态流转：

`draft → connection_verified → trial_ready → active → enterprise_ready / archived`

凭据丢失时进入 `credential_missing`。

### 6.1 创建与验证

- 运营或负责人创建连接和 Profile。
- 连接测试只发送无业务数据的最小 JSON Schema。
- 测试成功后记录能力、时间、请求 ID 支持情况和凭据来源，不保存密钥。
- Qwen 和私有端点在连接测试后固定实际协议能力。

### 6.2 Smoke

七类任务各使用两条纯合成案例，共 14 条。全部通过结构、引用和隐私门禁后，Profile 进入 `trial_ready`。

### 6.3 激活

- 只有负责人可以激活。
- 公有云 Profile 必须确认供应商、端点域名、声明区域和发送字段。
- 私有端点按企业信任边界处理，不增加公有云确认门禁。
- 激活后，待处理营销候选和客户评估候选全部过期。
- 已发布 `MarketingBrainVersion` 原子绑定新 Profile。
- 历史候选、运行记录和已采用结果保持原供应商和模型元数据。

### 6.4 Holdout 与回滚

- 负责人可以显式确认 API 用量后运行 88 条纯合成 Holdout。
- 最大并发为 2，逐案例幂等，支持暂停和断点续跑。
- 全部门槛通过后标记 `enterprise_ready`。
- 未完成 Holdout 的 Profile 允许试用激活，但持续显示试用警告。
- 回滚恢复上一曾激活 Profile，不改写历史结果。

## 7. 凭据与重启行为

密钥来源只有两种：

- 服务端环境变量引用。
- BFF 进程内存中的会话密钥。

SQLite 只保存引用名、来源类型和可用状态，不保存密钥、后缀或哈希。密钥不得进入浏览器状态、API 响应、审计、日志、错误详情或生成记录。

运行时密钥在 BFF 重启后失效。启动时系统读取 SQLite 中最后激活的 Profile：

- 对应环境变量存在时，恢复同一供应商和 Profile。
- 无环境凭据时将 Profile 标记为 `credential_missing` 并阻断生成。
- 不得静默恢复默认 OpenAI 或跨供应商切换。
- 管理员重新验证凭据后，Profile 回到连接验证流程。

## 8. 私有端点安全

私有端点执行以下确定性校验：

- URL 不得包含用户名、密码、查询参数或片段。
- 禁止重定向。
- 禁止云元数据主机和 `169.254.0.0/16` 链路本地地址。
- 非 loopback 私有主机必须进入 `AI_ENDPOINT_ALLOWLIST`。
- 生产和局域网端点必须使用 HTTPS；仅开发环境允许 loopback HTTP。
- 私有 CA 使用启动 BFF 时的服务端 `NODE_EXTRA_CA_CERTS` 证书路径，不接受浏览器上传证书。
- 认证仅支持 Bearer、固定 `x-api-key` 或无认证。
- 不允许用户注入任意请求头。
- 公有供应商连接只能使用对应官方 API 域名。

## 9. 产品体验

“治理 → 数据接入与模型治理”提供：

- 当前全局 Profile 摘要、协议、数据边界和凭据来源。
- OpenAI、DeepSeek、Anthropic、Qwen 和企业私有连接创建。
- 主模型、同供应商备用模型、环境变量引用和认证方式。
- 连接验证、14 条 Smoke、激活、完整 Holdout、回滚和清除会话密钥。
- 公有云数据去向确认。
- 最近模型与数据审计。

AI 质量中心提供：

- 四类决策有效采用率和知识/业务证据指标。
- 供应商、协议、模型、Profile、Fallback、Token 和 P95 切片。
- 当前全局 Profile 及“不跨供应商传输”说明。
- 旧 RouterVersion 仅作为离线评测迁移基线，不再提供日常路由编辑。

390px 移动端将 Profile 表格转换为卡片，可查看、验证、运行 Smoke、激活和回滚；长配置和完整治理仍建议使用桌面端。

## 10. 数据对象

新增或扩展对象：

- `ProviderConnectionProfile`
- `ProviderCapability`
- `ModelProfileVersion`
- `ProviderAttempt`
- `GenerationRun`
- `AiMeta`
- `MarketingBrainVersion`

`AiMeta` 和运行记录包含：`provider`、`protocol`、`connection_profile_id`、`model_profile_version_id`、`endpoint_scope`、`model`、`fallback_from`、尝试次数、响应 ID、时延、标准化 Token 和输入指纹。

所有持久对象继续包含 `tenant_id`、revision、更新时间和审计字段。SQLite fixture 版本为 8，默认数据库为 `trust-to-action-v2.3.sqlite`。

## 11. API

| 方法 | 接口 | 用途 |
| --- | --- | --- |
| GET | `/api/v2/ai/providers` | 服务端供应商目录与预设 |
| GET/POST | `/api/v2/ai/connections` | 查询或创建连接 |
| POST | `/api/v2/ai/connections/:id/test` | 最小 Schema 连接测试 |
| DELETE | `/api/v2/ai/connections/:id/runtime-secret` | 清除 BFF 内存密钥 |
| GET/POST | `/api/v2/ai/model-profiles` | 查询或创建 Profile |
| POST | `/api/v2/ai/model-profiles/:id/smoke` | 运行 14 条 Smoke |
| POST | `/api/v2/ai/model-profiles/:id/holdout` | 运行完整 Holdout |
| POST | `/api/v2/ai/model-profiles/:id/activate` | 激活全局 Profile |
| POST | `/api/v2/ai/model-profiles/:id/rollback` | 回滚上一 Profile |

现有七类生成接口保持不变。`GET /api/v2/ai/config` 保留兼容视图；旧 OpenAI 写接口委托给 OpenAI Profile 兼容流程，不能绕过负责人、公有云确认或候选过期规则。

## 12. 标准错误

Adapter 对外错误固定为：

- `PROVIDER_AUTH_FAILED`
- `MODEL_UNAVAILABLE`
- `RATE_LIMITED`
- `TIMEOUT`
- `REFUSAL`
- `OUTPUT_TRUNCATED`
- `SCHEMA_INVALID`
- `CAPABILITY_MISMATCH`
- `ENDPOINT_BLOCKED`

业务层可以增加 `AI_NOT_CONFIGURED`、`DATA_EGRESS_ACK_REQUIRED`、`SMOKE_REQUIRED`、`VERSION_CONFLICT`、`FORBIDDEN` 和确定性策略错误。错误响应不包含 SDK 对象、Prompt 正文、客户片段或凭据。

## 13. 评测与发布门槛

Profile 激活至少要求 14 条 Smoke 全部通过。企业就绪还要求完整 88 条 Holdout 同时满足：

- 决策有效采用率不低于 70%，相对基线提升至少 15pp。
- 单类采用率不低于 60%，审阅覆盖率不低于 80%。
- 状态准确率不低于 85%，NBA 可接受率不低于 80%。
- 业务证据和知识引用精度均为 100%。
- Recall@5 不低于 95%。
- 策略违规、隐私泄露、禁止来源和无依据事实均为 0。
- 关键切片回归不超过 2pp，P95 不超过 30 秒。

真实供应商测试只在显式环境开关下运行；CI 默认只运行 Mock 合约、确定性检索和固定回放，不配置真实密钥。

## 14. 测试与验收

单元和合约测试覆盖：

- 四类 Adapter 创建、Schema 复验、空响应、拒答和截断。
- 429、超时、5xx 和鉴权错误映射。
- 同供应商备用模型最多一次、禁止跨供应商自动回退。
- URL 凭据、查询参数、重定向、元数据地址、未授权内网主机和生产 HTTP。
- Profile 版本冲突、Smoke、数据去向确认、激活、候选过期和回滚。
- 运行时密钥清除、重启后 `credential_missing` 和环境凭据恢复。
- 角色权限、租户隔离、CSRF 和销售数据投影。

Playwright 覆盖：

`新建连接 → 验证 → Smoke → 公有云确认 → 激活 → 七类生成 → 同供应商回退 → 回滚`

视口为 1440×900、1024×768 和 390×844。验收要求无页面级横向滚动、控件不重叠、焦点可见、对话框焦点受控、失败输入保留。

## 15. 分批实施

第一批：供应商 Adapter、Profile 数据模型、标准错误、端点安全和同供应商回退。

第二批：治理 UI、连接测试、Smoke、激活、重启恢复、候选过期和 RouterVersion 迁移。

第三批：多供应商质量切片、完整 Holdout、响应式回归、真实供应商显式测试和文档。

## 16. 后续边界

2.3 不负责模型部署、GPU 调度、权重下载、模型微调、真实企微连接、生产 SSO、线上多供应商 A/B 或自动外发。下一阶段只有在合成 Holdout、企业安全评审和真实业务试点均通过后，才进入中国区生产数据面设计。
