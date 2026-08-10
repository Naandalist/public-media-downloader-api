import { z } from "zod";

import { ApplicationError } from "../domain/errors";
import type { ProcessExecutor } from "./process-runner";
import { ProcessRunnerError } from "./process-runner";

const extractorFormatSchema = z.object({
  abr: z.number().finite().nonnegative().nullable().optional(),
  acodec: z.string().nullable().optional(),
  ext: z
    .string()
    .regex(/^[a-zA-Z0-9]{1,10}$/)
    .nullable()
    .optional(),
  filesize: z.number().int().safe().nonnegative().nullable().optional(),
  filesize_approx: z.number().int().safe().nonnegative().nullable().optional(),
  format_id: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/),
  height: z.number().finite().positive().nullable().optional(),
  tbr: z.number().finite().nonnegative().nullable().optional(),
  vbr: z.number().finite().nonnegative().nullable().optional(),
  vcodec: z.string().nullable().optional(),
});

const extractorResponseSchema = z.object({
  _type: z.string().optional(),
  duration: z.number().finite().nonnegative().nullable().optional(),
  entries: z.array(z.unknown()).nullable().optional(),
  formats: z.array(extractorFormatSchema).min(1),
  id: z.union([z.string().min(1), z.number()]),
  thumbnail: z.url().nullable().optional(),
  title: z.string().trim().min(1).max(1_000),
});

const playlistMarkerSchema = z.object({
  _type: z.string().optional(),
  entries: z.array(z.unknown()).nullable().optional(),
});

export interface ExtractedFormat {
  readonly audioBitrate: number | null;
  readonly audioCodec: string | null;
  readonly extension: string | null;
  readonly fileSizeBytes: number | null;
  readonly formatId: string;
  readonly hasAudio: boolean;
  readonly hasVideo: boolean;
  readonly height: number | null;
  readonly totalBitrate: number | null;
  readonly videoBitrate: number | null;
}

export interface ExtractedMediaInfo {
  readonly durationSeconds: number | null;
  readonly formats: readonly ExtractedFormat[];
  readonly isPlaylist: false;
  readonly thumbnail?: string;
  readonly title: string;
}

export interface MediaExtractor {
  extract(url: string, signal?: AbortSignal): Promise<ExtractedMediaInfo>;
}

export interface YtDlpAdapterOptions {
  readonly executable?: string;
  readonly timeoutMilliseconds?: number;
}

export class YtDlpAdapter implements MediaExtractor {
  private readonly executable: string;
  private readonly timeoutMilliseconds: number;

  constructor(
    private readonly processExecutor: ProcessExecutor,
    options: YtDlpAdapterOptions = {},
  ) {
    this.executable = options.executable ?? "yt-dlp";
    this.timeoutMilliseconds = options.timeoutMilliseconds ?? 60_000;
  }

  async extract(url: string, signal?: AbortSignal): Promise<ExtractedMediaInfo> {
    let stdout: string;

    try {
      const result = await this.processExecutor.run({
        arguments: [
          "--dump-single-json",
          "--skip-download",
          "--no-warnings",
          "--no-playlist",
          "--",
          url,
        ],
        executable: this.executable,
        maxStderrBytes: 131_072,
        maxStdoutBytes: 4_194_304,
        timeoutMilliseconds: this.timeoutMilliseconds,
        ...(signal === undefined ? {} : { signal }),
      });
      stdout = result.stdout;
    } catch (error) {
      if (error instanceof ProcessRunnerError && error.code === "EXIT_NON_ZERO") {
        throw new ApplicationError(
          "MEDIA_UNAVAILABLE",
          404,
          "The media is private, unavailable, or no longer exists.",
        );
      }

      throw new ApplicationError("DOWNLOAD_FAILED", 502, "Media inspection failed.");
    }

    let rawResponse: unknown;

    try {
      rawResponse = JSON.parse(stdout);
    } catch {
      throw new ApplicationError(
        "DOWNLOAD_FAILED",
        502,
        "The media extractor returned invalid data.",
      );
    }

    const playlistMarker = playlistMarkerSchema.safeParse(rawResponse);

    if (
      playlistMarker.success &&
      (playlistMarker.data._type === "playlist" || playlistMarker.data.entries !== undefined)
    ) {
      throw new ApplicationError("INVALID_REQUEST", 400, "Playlist downloads are not supported.");
    }

    const parsed = extractorResponseSchema.safeParse(rawResponse);

    if (!parsed.success) {
      throw new ApplicationError(
        "DOWNLOAD_FAILED",
        502,
        "The media extractor returned invalid data.",
      );
    }

    const formats = parsed.data.formats.map((format) => ({
      audioBitrate: format.abr ?? null,
      audioCodec:
        format.acodec === undefined || format.acodec === null || format.acodec === "none"
          ? null
          : format.acodec,
      extension: format.ext?.toLowerCase() ?? null,
      fileSizeBytes: format.filesize ?? format.filesize_approx ?? null,
      formatId: format.format_id,
      hasAudio: format.acodec !== undefined && format.acodec !== null && format.acodec !== "none",
      hasVideo: format.vcodec !== undefined && format.vcodec !== null && format.vcodec !== "none",
      height: format.height ?? null,
      totalBitrate: format.tbr ?? null,
      videoBitrate: format.vbr ?? null,
    }));

    return Object.freeze({
      durationSeconds: parsed.data.duration ?? null,
      formats: Object.freeze(formats),
      isPlaylist: false as const,
      ...(parsed.data.thumbnail === undefined || parsed.data.thumbnail === null
        ? {}
        : { thumbnail: parsed.data.thumbnail }),
      title: parsed.data.title,
    });
  }
}
