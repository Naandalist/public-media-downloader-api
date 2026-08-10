export const ERROR_DEFINITIONS = Object.freeze({
  DOWNLOAD_FAILED: {
    message: "The media download failed.",
    status: 502,
  },
  INTERNAL_ERROR: {
    message: "An unexpected error occurred.",
    status: 500,
  },
  INVALID_REQUEST: {
    message: "The request is invalid.",
    status: 400,
  },
  LIMIT_EXCEEDED: {
    message: "The media exceeds an allowed limit.",
    status: 413,
  },
  MEDIA_UNAVAILABLE: {
    message: "The media is unavailable.",
    status: 404,
  },
  NOT_FOUND: {
    message: "The requested resource was not found.",
    status: 404,
  },
  PROCESSING_FAILED: {
    message: "The downloaded media could not be processed safely.",
    status: 500,
  },
  QUALITY_UNAVAILABLE: {
    message: "The requested media quality is unavailable.",
    status: 422,
  },
  RATE_LIMITED: {
    message: "Too many requests were received.",
    status: 429,
  },
  SERVICE_BUSY: {
    message: "The media service is busy.",
    status: 503,
  },
  SERVICE_NOT_READY: {
    message: "Media processing dependencies are unavailable.",
    status: 503,
  },
  UNAUTHORIZED: {
    message: "A valid API key is required.",
    status: 401,
  },
  UNSUPPORTED_URL: {
    message: "The media URL is not supported.",
    status: 400,
  },
} as const);

export type ApplicationErrorCode = keyof typeof ERROR_DEFINITIONS;
export type ApplicationErrorStatus = (typeof ERROR_DEFINITIONS)[ApplicationErrorCode]["status"];

export interface ApplicationErrorOptions {
  readonly retryAfterSeconds?: number;
}

export class ApplicationError extends Error {
  override readonly name = "ApplicationError";
  readonly status: ApplicationErrorStatus;

  constructor(
    readonly code: ApplicationErrorCode,
    readonly options: ApplicationErrorOptions = {},
  ) {
    const definition = ERROR_DEFINITIONS[code];
    super(definition.message);
    this.status = definition.status;
  }
}
