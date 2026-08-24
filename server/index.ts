import fs from "node:fs";
import { bindDemoStateToActiveKnowledge, createApp } from "./app";
import { createOpenAiServiceManager } from "./ai-service";
import { defaultDatabasePath, SqliteStateRepository } from "./repository";
import { SessionManager } from "./session";
import { KnowledgeService } from "./knowledge-service";
import { restorePersistedModelProfile } from "./model-profile-runtime";

if (fs.existsSync(".env")) process.loadEnvFile(".env");

const port = Number.parseInt(process.env.PORT || "4175", 10);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("PORT must be an integer between 1 and 65535");

const aiService = createOpenAiServiceManager({ apiKey: process.env.OPENAI_API_KEY, model: process.env.OPENAI_MODEL, fastModel: process.env.OPENAI_FAST_MODEL });
const repository = new SqliteStateRepository(defaultDatabasePath());
const knowledgeService = new KnowledgeService({ filename: defaultDatabasePath(), packPath: process.env.KNOWLEDGE_PACK_PATH });
if (knowledgeService.configured && !knowledgeService.status("tenant-dogfood-cn").active_version) {
  const indexed = knowledgeService.reindex("tenant-dogfood-cn");
  knowledgeService.activate("tenant-dogfood-cn", indexed.version.id);
}
const initial = repository.load("tenant-dogfood-cn");
if (initial.repositoryRevision === 1 && knowledgeService.status("tenant-dogfood-cn").active_version) {
  const hydrated = bindDemoStateToActiveKnowledge(initial.state, "tenant-dogfood-cn", knowledgeService);
  repository.save("tenant-dogfood-cn", hydrated, initial.repositoryRevision);
}
const profileRestoreStatus = restorePersistedModelProfile(repository, aiService, "tenant-dogfood-cn");
const sessionManager = new SessionManager(process.env.SESSION_SECRET);
const app = createApp({ aiService, repository, knowledgeService, sessionManager, serveDist: process.env.SERVE_DIST === "true" });
const server = app.listen(port, "127.0.0.1", () => {
  console.log(`Trust-to-Action 2.3 listening on http://127.0.0.1:${port} (AI ${aiService.configured ? "configured" : "blocked"}, knowledge ${knowledgeService.configured ? "configured" : "blocked"}, provider ${aiService.getConfiguration().provider}, primary ${aiService.model}, fallback ${aiService.fastModel ?? "none"}, restore ${profileRestoreStatus})`);
});

function shutdown() {
  server.close(() => { knowledgeService.close(); repository.close(); process.exit(0); });
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
