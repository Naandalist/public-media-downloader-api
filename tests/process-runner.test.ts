import { afterEach, describe, expect, test } from "bun:test";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { ProcessRunner, ProcessRunnerError } from "../src/services/process-runner";

const runner = new ProcessRunner();
const fixture = (name: string) => fileURLToPath(import.meta.resolve(`./fixtures/${name}`));
const tempDirectories: string[] = [];

const createTempDirectory = async () => {
  const directory = await mkdtemp(join(tmpdir(), "downloader-process-test-"));
  tempDirectories.push(directory);
  return directory;
};

const expectProcessError = async (
  promise: Promise<unknown>,
  expectedCode: ProcessRunnerError["code"],
) => {
  try {
    await promise;
    throw new Error("Expected process execution to fail");
  } catch (error) {
    expect(error).toBeInstanceOf(ProcessRunnerError);
    expect((error as ProcessRunnerError).code).toBe(expectedCode);
    return error as ProcessRunnerError;
  }
};

afterEach(async () => {
  await Promise.all(
    tempDirectories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("ProcessRunner", () => {
  test("captures bounded stdout and stderr from a successful process", async () => {
    const result = await runner.run({
      arguments: [fixture("echo-arguments.ts"), "first", "second"],
      executable: process.execPath,
    });

    expect(JSON.parse(result.stdout)).toEqual(["first", "second"]);
    expect(result.stderr).toBe("");
    expect(result.exitCode).toBe(0);
    expect(result.durationMilliseconds).toBeGreaterThanOrEqual(0);
  });

  test("passes shell metacharacters as inert arguments", async () => {
    const directory = await createTempDirectory();
    const markerPath = join(directory, "must-not-exist");
    const maliciousArgument = `; touch ${markerPath}; $(whoami) && echo unsafe`;
    const result = await runner.run({
      arguments: [fixture("echo-arguments.ts"), maliciousArgument],
      executable: process.execPath,
    });

    expect(JSON.parse(result.stdout)).toEqual([maliciousArgument]);
    await expect(access(markerPath)).rejects.toBeDefined();
  });

  test("kills a hanging process after timeout", async () => {
    const startedAt = performance.now();

    await expectProcessError(
      runner.run({
        arguments: [fixture("hang.ts")],
        executable: process.execPath,
        timeoutMilliseconds: 50,
      }),
      "TIMED_OUT",
    );

    expect(performance.now() - startedAt).toBeLessThan(2_000);
  });

  test("kills execution when an AbortSignal is aborted", async () => {
    const controller = new AbortController();
    const execution = runner.run({
      arguments: [fixture("hang.ts")],
      executable: process.execPath,
      signal: controller.signal,
      timeoutMilliseconds: 5_000,
    });

    setTimeout(() => controller.abort(), 25);

    await expectProcessError(execution, "ABORTED");
  });

  test("rejects an already-aborted operation before spawning", async () => {
    const controller = new AbortController();
    controller.abort();

    await expectProcessError(
      runner.run({
        arguments: [fixture("hang.ts")],
        executable: process.execPath,
        signal: controller.signal,
      }),
      "ABORTED",
    );
  });

  test("bounds large stderr and terminates the process", async () => {
    const error = await expectProcessError(
      runner.run({
        arguments: [fixture("large-stderr.ts"), "1048576"],
        executable: process.execPath,
        maxStderrBytes: 1_024,
      }),
      "OUTPUT_LIMIT_EXCEEDED",
    );

    expect(String(error)).not.toContain("x".repeat(64));
  });

  test("returns generic typed failures without command output or arguments", async () => {
    const secret = "https://example.com/private?token=do-not-leak";
    const error = await expectProcessError(
      runner.run({
        arguments: [fixture("fail-with-sensitive-output.ts"), secret],
        executable: process.execPath,
      }),
      "EXIT_NON_ZERO",
    );

    expect(error.exitCode).toBe(7);
    expect(String(error)).not.toContain(secret);
    expect(String(error)).not.toContain("token");
    expect(String(error)).not.toContain(process.cwd());
  });

  test("normalizes spawn failures without exposing executable paths", async () => {
    const executable = "/private/not-a-real-secret-executable";
    const error = await expectProcessError(runner.run({ executable }), "SPAWN_FAILED");

    expect(String(error)).not.toContain(executable);
  });

  test("shutdown aborts and drains all active executions", async () => {
    const shutdownRunner = new ProcessRunner();
    const firstExecution = expectProcessError(
      shutdownRunner.run({
        arguments: [fixture("hang.ts")],
        executable: process.execPath,
        timeoutMilliseconds: 5_000,
      }),
      "ABORTED",
    );
    const secondExecution = expectProcessError(
      shutdownRunner.run({
        arguments: [fixture("hang.ts")],
        executable: process.execPath,
        timeoutMilliseconds: 5_000,
      }),
      "ABORTED",
    );

    await shutdownRunner.shutdown();
    await firstExecution;
    await secondExecution;
    await expectProcessError(
      shutdownRunner.run({
        arguments: [fixture("echo-arguments.ts")],
        executable: process.execPath,
      }),
      "ABORTED",
    );
  });

  test("terminates descendants in the detached process group", async () => {
    const directory = await createTempDirectory();
    const markerPath = join(directory, "child-terminated");
    const pidPath = join(directory, "child-pid");

    await expectProcessError(
      runner.run({
        arguments: [fixture("process-tree-parent.ts"), markerPath, pidPath],
        executable: process.execPath,
        timeoutMilliseconds: 250,
      }),
      "TIMED_OUT",
    );

    const childPid = Number(await readFile(pidPath, "utf8"));

    try {
      await expect(readFile(markerPath, "utf8")).resolves.toBe("terminated");
    } finally {
      try {
        process.kill(childPid, "SIGKILL");
      } catch {
        // Descendant already exited as expected.
      }
    }
  });
});
