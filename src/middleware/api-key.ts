import { createMiddleware } from "hono/factory";

import type { ApiKeyAuthenticator } from "../services/api-key-authenticator";
import type { AppEnvironment } from "../types/http";

export const createApiKeyMiddleware = (authenticator: ApiKeyAuthenticator) =>
  createMiddleware<AppEnvironment>(async (context, next) => {
    const candidate = context.req.header("X-API-Key");
    const apiKeyId = candidate === undefined ? null : authenticator.authenticate(candidate);

    if (apiKeyId === null) {
      context.header("WWW-Authenticate", 'ApiKey realm="api"');

      return context.json(
        {
          error: {
            code: "UNAUTHORIZED",
            message: "A valid API key is required.",
            requestId: context.get("requestId"),
          },
        },
        401,
      );
    }

    context.set("apiKeyId", apiKeyId);
    await next();
  });
