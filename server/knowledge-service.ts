import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import type {
  KnowledgeChunk,
  KnowledgeKind,
  KnowledgePackVersion,
  KnowledgeReference,
  KnowledgeRetrievalRun,
  KnowledgeSource,
  MarketingTaskType,
} from "../src/domain/types";
import { AiServiceError } from "./ai-service";

const SKILLS = [
  "enterprise-wechat-friend-marketing",
  "marketing-growth-system",
  "enterprise-marketing-brain",
  "global-marketing-brain",
] as const;

const FINAL_DOCUMENTS = new Set([
  "企业微信好友全生命周期营销手册.md",
  "朋友圈特征与IP属性分析及运营框架_第四轮迭代.md",
  "朋友圈运营框架Agent化方案_Trust-to-Action.md",
  "客户分组营销技能树.md",
  "个人Marketing技能树与营销理论框架.md",
]);

export interface KnowledgeStatus {
  configured: boolean;
  pack_path: string | null;
  active_version: KnowledgePackVersion | null;
  versions: KnowledgePackVersion[];
  sources: KnowledgeSource[];
  unresolved_sources: KnowledgeSource[];
  duplicate_sources: KnowledgeSource[];
  recent_retrievals: KnowledgeRetrievalRun[];
  error: { code: string; message: string } | null;
}

export interface RetrievalRequest {
  tenantId: string;
  taskType: MarketingTaskType;
  query: string;
  market?: string;
  channels?: string[];
  lifecycle?: string[];
  stages?: Array<"T" | "I" | "D" | "A">;
}

export interface RetrievalResult {
  references: KnowledgeReference[];
  skill_route: string[];
  conflicts: string[];
  run: KnowledgeRetrievalRun;
}

export function routeSkills(input: Pick<RetrievalRequest, "query" | "market" | "channels">) {
  const text = `${input.query} ${input.market ?? ""} ${(input.channels ?? []).join(" ")}`;
  const route = ["enterprise-wechat-friend-marketing", "marketing-growth-system"];
  if (/跨渠道|CRM|组织|官网|邮件|销售协同|渠道协同/iu.test(text)) route.push("enterprise-marketing-brain");
  if (/北美|美国|加拿大|欧洲|欧盟|英国|德国|法国|North America|Europe|EU\b/iu.test(text)) route.push("global-marketing-brain");
  return route;
}

function hash(value: string) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function walkMarkdown(root: string) {
  const files: string[] = [];
  const visit = (current: string) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (entry.name.startsWith(".") || entry.name === "node_modules" || entry.name === "books-markdown") continue;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) visit(full);
      else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) files.push(full);
    }
  };
  visit(root);
  return files;
}

function includedSource(root: string, filename: string) {
  const relative = path.relative(root, filename).split(path.sep).join("/");
  const inSkill = SKILLS.some((skill) => relative === `${skill}/SKILL.md` || relative.startsWith(`${skill}/references/`) || relative.startsWith(`skills/${skill}/`));
  return inSkill || FINAL_DOCUMENTS.has(path.basename(filename));
}

function titleFromMarkdown(content: string, filename: string) {
  return content.match(/^#\s+(.+)$/mu)?.[1]?.trim() || path.basename(filename, path.extname(filename));
}

function skillFromPath(relative: string) {
  return SKILLS.find((skill) => relative.includes(skill)) ?? (/企业微信|朋友圈/iu.test(relative) ? "enterprise-wechat-friend-marketing" : "marketing-growth-system");
}

function inferTasks(text: string): MarketingTaskType[] {
  const tasks = new Set<MarketingTaskType>();
  if (/策略|经营|增长|复盘|市场选择/iu.test(text)) tasks.add("weekly_strategy");
  if (/Brief|选题|角度|目标客户|内容规划/iu.test(text)) tasks.add("content_brief");
  if (/朋友圈|草稿|文案|CTA|表达|内容/iu.test(text)) tasks.add("content_draft");
  if (/NBA|下一动作|客户状态|跟进|销售|线索|转化/iu.test(text)) tasks.add("customer_nba");
  if (!tasks.size) ["weekly_strategy", "content_brief", "content_draft", "customer_nba"].forEach((task) => tasks.add(task as MarketingTaskType));
  return [...tasks];
}

function inferKind(text: string): KnowledgeKind {
  if (/禁止|不得|严禁|不能自动|不可/iu.test(text)) return "prohibited_action";
  if (/必须|合规|授权|门禁|边界|硬规则/iu.test(text)) return "hard_guardrail";
  if (/假设|待验证|实验/iu.test(text)) return "test_hypothesis";
  if (/基线|参考值|经验值/iu.test(text)) return "experience_baseline";
  if (/实战|已验证|复盘结果|案例经验/iu.test(text)) return "verified_experience";
  if (/理论|定律|模型|框架/iu.test(text)) return "theory";
  return "operating_principle";
}

function inferStages(text: string) {
  const stages = (["T", "I", "D", "A"] as const).filter((stage) => new RegExp(`(?:^|[^A-Z])${stage}(?:1)?(?:[^A-Z]|$)`, "u").test(text));
  return stages.length ? stages : (["T", "I", "D", "A"] as const).slice();
}

function inferMarkets(text: string) {
  if (/北美|美国|加拿大|North America/iu.test(text)) return ["north_america"];
  if (/欧洲|欧盟|英国|德国|法国|Europe|EU\b/iu.test(text)) return ["europe"];
  return ["china"];
}

function inferChannels(text: string) {
  const channels = [];
  if (/企微|企业微信|朋友圈/iu.test(text)) channels.push("enterprise_wechat");
  if (/官网/iu.test(text)) channels.push("website");
  if (/邮件/iu.test(text)) channels.push("email");
  return channels.length ? channels : ["enterprise_wechat"];
}

export interface MarkdownChunkDraft {
  heading_path: string[];
  content: string;
  ordinal: number;
}

export function chunkMarkdown(content: string, minimum = 400, maximum = 1600, overlap = 120): MarkdownChunkDraft[] {
  const lines = content.replace(/\r\n?/gu, "\n").split("\n");
  const headings: string[] = [];
  const sections: Array<{ heading_path: string[]; text: string }> = [];
  let buffer: string[] = [];
  const flush = () => {
    const text = buffer.join("\n").trim();
    if (text) sections.push({ heading_path: [...headings], text });
    buffer = [];
  };
  for (const line of lines) {
    const match = line.match(/^(#{1,6})\s+(.+)$/u);
    if (!match) { buffer.push(line); continue; }
    flush();
    const depth = match[1].length;
    headings.splice(depth - 1);
    headings[depth - 1] = match[2].trim();
  }
  flush();

  const drafts: MarkdownChunkDraft[] = [];
  let carry = "";
  for (const section of sections) {
    const paragraphs = section.text.split(/\n{2,}/u).map((item) => item.trim()).filter(Boolean);
    let current = carry;
    for (const paragraph of paragraphs) {
      if (current && current.length + paragraph.length + 2 > maximum) {
        drafts.push({ heading_path: section.heading_path, content: current.trim(), ordinal: drafts.length });
        current = `${current.slice(-overlap)}\n\n${paragraph}`;
      } else current = current ? `${current}\n\n${paragraph}` : paragraph;
    }
    if (current.length >= minimum) {
      drafts.push({ heading_path: section.heading_path, content: current.trim(), ordinal: drafts.length });
      carry = current.slice(-overlap);
    } else carry = current;
  }
  if (carry.trim() && (!drafts.length || drafts.at(-1)?.content !== carry.trim())) {
    if (drafts.length && drafts.at(-1)!.content.length + carry.length <= maximum) drafts[drafts.length - 1].content = `${drafts.at(-1)!.content}\n\n${carry}`.trim();
    else drafts.push({ heading_path: sections.at(-1)?.heading_path ?? [], content: carry.trim(), ordinal: drafts.length });
  }
  return drafts.filter((item) => item.content.length > 0).map((item, ordinal) => ({ ...item, ordinal }));
}

function ftsExpression(query: string) {
  const segments = query.replace(/["'():*^]/gu, " ").split(/[\s，。；、！？/]+/u).map((item) => item.trim()).filter((item) => item.length >= 3);
  const terms = [...new Set(segments.flatMap((segment) => segment.length <= 4 ? [segment] : Array.from({ length: segment.length - 2 }, (_, index) => segment.slice(index, index + 3))))].slice(0, 28);
  return terms.map((term) => `"${term}"`).join(" OR ");
}

export class KnowledgeService {
  #database: Database.Database;
  #packPath: string | null;

  constructor({ filename = ":memory:", packPath = process.env.KNOWLEDGE_PACK_PATH?.trim() || null }: { filename?: string; packPath?: string | null } = {}) {
    if (filename !== ":memory:") fs.mkdirSync(path.dirname(filename), { recursive: true });
    this.#database = new Database(filename);
    this.#database.pragma("journal_mode = WAL");
    const migrationPath = path.resolve(process.cwd(), "server/migrations/002_knowledge.sql");
    this.#database.exec(fs.readFileSync(migrationPath, "utf8"));
    this.#packPath = packPath;
  }

  get configured() { return Boolean(this.#packPath && fs.existsSync(this.#packPath)); }

  status(tenantId: string): KnowledgeStatus {
    const versions = this.#database.prepare("SELECT payload_json FROM knowledge_pack_versions WHERE tenant_id = ? ORDER BY updated_at DESC").all(tenantId).map((row) => JSON.parse((row as { payload_json: string }).payload_json) as KnowledgePackVersion);
    const sources = this.#database.prepare("SELECT payload_json FROM knowledge_sources WHERE tenant_id = ? ORDER BY relative_path").all(tenantId).map((row) => JSON.parse((row as { payload_json: string }).payload_json) as KnowledgeSource);
    const recent = this.#database.prepare("SELECT payload_json FROM knowledge_retrieval_runs WHERE tenant_id = ? ORDER BY created_at DESC LIMIT 20").all(tenantId).map((row) => JSON.parse((row as { payload_json: string }).payload_json) as KnowledgeRetrievalRun);
    const configured = this.configured;
    return {
      configured,
      pack_path: configured ? path.basename(this.#packPath!) : null,
      active_version: versions.find((item) => item.status === "active") ?? null,
      versions,
      sources,
      unresolved_sources: sources.filter((item) => item.status === "unresolved"),
      duplicate_sources: sources.filter((item) => item.status === "duplicate"),
      recent_retrievals: recent,
      error: configured ? null : { code: "KNOWLEDGE_NOT_CONFIGURED", message: "未配置可读的 KNOWLEDGE_PACK_PATH，知识增强生成已阻断。" },
    };
  }

  reindex(tenantId: string) {
    if (!this.configured || !this.#packPath) throw new AiServiceError(503, "KNOWLEDGE_NOT_CONFIGURED", "未配置可读的 KNOWLEDGE_PACK_PATH，不能建立知识索引。", false);
    const startedAt = new Date().toISOString();
    const files = walkMarkdown(this.#packPath).filter((file) => includedSource(this.#packPath!, file));
    if (!files.length) throw new AiServiceError(422, "KNOWLEDGE_PACK_EMPTY", "知识包中没有找到四套 SKILL 或五份最终资料。", false);
    const sourceDrafts = files.map((filename) => {
      const content = fs.readFileSync(filename, "utf8");
      return { filename, relative: path.relative(this.#packPath!, filename).split(path.sep).join("/"), content, contentHash: hash(content) };
    });
    const packHash = hash(sourceDrafts.map((item) => `${item.relative}:${item.contentHash}`).sort().join("\n"));
    const packId = `knowledge-${packHash.slice(0, 12)}`;
    const seen = new Map<string, string>();
    const now = new Date().toISOString();
    const sources: KnowledgeSource[] = [];
    const chunks: KnowledgeChunk[] = [];

    for (const draft of sourceDrafts) {
      const duplicateOf = seen.get(draft.contentHash);
      seen.set(draft.contentHash, draft.relative);
      const skill = skillFromPath(draft.relative);
      const title = titleFromMarkdown(draft.content, draft.filename);
      const sourceId = `source-${hash(draft.relative).slice(0, 12)}`;
      const chunkDrafts = duplicateOf ? [] : chunkMarkdown(draft.content);
      const source: KnowledgeSource = {
        id: sourceId, revision: 1, updated_at: now, pack_version_id: packId, relative_path: draft.relative, title, skill, version: "2.2",
        market: inferMarkets(`${draft.relative} ${title}`), channels: inferChannels(`${draft.relative} ${title}`), tasks: inferTasks(`${title}\n${draft.content.slice(0, 3000)}`),
        lifecycle: ["acquisition", "nurture", "conversion", "retention"], stages: inferStages(draft.content), knowledge_kind: inferKind(`${draft.relative}\n${draft.content.slice(0, 2000)}`),
        status: duplicateOf ? "duplicate" : "ready", content_hash: draft.contentHash, chunk_count: chunkDrafts.length, error: duplicateOf ? `与 ${duplicateOf} 内容重复` : null,
      };
      sources.push(source);
      for (const chunk of chunkDrafts) {
        const kind = inferKind(`${chunk.heading_path.join(" ")}\n${chunk.content}`);
        const chunkHash = hash(`${draft.relative}:${chunk.ordinal}:${chunk.content}`);
        chunks.push({
          id: `chunk-${chunkHash.slice(0, 16)}`, revision: 1, updated_at: now, pack_version_id: packId, source_id: sourceId,
          heading_path: chunk.heading_path, ordinal: chunk.ordinal, content: chunk.content, content_hash: chunkHash, char_count: chunk.content.length,
          skill, market: inferMarkets(`${draft.relative} ${chunk.content}`), channels: inferChannels(chunk.content), tasks: inferTasks(`${chunk.heading_path.join(" ")} ${chunk.content}`),
          lifecycle: source.lifecycle, stages: inferStages(chunk.content), knowledge_kind: kind,
        });
      }
    }

    for (const draft of sourceDrafts.filter((item) => item.relative.endsWith("theory-library.md"))) {
      for (const match of draft.content.matchAll(/((?:\/Users|\/home)\/[^\s)]+\.md)/gmu)) {
        if (fs.existsSync(match[1])) continue;
        const sourceHash = hash(match[1]);
        sources.push({
          id: `source-unresolved-${sourceHash.slice(0, 12)}`, revision: 1, updated_at: now, pack_version_id: packId, relative_path: match[1], title: path.basename(match[1]),
          skill: skillFromPath(draft.relative), version: "unresolved", market: [], channels: [], tasks: [], lifecycle: [], stages: [], knowledge_kind: "theory",
          status: "unresolved", content_hash: sourceHash, chunk_count: 0, error: "外部绝对路径不可解析，未进入生成上下文",
        });
      }
    }

    const version: KnowledgePackVersion = {
      id: packId, revision: 1, updated_at: now, name: `private-pack-${packHash.slice(0, 8)}`, content_hash: packHash, status: "indexed",
      source_count: sources.length, chunk_count: chunks.length, unresolved_count: sources.filter((item) => item.status === "unresolved").length,
      duplicate_count: sources.filter((item) => item.status === "duplicate").length, indexed_at: now, activated_at: null, error: null,
    };

    const transaction = this.#database.transaction(() => {
      this.#database.prepare("DELETE FROM knowledge_chunks WHERE tenant_id = ? AND pack_version_id = ?").run(tenantId, packId);
      this.#database.prepare("DELETE FROM knowledge_sources WHERE tenant_id = ? AND pack_version_id = ?").run(tenantId, packId);
      const insertSource = this.#database.prepare("INSERT INTO knowledge_sources (tenant_id,id,pack_version_id,relative_path,content_hash,status,payload_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)");
      for (const source of sources) insertSource.run(tenantId, source.id, packId, source.relative_path, source.content_hash, source.status, JSON.stringify(source), startedAt, now);
      const insertChunk = this.#database.prepare("INSERT INTO knowledge_chunks (tenant_id,id,pack_version_id,source_id,ordinal,task_csv,skill,market_csv,knowledge_kind,content_hash,payload_json) VALUES (?,?,?,?,?,?,?,?,?,?,?)");
      for (const chunk of chunks) insertChunk.run(tenantId, chunk.id, packId, chunk.source_id, chunk.ordinal, chunk.tasks.join(","), chunk.skill, chunk.market.join(","), chunk.knowledge_kind, chunk.content_hash, JSON.stringify(chunk));
      this.#database.prepare("INSERT INTO knowledge_pack_versions (tenant_id,id,revision,status,content_hash,payload_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(tenant_id,id) DO UPDATE SET revision=revision+1,status=excluded.status,payload_json=excluded.payload_json,updated_at=excluded.updated_at")
        .run(tenantId, packId, 1, version.status, packHash, JSON.stringify(version), startedAt, now);
    });
    transaction();
    return { version, sources, chunks };
  }

  activate(tenantId: string, versionId: string) {
    const status = this.status(tenantId);
    const selected = status.versions.find((item) => item.id === versionId);
    if (!selected) throw new AiServiceError(404, "KNOWLEDGE_VERSION_NOT_FOUND", "知识包版本不存在。", false);
    const now = new Date().toISOString();
    const transaction = this.#database.transaction(() => {
      for (const version of status.versions) {
        const next: KnowledgePackVersion = { ...version, revision: version.revision + 1, updated_at: now, status: version.id === versionId ? "active" : "archived", activated_at: version.id === versionId ? now : version.activated_at };
        this.#database.prepare("UPDATE knowledge_pack_versions SET revision=?,status=?,payload_json=?,updated_at=? WHERE tenant_id=? AND id=?").run(next.revision, next.status, JSON.stringify(next), now, tenantId, version.id);
      }
    });
    transaction();
    return this.status(tenantId);
  }

  rollback(tenantId: string) {
    const versions = this.status(tenantId).versions.filter((item) => item.activated_at).sort((a, b) => (b.activated_at ?? "").localeCompare(a.activated_at ?? ""));
    if (versions.length < 2) throw new AiServiceError(409, "NO_KNOWLEDGE_ROLLBACK", "没有可回滚的上一知识版本。", false);
    return this.activate(tenantId, versions[1].id);
  }

  retrieve(input: RetrievalRequest): RetrievalResult {
    const active = this.status(input.tenantId).active_version;
    if (!active) throw new AiServiceError(503, "KNOWLEDGE_NOT_CONFIGURED", "知识包尚未索引并激活，生成已阻断。", false);
    const started = Date.now();
    const route = routeSkills(input);
    const expression = ftsExpression(input.query);
    if (!expression) throw new AiServiceError(422, "KNOWLEDGE_QUERY_TOO_SHORT", "检索问题缺少可用的三字关键词。", false);
    const taskFilter = `%${input.taskType}%`;
    const rows = this.#database.prepare(`SELECT c.payload_json, bm25(knowledge_chunks_fts, 1.0, 0.3) AS rank
      FROM knowledge_chunks_fts JOIN knowledge_chunks c ON c.rowid = knowledge_chunks_fts.rowid
      WHERE knowledge_chunks_fts MATCH ? AND c.tenant_id = ? AND c.pack_version_id = ? AND c.task_csv LIKE ?
      ORDER BY rank LIMIT 80`).all(expression, input.tenantId, active.id, taskFilter) as Array<{ payload_json: string; rank: number }>;
    const sourceMap = new Map(this.status(input.tenantId).sources.map((source) => [source.id, source]));
    const selected: Array<{ chunk: KnowledgeChunk; rank: number }> = [];
    const perSource = new Map<string, number>();
    let total = 0;
    for (const row of rows) {
      const chunk = JSON.parse(row.payload_json) as KnowledgeChunk;
      if (!route.includes(chunk.skill)) continue;
      if ((perSource.get(chunk.source_id) ?? 0) >= 2 || selected.length >= 8 || total + chunk.char_count > 6000) continue;
      if (input.market && chunk.market.length && !chunk.market.includes(input.market) && !chunk.market.includes("global")) continue;
      selected.push({ chunk, rank: row.rank });
      perSource.set(chunk.source_id, (perSource.get(chunk.source_id) ?? 0) + 1);
      total += chunk.char_count;
    }
    if (!selected.length) throw new AiServiceError(422, "KNOWLEDGE_NO_MATCH", "当前知识包没有适用于该任务的可引用内容。", false);
    const references = selected.map(({ chunk, rank }) => {
      const source = sourceMap.get(chunk.source_id)!;
      return { chunk_id: chunk.id, source_id: source.id, source_title: source.title, heading_path: chunk.heading_path, knowledge_kind: chunk.knowledge_kind, skill: chunk.skill, version: source.version, excerpt: chunk.content.slice(0, 420), score: Number((-rank).toFixed(4)) } satisfies KnowledgeReference;
    });
    const hasGuardrail = references.some((item) => ["hard_guardrail", "prohibited_action"].includes(item.knowledge_kind));
    const hasGrowth = references.some((item) => item.skill === "marketing-growth-system" && !["hard_guardrail", "prohibited_action"].includes(item.knowledge_kind));
    const conflicts = hasGuardrail && hasGrowth ? ["检测到增长战术与硬门禁同时适用；生成时按合规与已发布事实优先，并展示冲突。"] : [];
    const now = new Date().toISOString();
    const run: KnowledgeRetrievalRun = {
      id: `retrieval-${crypto.randomUUID()}`, revision: 1, updated_at: now, task_type: input.taskType, query: input.query,
      filters: { market: input.market ? [input.market] : [], channels: input.channels ?? [], lifecycle: input.lifecycle ?? [], stages: input.stages ?? [] },
      skill_route: route, chunk_refs: references.map((item) => item.chunk_id), source_refs: [...new Set(references.map((item) => item.source_id))],
      conflict_count: conflicts.length, latency_ms: Date.now() - started, result_count: references.length, created_at: now,
    };
    this.#database.prepare("INSERT INTO knowledge_retrieval_runs (tenant_id,id,payload_json,created_at) VALUES (?,?,?,?)").run(input.tenantId, run.id, JSON.stringify(run), now);
    return { references, skill_route: route, conflicts, run };
  }

  close() { this.#database.close(); }
}
