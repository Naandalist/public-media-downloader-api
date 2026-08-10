import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { InspectedMediaSource, MediaDownloadRequest } from "../src/domain/media";
import { FormatSelector } from "../src/services/format-selector";
import { JobLimiter } from "../src/services/job-limiter";
import {
  attachmentContentDisposition,
  MediaDownloadService,
  sanitizeAttachmentName,
} from "../src/services/media-download";
import type {
  ProcessExecutor,
  ProcessRunOptions,
  ProcessRunResult,
} from "../src/services/process-runner";
import { ProcessRunnerError } from "../src/services/process-runner";
import { TempJobStorage } from "../src/services/temp-job-storage";
import type { ExtractedFormat } from "../src/services/yt-dlp";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { force: true, recursive: true })),
  );
});

const format = (values: Partial<ExtractedFormat>): ExtractedFormat => ({
  audioBitrate: null,
  audioCodec: null,
  extension: null,
  fileSizeBytes: null,
  formatId: "format",
  hasAudio: false,
  hasVideo: false,
  height: null,
  totalBitrate: null,
  videoBitrate: null,
  ...values,
});

const request = (values: Partial<MediaDownloadRequest> = {}): MediaDownloadRequest => ({
  mode: "video_audio",
  quality: "best",
  stripMetadata: false,
  url: "https://youtube.com/watch?v=owned",
  ...values,
});

const source = (formats: readonly ExtractedFormat[]): InspectedMediaSource => ({
  extracted: {
    durationSeconds: 30,
    formats,
    isPlaylist: false,
    title: "Owned media",
  },
  platform: "youtube",
  url: "https://youtube.com/watch?v=owned",
});

class StubProcessExecutor implements ProcessExecutor {
  readonly calls: ProcessRunOptions[] = [];
  failDownload = false;
  hangDownload = false;
  outputBytes = new TextEncoder().encode("playable-fixture");
  probeFormat = "webm";
  probeStreams: readonly ("audio" | "video")[] = ["video", "audio"];

  async run(options: ProcessRunOptions): Promise<ProcessRunResult> {
    this.calls.push(options);

    if (options.executable === "/tools/yt-dlp") {
      if (this.failDownload) {
        throw new ProcessRunnerError("EXIT_NON_ZERO", 1);
      }

      if (this.hangDownload) {
        await Bun.write(join(options.cwd ?? "", "source.webm.part"), this.outputBytes);
        return new Promise<ProcessRunResult>((_resolve, reject) => {
          options.signal?.addEventListener(
            "abort",
            () => reject(new ProcessRunnerError("ABORTED")),
            { once: true },
          );
        });
      }

      await Bun.write(join(options.cwd ?? "", "source.webm"), this.outputBytes);
    }

    if (options.executable === "/tools/ffmpeg") {
      const arguments_ = options.arguments ?? [];
      const input = arguments_[arguments_.indexOf("-i") + 1];
      const output = arguments_.at(-1);

      if (input === undefined || output === undefined) {
        throw new Error("Missing ffmpeg fixture paths");
      }

      await Bun.write(output, Bun.file(input));
    }

    return {
      durationMilliseconds: 1,
      exitCode: 0,
      stderr: "",
      stdout:
        options.executable === "/tools/ffprobe"
          ? JSON.stringify({
              format: { format_name: this.probeFormat },
              streams: this.probeStreams.map((codec_type) => ({ codec_type })),
            })
          : "",
    };
  }
}

const setup = async (formats: readonly ExtractedFormat[], maximumOutputBytes = 1_024) => {
  const root = await mkdtemp(join(tmpdir(), "downloader-download-"));
  temporaryRoots.push(root);
  const storage = new TempJobStorage(root, 60_000);
  await storage.initialize();
  const executor = new StubProcessExecutor();
  const service = new MediaDownloadService(
    { inspectSource: async () => source(formats) },
    new FormatSelector(),
    executor,
    storage,
    {
      ffmpegExecutable: "/tools/ffmpeg",
      ffprobeExecutable: "/tools/ffprobe",
      processTimeoutMilliseconds: 5_000,
      ytDlpExecutable: "/tools/yt-dlp",
    },
  );
  const limiter = new JobLimiter(1, 5_000, maximumOutputBytes);
  const lease = limiter.acquire();

  return { executor, lease, limiter, root, service, storage };
};

describe("MediaDownloadService", () => {
  test("downloads selected streams, validates output, and preserves cleanup ownership", async () => {
    const fixture = await setup([
      format({ audioCodec: "opus", formatId: "audio", hasAudio: true }),
      format({ formatId: "video", hasVideo: true, height: 720 }),
    ]);
    const prepared = await fixture.service.prepare(request(), fixture.lease.context);
    const downloadCall = fixture.executor.calls.find((call) => call.executable === "/tools/yt-dlp");

    expect(downloadCall?.arguments).toContain("video+audio");
    expect(downloadCall?.arguments).toContain("1024");
    expect(prepared).toMatchObject({
      extension: "webm",
      mimeType: "video/webm",
      sizeBytes: 16,
      title: "Owned media",
    });
    expect(await Bun.file(prepared.filePath).text()).toBe("playable-fixture");

    await prepared.cleanup();
    fixture.lease.release();
    expect(await readdir(fixture.root)).toEqual([]);
  });

  test("removes audio with ffmpeg when only a combined video source exists", async () => {
    const fixture = await setup([
      format({
        audioCodec: "aac",
        extension: "mp4",
        formatId: "combined",
        hasAudio: true,
        hasVideo: true,
        height: 720,
      }),
    ]);
    fixture.executor.probeStreams = ["video"];
    const prepared = await fixture.service.prepare(
      request({ mode: "video_only" }),
      fixture.lease.context,
    );
    const ffmpegCall = fixture.executor.calls.find((call) => call.executable === "/tools/ffmpeg");

    expect(ffmpegCall?.arguments).toContain("0:v:0");
    expect(prepared.filePath).toContain("processed.webm");

    await prepared.cleanup();
    fixture.lease.release();
  });

  test("removes video and preserves the detected source audio container", async () => {
    const fixture = await setup([
      format({
        audioCodec: "opus",
        extension: "webm",
        formatId: "combined",
        hasAudio: true,
        hasVideo: true,
        height: 720,
      }),
    ]);
    fixture.executor.probeStreams = ["audio"];
    const prepared = await fixture.service.prepare(
      request({ mode: "audio_only" }),
      fixture.lease.context,
    );
    const ffmpegCall = fixture.executor.calls.find((call) => call.executable === "/tools/ffmpeg");

    expect(ffmpegCall?.arguments).toContain("0:a:0");
    expect(prepared).toMatchObject({ extension: "webm", mimeType: "audio/webm" });

    await prepared.cleanup();
    fixture.lease.release();
  });

  test("rejects known oversized media before starting a process", async () => {
    const fixture = await setup(
      [format({ fileSizeBytes: 11, formatId: "video", hasVideo: true, height: 720 })],
      10,
    );

    await expect(
      fixture.service.prepare(request({ mode: "video_only" }), fixture.lease.context),
    ).rejects.toMatchObject({ code: "LIMIT_EXCEEDED", status: 413 });
    expect(fixture.executor.calls).toHaveLength(0);
    expect(await readdir(fixture.root)).toEqual([]);
    fixture.lease.release();
  });

  test("rejects actual oversized output and cleans partial work", async () => {
    const fixture = await setup([format({ formatId: "video", hasVideo: true, height: 720 })], 10);
    fixture.executor.outputBytes = new Uint8Array(11);

    await expect(
      fixture.service.prepare(request({ mode: "video_only" }), fixture.lease.context),
    ).rejects.toMatchObject({ code: "LIMIT_EXCEEDED", status: 413 });
    expect(await readdir(fixture.root)).toEqual([]);
    fixture.lease.release();
  });

  test("cleans failed downloads before returning a normalized error", async () => {
    const fixture = await setup([format({ formatId: "video", hasVideo: true, height: 720 })]);
    fixture.executor.failDownload = true;

    await expect(
      fixture.service.prepare(request({ mode: "video_only" }), fixture.lease.context),
    ).rejects.toMatchObject({ code: "DOWNLOAD_FAILED", status: 502 });
    expect(await readdir(fixture.root)).toEqual([]);
    fixture.lease.release();
  });

  test("propagates client cancellation to active work and removes partial files", async () => {
    const root = await mkdtemp(join(tmpdir(), "downloader-abort-"));
    temporaryRoots.push(root);
    const storage = new TempJobStorage(root, 60_000);
    await storage.initialize();
    const executor = new StubProcessExecutor();
    executor.hangDownload = true;
    const service = new MediaDownloadService(
      {
        inspectSource: async () =>
          source([format({ formatId: "video", hasVideo: true, height: 720 })]),
      },
      new FormatSelector(),
      executor,
      storage,
      { ytDlpExecutable: "/tools/yt-dlp" },
    );
    const controller = new AbortController();
    const limiter = new JobLimiter(1, 5_000, 1_024);
    const lease = limiter.acquire(controller.signal);
    const preparation = service.prepare(request({ mode: "video_only" }), lease.context);

    while (executor.calls.length === 0) {
      await Bun.sleep(1);
    }
    controller.abort();

    await expect(preparation).rejects.toMatchObject({ code: "DOWNLOAD_FAILED" });
    expect(await readdir(root)).toEqual([]);
    lease.release();
  });

  test("rejects unexpected streams and unsupported metadata sanitization", async () => {
    const fixture = await setup([format({ formatId: "video", hasVideo: true, height: 720 })]);
    fixture.executor.probeStreams = ["audio"];

    await expect(
      fixture.service.prepare(request({ mode: "video_only" }), fixture.lease.context),
    ).rejects.toMatchObject({ code: "DOWNLOAD_FAILED" });
    expect(await readdir(fixture.root)).toEqual([]);

    await expect(
      fixture.service.prepare(request({ stripMetadata: true }), fixture.lease.context),
    ).rejects.toMatchObject({ code: "INVALID_REQUEST", status: 400 });
    fixture.lease.release();
  });
});

describe("download filenames", () => {
  test("removes path and control characters while preserving Unicode safely", () => {
    const fileName = sanitizeAttachmentName('../悪い\n"title"/..', "mp4");
    const disposition = attachmentContentDisposition(fileName);

    expect(fileName).toBe("悪い title.mp4");
    expect(disposition).toContain('filename="__ title.mp4"');
    expect(disposition).toContain("filename*=UTF-8''");
    expect(disposition).not.toContain("\n");
  });
});
