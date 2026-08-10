import { createApp } from "./app";
import { loadConfig } from "./config";
import { ApiKeyAuthenticator } from "./services/api-key-authenticator";
import { SystemReadinessChecker } from "./services/readiness";

const config = loadConfig();
const app = createApp({
  apiKeyAuthenticator: new ApiKeyAuthenticator(config.apiKeys),
  readiness: new SystemReadinessChecker(config.tempDir),
});

const server = Bun.serve({
  fetch: app.fetch,
  hostname: config.host,
  port: config.port,
});

console.log(`Media Downloader listening on ${server.url}`);
