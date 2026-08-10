import { isAbsolute } from "node:path";

import { z } from "zod";

const integerSetting = (defaultValue: number, minimum: number, maximum: number) =>
  z.preprocess(
    (value) => (value === undefined || value === "" ? defaultValue : value),
    z.coerce.number().int().min(minimum).max(maximum),
  );

const configSchema = z.object({
  API_KEYS: z
    .string()
    .trim()
    .min(1, "must contain at least one API key")
    .transform((value) => value.split(",").map((key) => key.trim()))
    .pipe(z.array(z.string().min(32, "each API key must contain at least 32 characters")).min(1)),
  HOST: z.string().trim().min(1).default("0.0.0.0"),
  JOB_TIMEOUT_SECONDS: integerSetting(900, 1, 86_400),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
  MAX_CONCURRENT_JOBS: integerSetting(2, 1, 100),
  MAX_DURATION_SECONDS: integerSetting(1_800, 1, 86_400),
  MAX_OUTPUT_BYTES: integerSetting(1_073_741_824, 1, Number.MAX_SAFE_INTEGER),
  PORT: integerSetting(3_000, 1, 65_535),
  TEMP_DIR: z
    .string()
    .trim()
    .min(1)
    .refine(isAbsolute, "must be an absolute path")
    .default("/tmp/downloader"),
  TEMP_FILE_MAX_AGE_SECONDS: integerSetting(3_600, 1, 604_800),
});

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface AppConfig {
  readonly apiKeys: readonly string[];
  readonly host: string;
  readonly jobTimeoutSeconds: number;
  readonly logLevel: LogLevel;
  readonly maxConcurrentJobs: number;
  readonly maxDurationSeconds: number;
  readonly maxOutputBytes: number;
  readonly port: number;
  readonly tempDir: string;
  readonly tempFileMaxAgeSeconds: number;
}

export class ConfigError extends Error {
  override readonly name = "ConfigError";
}

export const loadConfig = (
  environment: Readonly<Record<string, string | undefined>> = Bun.env,
): AppConfig => {
  const result = configSchema.safeParse(environment);

  if (!result.success) {
    const details = result.error.issues
      .map((issue) => `${issue.path.join(".") || "configuration"}: ${issue.message}`)
      .join("; ");

    throw new ConfigError(`Invalid configuration: ${details}`);
  }

  const apiKeys = Object.freeze([...new Set(result.data.API_KEYS)]);

  return Object.freeze({
    apiKeys,
    host: result.data.HOST,
    jobTimeoutSeconds: result.data.JOB_TIMEOUT_SECONDS,
    logLevel: result.data.LOG_LEVEL,
    maxConcurrentJobs: result.data.MAX_CONCURRENT_JOBS,
    maxDurationSeconds: result.data.MAX_DURATION_SECONDS,
    maxOutputBytes: result.data.MAX_OUTPUT_BYTES,
    port: result.data.PORT,
    tempDir: result.data.TEMP_DIR,
    tempFileMaxAgeSeconds: result.data.TEMP_FILE_MAX_AGE_SECONDS,
  });
};
