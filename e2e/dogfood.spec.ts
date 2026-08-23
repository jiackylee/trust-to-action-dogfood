import { expect, test } from "@playwright/test";

for (const viewport of [{ width: 1440, height: 900 }, { width: 1024, height: 768 }, { width: 390, height: 844 }]) {
  test(`responsive shell ${viewport.width}x${viewport.height}`, async ({ page }) => {
    const browserErrors: string[] = [];
    page.on("pageerror", (error) => browserErrors.push(error.message));
    page.on("console", (message) => { if (message.type() === "error") browserErrors.push(message.text()); });
    await page.setViewportSize(viewport);
    await page.goto("/");
    await expect(page.getByRole("heading", { name: "本周经营台" })).toBeVisible();
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
      body: JSON.stringify({ ok: true, ai_configured: configured, model: configured ? "gpt-test" : "gpt-5.6", config_source: configured ? "runtime" : "none", configured_at: configured ? "2026-08-23T16:00:00.000Z" : null }),
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
