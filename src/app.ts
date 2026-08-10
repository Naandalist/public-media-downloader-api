import { Hono } from "hono";

export const app = new Hono();

app.get("/", (context) =>
  context.json({
    name: "media-downloader",
    status: "ok",
  }),
);

export type App = typeof app;
