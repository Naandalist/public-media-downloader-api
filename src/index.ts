import { app } from "./app";
import { loadConfig } from "./config";

const config = loadConfig();

const server = Bun.serve({
  fetch: app.fetch,
  hostname: config.host,
  port: config.port,
});

console.log(`Media Downloader listening on ${server.url}`);
