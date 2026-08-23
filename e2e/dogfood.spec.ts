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
    if (viewport.width === 390) await expect(page.locator(".desktop-table")).toBeHidden();
    expect(browserErrors).toEqual([]);
  });
}

test("customer context, first-screen NBA and blocked AI retry", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/customers?owner=陈牧&state=A1");
  const firstCustomer = page.locator(".customer-name").first();
  await firstCustomer.click();
  await expect(page.getByText("下一最佳动作", { exact: true })).toBeVisible();
  await expect(page.locator(".nba-focus")).toBeInViewport();
  await page.getByRole("button", { name: "AI 重新评估" }).click();
  await expect(page.getByText(/AI_NOT_CONFIGURED/)).toBeVisible();
  await page.getByRole("button", { name: "返回原筛选" }).click();
  await expect(page).toHaveURL(/owner=.*state=A1/);
});

test("lead approves sensitive content and can undo", async ({ page }) => {
  await page.goto("/execution?tab=approvals");
  await page.locator(".role-button").click();
  await page.getByRole("menuitem").filter({ hasText: "负责人" }).click();
  const approval = page.locator(".approval-pending").first();
  await approval.getByPlaceholder("说明批准边界或退回原因").fill("仅允许销售场景，保留 14 天观察期说明");
  await approval.getByRole("button", { name: "批准" }).click();
  await expect(page.getByText("审批已通过")).toBeVisible();
  await page.getByRole("button", { name: "撤销" }).click();
  await expect(page.getByText("已撤销", { exact: true })).toBeVisible();
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
