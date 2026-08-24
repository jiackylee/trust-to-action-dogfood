import { expect, test } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "内容经营台" })).toBeVisible();
  await page.getByRole("button", { name: "重置演示数据" }).click();
  await page.getByRole("button", { name: "确认重置" }).click();
  await expect(page.getByText("演示数据已重置", { exact: true })).toBeVisible();
});

for (const viewport of [{ width: 1440, height: 900 }, { width: 1024, height: 768 }, { width: 390, height: 844 }]) {
  test(`responsive shell ${viewport.width}x${viewport.height}`, async ({ page }) => {
    const browserErrors: string[] = [];
    page.on("pageerror", (error) => browserErrors.push(error.message));
    page.on("console", (message) => { if (message.type() === "error") browserErrors.push(message.text()); });
    await page.setViewportSize(viewport);
    await page.goto("/");
    await expect(page.getByRole("heading", { name: "内容经营台" })).toBeVisible();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(1);
    if (viewport.width === 1440) {
      await expect(page.getByText("前三个阻塞点")).toBeVisible();
      await expect(page.getByText("线索跟进不靠销售记忆", { exact: true })).toBeVisible();
    }
    if (viewport.width === 1024) await expect(page.getByRole("link", { name: "客户状态" })).toHaveAttribute("title", "客户状态");
    if (viewport.width === 390) {
      await expect(page.locator(".desktop-table")).toBeHidden();
      await page.goto("/customers");
      await expect(page.locator(".customer-cards .mobile-card")).toHaveCount(8);
      await page.locator(".customer-cards .mobile-card").first().getByRole("checkbox").check();
      await expect(page.locator(".mobile-selection-bar")).toBeVisible();
      await page.getByRole("button", { name: /继续加载/ }).click();
      await expect(page.locator(".customer-cards .mobile-card")).toHaveCount(16);
      await page.goto("/weekly");
      await expect(page.locator(".nav-group").first().locator(".nav-link").first()).toHaveClass(/mobile-parent-active/);
      await page.goto("/proofs");
      await expect(page.locator(".nav-group").nth(1).locator(".nav-link").first()).toHaveClass(/mobile-parent-active/);
    }
    await page.goto("/ai-quality");
    await expect(page.getByRole("heading", { name: "AI 质量中心" })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);
    if (viewport.width === 390) {
      await expect(page.locator(".desktop-authoring")).toBeHidden();
      await expect(page.getByText("营销脑哈希对比、黄金集管理和模型路由编辑在桌面端开放；移动端仍可查看质量指标。")).toBeVisible();
      await page.locator(".role-button").click();
      await page.getByRole("menuitemradio").filter({ hasText: "销售" }).click();
      await page.goto("/customers");
      await page.locator(".customer-cards .mobile-card").first().getByRole("link").click();
      await expect(page.getByRole("button", { name: "原样采用并写入" })).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);
      await page.locator(".role-button").click();
      await page.getByRole("menuitemradio").filter({ hasText: "运营" }).click();
      await page.goto("/content?draft=draft-07");
      await page.getByRole("button", { name: "审阅 AI 候选" }).click();
      await expect(page.locator(".marketing-decision-panel")).toContainText("知识依据");
      expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);
    }
    expect(browserErrors).toEqual([]);
  });
}

test("customer context, first-screen NBA and blocked AI retry", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/customers?owner=陈牧&state=A1");
  const firstCustomer = page.locator(".customer-name").first();
  await firstCustomer.click();
  await expect(page.locator(".nba-focus").getByText("下一最佳动作", { exact: true })).toBeVisible();
  await expect(page.locator(".nba-focus")).toBeInViewport();
  await page.getByRole("button", { name: "AI 重新评估" }).click();
  await expect(page.getByText("操作未完成", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "返回原筛选" }).click();
  await expect(page).toHaveURL(/owner=.*state=A1/);
});

test("lead approves sensitive content and can undo", async ({ page }) => {
  await page.goto("/execution?tab=approvals");
  await page.locator(".role-button").click();
  await page.getByRole("menuitemradio").filter({ hasText: "负责人" }).click();
  const approval = page.locator(".approval-pending").first();
  await approval.getByPlaceholder("说明批准边界或退回原因").fill("仅允许销售场景，保留 14 天观察期说明");
  await approval.getByRole("button", { name: "批准" }).click();
  await expect(page.getByText("审批已通过")).toBeVisible();
  await page.getByRole("button", { name: "撤销" }).click();
  await expect(page.getByText("已撤销", { exact: true })).toBeVisible();
});

test("sales accepts the next best action and reaches the linked task", async ({ page }) => {
  await page.goto("/customers");
  await page.locator(".role-button").click();
  await page.getByRole("menuitemradio").filter({ hasText: "销售" }).click();
  await expect(page.getByLabel("按负责人筛选")).toHaveValue("陈牧");
  await page.locator(".customer-name").first().click();
  await page.getByRole("button", { name: "采纳并建任务" }).click();
  await expect(page.getByText("销售任务已建立", { exact: true })).toBeVisible();
  await page.getByRole("link", { name: "查看关联销售任务" }).click();
  await expect(page.locator(".row-focused")).toBeVisible();
});

test("revoking a proof blocks its dependent draft", async ({ page }) => {
  await page.goto("/proofs");
  await page.getByRole("button", { name: "编辑 7 人销售团队线索跟进校准" }).click();
  await page.getByLabel("授权状态").selectOption("revoked");
  await page.getByRole("button", { name: "保存证明资产" }).click();
  await expect(page.getByText("证明资产已更新", { exact: true })).toBeVisible();
  await page.goto("/content?draft=draft-03");
  await expect(page.getByText("引用已阻断", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "复制草稿" })).toBeDisabled();
});

test("1024 content workspace keeps evidence risks visible", async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 768 });
  await page.goto("/content?draft=draft-03");
  await expect(page.locator(".risk-pane")).toBeVisible();
  await expect(page.getByText("证据与风险", { exact: true })).toBeInViewport();
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);
});

test("role workspaces, role menu keyboard controls and execution tabs are accessible", async ({ page }) => {
  await page.goto("/");
  const roleButton = page.locator(".role-button");
  await roleButton.click();
  const selectedRole = page.getByRole("menuitemradio", { name: /运营/ });
  await expect(selectedRole).toBeFocused();
  await selectedRole.press("ArrowDown");
  await expect(page.getByRole("menuitemradio", { name: /销售/ })).toBeFocused();
  await page.getByRole("menuitemradio", { name: /销售/ }).press("Enter");
  await expect(page.getByRole("heading", { name: "我的销售工作台" })).toBeVisible();

  await roleButton.click();
  await page.getByRole("menuitemradio", { name: /销售/ }).press("Escape");
  await expect(page.getByRole("menu", { name: "切换内部角色" })).toHaveCount(0);
  await expect(roleButton).toBeFocused();

  await roleButton.click();
  await page.getByRole("menuitemradio", { name: /负责人/ }).click();
  await expect(page.getByRole("heading", { name: "审批与风险工作台" })).toBeVisible();
  await page.goto("/execution?tab=tasks");
  const taskTab = page.getByRole("tab", { name: /销售动作/ });
  await taskTab.press("ArrowRight");
  await expect(page).toHaveURL(/tab=approvals/);
  await expect(page.getByRole("tab", { name: /负责人审批/ })).toHaveAttribute("aria-selected", "true");
  await expect(page.locator(".approval-context").first()).toContainText("审批内容版本");
  await expect(page.locator(".approval-context").first()).toContainText("风险");
  await expect(page.locator(".approval-context").first()).toContainText("证据");
});

test("local AI key configuration keeps the secret ephemeral", async ({ page }) => {
  const secret = "local-playwright-secret-never-persisted";
  let configured = false;
  let submittedKey = "";

  await page.route("**/api/v2/health", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ok: true, ai_configured: configured, model: configured ? "gpt-test" : "gpt-5.6", fast_model: "gpt-5.6-terra", fast_model_available: true, data_mode: "http-sqlite", session_warning: null, config_source: configured ? "runtime" : "none", configured_at: configured ? "2026-08-23T16:00:00.000Z" : null }),
    });
  });
  await page.route("**/api/v2/ai/config", async (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    const body = route.request().postDataJSON() as { api_key: string; model: string };
    submittedKey = body.api_key;
    configured = true;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ configured: true, model: body.model, source: "runtime", configured_at: "2026-08-23T16:00:00.000Z" }),
    });
  });

  await page.goto("/governance");
  await page.getByRole("button", { name: "配置 API Key" }).click();
  const keyInput = page.getByLabel("OpenAI API Key");
  const submit = page.getByRole("button", { name: "验证并启用" });
  await expect(keyInput).toBeFocused();
  await keyInput.fill("short");
  await expect(submit).toBeDisabled();
  await keyInput.fill(secret);
  await expect(keyInput).toHaveAttribute("type", "password");
  await page.getByRole("button", { name: "显示 API Key" }).click();
  await expect(keyInput).toHaveAttribute("type", "text");
  await submit.click();

  await expect(page.getByText("AI 已配置", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "清除会话密钥" })).toBeVisible();
  expect(submittedKey).toBe(secret);
  expect(await page.evaluate((candidate) => Object.values(localStorage).some((value) => value.includes(candidate)), secret)).toBe(false);
  await expect(page.getByText(secret, { exact: true })).toHaveCount(0);
});

test("lead must explicitly confirm live Holdout usage", async ({ page }) => {
  await page.route("**/api/v2/health", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ok: true, ai_configured: true, knowledge_configured: true, model: "gpt-5.6", fast_model: "gpt-5.6-terra", fast_model_available: true, data_mode: "http-sqlite", session_warning: null, config_source: "runtime", configured_at: "2026-08-24T10:00:00.000Z" }),
    });
  });
  await page.reload();
  await page.locator(".role-button").click();
  await page.getByRole("menuitemradio").filter({ hasText: "负责人" }).click();
  await expect(page.locator(".role-button")).toContainText("负责人");
  await page.goto("/ai-quality");
  await page.getByRole("button", { name: "启动真实运行" }).click();
  const dialog = page.getByRole("dialog", { name: "确认真实 Holdout API 用量" });
  await expect(dialog).toBeVisible();
  const confirm = dialog.getByRole("button", { name: "确认并运行 88 条" });
  await expect(confirm).toBeDisabled();
  await dialog.getByRole("checkbox").check();
  await expect(confirm).toBeEnabled();
  await dialog.getByRole("button", { name: "取消" }).click();
  await expect(dialog).toHaveCount(0);
});

test("knowledge-grounded content loop reaches retrospective without automatic sending", async ({ page }) => {
  await page.goto("/weekly");
  const strategyCandidate = page.locator(".marketing-decision-panel").filter({ hasText: "本周策略候选" });
  await expect(strategyCandidate).toContainText("enterprise-wechat-friend-marketing");
  await expect(strategyCandidate).toContainText("进攻型增长");
  await strategyCandidate.getByRole("button", { name: "原样采用" }).click();
  await expect(page.getByText("候选已原样采用", { exact: true })).toBeVisible();

  await page.goto("/insights?status=accepted");
  const insight = page.locator(".insight-card").filter({ hasText: "担心工具增加维护负担" }).nth(1);
  await insight.getByRole("button", { name: "查看 Brief" }).click();
  const briefCandidate = page.locator(".marketing-decision-panel").filter({ hasText: "内容 Brief候选" });
  await expect(briefCandidate).toContainText("知识依据");
  await briefCandidate.locator("details").first().click();
  await expect(briefCandidate.locator("details").first().locator("small")).toContainText("chunk-");
  await briefCandidate.getByRole("button", { name: "原样采用" }).click();
  await expect(page.getByText("候选已原样采用", { exact: true })).toBeVisible();

  await page.goto("/content?draft=draft-07");
  await page.getByRole("button", { name: "审阅 AI 候选" }).click();
  const draftCandidate = page.locator(".marketing-decision-panel").filter({ hasText: "内容草稿候选" });
  await expect(draftCandidate).toContainText("业务证据");
  await draftCandidate.getByRole("button", { name: "原样采用" }).click();
  await expect(page.getByText("候选已原样采用", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "复制草稿" }).click();
  await page.getByRole("button", { name: "标记已发布" }).click();
  await page.getByRole("button", { name: "确认标记发布" }).click();
  await expect(page.getByText("已标记人工发布", { exact: true })).toBeVisible();

  await page.goto("/content?view=results");
  const latestPublication = page.locator(".publication-card").first();
  await latestPublication.getByRole("button", { name: "同步合成互动" }).click();
  await expect(page.getByText("合成互动已同步", { exact: true })).toBeVisible();
  await page.locator(".role-button").click();
  await page.getByRole("menuitemradio").filter({ hasText: "销售" }).click();
  await page.getByLabel("结果事实").fill("客户主动咨询实施清单并预约 Demo");
  await page.getByRole("button", { name: "保存业务结果" }).click();
  await expect(page.getByText("业务结果已回填", { exact: true })).toBeVisible();

  await page.goto("/weekly");
  await expect(page.getByRole("heading", { name: "第 4 周 内容结果" })).toBeVisible();
  await expect(page.getByText("时间关联，不代表因果", { exact: true })).toBeVisible();
});

test("raw message access is absent for operations and audited for owned sales conversations", async ({ page }) => {
  await page.goto("/insights");
  await expect(page.getByRole("button", { name: /查看 conv-.* 原文/ })).toHaveCount(0);
  await page.locator(".role-button").click();
  await page.getByRole("menuitemradio").filter({ hasText: "销售" }).click();
  const rawButton = page.getByRole("button", { name: /查看 conv-.* 原文/ }).first();
  await rawButton.click();
  await page.getByLabel("访问用途").selectOption({ label: "确认销售洞察" });
  await page.getByRole("button", { name: "记录用途并展开" }).click();
  await expect(page.locator(".raw-message-list")).toBeVisible();
  await page.getByRole("button", { name: "关闭对话框" }).click();
  await page.goto("/governance");
  await expect(page.getByText("查看会话原文", { exact: true })).toBeVisible();
});

test("sales adopts an AI candidate and records its seven-day review", async ({ page }) => {
  await page.locator(".role-button").click();
  await page.getByRole("menuitemradio").filter({ hasText: "销售" }).click();
  await page.goto("/customers");
  await page.getByText("待销售判断", { exact: true }).first().click();
  await expect(page.locator(".evaluation-candidate-panel")).toBeInViewport();
  await page.getByRole("button", { name: "原样采用并写入" }).click();
  await expect(page.getByText("AI 首稿已原样采用", { exact: true })).toBeVisible();

  await page.goto("/ai-quality");
  await expect(page.getByRole("heading", { name: "我的 AI 反馈" })).toBeVisible();
  const review = page.locator(".review-row").filter({ hasText: "cus-" }).first();
  await review.getByRole("button", { name: "保持有效" }).click();
  await expect(page.getByText("7 天质量复查已记录", { exact: true })).toBeVisible();
});

test("sales can modify a candidate with a structured reason", async ({ page }) => {
  await page.locator(".role-button").click();
  await page.getByRole("menuitemradio").filter({ hasText: "销售" }).click();
  await page.goto("/customers");
  await page.getByText("待销售判断", { exact: true }).first().click();
  await page.getByRole("button", { name: "修改后采用" }).click();
  await page.getByLabel("修改原因（必选）").selectOption("wrong_nba");
  await page.getByRole("button", { name: "确认判断" }).click();
  await expect(page.getByText("修改后已采用", { exact: true })).toBeVisible();
});

test("sales can reject a candidate without losing the selected reason", async ({ page }) => {
  await page.locator(".role-button").click();
  await page.getByRole("menuitemradio").filter({ hasText: "销售" }).click();
  await page.goto("/customers");
  await page.getByText("待销售判断", { exact: true }).first().click();
  await page.locator(".evaluation-candidate-panel").getByRole("button", { name: "拒绝", exact: true }).click();
  await page.getByLabel("拒绝原因（必选）").selectOption("missing_context");
  await page.getByRole("button", { name: "确认判断" }).click();
  await expect(page.getByText("AI 首稿已拒绝", { exact: true })).toBeVisible();
});

test("operations evaluates a code-bound marketing brain and lead publishes then rolls back", async ({ page }) => {
  await page.goto("/ai-quality");
  await expect(page.getByRole("heading", { name: "AI 质量中心" })).toBeVisible();
  await page.getByLabel("营销脑版本").selectOption("brain-v2.2-rc2");
  await page.getByLabel("数据切分").selectOption("holdout");
  await page.getByRole("button", { name: "运行离线评测" }).click();
  await expect(page.getByText("黄金集评测已完成", { exact: true })).toBeVisible();
  await expect(page.getByText("全部门槛通过", { exact: true })).toBeVisible();

  await page.locator(".role-button").click();
  await page.getByRole("menuitemradio").filter({ hasText: "负责人" }).click();
  const brainPanel = page.locator(".version-panel").filter({ hasText: "营销脑版本" });
  const candidateRow = brainPanel.locator(".version-row").filter({ hasText: "营销大脑 2.2-RC2" });
  await candidateRow.getByRole("button", { name: "发布" }).click();
  await expect(page.getByText("营销脑版本已发布", { exact: true })).toBeVisible();
  const baselineRow = brainPanel.locator(".version-row").filter({ hasText: "营销大脑 2.2-RC1" });
  await baselineRow.getByRole("button", { name: "回滚" }).click();
  await expect(page.getByText("营销脑已回滚", { exact: true })).toBeVisible();
});

test("knowledge governance previews Chinese retrieval and fixed skill routing", async ({ page }) => {
  await page.goto("/knowledge");
  await expect(page.getByRole("heading", { name: "知识治理" })).toBeVisible();
  await expect(page.getByText("中文 trigram", { exact: false })).toBeVisible();
  await page.getByLabel("业务问题").fill("企微客户分组 周策略 窄市场 内容实验 授权门禁");
  await page.getByRole("button", { name: "检索预览" }).click();
  await expect(page.locator(".skill-route")).toContainText("enterprise-wechat-friend-marketing");
  await expect(page.locator(".skill-route")).toContainText("marketing-growth-system");
  await expect(page.locator(".retrieval-results article").first()).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(1);
});
