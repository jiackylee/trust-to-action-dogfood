# Trust-to-Action Dogfood V2.3

面向运营、销售和负责人的企微营销大脑 Dogfood。2.3 在知识增强闭环上增加 OpenAI、DeepSeek、Anthropic、Qwen 与企业私有模型端点，使用一个全局 Model Profile 治理全部七类 AI 任务。

产品、接口、安全边界和验收标准见 [2.3 多模型治理产品方案](docs/Trust-to-Action_2.3_多模型治理产品方案.md)。2.2 及更早方案位于 `docs/archive/`，仅作历史参考。

## 本地运行

```bash
npm install
cp .env.example .env
npm run dev
```

访问 `http://127.0.0.1:4174/`。BFF 运行在 `127.0.0.1:4175`，Vite 将 `/api` 代理至 BFF。

默认 `VITE_DATA_MODE=http`。BFF 使用 `better-sqlite3`、WAL、FTS5 `trigram` 和迁移文件，将合成租户状态与知识索引写入 `./data/trust-to-action-v2.3.sqlite`。首次启动装载 fixture V8；“重置演示数据”由服务端执行。

## 多模型配置

治理页支持以下连接：

| 供应商 | 默认环境变量 | 默认协议 |
| --- | --- | --- |
| OpenAI | `OPENAI_API_KEY` | Responses |
| DeepSeek | `DEEPSEEK_API_KEY` | Responses |
| Anthropic | `ANTHROPIC_API_KEY` | Messages |
| Qwen / DashScope | `DASHSCOPE_API_KEY` | Responses 或 Chat JSON |
| 企业私有端点 | 自定义引用或无需认证 | Responses 或 Chat JSON |

密钥只来自 BFF 环境变量或进程内存，禁止添加 `VITE_` 前缀。页面录入的会话密钥重启即清除；如果当前 Profile 没有对应环境凭据，重启后会标记为 `credential_missing`，不会跨供应商回退或静默切回 OpenAI。

企业全局激活一个 Model Profile。七类任务先调用主模型，仅对限流、超时、可重试服务失败、拒答、截断、结构失败、低置信或模型策略失败回退一次。备用模型始终使用同一供应商、连接和协议。鉴权、权限、同意、硬合规和预算阻断不触发回退。

企业私有端点要求：

- 非 loopback 域名写入服务端 `AI_ENDPOINT_ALLOWLIST`。
- 生产和局域网端点使用 HTTPS；仅开发环境允许 loopback HTTP。
- URL 不得包含凭据、查询参数或片段，重定向和云元数据地址会被阻断。
- 私有 CA 在启动进程前通过 `NODE_EXTRA_CA_CERTS=/absolute/path/to/ca.pem npm run dev` 配置。
- 本项目只调用企业已有端点，不下载、托管或启动模型权重。

未配置可用模型时，页面、已有候选审阅、质量中心和合成数据仍可评审；真实生成返回 `AI_NOT_CONFIGURED`，不使用 Mock AI。

## 私有知识包

四类营销决策必须挂载 2.2 建立的私有知识包：

```bash
KNOWLEDGE_PACK_PATH=/absolute/path/to/private-knowledge-pack
```

目录需包含选定 SKILL 和最终 Markdown 资料。BFF 只读扫描允许来源并建立本地索引。未配置、未索引或未激活时返回 `KNOWLEDGE_NOT_CONFIGURED`，不会退化为通用 Prompt。私有知识正文、原始书籍和本机绝对路径不得提交到 Git。

## 测试

```bash
npm test
npm run build
npm run test:e2e
npm run preview
```

CI 不配置真实供应商密钥，只运行 Adapter Mock 合约、确定性检索和固定回放。真实供应商连接测试需显式开启对应环境开关，完整 88 条 Holdout 必须由负责人在治理页确认 API 用量后启动。

## 数据与安全边界

- 默认 HTTP + SQLite；Mock 仅用于隔离单元测试和离线演示。
- 演示身份由 BFF 签发 HttpOnly、SameSite=Strict 签名会话；写请求校验 CSRF Token。
- 服务端决定角色、租户和销售客户范围，不信任前端角色请求头。
- `SESSION_SECRET` 在非开发环境必须配置；开发环境缺失时使用启动期临时密钥并显示健康警告。
- SQLite 不保存 API Key；日志、审计、响应、候选和浏览器状态不包含密钥。
- Profile 切换会让待处理候选过期，不改写历史结果或反转已采用客户状态。
- 不接真实企微、V1、`landing-page`、Firestore、Cloud Run 或 `leads`。
- 会话、朋友圈互动、客户、内容和业务结果均为合成数据。
- 所有发布、私聊、客服回复、报价和 Offer 发送均由人执行。

## 仓库维护

- `main` 保持可运行，后续开发使用功能分支和 Pull Request。
- 不提交真实客户数据、聊天记录、私有知识包、API Key、`.env`、SQLite、构建产物或测试报告。
- 本仓库未提供开源许可证。源代码公开可见，但保留全部权利，未经许可不得复制、修改或分发。
