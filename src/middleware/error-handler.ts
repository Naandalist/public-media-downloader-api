import type { Context, ErrorHandler, NotFoundHandler } from "hono";

import { ApplicationError } from "../domain/errors";
import type { AppEnvironment } from "../types/http";

const errorResponse = (context: Context<AppEnvironment>, error: ApplicationError) =>
  context.json(
    {
      error: {
        code: error.code,
        message: error.message,
        requestId: context.get("requestId"),
      },
    },
    error.status,
  );

export const errorHandler: ErrorHandler<AppEnvironment> = (error, context) => {
  if (error instanceof ApplicationError) {
    if (error.options.retryAfterSeconds !== undefined) {
      context.header("Retry-After", String(error.options.retryAfterSeconds));
    }

    return errorResponse(context, error);
  }

  return errorResponse(context, new ApplicationError("INTERNAL_ERROR"));
};

export const notFoundHandler: NotFoundHandler<AppEnvironment> = (context) =>
  errorResponse(context, new ApplicationError("NOT_FOUND"));
