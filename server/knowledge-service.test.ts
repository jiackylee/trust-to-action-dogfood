import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { chunkMarkdown, KnowledgeService, routeSkills } from "./knowledge-service";

const cleanup: string[] = [];
afterEach(() => { for (const target of cleanup.splice(0)) fs.rmSync(target, { recursive: true, force: true }); });

function createPack() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "tta-knowledge-"));
  cleanup.push(root);
  const wechat = path.join(root, "skills/enterprise-wechat-friend-marketing");
  const growth = path.join(root, "skills/marketing-growth-system");
  fs.mkdirSync(path.join(growth, "references"), { recursive: true });
  fs.mkdirSync(wechat, { recursive: true });
  const paragraph = "企微客户分组策略必须基于带时间的有效证据，弱信号不能替代主动咨询。授权、频控、证明审批和禁止自动外发始终优先。";
  fs.writeFileSync(path.join(wechat, "SKILL.md"), `# 企业微信营销\n\n## 客户分组与证据\n\n${Array(18).fill(paragraph).join("\n\n")}\n`, "utf8");
  fs.writeFileSync(path.join(growth, "SKILL.md"), `# 进攻型增长\n\n## 窄市场实验\n\n${Array(18).fill("聚焦窄市场，提高内容密度，快速设计可测实验，再放大已经有效的组合。客户分组策略需要明确测量计划。").join("\n\n")}\n`, "utf8");
  fs.writeFileSync(path.join(growth, "references/theory-library.md"), `# 理论索引\n\n未解析：/Users/example/private/missing-theory.md\n\n${Array(10).fill(paragraph).join("\n\n")}`, "utf8");
  return root;
}

describe("knowledge service", () => {
  it("creates heading-aware chunks within the context contract", () => {
    const content = `# 总标题\n\n## 规则\n\n${Array(60).fill("客户状态判断依赖证据和下一动作。增长实验必须保留测量计划。").join("\n\n")}`;
    const chunks = chunkMarkdown(content);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((item) => item.content.length <= 1600)).toBe(true);
    expect(chunks.every((item) => item.heading_path.join("/").includes("规则"))).toBe(true);
  });

  it("routes core, enterprise and global skills deterministically", () => {
    expect(routeSkills({ query: "企微周策略", market: "china", channels: ["enterprise_wechat"] })).toEqual(["enterprise-wechat-friend-marketing", "marketing-growth-system"]);
    expect(routeSkills({ query: "CRM 与官网跨渠道协同", market: "china", channels: ["website"] })).toContain("enterprise-marketing-brain");
    expect(routeSkills({ query: "北美企业微信替代渠道", market: "north_america", channels: [] })).toContain("global-marketing-brain");
  });

  it("blocks missing packs and retrieves only active indexed knowledge", () => {
    const missing = new KnowledgeService({ packPath: null });
    expect(missing.status("tenant-a").error?.code).toBe("KNOWLEDGE_NOT_CONFIGURED");
    expect(() => missing.retrieve({ tenantId: "tenant-a", taskType: "weekly_strategy", query: "客户分组策略" })).toThrowError(/尚未索引并激活/);
    missing.close();

    const service = new KnowledgeService({ packPath: createPack() });
    const indexed = service.reindex("tenant-a");
    expect(indexed.version.chunk_count).toBeGreaterThan(0);
    expect(indexed.sources.some((item) => item.status === "unresolved")).toBe(true);
    service.activate("tenant-a", indexed.version.id);
    const result = service.retrieve({ tenantId: "tenant-a", taskType: "weekly_strategy", query: "企微客户分组策略 有效证据", market: "china" });
    expect(result.references.length).toBeGreaterThan(0);
    expect(result.references.length).toBeLessThanOrEqual(8);
    expect(Math.max(...Object.values(Object.fromEntries(result.references.map((item) => [item.source_id, result.references.filter((ref) => ref.source_id === item.source_id).length]))))).toBeLessThanOrEqual(2);
    expect(result.skill_route).toEqual(["enterprise-wechat-friend-marketing", "marketing-growth-system"]);
    service.close();
  });
});
