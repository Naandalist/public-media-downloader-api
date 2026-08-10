import { describe, expect, test } from "bun:test";

import { createApp } from "../src/app";
import { ApiKeyAuthenticator } from "../src/services/api-key-authenticator";
import type { ReadinessChecker, ReadinessResult } from "../src/services/readiness";

const testApiKey = "test-api-key-0123456789-abcdefgh";

const readyResult: ReadinessResult = {
  checks: {
    ffmpeg: true,
    ffprobe: true,
    tempDirectory: true,
    ytDlp: true,
  },
  status: "ready",
};

const createTestApp = (result: ReadinessResult = readyResult) => {
  const readiness: ReadinessChecker = {
    check: async () => result,
  };

  return createApp({
    apiKeyAuthenticator: new ApiKeyAuthenticator([testApiKey]),
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
