import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createStartupDependencyDiagnostic,
  SystemReadinessChecker,
  type CommandChecker,
} from "../src/services/readiness";

const tempDirectories: string[] = [];

const createTempDirectory = async () => {
  const directory = await mkdtemp(join(tmpdir(), "downloader-ready-test-"));
  tempDirectories.push(directory);
  return directory;
};

afterEach(async () => {
  await Promise.all(
    tempDirectories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("SystemReadinessChecker", () => {
  test("reports ready when temporary storage and tools work", async () => {
    const commandChecker: CommandChecker = async () => true;
    const checker = new SystemReadinessChecker(await createTempDirectory(), commandChecker);

    expect(await checker.check()).toEqual({
      checks: {
        ffmpeg: true,
        ffprobe: true,
        tempDirectory: true,
        ytDlp: true,
      },
      status: "ready",
    });
  });

  test("reports which tool is unavailable", async () => {
    const commandChecker: CommandChecker = async (executable) => executable !== "ffprobe";
    const checker = new SystemReadinessChecker(await createTempDirectory(), commandChecker);

    expect(await checker.check()).toEqual({
      checks: {
        ffmpeg: true,
        ffprobe: false,
        tempDirectory: true,
        ytDlp: true,
      },
      status: "not_ready",
    });
  });

  test("reports an unwritable temporary path without exposing it", async () => {
    const commandChecker: CommandChecker = async () => true;
    const checker = new SystemReadinessChecker("/dev/null/downloader", commandChecker);
    const result = await checker.check();

    expect(result.checks.tempDirectory).toBe(false);
    expect(result.status).toBe("not_ready");
    expect(JSON.stringify(result)).not.toContain("/dev/null/downloader");
  });
});

describe("createStartupDependencyDiagnostic", () => {
  test("returns safe availability labels without executable versions or paths", () => {
    const diagnostic = createStartupDependencyDiagnostic({
      checks: {
        ffmpeg: true,
        ffprobe: true,
        tempDirectory: true,
        ytDlp: false,
      },
      status: "not_ready",
    });

    expect(diagnostic).toEqual({
      event: "startup_dependencies",
      ffmpeg: "available",
      ffprobe: "available",
      status: "not_ready",
      tempDirectory: "available",
      ytDlp: "unavailable",
    });
    expect(JSON.stringify(diagnostic)).not.toContain("/tmp");
    expect(JSON.stringify(diagnostic)).not.toMatch(/\d+\.\d+\.\d+/);
  });
});
