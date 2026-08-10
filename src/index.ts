import { app } from "./app";

const port = Number.parseInt(Bun.env.PORT ?? "3000", 10);

if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
  throw new Error("PORT must be an integer between 1 and 65535");
}

const server = Bun.serve({
  fetch: app.fetch,
  port,
});

console.log(`Media Downloader listening on ${server.url}`);
