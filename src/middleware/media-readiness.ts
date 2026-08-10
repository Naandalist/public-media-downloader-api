import { createMiddleware } from "hono/factory";

import type { ReadinessChecker } from "../services/readiness";
import type { AppEnvironment } from "../types/http";

export const createMediaReadinessMiddleware = (readiness: ReadinessChecker) =>
  createMiddleware<AppEnvironment>(async (context, next) => {
    const result = await readiness.check();

    if (result.status !== "ready") {
      context.header("Retry-After", "30");

      return context.json(
        {
          error: {
            code: "SERVICE_NOT_READY",
            message: "Media processing dependencies are unavailable.",
            requestId: context.get("requestId"),
          },
        },
        503,
      );
    }

    await next();
  });
