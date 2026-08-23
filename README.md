# Trust-to-Action Dogfood V2

面向运营、销售和负责人的内部增长副驾 Dogfood。使用 React、TypeScript、Vite、Zod、Lucide、Express 和 OpenAI Responses API，当前全部业务数据均为合成或脱敏数据。

产品边界、AI 自动写入策略和验收标准见 [V2 产品方案](docs/Trust-to-Action_Dogfood产品方案_V2.md)。

## 本地运行

```bash
npm install
cp .env.example .env
npm run dev
```

访问 `http://127.0.0.1:4174/`。BFF 运行在 `127.0.0.1:4175`，Vite 将 `/api` 代理至 BFF。

不配置 `OPENAI_API_KEY` 时，页面和合成数据仍可评审，但所有 AI 生成会返回 `AI_NOT_CONFIGURED`，不会使用 Mock AI。

本地 Dogfood 提供两种配置方式：

- 持久配置：在本目录 `.env` 中设置 `OPENAI_API_KEY`，变量名不能添加 `VITE_` 前缀；修改后重启服务。
- 临时配置：打开“治理 → 数据与审计 → 配置 API Key”，密钥经本机 BFF 验证后仅保存在服务进程内存中，重启 BFF 自动清除。

临时密钥不会写入 `localStorage`、领域数据、审计日志、前端日志或 API 响应，也不会显示密钥后缀。候选密钥和模型验证成功前不会替换当前可用配置。不要把密钥粘贴到聊天、截图或提交到 Git。

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

- 默认 `VITE_DATA_MODE=mock`，数据仅写入浏览器 `localStorage` 的 `trust-to-action-dogfood-v2`。
- “重置演示数据”只清除此命名空间。
- 不接真实企微、V1、`landing-page`、Firestore、Cloud Run 或 `leads`。
- 所有发布、私聊、客服回复和 Offer 发送均由人执行。

## 仓库维护

- `main` 保持可运行，后续开发通过功能分支和 Pull Request 合并。
- Pull Request 和 `main` 推送会运行单元测试、构建和 Playwright 全流程。
- 不要提交真实客户数据、聊天记录、API Key、`.env`、构建产物或测试报告。
- 本仓库当前未提供开源许可证。源代码公开可见，但保留全部权利，未经许可不得复制、修改或分发。
