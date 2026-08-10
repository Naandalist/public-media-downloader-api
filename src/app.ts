import { Hono } from "hono";

import type { MediaInfoInspector } from "./domain/media";
import { errorHandler, notFoundHandler } from "./middleware/error-handler";
import { requestIdMiddleware } from "./middleware/request-id";
import { securityHeadersMiddleware } from "./middleware/security-headers";
import { createApiRoutes } from "./routes/api";
import { createHealthRoutes } from "./routes/health";
import type { ApiKeyAuthenticator } from "./services/api-key-authenticator";
import type { JobLimiter } from "./services/job-limiter";
import type { ReadinessChecker } from "./services/readiness";
import type { AppEnvironment } from "./types/http";

export interface AppDependencies {
  readonly apiKeyAuthenticator: ApiKeyAuthenticator;
  readonly jobLimiter: JobLimiter;
  readonly mediaInfo: MediaInfoInspector;
  readonly readiness: ReadinessChecker;
}

export const createApp = ({
  apiKeyAuthenticator,
  jobLimiter,
  mediaInfo,
  readiness,
}: AppDependencies) => {
  const app = new Hono<AppEnvironment>();

  app.use("*", requestIdMiddleware);
  app.use("*", securityHeadersMiddleware);
  app.onError(errorHandler);
  app.notFound(notFoundHandler);

  app.route("/", createHealthRoutes(readiness));
  app.route("/api/v1", createApiRoutes(apiKeyAuthenticator, readiness, mediaInfo, jobLimiter));

  return app;
};

export type App = ReturnType<typeof createApp>;
