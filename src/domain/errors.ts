export type ApplicationErrorCode =
  | "DOWNLOAD_FAILED"
  | "INVALID_REQUEST"
  | "LIMIT_EXCEEDED"
  | "MEDIA_UNAVAILABLE"
  | "UNSUPPORTED_URL";

export type ApplicationErrorStatus = 400 | 404 | 413 | 502;

export class ApplicationError extends Error {
  override readonly name = "ApplicationError";

  constructor(
    readonly code: ApplicationErrorCode,
    readonly status: ApplicationErrorStatus,
    message: string,
  ) {
    super(message);
  }
}
