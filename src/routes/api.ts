import { Hono } from "hono";

import { createApiKeyMiddleware } from "../middleware/api-key";
import { createMediaReadinessMiddleware } from "../middleware/media-readiness";
import type { ApiKeyAuthenticator } from "../services/api-key-authenticator";
import type { ReadinessChecker } from "../services/readiness";
import type { AppEnvironment } from "../types/http";

export const createApiRoutes = (
  apiKeyAuthenticator: ApiKeyAuthenticator,
  readiness: ReadinessChecker,
) => {
  const api = new Hono<AppEnvironment>();

  api.use("*", createApiKeyMiddleware(apiKeyAuthenticator));
  api.use("/info", createMediaReadinessMiddleware(readiness));
  api.use("/download", createMediaReadinessMiddleware(readiness));

  api.get("/", (context) =>
    context.json({
      name: "media-downloader",
      version: "v1",
    }),
  );

  return api;
};
