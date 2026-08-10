import type { ErrorHandler, NotFoundHandler } from "hono";

import type { AppEnvironment } from "../types/http";

export const errorHandler: ErrorHandler<AppEnvironment> = (_error, context) =>
  context.json(
    {
      error: {
        code: "INTERNAL_ERROR",
        message: "An unexpected error occurred.",
        requestId: context.get("requestId"),
      },
    },
    500,
  );

export const notFoundHandler: NotFoundHandler<AppEnvironment> = (context) =>
  context.json(
    {
      error: {
        code: "NOT_FOUND",
        message: "The requested resource was not found.",
        requestId: context.get("requestId"),
      },
    },
    404,
  );
