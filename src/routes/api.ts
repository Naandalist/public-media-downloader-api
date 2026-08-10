import { Hono } from "hono";
import { z } from "zod";

import { ApplicationError } from "../domain/errors";
import type { MediaInfoInspector } from "../domain/media";
import { createApiKeyMiddleware } from "../middleware/api-key";
import { createMediaReadinessMiddleware } from "../middleware/media-readiness";
import type { ApiKeyAuthenticator } from "../services/api-key-authenticator";
import type { JobLimiter } from "../services/job-limiter";
import type { ReadinessChecker } from "../services/readiness";
import type { AppEnvironment } from "../types/http";

export const createApiRoutes = (
  apiKeyAuthenticator: ApiKeyAuthenticator,
  readiness: ReadinessChecker,
  mediaInfo: MediaInfoInspector,
  jobLimiter: JobLimiter,
) => {
  const api = new Hono<AppEnvironment>();

  api.use("*", createApiKeyMiddleware(apiKeyAuthenticator));
  api.use("/info", createMediaReadinessMiddleware(readiness));
  api.use("/download", createMediaReadinessMiddleware(readiness));

  api.post("/info", async (context) => {
    let body: unknown;

    try {
      body = await context.req.json();
    } catch {
      throw new ApplicationError("INVALID_REQUEST", 400, "A valid JSON body is required.");
    }

    const parsed = z
      .object({
        url: z.string().trim().min(1).max(2_048),
      })
      .strict()
      .safeParse(body);

    if (!parsed.success) {
      throw new ApplicationError(
        "INVALID_REQUEST",
        400,
        "The request must contain only a valid URL string.",
      );
    }

    return context.json(
      await jobLimiter.run(
        ({ signal }) => mediaInfo.inspect(parsed.data.url, signal),
        context.req.raw.signal,
      ),
    );
  });

  api.get("/", (context) =>
    context.json({
      name: "media-downloader",
      version: "v1",
    }),
  );

  return api;
};
