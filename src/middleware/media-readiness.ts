import { createMiddleware } from "hono/factory";

import { ApplicationError } from "../domain/errors";
import type { ReadinessChecker } from "../services/readiness";
import type { AppEnvironment } from "../types/http";

export const createMediaReadinessMiddleware = (readiness: ReadinessChecker) =>
  createMiddleware<AppEnvironment>(async (context, next) => {
    const result = await readiness.check();

    if (result.status !== "ready") {
      context.header("Retry-After", "30");
      throw new ApplicationError("SERVICE_NOT_READY");
    }

    await next();
  });
