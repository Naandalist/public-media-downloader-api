import { Hono } from "hono";

import { createApiKeyMiddleware } from "../middleware/api-key";
import type { ApiKeyAuthenticator } from "../services/api-key-authenticator";
import type { AppEnvironment } from "../types/http";

export const createApiRoutes = (apiKeyAuthenticator: ApiKeyAuthenticator) => {
  const api = new Hono<AppEnvironment>();

  api.use("*", createApiKeyMiddleware(apiKeyAuthenticator));

  api.get("/", (context) =>
    context.json({
      name: "media-downloader",
      version: "v1",
    }),
  );

  return api;
};
