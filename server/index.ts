import { createApp } from "./app";
import { createOpenAiServiceManager } from "./ai-service";
import { defaultDatabasePath, SqliteStateRepository } from "./repository";
import { SessionManager } from "./session";

const port = Number.parseInt(process.env.PORT || "4175", 10);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("PORT must be an integer between 1 and 65535");

const aiService = createOpenAiServiceManager({ apiKey: process.env.OPENAI_API_KEY, model: process.env.OPENAI_MODEL, fastModel: process.env.OPENAI_FAST_MODEL });
const repository = new SqliteStateRepository(defaultDatabasePath());
const sessionManager = new SessionManager(process.env.SESSION_SECRET);
const app = createApp({ aiService, repository, sessionManager, serveDist: process.env.SERVE_DIST === "true" });
const server = app.listen(port, "127.0.0.1", () => {
  console.log(`Trust-to-Action 2.1 listening on http://127.0.0.1:${port} (AI ${aiService.configured ? "configured" : "blocked"}, primary ${aiService.model}, fast ${aiService.fastModel})`);
});

function shutdown() {
  server.close(() => { repository.close(); process.exit(0); });
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
