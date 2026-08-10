import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createApp } from "../src/app";
import { ApplicationError } from "../src/domain/errors";
import type { MediaDownloader, MediaInfoInspector, PublicMediaInfo } from "../src/domain/media";
import { ApiKeyAuthenticator } from "../src/services/api-key-authenticator";
import { JobLimiter } from "../src/services/job-limiter";
import type { ReadinessChecker, ReadinessResult } from "../src/services/readiness";

const testApiKey = "test-api-key-0123456789-abcdefgh";
const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { force: true, recursive: true })),
  );
});
const publicMediaInfo: PublicMediaInfo = {
  durationSeconds: 120,
  isPlaylist: false,
  modes: ["video_audio", "video_only", "audio_only"],
  platform: "youtube",
  qualities: ["best", "720p", "480p", "180p"],
  thumbnail: "https://images.example/thumbnail.jpg",
  title: "Owned test media",
};

const readyResult: ReadinessResult = {
  checks: {
    ffmpeg: true,
    ffprobe: true,
    tempDirectory: true,
    ytDlp: true,
  },
  status: "ready",
};

const unusedMediaDownloader: MediaDownloader = {
  prepare: async () => {
    throw new Error("Download service was not expected in this test");
  },
};

const createTestApp = (
  result: ReadinessResult = readyResult,
  mediaInfo: MediaInfoInspector = { inspect: async () => publicMediaInfo },
  mediaDownloader: MediaDownloader = unusedMediaDownloader,
) => {
  const readiness: ReadinessChecker = {
    check: async () => result,
  };

  return createApp({
    apiKeyAuthenticator: new ApiKeyAuthenticator([testApiKey]),
    jobLimiter: new JobLimiter(2, 5_000, 1_024),
    mediaDownloader,
    mediaInfo,
    readiness,
  });
};

describe("application", () => {
  test("returns liveness without implementation details", async () => {
    const response = await createTestApp().request("/health");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok" });
  });

  test("returns readiness state and dependency checks", async () => {
    const response = await createTestApp().request("/ready");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(readyResult);
  });

  test("returns 503 when a readiness check fails", async () => {
    const result: ReadinessResult = {
      checks: { ...readyResult.checks, ytDlp: false },
      status: "not_ready",
    };
    const response = await createTestApp(result).request("/ready");

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual(result);
  });

  test("mounts the versioned API", async () => {
    const response = await createTestApp().request("/api/v1", {
      headers: { "X-API-Key": testApiKey },
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ name: "media-downloader", version: "v1" });
  });

  test("rejects a missing API key", async () => {
    const response = await createTestApp().request("/api/v1");
    const body = (await response.json()) as {
      error: { code: string; message: string; requestId: string };
    };

    expect(response.status).toBe(401);
    expect(response.headers.get("WWW-Authenticate")).toBe('ApiKey realm="api"');
    expect(body.error.code).toBe("UNAUTHORIZED");
    expect(response.headers.get("X-Request-Id")).toBe(body.error.requestId);
  });

  test("rejects an invalid API key without exposing it", async () => {
    const invalidApiKey = "invalid-api-key-0123456789-abcdef";
    const response = await createTestApp().request("/api/v1", {
      headers: { "X-API-Key": invalidApiKey },
    });
    const responseText = await response.text();

    expect(response.status).toBe(401);
    expect(responseText).not.toContain(invalidApiKey);
    expect(responseText).not.toContain(testApiKey);
  });

  test("rejects media traffic while dependencies are unavailable", async () => {
    const result: ReadinessResult = {
      checks: { ...readyResult.checks, ffmpeg: false },
      status: "not_ready",
    };
    const response = await createTestApp(result).request("/api/v1/info", {
      headers: { "X-API-Key": testApiKey },
      method: "POST",
    });
    const body = (await response.json()) as {
      error: { code: string; message: string; requestId: string };
    };

    expect(response.status).toBe(503);
    expect(response.headers.get("Retry-After")).toBe("30");
    expect(body.error.code).toBe("SERVICE_NOT_READY");
    expect(response.headers.get("X-Request-Id")).toBe(body.error.requestId);
  });

  test("checks authentication before media readiness", async () => {
    const result: ReadinessResult = {
      checks: { ...readyResult.checks, ffmpeg: false },
      status: "not_ready",
    };
    const response = await createTestApp(result).request("/api/v1/download", {
      method: "POST",
    });

    expect(response.status).toBe(401);
  });

  test("returns normalized media information", async () => {
    const response = await createTestApp().request("/api/v1/info", {
      body: JSON.stringify({ url: "https://youtube.com/watch?v=owned" }),
      headers: {
        "Content-Type": "application/json",
        "X-API-Key": testApiKey,
      },
      method: "POST",
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(publicMediaInfo);
  });

  test("returns service busy with retry guidance when job capacity is full", async () => {
    let releaseInspection: () => void = () => undefined;
    let markInspectionStarted: () => void = () => undefined;
    const inspectionStarted = new Promise<void>((resolve) => {
      markInspectionStarted = resolve;
    });
    const inspectionReleased = new Promise<void>((resolve) => {
      releaseInspection = resolve;
    });
    const readiness: ReadinessChecker = { check: async () => readyResult };
    const app = createApp({
      apiKeyAuthenticator: new ApiKeyAuthenticator([testApiKey]),
      jobLimiter: new JobLimiter(1, 5_000, 1_024, 19),
      mediaDownloader: unusedMediaDownloader,
      mediaInfo: {
        inspect: async () => {
          markInspectionStarted();
          await inspectionReleased;
          return publicMediaInfo;
        },
      },
      readiness,
    });
    const request = {
      body: JSON.stringify({ url: "https://youtube.com/watch?v=owned" }),
      headers: { "Content-Type": "application/json", "X-API-Key": testApiKey },
      method: "POST",
    };
    const firstResponse = app.request("/api/v1/info", request);
    await inspectionStarted;
    const busyResponse = await app.request("/api/v1/info", request);

    expect(busyResponse.status).toBe(503);
    expect(busyResponse.headers.get("Retry-After")).toBe("19");
    expect(await busyResponse.json()).toMatchObject({ error: { code: "SERVICE_BUSY" } });

    releaseInspection();
    expect((await firstResponse).status).toBe(200);
  });

  test("streams a prepared download with safe attachment headers and defaults", async () => {
    const root = await mkdtemp(join(tmpdir(), "downloader-app-"));
    temporaryRoots.push(root);
    const filePath = join(root, "prepared.webm");
    await Bun.write(filePath, "media-body");
    let receivedRequest: Parameters<MediaDownloader["prepare"]>[0] | undefined;
    let cleaned = false;
    const mediaDownloader: MediaDownloader = {
      prepare: async (request) => {
        receivedRequest = request;
        return {
          cleanup: async () => {
            cleaned = true;
            await rm(root, { force: true, recursive: true });
          },
          extension: "webm",
          filePath,
          mimeType: "video/webm",
          sizeBytes: 10,
          title: '../Owned\n"media"',
        };
      },
    };
    const response = await createTestApp(readyResult, undefined, mediaDownloader).request(
      "/api/v1/download",
      {
        body: JSON.stringify({ url: "https://youtube.com/watch?v=owned" }),
        headers: {
          "Content-Type": "application/json",
          "X-API-Key": testApiKey,
        },
        method: "POST",
      },
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("video/webm");
    expect(response.headers.get("Content-Length")).toBe("10");
    expect(response.headers.get("Content-Disposition")).toContain("Owned media.webm");
    expect(response.headers.get("Content-Disposition")).not.toContain("\n");
    expect(await response.text()).toBe("media-body");
    expect(cleaned).toBe(true);
    expect(receivedRequest).toEqual({
      mode: "video_audio",
      quality: "best",
      stripMetadata: false,
      url: "https://youtube.com/watch?v=owned",
    });
  });

  test("rejects invalid download fields before preparing media", async () => {
    let called = false;
    const response = await createTestApp(readyResult, undefined, {
      prepare: async () => {
        called = true;
        throw new Error("unexpected");
      },
    }).request("/api/v1/download", {
      body: JSON.stringify({ mode: "raw-selector", url: "https://youtube.com/watch?v=owned" }),
      headers: { "Content-Type": "application/json", "X-API-Key": testApiKey },
      method: "POST",
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: "INVALID_REQUEST" } });
    expect(called).toBe(false);
  });

  test("returns a JSON failure before streaming when preparation fails", async () => {
    const response = await createTestApp(readyResult, undefined, {
      prepare: async () => {
        throw new ApplicationError("DOWNLOAD_FAILED", 502, "The media download failed.");
      },
    }).request("/api/v1/download", {
      body: JSON.stringify({ url: "https://youtube.com/watch?v=owned" }),
      headers: { "Content-Type": "application/json", "X-API-Key": testApiKey },
      method: "POST",
    });

    expect(response.status).toBe(502);
    expect(response.headers.get("Content-Disposition")).toBeNull();
    expect(await response.json()).toMatchObject({ error: { code: "DOWNLOAD_FAILED" } });
  });

  test("cleans prepared media when the response stream is cancelled", async () => {
    const root = await mkdtemp(join(tmpdir(), "downloader-cancel-"));
    temporaryRoots.push(root);
    const filePath = join(root, "prepared.webm");
    await Bun.write(filePath, new Uint8Array(64 * 1_024));
    let completeCleanup: () => void = () => undefined;
    const cleanupCompleted = new Promise<void>((resolve) => {
      completeCleanup = resolve;
    });
    const response = await createTestApp(readyResult, undefined, {
      prepare: async () => ({
        cleanup: async () => {
          await rm(root, { force: true, recursive: true });
          completeCleanup();
        },
        extension: "webm",
        filePath,
        mimeType: "video/webm",
        sizeBytes: 64 * 1_024,
        title: "Owned media",
      }),
    }).request("/api/v1/download", {
      body: JSON.stringify({ url: "https://youtube.com/watch?v=owned" }),
      headers: { "Content-Type": "application/json", "X-API-Key": testApiKey },
      method: "POST",
    });

    await response.body?.cancel("test cancellation");
    await cleanupCompleted;
    expect(await Bun.file(filePath).exists()).toBe(false);
  });

  test("rejects malformed and extra request fields", async () => {
    const malformedResponse = await createTestApp().request("/api/v1/info", {
      body: "not-json",
      headers: {
        "Content-Type": "application/json",
        "X-API-Key": testApiKey,
      },
      method: "POST",
    });
    const extraFieldResponse = await createTestApp().request("/api/v1/info", {
      body: JSON.stringify({ extra: true, url: "https://youtube.com/watch?v=owned" }),
      headers: {
        "Content-Type": "application/json",
        "X-API-Key": testApiKey,
      },
      method: "POST",
    });

    expect(malformedResponse.status).toBe(400);
    expect(extraFieldResponse.status).toBe(400);
  });

  test("returns stable media errors without leaking internal details", async () => {
    const internalDetail = "private extractor URL token=do-not-leak";
    const mediaInfo: MediaInfoInspector = {
      inspect: async () => {
        const error = new ApplicationError(
          "MEDIA_UNAVAILABLE",
          404,
          "The media is private, unavailable, or no longer exists.",
        );
        error.stack = `${error.stack}\n${internalDetail}`;
        throw error;
      },
    };
    const response = await createTestApp(readyResult, mediaInfo).request("/api/v1/info", {
      body: JSON.stringify({ url: "https://youtube.com/watch?v=private" }),
      headers: {
        "Content-Type": "application/json",
        "X-API-Key": testApiKey,
      },
      method: "POST",
    });
    const responseText = await response.text();

    expect(response.status).toBe(404);
    expect(responseText).toContain("MEDIA_UNAVAILABLE");
    expect(responseText).not.toContain(internalDetail);
    expect(responseText).not.toContain("do-not-leak");
  });

  test("returns normalized not-found errors", async () => {
    const response = await createTestApp().request("/missing");
    const requestId = response.headers.get("X-Request-Id");
    const body = (await response.json()) as {
      error: { code: string; message: string; requestId: string };
    };

    if (requestId === null) {
      throw new Error("Expected X-Request-Id response header");
    }

    expect(response.status).toBe(404);
    expect(body.error).toEqual({
      code: "NOT_FOUND",
      message: "The requested resource was not found.",
      requestId,
    });
  });

  test("normalizes unexpected errors", async () => {
    const readiness: ReadinessChecker = {
      check: () => Promise.reject(new Error("sensitive internal failure")),
    };
    const response = await createApp({
      apiKeyAuthenticator: new ApiKeyAuthenticator([testApiKey]),
      jobLimiter: new JobLimiter(2, 5_000, 1_024),
      mediaDownloader: unusedMediaDownloader,
      mediaInfo: { inspect: async () => publicMediaInfo },
      readiness,
    }).request("/ready");
    const requestId = response.headers.get("X-Request-Id");
    const body = (await response.json()) as {
      error: { code: string; message: string; requestId: string };
    };

    if (requestId === null) {
      throw new Error("Expected X-Request-Id response header");
    }

    expect(response.status).toBe(500);
    expect(body.error.code).toBe("INTERNAL_ERROR");
    expect(body.error.message).toBe("An unexpected error occurred.");
    expect(body.error.message).not.toContain("sensitive internal failure");
    expect(body.error.requestId).toBe(requestId);
  });

  test("adds request ID and security headers", async () => {
    const response = await createTestApp().request("/health");

    expect(response.headers.get("X-Request-Id")).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(response.headers.get("X-Frame-Options")).toBe("DENY");
    expect(response.headers.get("Content-Security-Policy")).toContain("default-src 'none'");
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });
});
