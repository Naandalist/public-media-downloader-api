import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ApplicationError } from "../src/domain/errors";
import { JobLimiter } from "../src/services/job-limiter";
import { TempJobStorage } from "../src/services/temp-job-storage";

const temporaryRoots: string[] = [];

afterEach(async () => {
  for (const root of temporaryRoots.splice(0)) {
    await rm(root, { force: true, recursive: true });
  }
});

const deferred = () => {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
};

describe("JobLimiter", () => {
  test("rejects a third simultaneous job with retry guidance", async () => {
    const limiter = new JobLimiter(2, 5_000, 100, 17);
    const first = deferred();
    const second = deferred();
    const firstJob = limiter.run(() => first.promise);
    const secondJob = limiter.run(() => second.promise);

    expect(limiter.activeJobs).toBe(2);

    try {
      await limiter.run(async () => undefined);
      throw new Error("Expected capacity rejection");
    } catch (error) {
      expect(error).toBeInstanceOf(ApplicationError);
      expect(error).toMatchObject({
        code: "SERVICE_BUSY",
        options: { retryAfterSeconds: 17 },
        status: 503,
      });
    }

    first.resolve();
    second.resolve();
    await Promise.all([firstJob, secondJob]);
    expect(limiter.activeJobs).toBe(0);
  });

  test("aborts timed-out work and releases its slot", async () => {
    const limiter = new JobLimiter(1, 20, 100);

    await expect(
      limiter.run(
        ({ signal }) =>
          new Promise<void>((_resolve, reject) => {
            signal.addEventListener("abort", () => reject(signal.reason), { once: true });
          }),
      ),
    ).rejects.toMatchObject({ code: "DOWNLOAD_FAILED", status: 502 });

    expect(limiter.activeJobs).toBe(0);
    await expect(limiter.run(async () => "available")).resolves.toBe("available");
  });

  test("rejects known oversized output before work begins", async () => {
    const limiter = new JobLimiter(1, 5_000, 10);
    let started = false;

    await expect(
      limiter.run(async ({ output }) => {
        output.assertKnownSize(11);
        started = true;
      }),
    ).rejects.toMatchObject({ code: "LIMIT_EXCEEDED", status: 413 });

    expect(started).toBe(false);
    expect(limiter.activeJobs).toBe(0);
  });

  test("enforces actual bytes when remote size is missing or incorrect", async () => {
    for (const knownSize of [null, 2]) {
      const limiter = new JobLimiter(1, 5_000, 4);

      await expect(
        limiter.run(async ({ output, signal }) => {
          output.assertKnownSize(knownSize);
          output.recordBytes(3);
          expect(signal.aborted).toBe(false);
          output.recordBytes(2);
        }),
      ).rejects.toMatchObject({ code: "LIMIT_EXCEEDED" });
    }
  });

  test("cleans temporary output after an over-limit failure", async () => {
    const root = await mkdtemp(join(tmpdir(), "downloader-limits-"));
    temporaryRoots.push(root);
    const storage = new TempJobStorage(root, 60_000);
    const limiter = new JobLimiter(1, 5_000, 4);
    await storage.initialize();

    await expect(
      limiter.run(({ output, signal }) =>
        storage.withJob(async () => {
          output.recordBytes(5);
        }, signal),
      ),
    ).rejects.toMatchObject({ code: "LIMIT_EXCEEDED" });

    expect(await readdir(root)).toEqual([]);
    await storage.shutdown();
  });

  test("releases capacity after ordinary failures", async () => {
    const limiter = new JobLimiter(1, 5_000, 100);

    await expect(
      limiter.run(async () => {
        throw new Error("fixture failure");
      }),
    ).rejects.toThrow("fixture failure");

    expect(limiter.activeJobs).toBe(0);
  });
});
