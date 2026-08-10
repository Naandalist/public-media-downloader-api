import { createMiddleware } from "hono/factory";

import type { AppEnvironment } from "../types/http";

export const requestIdMiddleware = createMiddleware<AppEnvironment>(async (context, next) => {
  const requestId = crypto.randomUUID();

  context.set("requestId", requestId);

  try {
    await next();
  } finally {
    context.header("X-Request-Id", requestId);
  }
});
