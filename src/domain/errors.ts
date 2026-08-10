export type ApplicationErrorCode =
  | "DOWNLOAD_FAILED"
  | "INVALID_REQUEST"
  | "LIMIT_EXCEEDED"
  | "MEDIA_UNAVAILABLE"
  | "QUALITY_UNAVAILABLE"
  | "SERVICE_BUSY"
  | "UNSUPPORTED_URL";

export type ApplicationErrorStatus = 400 | 404 | 413 | 422 | 502 | 503;

export interface ApplicationErrorOptions {
  readonly retryAfterSeconds?: number;
}

export class ApplicationError extends Error {
  override readonly name = "ApplicationError";

  constructor(
    readonly code: ApplicationErrorCode,
    readonly status: ApplicationErrorStatus,
    message: string,
    readonly options: ApplicationErrorOptions = {},
  ) {
    super(message);
  }
}
