# Trust-to-Action Dogfood V2.1

面向运营、销售和负责人的内部增长副驾 Dogfood。2.1 以“首稿有效采用率”为 North Star，聚焦客户状态与下一最佳动作质量，并使用 React、TypeScript、Vite、Zod、Lucide、Express、OpenAI Responses API 和 SQLite 构建本地企业试点边界。

当前产品、AI 路由、评测门禁、数据安全和验收标准见 [2.1 AI 质量优化产品方案](docs/Trust-to-Action_2.1_AI质量优化产品方案.md)。2.0 内容运营闭环和更早方案已移入 `docs/archive/`，仅作历史参考。

## 本地运行

```bash
npm install
cp .env.example .env
npm run dev
```

访问 `http://127.0.0.1:4174/`。BFF 运行在 `127.0.0.1:4175`，Vite 将 `/api` 代理至 BFF。

默认 `VITE_DATA_MODE=http`。BFF 使用 `better-sqlite3`、WAL 和迁移文件将合成租户状态写入 `./data/trust-to-action-v2.1.sqlite`。首次启动自动装载 fixture V5；“重置演示数据”由服务端执行。

不配置 `OPENAI_API_KEY` 时，页面、候选审阅、质量中心和合成数据仍可评审，但真实 AI 生成会返回 `AI_NOT_CONFIGURED`，不会使用 Mock AI。

本地 Dogfood 提供两种配置方式：

- 持久配置：在本目录 `.env` 中设置 `OPENAI_API_KEY`，变量名不能添加 `VITE_` 前缀；修改后重启服务。
- 临时配置：打开“治理 → 数据与审计 → 配置 API Key”，密钥经本机 BFF 分别验证 `OPENAI_MODEL` 和 `OPENAI_FAST_MODEL` 权限后，仅保存在服务进程内存中，重启 BFF 自动清除。

主模型默认 `gpt-5.6`，简单 T0/T1 场景可路由至 `gpt-5.6-terra`。Terra 低置信、拒答、结构或策略失败时最多升级一次；Terra 不可用时使用主模型单路模式；主模型失败后阻断。

临时密钥不会写入 SQLite、`localStorage`、领域数据、审计日志、前端日志或 API 响应，也不会显示密钥后缀。候选密钥和主模型验证成功前不会替换当前可用配置。不要把密钥粘贴到聊天、截图或提交到 Git。

## 命令

```bash
npm test
npm run build
npm run test:e2e
npm run preview
```

真实模型冒烟测试仅显式启用：

```bash
RUN_LIVE_OPENAI_TEST=1 npm run test:live
```

## 数据边界

- 默认 HTTP + SQLite；Mock 模式只用于隔离单元测试和离线演示，命名空间为 `trust-to-action-dogfood-v2-1`。
- 演示身份由 BFF 签发 HttpOnly、SameSite=Strict 的签名会话，写请求校验 CSRF Token；服务端决定角色、租户和销售客户范围。
- `SESSION_SECRET` 在非开发环境必须配置。开发环境缺失时使用启动期临时密钥，并在健康状态中提示重启后会话失效。
- 所有版本化写入检查对象 revision 和 Repository revision，409 冲突不覆盖最新状态。
- 不接真实企微、V1、`landing-page`、Firestore、Cloud Run 或 `leads`。
- 所有发布、私聊、客服回复和 Offer 发送均由人执行。
- 会话存档、朋友圈互动和业务结果全部为确定性合成数据：36 个会话、252 条消息、12 个洞察、8 个 Brief、8 个历史发布和 6 个业务结果。
- AI 质量数据包含 200 条纯合成黄金集（160 条调优集、40 条锁定 Holdout），不会上传真实客户内容。
- 运营只查看聚类和脱敏引用；销售仅可按审计用途查看本人合成会话原文，负责人可按需查看全部。
- 发布后结果固定按 7 天时间窗口关联，平台互动与销售业务结果分层展示，不宣称因果。

## 仓库维护

- `main` 保持可运行，后续开发通过功能分支和 Pull Request 合并。
- Pull Request 和 `main` 推送会运行单元测试、构建和 Playwright 全流程。
- 不要提交真实客户数据、聊天记录、API Key、`.env`、构建产物或测试报告。
- 本仓库当前未提供开源许可证。源代码公开可见，但保留全部权利，未经许可不得复制、修改或分发。
