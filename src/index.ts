import { createApp } from "./app";
import { loadConfig } from "./config";
import { ApiKeyAuthenticator } from "./services/api-key-authenticator";
import { MediaInfoService } from "./services/media-info";
import { MediaUrlValidator } from "./services/media-url-validator";
import { ProcessRunner } from "./services/process-runner";
import { createStartupDependencyDiagnostic, SystemReadinessChecker } from "./services/readiness";
import { YtDlpAdapter } from "./services/yt-dlp";

const config = loadConfig();
const readiness = new SystemReadinessChecker(config.tempDir);
const processRunner = new ProcessRunner();
const mediaInfo = new MediaInfoService(
  new MediaUrlValidator(),
  new YtDlpAdapter(processRunner, {
    timeoutMilliseconds: Math.min(config.jobTimeoutSeconds * 1_000, 60_000),
  }),
  config.maxDurationSeconds,
);
const startupReadiness = await readiness.check();

console.log(JSON.stringify(createStartupDependencyDiagnostic(startupReadiness)));

const app = createApp({
  apiKeyAuthenticator: new ApiKeyAuthenticator(config.apiKeys),
  mediaInfo,
  readiness,
});

const server = Bun.serve({
  fetch: app.fetch,
  hostname: config.host,
  port: config.port,
});

console.log(`Media Downloader listening on ${server.url}`);
