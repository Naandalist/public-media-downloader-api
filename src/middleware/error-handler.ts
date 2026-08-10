import type { ErrorHandler, NotFoundHandler } from "hono";

import { ApplicationError } from "../domain/errors";
import type { AppEnvironment } from "../types/http";

export const errorHandler: ErrorHandler<AppEnvironment> = (error, context) => {
  if (error instanceof ApplicationError) {
    if (error.options.retryAfterSeconds !== undefined) {
      context.header("Retry-After", String(error.options.retryAfterSeconds));
    }

    return context.json(
      {
        error: {
          code: error.code,
          message: error.message,
          requestId: context.get("requestId"),
        },
      },
      error.status,
    );
  }

  return context.json(
    {
      error: {
        code: "INTERNAL_ERROR",
        message: "An unexpected error occurred.",
        requestId: context.get("requestId"),
      },
    },
    500,
  );
};

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
