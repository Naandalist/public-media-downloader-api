import { describe, expect, test } from "bun:test";

import {
  ApplicationError,
  type ApplicationErrorCode,
  ERROR_DEFINITIONS,
} from "../src/domain/errors";

const expectedDefinitions = {
  DOWNLOAD_FAILED: [502, "The media download failed."],
  INTERNAL_ERROR: [500, "An unexpected error occurred."],
  INVALID_REQUEST: [400, "The request is invalid."],
  LIMIT_EXCEEDED: [413, "The media exceeds an allowed limit."],
  MEDIA_UNAVAILABLE: [404, "The media is unavailable."],
  NOT_FOUND: [404, "The requested resource was not found."],
  PROCESSING_FAILED: [500, "The downloaded media could not be processed safely."],
  QUALITY_UNAVAILABLE: [422, "The requested media quality is unavailable."],
  RATE_LIMITED: [429, "Too many requests were received."],
  SERVICE_BUSY: [503, "The media service is busy."],
  SERVICE_NOT_READY: [503, "Media processing dependencies are unavailable."],
  UNAUTHORIZED: [401, "A valid API key is required."],
  UNSUPPORTED_URL: [400, "The media URL is not supported."],
} as const satisfies Record<ApplicationErrorCode, readonly [number, string]>;

describe("application errors", () => {
  test("keeps every public code mapped to a stable status and safe message", () => {
    expect(Object.keys(ERROR_DEFINITIONS).toSorted()).toEqual(
      Object.keys(expectedDefinitions).toSorted(),
    );

    for (const [code, [status, message]] of Object.entries(expectedDefinitions)) {
      const error = new ApplicationError(code as ApplicationErrorCode);

      expect(error).toMatchObject({ code, message, name: "ApplicationError", status });
      expect(error.message).not.toMatch(/https?:\/\/|\/tmp\/|ffmpeg|ffprobe|yt-dlp|token=/i);
    }
  });

  test("retains only safe transport metadata", () => {
    const error = new ApplicationError("SERVICE_BUSY", { retryAfterSeconds: 17 });

    expect(error.options).toEqual({ retryAfterSeconds: 17 });
    expect(error.status).toBe(503);
  });
});
