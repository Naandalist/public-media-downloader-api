import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { ApplicationError } from "../src/domain/errors";
import type {
  ProcessExecutor,
  ProcessRunOptions,
  ProcessRunResult,
} from "../src/services/process-runner";
import { ProcessRunnerError } from "../src/services/process-runner";
import { YtDlpAdapter } from "../src/services/yt-dlp";

const fixture = (name: string) =>
  readFile(fileURLToPath(new URL(`./fixtures/media/${name}`, import.meta.url)), "utf8");

class StubProcessExecutor implements ProcessExecutor {
  lastOptions: ProcessRunOptions | undefined;

  constructor(private readonly outcome: string | Error) {}

  async run(options: ProcessRunOptions): Promise<ProcessRunResult> {
    this.lastOptions = options;

    if (this.outcome instanceof Error) {
      throw this.outcome;
    }

    return {
      durationMilliseconds: 1,
      exitCode: 0,
      stderr: "",
      stdout: this.outcome,
    };
  }
}

const expectApplicationError = async (
  promise: Promise<unknown>,
  expectedCode: ApplicationError["code"],
) => {
  try {
    await promise;
    throw new Error("Expected extraction to fail");
  } catch (error) {
    expect(error).toBeInstanceOf(ApplicationError);
    expect((error as ApplicationError).code).toBe(expectedCode);
    return error as ApplicationError;
  }
};

describe("YtDlpAdapter", () => {
  test("runs safe inspection arguments and returns parsed fields only", async () => {
    const executor = new StubProcessExecutor(await fixture("public-video.json"));
    const adapter = new YtDlpAdapter(executor, {
      executable: "/tools/yt-dlp",
      timeoutMilliseconds: 12_345,
    });
    const signal = new AbortController().signal;
    const result = await adapter.extract("https://youtube.com/watch?v=owned-video", signal);

    expect(executor.lastOptions).toEqual({
      arguments: [
        "--dump-single-json",
        "--skip-download",
        "--no-warnings",
        "--no-playlist",
        "--",
        "https://youtube.com/watch?v=owned-video",
      ],
      executable: "/tools/yt-dlp",
      maxStderrBytes: 131_072,
      maxStdoutBytes: 4_194_304,
      signal,
      timeoutMilliseconds: 12_345,
    });
    expect(result).toEqual({
      durationSeconds: 125.5,
      formats: [
        { hasAudio: true, hasVideo: false, height: null },
        { hasAudio: false, hasVideo: true, height: 720 },
        { hasAudio: false, hasVideo: true, height: 360 },
        { hasAudio: false, hasVideo: true, height: 144 },
      ],
      isPlaylist: false,
      thumbnail: "https://images.example/owned-video.jpg",
      title: "Owned test video",
    });
    expect(JSON.stringify(result)).not.toContain("signed-media.example");
    expect(JSON.stringify(result)).not.toContain("do-not-leak");
  });

  test.each(["private", "deleted", "unavailable"])(
    "maps %s extractor failures to MEDIA_UNAVAILABLE",
    async () => {
      const executor = new StubProcessExecutor(new ProcessRunnerError("EXIT_NON_ZERO", 1));
      const adapter = new YtDlpAdapter(executor);
      const error = await expectApplicationError(
        adapter.extract("https://youtube.com/watch?v=unavailable"),
        "MEDIA_UNAVAILABLE",
      );

      expect(error.status).toBe(404);
    },
  );

  test("rejects playlist extractor responses", async () => {
    const adapter = new YtDlpAdapter(new StubProcessExecutor(await fixture("playlist.json")));

    await expectApplicationError(
      adapter.extract("https://youtube.com/playlist?list=owned"),
      "INVALID_REQUEST",
    );
  });

  test.each(["not-json", "{}", '{"id":"missing-fields"}'])(
    "rejects unexpected extractor output",
    async (stdout) => {
      const adapter = new YtDlpAdapter(new StubProcessExecutor(stdout));

      await expectApplicationError(
        adapter.extract("https://youtube.com/watch?v=owned"),
        "DOWNLOAD_FAILED",
      );
    },
  );

  test("normalizes timeout and output-limit failures", async () => {
    for (const code of ["TIMED_OUT", "OUTPUT_LIMIT_EXCEEDED"] as const) {
      const adapter = new YtDlpAdapter(new StubProcessExecutor(new ProcessRunnerError(code)));
      const error = await expectApplicationError(
        adapter.extract("https://youtube.com/watch?v=owned"),
        "DOWNLOAD_FAILED",
      );

      expect(error.status).toBe(502);
    }
  });
});
