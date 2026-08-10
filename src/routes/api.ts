import { Hono } from "hono";

import type { AppEnvironment } from "../types/http";

export const createApiRoutes = () => {
  const api = new Hono<AppEnvironment>();

  api.get("/", (context) =>
    context.json({
      name: "media-downloader",
      version: "v1",
    }),
  );

  return api;
};
