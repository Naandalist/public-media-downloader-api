import { Hono } from "hono";

import type { ReadinessChecker } from "../services/readiness";
import type { AppEnvironment } from "../types/http";

export const createHealthRoutes = (readiness: ReadinessChecker) => {
  const routes = new Hono<AppEnvironment>();

  routes.get("/health", (context) => context.json({ status: "ok" }));

  routes.get("/ready", async (context) => {
    const result = await readiness.check();

    return context.json(result, result.status === "ready" ? 200 : 503);
  });

  return routes;
};
