import { describe, expect, test } from "bun:test";

import { ConfigError, loadConfig } from "../src/config";

const apiKey = "a".repeat(32);

describe("loadConfig", () => {
  test("loads documented defaults", () => {
    const config = loadConfig({ API_KEYS: apiKey });

    expect(config).toEqual({
      apiKeys: [apiKey],
      host: "0.0.0.0",
      jobTimeoutSeconds: 900,
      logLevel: "info",
      maxConcurrentJobs: 2,
      maxDurationSeconds: 1_800,
      maxOutputBytes: 1_073_741_824,
      port: 3_000,
      tempDir: "/tmp/downloader",
      tempFileMaxAgeSeconds: 3_600,
    });
    expect(Object.isFrozen(config)).toBe(true);
    expect(Object.isFrozen(config.apiKeys)).toBe(true);
  });

  test("parses overrides and removes duplicate API keys", () => {
    const secondApiKey = "b".repeat(32);
    const config = loadConfig({
      API_KEYS: `${apiKey}, ${secondApiKey}, ${apiKey}`,
      HOST: "127.0.0.1",
      JOB_TIMEOUT_SECONDS: "60",
      LOG_LEVEL: "debug",
      MAX_CONCURRENT_JOBS: "4",
      MAX_DURATION_SECONDS: "300",
      MAX_OUTPUT_BYTES: "2048",
      PORT: "8080",
      TEMP_DIR: "/var/tmp/downloader",
      TEMP_FILE_MAX_AGE_SECONDS: "120",
    });

    expect(config).toEqual({
      apiKeys: [apiKey, secondApiKey],
      host: "127.0.0.1",
      jobTimeoutSeconds: 60,
      logLevel: "debug",
      maxConcurrentJobs: 4,
      maxDurationSeconds: 300,
      maxOutputBytes: 2_048,
      port: 8_080,
      tempDir: "/var/tmp/downloader",
      tempFileMaxAgeSeconds: 120,
    });
  });

  test("rejects missing API keys", () => {
    expect(() => loadConfig({})).toThrow(ConfigError);
    expect(() => loadConfig({})).toThrow("API_KEYS");
  });

  test("rejects short API keys without exposing their value", () => {
    const shortSecret = "do-not-leak";

    expect(() => loadConfig({ API_KEYS: shortSecret })).toThrow(ConfigError);

    try {
      loadConfig({ API_KEYS: shortSecret });
    } catch (error) {
      expect(String(error)).not.toContain(shortSecret);
    }
  });

  test("rejects invalid ports and relative temporary paths", () => {
    expect(() => loadConfig({ API_KEYS: apiKey, PORT: "65536" })).toThrow("PORT");
    expect(() => loadConfig({ API_KEYS: apiKey, TEMP_DIR: "tmp/downloads" })).toThrow("TEMP_DIR");
  });
});
