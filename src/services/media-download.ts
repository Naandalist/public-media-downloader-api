import { lstat, readdir, rm } from "node:fs/promises";
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
const sanitizedPrefix = "sanitized.";

const probeSchema = z.object({
  chapters: z.array(z.unknown()).optional().default([]),
  format: z.object({
    duration: z.union([z.string(), z.number()]).nullable().optional(),
    format_name: z.string().min(1),
    tags: z.record(z.string(), z.string()).optional().default({}),
  }),
  streams: z.array(
    z.object({
      codec_name: z.string().nullable().optional(),
      codec_type: z.enum(["audio", "video"]),
      disposition: z
        .object({
          attached_pic: z.number().int().optional().default(0),
        })
        .passthrough()
        .optional()
        .default({ attached_pic: 0 }),
      height: z.number().int().positive().nullable().optional(),
      side_data_list: z
        .array(
          z
            .object({
              rotation: z.number().finite().nullable().optional(),
            })
            .passthrough(),
        )
        .optional()
        .default([]),
      tags: z.record(z.string(), z.string()).optional().default({}),
      width: z.number().int().positive().nullable().optional(),
    }),
  ),
});

interface DetectedMediaFile {
  readonly extension: string;
  readonly isImage: boolean;
  readonly mimeType: string;
}

type MediaProbe = z.infer<typeof probeSchema>;

const removableMetadataKeys = new Set([
  "album",
  "album_artist",
  "artist",
  "comment",
  "copyright",
  "creation_time",
  "date",
  "description",
  "encoded_by",
  "location",
  "make",
  "model",
  "orientation",
  "rotate",
  "synopsis",
  "title",
]);

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
  videoCodec?: string | null,
): DetectedMediaFile => {
  const formats = new Set(formatName.split(","));
  const audioOnly = mode === "audio_only";

  if (formats.has("image2") && videoCodec === "mjpeg") {
    return { extension: "jpg", isImage: true, mimeType: "image/jpeg" };
  }

  if (formats.has("image2") && videoCodec === "png") {
    return { extension: "png", isImage: true, mimeType: "image/png" };
  }

  if (formats.has("webm")) {
    return {
      extension: "webm",
      isImage: false,
      mimeType: audioOnly ? "audio/webm" : "video/webm",
    };
  }

  if (formats.has("matroska")) {
    return {
      extension: audioOnly ? "mka" : "mkv",
      isImage: false,
      mimeType: audioOnly ? "audio/x-matroska" : "video/x-matroska",
    };
  }

  if (formats.has("mov") || formats.has("mp4") || formats.has("m4a")) {
    return {
      extension: audioOnly ? "m4a" : "mp4",
      isImage: false,
      mimeType: audioOnly ? "audio/mp4" : "video/mp4",
    };
  }

  if (formats.has("mp3")) {
    return { extension: "mp3", isImage: false, mimeType: "audio/mpeg" };
  }

  if (formats.has("ogg")) {
    return {
      extension: "ogg",
      isImage: false,
      mimeType: audioOnly ? "audio/ogg" : "video/ogg",
    };
  }

  if (formats.has("flac")) {
    return { extension: "flac", isImage: false, mimeType: "audio/flac" };
  }

  if (formats.has("wav")) {
    return { extension: "wav", isImage: false, mimeType: "audio/wav" };
  }

  if (formats.has("aac")) {
    return { extension: "aac", isImage: false, mimeType: "audio/aac" };
  }

  if (formats.has("mpegts")) {
    return { extension: "ts", isImage: false, mimeType: "video/mp2t" };
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

const visualStream = (probe: MediaProbe) =>
  probe.streams.find(
    (stream) => stream.codec_type === "video" && stream.disposition.attached_pic !== 1,
  );

const detectFromProbe = (
  probe: MediaProbe,
  mode: MediaDownloadRequest["mode"],
): DetectedMediaFile =>
  detectMediaFile(probe.format.format_name, mode, visualStream(probe)?.codec_name);

const durationSeconds = (probe: MediaProbe): number | null => {
  const value = Number(probe.format.duration);
  return Number.isFinite(value) && value >= 0 ? value : null;
};

const imageRotation = (probe: MediaProbe): number | null => {
  const stream = visualStream(probe);
  const sideDataRotation = stream?.side_data_list.find(
    (sideData) => sideData.rotation !== undefined && sideData.rotation !== null,
  )?.rotation;
  const rotateTag = Number(stream?.tags.rotate);
  const orientationTag = Number(stream?.tags.orientation);
  const exifOrientationDegrees: Readonly<Record<number, number>> = {
    3: 180,
    5: 90,
    6: 90,
    7: -90,
    8: -90,
  };

  if (sideDataRotation !== undefined && sideDataRotation !== null) {
    return sideDataRotation;
  }

  if (Number.isFinite(rotateTag)) {
    return rotateTag;
  }

  return Number.isInteger(orientationTag) ? (exifOrientationDegrees[orientationTag] ?? 0) : null;
};

const assertSanitizedMetadata = (probe: MediaProbe) => {
  const metadataKeys = [
    ...Object.keys(probe.format.tags),
    ...probe.streams.flatMap((stream) => Object.keys(stream.tags)),
  ].map((key) => key.toLowerCase());
  const hasAttachedArtwork = probe.streams.some((stream) => stream.disposition.attached_pic === 1);

  if (
    probe.chapters.length > 0 ||
    hasAttachedArtwork ||
    metadataKeys.some((key) => removableMetadataKeys.has(key))
  ) {
    throw processingFailed();
  }
};

const assertDurationPreserved = (source: MediaProbe, sanitized: MediaProbe) => {
  const sourceDuration = durationSeconds(source);
  const sanitizedDuration = durationSeconds(sanitized);

  if (sourceDuration === null || sanitizedDuration === null) {
    return;
  }

  const toleranceSeconds = Math.max(1, sourceDuration * 0.02);

  if (Math.abs(sourceDuration - sanitizedDuration) > toleranceSeconds) {
    throw processingFailed();
  }
};

const assertImageOrientationNormalized = (source: MediaProbe, sanitized: MediaProbe) => {
  const sourceStream = visualStream(source);
  const sanitizedStream = visualStream(sanitized);
  const sourceRotation = imageRotation(source);
  const sanitizedRotation = imageRotation(sanitized);

  if (sanitizedRotation !== null && sanitizedRotation % 360 !== 0) {
    throw processingFailed();
  }

  if (
    sourceRotation !== null &&
    Math.abs(sourceRotation) % 180 === 90 &&
    sourceStream?.width !== undefined &&
    sourceStream.width !== null &&
    sourceStream.height !== undefined &&
    sourceStream.height !== null &&
    (sanitizedStream?.width !== sourceStream.height ||
      sanitizedStream.height !== sourceStream.width)
  ) {
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
  let derivedOutputBytes = 0;

  for (const entry of entries) {
    if (
      !entry.name.startsWith(sourcePrefix) &&
      !entry.name.startsWith(processedPrefix) &&
      !entry.name.startsWith(sanitizedPrefix)
    ) {
      continue;
    }

    const path = await job.resolveFile(entry.name);
    const status = await lstat(path);

    if (!status.isFile()) {
      throw downloadFailed();
    }

    if (!entry.name.startsWith(sourcePrefix)) {
      derivedOutputBytes = Math.max(derivedOutputBytes, status.size);
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

  return Math.max(completedSourceBytes, intermediateSourceBytes, derivedOutputBytes);
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
      const unsanitizedPaths = new Set([filePath]);

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
        unsanitizedPaths.add(filePath);
      }

      let detected: DetectedMediaFile;

      if (request.stripMetadata) {
        const sanitized = await this.sanitize(filePath, job, request.mode, context);
        filePath = sanitized.filePath;
        detected = sanitized.detected;
        await Promise.all(
          [...unsanitizedPaths]
            .filter((unsanitizedPath) => unsanitizedPath !== filePath)
            .map((unsanitizedPath) => rm(unsanitizedPath, { force: true })),
        );
      } else {
        const probe = await this.probe(filePath, context.signal);
        validateStreams(probe.streams, request.mode);
        detected = detectFromProbe(probe, request.mode);
      }

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

  private async probe(filePath: string, signal: AbortSignal): Promise<MediaProbe> {
    let result: Awaited<ReturnType<ProcessExecutor["run"]>>;

    try {
      result = await this.processExecutor.run({
        arguments: [
          "-v",
          "error",
          "-show_format",
          "-show_streams",
          "-show_chapters",
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

    return parsed.data;
  }

  private async sanitize(
    sourcePath: string,
    job: TempJob,
    mode: MediaDownloadRequest["mode"],
    context: JobContext,
  ): Promise<{ readonly detected: DetectedMediaFile; readonly filePath: string }> {
    const sourceProbe = await this.probe(sourcePath, context.signal);
    const sourceDetected = detectFromProbe(sourceProbe, mode);
    const sanitizedPath = await job.resolveFile(`sanitized.${sourceDetected.extension}`);
    const mapping =
      mode === "video_audio"
        ? ["-map", "0:V:0", "-map", "0:a:0"]
        : ["-map", mode === "video_only" ? "0:V:0" : "0:a:0"];
    const codecArguments = sourceDetected.isImage
      ? [
          "-frames:v",
          "1",
          "-update",
          "1",
          "-c:v",
          sourceDetected.extension === "jpg" ? "mjpeg" : "png",
        ]
      : ["-c", "copy"];

    await this.runProcess(
      {
        arguments: [
          "-nostdin",
          "-v",
          "error",
          "-y",
          ...(sourceDetected.isImage ? ["-autorotate"] : []),
          "-i",
          sourcePath,
          ...mapping,
          "-map_metadata",
          "-1",
          "-map_metadata:s",
          "-1",
          "-map_chapters",
          "-1",
          "-dn",
          "-sn",
          ...codecArguments,
          sanitizedPath,
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

    const sanitizedProbe = await this.probe(sanitizedPath, context.signal);
    validateStreams(sanitizedProbe.streams, mode);
    assertSanitizedMetadata(sanitizedProbe);
    assertDurationPreserved(sourceProbe, sanitizedProbe);

    if (sourceDetected.isImage) {
      assertImageOrientationNormalized(sourceProbe, sanitizedProbe);
    }

    const detected = detectFromProbe(sanitizedProbe, mode);

    if (
      detected.extension !== sourceDetected.extension ||
      detected.isImage !== sourceDetected.isImage
    ) {
      throw processingFailed();
    }

    return Object.freeze({ detected, filePath: sanitizedPath });
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
