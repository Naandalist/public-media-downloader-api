import { lstat, mkdir, mkdtemp, readdir, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, test } from "bun:test";

import { TempJobStorage, TempJobStorageError } from "../src/services/temp-job-storage";

const testRoots: string[] = [];

const createStorage = async (staleAfterMilliseconds = 60_000) => {
  const root = await mkdtemp(join(tmpdir(), "downloader-storage-test-"));
  testRoots.push(root);
  const storage = new TempJobStorage(root, staleAfterMilliseconds);
  await storage.initialize();
  return { root, storage };
};

const pathExists = async (path: string) => {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return false;
    }

    throw error;
  }
};

afterEach(async () => {
  await Promise.all(testRoots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

describe("TempJobStorage", () => {
  test("creates distinct private directories for parallel jobs", async () => {
    const { storage } = await createStorage();
    const [first, second] = await Promise.all([storage.createJob(), storage.createJob()]);

    expect(first.id).toMatch(/^job-[a-f0-9]{32}$/);
    expect(first.directory).not.toBe(second.directory);
    expect((await lstat(first.directory)).mode & 0o777).toBe(0o700);

    await Promise.all([first.cleanup(), second.cleanup()]);
  });

  test("cleans after successful and failed operations", async () => {
    const { root, storage } = await createStorage();

    await storage.withJob(async (job) => {
      await writeFile(await job.resolveFile("output.mp4"), "media");
    });
    expect(await readdir(root)).toEqual([]);

    await expect(
      storage.withJob(async () => {
        throw new Error("operation failed");
      }),
    ).rejects.toThrow("operation failed");
    expect(await readdir(root)).toEqual([]);
  });

  test("cleans on abort and shutdown", async () => {
    const { root, storage } = await createStorage();
    const controller = new AbortController();
    const abortedJob = await storage.createJob(controller.signal);
    const shutdownJob = await storage.createJob();

    controller.abort();
    await Bun.sleep(10);
    expect(await pathExists(abortedJob.directory)).toBe(false);

    await storage.shutdown();
    expect(await pathExists(shutdownJob.directory)).toBe(false);
    expect(await readdir(root)).toEqual([]);
    await expect(storage.createJob()).rejects.toBeInstanceOf(TempJobStorageError);
  });

  test("rejects path traversal, absolute paths, and symlinks", async () => {
    const { root, storage } = await createStorage();
    const job = await storage.createJob();
    const outsideFile = join(root, "outside");
    await writeFile(outsideFile, "outside");

    await expect(job.resolveFile("../outside")).rejects.toBeInstanceOf(TempJobStorageError);
    await expect(job.resolveFile(outsideFile)).rejects.toBeInstanceOf(TempJobStorageError);

    const link = join(job.directory, "output.mp4");
    await symlink(outsideFile, link);
    await expect(job.resolveFile("output.mp4")).rejects.toBeInstanceOf(TempJobStorageError);

    await job.cleanup();
    expect(await Bun.file(outsideFile).text()).toBe("outside");
  });

  test("removes only stale, valid job directories during startup", async () => {
    const root = await mkdtemp(join(tmpdir(), "downloader-storage-test-"));
    testRoots.push(root);
    const staleDirectory = join(root, `job-${"a".repeat(32)}`);
    const freshDirectory = join(root, `job-${"b".repeat(32)}`);
    const unrelatedDirectory = join(root, "uploads");
    await Promise.all([mkdir(staleDirectory), mkdir(freshDirectory), mkdir(unrelatedDirectory)]);
    const oldTime = new Date(Date.now() - 120_000);
    await utimes(staleDirectory, oldTime, oldTime);

    const storage = new TempJobStorage(root, 60_000);
    const removed = await storage.initialize();

    expect(removed).toBe(1);
    expect(await pathExists(staleDirectory)).toBe(false);
    expect(await pathExists(freshDirectory)).toBe(true);
    expect(await pathExists(unrelatedDirectory)).toBe(true);
  });
});
