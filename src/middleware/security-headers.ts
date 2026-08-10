import { createMiddleware } from "hono/factory";

import type { AppEnvironment } from "../types/http";

const headers = {
  "Cache-Control": "no-store",
  "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Permissions-Policy": "camera=(), geolocation=(), microphone=()",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
} as const;

export const securityHeadersMiddleware = createMiddleware<AppEnvironment>(async (context, next) => {
  try {
    await next();
  } finally {
    for (const [name, value] of Object.entries(headers)) {
      context.header(name, value);
    }
  }
});
