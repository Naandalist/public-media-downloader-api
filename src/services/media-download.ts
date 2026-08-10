import { lstat, readdir } from "node:fs/promises";
import { extname } from "node:path";

import { z } from "zod";

import { ApplicationError } from "../domain/errors";
import type {
  MediaDownloader,
  MediaDownloadRequest,
  MediaSourceInspector,
  PreparedMediaDownload,
} from "../domain/media";
import { FormatSelector } from "./format-selector";
import type { JobContext } from "./job-limiter";
import type { ProcessExecutor, ProcessRunOptions } from "./process-runner";
import { ProcessRunnerError } from "./process-runner";
import type { TempJob } from "./temp-job-storage";
import { TempJobStorage } from "./temp-job-storage";

const monitorIntervalMilliseconds = 25;
const sourcePrefix = "source.";
const processedPrefix = "processed.";

const probeSchema = z.object({
  format: z.object({
    format_name: z.string().min(1),
  }),
  streams: z.array(
    z.object({
      codec_type: z.enum(["audio", "video"]),
    }),
  ),
});

interface DetectedMediaFile {
  readonly extension: string;
  readonly mimeType: string;
}

const downloadFailed = () =>
  new ApplicationError("DOWNLOAD_FAILED", 502, "The media download failed.");

const processingFailed = () =>
  new ApplicationError("DOWNLOAD_FAILED", 502, "The downloaded media could not be validated.");

const processFailure = (error: unknown, signal: AbortSignal): ApplicationError => {
  if (signal.reason instanceof ApplicationError) {
    return signal.reason;
  }

  if (error instanceof ApplicationError) {
    return error;
  }

  return downloadFailed();
};

const detectMediaFile = (
  formatName: string,
  mode: MediaDownloadRequest["mode"],
): DetectedMediaFile => {
  const formats = new Set(formatName.split(","));
  const audioOnly = mode === "audio_only";

  if (formats.has("webm")) {
    return {
      extension: "webm",
      mimeType: audioOnly ? "audio/webm" : "video/webm",
    };
  }

  if (formats.has("matroska")) {
    return {
      extension: audioOnly ? "mka" : "mkv",
      mimeType: audioOnly ? "audio/x-matroska" : "video/x-matroska",
    };
  }

  if (formats.has("mov") || formats.has("mp4") || formats.has("m4a")) {
    return {
      extension: audioOnly ? "m4a" : "mp4",
      mimeType: audioOnly ? "audio/mp4" : "video/mp4",
    };
  }

  if (formats.has("mp3")) {
    return { extension: "mp3", mimeType: "audio/mpeg" };
  }

  if (formats.has("ogg")) {
    return { extension: "ogg", mimeType: audioOnly ? "audio/ogg" : "video/ogg" };
  }

  if (formats.has("flac")) {
    return { extension: "flac", mimeType: "audio/flac" };
  }

  if (formats.has("wav")) {
    return { extension: "wav", mimeType: "audio/wav" };
  }

  if (formats.has("aac")) {
    return { extension: "aac", mimeType: "audio/aac" };
  }

  if (formats.has("mpegts")) {
    return { extension: "ts", mimeType: "video/mp2t" };
  }

  throw processingFailed();
};

const validateStreams = (
  streams: readonly { readonly codec_type: "audio" | "video" }[],
  mode: MediaDownloadRequest["mode"],
) => {
  const hasAudio = streams.some((stream) => stream.codec_type === "audio");
  const hasVideo = streams.some((stream) => stream.codec_type === "video");
  const valid =
    (mode === "video_audio" && hasAudio && hasVideo) ||
    (mode === "video_only" && hasVideo && !hasAudio) ||
    (mode === "audio_only" && hasAudio && !hasVideo);

  if (!valid) {
    throw processingFailed();
  }
};

const findCompletedSource = async (job: TempJob): Promise<string> => {
  const entries = await readdir(job.directory, { withFileTypes: true });
  const candidates = entries.filter(
    (entry) =>
      entry.isFile() &&
      entry.name.startsWith(sourcePrefix) &&
      !entry.name.endsWith(".part") &&
      !entry.name.endsWith(".ytdl"),
  );

  if (candidates.length !== 1) {
    throw downloadFailed();
  }

  return job.resolveFile(candidates[0]?.name ?? "");
};

const logicalBytesWritten = async (job: TempJob): Promise<number> => {
  const entries = await readdir(job.directory, { withFileTypes: true });
  let completedSourceBytes = 0;
  let intermediateSourceBytes = 0;
  let processedBytes = 0;

  for (const entry of entries) {
    if (!entry.name.startsWith(sourcePrefix) && !entry.name.startsWith(processedPrefix)) {
      continue;
    }

    const path = await job.resolveFile(entry.name);
    const status = await lstat(path);

    if (!status.isFile()) {
      throw downloadFailed();
    }

    if (entry.name.startsWith(processedPrefix)) {
      processedBytes += status.size;
      continue;
    }

    const segmentCount = entry.name.split(".").length;
    const isCompletedOutput =
      segmentCount === 2 || (segmentCount === 3 && entry.name.endsWith(".part"));

    if (isCompletedOutput) {
      completedSourceBytes += status.size;
    } else {
      intermediateSourceBytes += status.size;
    }
  }

  return Math.max(completedSourceBytes, intermediateSourceBytes, processedBytes);
};

const runMonitored = async (
  operation: Promise<unknown>,
  job: TempJob,
  context: JobContext,
): Promise<void> => {
  let settled = false;
  const completed = operation.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );

  try {
    while (!settled) {
      context.output.observeBytesWritten(await logicalBytesWritten(job));
      await Promise.race([completed, Bun.sleep(monitorIntervalMilliseconds)]);
    }

    context.output.observeBytesWritten(await logicalBytesWritten(job));
  } catch (error) {
    await operation.catch(() => undefined);
    throw error;
  }

  await operation;
};

const processedFilePath = async (job: TempJob, sourcePath: string) => {
  const sourceExtension = extname(sourcePath).slice(1);

  if (!/^[a-zA-Z0-9]{1,10}$/.test(sourceExtension)) {
    throw processingFailed();
  }

  return job.resolveFile(`processed.${sourceExtension.toLowerCase()}`);
};

export interface MediaDownloadServiceOptions {
  readonly ffmpegExecutable?: string;
  readonly ffprobeExecutable?: string;
  readonly processTimeoutMilliseconds?: number;
  readonly ytDlpExecutable?: string;
}

export class MediaDownloadService implements MediaDownloader {
  private readonly ffmpegExecutable: string;
  private readonly ffprobeExecutable: string;
  private readonly processTimeoutMilliseconds: number;
  private readonly ytDlpExecutable: string;

  constructor(
    private readonly sourceInspector: MediaSourceInspector,
    private readonly formatSelector: FormatSelector,
    private readonly processExecutor: ProcessExecutor,
    private readonly tempJobStorage: TempJobStorage,
    options: MediaDownloadServiceOptions = {},
  ) {
    this.ffmpegExecutable = options.ffmpegExecutable ?? "ffmpeg";
    this.ffprobeExecutable = options.ffprobeExecutable ?? "ffprobe";
    this.processTimeoutMilliseconds = options.processTimeoutMilliseconds ?? 900_000;
    this.ytDlpExecutable = options.ytDlpExecutable ?? "yt-dlp";
  }

  async prepare(
    request: MediaDownloadRequest,
    context: JobContext,
  ): Promise<PreparedMediaDownload> {
    if (request.stripMetadata) {
      throw new ApplicationError(
        "INVALID_REQUEST",
        400,
        "Metadata sanitization is not available yet.",
      );
    }

    const source = await this.sourceInspector.inspectSource(request.url, context.signal);
    const selection = this.formatSelector.select(
      source.extracted.formats,
      request.mode,
      request.quality,
    );
    context.output.assertKnownSize(selection.knownOutputBytes);
    const job = await this.tempJobStorage.createJob(context.signal);

    try {
      const outputTemplate = await job.resolveFile("source.%(ext)s");
      await this.runProcess(
        {
          arguments: [
            "--no-playlist",
            "--no-warnings",
            "--newline",
            "--format",
            selection.selector,
            "--max-filesize",
            String(context.output.maximumBytes),
            "--output",
            outputTemplate,
            "--",
            source.url,
          ],
          cwd: job.directory,
          executable: this.ytDlpExecutable,
          maxStderrBytes: 262_144,
          maxStdoutBytes: 262_144,
          signal: context.signal,
          timeoutMilliseconds: this.processTimeoutMilliseconds,
        },
        job,
        context,
      );

      let filePath = await findCompletedSource(job);

      if (selection.requiresAudioRemoval || selection.requiresVideoRemoval) {
        const processedPath = await processedFilePath(job, filePath);
        const streamType = selection.requiresAudioRemoval ? "v:0" : "a:0";
        await this.runProcess(
          {
            arguments: [
              "-nostdin",
              "-v",
              "error",
              "-y",
              "-i",
              filePath,
              "-map",
              `0:${streamType}`,
              "-c",
              "copy",
              processedPath,
            ],
            cwd: job.directory,
            executable: this.ffmpegExecutable,
            maxStderrBytes: 262_144,
            maxStdoutBytes: 65_536,
            signal: context.signal,
            timeoutMilliseconds: this.processTimeoutMilliseconds,
          },
          job,
          context,
        );
        filePath = processedPath;
      }

      const detected = await this.probe(filePath, request.mode, context.signal);
      const status = await lstat(filePath);

      if (!status.isFile() || status.size < 1) {
        throw processingFailed();
      }

      context.output.observeBytesWritten(status.size);

      return Object.freeze({
        cleanup: () => job.cleanup(),
        extension: detected.extension,
        filePath,
        mimeType: detected.mimeType,
        sizeBytes: status.size,
        title: source.extracted.title,
      });
    } catch (error) {
      await job.cleanup();
      throw processFailure(error, context.signal);
    }
  }

  private async probe(
    filePath: string,
    mode: MediaDownloadRequest["mode"],
    signal: AbortSignal,
  ): Promise<DetectedMediaFile> {
    let result: Awaited<ReturnType<ProcessExecutor["run"]>>;

    try {
      result = await this.processExecutor.run({
        arguments: [
          "-v",
          "error",
          "-show_entries",
          "format=format_name:stream=codec_type",
          "-of",
          "json",
          filePath,
        ],
        executable: this.ffprobeExecutable,
        maxStderrBytes: 131_072,
        maxStdoutBytes: 1_048_576,
        signal,
        timeoutMilliseconds: this.processTimeoutMilliseconds,
      });
    } catch (error) {
      throw processFailure(error, signal);
    }

    let rawProbe: unknown;

    try {
      rawProbe = JSON.parse(result.stdout);
    } catch {
      throw processingFailed();
    }

    const parsed = probeSchema.safeParse(rawProbe);

    if (!parsed.success) {
      throw processingFailed();
    }

    validateStreams(parsed.data.streams, mode);
    return detectMediaFile(parsed.data.format.format_name, mode);
  }

  private async runProcess(
    options: ProcessRunOptions,
    job: TempJob,
    context: JobContext,
  ): Promise<void> {
    try {
      await runMonitored(this.processExecutor.run(options), job, context);
    } catch (error) {
      if (error instanceof ProcessRunnerError || error instanceof ApplicationError) {
        throw processFailure(error, context.signal);
      }

      throw error;
    }
  }
}

export const sanitizeAttachmentName = (title: string, extension: string): string => {
  const printableTitle = Array.from(title.normalize("NFKC"), (character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint < 32 || codePoint === 127 ? " " : character;
  }).join("");
  const normalizedTitle = printableTitle
    .replaceAll("/", " ")
    .replace(/[\\:*?"<>|]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\.+|\.+$/g, "")
    .trim()
    .slice(0, 120);
  const baseName = normalizedTitle.length > 0 ? normalizedTitle : "media";

  return `${baseName}.${extension}`;
};

export const attachmentContentDisposition = (fileName: string): string => {
  const asciiFallback = fileName.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  const encoded = encodeURIComponent(fileName).replace(
    /[!'()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );

  return `attachment; filename="${asciiFallback}"; filename*=UTF-8''${encoded}`;
};
