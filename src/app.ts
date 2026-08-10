import { Hono } from "hono";

import { errorHandler, notFoundHandler } from "./middleware/error-handler";
import { requestIdMiddleware } from "./middleware/request-id";
import { securityHeadersMiddleware } from "./middleware/security-headers";
import { createApiRoutes } from "./routes/api";
import { createHealthRoutes } from "./routes/health";
import type { ReadinessChecker } from "./services/readiness";
import type { AppEnvironment } from "./types/http";

export interface AppDependencies {
  readonly readiness: ReadinessChecker;
}

export const createApp = ({ readiness }: AppDependencies) => {
  const app = new Hono<AppEnvironment>();

  app.use("*", requestIdMiddleware);
  app.use("*", securityHeadersMiddleware);
  app.onError(errorHandler);
  app.notFound(notFoundHandler);

  app.route("/", createHealthRoutes(readiness));
  app.route("/api/v1", createApiRoutes());

  return app;
};

export type App = ReturnType<typeof createApp>;
