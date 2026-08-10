import { createApp } from "./app";
import { loadConfig } from "./config";
import { ApiKeyAuthenticator } from "./services/api-key-authenticator";
import { createStartupDependencyDiagnostic, SystemReadinessChecker } from "./services/readiness";

const config = loadConfig();
const readiness = new SystemReadinessChecker(config.tempDir);
const startupReadiness = await readiness.check();

console.log(JSON.stringify(createStartupDependencyDiagnostic(startupReadiness)));

const app = createApp({
  apiKeyAuthenticator: new ApiKeyAuthenticator(config.apiKeys),
  readiness,
});

const server = Bun.serve({
  fetch: app.fetch,
  hostname: config.host,
  port: config.port,
});

console.log(`Media Downloader listening on ${server.url}`);
