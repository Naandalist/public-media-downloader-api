import { createApp } from "./app";
import { loadConfig } from "./config";
import { SystemReadinessChecker } from "./services/readiness";

const config = loadConfig();
const app = createApp({
  readiness: new SystemReadinessChecker(config.tempDir),
});

const server = Bun.serve({
  fetch: app.fetch,
  hostname: config.host,
  port: config.port,
});

console.log(`Media Downloader listening on ${server.url}`);
